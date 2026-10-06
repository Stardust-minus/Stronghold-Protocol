import test from 'node:test';
import assert from 'node:assert/strict';
import { Net, PING_TIMEOUT_MS, PING_SAMPLE_MAX_AGE_MS } from '../public/js/net.js';
import { startServer } from '../server/index.js';

function fixture() {
  const clock = { wall: 1_700_000_000_000, mono: 50, visible: true };
  const sent = [], statuses = [];
  const net = new Net({ now: () => clock.wall, monotonicNow: () => clock.mono, isVisible: () => clock.visible });
  net.ws = { readyState: 1, send(data) { sent.push(JSON.parse(data)); }, close() { this.readyState = 3; } };
  net._setStatus('online');
  net.on('status', (status) => statuses.push(status));
  const advance = (ms) => { clock.mono += ms; clock.wall += ms; };
  const send = () => { net._sendPing(); return sent.at(-1); };
  const answer = (ping, extra = {}) => net._onMessage(JSON.stringify({ t: 'pong', rid: ping.rid, c: ping.c, loadState: 'normal', ...extra }));
  return { clock, net, sent, statuses, advance, send, answer };
}

test('monotonic RTT is unaffected by forward and backward client wall-clock adjustments', () => {
  const f = fixture();
  for (const adjustment of [60_000, -120_000]) {
    const ping = f.send();
    f.advance(40); f.clock.wall += adjustment;
    f.answer(ping);
    assert.equal(f.net.ping, 40);
    assert.equal(f.net.loadState, 'normal');
  }
});

test('clock offsets are re-estimated after an epoch adjustment between probes', () => {
  const f = fixture(), first = f.send();
  f.advance(20); f.answer(first, { s: first.c + 10 + 5000 });
  assert.equal(f.net.clockOffset, 5000);
  f.clock.wall += 10_000;
  const next = f.send();
  f.advance(40); f.answer(next, { s: next.c + 20 - 5000 });
  assert.equal(f.net.ping, 40);
  assert.equal(f.net.clockOffset, -5000, 'old lower-RTT offsets belong to a different client epoch');
  assert.equal(f.net._clockSamples.length, 1);
});

test('only a matching outstanding rid and echoed timestamp can update latency or load', () => {
  const f = fixture(), ping = f.send();
  f.advance(50);
  for (const extra of [{ rid: undefined }, { rid: ping.rid + 999 }, { c: ping.c + 1 }, { c: String(ping.c) }]) {
    f.answer(ping, extra);
    assert.equal(f.net.ping, null);
    assert.equal(f.net.loadState, 'unknown');
  }
  f.answer(ping, { loadState: 'busy' });
  assert.equal(f.net.ping, 50);
  assert.equal(f.net.loadState, 'busy');
  f.advance(1000); f.answer(ping, { loadState: 'overloaded' });
  assert.equal(f.net.ping, 50, 'duplicate replies cannot overwrite a completed sample');
  assert.equal(f.net.loadState, 'busy');
});

test('an older probe cannot overwrite a newer accepted probe', () => {
  const f = fixture(), older = f.send();
  f.advance(10); const newer = f.send();
  f.advance(20); f.answer(newer, { loadState: 'busy' });
  f.advance(100); f.answer(older, { loadState: 'overloaded' });
  assert.equal(f.net.ping, 20);
  assert.equal(f.net.loadState, 'busy');
});

test('valid high latency is still displayed rather than filtered or averaged away', () => {
  const f = fixture();
  let ping = f.send(); f.advance(40); f.answer(ping);
  assert.equal(f.net.ping, 40);
  ping = f.send(); f.advance(3000); f.answer(ping, { loadState: 'overloaded' });
  assert.equal(f.net.ping, 3000);
  assert.equal(f.net.loadState, 'overloaded');
});

test('probe timeout is independent of inbound battle traffic and silence detection', () => {
  const f = fixture(), ping = f.send();
  f.advance(PING_TIMEOUT_MS);
  f.net._onMessage('{"t":"b.snap","gt":1,"units":[]}');
  f.answer(ping);
  assert.equal(f.net.status, 'online');
  assert.equal(f.net.ping, null);
  assert.equal(f.net.loadState, 'unknown');
  assert.equal(f.net._pings.size, 0);
});

test('stale displayed latency becomes unavailable without discarding newer outstanding probes', () => {
  const f = fixture();
  const first = f.send(); f.advance(40); f.answer(first);
  f.advance(PING_SAMPLE_MAX_AGE_MS - 100);
  const newer = f.send();
  f.advance(100);
  f.net._onMessage('{"t":"b.ev","gt":2,"ev":[]}');
  f.net._heartbeat();
  assert.equal(f.net.status, 'online');
  assert.equal(f.net.ping, null);
  assert.equal(f.net.loadState, 'unknown');
  assert.ok(f.net._pings.has(newer.rid));
  f.answer(newer);
  assert.equal(f.net.ping, 100);
});

test('a client epoch adjustment does not falsely trigger heartbeat reconnection', () => {
  const f = fixture(); f.send();
  f.clock.wall += 60_000;
  f.advance(100); f.net._heartbeat();
  assert.equal(f.net.status, 'online');
  assert.equal(f.net.ws.readyState, 1);
});

test('outstanding probes are bounded, and a failed send leaves no pending probe', () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) f.send();
  assert.equal(f.net._pings.size, 8);
  assert.equal(new Set(f.sent.map(p => p.rid)).size, 100, 'equal epoch timestamps still have distinct probe IDs');
  f.net._sendRaw = () => false;
  f.net._resetLatency(); f.send();
  assert.equal(f.net._pings.size, 0);
});

test('socket teardown clears the old RTT, load and outstanding probes before reconnect', () => {
  const f = fixture(), first = f.send();
  f.advance(40); f.answer(first);
  const old = f.send();
  f.net._teardownSocket();
  f.answer(old);
  assert.equal(f.net.ping, null);
  assert.equal(f.net.loadState, 'unknown');
  assert.equal(f.net._pings.size, 0);
});

test('visibility changes invalidate old samples, while hidden pages continue heartbeating', () => {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const listeners = {}, document = { visibilityState: 'visible', addEventListener(type, fn) { listeners[type] = fn; } };
  globalThis.window = { addEventListener() {} }; globalThis.document = document;
  try {
    const f = fixture(); f.net.isVisible = () => document.visibilityState === 'visible';
    f.net.attachBrowserHooks();
    const first = f.send(); f.advance(40); f.answer(first);
    const beforeHide = f.send();
    document.visibilityState = 'hidden'; listeners.visibilitychange();
    assert.equal(f.net.ping, null);
    assert.equal(f.net.loadState, 'unknown');
    const hidden = f.send();
    assert.equal(f.net._pings.size, 0);
    f.advance(200); f.answer(hidden);
    document.visibilityState = 'visible'; listeners.visibilitychange();
    const fresh = f.sent.at(-1);
    assert.notEqual(fresh.rid, beforeHide.rid);
    f.answer(beforeHide); f.answer(hidden);
    assert.equal(f.net.ping, null);
    f.advance(30); f.answer(fresh);
    assert.equal(f.net.ping, 30);
  } finally {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  }
});

test('load details are whitelisted only on a matched pong and are cleared with stale latency', () => {
  const f = fixture(), ping = f.send();
  const details = { windowMs: 10000, ageMs: 100, cpuPercent: 250.5, rssMiB: 512, heapMiB: 64, eluPercent: 25, p95Ms: 20, p99Ms: 21, pid: 1234, host: 'not-public' };
  f.advance(40); f.answer(ping, { loadDetails: details });
  assert.equal(f.net.snapshot().loadDetails.cpuPercent, 250.5);
  assert.equal(Object.hasOwn(f.net.loadDetails, 'pid'), false);
  assert.equal(Object.hasOwn(f.net.loadDetails, 'host'), false);
  f.answer(ping, { loadDetails: { ...details, cpuPercent: 999 } });
  assert.equal(f.net.loadDetails.cpuPercent, 250.5);
  f.advance(PING_SAMPLE_MAX_AGE_MS); f.net._expireLatency(f.clock.mono);
  assert.equal(f.net.snapshot().loadDetails, null);
});

test('real Node24 browser WebSocket uses matched application pongs with compression enabled', { timeout: 10000 }, async t => {
  const server = await startServer({ host: '127.0.0.1', port: 0, quiet: true, combatWorkers: 0, trialWorkers: 0,
    snapshotHz: 10, wsCompression: 'on' });
  t.after(() => server.close());
  const net = new Net({ url: `ws://127.0.0.1:${server.port}/ws` });
  t.after(() => net.close());
  const latency = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('latency probe timed out')), 5000);
    net.on('ping', value => { if (Number.isFinite(value)) { clearTimeout(timeout); resolve(value); } });
  });
  net.connect();
  const value = await latency;
  assert.equal(net.status, 'connected');
  assert.ok(value >= 0 && value < PING_TIMEOUT_MS);
  assert.equal(net._pings.size, 0);
});
