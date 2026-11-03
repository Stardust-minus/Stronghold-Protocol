// The room's enemy multipliers (feedback #47, shared/experimental.js ENEMY_MULTIPLIERS) and the six-seat 3 + 3 chess pools
// (feedback #49, server/match/pool.js createPoolGroups). The multipliers ride on the spec as flags and are applied once, in
// spawnEnemy; a leader's HP is the pool, sized by the match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Match } from '../../server/match/Match.js';
import { CombatWorkerPool } from '../../server/match/combat/pool.js';
import { CombatEngine } from '../../server/match/combat/engine.js';
import { createPoolGroups, createItemPools } from '../../server/match/pool.js';
import { bossPoolHp } from '../../server/match/finalAssault.js';
import { collectViolations } from '../../server/match/invariants.js';
import { snapshotMatch, restoreMatch } from '../../server/match/snapshot.js';
import { createRngFromState } from '../../server/sim/rng.js';
import { isSyncTick, stateHash } from '../../server/sim/syncHash.js';
import * as specMod from '../../server/sim/spec.js';
import { DataSource } from '../../server/sim/simdata.js';
import { validateC2S } from '../../shared/protocol.js';
import { ENEMY_MULTIPLIERS, experimentalKey, experimentalOptions, isExperimental, sameExperimental } from '../../shared/experimental.js';
import { DATA, makeMatch, give, legalTileFor } from './harness.js';

const DS = new DataSource(DATA, null);
const QUIET = { info() {}, warn() {}, debug() {}, error() {} };
const clone = (x) => structuredClone(x);
const rules = (o = {}) => ({ revivalEnabled: false, disableSharedPool: false, ...o });
const seats = (count) => Array.from({ length: count }, (_, seat) => ({ seat, playerId: `p_${seat}`, name: `P${seat}`, isBot: false, connected: true }));
const YAN = ['chess_char_6_15_a', 'chess_char_5_12_a', 'chess_char_4_17_a', 'chess_char_3_03_a'];
const ENEMY = Object.keys(DATA.enemies).find((k) => DATA.enemies[k].stats?.maxHp > 0 && DATA.enemies[k].stats?.atk > 0 && !DATA.enemies[k].tokenOnly);

test('shape: ×1 is absent, the listed multipliers are the only legal values, the key names them', () => {
  assert.deepEqual([...ENEMY_MULTIPLIERS], [1, 1.25, 1.5, 2, 2.5, 3, 5]); // 2.5: rel27 (#118 names it)
  assert.deepEqual(Object.keys(experimentalOptions(rules({ enemyHpMul: 1, enemyAtkMul: 1 }))), ['revivalEnabled', 'disableSharedPool']);
  assert.equal(experimentalKey(rules({ enemyHpMul: 1 })), '00');
  assert.equal(sameExperimental(rules({ enemyHpMul: 1 }), rules()), true);
  const both = rules({ disableLayerCap: true, disableHitLimit: true, enemyHpMul: 2, enemyAtkMul: 1.5, playerCapacity: 8, disableDuckLord: true });
  assert.equal(isExperimental(both), true, 'every optional key at once');
  assert.deepEqual(experimentalOptions(both), both);
  assert.equal(experimentalKey(both), '00:8:duck:layers:hits:hp2:atk1.5');
  assert.equal(sameExperimental(rules({ enemyHpMul: 2 }), rules({ enemyHpMul: 3 })), false);
  assert.equal(sameExperimental(rules({ enemyHpMul: 2 }), rules({ enemyAtkMul: 2 })), false);
  for (const v of [0, 0.5, 1.1, 10, '2', null, NaN, Infinity]) {
    assert.equal(isExperimental(rules({ enemyHpMul: v })), false, `hp ${v}`);
    assert.equal(isExperimental(rules({ enemyAtkMul: v })), false, `atk ${v}`);
  }
  assert.equal(validateC2S({ t: 'room.setExperimental', experimental: rules({ enemyHpMul: 5 }) }), null); // was a call that always passed
  assert.equal(validateC2S({ t: 'room.setExperimental', experimental: rules({ enemyHpMul: 4 }) }), 'bad field experimental');
});

test('spec flags: every battle of a room with multipliers carries them; a standard room carries neither', (t) => {
  const h = makeMatch({ mode: 'solo', difficulty: 'HARD', seed: 21, fake: true, experimental: rules({ enemyHpMul: 2, enemyAtkMul: 3 }) }).start();
  t.after(() => h.m.dispose());
  assert.deepEqual(h.m._ruleFlags(), { enemyHpMul: 2, enemyAtkMul: 3 });
  const plain = makeMatch({ mode: 'solo', difficulty: 'HARD', seed: 21, fake: true }).start();
  t.after(() => plain.m.dispose());
  assert.deepEqual(plain.m._ruleFlags(), {});
  assert.equal(plain.m.enemyHpMul, 1); assert.equal(plain.m.enemyAtkMul, 1);
});

/** An enemy of a battle under these flags, spawned with `mods`. */
function spawned(flags, mods = null) {
  const b = specMod.createBattleFromSpec(specMod.buildBattleSpec({ seed: 3, kind: 'normal', modeId: 'mode_multi_normal', round: 3, stageId: 'act2autochess_m04',
    rect: { r0: 0, r1: 8, c0: 0, c1: 16 }, timeLimit: 60, players: [], spawns: [], routes: [], flags }), DS);
  return { b, e: b.spawnEnemy(ENEMY, { pos: [4, 8], mods }) };
}

test('spawnEnemy: every enemy once, over the round mods; mods stay as they came, so a leak or a child is not multiplied twice', () => {
  const mods = { hpMul: 1.5, atkMul: 2, slot: 'x' };
  const base = spawned({}, mods).e;
  const { b, e } = spawned({ enemyHpMul: 2, enemyAtkMul: 3 }, mods);
  assert.equal(e.base.maxHp, base.base.maxHp * 2);
  assert.equal(e.base.atk, base.base.atk * 3);
  assert.equal(e.base.def, base.base.def, 'DEF stays');
  assert.equal(e.hp, e.s.maxHp, 'it starts full');
  assert.deepEqual(e.mods, mods, 'the mods a leak carries into 联防');
  const child = b.spawnEnemy(ENEMY, { pos: [4, 8], mods: e.mods });
  assert.equal(child.base.maxHp, e.base.maxHp, 'an inherited spawn is multiplied once, like its parent');
  const summon = b.spawnEnemy(ENEMY, { pos: [4, 8] });
  assert.equal(summon.base.maxHp, spawned({}).e.base.maxHp * 2, 'a summon without mods takes it too');
  const junk = spawned({ enemyHpMul: 'x', enemyAtkMul: -1 }).e;
  assert.equal(junk.base.maxHp, spawned({}).e.base.maxHp, 'a bad flag counts as 1');
});

/** A Match at the boss round's PREP. */
function bossMatch({ experimental = rules(), pool = null, speed = 2, blood = 5e6 } = {}) {
  const m = new Match({
    roomCode: 'MULT', mode: 'coop', difficulty: 'NORMAL', seed: 733, data: DATA, experimental, seats: seats(2),
    send: () => true, broadcast: () => {}, onEnd: () => {}, log: QUIET, timerScale: 0.02, combatSpeed: speed, botRehearsal: 0,
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

/** The specs one boss phase hands its Worker, and the pool. */
function bossPhase(opts) {
  let cfg = null;
  const pool = { create(c) { cfg = c; return { ready: new Promise(() => {}), request: () => new Promise(() => {}), close() {} }; } };
  const m = bossMatch({ ...opts, pool });
  m.startFinalAssault(false);
  const max = m.bossPool.maxHp;
  m.dispose();
  return { specs: cfg.specs, boss: cfg.boss, max };
}

test('the leader: the pool is multiplied once, the Worker gets it and the flags; its copy on the field shows the pool', () => {
  const plain = bossPhase({ blood: 1e6 }), scaled = bossPhase({ blood: 1e6, experimental: rules({ enemyHpMul: 3, enemyAtkMul: 2 }) });
  assert.equal(scaled.max, plain.max * 3);
  assert.equal(scaled.boss.maxHp, plain.boss.maxHp * 3);
  assert.equal(scaled.specs[0].flags.enemyHpMul, 3); assert.equal(scaled.specs[0].flags.enemyAtkMul, 2);
  assert.equal(plain.specs[0].flags.enemyHpMul, undefined);
  const gd = { boss: () => ({ bloodPoint: { NORMAL: 1000 } }), difficulty: 'NORMAL', bossPoolShare: () => 2 };
  assert.equal(bossPoolHp(gd, 'b', 4), 2000); assert.equal(bossPoolHp(gd, 'b', 4, { hpMul: 1.25 }), 2500);
});

/** The Worker side of a boss phase in one engine, every field synced. */
function runEngine({ specs, boss }) {
  const eng = new CombatEngine({ specs, boss, wireFrames: true, coalesceFrames: true, damageBoard: true, snapshotHz: 10, metaOnDemand: true, terminalOnce: true },
    { data: DATA, cloneOutput: false });
  const syncs = new Map(specs.map((s) => [s.fieldId, []])), replies = [];
  for (let i = 0; i < 40; i++) {
    const o = eng.advance(32, { snapshotFields: [], syncFields: specs.map((s) => s.fieldId) });
    for (const s of o.syncs || []) syncs.get(s.fieldId).push([s.tick, s.h, s.done ? 1 : 0]);
    replies.push({ to: o.ticks, ext: clone(o.ext || []) });
    if (o.done) break;
  }
  eng.dispose();
  return { syncs, replies };
}

/** A browser's local replica of one boss field: its spec with the Worker's pool record. */
function replica(spec, replies) {
  const pool = new specMod.ReplayBossPool(spec.boss.poolMax, spec.boss.poolHp);
  const b = specMod.createBattleFromSpec(clone(spec), DS, { logger: QUIET, sharedBoss: pool });
  const out = [];
  let n = 0;
  for (const r of replies) {
    const x = r.ext.find((e) => e.fieldId === spec.fieldId);
    assert.equal(pool.feed(n, r.to, x ? x.hp : [], x && x.end), true);
    n += x ? x.hp.length : 0;
    if (pool.end && !b.finished && b.tickCount === pool.end.tick) b.forceEnd(pool.end.reason);
    while (!b.finished && b.tickCount < r.to && pool.ready(b.tickCount + 1)) {
      pool.enter(b.tickCount + 1);
      b.step();
      if (isSyncTick(b)) out.push([b.tickCount, stateHash(b), b.finished ? 1 : 0]);
      const end = pool.endAfter(b.tickCount);
      if (end && !b.finished) b.forceEnd(end.reason);
    }
  }
  return out;
}

test('local replica: a replica of a boss field under the multipliers gives every Worker digest', { timeout: 120_000 }, () => {
  const phase = bossPhase({ blood: 1e6, experimental: rules({ enemyHpMul: 2, enemyAtkMul: 3 }) });
  const w = runEngine(phase);
  for (const spec of phase.specs) {
    assert.ok(w.syncs.get(spec.fieldId).length > 0);
    assert.deepEqual(replica(spec, w.replies), w.syncs.get(spec.fieldId), spec.fieldId);
  }
});

test('real Worker: the multipliers reach the Worker battle and the pool', { timeout: 60_000 }, async (t) => {
  const pool = new CombatWorkerPool({ size: 1, data: DATA, log: QUIET });
  t.after(() => pool.close());
  await pool.start();
  const m = bossMatch({ experimental: rules({ enemyHpMul: 2 }), pool, speed: 20, blood: 1e6 });
  t.after(() => m.dispose());
  m.startFinalAssault(false);
  assert.ok(m.fields[0].remote, 'a Worker field');
  const deadline = Date.now() + 30_000;
  while (!(m.fields[0].battle.time > 1)) { assert.ok(Date.now() < deadline, 'the fight ran'); await delay(5); }
  assert.equal(m.errorCount + m.simErrors, 0);
  assert.equal(m.bossPool.maxHp, bossPoolHp(m.gd, 'boss_6', 2, { hpMul: 2 }));
});

for (const [count, sizes, scale] of [[5, [5], 1.25], [6, [3, 3], 1], [7, [4, 3], 1], [8, [4, 4], 1]]) {
  test(`${count} seats in an 8-seat room: chess and equipment pools ${sizes.join(' + ')}, ×${scale}`, (t) => {
    const h = makeMatch({ humans: count, experimental: rules({ playerCapacity: 8 }), seed: 713, fake: true }).start();
    t.after(() => h.m.dispose());
    h.toPrep(1);
    const m = h.m;
    assert.deepEqual(m.poolGroups.map((g) => g.playerIds.length), sizes);
    assert.deepEqual([...new Set(m.poolGroups.map((g) => g.scale))], [scale]);
    assert.equal(new Set(m.order.map((p) => p.pool)).size, sizes.length);
    assert.equal(new Set(m.order.map((p) => m.itemPoolFor(p))).size, sizes.length, 'equipment stock follows');
    assert.deepEqual(m.publicView().poolGroups.map((g) => g.playerIds.length), sizes);
    for (const g of m.poolGroups) for (const [id, e] of g.pool.entries) assert.equal(e.cap, Math.ceil(m.gd.poolCopies(id) * scale), id);
    assert.deepEqual(collectViolations(m), []);
  });
}

test('the other room shapes keep their pools: 20-seat chunks, no shared pool, a four-seat room', () => {
  const gd = makeMatch({ humans: 1, fake: true }).m.gd;
  const six = seats(6);
  assert.deepEqual(createPoolGroups(gd, six, { experimental: true, fixedChunks: true }).map((g) => g.playerIds.length), [4, 2]);
  assert.equal(createPoolGroups(gd, six, { experimental: true, independent: true }).length, 6);
  assert.deepEqual(createPoolGroups(gd, seats(4), { experimental: true }).map((g) => [g.playerIds.length, g.scale]), [[4, 1]]);
  assert.deepEqual(createPoolGroups(gd, six, { experimental: false }).map((g) => [g.playerIds.length, g.scale]), [[6, 1]]);
  const legacy = createPoolGroups(gd, six, { experimental: true, legacySix: true });
  assert.deepEqual(legacy.map((g) => [g.playerIds.length, g.scale]), [[6, 1.5]]);
  assert.deepEqual(createPoolGroups(gd, seats(7), { experimental: true, legacySix: true }).map((g) => g.playerIds.length), [4, 3], 'only six');
  assert.equal(createItemPools(gd, legacy, () => null).size, 6);
});

test('checkpoint: the multipliers survive a restore; 3 + 3 restores as saved, and a saved one-pool six-seat match goes on as it started', (t) => {
  const experimental = rules({ playerCapacity: 8, enemyHpMul: 2, enemyAtkMul: 1.25 });
  const h = makeMatch({ humans: 6, experimental, seed: 713, fake: true }).start();
  t.after(() => h.m.dispose());
  h.toPrep(1);
  const doc = JSON.parse(JSON.stringify(snapshotMatch(h.m)));
  assert.equal(doc.pools.length, 2);
  const restore = (saved) => {
    const r = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seats: saved.seats, seed: saved.seed, experimental: saved.experimental });
    t.after(() => r.m.dispose());
    assert.equal(restoreMatch(r.m, saved, { createRngFromState, log: { warn() {} } }), true);
    return r.m;
  };
  const m = restore(doc);
  assert.deepEqual(m.poolGroups.map((g) => [g.playerIds.length, g.scale]), [[3, 1], [3, 1]]);
  assert.deepEqual(m._ruleFlags(), { enemyHpMul: 2, enemyAtkMul: 1.25 });
  assert.deepEqual(collectViolations(m), []);
  // what rel22 saved: the one pool of all six seats, one equipment debt
  const saved = { ...doc, pools: [doc.pools[0]], itemDebt: [doc.itemDebt[0]] };
  const legacy = restore(saved);
  assert.deepEqual(legacy.poolGroups.map((g) => [g.playerIds.length, g.scale]), [[6, 1.5]]);
  assert.equal(legacy.order.every((p) => p.pool === legacy.poolGroups[0].pool), true);
});
