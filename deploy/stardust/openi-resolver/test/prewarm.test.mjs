import test from 'node:test';
import assert from 'node:assert/strict';
import OpenIResolver, { startServer } from '../server.mjs';

const NOW = 1791072000000;
const entry = (name, fileName = `releases/v012-prewarm-test/assets/${name}.png`) => ({
  requestPath: `/assets/${name}.png`, fileName, bytes: 123, sha256: '0'.repeat(64), mime: 'image/png',
});
function manifest(count = 4, aliasCount = 0) {
  const entries = Array.from({ length: count }, (_, i) => entry(`file_${i}`));
  for (let i = 0; i < aliasCount; i++) entries.push(entry(`alias_${i}`, entries[i % count].fileName));
  return { schemaVersion: 1, release: 'v012-workers-20261004', dataset: 'Stardust_minus/arknight_assets',
    apiOrigin: 'https://openi.pcl.ac.cn', ossOrigin: 'https://obs.cn-south-222.ai.pcl.cn',
    ossPathPrefix: '/test-bucket/test-dataset/',
    fallbackBase: 'https://ark-asset.hanabi-ai.cn:25442/releases/v012-workers-20261004', entries };
}
function signed(config, fileName, expiresAt = NOW + 3600000) {
  return config.ossOrigin + config.ossPathPrefix + fileName + '?' + new URLSearchParams({
    AWSAccessKeyId: 'test-only-key', Expires: String(Math.ceil(expiresAt / 1000)), Signature: 'test-only-signature',
  });
}
function response(location, status = 301, retryAfter = null) {
  return { status, headers: new Headers({ ...(location ? { location } : {}),
    ...(retryAfter !== null ? { 'retry-after': retryAfter } : {}) }), body: { async cancel() {} } };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
class FakeTime {
  now = NOW; pending = new Map(); nextId = 0; maxPending = 0; fired = 0;
  clock = () => this.now;
  timers = {
    setTimeout: (callback, delay) => {
      const id = this.nextId++;
      this.pending.set(id, { callback, at: this.now + delay });
      this.maxPending = Math.max(this.maxPending, this.pending.size);
      return id;
    },
    clearTimeout: id => { this.pending.delete(id); },
  };
  async advance(ms) {
    const target = this.now + ms;
    await flush();
    for (let steps = 0; ; steps++) {
      assert.ok(steps < 20000, 'Scheduler must not busy-spin');
      let next;
      for (const [id, timer] of this.pending) {
        if (timer.at <= target && (!next || timer.at < next[1].at)) next = [id, timer];
      }
      if (!next) break;
      this.now = Math.max(this.now, next[1].at);
      this.pending.delete(next[0]); this.fired++;
      next[1].callback();
      await flush();
    }
    this.now = target;
    await flush();
  }
}
function make(t, { config = manifest(), fetchImpl, ...options } = {}) {
  const time = new FakeTime(), calls = [];
  const resolver = new OpenIResolver({ manifest: config, clock: time.clock, timers: time.timers,
    maxRetries: 0, refreshJitterMs: 0, prewarm: true, ...options, fetchImpl: (url, request) => {
      const fileName = new URL(url).searchParams.get('file_name');
      calls.push({ fileName, at: time.now, request, url });
      return fetchImpl ? fetchImpl(fileName, request, time, calls.length) : response(signed(config, fileName, time.now + 3600000));
    } });
  t.after(() => resolver.close());
  return { resolver, time, calls, config };
}

test('prewarming is opt-in and constructors/start calls do no external work before the explicit lifecycle starts', async t => {
  const off = make(t, { prewarm: false });
  off.resolver.startPrewarm();
  await off.time.advance(3600000);
  assert.equal(off.calls.length, 0); assert.equal(off.time.pending.size, 0);
  assert.equal(off.resolver.health().prewarmEnabled, false);
  const on = make(t);
  await on.time.advance(0);
  assert.equal(on.calls.length, 0); assert.equal(on.time.pending.size, 0);
  on.resolver.startPrewarm(); on.resolver.startPrewarm();
  assert.equal(on.calls.length, 0);
  await on.time.advance(0);
  assert.equal(on.calls.length, 4); assert.equal(on.resolver.health().warmComplete, true);
});

test('startup warms 5515 unique files / 9803 routes once without queuing the manifest or downloading objects', async t => {
  const config = manifest(5515, 4288);
  const { resolver, time, calls } = make(t, { config });
  resolver.startPrewarm();
  assert.equal(resolver.health().queued, 0);
  await time.advance(0);
  const health = resolver.health();
  assert.equal(calls.length, 5515); assert.equal(new Set(calls.map(call => call.fileName)).size, 5515);
  assert.equal(health.files, 5515); assert.equal(health.entries, 9803);
  assert.equal(health.prewarmCompleted, 5515); assert.equal(health.prewarmRemaining, 0);
  assert.equal(health.prewarmActive, 0); assert.equal(health.queued, 0); assert.equal(health.warmComplete, true);
  assert.equal(health.apiRequests, 5515); assert.equal(time.pending.size, 1);
  assert.ok(time.maxPending <= 3, 'Only active-request deadlines plus one scheduler timer are retained');
  const known = new Set(config.entries.map(value => value.fileName));
  for (const call of calls) {
    const url = new URL(call.url);
    assert.equal(url.origin, config.apiOrigin); assert.equal(url.pathname, '/api/v1/dataset/file');
    assert.ok(known.has(call.fileName)); assert.equal(call.request.method, 'GET');
    assert.equal(call.request.redirect, 'manual'); assert.equal(call.request.credentials, 'omit');
    assert.deepEqual(call.request.headers, { Accept: '*/*' });
  }
  await time.advance(3449999);
  assert.equal(calls.length, 5515, 'Fresh signatures are not re-signed periodically');
  await resolver.resolve('/assets/alias_0.png?file_name=attacker');
  assert.equal(calls.length, 5515);
  assert.doesNotMatch(JSON.stringify(health), /https|Signature|AWSAccessKeyId|Expires|test-only|headers/i);
});

test('idle files refresh at their existing deadline before becoming unusable, with a bounded repeating schedule', async t => {
  const { resolver, time, calls, config } = make(t, { config: manifest(3) });
  resolver.startPrewarm(); await time.advance(0);
  const old = signed(config, config.entries[0].fileName);
  await time.advance(3449999); assert.equal(calls.length, 3);
  await time.advance(1);
  assert.equal(calls.length, 6); assert.equal(resolver.health().refreshes, 3);
  await time.advance(120000);
  const renewed = await resolver.resolve('/assets/file_0.png');
  assert.equal(renewed.fallback, false); assert.notEqual(renewed.location, old);
  assert.ok(Number(new URL(renewed.location).searchParams.get('Expires')) * 1000 > time.now + 30000);
  for (let round = 0; round < 5; round++) await time.advance(3450000);
  assert.equal(calls.length, 21); assert.equal(resolver.health().prewarmCompleted, 3);
  assert.equal(time.pending.size, 1); assert.ok(time.maxPending <= 3);
  await resolver.close();
  assert.equal(time.pending.size, 0);
  await time.advance(7200000); assert.equal(calls.length, 21);
});

test('default deterministic jitter spreads idle refreshes within the existing refresh window', async t => {
  const { resolver, time, calls } = make(t, { config: manifest(8), refreshJitterMs: 30000 });
  resolver.startPrewarm(); await time.advance(0);
  await time.advance(3419999); assert.equal(calls.length, 8);
  await time.advance(30001); assert.equal(calls.length, 16);
  const renewed = calls.slice(8);
  assert.ok(renewed.every(call => call.at >= NOW + 3420000 && call.at <= NOW + 3450000));
  assert.ok(new Set(renewed.map(call => call.at)).size > 1);
  assert.equal(resolver.health().warmComplete, true);
});

test('warmup completion timing spreads future expiry and refresh deadlines rather than creating a resign-all interval', async t => {
  const config = manifest(3);
  const { resolver, time, calls } = make(t, { config, fetchImpl: (fileName, _, time, call) => new Promise(done => {
    time.timers.setTimeout(() => done(response(signed(config, fileName, time.now + 3600000))), call === 2 ? 2000 : 1000);
  }) });
  resolver.startPrewarm(); await time.advance(3000);
  assert.equal(calls.length, 3); assert.equal(resolver.health().warmComplete, true);
  await time.advance(3447999); assert.equal(calls.length, 3);
  await time.advance(1); assert.equal(calls.length, 4); assert.equal(calls[3].at, NOW + 3451000);
  await time.advance(1000); assert.equal(calls.length, 6);
  assert.equal(calls.filter(call => call.at === NOW + 3452000).length, 2);
});

test('two slots are reserved for new cold users and the foreground queue always wins over more prewarming', async t => {
  const gates = new Map();
  const { resolver, time, calls, config } = make(t, { config: manifest(8), fetchImpl: fileName => {
    const gate = deferred(); gates.set(fileName, gate); return gate.promise;
  } });
  resolver.startPrewarm(); await time.advance(0);
  assert.equal(calls.length, 2); assert.equal(resolver.health().prewarmActive, 2);
  const background = calls.map(call => call.fileName);
  const foreground = config.entries.filter(value => !background.includes(value.fileName)).slice(0, 3);
  const pending = foreground.map(value => resolver.resolve(value.requestPath));
  await flush();
  assert.equal(calls.length, 4); assert.equal(resolver.health().active, 4);
  assert.equal(resolver.health().prewarmActive, 2); assert.equal(resolver.health().queued, 1);
  gates.get(background[0]).resolve(response(signed(config, background[0])));
  await time.advance(0);
  assert.equal(calls[4].fileName, foreground[2].fileName);
  assert.equal(resolver.health().prewarmActive, 1); assert.equal(resolver.health().queued, 0);
  assert.equal(resolver.health().active, 4);
  await resolver.close();
  assert.ok((await Promise.all(pending)).every(result => result.fallback));
  assert.equal(calls.length, 5); assert.equal(time.pending.size, 0);
});

test('foreground requests and aliases join a background-inflight file without duplicate API calls', async t => {
  const config = manifest(1, 3), gate = deferred();
  const { resolver, time, calls } = make(t, { config, fetchImpl: () => gate.promise });
  resolver.startPrewarm(); await time.advance(0);
  const pending = config.entries.map(value => resolver.resolve(value.requestPath));
  await flush();
  assert.equal(calls.length, 1); assert.equal(resolver.health().queued, 0);
  assert.equal(resolver.health().prewarmActive, 1);
  gate.resolve(response(signed(config, config.entries[0].fileName)));
  const results = await Promise.all(pending);
  assert.ok(results.every(result => !result.fallback && result.location === signed(config, config.entries[0].fileName)));
  assert.equal(calls.length, 1); assert.equal(resolver.health().warmComplete, true);
});

test('starting prewarm alongside an existing foreground singleflight does not duplicate or lose its future schedule', async t => {
  const config = manifest(3), gate = deferred();
  const { resolver, time, calls } = make(t, { config,
    fetchImpl: (fileName, _, time) => fileName === config.entries[0].fileName ? gate.promise : response(signed(config, fileName, time.now + 3600000)) });
  const foreground = resolver.resolve('/assets/file_0.png');
  await flush(); assert.equal(calls.length, 1);
  resolver.startPrewarm(); await time.advance(0);
  assert.equal(calls.length, 3); assert.equal(resolver.health().prewarmCompleted, 2);
  gate.resolve(response(signed(config, config.entries[0].fileName)));
  assert.equal((await foreground).fallback, false); await time.advance(0);
  assert.equal(resolver.health().warmComplete, true); assert.equal(time.pending.size, 1);
  await time.advance(3450000);
  assert.equal(calls.length, 6);
  assert.equal(calls.filter(call => call.fileName === config.entries[0].fileName).length, 2);
});

test('cold queue remains bounded at 128 while background jobs have no queue slots and aliases singleflight', async t => {
  const { resolver, time, calls, config } = make(t, { config: manifest(140), fetchImpl: () => deferred().promise });
  resolver.startPrewarm(); await time.advance(0);
  const background = new Set(calls.map(call => call.fileName));
  const cold = config.entries.filter(value => !background.has(value.fileName));
  const pending = cold.map(value => resolver.resolve(value.requestPath));
  const alias = resolver.resolve(cold[2].requestPath + '?v=another-client');
  await flush();
  assert.equal(resolver.health().active, 4); assert.equal(resolver.health().prewarmActive, 2);
  assert.equal(resolver.health().queued, 128); assert.equal(resolver.health().failures, 8);
  assert.ok((await Promise.all(pending.slice(130))).every(result => result.fallback));
  assert.equal(calls.length, 4);
  await resolver.close();
  assert.ok((await Promise.all([...pending, alias])).every(result => result.fallback));
  assert.equal(time.pending.size, 0); assert.equal(resolver.health().queued, 0);
});

test('a cold foreground overflow is automatically warmed after its cooldown without another user request', async t => {
  const gates = new Map();
  const { resolver, time, calls, config } = make(t, { config: manifest(5), maxQueue: 0,
    fetchImpl: (fileName, _, time, call) => {
      if (call > 4) return response(signed(config, fileName, time.now + 3600000));
      const gate = deferred(); gates.set(fileName, gate); return gate.promise;
    } });
  resolver.startPrewarm(); await time.advance(0);
  const active = new Set(calls.map(call => call.fileName));
  const cold = config.entries.filter(value => !active.has(value.fileName));
  const pending = cold.slice(0, 2).map(value => resolver.resolve(value.requestPath));
  assert.equal((await resolver.resolve(cold[2].requestPath)).fallback, true);
  await flush(); assert.equal(calls.length, 4);
  for (const [fileName, gate] of gates) gate.resolve(response(signed(config, fileName)));
  assert.ok((await Promise.all(pending)).every(result => !result.fallback));
  await time.advance(0); assert.equal(calls.length, 4); assert.equal(resolver.health().prewarmRemaining, 1);
  await time.advance(1250);
  assert.equal(calls.length, 5); assert.equal(calls[4].fileName, cold[2].fileName);
  assert.equal(resolver.health().warmComplete, true);
});

test('global 429 Retry-After pauses all prewarming and cold signing until the absolute cooldown ends', async t => {
  const { resolver, time, calls, config } = make(t, { config: manifest(4), prewarmConcurrency: 1,
    fetchImpl: (fileName, _, time, call) => call === 1 ? response(null, 429, '60') : response(signed(config, fileName, time.now + 3600000)) });
  resolver.startPrewarm(); await time.advance(0);
  assert.equal(calls.length, 1); assert.equal(resolver.health().prewarmActive, 0);
  const fired = time.fired;
  await time.advance(59999);
  assert.equal(calls.length, 1); assert.equal(time.fired, fired, 'No wakeup spin during global cooldown');
  assert.equal((await resolver.resolve('/assets/file_3.png')).fallback, true);
  await time.advance(1);
  assert.equal(calls.length, 5); assert.equal(resolver.health().warmComplete, true);
  assert.equal(resolver.health().apiRequests, 5);
});

test('distant 429 deadlines are not truncated to an overflowing Node timer or retried early', async t => {
  const { resolver, time, calls } = make(t, { config: manifest(1), prewarmConcurrency: 1,
    fetchImpl: () => response(null, 429, '31536000000') });
  resolver.startPrewarm(); await time.advance(0);
  assert.equal(calls.length, 1); assert.equal(time.pending.size, 1);
  assert.equal([...time.pending.values()][0].at, NOW + 2147483647);
  await time.advance(2147483647);
  assert.equal(calls.length, 1); assert.equal(time.pending.size, 1);
  assert.equal([...time.pending.values()][0].at, time.now + 2147483647);
});

test('failed rows back off individually without starving other files, and keep usable old URLs only until the cutoff', async t => {
  let bad = true;
  const { resolver, time, calls, config } = make(t, { config: manifest(3), failureBaseMs: 1000,
    fetchImpl: (fileName, _, time) => fileName.endsWith('/file_0.png') && bad ? response(null, 503) : response(signed(config, fileName, time.now + 3600000)) });
  resolver.startPrewarm(); await time.advance(0);
  assert.equal(calls.length, 3); assert.equal(resolver.health().prewarmCompleted, 2);
  assert.equal(resolver.health().prewarmRemaining, 1); assert.equal(resolver.health().warmComplete, false);
  const fired = time.fired;
  for (let i = 0; i < 20; i++) assert.equal((await resolver.resolve('/assets/file_0.png')).fallback, true);
  await time.advance(999); assert.equal(calls.length, 3); assert.equal(time.fired, fired);
  bad = false; await time.advance(251);
  assert.equal(calls.length, 4); assert.equal(resolver.health().warmComplete, true);
  bad = true; await time.advance(3452000);
  const old = await resolver.resolve('/assets/file_0.png');
  assert.equal(old.fallback, false);
  await time.advance(120000);
  const expired = await resolver.resolve('/assets/file_0.png');
  assert.equal(expired.fallback, true); assert.equal(expired.location, config.fallbackBase + '/assets/file_0.png');
  assert.ok(resolver.health().prewarmRemaining >= 1);
});

test('short-lived or reused refresh-due signatures cannot cause immediate repeated background work', async t => {
  const { resolver, time, calls, config } = make(t, { config: manifest(1),
    fetchImpl: fileName => response(signed(config, fileName, NOW + 31000)) });
  resolver.startPrewarm(); await time.advance(0); assert.equal(calls.length, 1);
  await time.advance(999); assert.equal(calls.length, 1);
  await time.advance(1); assert.equal(calls.length, 2);
  assert.equal((await resolver.resolve('/assets/file_0.png')).fallback, true);
  assert.equal(resolver.health().cache, 0);
});

test('close before the initial prewarm wakeup makes no fetch and cancels even a zero-valued timer handle', async t => {
  const { resolver, time, calls } = make(t);
  resolver.startPrewarm(); assert.equal(time.pending.size, 1);
  assert.ok(time.pending.has(0));
  await resolver.close(); await time.advance(7200000);
  assert.equal(time.pending.size, 0); assert.equal(calls.length, 0);
  assert.equal(resolver.health().prewarmActive, 0);
});

test('shutdown cancels active fetches, queued waiters, retry pauses and scheduler timers, including late fetch responses', async t => {
  const gates = [], signals = [];
  const { resolver, time, calls, config } = make(t, { config: manifest(6), maxRetries: 1, retryBaseMs: 1000,
    fetchImpl: (fileName, request, _, call) => {
      signals.push(request.signal);
      if (call === 1) return response(null, 503);
      const gate = deferred(); gates.push({ gate, fileName }); return gate.promise;
    } });
  resolver.startPrewarm(); await time.advance(0);
  const inProgress = new Set(calls.map(call => call.fileName));
  const pending = config.entries.filter(value => !inProgress.has(value.fileName)).map(value => resolver.resolve(value.requestPath));
  const joined = resolver.resolve(config.entries.find(value => value.fileName === calls[0].fileName).requestPath);
  await flush();
  assert.equal(resolver.health().active, 4); assert.equal(resolver.health().queued, 2);
  await resolver.close(); await resolver.close(); resolver.startPrewarm();
  assert.ok((await Promise.all([...pending, joined])).every(result => result.fallback));
  assert.ok(signals.slice(1).every(signal => signal.aborted));
  assert.equal(time.pending.size, 0); assert.equal(resolver.health().active, 0);
  assert.equal(resolver.health().prewarmActive, 0); assert.equal(resolver.health().prewarmCompleted, 0);
  for (const { gate, fileName } of gates) gate.resolve(response(signed(config, fileName)));
  await time.advance(7200000);
  assert.equal(calls.length, 4); assert.equal(resolver.health().cache, 0);
  assert.equal((await resolver.resolve('/assets/file_0.png')).fallback, true);
});

test('startServer parses PREWARM strictly, explicit options override it, and warm work begins only after listen', async t => {
  const previous = process.env.PREWARM;
  t.after(() => { if (previous === undefined) delete process.env.PREWARM; else process.env.PREWARM = previous; });
  const config = manifest(1);
  for (const value of ['', 'true', 'yes', '01', '1 ', '2']) {
    process.env.PREWARM = value;
    await assert.rejects(startServer({ manifest: config, host: '127.0.0.1', port: 0 }), { message: 'CONFIG' });
  }
  for (const [value, override, enabled] of [[undefined, undefined, false], ['0', undefined, false],
    ['1', undefined, true], ['invalid', false, false], ['0', true, true]]) {
    if (value === undefined) delete process.env.PREWARM; else process.env.PREWARM = value;
    const time = new FakeTime(); let calls = 0;
    const app = await startServer({ manifest: config, host: '127.0.0.1', port: 0, prewarm: override,
      timers: time.timers, clock: time.clock, fetchImpl: () => { calls++; return response(signed(config, config.entries[0].fileName)); } });
    t.after(() => app.close());
    assert.equal(app.server.listening, true); assert.equal(calls, 0);
    assert.equal(app.resolver.health().prewarmEnabled, enabled);
    await time.advance(0); assert.equal(calls, enabled ? 1 : 0);
    await app.close(); assert.equal(time.pending.size, 0);
  }
  process.env.PREWARM = '1';
  const time = new FakeTime(); let calls = 0;
  await assert.rejects(startServer({ manifest: config, host: '127.0.0.1', port: NaN,
    timers: time.timers, clock: time.clock, fetchImpl: () => { calls++; } }), { message: 'CONFIG' });
  assert.equal(calls, 0); assert.equal(time.pending.size, 0);
});
