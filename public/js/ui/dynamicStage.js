// public/js/ui/dynamicStage.js — ONE WebGL context for every embedded 动态立绘 (the owner's decisions of 2026-11-03: live
// Spine wherever a skin with a dynamic illustration shows, no limit on how many, no frame-rate or resolution cap).
// Browsers keep only ~16 WebGL contexts per page and drop the oldest, so one Pixi.Application per box (rel26) cannot scale
// to a 干员调配 page of 40 cells. Here every box owns a plain 2D <canvas> (its own pixels, sized CSS × devicePixelRatio) and
// a skeleton; one offscreen Pixi renderer draws them:
//   each requestAnimationFrame (the display's own rate: 60/120/144 Hz) — every visible, ready view advances its Spine state
//   by the real elapsed time; the views to draw are shelf-packed into pages of at most PAGE px (the GPU's renderbuffer /
//   viewport limit if lower), each clipped to its cell by an axis-aligned mask (Pixi's scissor), one render per page, and
//   each cell copied to its box with drawImage straight after (no preserveDrawingBuffer needed within the task).
// Off-screen boxes (IntersectionObserver, ui/dynamicIllustration.js) are not views at all: nothing loads or draws for them.
// Always animated (the owner's decision of 2026-11-03: prefers-reduced-motion is not honoured here). A lost context pauses
// the drawing — the 2D canvases keep their last frame — and Pixi re-uploads on restore.
import { ensurePixi } from '../render/app/pixi.js';
import { framingLayout } from './dynamicFraming.js';

/** The largest side of the shared canvas (a GPU's own limit is applied when lower). */
export const PAGE = 4096;
/** A frame further from the last than this (a hidden tab, a stall) advances the animations by this much only. */
export const MAX_STEP = 0.25;

const views = new Set();
let P = null, renderer = null, stage = null, raf = 0, last = 0, lost = false, booting = null, limit = PAGE, contexts = 0;
const env = () => globalThis;

async function boot() {
  if (renderer) return renderer;
  if (!booting) booting = (async () => {
    P = await ensurePixi();
    renderer = new P.Renderer({ width: 256, height: 256, backgroundAlpha: 0, antialias: true, premultipliedAlpha: true, resolution: 1, autoDensity: false });
    contexts++;
    const gl = renderer.gl;
    try {
      const dims = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
      limit = Math.max(512, Math.min(PAGE, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || PAGE, gl.getParameter(gl.MAX_TEXTURE_SIZE) || PAGE, dims?.[0] || PAGE, dims?.[1] || PAGE));
    } catch { limit = PAGE; }
    const view = renderer.view;
    view.addEventListener?.('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
    view.addEventListener?.('webglcontextrestored', () => { lost = false; for (const v of views) v.dirty = true; schedule(); });
    stage = new P.Container();
    return renderer;
  })();
  return booting;
}

/**
 * Shelf-pack sizes into pages: [{ w, h, cells: [{ index, x, y }] }], rows left to right, tallest first, a page at most
 * `side` px each way (a box larger than a page gets a page of its own, clipped to it).
 * @param {{ w: number, h: number }[]} sizes @param {number} side
 */
export function packPages(sizes, side) {
  const order = sizes.map((s, index) => ({ ...s, index })).sort((a, b) => b.h - a.h || b.w - a.w);
  const pages = [];
  let page = null, x = 0, y = 0, rowH = 0;
  for (const s of order) {
    const w = Math.min(s.w, side), h = Math.min(s.h, side);
    if (page && x + w > side) { x = 0; y += rowH; rowH = 0; }
    if (!page || y + h > side) { page = { w: 0, h: 0, cells: [] }; pages.push(page); x = 0; y = 0; rowH = 0; }
    page.cells.push({ index: s.index, x, y, w, h });
    page.w = Math.max(page.w, x + w); page.h = Math.max(page.h, y + h);
    x += w; rowH = Math.max(rowH, h);
  }
  return pages;
}

const jsonSkeletons = new Map();
/**
 * A dynamic illustration's skeleton data: through the asset store's Spine LRU (assets.spine), or — a skeleton exported as
 * JSON (3 of rel26's illustrations, the official dynamic avatars), which that store's validSpine (`.skel` only) refuses —
 * loaded here once per URL with the store's own loader (assets.js loadSpineData: the atlas named, the pages' alpha mode).
 * `release` gives an LRU entry back; a JSON one stays (a handful, small).
 * @param {any} entry { skel, atlas, textures, pma, anims }
 */
export async function acquireSpine(entry) {
  const mod = await import('../assets.js');
  if (!/\.json$/i.test(entry?.skel || '')) return { data: await mod.assets.spine.acquire(entry), release: () => mod.assets.spine.release(entry) };
  if (!jsonSkeletons.has(entry.skel)) {
    const p = mod.loadSpineData(entry);
    jsonSkeletons.set(entry.skel, p);
    p.catch(() => jsonSkeletons.delete(entry.skel));
  }
  return { data: await jsonSkeletons.get(entry.skel), release: () => {} };
}

/**
 * pixi-spine 4.0.6 gives a slot a clip graphic when its setup attachment is a ClippingAttachment, and later opens a clip for
 * every slot that has that graphic and ANY attachment — without checking it is still a clipping one. A clip opened by a
 * mesh has no end slot and its container never renders: every slot drawn after it vanishes (夕「青玉砚」: her Idle swaps
 * Xi_R_EyeWhite's setup clip Xi_R_EyeWhite2 for the mesh at t = 0, and everything after slot 224 — eyes, brows, nose —
 * was gone; the game's Spine runtime checks the type). Fix in the data, before a Spine object is built: a slot whose
 * setup attachment is a clipping one that the Idle replaces at t = 0 by a non-clipping one starts on that one (that clip
 * never shows in the Idle anyway). Idempotent; the skeleton data is shared, so once is enough.
 * @param {any} data spineData @param {string} [idle] the clip that plays
 * @returns {string[]} the slots changed
 */
export function fixStaleClips(data, idle) {
  const anim = data?.animations?.find((a) => a.name === idle) || data?.animations?.find((a) => /^idle$/i.test(a.name)) || data?.animations?.[0];
  const skin = data?.defaultSkin;
  if (!anim || !skin) return [];
  const isClip = (a) => !!a && (a.type === 6 || 'endSlot' in a);
  const changed = [];
  for (const tl of anim.timelines || []) {
    if (!Array.isArray(tl.attachmentNames) && !ArrayBuffer.isView(tl.attachmentNames)) continue;
    const slot = data.slots?.[tl.slotIndex];
    if (!slot || !(tl.frames?.[0] === 0)) continue;
    const at0 = tl.attachmentNames[0];
    if (!at0 || at0 === slot.attachmentName) continue;
    if (isClip(skin.getAttachment(tl.slotIndex, slot.attachmentName)) && !isClip(skin.getAttachment(tl.slotIndex, at0))) { slot.attachmentName = at0; changed.push(slot.name); }
  }
  return changed;
}

async function load(v) {
  v.loading = true;
  try {
    await boot();
    const [{ assets }] = await Promise.all([import('../assets.js')]);
    v.assets = assets;
    const got = await acquireSpine(v.entry);
    v.release = got.release;
    const data = got.data;
    v.acquired = true;
    if (v.gone) return;
    fixStaleClips(data, v.entry.anims?.idle);
    const actor = new P.spine.Spine(data); actor.autoUpdate = false;
    let b = v.entry.bounds;
    if (!b || !(b.width > 0 && b.height > 0)) {
      actor.update(0);
      const lb = actor.getLocalBounds();
      b = { x: lb.x, y: -(lb.y + lb.height), width: lb.width, height: lb.height };
      if (!(b.width > 0 && b.height > 0)) throw new Error('Dynamic illustration bounds missing');
    }
    const container = new P.Container(); container.addChild(actor);
    for (const [url, front] of [[v.entry.background, false], [v.entry.foreground, true]]) {
      if (!url) continue;
      const image = await assets.image(url);
      if (v.gone) return;
      if (!image) throw new Error('Dynamic illustration layer unavailable');
      const sprite = new P.Sprite(P.Texture.from(image));
      sprite.width = b.width; sprite.height = b.height; sprite.x = b.x; sprite.y = -b.y - b.height;
      if (front) container.addChild(sprite); else container.addChildAt(sprite, 0);
    }
    const clips = actor.spineData.animations.map((a) => a.name);
    const idle = v.entry.anims?.idle;
    actor.state.setAnimation(0, clips.includes(idle) ? idle : clips.find((n) => /^idle$/i.test(n)) || clips[0], true);
    actor.update(0);
    const mask = new P.Graphics();
    container.mask = mask;
    stage.addChild(container, mask);
    Object.assign(v, { actor, container, mask, bounds: b, dirty: true, cell: null });
    schedule();
  } catch (e) {
    if (!v.gone) v.onState?.('fallback', e);
  } finally { v.loading = false; }
}

function tick(now) {
  raf = 0;
  const dt = last ? Math.min(MAX_STEP, Math.max(0, (now - last) / 1000)) : 0;
  last = now;
  if (!renderer || lost) { if (views.size) schedule(); return; }
  const draw = [];
  for (const v of views) {
    if (!v.actor || !v.canvas || !(v.canvas.width > 0 && v.canvas.height > 0)) continue;
    if (v.playing !== false) { v.actor.update(dt); v.dirty = true; }
    if (v.dirty) draw.push(v);
  }
  if (draw.length) {
    for (const v of views) if (v.container) v.container.visible = false;
    for (const page of packPages(draw.map((v) => ({ w: v.canvas.width, h: v.canvas.height })), limit)) {
      if (renderer.width < page.w || renderer.height < page.h) renderer.resize(Math.max(renderer.width, page.w), Math.max(renderer.height, page.h));
      const shown = [];
      for (const c of page.cells) {
        const v = draw[c.index];
        const l = framingLayout(c.w, c.h, v.bounds, v.framing);
        v.container.scale.set(l.scale); v.container.position.set(c.x + l.x, c.y + l.y); v.container.visible = true;
        const key = `${c.x},${c.y},${c.w},${c.h}`;
        if (v.cell !== key) { v.mask.clear().beginFill(0xffffff).drawRect(c.x, c.y, c.w, c.h).endFill(); v.cell = key; }
        shown.push([v, c]);
      }
      renderer.render(stage, { clear: true });
      for (const [v, c] of shown) {
        const ctx = v.ctx || (v.ctx = v.canvas.getContext('2d'));
        ctx.clearRect(0, 0, v.canvas.width, v.canvas.height);
        ctx.drawImage(renderer.view, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
        v.container.visible = false; v.dirty = false;
        if (!v.drawn) { v.drawn = true; v.onState?.('ready'); }
      }
    }
  }
  if (views.size) schedule();
}

function schedule() {
  if (!raf && views.size) raf = (env().requestAnimationFrame || ((f) => setTimeout(() => f(performance.now()), 16)))(tick);
}

/**
 * Start drawing a view: { canvas (the box's 2D canvas, sized by the caller), entry (skins[id].dynamic), framing
 * (ui/dynamicFraming.js framingLayout), playing?, onState(state: 'ready'|'fallback') }. Returns the view; stopView ends it.
 */
export function startView(view) {
  const v = Object.assign(view, { gone: false, drawn: false, dirty: true });
  views.add(v);
  void load(v);
  schedule();
  return v;
}

/** The framing or the size of a view changed: draw it again on the next frame. */
export function touchView(v) { if (v) { v.dirty = true; schedule(); } }

/** Stop a view: its skeleton released, its container gone. */
export function stopView(v) {
  if (!v || v.gone) return;
  v.gone = true; views.delete(v);
  try {
    if (v.container) { stage?.removeChild(v.container); v.container.destroy({ children: true, texture: false, baseTexture: false }); }
    if (v.mask) { stage?.removeChild(v.mask); v.mask.destroy(); }
  } catch { /* a lost context: the objects are gone with it */ }
  if (v.acquired) v.release?.();
  v.container = v.actor = v.mask = null;
  if (!views.size) last = 0;
}

/** Test hooks: views alive, drawn, WebGL contexts this stage created (one, whatever the number of views). */
export const dynamicStage = Object.freeze({
  get views() { return views.size; },
  get drawn() { return [...views].filter((v) => v.drawn).length; },
  get contexts() { return contexts; },
  get page() { return limit; },
});
