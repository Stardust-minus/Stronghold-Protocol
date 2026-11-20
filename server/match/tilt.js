// server/match/tilt.js — experimental ELO tilt (§37.273, the owner's decisions of 2026-11-20): a seat's hidden strength
// `s` ∈ [-1, 1] (step 2: from that player's own win rate, only in a room with the option on; step 1: a test hook,
// setTilt) reweights the seat's OWN random draws of operators and equipment — never a battle, an enemy, a teammate's
// draw or anything shared — so its win rate drifts towards 50%: s > 0 deals the cards it needs more often, s < 0 less.
//
// Server-only on purpose: server/sim/** and shared/** are served to browsers (server/http/static.js), this file never is.
//
// The rule (every lever: a reweighting inside the existing single draw, the number of rng() calls never changes):
//   * relevance r ∈ [0, 1] of each candidate from the seat's state at the roll (no rng; chessRelevance / itemRelevance):
//     a copy that completes an elite merge, a second copy, a member of a bond one or two short of its next threshold
//     (counted over everything the seat owns, as if deployed), of its 预选盟约 or its strategy's home bond, 转职装备 for a
//     live bond, the 转职球 (变形同构体), the second copy of a held item. STRATEGY_TAGS raises r for what a strategy lives
//     on (复奏 the merges, 变形者集群 the 转职 pairs, a bond strategy its bond …).
//   * weight = base · M^(s·r); hindering with a `floor` set, a card with r ≥ `cut` goes to lerp(M^(s·r), floor, |s|) —
//     at s = −1 exactly the floor, which may be 0: the card stays in the pool and every count stays true, it is just not
//     dealt to this seat. A card without stock never gets weight (the pool's own gates run first).
//   * then every tier is rescaled to its untilted total, so the tier shares stay exactly as without the tilt; a tier
//     whose every card was floored to 0 keeps its untilted weights. `tier` (the tier lever, off by default) instead
//     moves up to that share of every tier's mass one tier up (s > 0) or down (s < 0) in the shop's own rolls.
//   * no tilt (absent, s = 0) → the callers take their untouched code path: the same draws, the same results.

import { computeBonds, thresholdsOf } from './bondsMeta.js';

/** Default weight base M. */
export const TILT_BASE = 2;
/** Default relevance cut of the hindering floor. */
export const TILT_CUT = 0.5;
/** The largest tier-lever share (the owner: 「bounded, e.g. move at most 25% of the probability mass by one tier」). */
export const TILT_TIER_MAX = 0.25;

/**
 * What each strategy lives on (the owner, 2026-11-20: 「复奏…靠精锐化…阻碍时不要发能碰的第三张」, generalized from every
 * strategy's text in data/versions/*\/bands.json and server/sim/content/bands/meta.js). A strategy tied to a bond
 * (GameData.bandBondIds: 杜遥夜 炎, 佩佩 萨尔贡 …) gets `home` from the data, so it is not repeated here. Tags:
 *   merge     elite merges / elites on the board: the merge-completing copy and a second copy are its key cards
 *   sameName  two copies of one operator on the board: a second copy is a key card
 *   bonds     bond activation itself (active-bond counts, layer gains of active bonds): a card one short is a key card
 *   highTier  the tier of its operators: higher-tier operators gain relevance
 *   tierSpread operators of different tiers: a tier the seat does not own yet gains relevance
 *   items     equipment (offers, discounts, slots): item merges and live 转职装备 are key cards
 *   itemMerge equipment merges: the second copy of a held item is a key card
 *   morph     转职 pairs (变形同构体): 转职装备 of a live bond and the 转职球 are key cards
 *   refresh   refresh-driven (special refreshes of its bond, refresh counters): informational — its bond is `home`
 * A strategy not listed (歌利亚, 埃芒加德, 大帝 … — a battle or economy effect) uses the plain relevance.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const STRATEGY_TAGS = Object.freeze({
  // act2autochess (the default version)
  band_bldsk: ['tierSpread', 'bonds'], // 华法琳 重点监护: +2 layers per distinct tier on the board
  band_amiya: ['bonds'], // 阿米娅 众志合一: 3 / 4 / 5 active bonds
  band_duyaoy: ['refresh'], // 杜遥夜 广交豪杰: special refreshes of 炎
  band_orchid: ['merge', 'refresh'], // 梓兰 猎头顾问: every refresh two copies of one operator
  band_pepe: ['refresh'], // 佩佩 博学多通: special refreshes of 萨尔贡
  band_paganini: ['highTier'], // 潘格尼尼 定制铳械: elite 拉特兰 of tier 4+
  band_clementia: ['highTier'], // 克莱门莎 崇高牺牲: 阿戈尔 layers by the operator's tier
  band_yu: ['bonds'], // 余 文火慢炖: one active bond +36, else every active +12
  band_cathy: ['items'], // 凯瑟琳 定向投放: equipment offers
  band_damaztic: ['morph'], // “变形者集群” 变形同构: a 变形同构体 every 5 rounds
  band_pith: ['bonds'], // Pith 优等生: 调和 counts core bonds +1
  band_dusk: ['sameName'], // 夕 墨色真颜: same-name operators +30% attack
  band_ioleta: ['merge'], // 伊奥莱塔·罗素 统御号令: +10% per elite on the board
  band_jesica: ['bonds'], // 杰西卡 集结指示: 寻呼模块, operators of the carrier's bonds
  band_chiave: ['refresh'], // 贾维 团伙行动: refresh count → 叙拉古
  band_narant: ['items'], // 娜仁图亚 见者有份: equipment offers, 萨尔贡 shares equipment
  band_amedic: ['merge'], // Touch 外勤医疗: two elites on the board
  // act3autochess-v3_1 (规程) — its own band ids
  band_price: ['items'], // 天空盒 内部货源: equipment discount
  band_jenga: ['bonds'], // 但书 条文修正: +9 on every active bond of one operator
  band_takecare: ['tierSpread', 'bonds'], // 华法琳 重点监护
  band_smith: ['items'], // 奥达 全力熔铸: random equipment
  band_weakness: ['merge'], // 陈 以己之长: elites +16%
  band_mech: ['items'], // 森蚺 暴躁铁皮: a four-slot operator
  band_sell: ['highTier', 'bonds'], // 三船光平 东之极道: sell for layers by tier on every active bond
  band_support: ['highTier'], // 雅拉 人才锁定: refresh with a higher-tier operator
  band_high: ['merge'], // 渡桥 专享情报: refresh of deployed operators
  band_equipment: ['items', 'itemMerge'], // Mechanist 精巧设计: equipment merges → equipment offers
  band_pudd: ['items'], // 布丁 电气化！: shop equipment for the whole board
  band_bonus: ['merge'], // 复奏 二重奏: an extra promotion reward on the first elite merge of a round
  band_yan: ['refresh'], // 杜遥夜 广交豪杰 (指令)
  band_siracusa: ['refresh'], // 裁度 量体裁衣: coin on the first refresh
  band_bond: ['refresh'], // 贾维 团伙行动
});

/** The strategy effects whose free equipment offers are tilted (凯瑟琳 定向投放, 娜仁图亚 见者有份; bands/meta.js). */
const OFFER_KEYS = new Set(['up_shop_add_special_goods', 'preparation_start_add_special_goods_every_n_round']);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v, d) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));

/**
 * The test hook (step 1; step 2 sets it from the player's rating in a room with the option): a seat's tilt, normalized.
 * `s` the strength, `m` the base M (≥ 1), `floor` (null = none) and `cut` the hindering floor, `tier` the tier lever's
 * share (0 = off, at most TILT_TIER_MAX), `core` false to switch the relevance weighting off (the tier lever alone).
 * s = 0 removes it.
 * @param {any} ps @param {{ s: number, m?: number, floor?: number|null, cut?: number, tier?: number, core?: boolean }|null} opts
 */
export function setTilt(ps, opts) {
  const s = clamp(num(opts?.s, 0), -1, 1);
  if (!opts || s === 0) { delete ps.tilt; return null; }
  const floor = opts.floor == null ? null : clamp(num(opts.floor, 0), 0, 1);
  ps.tilt = {
    s, m: Math.max(1, num(opts.m, TILT_BASE)), floor, cut: clamp(num(opts.cut, TILT_CUT), 0, 1),
    tier: clamp(num(opts.tier, 0), 0, TILT_TIER_MAX), core: opts.core !== false,
  };
  return ps.tilt;
}

/** The seat's tilt, or null (off: absent or s = 0 — the callers keep their untouched path). */
export function tiltOf(ps) {
  const t = ps && ps.tilt;
  return t && typeof t === 'object' && Number.isFinite(t.s) && t.s !== 0 ? t : null;
}

/** The multiplier of relevance r under tilt t. */
export function tiltFactor(t, r) {
  if (!(r > 0) || t.core === false) return 1;
  const f = Math.pow(t.m, t.s * r);
  if (t.s < 0 && t.floor != null && r >= t.cut) return f + (t.floor - f) * -t.s;
  return f;
}

/** The strategy's tags (STRATEGY_TAGS), `home` when it is tied to a bond. */
function tagsOf(ps) {
  const gd = ps.gd;
  const out = new Set(STRATEGY_TAGS[ps.bandId] || []);
  const home = ps.bandId && typeof gd.bandBondIds === 'function' ? gd.bandBondIds(ps.bandId) : [];
  return { tags: out, home: new Set(home) };
}

/**
 * Everything the relevance reads, once per roll (no rng): normal copies per base, the owned bases, bonds counted over every
 * owned operator as if deployed (computeBonds), how short each started bond is of its next threshold, 预选盟约, the
 * strategy's tags and home bonds, the tiers owned, the held items.
 * @param {any} ps
 */
export function tiltContext(ps) {
  const gd = ps.gd;
  const copies = new Map(), owned = new Set(), tiers = new Set(), pieces = [];
  let morphHeld = false, giveHeld = false;
  const seeItem = (id) => {
    const it = gd.item(id);
    if (!it) return;
    if (it.canGiveBond) morphHeld = true;
    if (typeof it.giveBondId === 'string') giveHeld = true;
  };
  for (const { piece } of ps._chessLocations()) {
    const base = gd.baseIdOf(piece.id);
    owned.add(base);
    tiers.add(gd.tierOf(piece.id));
    if (!gd.isGolden(piece.id)) copies.set(base, (copies.get(base) || 0) + 1);
    pieces.push(piece);
    for (const it of piece.items || []) seeItem(it.id);
  }
  for (const p of [...ps.hand, ...ps.temp]) if (p && p.kind === 'item') seeItem(p.id);
  const bonds = computeBonds(gd, { board: new Map(pieces.map((p, i) => [String(i), p])), hand: [], layers: ps.layers || {}, bondCountBonus: ps.bondCountBonus, m: ps.m });
  const short = new Map();
  for (const [id, st] of Object.entries(bonds)) {
    const bond = gd.bond(id);
    if (!bond || !(st.count >= 1) || bond.thresholdTemplate === 'count_threshold_downward' || bond.countMode === 'BOARD_ALL_CHESS' || bond.thresholdTemplate === 'count_threshold_upward_golden') continue;
    const next = thresholdsOf(bond).find((n) => n > st.count);
    if (next != null && next - st.count <= 2) short.set(id, next - st.count);
  }
  const { tags, home } = tagsOf(ps);
  const plan = new Set([ps.bondPlan, ...(Array.isArray(ps.bondPlanSub) ? ps.bondPlanSub : [])].filter((b) => typeof b === 'string'));
  return { ps, gd, copies, owned, tiers, bonds, short, tags, home, plan, morphHeld, giveHeld };
}

/**
 * Relevance of a chess candidate (0 … 1). Plain: completes a merge 0.7, a second copy 0.35, a member of a bond one short
 * 0.7 / two short 0.35, a member of 预选盟约 or the home bond 0.35. The strategy's key cards (STRATEGY_TAGS) instead: 1 /
 * 0.6 (merge, sameName, bonds), a home-bond member 0.8 (1 one short), higher tiers (highTier), a tier not owned (tierSpread).
 * @param {ReturnType<typeof tiltContext>} cx @param {string} id
 */
export function chessRelevance(cx, id) {
  const { gd, tags } = cx;
  const rec = gd.chess(id);
  if (!rec) return 0;
  const base = gd.baseIdOf(id);
  const held = cx.copies.get(base) || 0;
  let r = 0;
  if (!rec.isGolden && gd.mergeCount(id) > 1 && gd.goldenIdOf(id)) {
    if (held + 1 >= gd.mergeCount(id)) r = tags.has('merge') ? 1 : 0.7;
    else if (held >= 1) r = tags.has('sameName') ? 1 : tags.has('merge') ? 0.6 : 0.35;
  }
  if (!cx.owned.has(base)) {
    for (const b of Array.isArray(rec.bonds) ? rec.bonds : []) {
      const home = cx.home.has(b), key = home || tags.has('bonds');
      const short = cx.short.get(b);
      if (short === 1) r = Math.max(r, key ? 1 : 0.7);
      else if (short === 2) r = Math.max(r, key ? 0.6 : 0.35);
      if (home) r = Math.max(r, 0.8);
      else if (cx.plan.has(b)) r = Math.max(r, 0.35);
    }
    if (tags.has('tierSpread') && !cx.tiers.has(gd.tierOf(id))) r = Math.max(r, 0.6);
  }
  if (tags.has('highTier')) r = Math.max(r, clamp(0.2 * (gd.tierOf(id) - 2), 0, 0.8));
  return r;
}

/**
 * Relevance of an equipment candidate: the second copy of a held item (its merge) 0.7, 转职装备 (giveBondId) of an active
 * bond or one one short 0.7 / two short 0.35, the 转职球 (canGiveBond) 0.7 with a 转职装备 held, else 0.35. Key cards (items,
 * itemMerge, morph) 1 / 0.6.
 * @param {ReturnType<typeof tiltContext>} cx @param {string} id
 */
export function itemRelevance(cx, id) {
  const { gd, tags } = cx;
  const rec = gd.item(id);
  if (!rec) return 0;
  let r = 0;
  if (typeof cx.ps.completesItemMerge === 'function' && cx.ps.completesItemMerge(id)) r = tags.has('items') || tags.has('itemMerge') ? 1 : 0.7;
  const key = tags.has('morph') || tags.has('items');
  if (typeof rec.giveBondId === 'string') {
    const st = cx.bonds[rec.giveBondId], short = cx.short.get(rec.giveBondId);
    if ((st && st.active) || short === 1) r = Math.max(r, key ? 1 : 0.7);
    else if (short === 2 || cx.home.has(rec.giveBondId)) r = Math.max(r, key ? 0.6 : 0.35);
    if (cx.morphHeld) r = Math.max(r, tags.has('morph') ? 1 : 0.7);
  }
  if (rec.canGiveBond && !rec.isGolden) r = Math.max(r, cx.giveHeld ? (tags.has('morph') ? 1 : 0.7) : (tags.has('morph') ? 0.6 : 0.35));
  return r;
}

/**
 * Tier-lever shift of tier totals (Map tier → mass): `f` > 0 moves that share of every tier's mass one tier up (the top
 * tier keeps its own), f < 0 one tier down; only between tiers that have mass. The total is unchanged.
 * @param {Map<number, number>} totals @param {number} f
 */
export function shiftTiers(totals, f) {
  const tiers = [...totals.keys()].filter((t) => totals.get(t) > 0).sort((a, b) => a - b);
  const out = new Map(totals);
  if (tiers.length < 2 || !f) return out;
  if (f > 0) for (let i = 0; i < tiers.length - 1; i++) { const mv = totals.get(tiers[i]) * f; out.set(tiers[i], out.get(tiers[i]) - mv); out.set(tiers[i + 1], out.get(tiers[i + 1]) + mv); }
  else for (let i = tiers.length - 1; i > 0; i--) { const mv = totals.get(tiers[i]) * -f; out.set(tiers[i], out.get(tiers[i]) - mv); out.set(tiers[i - 1], out.get(tiers[i - 1]) + mv); }
  return out;
}

/**
 * Reweight candidates: [id, base weight, tier] → [id, weight], same order. Every tier keeps its untilted total (or the
 * tier lever's share of it, `shift`); a tier whose every weight came out 0 keeps its untilted weights.
 * @param {Array<[string, number, number]>} list @param {(id: string) => number} factor @param {number} [shift]
 */
function reweight(list, factor, shift = 0) {
  const base = new Map(), tilted = new Map();
  const w = list.map(([id, n, tier]) => {
    const x = n > 0 ? n * factor(id) : 0;
    base.set(tier, (base.get(tier) || 0) + Math.max(0, n));
    tilted.set(tier, (tilted.get(tier) || 0) + x);
    return x;
  });
  const goal = shift ? shiftTiers(base, shift) : base;
  return list.map(([id, n, tier], i) => {
    const t = tilted.get(tier);
    if (!(t > 0)) return [id, Math.max(0, n) * ((goal.get(tier) || 0) / (base.get(tier) || 1))];
    return [id, w[i] * (goal.get(tier) / t)];
  });
}

/**
 * The tilt of a chess roll (SharedPool.roll `tilt`), or null without a tilt. `shop`: the shop's own slot rolls, where the
 * tier lever applies too.
 * @param {any} ps @param {{ shop?: boolean }} [opts]
 * @returns {((el: Array<[string, number, number]>) => Array<[string, number]>) | null}
 */
export function chessTilt(ps, { shop = false } = {}) {
  const t = tiltOf(ps);
  if (!t) return null;
  const shift = shop && t.tier > 0 ? t.tier * t.s : 0;
  if (t.core === false && !shift) return null;
  return (el) => {
    const cx = t.core === false ? null : tiltContext(ps);
    return reweight(el, (id) => (cx ? tiltFactor(t, chessRelevance(cx, id)) : 1), shift);
  };
}

/**
 * The tilt of an equipment pick (SharedItemPool.pick weights), or null: (ids, base weights | null) → Map id → weight,
 * every item tier keeping its untilted total.
 * @param {any} ps
 * @returns {((ids: string[], weights?: Map<string, number>|null) => Map<string, number>) | null}
 */
export function itemTilt(ps) {
  const t = tiltOf(ps);
  if (!t || t.core === false) return null;
  return (ids, weights = null) => {
    const cx = tiltContext(ps);
    const list = [...new Set(ids)].map((id) => [id, weights ? Math.max(0, Number(weights.get(id)) || 0) : 1, ps.gd.item(id)?.tier ?? 0]);
    return new Map(reweight(/** @type {any} */ (list), (id) => tiltFactor(t, itemRelevance(cx, id))));
  };
}

/** The tier lever on the shop item slot's tier shares ({ tier: share }), or null. @param {any} ps */
export function itemTierTilt(ps) {
  const t = tiltOf(ps);
  if (!t || !(t.tier > 0)) return null;
  return (shares) => {
    const out = {};
    for (const [k, v] of shiftTiers(new Map(Object.entries(shares).map(([k, v]) => [Number(k), v])), t.tier * t.s)) out[k] = v;
    return out;
  };
}

/**
 * The equipment tilt of a strategy's free item offer (凯瑟琳 定向投放, 娜仁图亚 见者有份: a band source whose effect is one of
 * OFFER_KEYS drawing that effect's pool), else null.
 * @param {any} ps @param {any} source the dispatch source @param {string} poolId
 */
export function offerTilt(ps, source, poolId) {
  if (!tiltOf(ps) || !source || source.kind !== 'band') return null;
  const band = source.band || ps.gd.band?.(source.bandId);
  const hit = (Array.isArray(band?.buffs) ? band.buffs : []).some((b) => OFFER_KEYS.has(b?.key) && (b.bbStr?.pool ?? b.bb?.pool ?? band.params?.pool) === poolId);
  return hit ? itemTilt(ps) : null;
}

/**
 * Weighted pick with one rng() (the shop item slot without a stock gate): [id, weight] → id, never a 0-weight one.
 * @param {Function} rng @param {string[]} ids @param {Map<string, number>} weights
 */
export function weightedPickOf(rng, ids, weights) {
  const pairs = ids.map((id) => [id, Math.max(0, Number(weights.get(id)) || 0)]);
  const total = pairs.reduce((n, p) => n + /** @type {number} */ (p[1]), 0);
  if (!(total > 0)) return null;
  let r = rng() * total, last = null;
  for (const [id, w] of pairs) { if (w > 0) last = id; if ((r -= /** @type {number} */ (w)) < 0) return id; }
  return last;
}
