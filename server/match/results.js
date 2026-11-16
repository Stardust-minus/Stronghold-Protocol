// server/match/results.js — settlement (RESULT): per-player results, titles (评语), trophies and rewards
// (DESIGN §6.1, research 06 §10.4–§10.6, data/config.json titles/titleRule/trophies/rewards).
//
// roundsPassed (per player): eliminated in round k ⇒ k − 1; alive at the end ⇒ bossRound on a win (+1 when the
// Hidden Core was cleared), bossRound − 1 when the Final Assault was lost. Rewards and trophies follow each player's
// OWN rounds passed (research 06 §6 / §10.4): the Hidden-Core trophy row and a row's `victory` only for the players
// still in at the end — a teammate eliminated (or departed) earlier keeps the table value of its own rounds.
// Titles: every config.titles entry (with data/tuning.json `titles` overrides, gamedata.js) has { stat, rule:
// 'max'|'min', onlyOnWin? }. 'max' titles: candidates are the players with a positive stat, ranked high → low.
// 'min' titles (坚若磐石 "目标生命值损失最少" = least LP lost): every player still alive at the end is a candidate,
// ranked low → high (the eliminated lost everything). Candidates are ranked by the player's rank for that stat
// (0 = best), then by closeness to the best value, then title order, then seat; greedy assignment gives each player
// ≤ 1 title and uses each title ≤ once (config.titleRule [ASSUMED]).
// 规程 (config.titles with the official `type` / `rank` / `point`, act3autochess playerTitleDataDict): 18 评语 = six kinds
// (BOND 盟约层数, KILL 击败数, EQUIP 装备配发, COIN 消耗资金, CHAR 晋升次数, DAMAGE 领袖伤害) × three ranks — regulationTitles.

import { bondList } from './bondsMeta.js';
import { boardOrder } from './board.js';
import { REGULATION_TITLE_CUTOFFS } from './titleCutoffs.js';

const STAT_OF = {
  bossDamage: (ps) => ps.stats.bossDamage,
  activatedLayers: (ps) => ps.activatedLayers(),
  lpRemaining: (ps) => (ps.alive ? Math.max(0, ps.lpAtFinal ?? ps.lp) : 0),
  lpLost: (ps) => Math.max(0, Number(ps.stats.lpLost) || 0),
  merges: (ps) => ps.stats.merges,
  itemsEquipped: (ps) => ps.stats.itemsEquipped,
  fundsSpent: (ps) => ps.stats.gold,
  // 击败数 as 统计数据 counts it: the enemies the player's operators and summons defeated, 联防 included (creditedKills)
  kills: (ps) => (Number.isFinite(ps.creditedKills) ? ps.creditedKills : ps.stats.kills),
};

/** Is this config's 评语 table 规程's: titles of an official kind (playerTitleDataDict `type`)? @param {any[]} titles */
export const isRegulationTable = (titles) => Array.isArray(titles) && titles.some((t) => t && typeof t.type === 'string');

/**
 * One player's value of each 规程 评语 kind — the stat its titles name (config.titles[].stat), a whole number ≥ 0.
 * Shared with tools/title-cutoffs.mjs, which measures the tier lines of server/match/titleCutoffs.js on these values.
 * @param {any[]} titles config.titles (gd.titles) @param {any} ps a PlayerState
 * @returns {Record<string, number>} kind → value
 */
export function regulationValues(titles, ps) {
  const out = {};
  for (const t of titles) {
    if (!t || typeof t.type !== 'string' || Object.hasOwn(out, t.type) || !Object.hasOwn(STAT_OF, t.stat)) continue;
    out[t.type] = Math.max(0, Math.round(Number(STAT_OF[t.stat](ps)) || 0));
  }
  return out;
}

/**
 * The rank (0 / 1 / 2) a value reaches on a kind's tier lines `[rank1, rank2]` (the least value of each rank).
 * @param {number} value @param {readonly number[]|undefined} lines
 */
export function regulationRank(value, lines) {
  if (!Array.isArray(lines)) return 0;
  return value >= lines[1] ? 2 : value >= lines[0] ? 1 : 0;
}

/**
 * How far into its rank a value is, comparable across kinds: rank 0 the way to the rank-1 line, rank 1 the way from it to
 * the rank-2 line, rank 2 past that line in widths of the rank-1 band. (A plain value / line would favour the kinds with a
 * long tail — 领袖伤害 — over the narrow ones — 消耗资金: measured on tools/title-cutoffs.mjs's samples.)
 * @param {number} value @param {readonly number[]} lines @param {number} rank
 */
export function regulationProgress(value, lines, rank) {
  const band = Math.max(1, lines[1] - lines[0]);
  if (rank === 2) return (value - lines[1]) / band;
  if (rank === 1) return (value - lines[0]) / band;
  return value / Math.max(1, lines[0]);
}

/**
 * 规程's 评语 (the owner's decision of 2026-11-16): every player rated on the six kinds, each against its tier lines
 * (server/match/titleCutoffs.js: the server's own play, rank 1 = the top half, rank 2 = the top 15 %), and given the 评语
 * of its best: the highest rank, then the furthest into that rank (regulationProgress), then the official table order.
 * Rank 0 is the consolation 评语 of the kind closest to its first line (point 0: the statistics' hexagon does not count it). [ASSUMED] one 评语 per player per match, as 盟约's (research 06 §10.5), and
 * teammates may share one — the lines are absolute, not a ranking among teammates; the official rule is unpublished.
 * @param {any[]} titles config.titles with `type` / `rank` @param {any[]} players PlayerStates
 * @param {Record<string, readonly number[]>} [cutoffs] kind → [rank1, rank2] (REGULATION_TITLE_CUTOFFS)
 * @returns {Map<string, { id: string, name: string, picId: string, text: string }>}
 */
export function regulationTitles(titles, players, cutoffs = REGULATION_TITLE_CUTOFFS) {
  const kinds = [];
  for (const t of titles) if (t && typeof t.type === 'string' && !kinds.includes(t.type) && cutoffs[t.type]) kinds.push(t.type);
  const out = new Map();
  for (const ps of players) {
    const values = regulationValues(titles, ps);
    let best = null;
    for (const kind of kinds) {
      const lines = cutoffs[kind];
      const v = values[kind] ?? 0;
      const rank = regulationRank(v, lines);
      const rel = regulationProgress(v, lines, rank);
      if (!best || rank > best.rank || (rank === best.rank && rel > best.rel)) best = { kind, rank, rel };
    }
    const t = best && titles.find((x) => x && x.type === best.kind && x.rank === best.rank);
    if (t) out.set(ps.playerId, { id: t.id, name: t.name, picId: t.picId, text: t.text });
  }
  return out;
}

export function assignTitles(gd, players, victory) {
  const titles = Array.isArray(gd.titles) ? gd.titles : Array.isArray(gd.config.titles) ? gd.config.titles : [];
  if (isRegulationTable(titles)) return regulationTitles(titles, players);
  const cands = [];
  titles.forEach((t, ti) => {
    if (!t || typeof t.stat !== 'string' || !Object.hasOwn(STAT_OF, t.stat)) return;
    if (t.onlyOnWin && !victory) return;
    if (t.rule === 'min') {
      const vals = players.filter((ps) => ps.alive).map((ps) => ({ ps, v: Math.max(0, Number(STAT_OF[t.stat](ps)) || 0) }));
      if (!vals.length) return;
      const best = Math.min(...vals.map((x) => x.v));
      const sorted = vals.slice().sort((a, b) => a.v - b.v);
      for (const { ps, v } of vals) cands.push({ ps, t, ti, rank: sorted.findIndex((x) => x.v === v), rel: (best + 1) / (v + 1) });
      return;
    }
    const vals = players.map((ps) => ({ ps, v: Number(STAT_OF[t.stat](ps)) || 0 }));
    const best = Math.max(0, ...vals.map((x) => x.v));
    if (best <= 0) return;
    const sorted = vals.slice().sort((a, b) => b.v - a.v);
    for (const { ps, v } of vals) {
      if (v <= 0) continue;
      const rank = sorted.findIndex((x) => x.v === v);
      cands.push({ ps, t, ti, rank, rel: v / best });
    }
  });
  cands.sort((a, b) => a.rank - b.rank || b.rel - a.rel || a.ti - b.ti || a.ps.seat - b.ps.seat);
  const out = new Map();
  const used = new Set();
  for (const c of cands) {
    if (out.has(c.ps.playerId) || used.has(c.t.id)) continue;
    out.set(c.ps.playerId, { id: c.t.id, name: c.t.name, picId: c.t.picId, text: c.t.text });
    used.add(c.t.id);
  }
  return out;
}

function trophiesFor(gd, roundsPassed, hiddenCleared) {
  const tr = gd.config.trophies;
  if (!tr || gd.isSolo) return 0;
  let n = 0;
  if (Array.isArray(tr.byRoundsPassed)) {
    for (const row of tr.byRoundsPassed) {
      if (roundsPassed <= row.maxRound) { n = Number(row[gd.difficulty]) || 0; break; }
    }
  }
  if (hiddenCleared && tr.hiddenCore && Number.isFinite(tr.hiddenCore[gd.difficulty])) n = tr.hiddenCore[gd.difficulty];
  return n;
}

function rewardFor(gd, roundsPassed) {
  const rw = gd.config.rewards;
  if (!rw || !Array.isArray(rw.baseByRoundsPassed)) return 0;
  const row = rw.baseByRoundsPassed.filter((r) => r.round <= roundsPassed).pop();
  if (!row) return 0;
  const df = (rw.difficultyFactor && rw.difficultyFactor[gd.difficulty]) || 1;
  const mf = (rw.modeFactor && rw.modeFactor[gd.isSolo ? 'SINGLE' : 'MULTI']) || 1;
  return Math.round(row.count * df * mf);
}

/**
 * How the result screen draws a chess of `ps` (a lineup entry, a damage row): its 自选 pick, the stand-in it fielded, the
 * skin it wore.
 *   diy        0.2.0 自选编队: a DIY slot's pick — the result screen names and draws the operator (shared/diy.js diyRecord)
 *   standInFor 0.2.0 补位: a chess this player fielded as its stand-in — the result screen draws the stand-in (the owner's
 *              recall of the official mode, 2026-10-06); the replaced operator's charId, like the sim's UnitInfo
 * @returns {{ diy?: { charId: string, skillIndex: number, uniEquipId: string|null }, standInFor?: string, skinId?: string }}
 */
function pieceLook(ps, chessId) {
  const e = {};
  const pick = typeof ps.diyPickOf === 'function' ? ps.diyPickOf(chessId) : null;
  if (pick) e.diy = { charId: pick.charId, skillIndex: pick.skillIndex, uniEquipId: pick.uniEquipId };
  const si = typeof ps.fieldsStandIn === 'function' && ps.fieldsStandIn(chessId) ? ps.gd.standIn(chessId) : null;
  if (si && si.standInFor) e.standInFor = si.standInFor;
  const chess = ps.gd.chess(chessId);
  const skinId = chess && typeof ps.skinIdFor === 'function' ? ps.skinIdFor(chess) : null;
  if (skinId) e.skinId = skinId;
  return e;
}

/** Operator rows a final scope's damage report keeps per player (a board holds 10; summons are credited to theirs). */
export const BOSS_DAMAGE_OPS = 12;

/**
 * The 领袖战 damage report of one player (feedback #70 「对局记录里可以看到boss战每个干员dps」, #81 「结算页面加入干员伤害统计」):
 * one entry per final scope it fought — 最终攻势 ('boss') and 隐秘核心 ('hidden') — from the server's damage ledger frozen at
 * the scope's end (server/match/damageBoard.js `finals`): `seconds` its battle time (the DPS / HPS divisor), `total` its
 * authoritative damage sum and `healing` its healing, `otherDamage` / `otherHealing` what no operator owns (devices), and
 * `ops` its operators (summons credited to their operator) by damage, at most BOSS_DAMAGE_OPS. Whole numbers but `seconds`
 * (0.1 s). Compact — m.result goes out once per member (and into the end receipt, server/cluster/receipts.js, 2 MiB):
 * zero amounts but `total` / an op's `damage` are left out, and an op names how it is drawn (pieceLook: 自选 pick, stand-in,
 * skin) only when the row's lineup has no entry of its chess id (the page takes the lineup entry's; `lineupIds`).
 * Empty for a browser-run match (clientCombat: the ledger is not authoritative there) and for a player that fought no final
 * scope.
 * @param {Set<string>} [lineupIds] the chess ids of the row's lineup
 * @returns {Array<{ kind: 'boss'|'hidden', round: number, seconds: number, total: number, healing?: number,
 *   otherDamage?: number, otherHealing?: number, ops: Array<{ id: string, damage: number, healing?: number }> }>}
 */
export function bossDamageRows(m, ps, lineupIds = new Set()) {
  const finals = !m.clientCombat && m.damageBoard?.finals;
  if (!finals || typeof finals !== 'object') return [];
  const n = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  const some = (k, v) => (n(v) ? { [k]: n(v) } : {});
  const out = [];
  for (const kind of ['boss', 'hidden']) {
    const packet = finals[kind];
    const row = Array.isArray(packet?.owners) ? packet.owners.find((o) => o?.playerId === ps.playerId) : null;
    if (!row || !(row.seconds > 0)) continue;
    const ops = (Array.isArray(row.operators) ? row.operators : [])
      .filter((op) => typeof op?.defId === 'string' && ps.gd.chess(op.defId))
      .map((op) => ({ id: op.defId, damage: n(op.damage), ...some('healing', op.healing), ...(lineupIds.has(op.defId) ? {} : pieceLook(ps, op.defId)) }))
      .sort((a, b) => b.damage - a.damage || (b.healing || 0) - (a.healing || 0))
      .slice(0, BOSS_DAMAGE_OPS);
    out.push({ kind, round: Number.isInteger(packet.round) ? packet.round : 0, seconds: Math.round(row.seconds * 10) / 10,
      total: n(row.total), ...some('healing', row.healing), ...some('otherDamage', row.otherDamage), ...some('otherHealing', row.otherHealing), ops });
  }
  return out;
}

/**
 * One player's m.result row: `roundsPassed` its own (eliminated in round k ⇒ k − 1), `cleared` whether the team's clear
 * counts for it, `title` its 评语 (assignTitles) or null.
 */
function resultRow(m, ps, { roundsPassed, cleared, hiddenCleared, title }) {
  const gd = m.gd;
  const lineup = boardOrder(ps.board).filter((x) => x.piece.kind === 'chess').map(({ r, c, piece }) => (
    { id: piece.id, golden: gd.isGolden(piece.id), tier: gd.tierOf(piece.id), row: r, col: c, items: (piece.items || []).map((i) => i.id), ...pieceLook(ps, piece.id) }));
  const damage = bossDamageRows(m, ps, new Set(lineup.map((e) => e.id)));
  return {
    playerId: ps.playerId,
    seat: ps.seat,
    name: ps.name,
    isBot: ps.isBot,
    ...(Number.isInteger(ps.aiTakeoverRound) ? { aiTakeoverRound: ps.aiTakeoverRound } : {}),
    left: ps.left,
    alive: ps.alive,
    victory: cleared,
    roundsPassed,
    creditedKills: ps.creditedKills,
    eliminatedRound: ps.eliminatedRound,
    lp: Math.max(0, ps.lp),
    bandId: ps.bandId,
    lineup,
    bonds: bondList(gd, ps.bonds).filter((b) => b.active || b.layers > 0),
    stats: {
      dmgDealt: Math.round(ps.stats.dmgDealt), kills: ps.stats.kills, leaks: ps.stats.leaks, gold: ps.stats.gold,
      refreshes: ps.stats.refreshes, merges: ps.stats.merges, itemsEquipped: ps.stats.itemsEquipped,
      bossDamage: Math.round(ps.stats.bossDamage), activatedLayers: ps.activatedLayers(), lpLost: ps.stats.lpLost,
      perfectRounds: ps.stats.perfectRounds,
    },
    // the operators' damage / healing of each final scope the player fought (feedback #70 / #81), absent otherwise
    ...(damage.length ? { damage } : {}),
    title: m.test === true || Number.isInteger(ps.aiTakeoverRound) ? null : title,
    trophies: m.test === true || Number.isInteger(ps.aiTakeoverRound) ? 0 : trophiesFor(gd, roundsPassed, cleared && hiddenCleared),
    reward: m.test === true || Number.isInteger(ps.aiTakeoverRound) ? 0 : rewardFor(gd, roundsPassed),
  };
}

/**
 * @param {import('./Match.js').Match} m
 * @param {{ victory: boolean, hiddenReached: boolean, hiddenCleared: boolean, reason: string }} outcome
 */
export function buildResult(m, outcome) {
  const gd = m.gd;
  const { victory, hiddenReached, hiddenCleared } = outcome;
  const players = [...m.players.values()].sort((a, b) => a.seat - b.seat);
  const titles = assignTitles(gd, players.filter(ps => !Number.isInteger(ps.aiTakeoverRound)), victory);
  const teamRounds = victory ? gd.bossRound + (hiddenCleared ? 1 : 0) : Math.max(0, Math.min(m.round, gd.bossRound) - 1);
  const rows = players.map((ps) => {
    const roundsPassed = !ps.alive && ps.eliminatedRound != null ? Math.max(0, ps.eliminatedRound - 1) : teamRounds;
    // the team's clear counts for the players still in; an eliminated / departed teammate did not pass the boss round
    return resultRow(m, ps, { roundsPassed, cleared: victory && ps.alive, hiddenCleared, title: titles.get(ps.playerId) ?? null });
  });
  const out = {
    t: 'm.result',
    victory,
    roundsPassed: teamRounds,
    hiddenReached,
    hiddenCleared,
    reason: outcome.reason,
    // the merged Final Assault pool (null before round 14); players[].lp are the alive players' shares of it
    teamLp: m.teamLp != null ? Math.max(0, Math.round(m.teamLp)) : null,
    modeId: m.modeId,
    difficulty: m.difficulty,
    stageId: m.stageId,
    // a non-default official version's match (DESIGN §35.23): its registry id — the page records and draws the settlement
    // with that version even when it never saw the room (the lobby's replay after a kick / grace timeout); absent for
    // the default, so its result stays byte-identical
    ...(m.version ? { version: m.version } : {}),
    bossId: m.bossId,
    hiddenBossId: m.hiddenBossId,
    seed: m.seed,
    durationMs: Math.max(0, m.sched.now() - m.startedAt),
    players: rows,
  };
  // A test match is marked on the settlement the replay stores. The keys are absent otherwise, so a normal
  // result stays byte-identical. Test results award nothing and are never persisted by the client.
  if (m.test === true) {
    out.test = true;
    out.testActions = m.testActions | 0;
    if (m.testReplayable === false) out.testReplayable = false;
  }
  return out;
}

/**
 * The 个人战报 of a human eliminated while the match goes on (feedback #111 「阵亡之后可以出模拟中断结算的界面吗」): built
 * at the elimination (Match._finalizeDeath), before its board returns to the pool (PlayerState.eliminate), as the
 * m.result row it will get at the end (rounds passed = round − 1, no clear, the same trophies and reward) — but with its
 * lineup and bonds of that moment (the end's row lists an empty board for it) and without a 评语 (assignTitles ranks every
 * player at the end). m.private `out` carries it to that player only; the match's m.result follows when the match ends.
 * @param {import('./Match.js').Match} m
 * @param {any} ps the PlayerState, still holding its board
 * @param {number} round the round it is eliminated in
 */
export function buildOutResult(m, ps, round) {
  const gd = m.gd;
  const roundsPassed = Math.max(0, Math.min(round, gd.bossRound) - 1);
  const row = { ...resultRow(m, ps, { roundsPassed, cleared: false, hiddenCleared: false, title: null }), alive: false, victory: false, eliminatedRound: round, lp: 0 };
  return {
    provisional: true,
    victory: false,
    roundsPassed,
    hiddenReached: false,
    hiddenCleared: false,
    reason: 'eliminated',
    modeId: m.modeId,
    difficulty: m.difficulty,
    stageId: m.stageId,
    ...(m.version ? { version: m.version } : {}),
    bossId: m.bossId,
    hiddenBossId: m.hiddenBossId,
    seed: m.seed,
    durationMs: Math.max(0, m.sched.now() - m.startedAt),
    players: [row],
  };
}
