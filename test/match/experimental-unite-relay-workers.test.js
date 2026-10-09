// Actual worker.js / WorkerFieldRunner relay. Narrow deterministic wave fixtures, no fabricated results/forceEnd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Match } from '../../server/match/Match.js';
import { CombatWorkerPool } from '../../server/match/combat/pool.js';
import { WorkerFieldRunner } from '../../server/match/combat/runner.js';
import { collectViolations } from '../../server/match/invariants.js';
import { DATA, makeMatch, give, legalTileFor } from './harness.js';

const quiet = { info() {}, error() {}, warn() {}, debug() {} };
async function pump(h, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `worker relay timed out in ${h.m.phase}/${h.m.unitePlan?.uniteRound}`);
    h.sched.advance(330); await delay(3);
  }
}
async function fixture(t, count = 8, options = {}) {
  const pool = new CombatWorkerPool({ size: 1, data: DATA, log: quiet });
  let h;
  t.after(async () => { h?.m.dispose(); await pool.close(); });
  await pool.start();
  h = makeMatch({ humans: count, experimental: { playerCapacity: options.capacity ?? 20, revivalEnabled: true, disableSharedPool: false },
    instant: false, captureFrames: false, seed: 20261008, spectators: ['observer'] }).start();
  h.toPrep(1); h.setStage('act2autochess_m04');
  const m = h.m;
  for (const p of m.order.slice(1, 5)) give(m, p, 'chess_char_1_19_a', 'board', legalTileFor(m, p, 'chess_char_1_19_a'));
  m.wave = { ...m.wave, timeLimit: options.base ?? 1 };
  if (options.speed != null) m.gameSpeed = options.speed;
  // Only the one empty board receives a slime. Other real fields naturally clear: no substituted perPlayer result.
  m._normalOpts = function(p) {
    const o = Match.prototype._normalOpts.call(this, p);
    return { ...o, spawns: p.seat === 0 ? [{ time: 0, enemyKey: 'enemy_1007_slime', count: 1, interval: 0,
      routeIndex: 0, ownerPlayerId: p.playerId, mods: { hpMul: 10 } }] : [] };
  };
  // Keep terrain, routing, mods, source and carry. Schedule the fixture's real residual near the fixed allocation's
  // end (the old one-second limit used time0), or just after it for unspawned coverage; never fabricate results.
  m._uniteOpts = function(plan, limit) {
    plan.fixtureStartAt = this.sched.now();
    const o = Match.prototype._uniteOpts.call(this, plan, limit);
    return { ...o, spawns: o.spawns.map(s => ({ ...s,
      time: options.delayBoth || options.unspawned && plan.uniteRound === 1 ? limit + 3
        : options.earlyFirst && plan.uniteRound === 1 ? 0 : Math.max(0, limit - 1) })) };
  };
  let settlements = 0;
  const original = m.settle.bind(m);
  m.settle = (...args) => { settlements++; return original(...args); };
  m.combatPool = pool; m.startCombat();
  return { h, m, pool, settlements: () => settlements };
}

test('real oneWorker eight-human relay: natural first leaks to second, fresh session/field IDs, no LP until final, both ledgers/results and reconnect', { timeout: 20000 }, async t => {
  const s = await fixture(t), { h, m, pool } = s;
  const normalRunner = m.runner;
  assert.ok(normalRunner instanceof WorkerFieldRunner);
  const initial = await normalRunner.session.ready;
  assert.equal(initial.fields.length, 8);
  await pump(h, () => m.phase === 'UNITE' && m.unitePlan.uniteRound === 1 && m.runner.ready);
  assert.equal(m._normalAliveCount, 8);
  assert.deepEqual(m.unitePlan.helpers.map(p => p.playerId), ['p_1', 'p_2']);
  assert.equal(m.lastResults.get('p_0').leaked.length, 1);
  for (const p of m.order.slice(1)) {
    assert.equal(m.lastResults.get(p.playerId).perfect, true);
    assert.notEqual(m.lastResults.get(p.playerId).synthetic, true);
  }
  const firstRunner = m.runner, firstField = m.fields[0], firstSession = firstRunner.session;
  const firstOutputs = [];
  const receive = firstRunner._receive.bind(firstRunner);
  firstRunner._receive = (out, ...args) => { firstOutputs.push(structuredClone(out)); return receive(out, ...args); };
  assert.equal(pool.stats().sessions, 1);
  const lpBefore = m.order.map(p => p.lp);
  m.onReconnect('p_1'); m.addSpectator('observer');
  await pump(h, () => m.phase === 'UNITE' && m.unitePlan.uniteRound === 2 && m.runner.ready);
  const secondRunner = m.runner, secondField = m.fields[0];
  assert.ok(firstRunner.done); assert.ok(firstRunner.stopped); assert.equal(firstRunner.session, null);
  assert.notEqual(firstSession.generation, secondRunner.session.generation);
  assert.equal(pool.stats().sessions, 1); assert.equal(pool.stats().ready, 1);
  assert.equal(firstField.fieldId, 'u'); assert.equal(secondField.fieldId, 'u:2');
  assert.notEqual(firstField.spec.battleId, secondField.spec.battleId);
  assert.deepEqual(secondField.players, ['p_3', 'p_4']);
  const first = m._uniteRelay.rounds[0];
  assert.equal(first.result.synthetic, undefined); assert.equal(first.result.reason, 'timeout');
  assert.equal(first.result.perPlayer.p_1.leaked.length, 1, 'real spawned residual, not an unspawned or invented normal leak');
  assert.equal(first.result.perPlayer.p_1.leaked[0].sourcePlayerId, 'p_0');
  assert.equal(first.view.through, 1); assert.equal(secondField.spec.spawns.length, 1);
  assert.equal(secondField.spec.spawns[0].sourcePlayerId, 'p_0');
  assert.equal(secondField.spec.spawns[0].mods.hpMul, 10);
  assert.equal(secondField.spec.stageId, m.stageId); assert.equal(secondField.spec.flags.layerGainsEnabled, false);
  assert.deepEqual(m.order.map(p => p.lp), lpBefore); assert.equal(s.settlements(), 0); assert.equal(m._revival, null);
  const ledgerBeforeLate = m.damageBoard.packet();
  const terminal = firstOutputs.find(o => o.done); assert.ok(terminal);
  firstRunner._receive(terminal); normalRunner._receive(terminal);
  assert.deepEqual(m.damageBoard.packet(), ledgerBeforeLate);
  assert.equal(m.runner, secondRunner); assert.equal(s.settlements(), 0);
  const failed = firstSession.request('state'); await assert.rejects(failed, e => e.code === 'SESSION_CLOSED');
  m.onReconnect('p_3'); m.addSpectator('observer');
  await pump(h, () => h.lastTo('observer', 'm.field')?.fieldId === 'u:2');
  assert.equal(h.lastTo('observer', 'm.public').uniteRound, 2);
  assert.equal(h.lastTo('observer', 'm.private'), null);
  assert.equal(h.lastTo('p_3', 'm.field').fieldId, 'u:2');
  await pump(h, () => m.phase === 'SETTLE');
  assert.equal(s.settlements(), 1); assert.equal(m.order[0].lp, lpBefore[0] - 1);
  assert.equal(m.order[0].stats.lpLost, 1);
  assert.equal(m._uniteRelay.rounds.length, 2);
  assert.deepEqual(m.uniteResultView.rounds.map(r => [r.round, r.fieldId, r.through]), [[1, 'u', 1], [2, 'u:2', 1]]);
  assert.deepEqual(m.uniteResultView.helpers, ['p_1', 'p_2', 'p_3', 'p_4']);
  assert.deepEqual([...m._revival.eligible].sort(), ['p_2', 'p_4']);
  assert.equal(m.damageBoard.fields.size, 10);
  assert.equal(m.damageBoard.packet().status, 'frozen');
  for (const p of m.order.slice(1, 5)) {
    const n = m.lastResults.get(p.playerId), u = m._uniteRelay.rounds.find(r => r.view.helpers.includes(p.playerId)).result.perPlayer[p.playerId];
    assert.equal(p.stats.kills, n.killed + u.killed);
    assert.equal(p.stats.dmgDealt, n.damageDealt + u.damageDealt);
    assert.deepEqual(p.battleLayerGains, {});
  }
  assert.equal(m.simErrors, 0); assert.equal(m.errorCount, 0); assert.deepEqual(collectViolations(m), []);
  const finalLp = m.order.map(p => p.lp), finalLedger = m.damageBoard.packet();
  firstRunner._receive(terminal); secondRunner._receive(terminal);
  assert.deepEqual(m.order.map(p => p.lp), finalLp); assert.deepEqual(m.damageBoard.packet(), finalLedger);
  await pump(h, () => pool.stats().sessions === 0 && pool.stats().pending === 0 && pool.stats().cleanup === 0);
  assert.equal(pool.stats().replacements, 0);
});

test('real oneWorker unspawned first residual preserves actual spawn mods/source through second and does not count as helper leak', { timeout: 15000 }, async t => {
  const { h, m } = await fixture(t, 8, { unspawned: true });
  await pump(h, () => m.phase === 'UNITE' && m.unitePlan.uniteRound === 2 && m.runner.ready);
  const first = m._uniteRelay.rounds[0].result;
  assert.equal(first.reason, 'timeout'); assert.equal(first.unspawned.length, 1);
  assert.equal(first.unspawned[0].time, 153); assert.equal(first.unspawned[0].sourcePlayerId, 'p_0');
  assert.ok(Object.values(first.perPlayer).every(p => p.perfect && p.leaked.length === 0));
  assert.equal(m.fields[0].spec.spawns.length, 1);
  assert.equal(m.fields[0].spec.spawns[0].mods.hpMul, 10);
  assert.equal(m.fields[0].spec.spawns[0].sourcePlayerId, 'p_0');
  await pump(h, () => m.phase === 'SETTLE');
  assert.equal(m.order[0].stats.lpLost, 1);
  assert.deepEqual([...m._revival.eligible].sort(), ['p_1', 'p_2', 'p_4']);
  assert.equal(m.simErrors, 0); assert.equal(m.errorCount, 0);
});

test('real oneWorker seven-human expanded room retains single-round IDs/results and cleanup', { timeout: 15000 }, async t => {
  const s = await fixture(t, 7), { h, m, pool } = s;
  await pump(h, () => m.phase === 'UNITE' && m.runner.ready);
  assert.equal(m._normalAliveCount, 7); assert.equal(m._uniteRelay, null);
  assert.equal(m.unitePlan.uniteRound, undefined); assert.equal(m.fields[0].fieldId, 'u');
  assert.equal(m.publicView().uniteRound, undefined); assert.equal(m.publicView().unite.battleId, undefined);
  await pump(h, () => m.phase === 'SETTLE');
  assert.equal(s.settlements(), 1); assert.equal(m.uniteResultView.rounds, undefined);
  assert.deepEqual(m.uniteResultView.helpers, ['p_1', 'p_2']);
  assert.equal(m.order[0].stats.lpLost, 1); assert.equal(m.simErrors, 0); assert.equal(m.errorCount, 0);
  assert.deepEqual(collectViolations(m), []);
  await pump(h, () => pool.stats().sessions === 0 && pool.stats().pending === 0 && pool.stats().cleanup === 0);
});

for (const [label, options, total] of [
  ['entry twenty then departure', { base: 1, speed: 10 }, 300],
  ['capped original base120', { base: 120, speed: 20, delayBoth: true }, 300],
]) test(`real oneWorker twenty total-budget ${label}: Spec/deadline/public, final LP once, virtual consumption and privacy`, { timeout: 20000 }, async t => {
  const s = await fixture(t, 20, options), { h, m, pool } = s;
  await pump(h, () => m.phase === 'UNITE' && m.unitePlan.uniteRound === 1 && m.runner.ready);
  const first = m.unitePlan, f1 = m.fields[0];
  assert.equal(first.totalBudget, total); assert.equal(first.remainingBudget, total); assert.equal(first.timeLimit, total / 2);
  assert.equal(f1.spec.timeLimit, total / 2); assert.equal(f1.spec.stageId, m.stageId);
  assert.equal(m.deadline - first.fixtureStartAt, Math.round(first.timeLimit / options.speed * 1000));
  assert.equal(m.publicView().unite.gameSpeed, options.speed); assert.equal(m.wave.timeLimit, options.base);
  const before = m.order[0].lp; m.onLeave('p_19'); assert.equal(m._uniteBudget.entryAlive, 20);
  await pump(h, () => m.phase === 'UNITE' && m.unitePlan.uniteRound === 2 && m.runner.ready);
  const second = m.unitePlan, f2 = m.fields[0], result1 = m._uniteRelay.rounds[0].result;
  const spent1 = Math.min(first.timeLimit, result1.time);
  assert.equal(second.timeLimit, 150); assert.equal(second.remainingBudget, total - spent1);
  assert.equal(first.timeLimit + second.timeLimit, 300, 'fixed allocations never carry unused first time');
  assert.equal(second.totalBudget, total); assert.equal(f2.spec.timeLimit, second.timeLimit);
  assert.equal(m.deadline - second.fixtureStartAt, Math.round(second.timeLimit / options.speed * 1000));
  assert.equal(m.order[0].lp, before); assert.equal(s.settlements(), 0);
  const balance = m._uniteBudget.remaining; m._finishUniteField(first, result1, f1); assert.equal(m._uniteBudget.remaining, balance);
  m.addSpectator('observer'); m.onReconnect('p_3'); m.flush(true);
  const pub = h.lastTo('observer', 'm.public');
  assert.equal(pub.unite.timeLimit, second.timeLimit); assert.equal(pub.unite.totalBudget, total);
  assert.equal(pub.unite.remainingBudget, second.remainingBudget); assert.equal(pub.unite.gameSpeed, options.speed);
  assert.equal(h.lastTo('observer', 'm.private'), null);
  await pump(h, () => m.phase === 'SETTLE');
  const result2 = m._uniteRelay.rounds[1].result, spent2 = Math.min(second.timeLimit, result2.time);
  assert.equal(m._uniteBudget.remaining, Math.max(0, total - spent1 - spent2));
  assert.ok(spent1 + spent2 <= total); assert.equal(m._uniteRelay.rounds.length, 2);
  assert.equal(s.settlements(), 1); assert.equal(m.order[0].lp, before - m.uniteResultView.losses.p_0);
  assert.equal(m.order[0].stats.lpLost, m.uniteResultView.losses.p_0);
  assert.equal(new Set(m.uniteResultView.helpers).size, 4); assert.equal(m.wave.timeLimit, options.base);
  if (options.delayBoth) { assert.equal(m._uniteBudget.remaining, 0); assert.equal(m.uniteResultView.losses.p_0, 1); }
  assert.equal(m.simErrors, 0); assert.equal(m.errorCount, 0); assert.deepEqual(collectViolations(m), []);
  await pump(h, () => pool.stats().sessions === 0 && pool.stats().pending === 0 && pool.stats().cleanup === 0);
});

for (const capacity of [8, 12, 16]) test(`real oneWorker capacity${capacity}: both relay Specs allocate fixed150+150 and publish the budget`, { timeout: 15000 }, async t => {
  const { h, m } = await fixture(t, capacity, { capacity });
  await pump(h, () => m.phase === 'UNITE' && m.unitePlan.uniteRound === 1 && m.runner.ready);
  assert.equal(m.fields[0].spec.timeLimit, 150); assert.equal(m.publicView().unite.totalBudget, 300);
  assert.equal(m.publicView().unite.remainingBudget, 300);
  await pump(h, () => m.phase === 'UNITE' && m.unitePlan.uniteRound === 2 && m.runner.ready);
  assert.equal(m.fields[0].spec.timeLimit, 150); assert.equal(m._uniteBudget.total, 300);
  await pump(h, () => m.phase === 'SETTLE'); assert.equal(m.order[0].stats.lpLost, 1);
  assert.equal(m.errorCount, 0); assert.equal(m.simErrors, 0);
});

for (const capacity of [8, 12, 16, 20]) test(`real oneWorker sparse four capacity${capacity}: original single-field qualification and fixed300 survive departure`, { timeout: 15000 }, async t => {
  const { h, m, pool, settlements } = await fixture(t, 4, { capacity });
  await pump(h, () => m.phase === 'UNITE' && m.runner.ready);
  const field = m.fields[0], plan = m.unitePlan;
  assert.equal(m._normalAliveCount, 4); assert.equal(plan.uniteRound, undefined); assert.equal(m._uniteRelay, null);
  assert.equal(field.spec.timeLimit, 300); assert.equal(plan.totalBudget, 300); assert.equal(plan.remainingBudget, 300);
  assert.equal(m.publicView().uniteRound, undefined); assert.equal(m.publicView().unite.totalBudget, 300);
  m.onLeave('p_3'); assert.equal(m._uniteBudget.entryAlive, 4); assert.equal(field.spec.timeLimit, 300);
  await pump(h, () => m.phase === 'SETTLE');
  assert.equal(settlements(), 1); assert.equal(m.order[0].stats.lpLost, 1); assert.equal(m.uniteResultView.rounds, undefined);
  assert.equal(m._uniteBudget.remaining, 0); assert.equal(m.errorCount, 0); assert.equal(m.simErrors, 0);
  await pump(h, () => pool.stats().sessions === 0 && pool.stats().pending === 0 && pool.stats().cleanup === 0);
});

test('real oneWorker early natural first leak: actual elapsed ledger never increases second allocation150', { timeout: 15000 }, async t => {
  const { h, m, settlements } = await fixture(t, 8, { capacity: 8, earlyFirst: true });
  await pump(h, () => m.phase === 'UNITE' && m.unitePlan.uniteRound === 2 && m.runner.ready);
  const first = m._uniteRelay.rounds[0], second = m.unitePlan;
  assert.equal(first.result.synthetic, undefined); assert.ok(first.result.time > 0 && first.result.time < 150);
  const residuals = Object.values(first.result.perPlayer).flatMap(pp => pp.leaked);
  assert.equal(residuals.length, 1); assert.equal(residuals[0].sourcePlayerId, 'p_0', 'real natural residual, not a fabricated timeout result');
  assert.equal(first.plan.timeLimit, 150); assert.equal(second.timeLimit, 150); assert.equal(m.fields[0].spec.timeLimit, 150);
  assert.equal(second.remainingBudget, 300 - first.result.time); assert.ok(second.remainingBudget > second.timeLimit);
  assert.equal(settlements(), 0); assert.equal(m.order[0].stats.lpLost, 0);
  await pump(h, () => m.phase === 'SETTLE'); assert.equal(settlements(), 1); assert.equal(m.order[0].stats.lpLost, 1);
  assert.equal(m._uniteRelay.rounds.length, 2); assert.ok(m._uniteBudget.remaining > 0);
  assert.equal(m.errorCount, 0); assert.equal(m.simErrors, 0);
});

test('real oneWorker all unused helpers lost after entry: no extra field, single settlement and honest metadata', { timeout: 15000 }, async t => {
  const { h, m, settlements } = await fixture(t, 8, { capacity: 12 });
  await pump(h, () => m.phase === 'UNITE' && m.runner.ready);
  const first = m.unitePlan, field = m.fields[0];
  for (const ps of first.relayCandidates) ps.eliminate();
  assert.equal(first.timeLimit, 150); assert.equal(m.publicView().uniteRounds, 1);
  assert.equal(m.publicView().unite.battleId, field.spec.battleId);
  await pump(h, () => m.phase === 'SETTLE');
  assert.equal(settlements(), 1); assert.equal(m._uniteRelay.rounds.length, 1); assert.equal(m._uniteBudget.remaining, 150);
  assert.equal(m.order[0].stats.lpLost, 1); assert.equal(m.errorCount, 0); assert.equal(m.simErrors, 0);
});

test('real oneWorker relay cancellation: queued second generation closes; late first reply cannot finalize another phase', { timeout: 15000 }, async t => {
  const { h, m, pool } = await fixture(t);
  await pump(h, () => m.phase === 'UNITE' && m.unitePlan.uniteRound === 1 && m.runner.ready);
  const first = m.runner;
  await pump(h, () => m.phase === 'UNITE' && m.unitePlan.uniteRound === 2 && m.runner.ready);
  const second = m.runner;
  const session = second.session;
  m.dispose();
  assert.equal(first.session, null); assert.equal(second.stopped, true);
  await assert.rejects(session.request('state'), e => e.code === 'SESSION_CLOSED');
  const lp = m.order.map(p => p.lp), ledger = m.damageBoard.packet();
  first._receive({ ticks: 10000, fields: [], effects: [{ type: 'lpLoss', amount: 1000 }], done: true });
  second._receive({ ticks: 10000, fields: [], effects: [{ type: 'lpLoss', amount: 1000 }], done: true });
  assert.deepEqual(m.order.map(p => p.lp), lp); assert.deepEqual(m.damageBoard.packet(), ledger);
  await pump(h, () => pool.stats().sessions === 0 && pool.stats().pending === 0 && pool.stats().cleanup === 0);
});
