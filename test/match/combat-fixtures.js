// Real content fixtures for the phase engine and worker transport tests.
import { getData } from '../../server/data.js';
import { buildBattleSpec } from '../../server/sim/spec.js';
import { GEO } from '../../shared/constants.js';
export const DATA = getData();
export const QUIET = { error() {}, warn() {}, info() {} };

export function phase(kind = 'normal') {
  const bossLike = kind === 'boss' || kind === 'hidden';
  const count = kind === 'unite' ? 1 : 2;
  const boss = bossLike ? {
    maxHp: 5000, hp: 5000, teamLp: 6, overtimeApplied: 0,
    combatTimeScale: 2, bossOvertimeAfterReal: 2, bossOvertimeDrainReal: 2,
  } : null;
  const specs = Array.from({ length: count }, (_, i) => buildBattleSpec({
    fieldId: kind === 'normal' ? `n:p${i}` : kind === 'unite' ? 'u' : `b${i + 1}`,
    battleId: `${kind}:${i}`, kind, seed: 9181 + i, modeId: 'mode_multi_normal',
    round: bossLike ? 14 : 2, stageId: 'act1autochess_m01',
    rect: { ...(bossLike ? GEO.BOSS_RECT : kind === 'unite' ? GEO.UNITE_RECT : GEO.NORMAL_RECT) },
    timeLimit: 4, content: 'full', bossId: bossLike ? 'boss_1' : null,
    boss: bossLike ? { poolMax: boss.maxHp, poolHp: boss.hp } : null,
    players: [{
      playerId: `p${i}`, seat: i, side: 'L', colOffset: 0, bandId: 'band_bldsk',
      units: [
        { uid: 1, kind: 'chess', chessId: 'chess_char_3_01_b', row: 9, col: 8, dir: 'RIGHT' },
        { uid: 2, kind: 'chess', chessId: 'chess_char_4_22_b', row: 10, col: 8, dir: 'RIGHT' },
      ], bonds: {}, playerEffects: [],
    }],
    flags: { dpInit: 99, dpMax: 99, startOpCooldown: 0, layerGainsEnabled: !bossLike },
    routes: [{ motion: 'WALK', start: [bossLike ? 2 : 9, 10], end: [bossLike ? 2 : 9, 2], checkpoints: [] }],
    spawns: bossLike ? [
      { time: 0, enemyKey: 'enemy_9013_acstmk', routeIndex: 0, tag: 'boss', count: 1, countInTotal: false },
      { time: 1, enemyKey: 'enemy_1007_slime', routeIndex: 0, count: 2, interval: 1 },
    ] : [
      { time: 0, enemyKey: 'enemy_1007_slime', routeIndex: 0, count: 2, interval: 1, sourcePlayerId: 'leaker' },
      { time: 20, enemyKey: 'enemy_1007_slime', routeIndex: 0, count: 1, sourcePlayerId: 'leaker' },
    ],
  }));
  return { specs, boss };
}

export async function until(predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('test condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
