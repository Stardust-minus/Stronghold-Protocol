import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import WebSocket from 'ws';
import { serverLoadState, createHealthMetrics, publicLoadDetails } from '../server/healthMetrics.js';
import { Network, SessionRegistry } from '../server/net.js';
import { startServer } from '../server/index.js';
import { SERVER_LOAD_STATES, normalizeServerLoad, normalizeLoadDetails } from '../shared/protocol.js';
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

const detailKeys = ['windowMs', 'ageMs', 'cpuPercent', 'rssMiB', 'heapMiB', 'eluPercent', 'p95Ms', 'p99Ms'];
const nullDetails = { windowMs: 10_000, ageMs: 0, cpuPercent: null, rssMiB: null, heapMiB: null,
  eluPercent: null, p95Ms: null, p99Ms: null };
const detailSnapshot = () => ({
  status: 'ready', sampledAt: 1000, windowMs: 10_000.6,
  process: { cpu: { percent: 1485.46 }, rssBytes: 1536.6 * 1024 * 1024 },
  mainThread: { memory: { heapUsedBytes: 536.4 * 1024 * 1024 }, eventLoopUtilization: .8567,
    eventLoopDelayMs: { p95: 42.24, p99: 130.26 } },
  pid: 123, host: 'private', cpuModel: 'private', coreCount: 32, memoryTotal: 1e12,
  sessions: 8, rooms: ['private'], rawDiagnostics: { secret: true },
});

test('public load details are rounded, whitelist-only and preserve multi-core CPU units', () => {
  const input = { ...nullDetails, windowMs: 10_001, ageMs: 1500, cpuPercent: 1485.46,
    rssMiB: 1536.6, heapMiB: 536.4, eluPercent: 85.67, p95Ms: 42.24, p99Ms: 130.26,
    pid: 123, host: 'private', cpuModel: 'private', coreCount: 32, memoryTotal: 1e12,
    sessions: 8, rooms: ['private'], rawDiagnostics: { secret: true } };
  const original = structuredClone(input);
  const details = normalizeLoadDetails(input);
  assert.deepEqual(details, { windowMs: 10_001, ageMs: 1500, cpuPercent: 1485.5,
    rssMiB: 1537, heapMiB: 536, eluPercent: 85.7, p95Ms: 42.2, p99Ms: 130.3 });
  assert.deepEqual(Object.keys(details), detailKeys);
  assert.deepEqual(input, original, 'normalization does not mutate the provider/cache');
});

test('public load details reject invalid required window/age and retain inclusive limits', () => {
  for (const value of [null, undefined, 1, 'ready', [], new Date()]) assert.equal(normalizeLoadDetails(value), null);
  for (const windowMs of [undefined, null, false, '10000', NaN, Infinity, -1, 0, .5, 300_001]) {
    assert.equal(normalizeLoadDetails({ ...nullDetails, windowMs }), null);
  }
  for (const ageMs of [undefined, null, false, '0', NaN, Infinity, -1, .5, 30_001]) {
    assert.equal(normalizeLoadDetails({ ...nullDetails, ageMs }), null);
  }
  assert.deepEqual(normalizeLoadDetails({ windowMs: 1, ageMs: 0 }), { ...nullDetails, windowMs: 1 });
  assert.deepEqual(normalizeLoadDetails({ windowMs: 300_000, ageMs: 30_000, cpuPercent: 100_000,
    rssMiB: 16_777_216, heapMiB: 16_777_216, eluPercent: 100, p95Ms: 300_000, p99Ms: 300_000 }),
  { windowMs: 300_000, ageMs: 30_000, cpuPercent: 100_000, rssMiB: 16_777_216, heapMiB: 16_777_216,
    eluPercent: 100, p95Ms: 300_000, p99Ms: 300_000 });
});

test('public load details invalid optional measurements are null, never coerced or clamped', () => {
  const limits = { cpuPercent: 100_000, rssMiB: 16_777_216, heapMiB: 16_777_216,
    eluPercent: 100, p95Ms: 300_000, p99Ms: 300_000 };
  for (const [key, max] of Object.entries(limits)) {
    for (const value of [undefined, null, false, '0', [], {}, NaN, Infinity, -Infinity, -1, max + .01]) {
      assert.deepEqual(normalizeLoadDetails({ ...nullDetails, [key]: value }), nullDetails, `${key}: ${String(value)}`);
    }
    assert.deepEqual(normalizeLoadDetails({ ...nullDetails, [key]: 0 }), { ...nullDetails, [key]: 0 });
  }
});

test('cached load details convert only game-process bytes, CPU, ELU and delays', () => {
  assert.deepEqual(publicLoadDetails(detailSnapshot(), 2500.4), { windowMs: 10_001, ageMs: 1500,
    cpuPercent: 1485.5, rssMiB: 1537, heapMiB: 536, eluPercent: 85.7, p95Ms: 42.2, p99Ms: 130.3 });
  assert.deepEqual(publicLoadDetails({ status: 'ready', sampledAt: 1000, windowMs: 10_000 }, 1000), nullDetails);
  const snapshot = detailSnapshot();
  snapshot.process.cpu.percent = null; snapshot.process.rssBytes = null;
  snapshot.mainThread.memory.heapUsedBytes = undefined; snapshot.mainThread.eventLoopUtilization = null;
  snapshot.mainThread.eventLoopDelayMs = {};
  assert.deepEqual(publicLoadDetails(snapshot, 1000), { ...nullDetails, windowMs: 10_001 });
  for (const value of [null, undefined, false, '0', NaN, Infinity, -1]) {
    const invalid = detailSnapshot();
    invalid.process.cpu.percent = invalid.process.rssBytes = invalid.mainThread.memory.heapUsedBytes = value;
    invalid.mainThread.eventLoopUtilization = invalid.mainThread.eventLoopDelayMs.p95 = invalid.mainThread.eventLoopDelayMs.p99 = value;
    assert.deepEqual(publicLoadDetails(invalid, 1000), { ...nullDetails, windowMs: 10_001 });
  }
  const overLimit = detailSnapshot();
  overLimit.process.cpu.percent = 100_000.01; overLimit.process.rssBytes = 16_777_216 * 1024 * 1024 + 1;
  overLimit.mainThread.memory.heapUsedBytes = overLimit.process.rssBytes; overLimit.mainThread.eventLoopUtilization = 1.0001;
  overLimit.mainThread.eventLoopDelayMs = { p95: 300_000.01, p99: 300_000.01 };
  assert.deepEqual(publicLoadDetails(overLimit, 1000), { ...nullDetails, windowMs: 10_001 });
});

test('cached load details require a ready finite sample and reject future/stale/out-of-range windows', () => {
  for (const snapshot of [null, undefined, {}]) assert.equal(publicLoadDetails(snapshot, 1000), null);
  for (const status of ['warming', 'stopped', 'unavailable', undefined]) {
    assert.equal(publicLoadDetails({ ...detailSnapshot(), status }, 1000), null);
  }
  for (const sampledAt of [undefined, null, '1000', NaN, Infinity, -1]) {
    assert.equal(publicLoadDetails({ ...detailSnapshot(), sampledAt }, 1000), null);
  }
  for (const windowMs of [undefined, null, '10000', NaN, Infinity, -1, 0, 300_000.1]) {
    assert.equal(publicLoadDetails({ ...detailSnapshot(), windowMs }, 1000), null);
  }
  for (const now of [undefined, null, '1000', NaN, Infinity, 999, 31_000.1]) {
    // Explicit undefined uses Date.now(), which is stale for this deterministic epoch.
    assert.equal(publicLoadDetails(detailSnapshot(), now), null);
  }
  assert.equal(publicLoadDetails(detailSnapshot(), 31_000).ageMs, 30_000);
  assert.equal(publicLoadDetails({ ...detailSnapshot(), windowMs: 300_000 }, 1000).windowMs, 300_000);
  assert.equal(publicLoadDetails({ ...detailSnapshot(), windowMs: .1 }, 1000).windowMs, 1);
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

test('pong load details revalidate the provider whitelist and remain uncompressed', t => {
  let reads = 0;
  const input = { ...publicLoadDetails(detailSnapshot(), 1000), cpuPercent: 1485.46, heapMiB: 'private',
    pid: 123, host: 'private', cpuModel: 'private', coreCount: 32, memoryTotal: 1e12,
    sessions: 8, rooms: ['private'], process: detailSnapshot().process, rawDiagnostics: { secret: true } };
  const network = new Network({ registry: new SessionRegistry(), handler: { onMessage() {} }, now: () => 1000,
    getLoadState: () => 'busy', getLoadDetails: () => { reads++; return input; } });
  t.after(() => network.close());
  const ws = new Socket(); let sendOptions;
  ws.send = (data, options, callback) => { ws.sent.push(JSON.parse(data)); sendOptions = options; callback?.(); };
  network.handleConnection(ws);
  assert.equal(reads, 0, 'connections do not request diagnostic samples');
  ws.emit('message', Buffer.from('{"t":"ping","c":950,"rid":1,"loadDetails":{"pid":456}}'), false);
  assert.deepEqual(ws.sent.at(-1), { t: 'pong', c: 950, s: 1000, rid: 1, loadState: 'busy',
    loadDetails: { windowMs: 10_001, ageMs: 0, cpuPercent: 1485.5, rssMiB: 1537,
      heapMiB: null, eluPercent: 85.7, p95Ms: 42.2, p99Ms: 130.3 } });
  assert.equal(reads, 1);
  assert.deepEqual(Object.keys(ws.sent.at(-1).loadDetails), detailKeys);
  assert.deepEqual(sendOptions, { compress: false });
});

test('pong load details omit missing, invalid and throwing providers without interrupting load state or replies', t => {
  for (const provider of [undefined, null, {}, () => null, () => ({}), () => ({ ...nullDetails, windowMs: 0 }),
    () => { throw new Error('reader'); },
    () => ({ windowMs: 10_000, ageMs: 0, get cpuPercent() { throw new Error('measurement'); } })]) {
    const network = new Network({ registry: new SessionRegistry(), handler: { onMessage() {} }, now: () => 1000,
      getLoadState: () => 'busy', getLoadDetails: provider });
    t.after(() => network.close());
    const ws = new Socket(); network.handleConnection(ws);
    ws.emit('message', Buffer.from('{"t":"ping","c":950,"rid":1,"loadDetails":{"windowMs":10000,"ageMs":0}}'), false);
    assert.deepEqual(ws.sent.at(-1), { t: 'pong', c: 950, s: 1000, rid: 1, loadState: 'busy' });
  }
});

test('startServer load details use the existing cache and send only the public pong whitelist', { timeout: 10_000 }, async t => {
  let cached = { status: 'warming' }, failed = false, starts = 0, disposes = 0;
  const metrics = { start() { starts++; }, snapshot() { if (failed) throw new Error('cache'); return cached; },
    dispose() { disposes++; } };
  const app = await startServer({ host: '127.0.0.1', port: 0, quiet: true, combatWorkers: 0, trialWorkers: 0,
    wsCompression: 'on', healthMetricsFactory: () => metrics });
  t.after(() => app.close());
  const ws = new WebSocket(`${app.url.replace('http:', 'ws:')}/ws`);
  t.after(() => ws.terminate());
  await once(ws, 'open');
  let rid = 0;
  const ping = async () => {
    const id = ++rid, message = once(ws, 'message');
    ws.send(JSON.stringify({ t: 'ping', c: id, rid: id, loadDetails: { pid: 456 } }));
    const [raw] = await message;
    const pong = JSON.parse(raw.toString());
    assert.equal(pong.t, 'pong'); assert.equal(pong.c, id); assert.equal(pong.rid, id);
    return pong;
  };
  assert.equal('loadDetails' in await ping(), false, 'cold cache omits details');
  cached = { ...detailSnapshot(), sampledAt: Date.now() };
  const pong = await ping();
  assert.deepEqual(Object.keys(pong).sort(), ['c', 'loadDetails', 'loadState', 'rid', 's', 't']);
  assert.deepEqual(Object.keys(pong.loadDetails), detailKeys);
  assert.ok(pong.loadDetails.ageMs >= 0 && pong.loadDetails.ageMs <= Date.now() - cached.sampledAt);
  assert.deepEqual(pong.loadDetails, { windowMs: 10_001, ageMs: pong.loadDetails.ageMs,
    cpuPercent: 1485.5, rssMiB: 1537, heapMiB: 536, eluPercent: 85.7, p95Ms: 42.2, p99Ms: 130.3 });
  assert.equal(pong.loadState, 'busy');
  assert.equal(app.healthMetrics, metrics);
  cached = { ...cached, sampledAt: Date.now() - 30_001 };
  assert.equal('loadDetails' in await ping(), false, 'stale cache omits details');
  cached = { ...cached, sampledAt: Date.now() + 60_000 };
  assert.equal('loadDetails' in await ping(), false, 'future cache omits details');
  failed = true;
  const fallback = await ping();
  assert.equal('loadDetails' in fallback, false); assert.equal(fallback.loadState, 'unknown');
  assert.equal(starts, 1); assert.equal(disposes, 0);
  ws.terminate(); await app.close();
  assert.equal(disposes, 1);
});

test('client carries valid load in status without changing RTT and clears old or malformed hints', () => {
  let now = 950;
  const sent = [], net = new Net({ now: () => now });
  net.ws = { readyState: 1, send(data) { sent.push(JSON.parse(data)); } };
  net._setStatus('online');
  const answer = (loadState) => {
    net._sendPing();
    const ping = sent.at(-1);
    now += 50;
    net._onPong({ rid: ping.rid, c: ping.c, s: now, loadState });
  };
  for (const loadState of SERVER_LOAD_STATES) {
    answer(loadState);
    assert.equal(net.snapshot().loadState, loadState); assert.equal(net.ping, 50);
  }
  for (const loadState of [undefined, 'bad', {}, ['normal'], 1]) {
    net.loadState = 'normal'; answer(loadState);
    assert.equal(net.snapshot().loadState, 'unknown'); assert.equal(net.ping, 50);
  }
  net.loadState = 'normal'; net._teardownSocket();
  assert.equal(net.snapshot().loadState, 'unknown');
  net.loadState = 'normal'; net._setStatus('reconnecting');
  assert.equal(net.snapshot().loadState, 'unknown');
});
