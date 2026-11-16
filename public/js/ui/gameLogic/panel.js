// ui/gameLogic/panel.js — detail card and bond popup placement. Re-exported from ../gameLogic.js.

import { isObj } from './shared.js';


// ---- detail panel placement (user playtest #2 item 8) ---------------------------------------------------------------

/**
 * Which side the detail panel goes to so it never covers the selected unit's underframe: the default 'left' panel
 * unless the underframe (buttons included) overlaps it and the 'right' slot is clear of it (else 'left' — the
 * underframe is drawn above the panel anyway, css z-index).
 * @param {{ left: number, right: number, top: number, bottom: number }|null} uf underframe rect (client px)
 * @param {{ left: {left:number,right:number,top:number,bottom:number}, right: {left:number,right:number,top:number,bottom:number} }} slots
 * @param {{ minRight?: number }} [o]
 * @returns {'left'|'right'}
 */
export function panelSide(uf, slots, { minRight = 0 } = {}) {
  if (!isObj(uf) || !isObj(slots)) return 'left';
  const hit = (a, b) => !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  if (!hit(uf, slots.left)) return 'left';
  // `minRight` (client px): a right slot shorter than that gives way to the left one, where the official client always
  // shows the card (research 09 §1) — a phone above the 规程 shop under a pack's corner left ~110 px at 800×360
  if (minRight > 0 && isObj(slots.right) && slots.right.bottom - slots.right.top < minRight) return 'left';
  return hit(uf, slots.right) ? 'left' : 'right';
}

/**
 * Client-px rects of the two detail panel slots (css .dpanel / .dpanel--right in rem): left at 2.3rem, right against
 * the right edge above the shop bar when it is open.
 * @param {{ width: number, height: number, left?: number, top?: number }} vp the HUD layer's box (.gm__hud): its size,
 *   and its client offset — the HUD sits inside the safe-area insets (css/devices.css), so on a notched phone the
 *   panels start `left` / `top` px further in than the viewport edge (default 0: the whole viewport)
 * @param {number} rem root font size (px)
 * @param {{ shopOpen?: boolean, reg?: boolean, corner?: string }} [o] `reg`: the 规程 shop (taller); `corner`: whose corner
 *   sits top right (TopBar's data-corner, cornerKind in ui/regHud.js): the right card starts under it (CORNER_TOP)
 */
export function panelSlots(vp, rem, { shopOpen = false, reg = false, corner = 'hand' } = {}) {
  const W = Number(vp?.width) || 1920;
  const H = Number(vp?.height) || 1080;
  const X = Number.isFinite(vp?.left) ? vp.left : 0;
  const Y = Number.isFinite(vp?.top) ? vp.top : 0;
  const R = rem > 0 ? rem : 100;
  const top = R * 2.1;
  const rTop = R * cornerTop(corner);
  const leftH = Math.min(R * 8.4, H - top - R * 1.02);
  const shopInset = !reg ? PANEL_RIGHT_BOTTOM_SHOP : PANEL_RIGHT_BOTTOM_SHOP_REG;
  const rightBottom = H - R * (shopOpen ? shopInset : PANEL_RIGHT_BOTTOM);
  return {
    left: { left: X + R * 2.3, right: X + R * (2.3 + 4.9), top: Y + top, bottom: Y + top + leftH },
    right: { left: X + W - R * (PANEL_RIGHT_GAP + 4.9), right: X + W - R * PANEL_RIGHT_GAP, top: Y + rTop, bottom: Y + Math.max(rTop + R, rightBottom) },
  };
}
/**
 * Where the right card (and the bond popup docked right) starts under the top-right corner (rem), by whose corner it is:
 * the hand-made countdown, or an official pack's countdown + ready button (TopBar data-corner). Keep in sync with the
 * `.gtop[data-corner=…] ~ .dpanel--right` / `~ .bpop--right` rules in css/screens/game-reghud.css.
 */
export const CORNER_TOP = Object.freeze({ hand: 2.1, ac_n_initial: 2.6, ac_n_iron: 3, ac_s_closur: 3 });
/** @param {string|null|undefined} corner */
export const cornerTop = (corner) => CORNER_TOP[/** @type {keyof typeof CORNER_TOP} */ (corner || 'hand')] ?? CORNER_TOP.hand;
/** Client px under which the right card is too short to read and the left one is used (panelSide minRight). */
export const PANEL_RIGHT_MIN_PX = 180;
/** Right detail panel slot insets (rem; keep in sync with css/screens/game-panels.css .dpanel--right). */
export const PANEL_RIGHT_GAP = 0.9;
export const PANEL_RIGHT_BOTTOM = 1.02;
export const PANEL_RIGHT_BOTTOM_SHOP = 3.78;
/** The same above the 规程 shop (css/screens/game-reghud.css .gm--reg .dpanel--right.is-shop), on a phone too: the 规程 shop
 * keeps its prefab sizes there (2026-11-16 UI 大修; a short viewport used to have its own 2.92rem for 1.2rem cards). */
export const PANEL_RIGHT_BOTTOM_SHOP_REG = 4.6;

/** Bond popup geometry (rem; keep in sync with css/screens/game-panels.css .bpop / .bpop--*). */
export const BPOP = Object.freeze({ width: 5.4, top: 2.1, bottomGap: 0.3, left: 2.3, beside: 7.32, besideR: 5.92, right: 0.9 });

/**
 * Where the bond popup opens (css .bpop--<place>) so it neither hides the open detail card nor covers the selected
 * unit's underframe (user playtest #2 items 8 / 9): next to the card first ('beside' the left card, 'besideR' left of
 * the right card), else the free side of the screen ('left' at 2.3rem / 'right' against the right edge), else over the
 * card it was opened from; without a card the popup's usual place is 'left'. When every candidate covers the
 * underframe the first one is kept (the underframe is drawn above the popup, css z-index).
 * @param {{ left: number, right: number, top: number, bottom: number }|null} uf underframe rect (client px) or null
 * @param {{ width: number, height: number, left?: number, top?: number }} vp the HUD layer's box (see panelSlots)
 * @param {number} rem root font size (px)
 * @param {'left'|'right'|null} card side of the open detail card (null: none)
 * @param {{ corner?: string }} [o] whose corner sits top right (panelSlots)
 * @returns {'left'|'beside'|'besideR'|'right'}
 */
export function bondPopupPlace(uf, vp, rem, card = null, { corner = 'hand' } = {}) {
  const W = Number(vp?.width) || 1920;
  const H = Number(vp?.height) || 1080;
  const X = Number.isFinite(vp?.left) ? vp.left : 0;
  const Y = Number.isFinite(vp?.top) ? vp.top : 0;
  const R = rem > 0 ? rem : 100;
  const bottom = Y + Math.max(R * BPOP.top + R, H - R * BPOP.bottomGap);
  const rectOf = (p) => {
    const left = X + (p === 'left' ? R * BPOP.left : p === 'beside' ? R * BPOP.beside
      : p === 'besideR' ? W - R * (BPOP.besideR + BPOP.width) : W - R * (BPOP.right + BPOP.width));
    // the popup docked right starts under the corner, as the right card does
    const top = Y + R * (p === 'right' ? Math.max(BPOP.top, cornerTop(corner)) : BPOP.top);
    return { left, right: left + R * BPOP.width, top, bottom };
  };
  // last resort: over the card it was opened from (closing the popup shows the card again)
  const order = card === 'left' ? ['beside', 'right', 'left'] : card === 'right' ? ['besideR', 'left', 'right'] : ['left', 'right'];
  if (!isObj(uf)) return order[0];
  const hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  return order.find((p) => !hit(uf, rectOf(p))) || order[0];
}
