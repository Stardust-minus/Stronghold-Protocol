// public/js/ui/dynamicFraming.js — where a 动态立绘 sits in a box (pure; ui/dynamicStage.js draws it, the owner's decisions
// of 2026-11-03). Skeleton space is y-up (data/assets.json `bounds` / `frames`: { x, y, width, height }, y the bottom);
// pixi-spine draws y-down, so a skeleton point (X, Y) lands at (x + X·scale, y − Y·scale) for the transform returned here.
//   - rectLayout: a skeleton rect into a box like CSS `object-fit: cover; object-position: posX% posY%` — the official
//     avatar / portrait crops (skins[id].dynamic.frames, matched offline against the official pictures), so the live
//     picture frames exactly like the static one under it;
//   - the 名片: the whole bounds, cover × its stored zoom, its stored x / y as the position (ui/namecards.js, #129: the
//     static plate's CSS rule — the bounds' x% y% point on the box's x% y% point);
//   - a room seat: the player's own framing (room.card artX / artY / artZoom, seatRect), else the portrait crop.

import { appearanceEntry } from './skinAssets.js';
import { skinIdFor } from '../../../shared/skins.js';
import { isCollabUrl } from '../../../shared/collabAssets.js';

/** room.card art framing limits: centre in per-mille of the bounds (x from the left, y from the top), zoom in percent of the
 * bounds' height shown (100 = the whole height; 2500 = a 25th of it). A portrait crop in a seat box is 80–810 % (median
 * 390): the range holds every one with ~3× to zoom in further (past an atlas's own density that only magnifies). */
export const ART_LIMITS = Object.freeze({ min: 0, max: 1000, zoomMin: 100, zoomMax: 2500 });

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
export function moveArt(bw, bh, b, art, dx, dy, factor = 1) {
  const L = ART_LIMITS;
  const zoom = clamp(art.zoom * factor, L.zoomMin, L.zoomMax);
  const r = seatRect(bw, bh, b, { ...art, zoom });
  const perPx = r.height / bh; // skeleton units per box pixel
  const moved = { x: r.x - dx * perPx, y: r.y + dy * perPx, width: r.width, height: r.height };
  const out = artOfRect(bw, bh, b, moved);
  return { ...out, zoom: Math.round(zoom) };
}

/**
 * The transform for one embedded view: `framing` { rect, posX?, posY? } (a crop), { focusX?, focusY, zoom? } (the whole
 * bounds, the 名片), or { art } (a seat; null art = { rect, posX, posY } fallback given as `rect`).
 * @param {number} bw @param {number} bh @param {{ x: number, y: number, width: number, height: number }} bounds
 * @param {any} framing
 */
export function framingLayout(bw, bh, bounds, framing) {
  if (framing?.art) return rectLayout(bw, bh, seatRect(bw, bh, bounds, framing.art));
  if (framing?.rect) return rectLayout(bw, bh, framing.rect, framing.posX ?? 50, framing.posY ?? 50);
  return rectLayout(bw, bh, bounds, framing?.focusX ?? 50, framing?.focusY ?? 50, framing?.zoom ?? 1);
}


/** A skin's dynamic record when it may play here: a real one, never a collab skin's. @param {any} rec skins[id] */
const playable = (rec) => {
  const d = rec?.dynamic;
  return d && typeof d.skel === 'string' && !isCollabUrl(d.skel) && !isCollabUrl(rec.illustration) && !isCollabUrl(rec.avatar) ? d : null;
};
/** The dynamic record of the skin `charId` wears in a skins choice map (ui/skins.js), or null. */
export function dynamicOf(m, charId, skins) { return playable(appearanceEntry(m, charId, skinIdFor(skins, charId))); }
/** The dynamic record of a card look (room.card look / avatarLook: a skin id of `charId`), or null. */
export function lookDynamic(m, charId, look) {
  if (!look || look === 'e1' || !charId) return null;
  return playable(appearanceEntry(m, charId, look));
}
/** A crop framing ({ rect, posX, posY }) of a record's official `kind` ('avatar' | 'portrait'), or null without one. */
export function cropFraming(dyn, kind, posX = 50, posY = 50) {
  const rect = dyn?.frames?.[kind];
  return rect && rect.width > 0 && rect.height > 0 ? { rect, posX, posY } : null;
}
