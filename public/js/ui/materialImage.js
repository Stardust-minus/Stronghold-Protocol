// Native img with one per-URL OpenI retry. Existing placeholder handlers run only after both sources fail.
// An image that has already loaded never times out: a lazy image's observer can report it in view only after its
// load event (busy phones entering a match, the browser's own wider lazy-load margin), and the timer then checks the
// element itself before swapping to OpenI. A timer that ends while the page is hidden waits for it to be shown again.
import { h } from '../../vendor/preact.module.js';
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { MATERIAL_IMAGE_TIMEOUT_MS, openiFallbackUrl } from '../materialFallback.js';

/** How long a failed picture rests before it is asked for again; a URL gets one try per entry in a page's life. */
export const IMAGE_RETRY_MS = Object.freeze([10000, 30000, 120000]);
const retried = new Map();

/**
 * A picture that failed, for the fallback a caller draws: `[failed, fail]`. A fetch or Spine load takes MATERIAL_RETRY_MS
 * rounds; an <img> has only its one OpenI swap, and on a busy line (a material download taking the bandwidth) both
 * sources time out while the art is fine. Without a later try its letter-on-a-disc fallback stayed for good (feedback
 * #44). The rounds are counted per URL, so a picture that really is missing costs a few requests at most.
 * @param {string|null|undefined} src @returns {[boolean, () => void]}
 */
export function useImageFailure(src) {
  const [bad, setBad] = useState(null);
  useEffect(() => {
    if (bad == null) return undefined;
    const n = retried.get(bad) || 0;
    if (n >= IMAGE_RETRY_MS.length) return undefined;
    const timer = setTimeout(() => { retried.set(bad, n + 1); setBad(null); }, IMAGE_RETRY_MS[n]);
    return () => clearTimeout(timer);
  }, [bad]);
  return [bad != null && bad === src, () => setBad(src)];
}

export function MaterialImage({ src, onLoad, onError, loading, timeoutMs = MATERIAL_IMAGE_TIMEOUT_MS, ...props }) {
  const [retry, setRetry] = useState(null);
  const source = retry?.original === src ? retry.source : src;
  const node = useRef(null);
  const timer = useRef(null);
  const current = useRef(null);
  const failed = useRef(null);
  const loaded = useRef(null);
  const watch = useRef(null);
  current.current = source;
  const clear = () => { clearTimeout(timer.current); timer.current = null; };
  const done = (img) => loaded.current === source || !!(img?.complete && img.naturalWidth > 0);
  const fail = (event) => {
    if (current.current !== source || failed.current === source) return;
    clear();
    failed.current = source;
    const fallback = openiFallbackUrl(source);
    if (fallback) setRetry({ original: src, source: fallback });
    else onError?.(event);
  };
  useEffect(() => {
    const img = node.current;
    let observer;
    if (!openiFallbackUrl(src) || !img || done(img)) return;
    const expire = () => {
      timer.current = null;
      if (current.current !== source || done(img)) return;
      if (globalThis.document?.hidden) { arm(); return; } // a backgrounded tab: no verdict on a frozen load
      fail({ type: 'error', target: img, currentTarget: img });
    };
    const arm = () => { timer.current = setTimeout(expire, timeoutMs); };
    const start = () => {
      if (current.current !== source || failed.current === source || timer.current != null || done(img)) return;
      arm();
    };
    // Do not time out an offscreen lazy image that the browser has not even requested yet.
    if (loading === 'lazy') {
      if (typeof IntersectionObserver !== 'undefined') {
        observer = new IntersectionObserver(entries => {
          if (entries.some(e => e.isIntersecting)) { observer.disconnect(); start(); }
        }, { rootMargin: '300px' });
        observer.observe(img);
        watch.current = observer;
      }
    } else start();
    return () => { clear(); observer?.disconnect(); if (watch.current === observer) watch.current = null; };
  }, [src, source, loading, timeoutMs]);
  return h('img', { ...props, key: source, src: source, loading, ref: node, crossOrigin: openiFallbackUrl(src) ? 'anonymous' : props.crossOrigin,
    onLoad: event => {
      if (current.current !== source) return;
      clear(); watch.current?.disconnect(); loaded.current = source; failed.current = null; onLoad?.(event);
    }, onError: fail });
}
