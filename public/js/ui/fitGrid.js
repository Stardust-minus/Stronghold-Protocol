// Fit to the box (the owner, 2026-11-05: 「优化进入阶段，选择策略阶段的UI大小，尽量不用滚动」): the strategy draft's wall of
// portraits and its order rows take the size that shows all of them in the space the screen gives them, instead of a fixed
// size and a scrollbar. Pure sizing math (unit-tested) plus a hook that applies it to an element on every resize, writing
// CSS custom properties on the element only (no re-render): css/screens/draft.css reads them, with the design sizes as
// the fallback (before the first measure, and where ResizeObserver is missing).
//   * fitTiles: `count` square tiles in a w×h box — the column count that gives the largest tile, at most `max`; below
//     `min` the tiles keep `min` and the box scrolls (a phone's portrait screen, a huge list).
//   * fitRowHeight: `n` rows in a column whose other content (pool heads, gaps, paddings) keeps its height.
// Used by screens/bandDraft.js (.draft-grid: --dcols / --dtile; .draft-order__rows: --drh).

import { useEffect } from '../../vendor/hooks.module.js';

/**
 * The largest square tile for `count` tiles in a box of inner size w × h (px), with the gaps between them.
 * @param {number} count @param {number} w @param {number} h @param {number} gapX @param {number} gapY
 * @param {number} min @param {number} max px
 * @returns {{ cols: number, tile: number, fits: boolean }}
 */
export function fitTiles(count, w, h, gapX, gapY, min, max) {
  const n = Math.floor(Number(count));
  if (!(n > 0) || !(w > 0) || !(h > 0)) return { cols: Math.max(1, Math.min(4, n || 4)), tile: max, fits: true };
  // the largest tile; among column counts that give it (the `max` cap: a box with room to spare), the wall whose shape is
  // closest to the box's
  const shape = (cols) => Math.abs(Math.log(cols / Math.ceil(n / cols)) - Math.log(w / h));
  const sizes = [];
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
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
 * Size a wall of square tiles (the element's children) to its box: sets --dcols and --dtile (px) on `el`.
 * @param {HTMLElement} el @param {{ min: number, max: number }} rem tile bounds in rem
 */
export function fitTileBox(el, { min, max }) {
  const cs = getComputedStyle(el);
  const w = el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight);
  const h = el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom);
  const r = rootPx();
  const fit = fitTiles(el.children.length, w, h, px(cs.columnGap), px(cs.rowGap), min * r, max * r);
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
 * re-run it (e.g. the number of children). Nothing where ResizeObserver is missing: the CSS fallbacks stay.
 * @param {{ current: HTMLElement|null }} ref @param {(el: HTMLElement) => void} fit @param {any[]} deps
 */
export function useFitBox(ref, fit, deps) {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== 'function') return undefined;
    let raf = 0;
    const run = () => { raf = 0; if (el.isConnected) fit(el); };
    const ro = new ResizeObserver(() => { if (!raf) raf = requestAnimationFrame(run); });
    ro.observe(el);
    run();
    return () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, deps);
}
