import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenIResolver, { requestPath, validateManifest, validateDestination, startServer } from '../server.mjs';

const NOW = 1791072000000;
const MIRROR = 'v012-openi-test';
const PREFIX = '/fefced50e2d744508e4bc7e2792e1087-urchin2/ea9189b2-1aa3-4108-ae36-9dfb0ab139f4/';
const entry = (requestPath, fileName = `releases/${MIRROR}${requestPath}`, mime = 'image/png') =>
  ({ requestPath, fileName, bytes: 123, sha256: '0'.repeat(64), mime });
function manifest(entries = [entry('/assets/a.png')]) {
  return { schemaVersion: 1, release: 'v012-workers-20261004', dataset: 'Stardust_minus/arknight_assets',
    apiOrigin: 'https://openi.pcl.ac.cn', ossOrigin: 'https://obs.cn-south-222.ai.pcl.cn', ossPathPrefix: PREFIX,
    fallbackBase: 'https://ark-asset.hanabi-ai.cn:25442/releases/v012-workers-20261004', entries };
}
function aliases() {
  const fileName = `releases/${MIRROR}/media/test_audio`;
  return manifest(['/assets/audio/test_audio.mp3', '/media/test_audio',
    ...['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav'].map(ext => '/media/test_audio.' + ext)]
    .map(path => entry(path, fileName, 'audio/mpeg')));
}
function signed(config, fileName = config.entries[0].fileName, expiresAt = NOW + 3600000) {
  const path = (config.ossPathPrefix + fileName).split('/').map(encodeURIComponent).join('/');
  return config.ossOrigin + ':443' + path + '?' + new URLSearchParams({
    AWSAccessKeyId: 'test-only-key', Expires: String(expiresAt / 1000), Signature: 'test-only-signature',
    'response-content-disposition': 'attachment; filename="test"',
  });
}
function response(location, status = 301, retry = null) {
  const headers = new Headers();
  if (retry !== null) headers.set('retry-after', retry);
  // Preserve deliberately malformed raw Locations; Headers would trim trailing controls.
  return { status, headers: { get: key => key.toLowerCase() === 'location' ? location : headers.get(key) },
    body: { async cancel() {} } };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    // Native prewarm is timer-driven; fast setImmediate spins can finish before its first 1 ms timer.
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.fail('Expected asynchronous work to finish');
}
function make(t, { config = manifest(), fetchImpl = async () => response(signed(config)), ...options } = {}) {
  let now = NOW;
  const resolver = new OpenIResolver({ manifest: config, fetchImpl, clock: () => now, maxRetries: 0, ...options });
  t.after(() => resolver.close());
  return { resolver, setNow: value => { now = value; }, config };
}
async function native(t, options = {}) {
  const app = await startServer({ manifest: manifest(), host: '127.0.0.1', port: 0, clock: () => NOW,
    maxRetries: 0, prewarm: false, ...options });
  t.after(() => app.close());
  return { ...app, base: 'http://127.0.0.1:' + app.server.address().port };
}
function rawRequest(base, path, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base, { path, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('connect', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: '' }); });
    req.on('error', reject); req.end();
  });
}

test('manifest is strict, deduplicates aliases, and only allows public asset/media namespaces', () => {
  const config = validateManifest(aliases());
  assert.equal(config.entries.size, 9);
  assert.equal(config.files.size, 1);
  const bad = [
    { ...manifest(), schemaVersion: 2 }, { ...manifest(), extra: true },
    { ...manifest(), release: '../bad' }, { ...manifest(), dataset: 'other/dataset' },
    { ...manifest(), apiOrigin: 'https://evil.test' }, { ...manifest(), ossOrigin: 'https://evil.test' },
    { ...manifest(), fallbackBase: 'https://evil.test/releases/v012-workers-20261004' },
    { ...manifest(), fallbackBase: manifest().fallbackBase + '?redirect=evil' },
    { ...manifest(), fallbackBase: manifest().fallbackBase.replace('v012-workers-20261004', 'other-release') },
    { ...manifest(), ossPathPrefix: '/bucket/../' }, { ...manifest(), ossPathPrefix: '/bucket/uuid/extra/' },
    manifest([]), manifest([entry('/vendor/a.png')]), manifest([entry('/fonts/a.png')]),
    manifest([entry('/assets/game.js')]), manifest([entry('/assets/login.html')]),
    manifest([entry('/assets/../a.png')]), manifest([entry('/assets/.private.png')]),
    manifest([entry('/assets/a.png'), entry('/assets/a.png')]),
    manifest([{ ...entry('/assets/a.png'), sha256: 'invalid' }]),
    manifest([{ ...entry('/assets/a.png'), sha256: ['0'.repeat(64)] }]),
    manifest([{ ...entry('/assets/a.png'), bytes: -1 }]),
    manifest([{ ...entry('/assets/a.png'), bytes: 1.1 }]),
    manifest([{ ...entry('/assets/a.png'), mime: 'image/png\r\nInjected: true' }]),
    manifest([entry('/assets/a.png', 'https://evil.test/a.png')]),
    manifest([entry('/assets/a.png', `releases/${MIRROR}/vendor/a.png`)]),
    manifest([entry('/media/audio', `releases/${MIRROR}/media/audio.mp3`, 'audio/mpeg')]),
    manifest([entry('/assets/a.png'), entry('/assets/b.png', 'releases/other/assets/b.png')]),
    manifest([entry('/assets/a.png'), { ...entry('/assets/b.png', entry('/assets/a.png').fileName), bytes: 124 }]),
  ];
  for (const value of bad) assert.throws(() => validateManifest(value), { message: 'CONFIG' });
  for (const options of [{ concurrency: 5 }, { maxQueue: 129 }, { timeoutMs: 6000 }, { skewMs: 0 },
    { clock: 'invalid' }, { maxRetries: 2 }, { maxRetryDelayMs: 2001 }, { prewarm: '1' },
    { prewarmConcurrency: 3 }, { prewarm: true, concurrency: 3 }, { timers: {} }]) {
    assert.throws(() => new OpenIResolver({ manifest: manifest(), ...options }), { message: 'CONFIG' });
  }
});

test('immutable byte reuse requires an exact bounded explicit mirror allowlist', async t => {
  const next = 'v013-hangzhou-test';
  const values = [entry('/assets/a.png'), entry('/assets/audio/new.mp3', `releases/${next}/media/new`, 'audio/mpeg')];
  const input = { ...manifest(values), mirrorReleases: [MIRROR, next] };
  const config = validateManifest(input);
  assert.equal(config.files.size, 2);
  input.mirrorReleases.push('changed-after-validation');
  assert.deepEqual(config.mirrorReleases, [MIRROR, next]);
  for (const mirrorReleases of [null, [], [MIRROR], [MIRROR, MIRROR], [MIRROR, '../bad'],
    [MIRROR, next, 'third'], [MIRROR, 'not-used'], [MIRROR, 'https://evil.test']]) {
    assert.throws(() => validateManifest({ ...manifest(values), mirrorReleases }), { message: 'CONFIG' });
  }
  assert.throws(() => validateManifest(manifest(values)), { message: 'CONFIG' });
  const calls = [];
  const { resolver } = make(t, { config: { ...manifest(values), mirrorReleases: [MIRROR, next] },
    fetchImpl: async target => {
      const fileName = new URL(target).searchParams.get('file_name');
      calls.push(fileName);
      return response(signed(manifest(values), fileName));
    } });
  for (const e of values) assert.equal((await resolver.resolve(e.requestPath)).location, signed(manifest(values), e.fileName));
  assert.deepEqual(calls, values.map(e => e.fileName));
});

test('a cached exact capability is reused, with no client query or headers in the public API call', async t => {
  const config = manifest();
  const calls = [];
  const { resolver } = make(t, { config, fetchImpl: async (...args) => {
    calls.push(args); return response(signed(config));
  } });
  const first = await resolver.resolve('/assets/a.png?dataset_name=evil&Signature=attacker&loginToken=client');
  assert.deepEqual(first, { status: 302, location: signed(config), fallback: false });
  for (let i = 0; i < 20; i++) assert.deepEqual(await resolver.resolve('/assets/a.png?Expires=1'), first);
  assert.equal(calls.length, 1);
  const [target, options] = calls[0];
  const url = new URL(target);
  assert.equal(url.origin, config.apiOrigin);
  assert.equal(url.pathname, '/api/v1/dataset/file');
  assert.deepEqual([...url.searchParams], [['dataset_name', config.dataset], ['file_name', config.entries[0].fileName], ['parent_dir', '']]);
  assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
  assert.equal(options.credentials, 'omit'); assert.deepEqual(options.headers, { Accept: '*/*' });
  assert.equal(options.signal.aborted, false);
  assert.deepEqual(resolver.health(), { hits: 20, misses: 1, refreshes: 0, failures: 0, fallbacks: 0, apiRequests: 1,
    cache: 1, active: 0, queued: 0, entries: 1, files: 1, prewarmEnabled: false, prewarmActive: 0,
    prewarmCompleted: 1, prewarmRemaining: 0, warmComplete: true });
});

test('all audio aliases singleflight by remote fileName, preserve extensionless OSS object URLs', async t => {
  const config = aliases(), gate = deferred(); let calls = 0;
  const { resolver } = make(t, { config, fetchImpl: () => { calls++; return gate.promise; } });
  const pending = config.entries.flatMap(value => Array.from({ length: 5 }, () => resolver.resolve(value.requestPath)));
  await until(() => calls === 1);
  assert.equal(resolver.health().active, 1); assert.equal(resolver.health().queued, 0);
  gate.resolve(response(signed(config)));
  for (const result of await Promise.all(pending)) assert.equal(result.location, signed(config));
  const destination = new URL((await resolver.resolve('/media/test_audio.mp3')).location);
  assert.ok(destination.pathname.endsWith('/media/test_audio'));
  assert.equal(calls, 1); assert.equal(resolver.health().cache, 1);
});

test('refresh is singleflight and nonblocking while the old signed URL remains usable', async t => {
  const config = aliases(), gate = deferred(); let calls = 0;
  const { resolver, setNow } = make(t, { config, refreshJitterMs: 0, fetchImpl: () => {
    calls++; return calls === 1 ? response(signed(config)) : gate.promise;
  } });
  await resolver.resolve('/media/test_audio');
  setNow(NOW + 3460000);
  const warm = await Promise.all(config.entries.map(value => resolver.resolve(value.requestPath)));
  assert.ok(warm.every(result => result.location === signed(config)));
  assert.equal(calls, 2); assert.equal(resolver.health().refreshes, 1);
  const replacement = signed(config, config.entries[0].fileName, NOW + 7000000);
  gate.resolve(response(replacement));
  await until(() => resolver.health().active === 0);
  assert.equal((await resolver.resolve('/assets/audio/test_audio.mp3')).location, replacement);
  assert.equal(calls, 2);
});

test('failed background refresh retains a valid old URL with cooldown; expiry never redirects the old URL', async t => {
  const config = manifest(); let calls = 0;
  const { resolver, setNow } = make(t, { config, refreshJitterMs: 0, fetchImpl: () => {
    calls++; if (calls === 1) return response(signed(config)); throw new TypeError('test-only private failure text');
  } });
  await resolver.resolve('/assets/a.png');
  setNow(NOW + 3500000);
  assert.equal((await resolver.resolve('/assets/a.png')).location, signed(config));
  await until(() => resolver.health().failures === 1);
  for (let i = 0; i < 50; i++) assert.equal((await resolver.resolve('/assets/a.png')).location, signed(config));
  assert.equal(calls, 2); assert.equal(resolver.health().cache, 1);
  setNow(NOW + 3601000);
  const expired = await resolver.resolve('/assets/a.png?next=https://evil.test');
  assert.deepEqual(expired, { status: 302, location: config.fallbackBase + '/assets/a.png', fallback: true });
  assert.equal(calls, 3); assert.equal(resolver.health().cache, 0);
});

test('expiry safety skew is enforced at its boundary, including URLs too near expiry when fetched', async t => {
  const config = manifest(); let calls = 0;
  const { resolver, setNow } = make(t, { config, refreshMarginMs: 0, refreshJitterMs: 0, fetchImpl: () => {
    calls++; return calls === 1 ? response(signed(config)) : response(null, 503);
  } });
  await resolver.resolve('/assets/a.png');
  setNow(NOW + 3569999);
  assert.equal((await resolver.resolve('/assets/a.png')).fallback, false); assert.equal(calls, 1);
  setNow(NOW + 3570000);
  assert.equal((await resolver.resolve('/assets/a.png')).fallback, true); assert.equal(calls, 2);
  assert.throws(() => validateDestination(signed(config, config.entries[0].fileName, NOW + 30000),
    config.entries[0].fileName, config, NOW), { message: 'DESTINATION' });
});

test('path decoding is exact, query-independent, and never normalizes traversal into a known entry', async t => {
  const config = manifest([entry('/assets/char_[test]/a.png')]); let calls = 0;
  const { resolver } = make(t, { config, fetchImpl: () => { calls++; return response(signed(config)); } });
  const valid = '/assets/char_%5Btest%5D/%61.png?url=https://evil.test&file_name=elsewhere';
  assert.equal(requestPath(valid), config.entries[0].requestPath);
  assert.equal((await resolver.resolve(valid)).location, signed(config));
  const bad = ['/assets/char_[test]/other.png', '/vendor/a.png', '/fonts/a.png', '/js/game.js',
    '/assets/../assets/char_[test]/a.png', '/assets/%2e%2e/assets/char_[test]/a.png',
    '/assets/x/../char_[test]/a.png', '/assets/x/%2e%2e/char_[test]/a.png',
    '/assets/char_[test]%2fa.png', '/assets/char_[test]%5ca.png',
    '/assets/char_[test]/%252e%252e/a.png', '/assets/char_[test]/a.png%00',
    '/assets/char_[test]/a.png#fragment', '/assets//char_[test]/a.png',
    '/assets/char_[test]/a.png/', '//evil.test/assets/a.png', 'https://evil.test/assets/a.png',
    '/assets/char_[test]/%ZZ.png', '/assets/char_[test]/%FF.png', '/assets/.private/a.png'];
  for (const path of bad) assert.equal((await resolver.resolve(path)).status, 404, path);
  assert.equal(calls, 1); assert.equal(resolver.health().fallbacks, 0);
});

test('destination validation rejects origin, object, encoding, query, and expiry violations without following redirects', async t => {
  const config = manifest([entry('/assets/char_[test]/a.png')]);
  const good = signed(config), parsed = new URL(good);
  const mutation = (fn) => { const url = new URL(good); fn(url); return url.href; };
  const invalid = [
    null, '//obs.cn-south-222.ai.pcl.cn' + parsed.pathname + parsed.search, '/relative',
    good.replace('https:', 'http:'), good.replace('obs.cn-south-222.ai.pcl.cn', 'evil.test'),
    good.replace(':443/', ':444/'), good.replace(':443/', ':0443/'),
    good.replace('https://', 'https://userinfo@'), good.replace('https://', 'https://user:pass@'),
    good + '#fragment', good + '#', good + '\n', good + '&extra=1', good + '&loginToken=not-allowed',
    good + '&Signature=duplicate', good + '&%45xpires=duplicate', good + '&Signature=%0d%0aInjected',
    good.replace('/char_%5Btest%5D/', '/char_%255Btest%255D/'),
    good.replace('/assets/', '/assets%2F'), good.replace('/assets/', '/assets%5C'),
    good.replace('/assets/', '/assets/../assets/'), good.replace('/assets/', '/assets/%2e%2e/assets/'),
    good.replace('/a.png?', '/other.png?'), good.replace(PREFIX, '/other-bucket/other-dataset/'),
    mutation(url => url.searchParams.delete('Signature')), mutation(url => url.searchParams.delete('AWSAccessKeyId')),
    mutation(url => url.searchParams.set('Signature', '')), mutation(url => url.searchParams.set('Expires', '1e12')),
    mutation(url => url.searchParams.set('Expires', '-1')), mutation(url => url.searchParams.set('Expires', '1.5')),
    mutation(url => url.searchParams.set('Expires', String(NOW / 1000))),
    mutation(url => url.searchParams.set('Expires', String((NOW + 29000) / 1000))),
    good + '&response-content-disposition=duplicate', good.replace('test-only-signature', '%ZZ'),
    mutation(url => url.searchParams.set('AWSAccessKeyId', 'key\u0000')),
  ];
  for (const location of invalid) {
    let calls = 0;
    const { resolver } = make(t, { config, fetchImpl: () => { calls++; return response(location); } });
    const result = await resolver.resolve(config.entries[0].requestPath);
    assert.equal(result.location, config.fallbackBase + '/assets/char_%5Btest%5D/a.png');
    assert.equal(result.fallback, true); assert.equal(calls, 1);
  }
  assert.equal(validateDestination(good, config.entries[0].fileName, config, NOW).url, good);
  const defaultPort = good.replace(':443/', '/');
  assert.equal(validateDestination(defaultPort, config.entries[0].fileName, config, NOW).url, defaultPort);
});

test('unsupported API responses fall back to the same release and request path; unknown paths do not resolve or fall back', async t => {
  for (const status of [200, 302, 303, 307, 308, 401, 403, 404, 503]) {
    let calls = 0; const config = aliases();
    const { resolver } = make(t, { config, fetchImpl: () => { calls++; return response(signed(config), status); } });
    const result = await resolver.resolve('/media/test_audio?return=https://evil.test');
    assert.equal(result.location, config.fallbackBase + '/media/test_audio');
    assert.equal(result.status, 302); assert.equal(result.fallback, true);
    assert.equal((await resolver.resolve('/media/unknown')).status, 404); assert.equal(calls, 1);
  }
});

test('defaults cap concurrent API work at four and the unique-file queue at 128; aliases do not consume queue slots', async t => {
  const entries = Array.from({ length: 133 }, (_, i) => entry(`/assets/file_${i}.png`));
  entries.push(entry('/assets/queued_alias.png', entries[4].fileName));
  const config = manifest(entries), gates = [], signals = [];
  const { resolver } = make(t, { config, fetchImpl: (_, options) => {
    signals.push(options.signal); const gate = deferred(); gates.push(gate); return gate.promise;
  } });
  const pending = config.entries.map(value => resolver.resolve(value.requestPath));
  await until(() => gates.length === 4);
  assert.equal(resolver.health().active, 4); assert.equal(resolver.health().queued, 128);
  assert.equal((await pending[132]).fallback, true);
  assert.equal(resolver.health().failures, 1);
  await resolver.close();
  for (const result of await Promise.all(pending)) assert.equal(result.fallback, true);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(resolver.health().active, 0); assert.equal(resolver.health().queued, 0); assert.equal(resolver.health().cache, 0);
  assert.equal(gates.length, 4);
  for (const gate of gates) gate.resolve(response(signed(config)));
  await tick(); assert.equal(resolver.health().cache, 0);
});

test('queue drain starts the next unique file and never exceeds the concurrency limit', async t => {
  const config = manifest(Array.from({ length: 6 }, (_, i) => entry(`/assets/file_${i}.png`)));
  const calls = [], gates = [];
  const { resolver } = make(t, { config, concurrency: 2, fetchImpl: url => {
    calls.push(new URL(url).searchParams.get('file_name'));
    const gate = deferred(); gates.push(gate); return gate.promise;
  } });
  const pending = config.entries.map(value => resolver.resolve(value.requestPath));
  await until(() => calls.length === 2);
  for (let i = 0; i < 6; i++) {
    await until(() => calls.length > i);
    assert.ok(resolver.health().active <= 2);
    gates[i].resolve(response(signed(config, calls[i])));
  }
  const results = await Promise.all(pending);
  assert.ok(results.every(result => !result.fallback)); assert.equal(calls.length, 6);
  assert.equal(resolver.health().queued, 0); assert.equal(resolver.health().cache, 6);
});

test('queued requests time out locally instead of waiting indefinitely behind slow API work', async t => {
  const config = manifest([entry('/assets/a.png'), entry('/assets/b.png')]);
  const { resolver } = make(t, { config, concurrency: 1, timeoutMs: 5000, queueTimeoutMs: 10, fetchImpl: () => deferred().promise });
  const active = resolver.resolve('/assets/a.png');
  assert.equal((await resolver.resolve('/assets/b.png')).fallback, true);
  assert.equal(resolver.health().active, 1); assert.equal(resolver.health().queued, 0);
  await resolver.close(); assert.equal((await active).fallback, true);
});

test('transient failures retry with bounded backoff; API bodies are cancelled without inspection', async t => {
  const config = manifest(); let calls = 0, cancelled = 0;
  const { resolver } = make(t, { config, maxRetries: 1, retryBaseMs: 1, maxRetryDelayMs: 1, fetchImpl: () => {
    calls++;
    return { ...response(calls === 1 ? null : signed(config), calls === 1 ? 503 : 301),
      body: { async cancel() { cancelled++; }, get text() { assert.fail('Body must not be inspected'); } } };
  } });
  assert.equal((await resolver.resolve('/assets/a.png')).fallback, false);
  assert.equal(calls, 2); assert.equal(cancelled, 2); assert.equal(resolver.health().failures, 0);
});

test('429 Retry-After is honored globally for seconds and HTTP dates, with no retry clamped earlier', async t => {
  for (const header of ['60', new Date(NOW + 60000).toUTCString()]) {
    const config = manifest([entry('/assets/a.png'), entry('/assets/b.png')]); let calls = 0;
    const { resolver, setNow } = make(t, { config, maxRetries: 1, fetchImpl: url => {
      calls++;
      return calls === 1 ? response(null, 429, header) : response(signed(config, new URL(url).searchParams.get('file_name'), NOW + 7200000));
    } });
    assert.equal((await resolver.resolve('/assets/a.png')).fallback, true); assert.equal(calls, 1);
    setNow(NOW + 59999);
    assert.equal((await resolver.resolve('/assets/b.png')).fallback, true); assert.equal(calls, 1);
    setNow(NOW + 60000);
    assert.equal((await resolver.resolve('/assets/b.png')).fallback, false); assert.equal(calls, 2);
  }
});

test('timeouts abort each attempt even for an injected fetch that ignores signals; late responses cannot populate cache', async t => {
  const config = manifest(), gates = [], signals = [];
  const { resolver } = make(t, { config, timeoutMs: 10, maxRetries: 1, retryBaseMs: 1, maxRetryDelayMs: 1,
    fetchImpl: (_, options) => { signals.push(options.signal); const gate = deferred(); gates.push(gate); return gate.promise; } });
  assert.equal((await resolver.resolve('/assets/a.png')).fallback, true);
  assert.equal(gates.length, 2); assert.ok(signals.every(signal => signal.aborted));
  for (const gate of gates) gate.resolve(response(signed(config)));
  await tick(); assert.equal(resolver.health().cache, 0); assert.equal(resolver.health().active, 0);
});

test('shutdown aborts API and backoff work, settles waiters, and remains idempotent without new API work', async t => {
  let calls = 0;
  const { resolver } = make(t, { maxRetries: 1, retryBaseMs: 1000, fetchImpl: () => { calls++; throw new TypeError('private text'); } });
  const pending = resolver.resolve('/assets/a.png');
  await until(() => calls === 1); await tick();
  await resolver.close(); await resolver.close();
  assert.equal((await pending).fallback, true);
  assert.equal((await resolver.resolve('/assets/a.png')).fallback, true);
  assert.equal(calls, 1); assert.equal(resolver.health().active, 0);
});

test('native GET/HEAD/OPTIONS, health, method errors and exact-path rejections have no-store and no forwarded credentials', async t => {
  const config = aliases(); const calls = [];
  const app = await native(t, { manifest: config, fetchImpl: (...args) => { calls.push(args); return response(signed(config)); } });
  const head = await rawRequest(app.base, '/media/test_audio?Expires=1', 'HEAD');
  assert.equal(head.status, 302); assert.equal(head.headers.location, config.fallbackBase + '/media/test_audio');
  assert.equal(head.body, ''); assert.equal(calls.length, 0);
  const options = await rawRequest(app.base, '/media/test_audio', 'OPTIONS', { Origin: 'https://unrelated.test', 'Access-Control-Request-Headers': 'Range' });
  assert.equal(options.status, 204); assert.equal(options.headers['access-control-allow-origin'], '*');
  assert.equal(options.headers['access-control-allow-methods'], 'GET, HEAD, OPTIONS'); assert.equal(calls.length, 0);
  const get = await rawRequest(app.base, '/assets/audio/test_audio.mp3?loginToken=ignored', 'GET', {
    Cookie: 'private-cookie=test-only', Authorization: 'Bearer test-only-private', Range: 'bytes=0-1', 'X-Forwarded-For': '203.0.113.1',
  });
  assert.equal(get.status, 302); assert.equal(get.headers.location, signed(config) + '&sp_request=display'); assert.equal(get.body, '');
  assert.equal(get.headers['cache-control'], 'no-store'); assert.equal(get.headers['access-control-allow-origin'], '*');
  assert.equal(get.headers['access-control-allow-credentials'], undefined);
  assert.deepEqual(calls[0][1].headers, { Accept: '*/*' });
  const cachedHead = await rawRequest(app.base, '/media/test_audio.mp3', 'HEAD');
  assert.equal(cachedHead.headers.location, config.fallbackBase + '/media/test_audio.mp3'); assert.equal(calls.length, 1);
  for (const [path, method, expected] of [['/_material', 'GET', 404], ['/media/unknown', 'GET', 404], ['/media/unknown', 'OPTIONS', 404],
    ['/assets/../media/test_audio', 'GET', 404], ...['POST', 'PUT', 'PATCH', 'DELETE', 'TRACE', 'CONNECT']
      .map(method => ['/media/test_audio', method, 405])]) {
    const result = await rawRequest(app.base, path, method);
    assert.equal(result.status, expected); assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers.location, undefined);
  }
  const health = await rawRequest(app.base, '/healthz', 'GET', { 'X-Forwarded-For': '203.0.113.1' });
  assert.equal(health.status, 200); assert.equal(health.headers['access-control-allow-origin'], undefined);
  assert.equal(JSON.parse(health.body).entries, 9); assert.equal(JSON.parse(health.body).files, 1);
  assert.doesNotMatch(health.body, /https|Signature|AWSAccessKeyId|Expires|loginToken|Cookie|test-only/i);
  const rejected = await new Promise(resolve => app.server.emit('request', {
    url: '/healthz', method: 'GET', headers: { 'x-forwarded-for': '127.0.0.1' }, socket: { remoteAddress: '192.0.2.1' },
  }, { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { resolve({ status: this.status, body }); } }));
  assert.equal(rejected.status, 404);
  assert.equal((await rawRequest(app.base, '/healthz', 'OPTIONS')).status, 405);
  await app.close(); await app.close();
});

test('display, CORS, and fetch clients share one signature but use separate OBS cache keys', async t => {
  const config = manifest(); let calls = 0;
  const app = await native(t, { manifest: config, fetchImpl: () => { calls++; return response(signed(config)); } });
  const display = await rawRequest(app.base, '/assets/a.png?sp_request=attacker', 'GET', { 'Sec-Fetch-Mode': 'no-cors' });
  const cors = await rawRequest(app.base, '/assets/a.png', 'GET', { Origin: 'https://game.test', 'Sec-Fetch-Mode': 'cors' });
  const fetch = await rawRequest(app.base, '/assets/a.png', 'GET', { 'Sec-Fetch-Mode': 'cors' });
  const again = await rawRequest(app.base, '/assets/a.png', 'GET');
  assert.equal(display.headers.location, signed(config) + '&sp_request=display');
  assert.equal(cors.headers.location, signed(config) + '&sp_request=cors');
  assert.equal(fetch.headers.location, cors.headers.location);
  assert.equal(again.headers.location, display.headers.location);
  for (const result of [display, cors, fetch, again]) {
    assert.equal(result.status, 302);
    assert.equal(new URL(result.headers.location).origin, config.ossOrigin);
    assert.equal(result.headers.vary, 'Origin, Sec-Fetch-Mode');
    assert.equal(result.headers['cache-control'], 'no-store');
    const url = new URL(result.headers.location);
    url.searchParams.delete('sp_request');
    assert.deepEqual([...url.searchParams], [...new URL(signed(config)).searchParams]);
  }
  assert.equal(calls, 1); assert.equal(app.resolver.health().apiRequests, 1);
  const head = await rawRequest(app.base, '/assets/a.png', 'HEAD', { Origin: 'https://game.test' });
  assert.equal(head.headers.location, config.fallbackBase + '/assets/a.png');
});

test('prewarmed native display and CORS redirects reuse one cached signature and expose counts only', async t => {
  const config = manifest(); let calls = 0;
  const app = await native(t, { manifest: config, prewarm: true, fetchImpl: () => { calls++; return response(signed(config)); } });
  await until(() => app.resolver.health().warmComplete);
  const display = await rawRequest(app.base, '/assets/a.png?sp_request=attacker', 'GET', { 'Sec-Fetch-Mode': 'no-cors' });
  const cors = await rawRequest(app.base, '/assets/a.png', 'GET', { Origin: 'https://game.test', 'Sec-Fetch-Mode': 'cors' });
  assert.equal(display.headers.location, signed(config) + '&sp_request=display');
  assert.equal(cors.headers.location, signed(config) + '&sp_request=cors');
  assert.equal(calls, 1); assert.equal(app.resolver.health().apiRequests, 1);
  const health = await rawRequest(app.base, '/healthz');
  const counts = JSON.parse(health.body);
  assert.equal(counts.prewarmEnabled, true); assert.equal(counts.prewarmCompleted, 1);
  assert.equal(counts.prewarmActive, 0); assert.equal(counts.prewarmRemaining, 0); assert.equal(counts.warmComplete, true);
  assert.doesNotMatch(health.body, /https|Signature|AWSAccessKeyId|Expires|Cookie|test-only/i);
});

test('native fallback redirects remain no-store, CORS-public and exactly same-release', async t => {
  const config = manifest();
  const app = await native(t, { manifest: config, fetchImpl: () => response('https://evil.test/?loginToken=private') });
  const result = await rawRequest(app.base, '/assets/a.png?next=https://evil.test');
  assert.equal(result.status, 302); assert.equal(result.headers.location, config.fallbackBase + '/assets/a.png');
  assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['access-control-allow-origin'], '*');
  assert.equal(result.body, '');
});

test('startServer loads a mounted JSON manifest and fails closed before listening on malformed config or bind settings', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'openi-resolver-test-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const path = join(fixture, 'manifest.json'); const config = manifest();
  await writeFile(path, JSON.stringify(config));
  const app = await startServer({ manifestPath: path, host: '127.0.0.1', port: 0, clock: () => NOW, prewarm: false,
    fetchImpl: () => response(signed(config)) });
  t.after(() => app.close());
  assert.equal(app.server.address().address, '127.0.0.1');
  const result = await rawRequest('http://127.0.0.1:' + app.server.address().port, '/assets/a.png');
  assert.equal(result.status, 302);
  await writeFile(path, '{malformed private content');
  await assert.rejects(startServer({ manifestPath: path, host: '127.0.0.1', port: 0 }), { message: 'CONFIG' });
  await assert.rejects(startServer({ manifest: config, host: 'evil.test', port: 0 }), { message: 'CONFIG' });
  await assert.rejects(startServer({ manifest: config, host: '127.0.0.1', port: NaN }), { message: 'CONFIG' });
  const previousPort = process.env.PORT;
  try {
    for (const value of ['', '3000x', '3e3', '0', '65536']) {
      process.env.PORT = value;
      await assert.rejects(startServer({ manifest: config, host: '127.0.0.1' }), { message: 'CONFIG' });
    }
  } finally { if (previousPort === undefined) delete process.env.PORT; else process.env.PORT = previousPort; }
});
