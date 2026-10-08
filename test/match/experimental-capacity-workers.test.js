// Capacity regression through real worker.js sessions and production WorkerFieldRunner, not a replacement runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Match } from '../../server/match/Match.js';
import { CombatWorkerPool } from '../../server/match/combat/pool.js';
import { CombatEngine } from '../../server/match/combat/engine.js';
import { WorkerFieldRunner } from '../../server/match/combat/runner.js';
import { collectViolations } from '../../server/match/invariants.js';
import { DATA, makeMatch, give, legalTileFor } from './harness.js';
import { QUIET, phase, until } from './combat-fixtures.js';

const experiment = { revivalEnabled: false, disableSharedPool: false, playerCapacity: 20 };
const seats = count => Array.from({ length: count }, (_, seat) => ({ seat, playerId: `p_${seat}`, name: `Capacity ${seat}`, isBot: false, connected: true }));
async function pump(h, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `worker fixture timed out in ${h.m.phase}`);
    h.sched.advance(33); await delay(3);
  }
}

for (const count of [5, 20]) test(`real Worker: ${count} normal fields persist unwatched layers and reconcile terminal deltas once`, { timeout: 20000 }, async t => {
  const pool = new CombatWorkerPool({ size: 1, data: DATA, log: QUIET });
  let h; t.after(async () => { h?.m.dispose(); await pool.close(); });
  await pool.start();
  // The existing virtual clock drives the REAL worker and actual Match receiver deterministically.
  h = makeMatch({ humans: count, experimental: experiment, instant: false, seed: 8301 }).start();
  h.toPrep(1); h.setStage('act2autochess_m04');
  const m = h.m;
  for (const ps of m.order) {
    for (const id of ['chess_char_2_12_a', 'chess_char_3_12_a', 'chess_char_1_19_a']) {
      const tile = legalTileFor(m, ps, id); assert.ok(tile); give(m, ps, id, 'board', tile);
    }
    ps.layers.kazimierzShip = 10; ps.recompute();
    assert.equal(ps.bonds.kazimierzShip.active, true);
  }
  m.wave = { ...m.wave, spawns: m.wave.spawns.map(s => ({ ...s, time: 20 + (s.time || 0) })) };
  m.combatPool = pool; m.startCombat(); m.watchers.clear();
  const runner = m.runner;
  assert.ok(runner instanceof WorkerFieldRunner);
  const initial = await runner.session.ready;
  assert.equal(initial.fields.length, count); assert.equal(initial.ticks, 0);
  assert.equal(pool.stats().sessions, 1, 'one whole-phase worker session, not one job per field');
  await pump(h, () => m.order.every(ps => ps.layers.kazimierzShip > 10));
  assert.equal(m.phase, 'COMBAT'); assert.ok(m.fields.every(f => f.live));
  const fields = m.fields.slice();
  const before = m.order.map(p => p.layers.kazimierzShip);
  for (const f of fields) m._syncNormalLayers(f, f.battle.layerGains);
  assert.deepEqual(m.order.map(p => p.layers.kazimierzShip), before);
  m.onReconnect(m.order.at(-1).playerId);
  assert.deepEqual(m.order.map(p => p.layers.kazimierzShip), before, 'resync never recredits layers');
  runner.forceAll('timeout');
  await pump(h, () => m.phase === 'SETTLE');
  assert.deepEqual(m.order.map(p => p.layers.kazimierzShip), before, 'full final result accounts only the remaining delta');
  for (const f of fields) {
    assert.ok(f.battle.result()?.perPlayer[f.players[0]]);
    assert.notEqual(f.battle.result().synthetic, true, 'real result, not a fabricated fallback');
    assert.deepEqual(f.battle.errors, []);
  }
  assert.equal(m.errorCount, 0); assert.equal(m.simErrors, 0);
  assert.deepEqual(collectViolations(m), []);
  const ended = h.endedCount;
  const oldTicks = runner.ticks;
  runner._receive({ ticks: oldTicks + 1000, fields: [], effects: [{ type: 'lpLoss', amount: 1000 }], done: true });
  assert.equal(runner.ticks, oldTicks, 'completed runner ignores stale terminal reply');
  assert.equal(h.endedCount, ended);
  m.dispose();
  await until(() => pool.stats().sessions === 0 && pool.stats().pending === 0);
});

async function bossFixture(t, count, { hidden = false, smallPool = false, speed = 2 } = {}) {
  const errors = [], ended = [];
  const log = { ...QUIET, error: (...args) => errors.push(args.map(String).join(' ')) };
  const pool = new CombatWorkerPool({ size: 1, data: DATA, log });
  let m; t.after(async () => { m?.dispose(); await pool.close(); });
  await pool.start();
  m = new Match({ roomCode: 'CAPW', mode: 'coop', difficulty: 'NORMAL', seed: 731, data: DATA,
    seats: seats(count), spectators: ['observer'], experimental: experiment,
    send() { return true; }, broadcast() {}, onEnd: result => ended.push(result), log,
    combatPool: pool, clientCombat: false, verify: 'off', combatSpeed: speed, timerScale: 0.02, botRehearsal: 0 });
  m.phase = 'PREP'; m.round = hidden ? m.gd.hiddenRound : m.gd.bossRound;
  m.stageId = 'act2autochess_m04'; m.stage = m.gd.stage(m.stageId);
  // Neutral counting fixture proves capacity/pool ownership only. The pre-existing 余音 reflection bug is deferred.
  m.bossId = smallPool ? 'boss_1' : 'boss_3'; m.hiddenBossId = 'boss_8'; m.hiddenLayerSum = 0;
  const id = hidden ? m.hiddenBossId : m.bossId;
  if (smallPool) m.gd.raw = { ...m.gd.raw, bosses: { ...m.gd.raw.bosses,
    [id]: { ...m.gd.boss(id), bloodPoint: { NORMAL: 40000 } } } };
  for (const ps of m.order) {
    ps.lp = 40; ps.bandId = 'band_bldsk'; ps.invalidateDeployMap(); ps.recompute();
    if (hidden) ps.lpAtFinal = ps.lp;
  }
  if (hidden) { m.hiddenReached = true; m.teamLp = count * 40; }
  return { m, pool, errors, ended, expected: Math.round(m.gd.boss(id).bloodPoint.NORMAL * count / 4) };
}

for (const hidden of [false, true]) for (const count of [5, 7, 20]) {
  test(`real Worker: ${count} alive ${hidden ? 'hidden' : 'ordinary'} Boss uses <=10 fields and one scaled authority`, { timeout: 15000 }, async t => {
    const { m, pool, errors, expected } = await bossFixture(t, count, { hidden });
    m.startFinalAssault(hidden); const runner = m.runner;
    const initial = await runner.session.ready;
    assert.ok(runner instanceof WorkerFieldRunner);
    assert.equal(initial.boss.maxHp, expected); assert.equal(initial.boss.hp, expected);
    assert.equal(m.bossPool.maxHp, expected);
    assert.equal(m.fields.length, Math.ceil(count / 2));
    assert.equal(m.fields.flatMap(f => f.players).length, count);
    assert.equal(pool.stats().sessions, 1);
    for (const frame of initial.frames) assert.deepEqual(JSON.parse(frame.snapshotWire).boss, { hp: expected, max: expected });
    for (const f of m.fields) assert.deepEqual(f.spec.boss, { poolMax: expected, poolHp: expected });
    assert.equal(m.fields.at(-1).players.length, count % 2 ? 1 : 2);
    assert.deepEqual(collectViolations(m), []);
    // Departure retains the local no-rescale rule; no main-only edit of the worker's HP authority.
    const before = m.bossPool.maxHp;
    m.onLeave(m.order.at(-1).playerId);
    assert.equal(m.bossPool.maxHp, before);
    m.dispose(); await until(() => pool.stats().sessions === 0 && pool.stats().pending === 0);
    assert.deepEqual(errors, []);
  });
}

for (const hidden of [false, true]) {
  test(`real Worker: odd five-seat ${hidden ? 'hidden' : 'ordinary'} Boss debits one pool, once-only effects/results/finish`, { timeout: 20000 }, async t => {
    const { m, pool, errors, ended, expected } = await bossFixture(t, 5, { hidden, smallPool: true, speed: 200 });
    for (const ps of m.order) for (const id of ['chess_char_4_17_b', 'chess_char_6_18_b', 'chess_char_6_20_b']) {
      const tile = legalTileFor(m, ps, id); assert.ok(tile); give(m, ps, id, 'board', tile);
    }
    m.startFinalAssault(hidden); const runner = m.runner, outputs = [];
    const receive = runner._receive.bind(runner);
    runner._receive = (out, ...args) => { outputs.push(structuredClone(out)); return receive(out, ...args); };
    const initial = await runner.session.ready;
    assert.equal(initial.boss.maxHp, expected);
    const fields = m.fields.slice(), shared = m.bossPool;
    assert.deepEqual(fields.map(f => f.players.length), [2, 2, 1]);
    await until(() => runner.done && m.ended, 15000);
    assert.equal(ended.length, 1); assert.equal(m.outcome.victory, true); assert.equal(shared.hp, 0);
    const effects = outputs.flatMap(out => out.effects || []).filter(e => e.type === 'bossDamage');
    assert.ok(effects.length > 1);
    assert.ok(Math.abs(effects.reduce((sum, e) => sum + e.amount, 0) - expected) < 1e-6);
    assert.ok(Math.abs([...shared.byPlayer.values()].reduce((sum, n) => sum + n, 0) - expected) < 1e-6);
    const credit = () => m.order.reduce((sum, ps) => sum + ps.stats.bossDamage, 0);
    assert.ok(Math.abs(credit() - expected) < 1e-6, 'main-thread mirror replays each worker hit once');
    const perField = fields.map(f => {
      const result = f.battle.result(); assert.ok(result?.perPlayer[f.players[0]]); assert.notEqual(result.synthetic, true);
      assert.equal(result.errors, 0, JSON.stringify({ field: f.fieldId, errors: f.battle.errors })); assert.deepEqual(f.battle.errors, []);
      return Object.values(result.perPlayer).reduce((sum, pp) => sum + pp.bossDamage, 0);
    });
    assert.ok(perField[0] > 0 && perField[1] > 0, 'both pair fields contribute to the same HP pool');
    assert.ok(perField[2] >= 0, 'the odd lone field participates, even if pairs deplete HP before its attack');
    assert.ok(Math.abs(perField.reduce((sum, n) => sum + n, 0) - expected) < 1e-6);
    const before = credit(); m._finishFinal(hidden, f => f.battle.result());
    assert.equal(credit(), before); assert.equal(ended.length, 1); assert.equal(shared.hp, 0);
    assert.equal(m.errorCount, 0); assert.equal(m.simErrors, 0); assert.deepEqual(errors, []);
    assert.deepEqual(collectViolations(m), []);
    await until(() => pool.stats().sessions === 0 && pool.stats().pending === 0);
  });
}

function repeated(kind, count) {
  const input = phase(kind);
  input.specs = Array.from({ length: count }, (_, i) => {
    const spec = structuredClone(input.specs[i % input.specs.length]);
    spec.fieldId = `${kind}:${i}`; spec.battleId = `capacity:${kind}:${i}`;
    spec.players[0].playerId = `p${i}`; spec.players[0].seat = i;
    return spec;
  });
  return input;
}

test('engine accepts exactly 20 normal / 10 leader fields; larger, duplicate and malformed phases reject', () => {
  for (const [kind, count] of [['normal', 20], ['boss', 10]]) {
    const engine = new CombatEngine(repeated(kind, count), { data: DATA, log: QUIET });
    assert.equal(engine.fields.length, count);
    if (kind === 'boss') assert.ok(engine.fields.every(f => f.battle.sharedBoss === engine.pool), 'every field uses the same SharedBossPool object');
    engine.dispose();
    assert.throws(() => new CombatEngine(repeated(kind, count + 1), { data: DATA, log: QUIET }), /at most/);
  }
  const duplicate = repeated('normal', 5); duplicate.specs[4].fieldId = duplicate.specs[0].fieldId;
  assert.throws(() => new CombatEngine(duplicate, { data: DATA, log: QUIET }), /unique fieldId/);
  assert.throws(() => new CombatEngine({ specs: null }, { data: DATA, log: QUIET }), /specs/);
  const missing = repeated('boss', 3); missing.boss = null;
  assert.throws(() => new CombatEngine(missing, { data: DATA, log: QUIET }), /shared boss config/);
});

test('real Worker rejects oversized init and retains readiness; cancelled generations cannot accept commands', { timeout: 15000 }, async t => {
  const pool = new CombatWorkerPool({ size: 1, data: DATA, log: QUIET }); t.after(() => pool.close()); await pool.start();
  const bad = pool.create(repeated('normal', 21));
  await assert.rejects(bad.ready, /at most 20/);
  assert.equal(pool.stats().ready, 1);
  const active = pool.create(repeated('normal', 5));
  const initial = await active.ready; assert.equal(initial.fields.length, 5);
  const pending = active.request('advance', { ticks: 32 }); active.close();
  await assert.rejects(pending, e => e.code === 'SESSION_CLOSED');
  await assert.rejects(active.request('state'), e => e.code === 'SESSION_CLOSED');
  await until(() => pool.stats().sessions === 0 && pool.stats().pending === 0 && pool.stats().cleanup === 0 && pool.stats().active === 0);
  assert.equal(pool.stats().replacements, 0);
});
