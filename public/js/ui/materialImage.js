// Native img with one per-URL OpenI retry. Existing placeholder handlers run only after both sources fail.
import { h } from '../../vendor/preact.module.js';
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { MATERIAL_TIMEOUT_MS, openiFallbackUrl } from '../materialFallback.js';

export function MaterialImage({ src, onLoad, onError, loading, timeoutMs = MATERIAL_TIMEOUT_MS, ...props }) {
  const [retry, setRetry] = useState(null);
  const source = retry?.original === src ? retry.source : src;
  const node = useRef(null);
  const timer = useRef(null);
  const current = useRef(null);
  const failed = useRef(null);
  current.current = source;
  const clear = () => { clearTimeout(timer.current); timer.current = null; };
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
    if (!openiFallbackUrl(src) || !img || (img.complete && img.naturalWidth > 0)) return;
    const start = () => {
      if (current.current !== source || failed.current === source || timer.current != null) return;
      timer.current = setTimeout(() => fail({ type: 'error', target: img, currentTarget: img }), timeoutMs);
    };
    // Do not time out an offscreen lazy image that the browser has not even requested yet.
    if (loading === 'lazy') {
      if (typeof IntersectionObserver !== 'undefined') {
        observer = new IntersectionObserver(entries => {
          if (entries.some(e => e.isIntersecting)) { observer.disconnect(); start(); }
        }, { rootMargin: '300px' });
        observer.observe(img);
      }
    } else start();
    return () => { clear(); observer?.disconnect(); };
  }, [src, source, loading, timeoutMs]);
  return h('img', { ...props, key: source, src: source, loading, ref: node, crossOrigin: openiFallbackUrl(src) ? 'anonymous' : props.crossOrigin,
    onLoad: event => { if (current.current === source) { clear(); failed.current = null; onLoad?.(event); } }, onError: fail });
}
