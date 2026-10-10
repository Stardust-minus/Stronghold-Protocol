// Public material failover only: retry a failed same-origin asset once through the paired OpenI inventory.
// Never inspect provider redirects/signatures, replace global fetch, or change authentication/business requests.

export const MATERIAL_TIMEOUT_MS = 8000;
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

export function openiFallbackUrl(value, origin = globalThis.location?.origin) {
  const url = materialUrl(value, origin);
  return url && !url.search ? `${url.pathname}?sp_source=openi` : null;
}

const aborted = () => Object.assign(new Error('material load aborted'), { name: 'AbortError' });

/** One bounded attempt; abort fetch/Image when possible and dispose abandoned late decoded resources. */
function attempt(url, load, { timeoutMs, signal, discard }) {
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let done = false, timer;
    const finish = (err, value) => {
      if (done) { if (!err) { try { discard?.(value); } catch { /* abandoned resource */ } } return; }
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (err) { controller.abort(); reject(err); } else resolve(value);
    };
    const cancel = () => finish(aborted());
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => finish(new Error('material load timeout')), timeoutMs);
    Promise.resolve().then(() => load(url, controller.signal)).then(v => finish(null, v), err => finish(err));
  });
}

/** Successful requests are never duplicated. An explicit OpenI attempt cannot recurse; caller cancellation cannot retry. */
export async function withMaterialFallback(url, load, options = {}) {
  if (!materialUrl(url, options.origin)) return load(url, options.signal);
  const settings = { timeoutMs: MATERIAL_TIMEOUT_MS, ...options };
  try { return await attempt(url, load, settings); }
  catch (err) {
    const fallback = openiFallbackUrl(url, options.origin);
    if (!fallback || options.fallback === false || options.signal?.aborted || err?.name === 'AbortError') throw err;
    return attempt(fallback, load, settings);
  }
}

/** Consume inside the attempt: stalled/error bodies and invalid JSON can fail over, not just fetch() headers. */
export function fetchMaterial(url, read = r => r.arrayBuffer(), { fetch: doFetch = (...a) => globalThis.fetch(...a), ...options } = {}) {
  return withMaterialFallback(url, async (source, signal) => {
    const res = await doFetch(source, { credentials: 'omit', signal });
    if (!res?.ok || /(?:text\/html|application\/xhtml\+xml)/i.test(res.headers?.get?.('content-type') || '')) {
      try { void res?.body?.cancel?.().catch(() => {}); } catch { /* unusable response */ }
      throw Object.assign(new Error('material response unavailable'), { status: res?.status, badContentType: !!res?.ok });
    }
    return read(res);
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
  }), options);
}
