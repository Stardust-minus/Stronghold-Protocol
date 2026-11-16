// 卡池剩余 (feedback #160, a fork addition — the official shop cards and bond card show no such number): how many copies of
// an operator or a piece of equipment are left in the stock the player shares with the rest of their pool group
// (m.private poolLeft, server/match/pool.js poolCountsView). The server sends it only when the stock is shared and finite
// (never in 单人 / 独立卡池 / a one-seat pool group, never for effect-only equipment or the private 自选 stock); 设置
// 「显示卡池剩余张数」 (poolCount, on by default) hides it.
// The mark is a small tab right of the card's price — the card's buying information, not its frame (the owner's rule for
// marks, feedback #152: on the element it belongs to, easy to tell from the 可晋升 tag, the owned-copies pips and the plan
// marks) — and the same tab on a member's portrait on the bond card. It reads 「余 n」, red at 0 (a card already in the shop
// can still be bought: displays reserve nothing, and that purchase overdraws the stock). It hung under the price at first;
// that covered the top of the portrait, worst on the 规程 card (the owner, 2026-11-16: right of the price instead).

import { html } from './components.js';
import { data } from '../data.js';
import { t, tParts } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/**
 * The copies left of a shop operator / equipment in the player's shared stock, or null when it is not counted.
 * @param {any} priv m.private (its `poolLeft`)
 * @param {'chess'|'item'} kind
 * @param {string} id a chess or item id; an elite / advanced id counts against its base
 * @returns {number|null}
 */
export function poolLeftOf(priv, kind, id) {
  const map = priv?.poolLeft?.[kind === 'item' ? 'items' : 'chess'];
  if (!map || typeof map !== 'object' || typeof id !== 'string') return null;
  const own = map[id];
  if (Number.isInteger(own) && own >= 0) return own;
  const base = data.lookup(kind === 'item' ? 'items' : 'chess', id)?.baseId;
  const n = base && base !== id ? map[base] : undefined;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * The tab: 「余 n」 beside a shop card's price or on a bond member's portrait (`where`: 'card' | 'member').
 */
export function PoolTag({ n, where = 'card' }) {
  if (!Number.isInteger(n) || n < 0) return null;
  const label = t('卡池剩余 {n} 张', { n });
  return html`<span class=${cx('pooltag', `pooltag--${where}`, n === 0 && 'is-empty')} data-pool-left=${n} title=${label} aria-label=${label}>
    <span class="pooltag__k" aria-hidden="true">${tParts('余 {n}', { n: html`<b class="pooltag__n num">${n}</b>` })}</span>
  </span>`;
}

/**
 * A shop / reward card's price with its tab on the right (css/screens/game-shop.css .scard__pricebox): the box takes the
 * price's place — the 盟约 card's top centre, the 规程 card's cost anchor (`style`) — and the price sits in it, so the tab
 * follows the price whatever its width (a two-digit price, FREE). `edge`: the anchor is in the card's right part (乌萨斯齐心团
 * and 可露希尔 put the 规程 card's root_cost there, which only FREE follows), where no tab fits on the right — the price and
 * the tab move left together, right-aligned in the card, the price's height kept (`--pb-top`: phones keep the box inside the
 * card's top edge). Without a count the price is returned as
 * it is (单人 / 独立卡池 / 设置 off draw exactly what they drew before).
 * @param {any} price the price element
 * @param {number|null} n the count (poolLeftOf)
 * @param {{ style?: Record<string, string>|null, edge?: boolean }} [opts]
 */
export function withPoolTag(price, n, { style = null, edge = false } = {}) {
  if (!Number.isInteger(n) || n < 0) return price;
  return html`<span class=${cx('scard__pricebox', edge && 'is-edge')} style=${edge && style ? { '--pb-top': style.top } : style}>${price}<${PoolTag} n=${n} /></span>`;
}

/** The anchor is right of the card's middle (a 规程 face's root_cost `left`, a percentage): see withPoolTag `edge`. */
export const isEdgeAnchor = (style) => Number.parseFloat(style?.left) > 55;
