// 成就奖杯等级 (the 2026-10-14 design by 雨千代chiyo, the PRTS 同盟成就奖杯 table): the cumulative trophies pick one of five
// chess-piece badges — 0~9 / 10~29 / 30~59 / 60~99 / 100+ (data/config.json trophies.medals, the official medalDataList),
// art data/assets.json ui['medalIcon/trophy_level<n>_icon']; the SVG rook while the pack is missing or fails to load.
// 规程's config lists eight (150 / 200 / 300 more): their icons come from the local extraction only (ui/assetUrls.js
// medalIconUrl, the medal's iconId).
// One's own count is the sum of this browser's 统计数据 (ui/playerCard.js trophyTotal); a teammate's comes with their
// seat's card (room.state seats[].card.trophies — that player's own claim, display only).

import { useState } from '../../vendor/hooks.module.js';
import { html, Icon } from './components.js';
import { data, useData } from '../data.js';
import { medalIconUrl } from './assetUrls.js';
import { t } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');
export const MEDAL_STEPS = [0, 10, 30, 60, 100];

/** The trophy level (1..5) of a cumulative count. */
export function trophyLevel(count, medals = data.get('config')?.trophies?.medals) {
  const steps = Array.isArray(medals) && medals.length ? medals.map((m) => Number(m?.count) || 0) : MEDAL_STEPS;
  const n = Number.isFinite(count) ? count : 0;
  let lv = 1;
  steps.forEach((min, i) => { if (n >= min) lv = i + 1; });
  return lv;
}

/**
 * The trophy-level badge.
 * @param {{ count: number|null|undefined, class?: string, title?: string }} props  count null: unknown (a guest) → nothing
 */
export function TrophyBadge({ count, class: cls, title }) {
  useData('assets'); useData('config');
  const [bad, setBad] = useState(null);
  if (!Number.isFinite(count)) return null;
  const lv = trophyLevel(count);
  const medals = data.get('config')?.trophies?.medals;
  const iconId = (Array.isArray(medals) && typeof medals[lv - 1]?.iconId === 'string' && medals[lv - 1].iconId) || `trophy_level${lv}_icon`;
  const src = medalIconUrl(data.get('assets'), iconId);
  const tip = title ?? t('奖杯等级 {lv} · 累计奖杯 {n}', { lv, n: count });
  if (typeof src === 'string' && src && bad !== src) {
    return html`<img class=${cx('tbadge', `tbadge--${lv}`, cls)} src=${src} alt=${tip} title=${tip} draggable=${false} onError=${() => setBad(src)} />`;
  }
  return html`<span class=${cx('tbadge', 'tbadge--svg', `tbadge--${lv}`, cls)} title=${tip}><${Icon} name="rook" /></span>`;
}
