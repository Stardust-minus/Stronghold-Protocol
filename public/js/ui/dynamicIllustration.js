// Original layered Spine illustrations (an appearance's official 动态立绘, data/assets.json skins[id].dynamic). Two modes:
//   full (the default): the 「查看立绘」 preview — opened explicitly, contain fit, play / pause and clip controls, its own
//     Pixi.Application (one at a time).
//   cover: embedded where an appearance's art already shows — 干员调配's cells (the list's avatar crop, the cards' portrait
//     crop), its detail head, 自选's art box, player avatars, the room's seat cards (the player's own framing) and the 名片
//     — drawn by ui/dynamicStage.js: ONE WebGL context for all of them, each box a 2D canvas of its CSS size ×
//     devicePixelRatio, every frame of the display (requestAnimationFrame), the Spine state advanced by real time.
// The owner's decisions of 2026-11-03: live everywhere, no cap on how many play, no frame-rate or resolution limit (sharper
// than the atlas's own texel density is only interpolation — the asset's limit); a box off screen draws nothing.
// Always animated: prefers-reduced-motion is not honoured (the owner's decision of 2026-11-03). A box's static picture (its parent's <img>,
// a 名片's background) is the same crop — the frames were matched against the official avatar / portrait — and is hidden
// once the first live frame is drawn ([data-dyn="live"] on the parent), so two framings never show at once; any failure
// leaves the static picture.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button } from './components.js';
// not ./gameComponents.js (Img): it imports ./playerCard.js, which imports ./namecards.js, which imports this module —
// a cycle that left NAMECARD_PREF uninitialised when namecards.js was loaded first
import { MaterialImage } from './materialImage.js';
import { ensurePixi } from '../render/app/pixi.js';
import { startView, stopView, touchView, acquireSpine, fixStaleClips } from './dynamicStage.js';
import { dynamicOf, lookDynamic, cropFraming } from './dynamicFraming.js';
import { t } from '../../../shared/i18n.js';

/** How long a dynamic illustration may take to load before its static picture stays. */
export const LOAD_TIMEOUT_MS = 20000;

const env = () => globalThis;
/**
 * Where the illustration's bounds go in a box: `contain` (the preview: whole, 94 %) or `cover` (fills the box, the
 * horizontal centre and the `focusY` percent line of the art on the same line of the box). Pixi container coordinates:
 * the bounds rect spans x b.x…b.x+w and y −(b.y+h)…−b.y (pixi-spine's y-down skeleton).
 * @param {number} width @param {number} height @param {{ x: number, y: number, width: number, height: number }} b
 * @param {'contain'|'cover'} fit @param {number} [focusY] 0–100
 */
export function illustrationLayout(width, height, b, fit, focusY = 50) {
  if (fit === 'cover') {
    const scale = Math.max(width / b.width, height / b.height);
    const f = Math.min(100, Math.max(0, focusY)) / 100;
    return { scale, x: width / 2 - (b.x + b.width / 2) * scale, y: f * height + (b.y + b.height - f * b.height) * scale };
  }
  const scale = Math.min(width / b.width, height / b.height) * 0.94;
  return { scale, x: width / 2 - (b.x + b.width / 2) * scale, y: height / 2 + (b.y + b.height / 2) * scale };
}

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('Dynamic illustration load timed out')), ms));

/**
 * @param {{ entry: any, staticSrc?: string, mode?: 'full'|'cover', focusY?: number, framing?: any, playing?: boolean }} props
 *   `entry`: the skin's `dynamic` record; `staticSrc`: the full-mode fallback picture; cover mode draws over its parent's
 *   static picture: `framing` (ui/dynamicFraming.js framingLayout: { rect, posX, posY } a crop, { art } a seat), else the
 *   whole bounds at `focusY` (the 名片)
 */
export function DynamicIllustration(props) {
  return props.mode === 'cover' ? html`<${CoverIllustration} ...${props} />` : html`<${FullIllustration} ...${props} />`;
}

/**
 * The live 动态立绘 over a box's static avatar / portrait — the official crop, framed as the <img> under it
 * (object-fit: cover at posX% posY%) — when the worn skin (a skins choice map, or a card `look`) has one; nothing otherwise.
 * @param {{ m: any, charId: string, skins?: any, look?: string, kind: 'avatar'|'portrait', posX?: number, posY?: number }} props
 */
export function LiveArt({ m, charId, skins = null, look = null, kind, posX = 50, posY = 50 }) {
  const dyn = look != null ? lookDynamic(m, charId, look) : dynamicOf(m, charId, skins);
  const framing = cropFraming(dyn, kind, posX, posY);
  return framing ? html`<${CoverIllustration} entry=${dyn} framing=${framing} />` : null;
}

/** An embedded illustration on the shared stage (ui/dynamicStage.js). */
export function CoverIllustration({ entry, focusY = 50, framing = null, playing = true }) {
  const box = useRef(null), canvas = useRef(null), view = useRef(null);
  const [state, setState] = useState('idle');
  const [onScreen, setOnScreen] = useState(false);
  const frame = framing || { focusY };
  const frameKey = JSON.stringify(frame);

  // on screen (any part of it) → a view; off screen → nothing loads or draws
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const Observer = env().IntersectionObserver;
    if (!Observer) { setOnScreen(true); return undefined; }
    const io = new Observer((list) => setOnScreen(!!list[list.length - 1]?.isIntersecting), { rootMargin: '64px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // the canvas follows the box: CSS size × devicePixelRatio (uncapped; a zoom / DPR change re-measures)
  useEffect(() => {
    const el = box.current, cv = canvas.current;
    if (!el || !cv) return undefined;
    let dprQuery = null;
    const measure = () => {
      const dpr = env().devicePixelRatio || 1;
      const w = Math.max(0, Math.round(el.clientWidth * dpr)), h = Math.max(0, Math.round(el.clientHeight * dpr));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; touchView(view.current); }
      dprQuery?.removeEventListener?.('change', measure);
      dprQuery = env().matchMedia?.(`(resolution: ${dpr}dppx)`) || null;
      dprQuery?.addEventListener?.('change', measure);
    };
    measure();
    const ro = env().ResizeObserver ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => { ro?.disconnect(); dprQuery?.removeEventListener?.('change', measure); };
  }, []);

  useEffect(() => {
    if (!entry || !onScreen || !canvas.current) return undefined;
    setState('loading');
    let timer = setTimeout(() => setState((s) => (s === 'loading' ? 'fallback' : s)), LOAD_TIMEOUT_MS);
    const v = startView({ canvas: canvas.current, entry, framing: frame, playing,
      onState: (next) => { clearTimeout(timer); timer = null; setState(next); } });
    view.current = v;
    return () => { clearTimeout(timer); stopView(v); view.current = null; setState('idle'); };
  }, [entry, onScreen]);
  useEffect(() => { const v = view.current; if (v) { v.framing = frame; v.playing = playing; touchView(v); } }, [frameKey, playing]);

  // the parent's static picture hides once the live one shows (one framing at a time)
  useEffect(() => {
    const parent = box.current?.parentElement;
    if (!parent) return undefined;
    if (state === 'ready') parent.dataset.dyn = 'live'; else delete parent.dataset.dyn;
    return () => { delete parent.dataset.dyn; };
  }, [state]);

  return html`<span class="dyn-cover" ref=${box} data-testid="dynamic-cover" data-state=${state} data-frame=${frameKey} aria-hidden="true">
    <canvas class="dyn-cover__canvas" ref=${canvas} hidden=${state !== 'ready'}></canvas>
  </span>`;
}

/** The 「查看立绘」 preview: contain fit, its own renderer, play / pause and clip controls. */
function FullIllustration({ entry, staticSrc }) {
  const host = useRef(null), appRef = useRef(null);
  const [playing, setPlaying] = useState(true);
  const playingRef = useRef(playing); playingRef.current = playing;
  const [state, setState] = useState('loading');
  const [clip, setClip] = useState(entry?.anims?.idle || 'Idle');
  const actorRef = useRef(null);
  const relayout = useRef(null);
  const clips = Object.keys(entry?.animations || {});

  useEffect(() => {
    if (!entry) return undefined;
    // the asset store (../assets.js, also behind render/app/host.js) loads with the first opened illustration, not with
    // the lobby (a vanilla page loads it only when needed — test/ui/plugins-client.test.js)
    let disposed = false, release = null, assets = null, releaseGl = null, app = null, actor = null, watcher = null;
    const stop = () => { if (app) app.stop(); };
    const visibility = () => { if (env().document?.hidden) stop(); else if (playingRef.current) app?.start(); };
    setState('loading');
    const initialise = async () => {
      try {
        if (!host.current) throw new Error('No dynamic artwork');
        const P = await ensurePixi();
        if (disposed) return;
        // the display's own resolution and rate: no DPR clamp, no fps cap (the owner's decision of 2026-11-03)
        app = new P.Application({ width: 1, height: 1, backgroundAlpha: 0, antialias: true, autoStart: false, resolution: env().devicePixelRatio || 1, autoDensity: true });
        appRef.current = app;
        host.current.appendChild(app.view);
        [{ assets }, { releaseGl }] = await Promise.all([import('../assets.js'), import('../render/app/host.js')]);
        if (disposed) return;
        const got = await Promise.race([acquireSpine(entry), timeout(LOAD_TIMEOUT_MS)]);
        release = got.release;
        const data = got.data;
        if (disposed) return;
        fixStaleClips(data, entry.anims?.idle);
        actor = new P.spine.Spine(data); actor.autoUpdate = false; actorRef.current = actor;
        let b = entry.bounds;
        if (!b || !(b.width > 0 && b.height > 0)) {
          actor.update(0);
          const lb = actor.getLocalBounds();
          b = { x: lb.x, y: -(lb.y + lb.height), width: lb.width, height: lb.height };
          if (!(b.width > 0 && b.height > 0)) throw new Error('Dynamic illustration bounds missing');
        }
        const container = new P.Container(); container.addChild(actor); app.stage.addChild(container);
        const layer = async (url, foreground) => {
          if (!url) return;
          const image = await assets.image(url);
          if (disposed) return;
          if (!image) throw new Error('Dynamic illustration layer unavailable');
          const sprite = new P.Sprite(P.Texture.from(image));
          sprite.width = b.width; sprite.height = b.height; sprite.x = b.x; sprite.y = -b.y - b.height;
          if (foreground) container.addChild(sprite); else container.addChildAt(sprite, 0);
        };
        await layer(entry.background, false); await layer(entry.foreground, true);
        if (disposed) return;
        actor.state.setAnimation(0, entry.anims?.idle || clips[0], true);
        actor.update(0);
        const resize = () => {
          if (disposed || !host.current) return;
          const width = Math.max(1, host.current.clientWidth), height = Math.max(1, host.current.clientHeight);
          app.renderer.resolution = env().devicePixelRatio || 1;
          app.renderer.resize(width, height);
          const l = illustrationLayout(width, height, b, 'contain');
          container.scale.set(l.scale);
          container.position.set(l.x, l.y);
          app.render();
        };
        relayout.current = resize;
        resize();
        watcher = new ResizeObserver(resize); watcher.observe(host.current);
        app.ticker.add(() => actor.update(Math.min(0.25, app.ticker.deltaMS / 1000)));
        env().document?.addEventListener('visibilitychange', visibility);
        if (playingRef.current && !env().document?.hidden) app.start(); else app.render();
        setState('ready');
      } catch {
        stop();
        if (!disposed) setState('fallback');
      }
    };
    void initialise();
    return () => {
      disposed = true; watcher?.disconnect(); env().document?.removeEventListener('visibilitychange', visibility);
      appRef.current = null; actorRef.current = null; relayout.current = null;
      try { if (app?.renderer) releaseGl?.(app.renderer); app?.destroy(true, { children: true, texture: false, baseTexture: false }); } catch { /* a lost context is already gone */ }
      release?.();
    };
  }, [entry]);
  useEffect(() => {
    const app = appRef.current;
    if (!app) return;
    if (state === 'ready' && playing && !env().document?.hidden) app.start(); else app.stop();
  }, [playing, state]);
  useEffect(() => {
    const actor = actorRef.current;
    if (!actor || !clips.includes(clip)) return;
    actor.state.setAnimation(0, clip, true); actor.update(0); appRef.current?.render();
  }, [clip, state]);

  return html`<div class="lo-dynamic" data-testid="dynamic-illustration" data-state=${state}>
    <div class="lo-dynamic__stage">
      ${state !== 'ready' && staticSrc ? html`<${MaterialImage} src=${staticSrc} class="lo-dynamic__fallback" alt="" draggable=${false} />` : null}
      <div class="lo-dynamic__canvas" ref=${host} hidden=${state === 'fallback'}></div>
    </div>
    <div class="lo-dynamic__controls">
      <span role="status">${state === 'loading' ? t('正在载入动态立绘…') : state === 'fallback' ? t('动态立绘暂不可用，已显示静态立绘') : playing ? t('动态立绘播放中') : t('动态立绘已暂停')}
      ${state === 'ready' ? html`<${Button} variant="secondary" size="sm" data-testid="dynamic-pause" onClick=${() => setPlaying(!playing)}>${playing ? t('暂停') : t('播放')}<//>` : null}
      ${state === 'ready' && clips.length > 1 ? html`<label>${t('动作')} <select id="operator-illustration-animation" value=${clip} onChange=${e => setClip(e.currentTarget.value)}>
        ${clips.map(name => html`<option key=${name} value=${name}>${name}</option>`)}
      </select></label>` : null}
    </div>
  </div>`;
}
