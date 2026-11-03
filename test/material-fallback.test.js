import test from 'node:test';
import assert from 'node:assert/strict';
import { openiFallbackUrl, withMaterialFallback, fetchMaterial, loadMaterialImage, transientMaterialError, materialCredentials } from '../public/js/materialFallback.js';
import { installPixiMaterialFallback } from '../public/js/render/materialLoader.js';

const origin = 'https://game.example';
const path = '/assets/test/pixel.png';
const forced = path + '?sp_source=openi';

test('only canonical same-origin public material aliases can request OpenI', () => {
  for (const value of [path, '/media/voice/cn/test', '/assets/local/item[1].png', '/assets/local/item%5B1%5D.png']) {
    assert.equal(openiFallbackUrl(value, origin), value + '?sp_source=openi');
  }
  assert.equal(openiFallbackUrl(origin + path, origin), forced);
  for (const value of ['/data/assets.json', '/js/main.js', '/privatecode/x.png', '/auth/x.png', '/ws', '/vendor/x.js', '/fonts/x.woff2',
    '/assets/.hidden.png', '/assets/foo/../x.png', '/assets/foo/%2e%2e/x.png', '/assets/foo%2fbar.png', '/assets/foo%5cbar.png',
    '/assets//x.png', '/assets/x.png.', '/assets/x.svg', '/assets/x.js', '/assets/x.png#x', '//game.example' + path,
    'https://other.example' + path, 'data:image/png,abc', origin + '/assets/x.png?Signature=secret',
    path + '?v=1', forced, forced + '&sp_source=openi', forced + '&next=https://other.example', path + '?sp_source=modelscope']) {
    assert.equal(openiFallbackUrl(value, origin), null, value);
  }
  assert.equal(openiFallbackUrl(origin + path), null, 'absolute URLs need the known page origin');
});

test('success is requested once; a failed canonical load retries once without mutating its URL', async () => {
  const seen = [];
  const load = async url => { seen.push(url); if (url === path) throw new TypeError('network/CORS'); return 'ready'; };
  assert.equal(await withMaterialFallback(path, load), 'ready');
  assert.deepEqual(seen, [path, forced]);
  seen.length = 0;
  assert.equal(await withMaterialFallback(path, async url => { seen.push(url); return 'ready'; }), 'ready');
  assert.deepEqual(seen, [path]);
});

test('two failures terminate, explicit OpenI cannot recurse, unrelated requests never change', async () => {
  for (const [url, expected] of [[path, [path, forced]], [forced, [forced]], ['/data/assets.json', ['/data/assets.json']],
    ['https://other.example/x.png', ['https://other.example/x.png']]]) {
    const seen = [];
    await assert.rejects(withMaterialFallback(url, async source => { seen.push(source); throw new Error('offline'); }), /offline/);
    assert.deepEqual(seen, expected);
  }
});

test('a stalled primary is aborted before OpenI and abandoned late values are disposed', async () => {
  let finish, oldSignal;
  const discarded = [];
  const result = await withMaterialFallback(path, (source, signal) => {
    if (source === path) { oldSignal = signal; return new Promise(resolve => { finish = resolve; }); }
    assert.equal(oldSignal.aborted, true);
    return 'ready';
  }, { timeoutMs: 15, discard: value => discarded.push(value) });
  assert.equal(result, 'ready');
  finish('late texture');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(discarded, ['late texture']);
});

test('caller cancellation does not start fallback and both hanging attempts remain bounded', async () => {
  const controller = new AbortController();
  const seen = [];
  const pending = withMaterialFallback(path, source => { seen.push(source); controller.abort(); return new Promise(() => {}); }, { signal: controller.signal });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(seen, [path]);
  seen.length = 0;
  await assert.rejects(withMaterialFallback(path, source => { seen.push(source); return new Promise(() => {}); }, { timeoutMs: 15, retryMs: [] }), /timeout/);
  assert.deepEqual(seen, [path, forced]);
});

for (const mode of ['network', '404', '403', '503', 'html', 'bad-json', 'body-error', 'body-timeout']) {
  test(`fetch consumes the body within failover: ${mode}`, async () => {
    const seen = [];
    const fetch = async (url, init) => {
      seen.push(url);
      assert.equal(init.credentials, 'omit');
      if (url !== path) return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
      if (mode === 'network') throw new TypeError('CORS');
      if (/^\d+$/.test(mode)) return new Response('failed', { status: Number(mode) });
      if (mode === 'html') return new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } });
      if (mode === 'bad-json') return new Response('not json');
      return { ok: true, json: () => mode === 'body-error' ? Promise.reject(new Error('broken body')) : new Promise(() => {}) };
    };
    assert.deepEqual(await fetchMaterial(path, r => r.json(), { fetch, timeoutMs: 20, idleMs: 20 }), { ok: true });
    assert.deepEqual(seen, [path, forced]);
  });
}

test('cached Image loader uses anonymous CORS and has one bounded fallback', async t => {
  const previous = globalThis.Image;
  const seen = [];
  class FakeImage {
    set src(value) { this._src = value; if (!value) return; seen.push(value); queueMicrotask(() => value === path ? this.onerror?.() : this.onload?.()); }
    get src() { return this._src; }
  }
  globalThis.Image = FakeImage;
  t.after(() => { if (previous === undefined) delete globalThis.Image; else globalThis.Image = previous; });
  const image = await loadMaterialImage(path);
  assert.equal(image.src, forced);
  assert.equal(image.crossOrigin, 'anonymous');
  assert.deepEqual(seen, [path, forced]);
});

test('Pixi retries only failed resource loads, keeps original parse/unload/cache APIs and installs once', async () => {
  const seen = [];
  const parse = () => {}, unload = () => {};
  const parser = { parse, unload, load: async url => { seen.push(url); if (url === '/assets/test/page.png') throw new Error('texture decode'); return { url }; } };
  const pixi = { Assets: { loader: { parsers: [parser] } } };
  installPixiMaterialFallback(pixi); installPixiMaterialFallback(pixi);
  await parser.load('/assets/test/model.skel');
  await parser.load('/assets/test/model.atlas');
  assert.deepEqual(await parser.load('/assets/test/page.png'), { url: '/assets/test/page.png?sp_source=openi' });
  assert.deepEqual(seen, ['/assets/test/model.skel', '/assets/test/model.atlas', '/assets/test/page.png', '/assets/test/page.png?sp_source=openi']);
  assert.equal(parser.parse, parse); assert.equal(parser.unload, unload);
});

test('public Pixi texture decoding retries in its promise and preserves canonical keys/alpha/unload', async t => {
  const previous = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async blob => {
    if (await blob.text() === 'bad') throw new Error('invalid image');
    return { width: 2, height: 2, close() {} };
  };
  t.after(() => { if (previous === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previous; });
  const seen = [];
  let unrelated = 0;
  class BaseTexture { constructor(image, data) { this.image = image; this.data = data; this.resource = {}; } }
  class Texture { constructor(base) { this.baseTexture = base; } destroy() { this.baseTexture.destroyed = true; } }
  const parser = { name: 'loadTextures', config: { preferCreateImageBitmap: true, preferWorkers: true },
    load: async () => { unrelated++; return 'untouched'; }, unload: value => value.destroy(true) };
  const pixi = { BaseTexture, Texture, utils: { getResolutionOfUrl: () => 2 }, settings: { ADAPTER: {
    fetch: async (url, init) => { seen.push(url); assert.equal(init.credentials, 'omit'); return new Response(url.includes('?') ? 'good' : 'bad'); },
  } }, Assets: { loader: { parsers: [parser] } } };
  installPixiMaterialFallback(pixi);
  const value = await parser.load(path, { data: { alphaMode: 2 } }, {});
  assert.equal(value.baseTexture.resource.src, path);
  assert.equal(value.baseTexture.resource.internal, true);
  assert.deepEqual(value.baseTexture.data, { alphaMode: 2, resolution: 2, resourceOptions: { ownsImageBitmap: true } });
  assert.deepEqual(seen, [path, forced]);
  parser.unload(value); assert.equal(value.baseTexture.destroyed, true);
  assert.equal(await parser.load('/vendor/image.png'), 'untouched');
  assert.equal(unrelated, 1);
});

test('a premultiplied page is decoded as it is, also off the public material paths (feedback #48, #55)', async t => {
  const previous = globalThis.createImageBitmap, decoded = [];
  globalThis.createImageBitmap = async (blob, o) => { decoded.push(o); return { width: 1, height: 1, close() {} }; };
  t.after(() => { if (previous === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previous; });
  class BaseTexture { constructor(image, data) { this.image = image; this.data = data; this.resource = {}; } }
  class Texture { constructor(base) { this.baseTexture = base; } }
  const parser = { name: 'loadTextures', config: { preferCreateImageBitmap: true }, load: async () => 'stock' };
  const pixi = { BaseTexture, Texture, ALPHA_MODES: { PMA: 2 }, utils: { getResolutionOfUrl: () => 1 }, settings: { ADAPTER: { fetch: async () => new Response('png') } },
    Assets: { loader: { parsers: [parser] } } };
  installPixiMaterialFallback(pixi);
  await parser.load(path, { data: { alphaMode: 2 } }, {});
  assert.deepEqual(decoded.pop(), { premultiplyAlpha: 'none' });
  await parser.load(path, { data: {} }, {});
  assert.equal(decoded.pop(), undefined, 'a straight page keeps the default decode');
  await parser.load('/assets/~abc123/skins/x/front/x.png', { data: { alphaMode: 2 } }, {});
  assert.deepEqual(decoded.pop(), { premultiplyAlpha: 'none' }, 'an indexed asset URL too');
  assert.equal(await parser.load('/vendor/image.png', { data: {} }, {}), 'stock');
});

test('destroying a late Pixi decode cannot drop the successful replacement cache entry', async t => {
  const previous = globalThis.createImageBitmap;
  let finish;
  globalThis.createImageBitmap = async blob => {
    if (await blob.text() === 'primary') return new Promise(resolve => { finish = resolve; });
    return { close() {} };
  };
  t.after(() => { if (previous === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previous; });
  class BaseTexture {
    constructor() { this.resource = {}; this.listeners = {}; }
    once(name, fn) { this.listeners[name] = fn; }
  }
  class Texture {
    constructor(base) { this.baseTexture = base; this.listeners = {}; }
    once(name, fn) { this.listeners[name] = fn; }
    destroy() { this.baseTexture.destroyed = true; this.baseTexture.listeners.destroyed?.(); this.listeners.destroyed?.(); }
  }
  let cached;
  const record = { promise: null }, loader = { promiseCache: { [path]: record } };
  const parser = { name: 'loadTextures', config: { preferCreateImageBitmap: true }, load: async () => null, unload: value => value.destroy(true) };
  loader.parsers = [parser];
  const pixi = { BaseTexture, Texture, utils: { getResolutionOfUrl: () => 1 },
    settings: { ADAPTER: { fetch: async url => new Response(url.includes('?') ? 'forced' : 'primary') } },
    Assets: { loader, cache: { get: () => cached, remove: () => { cached = null; } } } };
  installPixiMaterialFallback(pixi, { timeoutMs: 15 });
  record.promise = parser.load(path, {}, loader);
  const replacement = cached = await record.promise;
  finish({ close() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loader.promiseCache[path], record);
  assert.equal(cached, replacement);
  parser.unload(replacement);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loader.promiseCache[path], undefined);
  assert.equal(cached, null);
});

test('Pixi detects HTTP/HTML/binary-body failures but does not alter unrelated adapter requests', async () => {
  const seen = [];
  const adapter = { fetch: async url => { seen.push(url); return url.includes('sp_source=') ? new Response('atlas page') : new Response('<html>failed</html>', { status: 403 }); } };
  const parser = { load: async url => (await adapter.fetch(url)).text() };
  const pixi = { settings: { ADAPTER: adapter }, Assets: { loader: { parsers: [parser] } } };
  installPixiMaterialFallback(pixi); installPixiMaterialFallback(pixi);
  assert.equal(await parser.load('/assets/test/model.atlas'), 'atlas page');
  assert.deepEqual(seen, ['/assets/test/model.atlas', '/assets/test/model.atlas?sp_source=openi']);
  assert.equal((await adapter.fetch('/data/assets.json')).status, 403);
  const binary = { load: async url => url.includes('?') ? new Uint8Array([1, 2]).buffer : new ArrayBuffer(0) };
  installPixiMaterialFallback({ Assets: { loader: { parsers: [binary] } } });
  assert.equal((await binary.load('/assets/test/model.skel')).byteLength, 2);
});

// Weak networks (after xinhai-ai 6e4acd3): progress keeps a slow transfer alive, a stall still fails over, and only
// transient failures of both sources take later rounds.
const trickle = (parts, everyMs, { stallAfter = Infinity } = {}) => new Response(new ReadableStream({
  async start(controller) {
    for (let i = 0; i < parts.length; i++) {
      if (i >= stallAfter) return; // never closes
      await new Promise(resolve => setTimeout(resolve, everyMs));
      controller.enqueue(new TextEncoder().encode(parts[i]));
    }
    controller.close();
  },
}), { headers: { 'content-type': 'application/json' } });

test('a slow but moving body outlives the first-response timeout; a stalled one fails over after idleMs', async () => {
  const seen = [];
  const parts = ['{"ok"', ':', 'tr', 'u', 'e', '}'];
  const slow = async url => { seen.push(url); return trickle(parts, 15); };
  assert.deepEqual(await fetchMaterial(path, r => r.json(), { fetch: slow, timeoutMs: 20, idleMs: 60, retryMs: [] }), { ok: true });
  assert.deepEqual(seen, [path], '~90 ms of steady bytes against a 20 ms first-response timeout: no failover');
  seen.length = 0;
  const stalls = async url => { seen.push(url); return url === path ? trickle(parts, 5, { stallAfter: 2 }) : trickle(parts, 1); };
  assert.deepEqual(await fetchMaterial(path, r => r.json(), { fetch: stalls, timeoutMs: 20, idleMs: 40, retryMs: [] }), { ok: true });
  assert.deepEqual(seen, [path, forced]);
});

test('transient failures of both sources take later rounds; a 404, a plain error and fallback: false do not', async () => {
  for (const [label, status, rounds, fallback, expected] of [
    ['503 then fine', 503, 2, undefined, [path, forced, path, forced, path]],
    ['404', 404, 2, undefined, [path, forced]],
    ['no own failover', 503, 2, false, [path]],
  ]) {
    const seen = [];
    let n = 0;
    const fetch = async url => { seen.push(url); return ++n <= 4 ? new Response('x', { status }) : new Response('{"ok":true}'); };
    const run = fetchMaterial(path, r => r.json(), { fetch, timeoutMs: 50, retryMs: Array(rounds).fill(5), ...(fallback === false ? { fallback } : {}) });
    if (label === '503 then fine') assert.deepEqual(await run, { ok: true });
    else await assert.rejects(run);
    assert.deepEqual(seen, expected, label);
  }
  assert.equal(transientMaterialError(Object.assign(new Error('t'), { timeout: true })), true);
  assert.equal(transientMaterialError(new TypeError('network')), true);
  assert.equal(transientMaterialError(Object.assign(new Error('gone'), { status: 404 })), false);
  assert.equal(transientMaterialError(Object.assign(new Error('x'), { name: 'AbortError' })), false);
});

test('a caller cancelling during the pause between rounds stops at once', async () => {
  const controller = new AbortController();
  const seen = [];
  const pending = fetchMaterial(path, r => r.json(), { signal: controller.signal, timeoutMs: 50, retryMs: [10_000],
    fetch: async url => { seen.push(url); if (url !== path) setTimeout(() => controller.abort(), 5); return new Response('x', { status: 502 }); } });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(seen, [path, forced]);
});

test('Pixi loads through the adapter report progress: a slow skeleton keeps loading past the first-response timeout', async () => {
  const seen = [];
  const adapter = { fetch: async url => { seen.push(url); return trickle(['sk', 'el', 'et', 'on'], 15); } };
  const parser = { load: async url => (await adapter.fetch(url)).text() };
  installPixiMaterialFallback({ settings: { ADAPTER: adapter }, Assets: { loader: { parsers: [parser] } } }, { timeoutMs: 20, idleMs: 60, retryMs: [] });
  assert.equal(await parser.load('/assets/test/slow.skel'), 'skeleton');
  assert.deepEqual(seen, ['/assets/test/slow.skel']);
});

// 联动 pack (rel26, 2026-11-02): the edge serves /assets/collab/ from its own copy behind the password gate; the page
// textures and sounds fetched without credentials got 401 (Jinan: ~94 % of the requests for 结城理's model page).
const collab = '/assets/collab/spine/op/char_4217_makoto/front/char_4217_makoto.png';
test('the 联动 pack is fetched with the page\'s own credentials, every other material without', () => {
  for (const value of [collab, collab + '?sp_source=openi', origin + collab, '/assets/collab/audio/voice/jp/char_4217_makoto/cn_020.mp3']) {
    assert.equal(materialCredentials(value, origin), 'same-origin', value);
  }
  for (const value of [path, forced, '/media/voice/cn/test', '/assets/spine/op/char_002_amiya/front/char_002_amiya.png',
    'https://other.example' + collab, '//other.example' + collab, '/assets/collab/../x.png', '/assets/collabx/x.png', '/data/assets-collab.json', null, 42]) {
    assert.equal(materialCredentials(value, origin), 'omit', String(value));
  }
});

test('a 联动 page texture and sound carry the gate cookie (same-origin), a public one none', async t => {
  const previous = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
  t.after(() => { if (previous === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = previous; });
  const seen = [];
  class BaseTexture { constructor(image, data) { this.image = image; this.data = data; this.resource = {}; } }
  class Texture { constructor(base) { this.baseTexture = base; } }
  const parser = { name: 'loadTextures', config: { preferCreateImageBitmap: true, preferWorkers: true }, load: async () => 'stock' };
  const pixi = { BaseTexture, Texture, utils: { getResolutionOfUrl: () => 1 }, settings: { ADAPTER: {
    fetch: async (url, init) => { seen.push([url, init.credentials]); return new Response('png'); },
  } }, Assets: { loader: { parsers: [parser] } } };
  installPixiMaterialFallback(pixi);
  await parser.load(collab, {}, {});
  await parser.load(path, {}, {});
  assert.deepEqual(seen, [[collab, 'same-origin'], [path, 'omit']]);
  const heard = [];
  const fetch = async (url, init) => { heard.push([url, init.credentials]); return new Response('mp3'); };
  await fetchMaterial('/assets/collab/audio/sfx/battle/b_char/b_char_atkboost.mp3', r => r.text(), { fetch });
  await fetchMaterial('/media/voice/cn/test', r => r.text(), { fetch });
  assert.deepEqual(heard, [['/assets/collab/audio/sfx/battle/b_char/b_char_atkboost.mp3', 'same-origin'], ['/media/voice/cn/test', 'omit']]);
});
