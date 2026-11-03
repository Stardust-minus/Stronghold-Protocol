// Original layered Spine illustrations (an appearance's official 动态立绘, data/assets.json skins[id].dynamic). Two modes:
//   full (the default): the 「查看立绘」 preview — opened explicitly, contain fit, play / pause and clip controls.
//   cover: embedded where the appearance's art already shows (a 名片 plate: ui/namecards.js NameCardLayer; an operator's
//     art box in 干员调配 / 自选: screens/loadout.js, screens/diy.js) — no controls, fills its box like
//     `background-size: cover` at `focusY` (percent of the art's height, as background-position-y), drawn over the static
//     picture the parent keeps underneath; it never replaces that picture, so every failure simply leaves it.
// Resources (the owner's decision of 2026-11-02: several may animate at once, within a cap):
//   - each live illustration owns a small PIXI.Application, i.e. its own WebGL context (render/app/host.js keeps the
//     board's renderer to itself; nothing here can share it), torn down with releaseGl when it closes or leaves the screen;
//   - at most liveCap() embedded illustrations hold a renderer at a time (4, or 2 on a coarse pointer / ≤ 4 GB device);
//     the next one on screen waits and gets the slot a closing one frees; a full preview is always granted;
//   - an embedded one starts only on screen (IntersectionObserver) and only in a box at least `minWidth` px wide, and
//     unloads (renderer destroyed, Spine data released) when it scrolls off;
//   - paused while the page is hidden; under prefers-reduced-motion an embedded one never starts (the static picture)
//     and the preview opens paused;
//   - static on a slow or data-saver device (slowDevice), on a load failure, after LOAD_TIMEOUT_MS, or — embedded — when
//     its first frames run slower than SLOW_FRAME_MS on average (the rest of the session stays static then).
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button } from './components.js';
// not ./gameComponents.js (Img): it imports ./playerCard.js, which imports ./namecards.js, which imports this module —
// a cycle that left NAMECARD_PREF uninitialised when namecards.js was loaded first
import { MaterialImage } from './materialImage.js';
import { ensurePixi } from '../render/app/pixi.js';
import { t } from '../../../shared/i18n.js';

/** How long a dynamic illustration may take to load before its static picture stays. */
export const LOAD_TIMEOUT_MS = 20000;
/** Mean frame time (ms) over the first FRAME_PROBE frames above which an embedded one gives up for the session. */
export const SLOW_FRAME_MS = 70;
const FRAME_PROBE = 90;

const env = () => globalThis;
const mq = (q) => !!env().matchMedia?.(q).matches;
/** The number of embedded illustrations that may hold a renderer at once. @param {any} [g] */
export function liveCap(g = env()) {
  const coarse = !!g.matchMedia?.('(pointer: coarse)').matches;
  const mem = g.navigator?.deviceMemory;
  return coarse || (Number.isFinite(mem) && mem <= 4) ? 2 : 4;
}
/** A device the embedded illustrations stay static on: data saver, ≤ 2 cores or ≤ 2 GB. @param {any} [g] */
export function slowDevice(g = env()) {
  const n = g.navigator || {};
  return n.connection?.saveData === true || (Number.isFinite(n.hardwareConcurrency) && n.hardwareConcurrency <= 2)
    || (Number.isFinite(n.deviceMemory) && n.deviceMemory <= 2);
}
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

// ---- the live-renderer slots of the embedded illustrations ---------------------------------------------------------
const live = new Set();
const waiting = new Set();
let sessionSlow = false;
/** @param {{ grant: () => void }} token @returns {boolean} granted now */
function requestSlot(token) {
  if (live.has(token)) return true;
  if (live.size < liveCap()) { live.add(token); waiting.delete(token); return true; }
  waiting.add(token);
  return false;
}
/** @param {{ grant: () => void }} token */
function releaseSlot(token) {
  waiting.delete(token);
  if (!live.delete(token)) return;
  for (const w of [...waiting]) {
    if (live.size >= liveCap()) break;
    waiting.delete(w); live.add(w); w.grant();
  }
}
/** Test hooks: the slots in use and waiting; reset. */
export const dynamicSlots = Object.freeze({
  get live() { return live.size; }, get waiting() { return waiting.size; }, get slow() { return sessionSlow; },
  request: requestSlot, release: releaseSlot,
  reset() { live.clear(); waiting.clear(); sessionSlow = false; },
});

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('Dynamic illustration load timed out')), ms));

/**
 * @param {{ entry: any, staticSrc?: string, mode?: 'full'|'cover', focusY?: number, minWidth?: number, label?: string }} props
 *   `entry`: the skin's `dynamic` record; `staticSrc`: the full-mode fallback picture (cover mode draws over its parent's)
 */
export function DynamicIllustration({ entry, staticSrc, mode = 'full', focusY = 50, minWidth = 120 }) {
  const cover = mode === 'cover';
  const box = useRef(null), host = useRef(null), appRef = useRef(null);
  const reduced = mq('(prefers-reduced-motion: reduce)');
  const [playing, setPlaying] = useState(!reduced);
  const playingRef = useRef(playing); playingRef.current = playing;
  const [state, setState] = useState(cover ? 'idle' : 'loading');
  const [clip, setClip] = useState(entry?.anims?.idle || 'Idle');
  const [onScreen, setOnScreen] = useState(!cover);
  const [granted, setGranted] = useState(!cover);
  const actorRef = useRef(null);
  const focusRef = useRef(focusY); focusRef.current = focusY;
  const relayout = useRef(null);
  const clips = Object.keys(entry?.animations || {});
  const allowed = !cover || (!reduced && !slowDevice() && !sessionSlow);

  // embedded: on screen (and wide enough) asks for a slot; off screen gives it back
  useEffect(() => {
    if (!cover || !allowed || !box.current) return undefined;
    const el = box.current;
    const Observer = env().IntersectionObserver;
    if (!Observer) { setOnScreen(true); return undefined; }
    const io = new Observer((list) => {
      const e = list[list.length - 1];
      setOnScreen(!!e?.isIntersecting && el.clientWidth >= minWidth);
    }, { threshold: 0.1 });
    io.observe(el);
    return () => io.disconnect();
  }, [cover, allowed, minWidth]);
  useEffect(() => {
    if (!cover) return undefined;
    if (!(allowed && onScreen && entry)) { setGranted(false); return undefined; }
    const token = { grant: () => setGranted(true) };
    setGranted(requestSlot(token));
    return () => { releaseSlot(token); setGranted(false); };
  }, [cover, allowed, onScreen, entry]);

  const active = !!entry && (!cover || (allowed && onScreen && granted));
  useEffect(() => {
    if (!active) { if (cover) setState('idle'); return undefined; }
    // the asset store (../assets.js, also behind render/app/host.js) loads with the first opened illustration, not with
    // the lobby (a vanilla page loads it only when needed — test/ui/plugins-client.test.js)
    let disposed = false, acquired = false, assets = null, releaseGl = null, app = null, actor = null, watcher = null;
    let frames = 0, frameMs = 0;
    const stop = () => { if (app) app.stop(); };
    const visibility = () => { if (env().document?.hidden) stop(); else if (cover || playingRef.current) app?.start(); };
    setState('loading');
    const initialise = async () => {
      try {
        if (!host.current || !entry) throw new Error('No dynamic artwork');
        const P = await ensurePixi();
        if (disposed) return;
        app = new P.Application({ width: 1, height: 1, backgroundAlpha: 0, antialias: true, autoStart: false, resolution: Math.min(env().devicePixelRatio || 1, 1.5), autoDensity: true });
        appRef.current = app;
        host.current.appendChild(app.view);
        [{ assets }, { releaseGl }] = await Promise.all([import('../assets.js'), import('../render/app/host.js')]);
        if (disposed) return;
        acquired = true;
        const data = await Promise.race([assets.spine.acquire(entry), timeout(LOAD_TIMEOUT_MS)]);
        if (disposed) return;
        actor = new P.spine.Spine(data); actor.autoUpdate = false; actorRef.current = actor;
        // the record's bounds (the skeleton header's, or the setup pose's the import computed); without them the
        // actor's own setup-pose bounds, turned from Pixi's y-down into the skeleton's y-up like the records
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
          app.renderer.resize(width, height);
          const l = illustrationLayout(width, height, b, cover ? 'cover' : 'contain', focusRef.current);
          container.scale.set(l.scale);
          container.position.set(l.x, l.y);
          app.render();
        };
        relayout.current = resize;
        resize();
        watcher = new ResizeObserver(resize); watcher.observe(host.current);
        app.ticker.maxFPS = mq('(pointer: coarse)') ? 24 : 30;
        app.ticker.add(() => {
          const dt = app.ticker.deltaMS;
          actor.update(Math.min(0.05, dt / 1000));
          if (cover && frames < FRAME_PROBE) {
            frames++; frameMs += dt;
            if (frames === FRAME_PROBE && frameMs / frames > SLOW_FRAME_MS) { sessionSlow = true; stop(); setState('fallback'); }
          }
        });
        env().document?.addEventListener('visibilitychange', visibility);
        if ((cover || playingRef.current) && !env().document?.hidden) app.start(); else app.render();
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
      if (acquired) assets?.spine.release(entry);
    };
  }, [entry, active]);
  useEffect(() => { relayout.current?.(); }, [focusY]);
  useEffect(() => {
    const app = appRef.current;
    if (!app || cover) return;
    if (state === 'ready' && playing && !env().document?.hidden) app.start(); else app.stop();
  }, [playing, state]);
  useEffect(() => {
    const actor = actorRef.current;
    if (!actor || cover || !clips.includes(clip)) return;
    actor.state.setAnimation(0, clip, true); actor.update(0); appRef.current?.render();
  }, [clip, state]);

  if (cover) {
    return html`<span class="dyn-cover" ref=${box} data-testid="dynamic-cover" data-state=${state} aria-hidden="true">
      <span class="dyn-cover__canvas" ref=${host} hidden=${state !== 'ready'}></span>
    </span>`;
  }
  return html`<div class="lo-dynamic" data-testid="dynamic-illustration" data-state=${state}>
    <div class="lo-dynamic__stage">
      ${state !== 'ready' && staticSrc ? html`<${MaterialImage} src=${staticSrc} class="lo-dynamic__fallback" alt="" draggable=${false} />` : null}
      <div class="lo-dynamic__canvas" ref=${host} hidden=${state === 'fallback'}></div>
    </div>
    <div class="lo-dynamic__controls">
      <span role="status">${state === 'loading' ? t('正在载入动态立绘…') : state === 'fallback' ? t('动态立绘暂不可用，已显示静态立绘') : playing ? t('动态立绘播放中') : t('动态立绘已暂停')}</span>
      ${state === 'ready' ? html`<${Button} variant="secondary" size="sm" data-testid="dynamic-pause" onClick=${() => setPlaying(!playing)}>${playing ? t('暂停') : t('播放')}<//>` : null}
      ${state === 'ready' && clips.length > 1 ? html`<label>${t('动作')} <select id="operator-illustration-animation" value=${clip} onChange=${e => setClip(e.currentTarget.value)}>
        ${clips.map(name => html`<option key=${name} value=${name}>${name}</option>`)}
      </select></label>` : null}
    </div>
  </div>`;
}
