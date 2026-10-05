// Configured Boss scaling through actual server WorkerFieldRunner / worker.js, not a second transport runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../../server/match/Match.js';
import { CombatWorkerPool } from '../../server/match/combat/pool.js';
import { WorkerFieldRunner, RemoteBattle } from '../../server/match/combat/runner.js';
import { collectViolations } from '../../server/match/invariants.js';
import { DATA, QUIET, until } from './combat-fixtures.js';
import { give, legalTileFor } from './harness.js';

// Small PREP checkpoint using the existing content/placement fixtures; production phase and worker methods run as-is.
async function fixture(t, { count = 3, hidden = false, speed = 2, smallPool = false } = {}) {
  const errors = [], ended = [];
  const log = { ...QUIET, error: (...args) => errors.push(args.map(String).join(' ')) };
  const pool = new CombatWorkerPool({ size: 1, data: DATA, log });
  let m;
  t.after(async () => { m?.dispose(); await pool.close(); });
  await pool.start();
  assert.equal(pool.stats().ready, 1);
  m = new Match({ roomCode: 'SCAL', mode: 'coop', difficulty: 'NORMAL', seed: 731, data: DATA,
    // A living AI participates just like a human; the room spectators never participate.
    seats: Array.from({ length: count }, (_, seat) => ({ seat, playerId: seat > 0 && seat === count - 1 ? 'ai_0' : `p_${seat}`,
      name: `Scaling ${seat}`, isBot: seat > 0 && seat === count - 1, connected: true })),
    spectators: ['observer_0', 'observer_1'],
    send() { return true; },
    broadcast() {}, onEnd: (result) => ended.push(result), log,
    combatPool: pool, clientCombat: false, verify: 'off', combatSpeed: speed, timerScale: 0.02, botRehearsal: 0 });
  m.phase = 'PREP'; m.round = hidden ? m.gd.hiddenRound : m.gd.bossRound;
  m.stageId = 'act2autochess_m04'; m.stage = m.gd.stage(m.stageId);
  m.bossId = 'boss_3'; m.hiddenBossId = 'boss_8'; m.hiddenLayerSum = 0;
  const id = hidden ? m.hiddenBossId : m.bossId;
  if (smallPool) {
    // Only this test checkpoint lowers the base pool for a quick real-content victory; scaling still happens in Match.
    m.gd.raw = { ...m.gd.raw, bosses: { ...m.gd.raw.bosses,
      [id]: { ...m.gd.boss(id), bloodPoint: { NORMAL: 40000 } } } };
  }
  for (const ps of m.order) {
    ps.lp = 40; ps.bandId = 'band_bldsk'; ps.round = m.round;
    ps.invalidateDeployMap(); ps.recompute();
    if (hidden) ps.lpAtFinal = ps.lp;
  }
  if (hidden) { m.hiddenReached = true; m.teamLp = count * 40; }
  return { m, pool, expected: Math.round(m.gd.boss(id).bloodPoint.NORMAL * count / 4), errors, ended };
}

function assertInitial(m, runner, out, expected) {
  assert.ok(runner instanceof WorkerFieldRunner);
  assert.equal(m.combatPool, m.opts.combatPool);
  assert.ok(m.fields.every((f) => f.remote && f.battle instanceof RemoteBattle));
  assert.equal(out.ticks, 0, 'actual worker init reply precedes simulation');
  assert.equal(out.boss.maxHp, expected, 'worker starts with the configured scaled pool');
  assert.equal(out.boss.hp, expected);
  assert.equal(m.bossPool.maxHp, expected, 'main-thread mirror starts with the same HP');
  assert.deepEqual(m.publicView().bossHp, { hp: expected, max: expected });
  for (const f of m.fields) assert.deepEqual(f.spec.boss, { poolHp: expected, poolMax: expected });
  assert.equal(out.frames.length, m.fields.length, 'every field returns its actual startup snapshot');
  for (const frame of out.frames) {
    assert.deepEqual(JSON.parse(frame.snapshotWire).boss, { hp: expected, max: expected }, `${frame.fieldId}: worker snapshot`);
  }
}

for (const hidden of [false, true]) for (const count of [1, 2, 3, 4]) {
  test(`serverWorker ${hidden ? 'hidden' : 'ordinary'} Boss: ${count} living seats start with ${count * 25}% HP`, { timeout: 15_000 }, async (t) => {
    const { m, pool, expected, errors } = await fixture(t, { count, hidden });
    m.startFinalAssault(hidden);
    const runner = m.runner;
    const initial = await runner.session.ready;
    assertInitial(m, runner, initial, expected);
    assert.equal(m.fields.length, Math.ceil(count / 2));
    assert.equal(m.fields.flatMap((f) => f.players).length, count);
    assert.equal(m.spectators.size, 2);
    assert.equal(m.fields.some((f) => f.players.some((pid) => pid.startsWith('observer'))), false);
    assert.deepEqual(collectViolations(m), []);
    m.dispose();
    await until(() => pool.stats().sessions === 0 && pool.stats().pending === 0);
    assert.deepEqual(errors, []);
  });
}

for (const hidden of [false, true]) {
  test(`serverWorker ${hidden ? 'hidden' : 'ordinary'} Boss: two fields debit the scaled pool once, no result re-credit`, { timeout: 20_000 }, async (t) => {
    const { m, pool, expected, errors, ended } = await fixture(t, { hidden, smallPool: true, speed: 200 });
    for (const ps of m.order) for (const id of ['chess_char_4_17_b', 'chess_char_6_18_b', 'chess_char_6_20_b']) {
      const tile = legalTileFor(m, ps, id); assert.ok(tile, `legal tile for ${id}`);
      give(m, ps, id, 'board', tile);
    }
    m.startFinalAssault(hidden);
    const runner = m.runner;
    const outputs = [];
    // Capture actual worker DTOs while keeping the production receiver and its ordered mirror replay unchanged.
    const receive = runner._receive.bind(runner);
    runner._receive = (out, ...args) => { outputs.push(structuredClone(out)); return receive(out, ...args); };
    const initial = await runner.session.ready;
    assertInitial(m, runner, initial, expected);
    const fields = m.fields.slice(), shared = m.bossPool;
    await until(() => runner.done && m.ended, 15_000);
    assert.equal(ended.length, 1);
    assert.equal(m.outcome.victory, true);
    assert.equal(m.outcome.hiddenCleared, hidden);
    assert.equal(shared.maxHp, 30000, 'three seats: 75% of the test-only 40000 base');
    assert.equal(shared.hp, 0);
    const effects = outputs.flatMap((out) => out.effects || []).filter((effect) => effect.type === 'bossDamage');
    assert.ok(effects.length > 1, 'real content produced multiple ordered damage deltas');
    assert.ok(Math.abs(effects.reduce((sum, e) => sum + e.amount, 0) - expected) < 1e-6, 'one shared pool, not a pool per field');
    assert.ok(Math.abs([...shared.byPlayer.values()].reduce((sum, value) => sum + value, 0) - expected) < 1e-6);
    const credit = () => m.order.reduce((sum, p) => sum + p.stats.bossDamage, 0);
    assert.ok(Math.abs(credit() - expected) < 1e-6, 'main-thread effects replay credits the same pool only once');
    let resultDamage = 0;
    for (const f of fields) {
      const result = f.battle.result();
      assert.ok(result && !result.synthetic);
      assert.equal(result.errors, 0);
      assert.deepEqual(f.battle.errors, []);
      const damage = Object.values(result.perPlayer).reduce((sum, pp) => sum + pp.bossDamage, 0);
      assert.ok(damage > 0, `${f.fieldId}: both fields really damaged the leader`);
      resultDamage += damage;
    }
    assert.ok(Math.abs(resultDamage - expected) < 1e-6, 'full field results also account for the same pool exactly once');
    const before = credit();
    m._finishFinal(hidden, (f) => f.battle.result());
    assert.equal(credit(), before, 'a late duplicate settlement cannot debit or credit again');
    assert.equal(shared.hp, 0);
    assert.equal(ended.length, 1);
    assert.equal(m.simErrors, 0); assert.equal(m.errorCount, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(collectViolations(m), []);
    await until(() => pool.stats().sessions === 0 && pool.stats().pending === 0);
  });
}
