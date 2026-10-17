// 成就统计 (2026-10-14: the panel of the lobby design by 雨千代chiyo, rebuilt on this browser's 统计数据 — the owner's
// decision: no accounts, so everything here is local and per browser, like 统计数据 itself, ui/stats.js): the hub's entry
// card (the trophies, the LV) and the 卫戍协议：盟约 panel —
//   the name card (头像 with the LV, 名片底图; ui/playerCard.js), 已获奖杯 / 已达成成就, the mode table (总模拟数 /
//   成功卫戍 / 绝境突破 = cleared on 绝境 or 终极), the six 评语 round a hexagon;
//   成就 — ACHIEVEMENTS, each with its progress;
//   卫戍成就 — 战果纪录 (the match whose bond stacked highest: that bond, its layers, the lineup and its top bonds) and the
//     single-match bests of funds spent, promotions and enemies defeated;
//   盟约纪录 — the three bonds most often active, and the operators of the first;
//   策略纪录 — the three strategies most often picked, and those that carry the mark (cleared on 绝境 or 终极 with them).
// The LV is the settlement's (screens/settle.js levelOf over the rows' `reward`). 战果纪录 and 盟约纪录 read lineups and
// bonds, which only the newest FULL_KEEP records keep (ui/stats.js compactRecord). The designer's panel (2026-10-14, second
// package) read an account's records; its login, friends, import and likes are left out. Nothing is sent anywhere; the
// trophy count and the 头像 travel with room.card (display only). Styles: css/screens/lobby.css (.hub-ach / .ach*).
import { useEffect, useMemo, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTIES } from '../../../shared/constants.js';
import { html, Icon, MicroLabel, doctorNo } from './components.js';
import { Img, BandIcon, BondGlyph, UnitThumb, useGameData } from './gameComponents.js';
import { chessAvatarUrl } from './assetUrls.js';
import { data } from '../data.js';
import { peekStatsRecords, aggregateStats, countsTowardStats, selfRowOf, roundsOf, FULL_KEEP } from './stats.js';
import { TrophyBadge } from './trophies.js';
import { NameCardLayer, NameCardPicker } from './namecards.js';
import { useMyCard, trophyTotal, setCardBackground, setCardAvatar, setCardFace } from './playerCard.js';
import { cardOperators, cardAvatarUrl } from './seatArt.js';
import { AvatarPicker } from './opPicker.js';
import { Emblem } from './emblem.js';
import { OpCard, levelOf } from '../screens/settle.js';
import { t, N_ } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];

const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('zh-CN') : '0');

/**
 * The numbers the achievements read, from the stats records (only the records that count, ui/stats.js
 * countsTowardStats; the trophies from every settled record).
 * @param {any[]} records
 */
export function progressOf(records) {
  const all = Array.isArray(records) ? records : [];
  const agg = aggregateStats(all);
  const modes = { solo: { games: 0, wins: 0, best: 0 }, coop: { games: 0, wins: 0, best: 0 } };
  for (const rec of all.filter(countsTowardStats)) {
    const m = modes[rec.roomMode];
    if (!m) continue;
    const self = selfRowOf(rec);
    m.games++;
    if (self ? self.victory : rec.victory) m.wins++;
    const r = Number.isFinite(self?.roundsPassed) ? self.roundsPassed : rec.roundsPassed;
    if (Number.isFinite(r)) m.best = Math.max(m.best, r);
  }
  const winsAt = (d) => agg.byDifficulty[d]?.wins || 0;
  return {
    agg, modes, trophies: trophyTotal(all),
    games: agg.count, wins: agg.wins, hours: agg.duration.totalMs / 3.6e6,
    clears: Object.fromEntries(DIFFICULTIES.map((d) => [d, winsAt(d)])),
    hidden: agg.hidden.cleared, hiddenAbyss: agg.byDifficulty.ABYSS?.hiddenCleared || 0,
    bandKinds: Object.keys(agg.bands).length, titleKinds: Object.keys(agg.titles).length,
    sums: agg.sums,
  };
}

/**
 * The achievements (the owner reviews this list; 2026-10-14 first draft): `value(p)` reads progressOf, reached at `goal`.
 * Groups: 模拟经历 / 胜利 / 难度 / 同盟 / 策略 / 战斗 / 奖杯.
 */
export const ACHIEVEMENTS = Object.freeze([
  { id: 'games_1', group: 'career', name: N_('初次模拟'), desc: N_('完成 1 场模拟'), goal: 1, value: (p) => p.games },
  { id: 'games_10', group: 'career', name: N_('例行演练'), desc: N_('完成 10 场模拟'), goal: 10, value: (p) => p.games },
  { id: 'games_50', group: 'career', name: N_('久经推演'), desc: N_('完成 50 场模拟'), goal: 50, value: (p) => p.games },
  { id: 'games_200', group: 'career', name: N_('卫戍常驻'), desc: N_('完成 200 场模拟'), goal: 200, value: (p) => p.games },
  { id: 'hours_10', group: 'career', name: N_('长时值守'), desc: N_('累计模拟 10 小时'), goal: 10, value: (p) => Math.floor(p.hours) },
  { id: 'wins_1', group: 'victory', name: N_('初战告捷'), desc: N_('取得 1 场胜利'), goal: 1, value: (p) => p.wins },
  { id: 'wins_20', group: 'victory', name: N_('屡战屡胜'), desc: N_('取得 20 场胜利'), goal: 20, value: (p) => p.wins },
  { id: 'wins_100', group: 'victory', name: N_('百战不殆'), desc: N_('取得 100 场胜利'), goal: 100, value: (p) => p.wins },
  { id: 'clear_FUNNY', group: 'difficulty', name: N_('标准达成'), desc: N_('在标准模拟中获胜'), goal: 1, value: (p) => p.clears.FUNNY },
  { id: 'clear_NORMAL', group: 'difficulty', name: N_('险境突破'), desc: N_('在险境模拟中获胜'), goal: 1, value: (p) => p.clears.NORMAL },
  { id: 'clear_HARD', group: 'difficulty', name: N_('绝境求生'), desc: N_('在绝境模拟中获胜'), goal: 1, value: (p) => p.clears.HARD },
  { id: 'clear_ABYSS', group: 'difficulty', name: N_('终极考验'), desc: N_('在终极模拟中获胜'), goal: 1, value: (p) => p.clears.ABYSS },
  { id: 'hidden_1', group: 'difficulty', name: N_('触及核心'), desc: N_('击破隐秘核心 1 次'), goal: 1, value: (p) => p.hidden },
  { id: 'hidden_10', group: 'difficulty', name: N_('核心猎手'), desc: N_('击破隐秘核心 10 次'), goal: 10, value: (p) => p.hidden },
  { id: 'hidden_abyss', group: 'difficulty', name: N_('深渊之底'), desc: N_('在终极模拟中击破隐秘核心'), goal: 1, value: (p) => p.hiddenAbyss },
  { id: 'coop_10', group: 'alliance', name: N_('同盟战友'), desc: N_('完成 10 场同盟模拟'), goal: 10, value: (p) => p.modes.coop.games },
  { id: 'coop_wins_10', group: 'alliance', name: N_('同盟凯歌'), desc: N_('同盟模拟获胜 10 场'), goal: 10, value: (p) => p.modes.coop.wins },
  { id: 'solo_wins_10', group: 'alliance', name: N_('独当一面'), desc: N_('独立模拟获胜 10 场'), goal: 10, value: (p) => p.modes.solo.wins },
  { id: 'bands_10', group: 'strategy', name: N_('博采众长'), desc: N_('使用过 10 种不同的策略'), goal: 10, value: (p) => p.bandKinds },
  { id: 'bands_25', group: 'strategy', name: N_('运筹帷幄'), desc: N_('使用过 25 种不同的策略'), goal: 25, value: (p) => p.bandKinds },
  { id: 'titles_6', group: 'strategy', name: N_('评语收藏家'), desc: N_('获得全部 6 种评语'), goal: 6, value: (p) => p.titleKinds },
  { id: 'kills_1000', group: 'combat', name: N_('千军辟易'), desc: N_('累计击倒 1,000 名敌人'), goal: 1000, value: (p) => p.sums.kills || 0 },
  { id: 'kills_20000', group: 'combat', name: N_('万夫莫当'), desc: N_('累计击倒 20,000 名敌人'), goal: 20000, value: (p) => p.sums.kills || 0 },
  { id: 'boss_1m', group: 'combat', name: N_('领袖克星'), desc: N_('累计对领袖造成 1,000,000 伤害'), goal: 1_000_000, value: (p) => p.sums.bossDamage || 0 },
  { id: 'perfect_50', group: 'combat', name: N_('完美作战'), desc: N_('累计 50 回合完美作战'), goal: 50, value: (p) => p.sums.perfectRounds || 0 },
  { id: 'merges_200', group: 'combat', name: N_('精英集结'), desc: N_('累计晋升干员 200 次'), goal: 200, value: (p) => p.sums.merges || 0 },
  { id: 'trophy_10', group: 'trophy', name: N_('崭露头角'), desc: N_('累计获得 10 个奖杯（奖杯等级 2）'), goal: 10, value: (p) => p.trophies },
  { id: 'trophy_30', group: 'trophy', name: N_('声名鹊起'), desc: N_('累计获得 30 个奖杯（奖杯等级 3）'), goal: 30, value: (p) => p.trophies },
  { id: 'trophy_60', group: 'trophy', name: N_('威名远扬'), desc: N_('累计获得 60 个奖杯（奖杯等级 4）'), goal: 60, value: (p) => p.trophies },
  { id: 'trophy_100', group: 'trophy', name: N_('卫戍传奇'), desc: N_('累计获得 100 个奖杯（奖杯等级 5）'), goal: 100, value: (p) => p.trophies },
]);

export const ACHIEVEMENT_GROUPS = Object.freeze([
  ['career', N_('模拟经历'), 'hourglass'], ['victory', N_('胜利'), 'crown'], ['difficulty', N_('难度'), 'rook'],
  ['alliance', N_('同盟'), 'users'], ['strategy', N_('策略'), 'book'], ['combat', N_('战斗'), 'sword'], ['trophy', N_('奖杯'), 'crown'],
]);

/** Each achievement with its value, done flag and fraction. */
export function achievementsOf(progress) {
  return ACHIEVEMENTS.map((a) => {
    const v = Math.max(0, Number(a.value(progress)) || 0);
    return { ...a, current: Math.min(v, a.goal), done: v >= a.goal, frac: Math.min(1, v / a.goal) };
  });
}

/** 绝境突破 / the strategy mark: a clear on these difficulties. */
const HARD_UP = new Set(['HARD', 'ABYSS']);
/** The hexagon's 评语, clockwise from the top (the official order). */
export const HEX_TITLES = ['comment_4', 'comment_5', 'comment_6', 'comment_1', 'comment_2', 'comment_3'];

/**
 * The designer's records (any order): the experience (the LV), the mode table, the 评语 counts, 战果纪录, the
 * single-match bests, the bonds and strategies played most and the marked strategies. `hiddenLayers(bondId)`: a bond
 * whose layers the game never shows (bonds.json noStack) cannot be the 战果纪录.
 * @param {any[]} records
 * @param {{ hiddenLayers?: (bondId: string) => boolean }} [o]
 */
export function achievementStats(records, { hiddenLayers = () => false } = {}) {
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const out = {
    exp: 0, bestRound: 0,
    modes: { solo: { games: 0, wins: 0, hard: 0 }, coop: { games: 0, wins: 0, hard: 0 } },
    titles: {}, best: null, maxima: { gold: 0, merges: 0, kills: 0 },
    topBonds: [], topBands: [], markedBands: [],
  };
  const bonds = new Map();
  const bands = new Map();
  const marked = new Set();
  for (const rec of Array.isArray(records) ? records : []) {
    const self = rec ? selfRowOf(rec) : null;
    if (!self) continue;
    out.exp += Math.max(0, num(self.reward));
    if (!countsTowardStats(rec)) continue;
    out.bestRound = Math.max(out.bestRound, roundsOf(rec));
    const won = !!self.victory;
    const hardWin = won && HARD_UP.has(rec.difficulty);
    const mode = out.modes[rec.roomMode];
    if (mode) { mode.games++; if (won) mode.wins++; if (hardWin) mode.hard++; }
    const tid = self.title?.id;
    if (tid) out.titles[tid] = (out.titles[tid] || 0) + 1;
    const st = self.stats || {};
    for (const k of ['gold', 'merges', 'kills']) if (num(st[k]) > out.maxima[k]) out.maxima[k] = st[k];
    if (self.bandId) {
      bands.set(self.bandId, (bands.get(self.bandId) || 0) + 1);
      if (hardWin) marked.add(self.bandId);
    }
    for (const b of Array.isArray(self.bonds) ? self.bonds : []) {
      if (!b || !b.bondId) continue;
      if (b.active) bonds.set(b.bondId, (bonds.get(b.bondId) || 0) + 1);
      const layers = num(b.layers);
      if (layers > 0 && !hiddenLayers(b.bondId) && (!out.best || layers > out.best.layers)) out.best = { rec, self, bondId: b.bondId, layers };
    }
  }
  const top = (map) => [...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3);
  out.topBonds = top(bonds).map(([bondId, games]) => ({ bondId, games }));
  out.topBands = top(bands).map(([bandId, games]) => ({ bandId, games }));
  out.markedBands = [...marked];
  return out;
}

/** The operators of a bond (plain chess, one per operator), by tier. */
export function bondOperators(chessList, bondId) {
  const seen = new Set();
  return (Array.isArray(chessList) ? chessList : [])
    .filter((c) => c && !c.isGolden && c.visible !== false && !c.isHidden && !c.isDiy && Array.isArray(c.bonds) && c.bonds.includes(bondId))
    .sort((a, b) => (a.tier - b.tier) || ((a.shopSortId ?? 0) - (b.shopSortId ?? 0)))
    .filter((c) => { const k = c.charId || c.chessId; if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * The 战果纪录's bonds beside the lineup: that match's bonds (active ones first, then by layers), at most six — the
 * 2×3 grid of the reference. `noStack(bondId)`: a bond whose layers the game never shows prints a dash.
 */
export function recordBonds(list, noStack = () => false) {
  return (Array.isArray(list) ? list : [])
    .filter((b) => b && b.bondId && (b.active || Number(b.layers) > 0))
    .map((b) => ({ bondId: b.bondId, active: !!b.active, layers: Math.max(0, Number(b.layers) || 0), hidden: noStack(b.bondId) }))
    .sort((a, b) => (b.active - a.active) || ((b.hidden ? -1 : b.layers) - (a.hidden ? -1 : a.layers)))
    .slice(0, 6);
}

/** This browser's records, read when a component mounts and again when the page comes back (they change between matches). */
function useRecords() {
  const [records, setRecords] = useState(() => peekStatsRecords());
  useEffect(() => {
    const again = () => { if (document.visibilityState !== 'hidden') setRecords(peekStatsRecords()); };
    document.addEventListener('visibilitychange', again);
    return () => document.removeEventListener('visibilitychange', again);
  }, []);
  return records;
}
const noHidden = () => false;

/** The low hills behind the entry card's emblem (original drawing). */
function Land() {
  return html`<svg class="hub-ach__land" viewBox="0 0 320 88" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <rect width="320" height="88" fill="#d7a35a" />
    <path d="M0 52 C40 40 70 58 110 46 S180 30 220 44 S290 56 320 40 V88 H0z" fill="#b97a34" />
    <path d="M0 66 C50 58 90 74 140 64 S230 54 270 66 S310 72 320 68 V88 H0z" fill="#8a5420" />
  </svg>`;
}

/** The hub's 成就统计 card: the trophies, the LV; opens the panel. */
export function AchievementEntry({ onOpen }) {
  const card = useMyCard();
  const records = useRecords();
  const trophies = card.trophies ?? trophyTotal(records);
  const lv = useMemo(() => levelOf(achievementStats(records).exp).lv, [records]);
  return html`<button type="button" class="hub-ach" onClick=${onOpen} aria-haspopup="dialog" title=${t('成就统计：本机的模拟纪录、奖杯与成就')}>
    <span class="hub-ach__scene"><${Land} /><span class="hub-ach__mark"><${Emblem} /></span>
      <span class="hub-ach__rank"><${TrophyBadge} count=${trophies} /><small><${Icon} name="crown" />${fmt(trophies)}</small></span>
    </span>
    <span class="hub-ach__label">${t('成就统计')}<span class="hub-ach__lv num">LV.${lv}</span></span>
  </button>`;
}

// ---- the panel ---------------------------------------------------------------------------------------------------------

/** One achievement mark: the group icon, the name, the description, a bar while it is not reached. */
function Mark({ a, icon }) {
  return html`<div class=${`ach-mark ach-mark--row${a.done ? ' is-done' : ''}`} title=${t(a.desc)}>
    <span class="ach-mark__frame"><${Icon} name=${icon} />${a.done ? html`<span class="ach-mark__badge"><${Icon} name="check" /></span>` : null}</span>
    <span class="ach-mark__text">
      <b>${t(a.name)}</b><small>${t(a.desc)}</small>
      ${a.done ? html`<span class="ach-mark__got">${t('已达成')}</span>`
        : html`<span class="ach-mark__bar" aria-label=${`${fmt(a.current)} / ${fmt(a.goal)}`}><i style=${`width:${(a.frac * 100).toFixed(1)}%`}></i><em class="num">${fmt(a.current)} / ${fmt(a.goal)}</em></span>`}
    </span>
  </div>`;
}

function SectionBar({ title, micro }) {
  return html`<h3 class="ach-bar">
    <span class="ach-bar__icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 3h12v3h3v3a5 5 0 0 1-5 5h-.4A5 5 0 0 1 13 16.6V19h4v2H7v-2h4v-2.4A5 5 0 0 1 8.4 14H8a5 5 0 0 1-5-5V6h3zm0 5H5v1a3 3 0 0 0 1.4 2.5A5 5 0 0 1 6 10zm12 0v2a5 5 0 0 1-.4 1.5A3 3 0 0 0 19 9V8zM12 5.6l.9 1.9 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2-1.5-1.4 2-.3z" fill-rule="evenodd" /></svg></span>
    <span class="ach-bar__title">${title}</span>
    <span class="ach-bar__marks" aria-hidden="true"><i><${Icon} name="rook" /></i><i><svg viewBox="0 0 24 24"><path d="M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z" fill="none" stroke="currentColor" stroke-width="2" /></svg></i>
      <${MicroLabel} class="ach-bar__micro">STRONGHOLD PROTOCOL<br />${micro}<//></span>
  </h3>`;
}

/**
 * The six 评语 round a hexagon of six solid triangles (gaps between them, the outer corners cut, a ruler along each
 * outer edge, a dark hub). Exported for the tests: the segment paths are plain geometry.
 */
export function hexSegments(R = 172) {
  const pt = (deg, r) => [Math.cos((deg * Math.PI) / 180) * r, Math.sin((deg * Math.PI) / 180) * r];
  const mix = (p, q, u) => [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u];
  const r1 = (p) => p.map((v) => Math.round(v * 10) / 10);
  return HEX_TITLES.map((id, i) => {
    const a = -90 + i * 60;
    const n = pt(a, 1); // outward normal of the outer edge
    const off = (p, d) => [p[0] + n[0] * d, p[1] + n[1] * d];
    const p1 = pt(a - 30, R), p2 = pt(a + 30, R);
    // the gaps: each triangle shrunk towards its centroid; then the hub corner and the two outer corners cut
    const g = [(p1[0] + p2[0]) / 3, (p1[1] + p2[1]) / 3];
    const s = (p) => [g[0] + (p[0] - g[0]) * 0.93, g[1] + (p[1] - g[1]) * 0.93];
    const [C, P1, P2] = [s([0, 0]), s(p1), s(p2)];
    const poly = [mix(C, P1, 0.12), mix(C, P1, 0.93), mix(P1, P2, 0.06), mix(P1, P2, 0.94), mix(C, P2, 0.93), mix(C, P2, 0.12)];
    // the ruler: a line inside the outer edge and ticks reaching towards it (every fourth one longer)
    const e1 = off(mix(P1, P2, 0.12), -14), e2 = off(mix(P1, P2, 0.88), -14);
    const ticks = Array.from({ length: 17 }, (_, j) => { const q = mix(e1, e2, j / 16); return [r1(q), r1(off(q, j % 4 === 0 ? 9 : 5))]; });
    return { id, i, points: poly.map((p) => r1(p).join(',')).join(' '), rule: [r1(e1), r1(e2)], ticks };
  });
}
const HEX = hexSegments();
const seg = ([p, q], key) => html`<line key=${key} x1=${p[0]} y1=${p[1]} x2=${q[0]} y2=${q[1]} />`;

function TitleHex({ titles, gd }) {
  const recs = Array.isArray(gd.config?.titles) ? gd.config.titles : [];
  const pt = (deg, r) => [Math.cos((deg * Math.PI) / 180) * r, Math.sin((deg * Math.PI) / 180) * r];
  return html`<div class="ach-hex">
    <span class="ach-hex__cap" aria-hidden="true"><i></i>STRONGHOLD PROTOCOL<small></small></span>
    <svg class="ach-hex__svg" viewBox="-300 -240 600 480" aria-hidden="true">
      ${HEX.map((h) => html`<g key=${h.id} class="ach-hex__seg" style=${`--i:${h.i}`}>
        <polygon points=${h.points} />
        <g class="ach-hex__ticks">${seg(h.rule, 'rule')}${h.ticks.map(seg)}</g>
      </g>`)}
      <circle class="ach-hex__hub" r="15" />
    </svg>
    ${HEX_TITLES.map((id, i) => {
      const [x, y] = pt(-90 + i * 60, 222);
      const rec = recs.find((r) => r.id === id);
      return html`<span key=${id} class="ach-hex__label" style=${`left:calc(50% + ${(x / 600) * 100}%);top:calc(50% + ${(y / 480) * 100}%);--i:${i}`} title=${rec?.text || ''}>
        <b class="num">${titles[id] || 0}</b><span>${rec?.name || id}</span></span>`;
    })}
  </div>`;
}

/** The name card (头像 with the LV, the name, DOCTOR #, 名片底图) and the counts beside it. */
function Plate({ me, card, s, p, done, total, gd, onAvatar, onBg }) {
  const lv = levelOf(s.exp);
  const opRec = card.charId && gd.ready ? gd.list('chess').find((c) => c.charId === card.charId) : null;
  // 头像 (room.card avatar + its 精一/精二/皮肤 变体, 项目 5), else the 名片干员's avatar, else the name's first letter
  const face = cardAvatarUrl(card.avatar, gd.m, card.face) || (opRec ? chessAvatarUrl(gd.m, opRec) : null);
  return html`<div class="ach-plate">
    <div class=${cx('ach-card', card.bg && 'has-nc')}>
      <${NameCardLayer} card=${card.bg} />
      <button type="button" class="ach-card__ava" onClick=${onAvatar} title=${t('更换头像')} aria-label=${t('更换头像')}>
        <${Img} src=${face} alt="" fallback=${html`<span class="ach-card__glyph">${[...(me?.name || '?')][0]}</span>`} />
        <span class="ach-card__lv" title=${t('等级')}><b class="num">${lv.lv}</b><small>LV</small></span></button>
      <span class="ach-card__who">
        <span class="ach-card__name">${me?.name || t('博士')}</span>
        <span class="ach-card__id num">${me?.playerId != null ? `DOCTOR #${doctorNo(me.playerId)}` : 'DOCTOR'}</span>
        <span class="ach-card__edits">
          <button type="button" class="ach-card__nc" onClick=${onAvatar}><${Icon} name="edit" />${t('头像')}</button>
          <button type="button" class="ach-card__nc" onClick=${onBg}><${Icon} name="edit" />${t('名片底图')}</button>
        </span>
      </span>
      <span class="ach-card__brand" aria-hidden="true">STRONGHOLD<br />PROTOCOL</span>
    </div>
    <div class="ach-counts">
      <span class="ach-counts__badge is-trophy"><${TrophyBadge} count=${p.trophies} /></span>
      <span class="ach-counts__row" title=${s.bestRound ? t('最高回合 {n}', { n: s.bestRound }) : ''}><small><${Icon} name="crown" />${t('已获奖杯')}</small><b class="num">${fmt(p.trophies)}</b></span>
      <span class="ach-counts__badge"><${Icon} name="check" /></span>
      <span class="ach-counts__row"><small>${t('已达成成就')}</small><b class="num">${done}<small> / ${total}</small></b></span>
    </div>
  </div>`;
}

function ModeTable({ modes }) {
  const row = (key, icon, label) => html`<div class="ach-modes__row">
    <span class="ach-modes__mode"><${Icon} name=${icon} /><b>${label}</b></span>
    <span class="ach-modes__cell"><b class="num">${fmt(modes[key].games)}</b><small>${t('总模拟数')}</small></span>
    <span class="ach-modes__cell"><b class="num">${fmt(modes[key].wins)}</b><small>${t('成功卫戍')}</small></span>
    <span class="ach-modes__cell" title=${t('在绝境模拟或终极模拟中成功卫戍')}><b class="num">${fmt(modes[key].hard)}</b><small>${t('绝境突破')}</small></span>
  </div>`;
  return html`<div class="ach-modes">${row('solo', 'user', t('独立模拟'))}${row('coop', 'users', t('同盟模拟'))}</div>`;
}

function BestRecord({ best, gd }) {
  if (!best) return html`<p class="ach-empty">${t('还没有可展示的战果：完成一局模拟后在这里记录盟约叠加最高的一局')}</p>`;
  const lineup = Array.isArray(best.self.lineup) ? best.self.lineup : [];
  const slots = Array.from({ length: 10 }, (_, i) => lineup[i] || null);
  const bonds = recordBonds(best.self.bonds, (id) => !!gd.bond(id)?.noStack);
  const bond = gd.bond(best.bondId);
  return html`<div class="ach-best">
    <div class="ach-best__left">
      <span class="ach-pill">${t('战果纪录')}<${Icon} name="chevrons" /></span>
      <span class="ach-best__mount">
        <span class="ach-best__glyph" title=${bond?.name || best.bondId}><${BondGlyph} bondId=${best.bondId} /></span>
        <span class="ach-best__label">${t('盟约最高叠加')}</span>
        <b class="ach-best__num num">${best.layers}</b>
        <i class="ach-best__wire" aria-hidden="true"></i>
      </span>
    </div>
    <div class="ach-best__lineup">
      <div class="ach-best__rows">
        <div class="ach-best__row">${slots.slice(0, 5).map((u, i) => html`<${OpCard} key=${i} u=${u} gd=${gd} i=${i} />`)}</div>
        <div class="ach-best__row">${slots.slice(5).map((u, i) => html`<${OpCard} key=${i} u=${u} gd=${gd} i=${i + 5} />`)}</div>
      </div>
      <div class="ach-best__bonds">${bonds.map((b, i) => html`<span key=${b.bondId} class=${cx('sbond', b.active && 'is-on')} style=${`--i:${i}`} title=${gd.bond(b.bondId)?.name || b.bondId}>
        <span class="sbond__disc"><${BondGlyph} bondId=${b.bondId} /></span><b class="num">${b.hidden ? '—' : b.layers}</b></span>`)}</div>
    </div>
  </div>`;
}

function Maxima({ maxima }) {
  const box = (cls, label, v, glyph) => html`<div class=${cx('ach-max', cls)}>
    <span class="ach-max__label">${label}</span><b class="ach-max__num"><small>x</small><span class="num">${fmt(v)}</span></b>
    <svg class="ach-max__glyph" viewBox="0 0 48 48" aria-hidden="true"><path d=${glyph} /></svg>
  </div>`;
  return html`<div class="ach-maxima">
    ${box('is-gold', t('单局最多消耗资金:'), maxima.gold, 'M24 3 33 13 24 23 15 13zM12 21l9 10-9 10-9-10zM36 21l9 10-9 10-9-10z')}
    ${box('is-orange', t('单局最多晋级次数:'), maxima.merges, 'M4 22 16 10l8 8 8-8 12 12-5 5-7-7-8 8-8-8-7 7zM4 38l12-12 8 8 8-8 12 12-5 5-7-7-8 8-8-8-7 7z')}
    ${box('is-mint', t('单局最多击败数:'), maxima.kills, 'M6 4h8l10 13L34 4h8L28 22l16 18-6 5-14-15-14 15-6-5 16-18z')}
  </div>`;
}

function BondRecord({ topBonds, gd }) {
  if (!topBonds.length) return html`<p class="ach-empty">${t('暂无盟约记录')}</p>`;
  const ops = bondOperators(data.list('chess'), topBonds[0].bondId);
  return html`<div class="ach-list">
    <p class="ach-sub">${t('最常使用的盟约:')}</p>
    <div class="ach-tops">${topBonds.map((b, i) => html`<div key=${b.bondId} class="ach-top ach-top--bond" title=${t('{n} 局中激活', { n: b.games })}>
      <span class="ach-top__frame"><i class="ach-top__rank">TOP${i + 1}</i><${BondGlyph} bondId=${b.bondId} /></span>
      <b class="ach-top__name">${gd.bond(b.bondId)?.name || b.bondId}</b></div>`)}</div>
    ${ops.length ? html`<p class="ach-sub">${t('盟约下干员为:')}</p>
      <div class="ach-ops">${ops.map((c) => html`<span key=${c.chessId} class=${cx('ach-op', `sop--t${c.tier}`)} title=${c.name}>
        <${UnitThumb} kind="chess" id=${c.chessId} size="md" showTier=${false} /><b class="ach-op__tier">${ROMAN[c.tier] || ''}</b></span>`)}</div>` : null}
  </div>`;
}

function BandRecord({ topBands, marked, gd }) {
  if (!topBands.length) return html`<p class="ach-empty">${t('暂无策略记录')}</p>`;
  const name = (id) => gd.band(id)?.name || id;
  return html`<div class="ach-list">
    <p class="ach-sub">${t('最常使用的策略:')}</p>
    <div class="ach-tops ach-tops--band">${topBands.map((b, i) => html`<div key=${b.bandId} class="ach-top ach-top--band">
      <span class="ach-top__frame"><i class="ach-top__rank">TOP${i + 1}</i><${BandIcon} bandId=${b.bandId} size="lg" /></span>
      <span class="ach-top__side"><b class="ach-top__name">${name(b.bandId)}</b><span class="ach-top__count"><small>x</small><b class="num">${b.games}</b></span></span></div>`)}</div>
    <p class="ach-sub" title=${t('用该策略在绝境模拟或终极模拟中成功卫戍')}>${t('已获得特殊标识的策略:')}</p>
    ${marked.length ? html`<div class="ach-marks">${marked.map((id) => html`<div key=${id} class="ach-mark">
      <span class="ach-mark__frame"><${BandIcon} bandId=${id} size="lg" /><i class="ach-mark__badge" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M8 1.5 14 13H2zM8 6v3.6M8 11v.6" fill="none" stroke="currentColor" stroke-width="1.8" /></svg></i></span>
      <b>${name(id)}</b></div>`)}</div>` : html`<p class="ach-empty">${t('在绝境模拟或终极模拟中成功卫戍，所用策略会获得特殊标识')}</p>`}
  </div>`;
}

/** The diamond loader stays at least this long, so a panel whose data is already in does not flash it. */
const LOADER_MIN_MS = 260;

/**
 * The 卫戍协议：盟约 panel (local data; Esc / ✕ / the backdrop close it): the blurred lobby with the diamond loader until
 * the game data is in (names, icons), then the panel fades in (the reference clip's order).
 */
export function AchievementPanel({ me, onClose }) {
  const gd = useGameData();
  const card = useMyCard();
  const records = useRecords();
  const hidden = useMemo(() => (gd.ready ? (id) => !!gd.bond(id)?.noStack : noHidden), [gd.ready]);
  const p = useMemo(() => progressOf(records), [records]);
  const s = useMemo(() => achievementStats(records, { hiddenLayers: hidden }), [records, hidden]);
  const list = useMemo(() => achievementsOf(p), [p]);
  const cardList = useMemo(() => (gd.ready ? cardOperators(gd.list('chess')) : []), [gd.ready]);
  const [picking, setPicking] = useState(null); // 'bg' | 'avatar'
  const [closing, setClosing] = useState(false);
  const [shown, setShown] = useState(false);
  const opened = useMemo(() => Date.now(), []);
  const close = () => { if (closing) return; setClosing(true); setTimeout(onClose, 180); };
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !picking) close(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [picking, closing]);
  useEffect(() => {
    // the lobby chat steps aside while a hub dialog is open (as for the lobby's other dialogs)
    document.body.classList.add('hub-dialog-open');
    return () => document.body.classList.remove('hub-dialog-open');
  }, []);
  useEffect(() => {
    if (!gd.ready || shown) return undefined;
    const id = setTimeout(() => setShown(true), Math.max(0, LOADER_MIN_MS - (Date.now() - opened)));
    return () => clearTimeout(id);
  }, [gd.ready, shown]);
  const done = list.filter((a) => a.done).length;
  const icons = Object.fromEntries(ACHIEVEMENT_GROUPS.map(([g, , icon]) => [g, icon]));
  return html`<div class=${cx('ach', closing && 'is-closing')} role="presentation" onMouseDown=${(e) => { if (e.target === e.currentTarget) close(); }}>
    ${!shown ? html`<span class="ach__loader" role="status" aria-label=${t('读取中')}><i></i><i></i><b></b></span>` : html`
    <div class="ach__box" role="dialog" aria-modal="true" aria-label=${t('成就统计')}>
      <header class="ach__head">
        <span class="ach__logo"><svg viewBox="0 0 40 30" aria-hidden="true"><path d="M8 4h10v8H8zM22 4h10v8H22zM8 18h10v8H8zM22 18h10v8H22z" fill="none" stroke="currentColor" stroke-width="2.4" /><path d="M2 2v26M38 2v26" stroke="currentColor" stroke-width="2" /></svg>
          <b>STRONGHOLD<br />PROTOCOL</b></span>
        <span class="ach__band">
          <svg class="ach__dunes" viewBox="0 0 300 40" preserveAspectRatio="none" aria-hidden="true">
            <path class="is-far" d="M0 24c28-7 58-13 92-9s56 11 90 4 64-14 118-7V40H0z" /><path d="M0 34c34-9 60-12 96-6s52 9 86 3 70-11 118-5V40H0z" /></svg>
          <span class="ach__emblem"><${Emblem} /></span>
          <span class="ach__titles"><i aria-hidden="true">ALLIANCE</i><b>${t('卫戍协议：盟约')}</b></span>
        </span>
      </header>
      <div class="ach__body">
        <section class="ach-top-area">
          <div class="ach-top-area__left">
            <${Plate} me=${me} card=${card} s=${s} p=${p} done=${done} total=${list.length} gd=${gd}
              onAvatar=${() => cardList.length && setPicking('avatar')} onBg=${() => setPicking('bg')} />
            <${ModeTable} modes=${s.modes} />
          </div>
          <${TitleHex} titles=${s.titles} gd=${gd} />
        </section>

        <${SectionBar} title=${t('成就')} micro="ACHIEVEMENTS" />
        ${ACHIEVEMENT_GROUPS.map(([g, label]) => html`<div key=${g} class="ach-list">
          <p class="ach-sub">${t(label)}</p>
          <div class="ach-marks ach-marks--list">${list.filter((a) => a.group === g).map((a) => html`<${Mark} key=${a.id} a=${a} icon=${icons[g]} />`)}</div>
        </div>`)}

        <${SectionBar} title=${t('卫戍成就')} micro="RECORDS" />
        <${BestRecord} best=${s.best} gd=${gd} />
        <${Maxima} maxima=${s.maxima} />
        <${SectionBar} title=${t('盟约纪录')} micro="BONDS" />
        <${BondRecord} topBonds=${s.topBonds} gd=${gd} />
        <${SectionBar} title=${t('策略纪录')} micro="STRATEGIES" />
        <${BandRecord} topBands=${s.topBands} marked=${s.markedBands} gd=${gd} />
        <p class="ach-local"><${Icon} name="info" />${t('成就统计只读取本机的统计数据，不会上传；换浏览器或清除数据后会重新开始，可在「统计数据」里导出、导入。')}
          ${t('战果纪录与盟约纪录只统计最近 {n} 局的详细记录。', { n: FULL_KEEP })}</p>
      </div>
      <button type="button" class="ach__close" onClick=${close} aria-label=${t('关闭')}><${Icon} name="close" /></button>
      <span class="ach__foot">${t('本机记录 · 保存在这台设备的浏览器里 · 每局结束后更新')}</span>
    </div>`}
    ${picking === 'bg' ? html`<${NameCardPicker} current=${card.bg} onPick=${setCardBackground} onClose=${() => setPicking(null)} />` : null}
    ${picking === 'avatar' ? html`<${AvatarPicker} current=${card.avatar} list=${cardList} m=${gd.m} variant=${card.face}
      onPick=${(id, v) => { setCardAvatar(id); setCardFace(v); setPicking(null); }}
      onClose=${() => setPicking(null)} />` : null}
  </div>`;
}
