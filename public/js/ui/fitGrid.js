// Fit to the box (the owner, 2026-11-05: 「优化进入阶段，选择策略阶段的UI大小，尽量不用滚动」): the strategy draft's wall of
// portraits and its order rows take the size that shows all of them in the space the screen gives them, instead of a fixed
// size and a scrollbar. Pure sizing math (unit-tested) plus a hook that applies it to an element on every resize, writing
// CSS custom properties on the element only (no re-render): css/screens/draft.css reads them, with the design sizes as
// the fallback (before the first measure, and where ResizeObserver is missing).
//   * fitTiles: `count` square tiles in a w×h box — the column count that gives the largest tile, at most `max`; below
//     `min` the tiles keep `min` and the box scrolls (a phone's portrait screen, a huge list). With `groups` (the tile
//     counts of sections, each starting a row: 规程's 泛用型 / 盟约型 strategies under their full-row headers) the rows add
//     up per section; the headers' own height the caller takes off `h` (fitTileBox `head`).
//   * fitRowHeight: `n` rows in a column whose other content (pool heads, gaps, paddings) keeps its height.
//   * fitNameScale: a doctor's name on its order row, whole (the owner, 2026-11-16: no ellipsis) — the client's best fit.
//   * fitBandNameScale: a strategy's name on its tile, the same best fit; past its floor it wraps between words.
// Used by screens/bandDraft.js (.draft-grid: --dcols / --dtile; .dband__name: --bk; .draft-order__rows: --drh;
// .dorder__name: --nk).

import { useEffect } from '../../vendor/hooks.module.js';

/**
 * The largest square tile for `count` tiles in a box of inner size w × h (px), with the gaps between them.
 * @param {number} count @param {number} w @param {number} h @param {number} gapX @param {number} gapY
 * @param {number} min @param {number} max px
 * @param {number[]|null} [groups] the tiles of each section (summing to `count`), each section starting a new row
 * @returns {{ cols: number, tile: number, fits: boolean }}
 */
export function fitTiles(count, w, h, gapX, gapY, min, max, groups = null) {
  const n = Math.floor(Number(count));
  if (!(n > 0) || !(w > 0) || !(h > 0)) return { cols: Math.max(1, Math.min(4, n || 4)), tile: max, fits: true };
  const parts = Array.isArray(groups) && groups.length && groups.every((g) => g > 0) ? groups : [n];
  const rowsOf = (cols) => parts.reduce((sum, g) => sum + Math.ceil(g / cols), 0);
  // the largest tile; among column counts that give it (the `max` cap: a box with room to spare), the wall whose shape is
  // closest to the box's
  const shape = (cols) => Math.abs(Math.log(cols / rowsOf(cols)) - Math.log(w / h));
  const sizes = [];
  for (let cols = 1; cols <= n; cols++) {
    const rows = rowsOf(cols);
    sizes.push({ cols, tile: Math.min((w - (cols - 1) * gapX) / cols, (h - (rows - 1) * gapY) / rows, max) });
  }
  const top = Math.max(...sizes.map((s) => s.tile));
  const best = sizes.filter((s) => s.tile >= top - 0.5).reduce((a, b) => (shape(b.cols) < shape(a.cols) ? b : a));
  if (best.tile >= min) return { cols: best.cols, tile: Math.floor(best.tile * 100) / 100, fits: true };
  // no size at or above `min` shows them all: `min` with as many columns as the width takes; the box scrolls
  const cols = Math.max(1, Math.min(n, Math.floor((w + gapX) / (min + gapX))));
  return { cols, tile: min, fits: false };
}

/**
 * The row height at which `n` rows fit a column of height `boxH`: `contentH` is the column's content measured with rows
 * of height `rowH` (everything that is not a row keeps its height), clamped to [min, max].
 * @param {number} n @param {number} boxH @param {number} contentH @param {number} rowH @param {number} min @param {number} max
 */
export function fitRowHeight(n, boxH, contentH, rowH, min, max) {
  if (!(n > 0) || !(boxH > 0) || !(rowH > 0)) return max;
  const fixed = Math.max(0, contentH - n * rowH);
  return Math.max(min, Math.min(max, Math.floor(((boxH - fixed) / n) * 100) / 100));
}

const px = (v) => parseFloat(v) || 0;
const rootPx = () => px(globalThis.getComputedStyle?.(document.documentElement).fontSize) || 16;

/**
 * A doctor's name: `k` of its size or `floorPx`, whichever is larger (never above its size: a phone at 文字大小 小 keeps
 * its size and wraps), is the readable floor of the one-line fit. A wrapped name whose row is too short for its column
 * may go `squeeze` of the way under that floor, never under `minPx` (a phone's own size at 小), when that brings the
 * whole column inside its card. [ASSUMED] the four values.
 */
export const NAME_FIT = Object.freeze({ k: 0.72, floorPx: 11, minPx: 8, squeeze: 0.85 });

/**
 * The scale of a doctor's name on its order row (pure). The client's player card (prefab_auto_chess_band_choose_player_card_item
 * text_name: BestFit from 18 down, one 30-unit line) shrinks the name until it fits; ours does so down to NAME_FIT's floor and
 * wraps past it, at the floor. px in. `room`: the width the row leaves the name beside the trophy and the AI tag; `need`: the
 * name's one-line width at `base` (the 服主 tag beside it included); `own`: the name's text alone (the tag keeps its size).
 * @param {{ room: number, need: number, own?: number, base: number }} m
 * @returns {{ scale: number, wrap: boolean }}
 */
export function fitNameScale({ room, need, own = need, base }) {
  // half a pixel of rounding is no overflow
  if (!(need > room + 0.5) || !(own > 0) || !(base > 0)) return { scale: 1, wrap: false };
  const floor = Math.max(NAME_FIT.k * base, Math.min(base, NAME_FIT.floorPx));
  // a pixel to spare: the widths are rounded, and a hair too wide would wrap the last letter
  const scale = (room - 1 - Math.max(0, need - own)) / own;
  if (scale * base >= floor) return { scale: Math.min(1, scale), wrap: false };
  return { scale: floor / base, wrap: true };
}

/**
 * Fit the name of an order row's text column (.dorder__text, as wide as its card leaves it; fitNameScale): measured on one
 * line at its size, it gets --nk and data-fit="one" (shrunk on its line) or "wrap" (at the floor, wrapping, the trophy
 * scaled with it) on .dorder__name. A wrapped name whose column outgrows its card (a phone's short row) steps down half a
 * pixel at a time, to NAME_FIT.squeeze of its floor (not under minPx), if that brings the column inside; else (大 / 特大 on
 * a phone, where the state line and the plan are large too) it keeps its floor and the column sits at the card's top
 * (data-over): the card cuts the lines under the name, never the name; only a name taller than the card by itself steps
 * down further, to NAME_FIT.minPx. Without a measure the CSS wraps it at its size (css/screens/draft.css).
 * @param {HTMLElement} el
 */
export function fitNameBox(el) {
  const row = el.querySelector('.dorder__name');
  const nm = row?.querySelector('.dorder__nm');
  if (!row || !nm) return;
  row.dataset.fit = 'measure';
  row.style.removeProperty('--nk');
  delete el.dataset.over;
  const cs = getComputedStyle(row);
  const base = px(cs.fontSize);
  const kids = [...row.children];
  const width = (k) => { const s = getComputedStyle(k); return k.getBoundingClientRect().width + px(s.marginLeft) + px(s.marginRight); };
  const others = kids.reduce((sum, k) => (k === nm ? sum : sum + width(k)), 0);
  const room = row.getBoundingClientRect().width - others - px(cs.columnGap) * Math.max(0, kids.length - 1);
  const need = nm.getBoundingClientRect().width;
  const own = (nm.querySelector('.sp-owner-name') || nm).getBoundingClientRect().width;
  const { scale, wrap } = fitNameScale({ room, need, own, base });
  if (scale < 1) row.style.setProperty('--nk', scale.toFixed(4));
  row.dataset.fit = wrap ? 'wrap' : 'one';
  const card = el.closest('.dorder__card');
  if (!wrap || !card) return;
  const roomH = card.clientHeight - 2;
  const min = Math.min(base, NAME_FIT.minPx);
  const set = (size) => row.style.setProperty('--nk', (size / base).toFixed(4));
  if (el.offsetHeight <= roomH) return;
  for (let size = scale * base - 0.5, low = Math.max(min, NAME_FIT.squeeze * scale * base); size >= low; size -= 0.5) {
    set(size);
    if (el.offsetHeight <= roomH) return;
  }
  set(scale * base);
  el.dataset.over = '1';
  for (let size = scale * base - 0.5; row.offsetHeight > roomH && size >= min; size -= 0.5) set(size);
}

/**
 * The scale of a strategy's name on its tile (pure; the owner, 2026-11-16: the whole name, never an ellipsis — and a Korean
 * name not broken inside a word, 「에르망가|르드」 on a phone): the best fit of a doctor's name (fitNameScale, NAME_FIT) —
 * on one line, shrunk to a readable floor (72 % of its size or 11 px, never above its size: a phone's 9 px keeps its
 * size); past the floor it wraps, at the floor, between words only (Korean keep-all, Japanese at its ・: css/screens/draft.css);
 * a word wider than the tile at the floor may go NAME_FIT.squeeze of the way under it (not under minPx), words still whole;
 * only one wider even there breaks inside ('break', at the floor). px in, at the name's own size `base`: `box`, the
 * name box's width (it spans the tile); `pad`, its side paddings (in em: they scale with it); `line`, the name on one line;
 * `word`, its widest piece that may not break (the min-content width under the language's rules).
 * @param {{ box: number, pad?: number, line: number, word?: number, base: number }} m
 * @returns {{ scale: number, mode: 'one'|'wrap'|'break' }}
 */
export function fitBandNameScale({ box, pad = 0, line, word = line, base }) {
  // half a pixel of rounding is no overflow (it runs into the padding)
  if (!(line > box - pad + 0.5) || !(box > 0) || !(base > 0)) return { scale: 1, mode: 'one' };
  const floor = Math.max(NAME_FIT.k * base, Math.min(base, NAME_FIT.floorPx)) / base;
  // the scale that puts the line and its paddings in the box with a pixel to spare (the widths are rounded)
  const one = (box - 1) / (line + pad);
  if (one >= floor) return { scale: Math.min(1, one), mode: 'one' };
  // a word may run a pixel into its padding rather than break (less than that is the widths' rounding)
  if (!(word * floor > box - pad * floor + 1)) return { scale: floor, mode: 'wrap' };
  // a word wider than the tile at the floor goes on under it, as a doctor's wrapped name does (fitNameBox): down to
  // NAME_FIT.squeeze of the floor, never under minPx (「클레멘티아」, 「Mulberry」 a pixel or three too wide); past that it
  // breaks, at the floor (「에르망가르드」 on a phone)
  const squeezed = (box + 1) / (word + pad);
  if (squeezed >= Math.max(NAME_FIT.squeeze * floor, Math.min(base, NAME_FIT.minPx) / base)) return { scale: squeezed, mode: 'wrap' };
  return { scale: floor, mode: 'break' };
}

/**
 * Fit the names of a wall's tiles (.dband__name, fitBandNameScale): each gets --bk (its scale) and data-fit "one" (one
 * line), "wrap" (at the floor or a little under it, words whole) or "break" (a word wider than the tile even there breaks inside, as the
 * unmeasured CSS does). Measured in three passes over all of them — a layout each, not one per tile —, from computed
 * widths (the tiles' entry animation scales them: rectangles would be off): the box at its size on one line ("measure"),
 * the line ("measure-line", max-content) and the widest piece ("measure-word", min-content, words whole). A hidden name
 * (a search, 已被选择) is skipped; the caller fits again when it shows.
 * @param {HTMLElement} wall
 */
export function fitBandNames(wall) {
  const names = [...wall.querySelectorAll('.dband__name')].filter((n) => n.getClientRects().length);
  if (!names.length) return;
  const width = (n) => px(getComputedStyle(n).width);
  for (const n of names) { n.style.removeProperty('--bk'); n.dataset.fit = 'measure'; }
  const m = names.map((n) => {
    const cs = getComputedStyle(n);
    const pad = px(cs.paddingLeft) + px(cs.paddingRight);
    return { box: px(cs.width) + pad, pad, base: px(cs.fontSize), line: 0, word: 0 };
  });
  for (const n of names) n.dataset.fit = 'measure-line';
  names.forEach((n, i) => { m[i].line = width(n); });
  for (const n of names) n.dataset.fit = 'measure-word';
  names.forEach((n, i) => { m[i].word = width(n); });
  names.forEach((n, i) => {
    const { scale, mode } = fitBandNameScale(m[i]);
    if (scale < 1) n.style.setProperty('--bk', scale.toFixed(4));
    n.dataset.fit = mode;
  });
}

/**
 * Size a wall of square tiles (the element's children) to its box: sets --dcols and --dtile (px) on `el`. Children that
 * match `head` (full-row section headers: bandDraft.js .draft-grid__sec) are no tiles: each starts a section, and its
 * row (its height, margins and one row gap) is taken off the box.
 * @param {HTMLElement} el @param {{ min: number, max: number, head?: string|null }} rem tile bounds in rem
 */
export function fitTileBox(el, { min, max, head = null }) {
  const cs = getComputedStyle(el);
  const w = el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight);
  let h = el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom);
  const r = rootPx();
  const kids = [...el.children];
  let count = kids.length;
  let groups = null;
  if (head && kids.some((k) => k.matches(head))) {
    groups = [];
    count = 0;
    let n = 0;
    for (const k of kids) {
      if (!k.matches(head)) { n++; continue; }
      if (n) groups.push(n);
      count += n;
      n = 0;
      const ks = getComputedStyle(k);
      h -= k.getBoundingClientRect().height + px(ks.marginTop) + px(ks.marginBottom) + px(cs.rowGap);
    }
    if (n) groups.push(n);
    count += n;
  }
  const fit = fitTiles(count, w, Math.max(1, h), px(cs.columnGap), px(cs.rowGap), min * r, max * r, groups);
  el.style.setProperty('--dcols', String(fit.cols));
  el.style.setProperty('--dtile', `${fit.tile}px`);
  el.dataset.fit = fit.fits ? 'all' : 'scroll';
}

/**
 * Size the rows (`rowSel`, all of one height) of a column to its box: sets --drh (px) on `el`.
 * @param {HTMLElement} el @param {{ rowSel: string, min: number, max: number }} opts bounds in rem
 */
export function fitRowBox(el, { rowSel, min, max }) {
  const rows = el.querySelectorAll(rowSel);
  const first = el.firstElementChild;
  const last = el.lastElementChild;
  if (!rows.length || !first || !last) return;
  const cs = getComputedStyle(el);
  const contentH = last.getBoundingClientRect().bottom - first.getBoundingClientRect().top + px(cs.paddingTop) + px(cs.paddingBottom);
  const r = rootPx();
  const h = fitRowHeight(rows.length, el.clientHeight, contentH, rows[0].getBoundingClientRect().height, min * r, max * r);
  el.style.setProperty('--drh', `${h}px`);
}

/**
 * Run `fit(el)` now and whenever the element's box changes size (ResizeObserver, one per animation frame); `deps`
 * re-run it (e.g. the number of children). `fonts`: also when web fonts finish loading (a fit that measures text).
 * Nothing where ResizeObserver is missing: the CSS fallbacks stay.
 * @param {{ current: HTMLElement|null }} ref @param {(el: HTMLElement) => void} fit @param {any[]} deps
 * @param {{ fonts?: boolean }} [opts]
 */
export function useFitBox(ref, fit, deps, { fonts = false } = {}) {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== 'function') return undefined;
    let raf = 0;
    const run = () => { raf = 0; if (el.isConnected) fit(el); };
    const later = () => { if (!raf) raf = requestAnimationFrame(run); };
    const ro = new ResizeObserver(later);
    ro.observe(el);
    const fontSet = fonts ? globalThis.document?.fonts : null;
    fontSet?.addEventListener?.('loadingdone', later);
    run();
    return () => { ro.disconnect(); fontSet?.removeEventListener?.('loadingdone', later); if (raf) cancelAnimationFrame(raf); };
  }, deps);
}
