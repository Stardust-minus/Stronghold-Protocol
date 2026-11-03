// Public material failover only: retry a failed same-origin asset once through the paired OpenI inventory.
// Never inspect provider redirects/signatures, replace global fetch, or change authentication/business requests.
//
// Weak networks (ideas from xinhai-ai/Stronghold-Protocol 6e4acd3): MATERIAL_TIMEOUT_MS bounds the wait for a first
// sign of life only. A load that reports progress (response headers, then body bytes — fetchMaterial, the Pixi loaders)
// may then take as long as it keeps moving: MATERIAL_IDLE_MS without a byte fails it, MATERIAL_TOTAL_MS ends it anyway.
// An <img> reports no progress and waits MATERIAL_IMAGE_TIMEOUT_MS. When both sources failed transiently (a timeout, a
// network error, 408/425/429/5xx — never a 404), the pair is tried again after MATERIAL_RETRY_MS.

export const MATERIAL_TIMEOUT_MS = 8000;
export const MATERIAL_IDLE_MS = 20000;
export const MATERIAL_TOTAL_MS = 120000;
export const MATERIAL_IMAGE_TIMEOUT_MS = 15000;
export const MATERIAL_RETRY_MS = Object.freeze([2000, 6000]);
const EXTENSIONS = /\.(?:png|jpg|jpeg|webp|gif|atlas|skel|obj|mtl|json|mp3|m4a|aac|ogg|oga|opus|wav)$/;

/** Raw-path validation comes before URL normalization (which would hide traversal). No signed/custom queries. */
function materialUrl(value, origin = globalThis.location?.origin) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\s\\#\u0000-\u001f\u007f]/.test(value)) return null;
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(value);
  if (value.startsWith('//') || (absolute && !origin)) return null;
  const raw = absolute ? /^https?:\/\/[^/?#]+(\/[^?#]*)/.exec(value)?.[1] : value.split('?')[0];
  if (!raw || !raw.startsWith('/') || /%(?:2f|5c)/i.test(raw)) return null;
  let path, url;
  try { path = decodeURIComponent(raw); url = new URL(value, origin || 'http://localhost'); } catch { return null; }
  if (url.origin !== (origin || 'http://localhost') || url.username || url.password) return null;
  if (!/^\/(?:assets|media)\//.test(path) || path.split('/').slice(1).some(s => !/^[A-Za-z0-9_\[\]-][A-Za-z0-9_.\[\]-]*$/.test(s) || s.endsWith('.'))) return null;
  if (path.startsWith('/assets/') && !EXTENSIONS.test(path)) return null;
  const query = [...url.searchParams];
  if (query.length && (query.length !== 1 || query[0][0] !== 'sp_source' || query[0][1] !== 'openi')) return null;
  return url;
}

export const isPublicMaterialUrl = (value, origin = globalThis.location?.origin) => !!materialUrl(value, origin);

/**
 * The credentials of a material request: none (the CDN redirects, OpenI, this edge's public /assets/ and /media/), but the
 * page's own for the 联动 pack (`/assets/collab/`, data/assets-collab.json): the edge serves it from its own copy behind the
 * password gate (deploy/stardust/MATERIAL-SOURCES.md), so a request without the gate cookie gets 401. The Pixi page
 * textures (render/materialLoader.js) and the sounds (fetchMaterial) went without it: on 2026-11-02 Jinan answered 401 to
 * ~94 % of the requests for 结城理's model page (its atlas and skeleton, fetched by Pixi itself, and the <img> art passed);
 * only a page whose service worker re-fetched it (sw.js, same-origin credentials) drew the model. 'same-origin' never sends
 * a cookie to another origin, so a fallback source elsewhere is fetched exactly as before.
 * @param {string} value @param {string} [origin]
 * @returns {'same-origin' | 'omit'}
 */
export function materialCredentials(value, origin = globalThis.location?.origin) {
  const url = materialUrl(value, origin);
  let path = null;
  try { path = url ? decodeURIComponent(url.pathname) : null; } catch { path = null; }
  return path && path.startsWith('/assets/collab/') ? 'same-origin' : 'omit';
}

export function openiFallbackUrl(value, origin = globalThis.location?.origin) {
  const url = materialUrl(value, origin);
  return url && !url.search ? `${url.pathname}?sp_source=openi` : null;
}

const aborted = () => Object.assign(new Error('material load aborted'), { name: 'AbortError' });
const noProgress = () => {};

/**
 * One bounded attempt; abort fetch/Image when possible and dispose abandoned late decoded resources. `load(url, signal,
 * progress)` may call progress() whenever the transfer moves: from then on only a stall (idleMs) or totalMs ends it.
 */
function attempt(url, load, { timeoutMs, idleMs = MATERIAL_IDLE_MS, totalMs = MATERIAL_TOTAL_MS, signal, discard }) {
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let done = false, timer, total;
    const finish = (err, value) => {
      if (done) { if (!err) { try { discard?.(value); } catch { /* abandoned resource */ } } return; }
      done = true;
      clearTimeout(timer); clearTimeout(total);
      signal?.removeEventListener('abort', cancel);
      if (err) { controller.abort(); reject(err); } else resolve(value);
    };
    const cancel = () => finish(aborted());
    const expire = () => finish(Object.assign(new Error('material load timeout'), { timeout: true }));
    const progress = () => { if (done) return; clearTimeout(timer); timer = setTimeout(expire, Math.max(idleMs, timeoutMs)); };
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(expire, timeoutMs);
    if (totalMs > 0) total = setTimeout(expire, Math.max(totalMs, timeoutMs));
    Promise.resolve().then(() => load(url, controller.signal, progress)).then(v => finish(null, v), err => finish(err));
  });
}

// Fork (2026-10-16): a material load that showed no sign of life in time is told to these listeners (ui/assetSection.js:
// a hint, once, to download the art ahead in 设置 → 素材下载). A listener cannot change or fail the load.
const slowListeners = new Set();
/** @param {() => void} listener @returns {() => void} unsubscribe */
export function onMaterialSlow(listener) {
  slowListeners.add(listener);
  return () => { slowListeners.delete(listener); };
}
function reportSlow() {
  for (const listener of [...slowListeners]) { try { listener(); } catch { /* a hint only */ } }
}

/** A failure worth another round later: a timeout, a network error, or an HTTP status that may pass (never a 404). */
export const transientMaterialError = (err) => err?.name !== 'AbortError'
  && (err?.timeout === true || err?.name === 'TypeError' || [408, 425, 429].includes(err?.status) || err?.status >= 500);

function pause(ms, signal) {
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', stop); resolve(); };
    const timer = setTimeout(done, ms);
    const stop = () => { clearTimeout(timer); reject(aborted()); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/**
 * Successful requests are never duplicated. An explicit OpenI attempt cannot recurse; caller cancellation cannot retry.
 * `fallback: false` (a caller running its own failover) also takes no later rounds: retries never multiply.
 */
export async function withMaterialFallback(url, load, options = {}) {
  if (!materialUrl(url, options.origin)) return load(url, options.signal, noProgress);
  const settings = { timeoutMs: MATERIAL_TIMEOUT_MS, ...options };
  const rounds = options.fallback === false ? [] : (options.retryMs ?? MATERIAL_RETRY_MS);
  const fallback = openiFallbackUrl(url, options.origin);
  for (let round = 0; ; round++) { // bounded: rounds.length + 1 rounds
    let err;
    try { return await attempt(url, load, settings); }
    catch (primary) {
      err = primary;
      if (options.signal?.aborted || err?.name === 'AbortError') throw err;
      if (err?.timeout === true) reportSlow();
      if (fallback && options.fallback !== false) {
        try { return await attempt(fallback, load, settings); }
        catch (second) { err = second; }
      }
    }
    if (round >= rounds.length || options.signal?.aborted || !transientMaterialError(err)) throw err;
    await pause(rounds[round] * (0.8 + Math.random() * 0.4), options.signal);
  }
}

/**
 * The response with its body read through, calling progress() per chunk (a stalled body is then an idle timeout,
 * not a 120 s wait). A body without a stream reader is returned as it is.
 * @param {Response} res @param {() => void} progress @returns {Promise<Response>}
 */
export async function readMaterialBody(res, progress) {
  const reader = res?.body?.getReader?.();
  if (!reader) return res;
  const chunks = [];
  for (;;) { // ends with the body, or with the attempt's abort (the read rejects)
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.byteLength) { chunks.push(value); progress(); }
  }
  return new Response(new Blob(chunks), { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** Consume inside the attempt: stalled/error bodies and invalid JSON can fail over, not just fetch() headers. */
export function fetchMaterial(url, read = r => r.arrayBuffer(), { fetch: doFetch = (...a) => globalThis.fetch(...a), ...options } = {}) {
  return withMaterialFallback(url, async (source, signal, progress) => {
    const res = await doFetch(source, { credentials: materialCredentials(source), signal });
    if (!res?.ok || /(?:text\/html|application\/xhtml\+xml)/i.test(res.headers?.get?.('content-type') || '')) {
      try { void res?.body?.cancel?.().catch(() => {}); } catch { /* unusable response */ }
      throw Object.assign(new Error('material response unavailable'), { status: res?.status, badContentType: !!res?.ok });
    }
    progress();
    return read(await readMaterialBody(res, progress));
  }, options);
}

/** CORS-safe Image for canvas/preload; cancellation releases listeners and the pending image request. */
export function loadMaterialImage(url, options) {
  return withMaterialFallback(url, (source, signal) => new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') { reject(new Error('no Image in this environment')); return; }
    const img = new Image();
    const clear = () => { img.onload = img.onerror = null; signal?.removeEventListener('abort', cancel); };
    const cancel = () => { clear(); img.src = ''; reject(aborted()); };
    img.decoding = 'async';
    img.crossOrigin = 'anonymous';
    img.onload = () => { clear(); resolve(img); };
    img.onerror = () => { clear(); reject(new Error('material image unavailable')); };
    signal?.addEventListener('abort', cancel, { once: true });
    img.src = source;
  }), { timeoutMs: MATERIAL_IMAGE_TIMEOUT_MS, ...options });
}
