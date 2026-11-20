// ui/eloRecords.js — what the ELO room option (shared/experimental.js isEloRoom, docs/history/0.4.0.md §37.275) reads of
// this browser's own match records (ui/stats.js): per room mode, difficulty and official version (the owner's decision of
// 2026-11-20: each version its own win rate, no fallback; ui/stats.js recordVersion — a record without one played 第二期下半,
// the stats format's own rule), the newest ELO_LIMITS.last records that
// count (countsTowardStats: a settled match, a quit after the first battle; never a test, an AI 托管 or a gameplay-plugin
// match), each as `[won, roundsPassed]` — won: the player's own row's victory (the team won and the player was still in);
// roundsPassed: the rounds the player passed (ui/stats.js roundsOf). Only these lists leave the page — as room.elo
// { rec }, while it is in a room with the option (ui/loadoutSync.js installEloSync) —; the panel (ui/eloPanel.js) and the
// server run shared/elo.js eloSummary on the same list. Pure logic: Node-testable (test/ui/elo-panel.test.js).

import { DIFFICULTIES } from '../../../shared/constants.js';
import { ELO_LIMITS, eloKey } from '../../../shared/elo.js';
import { countsTowardStats, isModdedRecord, recordVersion, recordWon, roundsOf } from './stats.js';

/**
 * room.elo `rec` of a list of records (newest first, as ui/stats.js keeps them): `{ '<mode>:<difficulty>:<version>': [[won,
 * roundsPassed], …] }`, newest first, only the keys that have a record.
 * @param {any[]} records
 * @returns {Record<string, Array<[number, number]>>}
 */
export function eloRecords(records) {
  const out = {};
  for (const rec of Array.isArray(records) ? records : []) {
    if (!countsTowardStats(rec) || isModdedRecord(rec)) continue;
    if ((rec.roomMode !== 'solo' && rec.roomMode !== 'coop') || !DIFFICULTIES.includes(rec.difficulty)) continue;
    const key = eloKey(rec.roomMode, rec.difficulty, recordVersion(rec));
    const list = out[key] || (out[key] = []);
    if (list.length >= ELO_LIMITS.last) continue;
    list.push([recordWon(rec) ? 1 : 0, Math.max(0, Math.min(ELO_LIMITS.rounds, Math.round(roundsOf(rec))))]);
  }
  return out;
}
