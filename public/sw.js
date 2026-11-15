// Classic service worker for art a player imported on this origin, and (fork) the runtime art cache.
// Keep these three lines in sync with public/js/assetCache.js (that module documents why this file is not a module).
const IMPORTED_ASSET_CACHE = 'sp-imported-assets-v1';
const IMPORTED_ASSET_CACHE_PREFIX = 'sp-imported-assets-';
const IMPORTED_ASSET_PATH = /^\/(?:assets|fonts|media)\/~[0-9a-f]{16}\//;

// Runtime art cache (fork 2026-10-16, after xinhai-ai/Stronghold-Protocol 4b47e3d). Only when the page registered this
// worker as /sw.js?material=<profile> (public/js/assetCache.js assetWorkerUrl; the profile comes from /code-source.json).
// A same-origin GET of public art — the /assets/ and /media/ paths public/js/materialFallback.js accepts, with no query
// or its OpenI retry `?sp_source=openi` — is answered from Cache Storage by its path, so the provider's rotating signed
// redirect does not download the same file again; the OpenI retry fills the same entry. A miss is fetched in CORS mode
// (an opaque response can be neither checked nor kept: Chrome charges megabytes of quota for each) and only a complete
// 200 that is not an HTML error page is kept. Another profile is another cache: activating one drops the others,
// except the one /code-source.json `materialCarry.from` names (deploy/stardust/STUDIO-CODE-SOURCE.md): a miss is then
// answered from that cache unless its path is in `materialCarry.drop` (exact paths, or directories ending in `/`, whose
// bytes changed), and the entry moves to this profile's cache. A switch then refetches only what changed.
// A real miss of a plain path (no OpenI retry query) asks POST /material-sign (deploy/stardust/material-lb/sign.lua)
// for the provider's signed CDN URL, many paths per request, and fetches that URL itself: one small request to the
// proxy per batch instead of one signed 302 per file. A path the answer leaves out, a failed sign request or a failed
// CDN download falls back to the plain path (the proxy's 302) — the old behavior. Signed URLs live only in this
// worker's memory and are used until SIGN_MARGIN_S before the expiry the proxy states (relative seconds, so the
// player's clock does not matter); what is kept in Cache Storage is the file, which no signature expiry touches.
// Range requests, other paths and other origins never reach it.
const MATERIAL_CACHE_PREFIX = 'sp-material-';
const MATERIAL_PROFILE = (() => {
  try {
    const value = new URL(self.location.href).searchParams.get('material');
    return value && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) ? value : null;
  } catch { return null; }
})();
const MATERIAL_CACHE = MATERIAL_PROFILE ? MATERIAL_CACHE_PREFIX + MATERIAL_PROFILE : null;
const MATERIAL_EXTENSIONS = /\.(?:png|jpg|jpeg|webp|gif|atlas|skel|obj|mtl|json|mp3|m4a|aac|ogg|oga|opus|wav)$/;

/** The cache key (origin + path) of a public art URL, or null. */
function materialKey(url) {
  const query = [...url.searchParams];
  if (query.length && (query.length !== 1 || query[0][0] !== 'sp_source' || query[0][1] !== 'openi')) return null;
  if (/%(?:2f|5c)/i.test(url.pathname)) return null;
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return null; }
  if (!/^\/(?:assets|media)\//.test(path)) return null;
  if (path.split('/').slice(1).some((s) => !/^[A-Za-z0-9_[\]-][A-Za-z0-9_.[\]-]*$/.test(s) || s.endsWith('.'))) return null;
  if (path.startsWith('/assets/') && !MATERIAL_EXTENSIONS.test(path)) return null;
  return url.origin + url.pathname;
}

/** Where the activated carry-over is kept, inside MATERIAL_CACHE (never a path the page requests through materialKey). */
const MATERIAL_CARRY_KEY = '/__sp-material-carry';
const MATERIAL_CARRY_MAX = 4096;

/** `materialCarry` of a /code-source.json that names this worker's profile → { from, drop }, or null. */
function parseCarry(json) {
  const carry = json && json.material === MATERIAL_PROFILE ? json.materialCarry : null;
  if (!carry || typeof carry.from !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(carry.from)
    || carry.from === MATERIAL_PROFILE || !Array.isArray(carry.drop) || carry.drop.length > MATERIAL_CARRY_MAX
    || carry.drop.some((p) => typeof p !== 'string' || !/^\/(?:assets|media)\/./.test(p))) return null;
  return { from: carry.from, drop: carry.drop };
}

async function fetchCarry() {
  try {
    const res = await fetch('/code-source.json', { cache: 'no-store', credentials: 'same-origin' });
    return res.ok ? parseCarry(await res.json()) : null;
  } catch { return null; }
}

let carryState = null;
/** The carry-over this worker activated with: { cacheName, exact: Set, dirs: string[] }, or null. Read once per start. */
function activeCarry() {
  if (!carryState) {
    carryState = (async () => {
      try {
        const hit = await caches.match(self.location.origin + MATERIAL_CARRY_KEY, { cacheName: MATERIAL_CACHE });
        const carry = hit ? parseCarry({ material: MATERIAL_PROFILE, materialCarry: await hit.json() }) : null;
        return carry && { cacheName: MATERIAL_CACHE_PREFIX + carry.from, exact: new Set(carry.drop.filter((p) => !p.endsWith('/'))),
          dirs: carry.drop.filter((p) => p.endsWith('/')) };
      } catch { return null; }
    })();
  }
  return carryState;
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const carry = MATERIAL_CACHE ? await fetchCarry() : null;
    const kept = carry ? MATERIAL_CACHE_PREFIX + carry.from : null;
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => (name.startsWith(IMPORTED_ASSET_CACHE_PREFIX) && name !== IMPORTED_ASSET_CACHE)
        // a worker without a profile (its page could not read /code-source.json) leaves the art cache to the next one
        || (MATERIAL_CACHE && name.startsWith(MATERIAL_CACHE_PREFIX) && name !== MATERIAL_CACHE && name !== kept))
      .map((name) => caches.delete(name)));
    if (MATERIAL_CACHE) {
      try {
        const cache = await caches.open(MATERIAL_CACHE);
        const key = self.location.origin + MATERIAL_CARRY_KEY;
        if (carry && names.includes(kept)) {
          await cache.put(key, new Response(JSON.stringify(carry), { headers: { 'content-type': 'application/json' } }));
        } else {
          await cache.delete(key);
        }
      } catch { /* no storage: nothing carried */ }
      carryState = null;
    }
    await self.clients.claim();
  })());
});

/** A miss of this profile answered from the carried profile's cache (moved into `cache`), or null. */
async function carriedArt(event, cache, key) {
  const carry = await activeCarry();
  if (!carry) return null;
  let path;
  try { path = decodeURIComponent(new URL(key).pathname); } catch { return null; }
  if (carry.exact.has(path) || carry.dirs.some((dir) => path.startsWith(dir))) return null;
  let hit;
  try { hit = await caches.match(key, { cacheName: carry.cacheName }); } catch { return null; }
  if (!hit) return null;
  if (cache) {
    event.waitUntil(cache.put(key, hit.clone())
      .then(() => caches.open(carry.cacheName)).then((old) => old.delete(key))
      .catch(() => { /* quota: served, not moved */ }));
  }
  return hit;
}

/** Batch signer (fork 2026-10-17): POST /material-sign {paths} → {urls: {path: [signed CDN URL, seconds valid]}}. */
const SIGN_URL = '/material-sign';
const SIGN_BATCH_MAX = 64;     // sign.lua accepts at most this many paths per request
const SIGN_WAIT_MS = 25;       // collect the misses of one burst (a scene, a skin) into one request
const SIGN_MARGIN_S = 60;      // stop using a signed URL this long before the proxy's stated expiry
const SIGN_CACHE_MAX = 4096;
const SIGN_HOST = /^https:\/\/cdn-lfs[A-Za-z0-9-]*\.modelscope\.cn\/[^\s]*$/;
const signedUrls = new Map(); // path -> { url, until } (Date.now() ms)
let signBatch = null;         // { paths: Map(path -> resolve[]), timer }
let signOffUntil = 0;         // no endpoint (old proxy), refused or failing: the plain path until then

function forgetSigned(path) { signedUrls.delete(path); }

/** The signed CDN URL for a public alias path, or null (use the plain path). */
function signedUrl(path) {
  const now = Date.now();
  const known = signedUrls.get(path);
  if (known && known.until > now) return Promise.resolve(known.url);
  if (known) signedUrls.delete(path);
  if (now < signOffUntil) return Promise.resolve(null);
  return new Promise((resolve) => {
    if (!signBatch) signBatch = { paths: new Map(), timer: setTimeout(flushSign, SIGN_WAIT_MS) };
    const waiting = signBatch.paths.get(path);
    if (waiting) waiting.push(resolve); else signBatch.paths.set(path, [resolve]);
    if (signBatch.paths.size >= SIGN_BATCH_MAX) { clearTimeout(signBatch.timer); flushSign(); }
  });
}

async function flushSign() {
  const batch = signBatch;
  signBatch = null;
  if (!batch) return;
  const started = Date.now();
  let urls = null;
  try {
    const res = await fetch(SIGN_URL, { method: 'POST', cache: 'no-store', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: [...batch.paths.keys()] }) });
    if (res.status === 200 && /^application\/json\b/i.test(res.headers.get('content-type') || '')) {
      const json = await res.json();
      urls = json && typeof json.urls === 'object' && json.urls && !Array.isArray(json.urls) ? json.urls : null;
    }
    // 404/405, an HTML page (a proxy without the endpoint), the gate: stop asking for a while; 429/5xx: briefly
    if (!urls) signOffUntil = Date.now() + (res.status === 429 || res.status >= 500 ? 30e3 : 600e3);
  } catch { signOffUntil = Date.now() + 30e3; }
  if (urls && signedUrls.size > SIGN_CACHE_MAX) {
    for (const [path, entry] of signedUrls) if (entry.until <= started) signedUrls.delete(path);
    if (signedUrls.size > SIGN_CACHE_MAX) signedUrls.clear();
  }
  for (const [path, resolvers] of batch.paths) {
    const entry = urls && Object.prototype.hasOwnProperty.call(urls, path) ? urls[path] : null;
    let url = null;
    if (Array.isArray(entry) && typeof entry[0] === 'string' && SIGN_HOST.test(entry[0])
      && Number.isFinite(entry[1]) && entry[1] > SIGN_MARGIN_S) {
      url = entry[0];
      signedUrls.set(path, { url, until: started + (entry[1] - SIGN_MARGIN_S) * 1000 });
    }
    for (const resolve of resolvers) resolve(url);
  }
}

/** A complete 200 straight from the CDN for `path`, or null (the caller fetches the plain path). */
async function directArt(path, signal) {
  const url = await signedUrl(path);
  if (!url) return null;
  try {
    // no-store: the file is kept once, in Cache Storage, not again under a signature that changes every window
    const res = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store', signal });
    if (res.status === 200) return res;
  } catch (err) {
    if (signal && signal.aborted) throw err;
  }
  forgetSigned(path); // expired, refused or unreachable: the next miss signs again
  return null;
}

async function importedAsset(request, url) {
  const cache = await caches.open(IMPORTED_ASSET_CACHE);
  // The exact key: an import stores each URL without a query, so the path is the key. `ignoreSearch` would make
  // Chrome scan every entry — about 4 s per request once a whole pack (some 43,000 entries) is imported.
  const hit = await cache.match(url.origin + url.pathname);
  if (hit) return hit;
  // Do not cache the network response. The browser's own HTTP cache still applies to this fetch.
  return fetch(request);
}

async function runtimeArt(event, request, key) {
  let cache = null;
  try {
    cache = await caches.open(MATERIAL_CACHE);
    const hit = await cache.match(key);
    if (hit) return hit;
  } catch { /* no storage: the network */ }
  const carried = await carriedArt(event, cache, key);
  if (carried) return carried;
  let response = null;
  if (!new URL(request.url).search) { // not an OpenI retry
    let path = null;
    try { path = decodeURIComponent(new URL(key).pathname); } catch { /* materialKey decoded it already */ }
    if (path) response = await directArt(path, request.signal);
  }
  if (!response) {
    try {
      // CORS also for a plain <img> (no-cors): a CORS response may answer it, and only a readable one can be kept
      response = await fetch(request.url, { mode: 'cors', credentials: 'same-origin', signal: request.signal });
    } catch (err) {
      if (request.signal && request.signal.aborted) throw err;
      return fetch(request); // a source without CORS: the page's own request, not kept
    }
  }
  const type = response.headers.get('content-type') || '';
  const control = response.headers.get('cache-control') || '';
  if (cache && response.status === 200 && response.type !== 'opaque' && !/text\/html|application\/xhtml\+xml/i.test(type)
    && !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(control)) {
    const copy = response.clone();
    event.waitUntil(cache.put(key, copy).catch(() => { /* quota or a dropped body: just not kept */ }));
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;
  // A cache-only probe (resourceCheck.js) must reach the browser HTTP cache. respondWith, even with 504, hides
  // that cache. Leaving the event unanswered lets a hit return and a miss reject, with no network. Cache Storage
  // is already decided by the page's caches.match before this probe.
  if (request.cache === 'only-if-cached') return;
  let url;
  try { url = new URL(request.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (IMPORTED_ASSET_PATH.test(url.pathname)) { event.respondWith(importedAsset(request, url)); return; }
  const key = MATERIAL_CACHE ? materialKey(url) : null;
  if (key) event.respondWith(runtimeArt(event, request, key));
});
