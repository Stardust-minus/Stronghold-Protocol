import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueueCancellation, CANCEL_BUDGET_MS } from '../public/js/queueCancellation.js';
import { BrowserClock, flushPromises } from './helpers/browserClock.js';

class FakeNet {
  status = 'online';
  ws = {};
  listeners = new Map();
  calls = [];
  reconnects = 0;
  constructor(clock) { this.clock = clock; }
  on(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
    return () => this.listeners.get(name).delete(fn);
  }
  emit(name, data) { for (const fn of this.listeners.get(name) || []) fn(data); }
  change(status) { this.status = status; this.emit('status', { status }); }
  hello(playerId = 'p1') { this.change('online'); this.emit('welcome', { playerId }); }
  queue(ticketId = 't1', state = 'queued') { this.emit('queue.state', { ticketId, state }); }
  reconnectNow() {
    this.reconnects++;
    this.swap();
  }
  swap() {
    this.ws = {};
    this.change('reconnecting');
    for (const call of this.calls) call.reject({ code: 'DISCONNECTED' });
  }
  request(type, fields, opts) {
    return new Promise((resolve, reject) => {
      const timer = this.clock.setTimeout(() => reject({ code: 'TIMEOUT' }), opts.timeout);
      this.calls.push({ type, fields, timeout: opts.timeout,
        resolve: () => { this.clock.clearTimeout(timer); resolve({ t: 'ack' }); },
        reject: (error) => { this.clock.clearTimeout(timer); reject(error); },
      });
    });
  }
}

function fixture(t) {
  const clock = new BrowserClock(), net = new FakeNet(clock), changes = [];
  const controller = createQueueCancellation({ net, timers: clock, now: clock.now, onChange: (state) => changes.push(state) });
  net.hello(); net.queue();
  t.after(() => { controller.dispose(); for (const call of net.calls) call.reject({ code: 'CLOSED' }); });
  return { clock, net, controller, changes };
}

test('ack alone does not fake idle; authoritative cancellation clears all timers', async (t) => {
  const { clock, net, controller } = fixture(t);
  assert.equal(controller.cancel('wrong'), false);
  assert.equal(controller.cancel('t1'), true);
  assert.equal(controller.cancel('t1'), false, 'one intent at a time');
  assert.deepEqual(net.calls[0].fields, { ticketId: 't1' });
  net.calls[0].resolve(); await flushPromises();
  assert.equal(controller.snapshot().status, 'confirming');
  net.queue(null, 'idle');
  assert.deepEqual(controller.snapshot(), { status: 'idle', ticketId: null });
  assert.equal(clock.jobs.size, 0);
});

test('lost cancel request: one socket swap, fresh hello/state, then same-ticket recovery only', async (t) => {
  const { clock, net, controller } = fixture(t);
  controller.cancel('t1');
  clock.advance(8000); await flushPromises();
  assert.equal(net.reconnects, 1);
  assert.equal(controller.snapshot().status, 'recovering');
  net.queue();
  assert.equal(net.calls.length, 1, 'stale state before hello is ignored');
  net.hello();
  assert.equal(net.calls.length, 1, 'hello alone is not queue confirmation');
  net.queue(); net.queue(); net.queue();
  assert.equal(net.calls.length, 2, 'duplicate pushes do not repeat an in-flight cancel');
  assert.equal(net.calls[1].fields.ticketId, 't1');
  net.queue(null, 'idle');
  net.calls[1].resolve(); await flushPromises();
  assert.equal(controller.snapshot().status, 'idle');
});

test('lost ack after server cancellation does not cause any reconnect or replay', async (t) => {
  const { clock, net, controller } = fixture(t);
  controller.cancel('t1');
  net.queue(null, 'idle');
  clock.advance(8000); await flushPromises();
  assert.equal(net.reconnects, 0);
  assert.equal(net.calls.length, 1);
  assert.equal(controller.snapshot().status, 'idle');
});

for (const [ticket, state] of [['new-ticket', 'queued'], ['t1', 'matched'], [null, 'idle']]) {
  test(`recovered ${state}/${ticket} stops old cancellation without touching a new ticket or match`, async (t) => {
    const { clock, net, controller } = fixture(t);
    controller.cancel('t1'); clock.advance(8000); await flushPromises();
    net.hello(); net.queue(ticket, state);
    assert.equal(net.calls.length, 1);
    assert.equal(controller.snapshot().status, 'idle');
    clock.advance(30000); await flushPromises();
    assert.equal(net.calls.length, 1);
    assert.ok(net.calls.every((call) => call.type === 'queue.cancel'));
  });
}

test('ordinary disconnect retains the intent; a replacement session does not', async (t) => {
  const { net, controller } = fixture(t);
  controller.cancel('t1');
  net.swap(); await flushPromises();
  assert.equal(controller.snapshot().status, 'recovering');
  net.hello(); net.queue('t1', 'offered');
  assert.equal(net.calls.length, 2);
  assert.equal(net.reconnects, 0, 'normal reconnect was enough');
  net.swap(); net.hello('p2'); net.queue('t1');
  assert.equal(controller.snapshot().status, 'idle');
  assert.equal(net.calls.length, 2);
});

test('closed/replaced sessions never reconnect autonomously', async (t) => {
  const { clock, net, controller } = fixture(t);
  controller.cancel('t1');
  net.change('closed'); net.emit('replaced');
  clock.advance(40000); await flushPromises();
  assert.equal(net.reconnects, 0);
  assert.equal(net.calls.length, 1);
  assert.equal(controller.snapshot().status, 'failed');
});

test('at most two recovery sends; failure stays actionable and stale ack cannot clear a new attempt', async (t) => {
  const { clock, net, controller } = fixture(t);
  controller.cancel('t1'); clock.advance(8000); await flushPromises();
  net.hello(); net.queue();
  clock.advance(8000); await flushPromises();
  assert.equal(net.calls.length, 3);
  clock.advance(8000); await flushPromises();
  assert.equal(controller.snapshot().status, 'failed');
  assert.equal(net.reconnects, 1);
  net.queue(); net.queue();
  assert.equal(net.calls.length, 3, 'no automatic loop after exhaustion');
  assert.equal(controller.cancel('t1'), true, 'explicit manual retry is available');
  net.calls[2].resolve(); await flushPromises();
  assert.equal(controller.snapshot().status, 'sending');
  net.queue(null, 'idle'); net.calls[3].resolve();
});

test('waiting for fresh state has a fixed deadline, not renewed by status traffic', async (t) => {
  const { clock, net, controller } = fixture(t);
  controller.cancel('t1'); clock.advance(8000); await flushPromises();
  clock.advance(4000); net.change('handshaking');
  clock.advance(3999); assert.equal(controller.snapshot().status, 'recovering');
  clock.advance(1); await flushPromises();
  assert.equal(controller.snapshot().status, 'failed');
  assert.equal(net.reconnects, 1);
});

test('remaining total budget caps requests even when reconnection and server replies are slow', async (t) => {
  const { clock, net, controller } = fixture(t);
  controller.cancel('t1'); clock.advance(8000); await flushPromises();
  clock.advance(7000); net.hello(); net.queue();
  clock.advance(8000); await flushPromises();
  assert.equal(net.calls[2].timeout, CANCEL_BUDGET_MS - clock.now());
  clock.advance(7000); await flushPromises();
  assert.equal(controller.snapshot().status, 'failed');
  assert.equal(clock.now(), CANCEL_BUDGET_MS);
});

test('server refusal is not retried as a connection fault; dispose clears listeners and deadlines', async (t) => {
  const { clock, net, controller } = fixture(t);
  controller.cancel('t1'); net.calls[0].reject({ code: 'BAD_TICKET' }); await flushPromises();
  assert.equal(controller.snapshot().status, 'failed');
  assert.equal(net.reconnects, 0);
  controller.dispose(); controller.dispose();
  assert.equal(clock.jobs.size, 0);
  assert.ok([...net.listeners.values()].every((set) => set.size === 0));
  assert.equal(controller.cancel('t1'), false);
});
