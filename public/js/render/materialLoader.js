// Pixi's loader parsers fetch Spine skeletons, atlases and every page separately. Keep their canonical cache keys,
// parse/unload/refcount behavior, and retry only the resource that failed (never re-download an entire model).
import { MATERIAL_IMAGE_TIMEOUT_MS, isPublicMaterialUrl, loadMaterialImage, materialCredentials, readMaterialBody, withMaterialFallback } from '../materialFallback.js';

const parsers = new WeakSet();
const adapters = new WeakSet();
/** URL → the running attempt's progress(): a parser's own adapter.fetch reports headers and body bytes to it. */
const progressFor = new Map();

/** The response, its body counted as progress (a slow skeleton keeps loading while it moves). */
function counted(res, progress) {
  if (!progress || !res?.body?.pipeThrough || typeof TransformStream !== 'function') return res;
  progress();
  const body = res.body.pipeThrough(new TransformStream({ transform(chunk, out) { progress(); out.enqueue(chunk); } }));
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

export function installPixiMaterialFallback(PIXI, options) {
  const adapter = PIXI?.settings?.ADAPTER;
  if (adapter?.fetch && !adapters.has(adapter)) {
    const fetch = adapter.fetch;
    adapter.fetch = async function (url, init) {
      const res = await fetch.call(this, url, init);
      if (isPublicMaterialUrl(url, options?.origin) && (!res?.ok || /text\/html|application\/xhtml\+xml/i.test(res.headers?.get?.('content-type') || ''))) {
        try { void res?.body?.cancel?.().catch(() => {}); } catch { /* unusable response */ }
        throw Object.assign(new Error('material response unavailable'), { status: res?.status });
      }
      return typeof url === 'string' ? counted(res, progressFor.get(url)) : res;
    };
    adapters.add(adapter);
  }
  for (const parser of PIXI?.Assets?.loader?.parsers || []) {
    if (!parser.load || parsers.has(parser)) continue;
    const load = parser.load;
    parser.load = function (url, asset, loader) {
      // (premultiplied pages everywhere: createImageBitmap premultiplies by default, whatever the alphaMode says later)
      const premultiplied = PIXI?.ALPHA_MODES?.PMA != null && asset?.data?.alphaMode === PIXI.ALPHA_MODES.PMA;
      const isTexture = (premultiplied || isPublicMaterialUrl(url, options?.origin)) && parser.name === 'loadTextures' && PIXI.BaseTexture && PIXI.Texture;
      const bitmap = isTexture && typeof createImageBitmap === 'function' && parser.config.preferCreateImageBitmap;
      return withMaterialFallback(url, async (source, signal, progress) => {
        let value;
        if (isTexture) {
          // The stock worker's decode error can escape its promise, and its Image branch may resolve an already
          // complete but broken image. Keep decoding inside this attempt so both failures reach the one retry.
          const decode = premultiplied ? { premultiplyAlpha: 'none' } : undefined;
          const image = bitmap ? await createImageBitmap(await (await readMaterialBody(await adapter.fetch(source, { credentials: materialCredentials(source, options?.origin), signal }), progress)).blob(), decode)
            : await loadMaterialImage(source, { ...options, signal, fallback: false });
          const data = { ...asset?.data };
          data.resolution ??= PIXI.utils.getResolutionOfUrl(url);
          if (bitmap) data.resourceOptions = { ...data.resourceOptions, ownsImageBitmap: data.resourceOptions?.ownsImageBitmap ?? true };
          try {
            const base = new PIXI.BaseTexture(image, data);
            base.resource.internal = true;
            base.resource.src = url;
            value = new PIXI.Texture(base);
            const texture = value;
            const forget = () => {
              const record = loader?.promiseCache?.[url];
              if (!record) return;
              // A timed-out primary may finish after its replacement. Destroying that late texture must not
              // remove the successful replacement's canonical cache entry.
              void record.promise.then(loaded => {
                if (loaded !== texture || loader.promiseCache[url] !== record) return;
                delete loader.promiseCache[url];
                if (PIXI.Assets.cache?.get?.(url) === texture) PIXI.Assets.cache.remove(url);
              }).catch(() => {});
            };
            base.once?.('destroyed', forget);
            texture.once?.('destroyed', forget);
          } catch (err) { if (bitmap) image.close(); throw err; }
        } else {
          progressFor.set(source, progress);
          try { value = await load.call(this, source, asset, loader); }
          finally { if (progressFor.get(source) === progress) progressFor.delete(source); }
        }
        if (isPublicMaterialUrl(url, options?.origin)) {
          const text = typeof value === 'string' ? value : value instanceof ArrayBuffer
            ? new TextDecoder().decode(value.slice(0, 96)) : null;
          if ((value instanceof ArrayBuffer && !value.byteLength) || (text !== null && (!text.trim() || /^\s*<(?:!doctype|html|\?xml)/i.test(text)))) {
            throw new Error('material body unavailable');
          }
        }
        return value;
      }, { ...(isTexture && !bitmap ? { timeoutMs: MATERIAL_IMAGE_TIMEOUT_MS } : {}), ...options,
        discard: value => { if (value?.baseTexture) parser.unload?.(value, asset, loader); } });
    };
    parsers.add(parser);
  }
}
