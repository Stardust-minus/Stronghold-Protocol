import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { serverLoadState, createHealthMetrics } from '../server/healthMetrics.js';
import { Network, SessionRegistry } from '../server/net.js';
import { SERVER_LOAD_STATES, normalizeServerLoad } from '../shared/protocol.js';
import { Net } from '../public/js/net.js';

const ready = (elu = .2, p95 = 20) => ({ status: 'ready', sampledAt: 1000, windowMs: 10_000,
  mainThread: { eventLoopUtilization: elu, eventLoopDelayMs: { p95 } },
  process: { cpu: { percent: 1400 }, rssBytes: 999_999_999 } });

test('public server pressure is a finite enum, not a diagnostic object or online count', () => {
  assert.deepEqual(SERVER_LOAD_STATES, ['unknown', 'normal', 'busy', 'overloaded']);
  for (const value of SERVER_LOAD_STATES) assert.equal(normalizeServerLoad(value), value);
  for (const value of [null, undefined, '', 'constructor', '__proto__', [], ['normal'], {}, 1]) {
    assert.equal(normalizeServerLoad(value), 'unknown');
  }
  assert.equal(serverLoadState(ready(), 2000), 'normal', 'aggregate multi-thread CPU is not main-thread pressure');
});

test('cached ELU and p95 thresholds have explicit boundaries', () => {
  for (const [elu, delay, state] of [[.849, 39.9, 'normal'], [.85, 20, 'busy'], [.2, 40, 'busy'],
    [.95, 49.9, 'busy'], [.95, 50, 'overloaded'], [.2, 100, 'overloaded']]) {
    assert.equal(serverLoadState(ready(elu, delay), 2000), state);
  }
});

test('cold, stopped, invalid and stale measurements are unknown, never invented normal', () => {
  for (const status of ['warming', 'stopped', 'unavailable', undefined]) {
    assert.equal(serverLoadState({ ...ready(), status }, 2000), 'unknown');
  }
  for (const elu of [null, undefined, NaN, Infinity, -1, 1.01]) {
    const snapshot = ready(); snapshot.mainThread.eventLoopUtilization = elu;
    assert.equal(serverLoadState(snapshot, 2000), 'unknown');
  }
  for (const delay of [null, undefined, NaN, Infinity, -1]) {
    const snapshot = ready(); snapshot.mainThread.eventLoopDelayMs.p95 = delay;
    assert.equal(serverLoadState(snapshot, 2000), 'unknown');
  }
  for (const snapshot of [null, {}, { ...ready(), sampledAt: null }, { ...ready(), windowMs: 0 }]) {
    assert.equal(serverLoadState(snapshot, 2000), 'unknown');
  }
  assert.equal(serverLoadState(ready(), 31_000), 'normal');
  assert.equal(serverLoadState(ready(), 31_001), 'unknown');
  assert.equal(serverLoadState(ready(), 999), 'unknown');
});

test('pressure reads reuse the single performance cache and do not advance samples', () => {
  let at = 0, tick, resets = 0, cpuReads = 0;
  const metrics = createHealthMetrics({ now: () => at, wallNow: () => 1000,
    cpuUsage: () => { cpuReads++; return { user: at, system: 0 }; },
    eventLoopUtilization: () => ({ active: at / 5, idle: at * 4 / 5 }),
    memoryUsage: () => ({ rss: 1, heapUsed: 1, heapTotal: 1, external: 0, arrayBuffers: 0 }),
    createHistogram: () => ({ count: 1, max: 20e6, percentile: () => 20e6,
      enable() {}, disable() {}, reset() { resets++; } }),
    setInterval: (fn, ms) => { assert.equal(ms, 10_000); tick = fn; return { unref() {} }; }, clearInterval() {},
  });
  assert.equal(serverLoadState(metrics.snapshot(), 1000), 'unknown');
  metrics.start(); at = 10_000; tick();
  const cached = metrics.snapshot();
  for (let i = 0; i < 100; i++) {
    assert.equal(metrics.snapshot(), cached);
    assert.equal(serverLoadState(cached, 1000), 'normal');
  }
  assert.equal(resets, 1); assert.equal(cpuReads, 2);
  metrics.dispose();
  assert.equal(serverLoadState(metrics.snapshot(), 1000), 'unknown');
});

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(data, callback) { this.sent.push(JSON.parse(data)); callback?.(); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
}

test('pong publishes only the enum and remains compatible when no provider is configured', t => {
  const cases = [[undefined, undefined], [() => 'busy', 'busy'],
    [() => ({ rssBytes: 123, pid: 456 }), 'unknown'], [() => { throw new Error('reader'); }, 'unknown']];
  for (const [provider, expected] of cases) {
    const network = new Network({ registry: new SessionRegistry(), handler: { onMessage() {} },
      now: () => 1000, getLoadState: provider });
    t.after(() => network.close());
    const ws = new Socket(); network.handleConnection(ws);
    ws.emit('message', Buffer.from('{"t":"ping","c":950,"rid":1,"loadState":"normal"}'), false);
    const pong = ws.sent.at(-1);
    assert.equal(pong.t, 'pong'); assert.equal(pong.c, 950); assert.equal(pong.s, 1000); assert.equal(pong.rid, 1);
    assert.deepEqual(Object.keys(pong).sort(), provider ? ['c', 'loadState', 'rid', 's', 't'] : ['c', 'rid', 's', 't']);
    assert.equal(pong.loadState, expected);
    assert.equal(JSON.stringify(pong).includes('rssBytes'), false);
  }
});

test('client carries valid load in status without changing RTT and clears old or malformed hints', () => {
  const net = new Net({ now: () => 1000 }); net._setStatus('online');
  for (const loadState of SERVER_LOAD_STATES) {
    net._onPong({ c: 950, s: 1000, loadState });
    assert.equal(net.snapshot().loadState, loadState); assert.equal(net.ping, 50);
  }
  for (const loadState of [undefined, 'bad', {}, ['normal'], 1]) {
    net.loadState = 'normal'; net._onPong({ c: 950, s: 1000, loadState });
    assert.equal(net.snapshot().loadState, 'unknown'); assert.equal(net.ping, 50);
  }
  net.loadState = 'normal'; net._teardownSocket();
  assert.equal(net.snapshot().loadState, 'unknown');
  net.loadState = 'normal'; net._setStatus('reconnecting');
  assert.equal(net.snapshot().loadState, 'unknown');
});
