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

import { bondList } from './bondsMeta.js';
import { boardOrder } from './board.js';

const STAT_OF = {
  bossDamage: (ps) => ps.stats.bossDamage,
  activatedLayers: (ps) => ps.activatedLayers(),
  lpRemaining: (ps) => (ps.alive ? Math.max(0, ps.lpAtFinal ?? ps.lp) : 0),
  lpLost: (ps) => Math.max(0, Number(ps.stats.lpLost) || 0),
  merges: (ps) => ps.stats.merges,
  itemsEquipped: (ps) => ps.stats.itemsEquipped,
  fundsSpent: (ps) => ps.stats.gold,
};

export function assignTitles(gd, players, victory) {
  const titles = Array.isArray(gd.titles) ? gd.titles : Array.isArray(gd.config.titles) ? gd.config.titles : [];
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
 * One player's m.result row: `roundsPassed` its own (eliminated in round k ⇒ k − 1), `cleared` whether the team's clear
 * counts for it, `title` its 评语 (assignTitles) or null.
 */
function resultRow(m, ps, { roundsPassed, cleared, hiddenCleared, title }) {
  const gd = m.gd;
  const lineup = boardOrder(ps.board).filter((x) => x.piece.kind === 'chess').map(({ r, c, piece }) => {
    const e = { id: piece.id, golden: gd.isGolden(piece.id), tier: gd.tierOf(piece.id), row: r, col: c, items: (piece.items || []).map((i) => i.id) };
    // 0.2.0 自选编队: a DIY slot's pick — the result screen names and draws the operator (shared/diy.js diyRecord)
    const pick = typeof ps.diyPickOf === 'function' ? ps.diyPickOf(piece.id) : null;
    if (pick) e.diy = { charId: pick.charId, skillIndex: pick.skillIndex, uniEquipId: pick.uniEquipId };
    // 0.2.0 补位: a chess this player fielded as its stand-in — the result screen draws the stand-in (the owner's recall
    // of the official mode, 2026-10-06); `standInFor` = the replaced operator's charId, like the sim's UnitInfo
    const si = typeof ps.fieldsStandIn === 'function' && ps.fieldsStandIn(piece.id) ? gd.standIn(piece.id) : null;
    if (si && si.standInFor) e.standInFor = si.standInFor;
    const skinId = typeof ps.skinIdFor === 'function' ? ps.skinIdFor(ps.gd.chess(piece.id)) : null;
    if (skinId) e.skinId = skinId;
    return e;
  });
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
