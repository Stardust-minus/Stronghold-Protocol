// tools/rl/describe.mjs — compact, readable summaries of a seat's decision state for the replay viewer (plan §8, B2).
// Everything comes from the seat's own human view (privateView) and the public catalogue names. Names are interned into
// a per-match table (Names) so a match file stays small.
import { ACT, SHOP, OWNED, REWARDS, PERSONAL, CARDS } from './spec.mjs';
import { Encoder } from './spec.mjs';

export class Names {
  constructor() { this.list = []; this.index = new Map(); }
  id(s) {
    const k = String(s ?? '');
    if (!this.index.has(k)) { this.index.set(k, this.list.length); this.list.push(k); }
    return this.index.get(k);
  }
}

const nameOf = (gd, id) => {
  if (!id) return '';
  const c = gd.chess(id) || gd.item(id) || gd.token?.(id);
  return (c && c.name) || id;
};

/** One decision state. kind: 'prep' | 'card'. Arrays are positional: see the field lists below. */
export function summarize(m, ps, own, names, kind) {
  const gd = m.gd;
  const piece = (p) => p ? [names.id(nameOf(gd, p.id)), p.tier || gd.tierOf?.(p.id) || 0, p.golden ? 1 : 0, (p.items || []).length,
    p.kind === 'item' ? 1 : p.kind === 'token' ? 2 : 0] : null; // name, tier, golden, equipment, kind (0 operator, 1 item, 2 token)
  const owned = Encoder.owned(own);
  const shop = (own.shop?.slots || []).map((s) => s ? [names.id(nameOf(gd, s.id)), gd.tierOf?.(s.id) || 0, s.price || 0, s.sold ? 1 : 0,
    s.frozen ? 1 : 0, s.kind === 'item' ? 1 : 0] : null); // name, tier, price, sold, frozen, item
  const bonds = (own.bonds || []).filter((b) => (b.count || 0) > 0 || (b.layers || 0) > 0).map((b) => [names.id(gd.bond(b.bondId)?.name || b.bondId),
    b.count || 0, b.active ? (b.tier || 0) : 0, (b.thresholds || []).length, b.layers || 0]); // name, count, active tier, max tier, layers
  const rewards = (own.shop?.rewardOffer?.slots || []).map((s) => s ? [names.id(nameOf(gd, s.id)), s.price || 0, s.sold ? 1 : 0] : null);
  const personal = (own.personalChoice?.cards || []).map((c) => names.id(c.name || c.id));
  const cards = kind === 'card' && m.sp ? m.sp.cards.map((c) => [names.id(c.name || c.id), c.kind === 'bounty' ? 1 : 0]) : [];
  const st = ps.stats || {};
  return {
    r: m.round, k: kind === 'card' ? 1 : 0, lp: Math.max(0, own.lp || 0), g: own.funds || 0, lv: own.shop?.level || 0,
    shop, owned: owned.map(piece), bonds, rewards, personal, cards,
    st: [st.dmgDealt || 0, st.kills || 0, st.leaks || 0, Math.round(st.bossDamage || 0), st.lpLost || 0], // cumulative
  };
}

/** A readable label of env action `a` in a state summarized by summarize() (same names table). */
export function actionLabel(a, s, names) {
  const n = (i) => names.list[i] ?? '?';
  if (a === ACT.END) return '结束准备';
  if (a === ACT.REFRESH) return '刷新';
  if (a === ACT.LEVEL) return '升级商店';
  if (a === ACT.FREEZE) return '冻结';
  if (a < ACT.SELL) { const x = s.shop[a - ACT.BUY]; return `买 ${a - ACT.BUY + 1} 号格${x ? '：' + n(x[0]) : ''}`; }
  if (a < ACT.REWARD) {
    const j = a - ACT.SELL, x = s.owned[j];
    const where = j < 10 ? `整备区 ${j + 1}` : j < 15 ? `临时 ${j - 9}` : `场上 ${j - 14}`;
    return `卖 ${where}${x ? '：' + n(x[0]) : ''}`;
  }
  if (a < ACT.PERSONAL) { const x = s.rewards[a - ACT.REWARD]; return `领奖励 ${a - ACT.REWARD + 1}${x ? '：' + n(x[0]) : ''}`; }
  if (a < ACT.CARD) { const x = s.personal[a - ACT.PERSONAL]; return `个人选择 ${a - ACT.PERSONAL + 1}${x != null ? '：' + n(x) : ''}`; }
  const x = s.cards[a - ACT.CARD]; return `机变 ${a - ACT.CARD + 1}${x ? '：' + n(x[0]) : ''}`;
}
export const LIMITS = { SHOP, OWNED, REWARDS, PERSONAL, CARDS };
