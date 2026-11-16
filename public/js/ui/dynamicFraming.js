// public/js/ui/dynamicFraming.js — where a 动态立绘 sits in a box (pure; ui/dynamicStage.js draws it, the owner's decisions
// of 2026-11-03). Skeleton space is y-up (data/assets.json `bounds` / `frames`: { x, y, width, height }, y the bottom);
// pixi-spine draws y-down, so a skeleton point (X, Y) lands at (x + X·scale, y − Y·scale) for the transform returned here.
//   - rectLayout: a skeleton rect into a box like CSS `object-fit: cover; object-position: posX% posY%` — the official
//     avatar / portrait crops (skins[id].dynamic.frames, matched offline against the official pictures), so the live
//     picture frames exactly like the static one under it;
//   - the 名片: the official camera frame (dynamicFrame; the bounds for a record without one), cover × its stored zoom,
//     its stored x / y as the position (ui/namecards.js, #129: the static plate's CSS rule — the frame's x% y% point on
//     the box's x% y% point). The plate's static picture is the skin's 立绘, which shows about that same square (2026-11-16:
//     the backdrop fills the plate, and the switch from the static picture to the live one no longer jumps);
//   - a room seat: the player's own framing (room.card artX / artY / artZoom, seatRect), else the portrait crop. rel30 (the
//     owner, 2026-11-04): every look has one — a static portrait (精二, 精一, a skin without a 动态立绘) is framed in its own
//     picture (pictureBounds); a skin with one in its skeleton bounds, and its static portrait (the official crop's rect
//     there) is placed by the same transform (pictureBox), so the two frame alike and a 动态立绘 that fails shows the same.
//     A 精二 动态立绘 (e2Dynamic, 2026-11-16) is framed in its 立绘's space mapped into the skeleton (the official crop ↔
//     portraitBoxE2), so a frame saved on the static 精二 shows the same part of it live.

import { appearanceEntry } from './skinAssets.js';
import { skinIdFor } from '../../../shared/skins.js';
import { isCollabUrl } from '../../../shared/collabAssets.js';

/** room.card art framing limits: centre in per-mille of the bounds (x from the left, y from the top), zoom in percent of the
 * bounds' height shown (100 = the whole height; 2500 = a 25th of it). A portrait crop in a seat box is 80–810 % (median
 * 390): the range holds every one with ~3× to zoom in further (past an atlas's own density that only magnifies). */
export const ART_LIMITS = Object.freeze({ min: 0, max: 1000, zoomMin: 100, zoomMax: 2500 });
/** The framer's zoom ceiling for a static portrait (rel30, [ASSUMED]): 8× its height (a 180 × 360 picture only blurs past it). */
export const STATIC_ZOOM_MAX = 800;

/**
 * The container transform that fits `rect` into a bw × bh box as `object-fit: cover; object-position: posX% posY%`, the
 * cover size × `zoom` (≥ 1; the same posX% posY% point stays on the box's).
 * @param {number} bw @param {number} bh @param {{ x: number, y: number, width: number, height: number }} rect y-up
 * @param {number} [posX] 0–100 @param {number} [posY] 0–100 @param {number} [zoom]
 * @returns {{ scale: number, x: number, y: number }}
 */
export function rectLayout(bw, bh, rect, posX = 50, posY = 50, zoom = 1) {
  const scale = Math.max(bw / rect.width, bh / rect.height) * (zoom > 1 ? zoom : 1);
  const ox = (bw - rect.width * scale) * (posX / 100), oy = (bh - rect.height * scale) * (posY / 100);
  return { scale, x: ox - rect.x * scale, y: oy + (rect.y + rect.height) * scale };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isInt = (v) => Number.isInteger(v);

/** A stored art framing, or null when the card has none (any field missing / out of range). @param {any} card */
export function cardArt(card) {
  const x = card?.artX, y = card?.artY, z = card?.artZoom;
  if (![x, y, z].every(isInt)) return null;
  const L = ART_LIMITS;
  if (x < L.min || x > L.max || y < L.min || y > L.max || z < L.zoomMin || z > L.zoomMax) return null;
  return { x, y, zoom: z };
}

/**
 * The skeleton rect a seat box of bw × bh shows for a framing: `zoom` sets the height shown (bounds.height · 100 / zoom),
 * the box's aspect its width; then the rect is moved inside the bounds (the box always filled — a zoom too low for a wide
 * box is raised until the width fits) with its centre as near (x‰, y‰ from the top) as that allows.
 * @param {number} bw @param {number} bh @param {{ x: number, y: number, width: number, height: number }} b
 * @param {{ x: number, y: number, zoom: number }} art
 */
export function seatRect(bw, bh, b, art) {
  const aspect = bw / bh;
  let h = b.height * 100 / art.zoom, w = h * aspect;
  if (w > b.width) { w = b.width; h = w / aspect; }
  if (h > b.height) { h = b.height; w = h * aspect; }
  const cx = clamp(b.x + b.width * art.x / 1000, b.x + w / 2, b.x + b.width - w / 2);
  const cyTop = clamp(b.y + b.height - b.height * art.y / 1000, b.y + h / 2, b.y + b.height - h / 2);
  return { x: cx - w / 2, y: cyTop - h / 2, width: w, height: h };
}

/**
 * The framing that shows `rect` in a box of aspect bw / bh around its centre (the inverse of seatRect, for the start of an
 * adjustment from what the box shows now), clamped to ART_LIMITS.
 * @param {number} bw @param {number} bh @param {{ x: number, y: number, width: number, height: number }} b
 * @param {{ x: number, y: number, width: number, height: number }} rect
 */
export function artOfRect(bw, bh, b, rect) {
  const h = Math.max(rect.height, rect.width * bh / bw);
  const L = ART_LIMITS;
  return {
    x: Math.round(clamp((rect.x + rect.width / 2 - b.x) / b.width * 1000, L.min, L.max)),
    y: Math.round(clamp((b.y + b.height - (rect.y + rect.height / 2)) / b.height * 1000, L.min, L.max)),
    zoom: Math.round(clamp(b.height / h * 100, L.zoomMin, L.zoomMax)),
  };
}

/**
 * The framing after a drag of (dx, dy) box pixels and a zoom by `factor` about the box centre, from `art`, clamped.
 * @param {number} bw @param {number} bh @param {{ x: number, y: number, width: number, height: number }} b
 * @param {{ x: number, y: number, zoom: number }} art @param {number} dx @param {number} dy @param {number} [factor]
 */
export function moveArt(bw, bh, b, art, dx, dy, factor = 1, zoomMax = ART_LIMITS.zoomMax) {
  const L = ART_LIMITS;
  const zoom = clamp(art.zoom * factor, L.zoomMin, Math.min(L.zoomMax, Math.max(L.zoomMin, zoomMax)));
  const r = seatRect(bw, bh, b, { ...art, zoom });
  const perPx = r.height / bh; // skeleton units per box pixel
  const moved = { x: r.x - dx * perPx, y: r.y + dy * perPx, width: r.width, height: r.height };
  const out = artOfRect(bw, bh, b, moved);
  return { ...out, zoom: Math.round(zoom) };
}

/**
 * The official camera frame of a 动态立绘 (2026-11-16), or null: the square its prefab's camera shows — side
 * 2 × DynIllust._cameraSize, centred on the root's offset reversed, in y-up skeleton space (skins[id].dynamic.frame,
 * chars[id].dynamicE2.frame; tools/assets/dynamic-backdrops.json). The `background` / `foreground` pictures are exactly
 * this square; the 「查看立绘」 preview shows it whole; nothing of the scene outside it is ever on screen in the game.
 * @param {any} entry a `dynamic` record
 * @returns {{ x: number, y: number, width: number, height: number }|null}
 */
export function dynamicFrame(entry) {
  const f = entry?.frame;
  return f && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(f[k])) && f.width > 0 && f.height > 0 ? f : null;
}

/**
 * The transform for one embedded view: `framing` { rect, posX?, posY? } (a crop), { focusX?, focusY, zoom? } (the whole
 * frame — the official camera square, `frame`, else the bounds —, the 名片), or { art, space? } (a seat; null art =
 * { rect, posX, posY } fallback given as `rect`; `space`: the rect the art is relative to when it is not the bounds — a
 * 精二 动态立绘 framed in its 立绘's space, ui/seatLive.js).
 * @param {number} bw @param {number} bh @param {{ x: number, y: number, width: number, height: number }} bounds
 * @param {any} framing @param {{ x: number, y: number, width: number, height: number }|null} [frame] dynamicFrame()
 */
export function framingLayout(bw, bh, bounds, framing, frame = null) {
  if (framing?.art) return rectLayout(bw, bh, seatRect(bw, bh, framing.space || bounds, framing.art));
  if (framing?.rect) return rectLayout(bw, bh, framing.rect, framing.posX ?? 50, framing.posY ?? 50);
  return rectLayout(bw, bh, frame || bounds, framing?.focusX ?? 50, framing?.focusY ?? 50, framing?.zoom ?? 1);
}

/**
 * The part of a bw × bh box a backdrop view may draw in: the box ∩ the official frame under the transform `l` (the game
 * never shows the scene outside its camera square), as box pixels { x, y, w, h } (w or h 0: nothing shows).
 * @param {number} bw @param {number} bh @param {{ scale: number, x: number, y: number }} l
 * @param {{ x: number, y: number, width: number, height: number }} frame
 */
export function frameClip(bw, bh, l, frame) {
  const f = pictureBox(l, frame);
  const x0 = Math.max(0, f.left), y0 = Math.max(0, f.top), x1 = Math.min(bw, f.left + f.width), y1 = Math.min(bh, f.top + f.height);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}


/** A static picture of natural w × h as a framing space: its own rect, y-up from its bottom-left (pixels). */
export const pictureBounds = (w, h) => ({ x: 0, y: 0, width: w, height: h });

/**
 * Where a static picture lands in a box under a container transform (rectLayout / framingLayout): `pic` its rect in the
 * same y-up space. CSS pixels of the box: { left, top, width, height }.
 * @param {{ scale: number, x: number, y: number }} l @param {{ x: number, y: number, width: number, height: number }} pic
 */
export function pictureBox(l, pic) {
  return { left: l.x + pic.x * l.scale, top: l.y - (pic.y + pic.height) * l.scale, width: pic.width * l.scale, height: pic.height * l.scale };
}

/** A skin's dynamic record when it may play here: a real one, never a collab skin's. @param {any} rec skins[id] */
const playable = (rec) => {
  const d = rec?.dynamic;
  return d && typeof d.skel === 'string' && !isCollabUrl(d.skel) && !isCollabUrl(rec.illustration) && !isCollabUrl(rec.avatar) ? d : null;
};
/**
 * The 精二 动态立绘 of an operator (2026-11-16, the owner: 「有一部分干员精英II立绘也是动态的」 — the official default
 * 精二 look, skin_table charSkins[<charId>#2].dynIllustId; data/assets.json chars[id].dynamicE2, the same record as a skin's
 * `dynamic`), or null: only where the operator's own 精二 pictures are shown (avatarE2 / portraitE2), never a collab one.
 * @param {any} m @param {string} charId
 */
export function e2Dynamic(m, charId) {
  const c = typeof charId === 'string' && m?.chars && typeof m.chars === 'object' && Object.hasOwn(m.chars, charId) ? m.chars[charId] : null;
  const d = c?.dynamicE2;
  return d && typeof d.skel === 'string' && (c.avatarE2 || c.portraitE2) && ![d.skel, c.avatarE2, c.portraitE2, c.illustrationE2].some(isCollabUrl) ? d : null;
}
/**
 * The dynamic record of the skin `charId` wears in a skins choice map (ui/skins.js), or null. `elite`: the box shows the
 * operator's 精锐 (精二) pictures when no skin is worn (干员调配 / 自选's detail: `golden || chess`) — its 精二 动态立绘 then.
 */
export function dynamicOf(m, charId, skins, elite = false) {
  const skin = appearanceEntry(m, charId, skinIdFor(skins, charId));
  return skin ? playable(skin) : elite ? e2Dynamic(m, charId) : null;
}
/**
 * The dynamic record of a card look (room.card look / avatarLook), or null: a skin id of `charId` — its skin's; 'e1' —
 * none; '' (精二, the default) or a skin this client does not have (its static pictures fall back to 精二 too,
 * ui/seatArt.js lookUrl) — the 精二 one.
 */
export function lookDynamic(m, charId, look) {
  if (look === 'e1' || !charId) return null;
  const skin = look ? appearanceEntry(m, charId, look) : null;
  return skin ? playable(skin) : e2Dynamic(m, charId);
}
/** A crop framing ({ rect, posX, posY }) of a record's official `kind` ('avatar' | 'portrait'), or null without one. */
export function cropFraming(dyn, kind, posX = 50, posY = 50) {
  const rect = dyn?.frames?.[kind];
  return rect && rect.width > 0 && rect.height > 0 ? { rect, posX, posY } : null;
}
