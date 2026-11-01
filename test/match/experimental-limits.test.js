// The room's experimental battle rules (shared/experimental.js, DESIGN §20.12): disableLayerCap lifts the 999 bond-layer
// cap, disableHitLimit lifts 限伤 (BOSS_HIT_LIMIT). Both ride on the spec as flags, so the match's own writers, the Worker,
// a browser's local replica and the check of a client-run result agree; a room without them keeps every old shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { BOND_LAYER_SAFE_MAX, PHASE, layerGainRoom } from '../../shared/constants.js';
import { Match } from '../../server/match/Match.js';
import { CombatWorkerPool } from '../../server/match/combat/pool.js';
import { CombatEngine } from '../../server/match/combat/engine.js';
import { validateClientResult } from '../../server/match/fields.js';
import { collectViolations } from '../../server/match/invariants.js';
import { snapshotMatch, restoreMatch } from '../../server/match/snapshot.js';
import { createRngFromState } from '../../server/sim/rng.js';
import { isSyncTick, stateHash } from '../../server/sim/syncHash.js';
import * as specMod from '../../server/sim/spec.js';
import { DataSource } from '../../server/sim/simdata.js';
import { DATA, makeMatch, give, legalTileFor } from './harness.js';

const DS = new DataSource(DATA, null);
const QUIET = { info() {}, warn() {}, debug() {}, error() {} };
const clone = (x) => structuredClone(x);
const rules = (o = {}) => ({ revivalEnabled: false, disableSharedPool: false, ...o });
const LIFTED = rules({ disableLayerCap: true, disableHitLimit: true });
const YAN = ['chess_char_6_15_a', 'chess_char_5_12_a', 'chess_char_4_17_a', 'chess_char_3_03_a'];

async function until(predicate, label, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await delay(5);
  }
}

function prepMatch(t, experimental, o = {}) {
  const h = makeMatch({ mode: 'solo', difficulty: 'HARD', seed: 171, fake: true, experimental, ...o }).start();
  t.after(() => h.m.dispose());
  h.toPrep(1);
  const ps = h.ps('p_0');
  ps.layers = {};
  ps.recompute();
  return { h, m: h.m, ps };
}

/** A Match at the boss round's PREP: 炎 boards holding `layers` layers (what the room lets them hold). */
function bossMatch({ experimental = rules(), count = 2, pool = null, speed = 2, layers = 300000, blood = 5e6 } = {}) {
  const m = new Match({
    roomCode: 'LIFT', mode: 'coop', difficulty: 'NORMAL', seed: 733, data: DATA, experimental,
    seats: Array.from({ length: count }, (_, seat) => ({ seat, playerId: `p_${seat}`, name: `P${seat}`, isBot: false, connected: true })),
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
    ps.addLayers('yanShip', layers);
    ps.recompute();
  }
  return m;
}

/** The specs one boss phase hands its Worker. */
function bossPhase(opts) {
  let cfg = null;
  const pool = { create(c) { cfg = c; return { ready: new Promise(() => {}), request: () => new Promise(() => {}), close() {} }; } };
  const m = bossMatch({ ...opts, pool });
  m.startFinalAssault(false);
  m.dispose();
  return { specs: cfg.specs, boss: cfg.boss };
}

test('layerGainRoom uncapped: only the safety bound stops a count; the capped form is unchanged', () => {
  assert.equal(layerGainRoom(995, 10, true), 10);
  assert.equal(layerGainRoom(999, 1, true), 1);
  assert.equal(layerGainRoom(1500, Infinity, true), BOND_LAYER_SAFE_MAX - 1500);
  assert.equal(layerGainRoom(BOND_LAYER_SAFE_MAX - 1, 5, true), 1);
  assert.equal(layerGainRoom(BOND_LAYER_SAFE_MAX, 1, true), 0);
  assert.equal(layerGainRoom(995, 10), 4);
  assert.equal(layerGainRoom(995, 10, false), 4);
  assert.ok(Number.isSafeInteger(BOND_LAYER_SAFE_MAX));
});

test('prep: a gain passes 999 in a room that lifted the cap, views and invariants agree; other rooms stop at 999', (t) => {
  const { m, ps } = prepMatch(t, rules({ disableLayerCap: true }));
  assert.equal(ps.addLayers('yanShip', 1500), 1500);
  assert.equal(ps.addLayers('yanShip', 100), 100);
  assert.equal(ps.privateView().bonds.find((b) => b.bondId === 'yanShip').layers, 1600);
  assert.deepEqual(collectViolations(m), []);
  assert.equal(ps.addLayers('kjeragShip', 5e9), BOND_LAYER_SAFE_MAX, 'the safety bound');
  assert.equal(ps.addLayers('kjeragShip', 1), 0);
  assert.deepEqual(collectViolations(m), []);
  ps.layers.kjeragShip = BOND_LAYER_SAFE_MAX + 1;
  assert.ok(collectViolations(m).some((v) => /kjeragShip layers/.test(v)), 'past the safety bound is still a violation');
  const capped = prepMatch(t, rules());
  assert.equal(capped.ps.addLayers('yanShip', 1500), 999);
});

test('settle: in-battle gains merge past 999 in a room that lifted the cap', (t) => {
  const script = (b) => (b.kind === 'normal' ? { duration: 1, layerGains: { p_0: { yanShip: 50 } } } : {});
  const { h, ps } = prepMatch(t, rules({ disableLayerCap: true }), { script });
  ps.layers.yanShip = 980;
  ps.recompute();
  h.toPrep(2);
  assert.equal(ps.layers.yanShip, 1030);
  h.invariants();
  const capped = prepMatch(t, rules(), { script });
  capped.ps.layers.yanShip = 980;
  capped.ps.recompute();
  capped.h.toPrep(2);
  assert.equal(capped.ps.layers.yanShip, 999);
});

test('client-result check: layerCapOff lifts only the room left under 999, the per-round bound stays', (t) => {
  const { m } = prepMatch(t, rules({ disableLayerCap: true }));
  const spec = (flags) => ({ kind: 'normal', round: 5, timeLimit: 60, spawns: [], flags: { layerGainsEnabled: true, ...flags },
    players: [{ playerId: 'p_0', units: [], bonds: { yanShip: { count: 3, active: true, tier: 1, layers: 990 } } }] });
  const res = (n) => ({ reason: 'cleared', time: 10, perPlayer: { p_0: { killed: 0, total: 0, leaked: [], perfect: true, layerGains: { yanShip: n }, coins: 0, unitsEnd: [], unitStats: [] } } });
  assert.deepEqual(validateClientResult(spec({}), res(10), { gd: m.gd }), { ok: false, reason: 'layer bound' });
  assert.equal(validateClientResult(spec({ layerCapOff: true }), res(10), { gd: m.gd }).ok, true);
  assert.deepEqual(validateClientResult(spec({ layerCapOff: true }), res(81), { gd: m.gd }), { ok: false, reason: 'layer bound' }, '60 + 4·5');
});

test('spec flags: every battle of a room with the rules carries them; other rooms carry neither', (t) => {
  for (const [experimental, flags] of [[LIFTED, { layerCapOff: true, hitLimitOff: true }], [rules({ disableLayerCap: true }), { layerCapOff: true }],
    [rules({ disableHitLimit: true }), { hitLimitOff: true }], [rules(), {}]]) {
    const { h, m, ps } = prepMatch(t, experimental);
    assert.deepEqual(m._ruleFlags(), flags);
    const normal = m._normalOpts(ps).flags;
    assert.deepEqual(normal, { layerGainsEnabled: true, ...m.gd.dp, ...flags });
    const unite = m._uniteOpts({ helpers: [ps], leakers: [ps], leaked: [], notReentered: new Map() }, 60).flags;
    assert.deepEqual(unite, { layerGainsEnabled: false, ...m.gd.dp, ...flags });
    assert.equal(specMod.buildBattleSpec({ ...m._normalOpts(ps), content: 'none', boss: null }).flags.layerCapOff, flags.layerCapOff);
    assert.equal(h.ended, null);
    const boss = bossPhase({ experimental, layers: 10 });
    for (const spec of boss.specs) {
      assert.equal(spec.flags.layerCapOff, flags.layerCapOff); assert.equal(spec.flags.hitLimitOff, flags.hitLimitOff);
    }
  }
});

test('a battle built from the spec follows the flags: layers pass 999, a 300000 hit lands on a leader', () => {
  const { specs: [spec] } = bossPhase({ experimental: LIFTED, layers: 10 });
  const off = clone(spec); delete off.flags.layerCapOff; delete off.flags.hitLimitOff;
  for (const [s, landed, room] of [[spec, 400000, 2], [off, 0, 0]]) {
    const b = specMod.createBattleFromSpec(clone(s), DS, { logger: QUIET });
    for (let i = 0; i < 200 && !b.enemyUnits?.some?.((u) => u.isBoss) && !b.units.some((u) => u.isBoss && u.alive); i++) b.step();
    const leader = b.units.find((u) => u.isBoss && u.alive), op = b.units.find((u) => u.side === 'ally' && u.alive);
    assert.ok(leader && op, 'a leader and an operator');
    assert.equal(b.dealDamage(op, leader, { amount: 400000, type: 'true' }), landed);
    // layer gains are off in a boss field: the rule on the live copy
    b.flags.layerGainsEnabled = true;
    const pid = op.ownerId, live = b.getPlayer(pid);
    live.bonds.yanShip.layers = 998;
    assert.equal(b.addLayers(pid, 'yanShip', 2, 'test'), room === 2 ? 2 : 1);
  }
});

test('checkpoint: the rules and the counts past 999 survive a restore', (t) => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 175, fake: true, experimental: LIFTED }).start();
  t.after(() => h.m.dispose());
  h.toPrep(1);
  h.ps('p_0').addLayers('yanShip', 5000);
  const doc = JSON.parse(JSON.stringify(snapshotMatch(h.m)));
  assert.equal(doc.experimental.disableLayerCap, true); assert.equal(doc.experimental.disableHitLimit, true);
  const r = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seats: doc.seats, seed: doc.seed, experimental: doc.experimental });
  t.after(() => r.m.dispose());
  assert.equal(restoreMatch(r.m, doc, { createRngFromState, log: { warn() {} } }), true);
  assert.equal(r.m.disableLayerCap, true); assert.equal(r.m.disableHitLimit, true);
  assert.deepEqual(r.m._ruleFlags(), { layerCapOff: true, hitLimitOff: true });
  assert.equal(r.m.players.get('p_0').layers.yanShip, 5000);
  assert.deepEqual(collectViolations(r.m), []);
});

/** The Worker side of a boss phase in one engine, every field synced. */
function runEngine({ specs, boss }) {
  const eng = new CombatEngine({ specs, boss, wireFrames: true, coalesceFrames: true, damageBoard: true, snapshotHz: 10, metaOnDemand: true, terminalOnce: true },
    { data: DATA, cloneOutput: false });
  const syncs = new Map(specs.map((s) => [s.fieldId, []])), replies = [];
  for (let i = 0; i < 40000; i++) {
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

test('local replica: a replica of a boss field past both limits gives every Worker digest', { timeout: 120_000 }, () => {
  const phase = bossPhase({ experimental: LIFTED, count: 4 });
  assert.equal(phase.specs.length, 2);
  const w = runEngine(phase);
  for (const spec of phase.specs) {
    assert.ok(w.syncs.get(spec.fieldId).length > 0);
    assert.deepEqual(replica(spec, w.replies), w.syncs.get(spec.fieldId), spec.fieldId);
  }
});

test('real Worker: the same board clears the pool without 限伤 and cannot touch it with it', { timeout: 60_000 }, async (t) => {
  const run = async (experimental) => {
    const pool = new CombatWorkerPool({ size: 1, data: DATA, log: QUIET });
    t.after(() => pool.close());
    await pool.start();
    const m = bossMatch({ experimental, pool, speed: 20 });
    t.after(() => m.dispose());
    m.startFinalAssault(false);
    assert.equal(m.phase, PHASE.FINAL_ASSAULT);
    assert.ok(m.fields[0].remote, 'a Worker field');
    assert.equal(m.fields[0].spec.flags.hitLimitOff, experimental.disableHitLimit);
    await until(() => m.bossPool.hp <= 0 || m.fields[0].battle.time > 40, 'the fight ran');
    return { hp: m.bossPool.hp, max: m.bossPool.maxHp, errors: m.errorCount + m.simErrors };
  };
  const off = await run(LIFTED);
  assert.equal(off.hp, 0, 'single hits past 300000 emptied the pool');
  assert.equal(off.errors, 0);
  const on = await run(rules({ disableLayerCap: true }));
  assert.ok(on.hp > on.max * 0.9, `limit on: hits past the line deal nothing (${on.hp}/${on.max})`);
  assert.equal(on.errors, 0);
});
