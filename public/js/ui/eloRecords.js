// ui/eloRecords.js — what the ELO room option (shared/experimental.js isEloRoom, docs/history/0.4.0.md §37.275) reads of
// this browser's own match records (ui/stats.js): per room mode and difficulty, the wins and games of the newest
// ELO_LIMITS.last records that count (countsTowardStats: a settled match, a quit after the first battle; never a test, an
// AI 托管 or a gameplay-plugin match), a win being the player's own row's victory (the team won and the player was still
// in). Only these counts leave the page — as room.elo { rec }, while it is in a room with the option
// (ui/loadoutSync.js installEloSync) —; the server turns them into the player's tilt (shared/elo.js eloTilt).
// Pure logic: Node-testable (test/ui/elo-records.test.js).

import { DIFFICULTIES } from '../../../shared/constants.js';
import { ELO_LIMITS, eloKey } from '../../../shared/elo.js';
import { countsTowardStats, isModdedRecord, recordWon } from './stats.js';

/**
 * room.elo `rec` of a list of records (newest first, as ui/stats.js keeps them): `{ '<mode>:<difficulty>': [wins, games] }`,
 * only the keys that have a record.
 * @param {any[]} records
 * @returns {Record<string, [number, number]>}
 */
export function eloRecords(records) {
  const out = {};
  for (const rec of Array.isArray(records) ? records : []) {
    if (!countsTowardStats(rec) || isModdedRecord(rec)) continue;
    if ((rec.roomMode !== 'solo' && rec.roomMode !== 'coop') || !DIFFICULTIES.includes(rec.difficulty)) continue;
    const key = eloKey(rec.roomMode, rec.difficulty);
    const pair = out[key] || (out[key] = [0, 0]);
    if (pair[1] >= ELO_LIMITS.last) continue;
    pair[1]++;
    if (recordWon(rec)) pair[0]++;
  }
  return out;
}
