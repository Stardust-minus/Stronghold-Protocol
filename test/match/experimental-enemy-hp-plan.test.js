// 敌人生命倍率 by round (feedback #118, rel27; shared/experimental.js enemyHpPlan): segments "from round N on ×M" replace the
// room's single HP multiplier, with its scope (every enemy, the leader's shared pool). A round's multiplier rides on its
// battles' spec flags (Match.enemyHpMulAt, combat.js _ruleFlags) and sizes that round's leader pool (bossRounds.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../../server/match/Match.js';
import { snapshotMatch, restoreMatch } from '../../server/match/snapshot.js';
import { createRngFromState } from '../../server/sim/rng.js';
import { validateC2S } from '../../shared/protocol.js';
import {
  ENEMY_HP_PLAN_MAX, ENEMY_HP_PLAN_ROUND_MAX, canonicalEnemyHpPlan, enemyHpMulAt, experimentalKey, experimentalOptions, experimentalRuleChanged,
  isEnemyHpPlan, isExperimental, sameExperimental,
} from '../../shared/experimental.js';
import { DATA, makeMatch, give, legalTileFor } from './harness.js';

const QUIET = { info() {}, warn() {}, debug() {}, error() {} };
const rules = (o = {}) => ({ revivalEnabled: false, disableSharedPool: false, ...o });
const seats = (count) => Array.from({ length: count }, (_, seat) => ({ seat, playerId: `p_${seat}`, name: `P${seat}`, isBot: false, connected: true }));
const YAN = ['chess_char_6_15_a', 'chess_char_5_12_a', 'chess_char_4_17_a', 'chess_char_3_03_a'];
/** The player's example in #118: 1–5 ×1, 6–8 ×1.5, 9 on ×2.5. */
const EXAMPLE = [[1, 1], [6, 1.5], [9, 2.5]];

test('shape: segments from round 1, rounds ascending, listed multipliers, at most six; anything else is refused', () => {
  assert.equal(isEnemyHpPlan(EXAMPLE), true);
  assert.equal(isEnemyHpPlan([[1, 2]]), true, 'one segment is a plan of one multiplier');
  assert.equal(isEnemyHpPlan(Array.from({ length: ENEMY_HP_PLAN_MAX }, (_, i) => [1 + i, 1 + (i % 2)])), true);
  for (const bad of [
    [], null, 'x', { 0: [1, 1] }, [[2, 1], [3, 2]], [[1, 1], [1, 2]], [[1, 1], [5, 2], [4, 3]], [[1, 1], [ENEMY_HP_PLAN_ROUND_MAX + 1, 2]],
    [[1, 1.1]], [[1, '2']], [[1, 1, 1]], [[1]], [[1.5, 1]], [[1, 1], [2.5, 2]], [[1, NaN]],
    Array.from({ length: ENEMY_HP_PLAN_MAX + 1 }, (_, i) => [1 + i, 2]),
  ]) {
    assert.equal(isEnemyHpPlan(bad), false, JSON.stringify(bad));
    assert.equal(isExperimental(rules({ enemyHpPlan: bad })), false, JSON.stringify(bad));
  }
  assert.equal(isExperimental(rules({ enemyHpPlan: EXAMPLE })), true);
  assert.equal(validateC2S({ t: 'room.setExperimental', experimental: rules({ enemyHpPlan: EXAMPLE }) }), null);
  assert.equal(validateC2S({ t: 'room.setExperimental', experimental: rules({ enemyHpPlan: [[2, 1]] }) }), 'bad field experimental');
  assert.equal(validateC2S({ t: 'room.create', mode: 'coop', experimental: rules({ enemyHpPlan: EXAMPLE }) }), null);
  // every optional key at once, the single multiplier and a plan both sent: still a valid input (11 keys); the plan wins
  const all = rules({ playerCapacity: 8, disableDuckLord: true, disableLayerCap: true, disableHitLimit: true, enemyHpMul: 3, enemyAtkMul: 2,
    poolPlan: [0, 0, 0, 0, 1, 1, 1, 1], collabOps: true, enemyHpPlan: EXAMPLE });
  assert.equal(isExperimental(all), true);
  const o = experimentalOptions(all);
  assert.deepEqual(o.enemyHpPlan, EXAMPLE); assert.equal(o.enemyHpMul, undefined, 'the plan replaces the single multiplier');
  assert.equal(isExperimental({ ...o }), true, 'the stored form is a valid input');
});

test('stored form: frozen pairs; a plan of one multiplier is that multiplier, ×1 throughout is nothing', () => {
  const o = experimentalOptions(rules({ enemyHpPlan: EXAMPLE }));
  assert.deepEqual(o, rules({ enemyHpPlan: EXAMPLE }));
  assert.ok(Object.isFrozen(o.enemyHpPlan) && o.enemyHpPlan.every((s) => Object.isFrozen(s)));
  assert.deepEqual(experimentalOptions(rules({ enemyHpPlan: [[1, 2], [5, 2]] })), rules({ enemyHpMul: 2 }));
  assert.deepEqual(experimentalOptions(rules({ enemyHpPlan: [[1, 2]] })), rules({ enemyHpMul: 2 }));
  assert.deepEqual(experimentalOptions(rules({ enemyHpPlan: [[1, 1], [9, 1]] })), rules());
  assert.equal(canonicalEnemyHpPlan([[1, 1], [9, 1]]), null);
  // neighbours may repeat a multiplier (an editor's intermediate step): kept as they came
  assert.deepEqual(experimentalOptions(rules({ enemyHpPlan: [[1, 1], [4, 2], [8, 2]] })).enemyHpPlan, [[1, 1], [4, 2], [8, 2]]);
});

test('key, equality and the rules scope: a plan is its own rule, equal to the same plan only', () => {
  const plan = rules({ enemyHpPlan: EXAMPLE });
  assert.equal(experimentalKey(plan), '00:hpplan1x1,6x1.5,9x2.5');
  assert.equal(experimentalKey(rules({ enemyHpPlan: [[1, 2], [3, 2]] })), '00:hp2', 'one multiplier: the single key');
  assert.equal(experimentalKey(rules({ enemyHpPlan: EXAMPLE, enemyAtkMul: 2 })), '00:hpplan1x1,6x1.5,9x2.5:atk2');
  assert.equal(sameExperimental(plan, rules({ enemyHpPlan: EXAMPLE.map((s) => [...s]) })), true);
  assert.equal(sameExperimental(plan, rules({ enemyHpPlan: [[1, 1], [6, 1.5], [10, 2.5]] })), false);
  assert.equal(sameExperimental(plan, rules({ enemyHpMul: 2.5 })), false);
  assert.equal(sameExperimental(rules({ enemyHpPlan: [[1, 2], [6, 2]] }), rules({ enemyHpMul: 2 })), true);
  assert.equal(sameExperimental(plan, rules()), false);
  assert.equal(experimentalRuleChanged(experimentalOptions(plan)), true, '多人匹配 counts it as a changed rule');
});

test('a round\'s multiplier: the last segment it reached; the single multiplier without a plan', () => {
  const o = experimentalOptions(rules({ enemyHpPlan: EXAMPLE }));
  assert.deepEqual([0, 1, 5, 6, 8, 9, 14, 15].map((r) => enemyHpMulAt(o, r)), [1, 1, 1, 1.5, 1.5, 2.5, 2.5, 2.5]);
  assert.equal(enemyHpMulAt(rules({ enemyHpMul: 3 }), 7), 3);
  assert.equal(enemyHpMulAt(rules(), 7), 1);
  assert.equal(enemyHpMulAt(null, 7), 1);
  assert.equal(enemyHpMulAt(rules({ enemyHpPlan: [[1, 2], [4, 2]] }), 9), 2);
});

test('the match: each round\'s battles carry that round\'s multiplier as their spec flag; the single field stays 1', (t) => {
  const h = makeMatch({ mode: 'solo', difficulty: 'HARD', seed: 21, fake: true, experimental: rules({ enemyHpPlan: [[1, 1], [3, 2], [5, 3]], enemyAtkMul: 1.5 }) }).start();
  t.after(() => h.m.dispose());
  const seen = new Map();
  const orig = h.m.newBattle.bind(h.m);
  h.m.newBattle = (opts, more) => {
    if (opts?.kind === 'normal' && !more?.preview) seen.set(opts.round, { hp: opts.flags?.enemyHpMul ?? 1, atk: opts.flags?.enemyAtkMul ?? 1 });
    return orig(opts, more);
  };
  h.toPrep(6);
  assert.equal(h.m.enemyHpMul, 1, 'no single multiplier under a plan');
  assert.deepEqual([...seen].sort((a, b) => a[0] - b[0]), [
    [1, { hp: 1, atk: 1.5 }], [2, { hp: 1, atk: 1.5 }], [3, { hp: 2, atk: 1.5 }], [4, { hp: 2, atk: 1.5 }], [5, { hp: 3, atk: 1.5 }],
  ]);
  assert.deepEqual(h.m._ruleFlags(), { enemyHpMul: 3, enemyAtkMul: 1.5 }, 'round 6 (the prep of the next fight)');
  assert.equal(h.m.enemyHpMulAt(2), 1);
});

/** A Match at the boss round's PREP (test/match/experimental-enemy-rules.test.js bossMatch). */
function bossMatch({ experimental = rules(), pool = null, blood = 1e6 } = {}) {
  const m = new Match({
    roomCode: 'PLAN', mode: 'coop', difficulty: 'NORMAL', seed: 733, data: DATA, experimental, seats: seats(2),
    send: () => true, broadcast: () => {}, onEnd: () => {}, log: QUIET, timerScale: 0.02, combatSpeed: 2, botRehearsal: 0,
    clientCombat: false, verify: 'off', combatPool: pool, afkRemoveRounds: 0,
  });
  m.phase = 'PREP'; m.round = m.gd.bossRound;
  m.stageId = 'act2autochess_m04'; m.stage = m.gd.stage(m.stageId);
  m.bossId = 'boss_6';
  m.gd.raw = { ...m.gd.raw, bosses: { ...m.gd.raw.bosses, boss_6: { ...m.gd.boss('boss_6'), bloodPoint: { NORMAL: blood } } } };
  for (const ps of m.order) {
    ps.lp = 200; ps.bandId = 'band_bldsk'; ps.round = m.round;
    ps.invalidateDeployMap();
    const used = new Set();
    for (const id of YAN) {
      const at = legalTileFor(m, ps, id, used);
      used.add(`${at[0]},${at[1]}`);
      give(m, ps, id, 'board', at);
    }
    ps.recompute();
  }
  return m;
}
function bossPhase(opts) {
  let cfg = null;
  const pool = { create(c) { cfg = c; return { ready: new Promise(() => {}), request: () => new Promise(() => {}), close() {} }; } };
  const m = bossMatch({ ...opts, pool });
  const round = m.round;
  m.startFinalAssault(false);
  const max = m.bossPool.maxHp;
  m.dispose();
  return { specs: cfg.specs, max, round };
}

test('the leader: its pool and its fields take the boss round\'s segment, once', () => {
  const plain = bossPhase();
  const late = bossPhase({ experimental: rules({ enemyHpPlan: EXAMPLE }) });
  assert.ok(late.round >= 9, `the boss round (${late.round}) is in the last segment`);
  assert.ok(Math.abs(late.max - plain.max * 2.5) <= 1.5, `${late.max} ≈ ${plain.max} × 2.5 (rounded once)`);
  assert.equal(late.specs[0].flags.enemyHpMul, 2.5);
  const early = bossPhase({ experimental: rules({ enemyHpPlan: [[1, 2], [ENEMY_HP_PLAN_ROUND_MAX, 5]] }) });
  assert.equal(early.max, plain.max * 2, 'a segment after the boss round does not reach it');
  assert.equal(early.specs[0].flags.enemyHpMul, 2);
  assert.equal(plain.specs[0].flags.enemyHpMul, undefined);
});

test('checkpoint: the plan survives a restore, and the restored match goes on with it', (t) => {
  const experimental = rules({ enemyHpPlan: EXAMPLE });
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, seed: 713, fake: true, experimental }).start();
  t.after(() => h.m.dispose());
  h.toPrep(2);
  const doc = JSON.parse(JSON.stringify(snapshotMatch(h.m)));
  assert.deepEqual(doc.experimental.enemyHpPlan, EXAMPLE);
  const r = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seats: doc.seats, seed: doc.seed, experimental: doc.experimental });
  t.after(() => r.m.dispose());
  assert.equal(restoreMatch(r.m, doc, { createRngFromState, log: { warn() {} } }), true);
  assert.deepEqual(r.m.experimental.enemyHpPlan, EXAMPLE);
  assert.deepEqual([2, 6, 9].map((n) => r.m.enemyHpMulAt(n)), [1, 1.5, 2.5]);
  assert.equal(r.m.round, 2);
});
