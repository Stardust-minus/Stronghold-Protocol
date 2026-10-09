// Expanded-capacity unite allocates a fixed 300 game seconds, independent of alive count or normal-wave time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';

const rules = capacity => ({ playerCapacity: capacity, revivalEnabled: false, disableSharedPool: false });
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
function fixture(t, { count = 20, capacity = 20, mode = 'coop', clientCombat = false, base = 60, speed = 2, relay = false } = {}) {
  const h = makeMatch({ humans: count, mode, experimental: rules(capacity), fake: true, instant: false, clientCombat, clients: false, seed: 9017 }).start();
  t.after(() => h.m.dispose()); h.toPrep(1); const m = h.m;
  for (const ps of m.order) ps.lp = 28;
  m.gameSpeed = speed; m.wave = base == null ? null : { ...m.wave, timeLimit: base };
  const plan = { helpers: [m.order[0]], leakers: [m.order.at(-1)], leaked: [{ enemyKey: 'enemy_1007_slime', sourcePlayerId: m.order.at(-1).playerId, mods: null, lpr: 1 }], notReentered: new Map() };
  if (m.capacityExperiment && count >= 8) {
    plan.uniteRound = 1; plan.relayCandidates = relay ? m.order.slice(1, 3) : [];
    m.lastResults = new Map(m.order.map(p => [p.playerId, { perfect: true, leaked: [], unitsEnd: [] }]));
  }
  return { h, m, plan };
}

for (const capacity of [8, 12, 16, 20]) for (const count of [capacity, 4, 1]) for (const base of [60, 17.5, 120, null]) for (const clientCombat of [false, true]) {
  for (const relay of count >= 8 ? [false, true] : [false]) test(`capacity${capacity} ${count} alive, base ${base ?? 'default'}, ${clientCombat ? 'client' : 'inline'}, ${relay ? 'viable relay' : 'single round'}: fixed allocation/Spec/deadline/public`, t => {
    const speed = count === 1 ? 3 : count === 12 ? 4 : 2;
    const { h, m, plan } = fixture(t, { capacity, count, base, speed, clientCombat, relay });
    const total = 300, limit = relay ? 150 : 300;
    const original = m.wave && structuredClone(m.wave);
    m.startUnite(plan); const spec = m.fields[0].spec || m.fields[0].battle.opts;
    assert.equal(spec.timeLimit, limit); assert.equal(plan.timeLimit, limit);
    assert.equal(m._uniteBudget.entryAlive, count); assert.equal(m._uniteBudget.base, base ?? 60);
    assert.deepEqual(m._uniteBudget.allocations, relay ? [150, 150] : [300]);
    assert.equal(m.publicView().unite.timeLimit, limit); assert.equal(m.publicView().unite.totalBudget, total);
    assert.equal(m.publicView().unite.remainingBudget, total); assert.equal(m.publicView().unite.gameSpeed, speed);
    if (count >= 8) {
      assert.equal(m.publicView().uniteRounds, relay ? 2 : 1);
      assert.equal(m.publicView().uniteRound, 1); assert.equal(m.publicView().unite.battleId, spec.battleId);
      assert.ok(spec.battleId, 'honest single-round metadata must retain field admission identity');
    } else assert.equal(m.publicView().uniteRound, undefined, 'sparse rooms retain the original single-field identity shape');
    assert.equal(m.deadline - h.sched.now(), Math.round(limit / speed * 1000));
    if (count > 1) {
      m.onLeave(m.order.at(-1).playerId);
      assert.equal(m.publicView().unite.timeLimit, limit); assert.equal(spec.timeLimit, limit);
      assert.equal(m._uniteBudget.total, total); assert.equal(m._uniteBudget.remaining, total);
      assert.equal(m.deadline - h.sched.now(), Math.round(limit / speed * 1000));
    }
    assert.deepEqual(m.wave, original);
  });
}

for (const clientCombat of [false, true]) test(`ordinary four ${clientCombat ? 'client' : 'inline'} preserves original time, deadline, public shape`, t => {
  const { h, m, plan } = fixture(t, { count: 4, capacity: 4, base: 17.5, speed: 3, clientCombat });
  m.startUnite(plan); const spec = m.fields[0].spec || m.fields[0].battle.opts;
  assert.equal(spec.timeLimit, 17.5); assert.equal(m.deadline - h.sched.now(), Math.round(17.5 / 3 * 1000));
  for (const key of ['timeLimit', 'totalBudget', 'remainingBudget', 'gameSpeed']) {
    assert.equal(Object.hasOwn(m.publicView().unite, key), false); assert.equal(Object.hasOwn(plan, key), false);
  }
  assert.equal(m._uniteBudget, undefined); assert.equal(m.publicView().uniteRound, undefined);
});

test('solo never enables expanded timing from irrelevant experimental capacity', t => {
  const { m } = fixture(t, { mode: 'solo', count: 1, capacity: 20, base: 17.5 });
  assert.equal(m.capacityExperiment, false); assert.equal(m.uniteTimeLimit(), 17.5);
});

for (const capacity of [8, 12, 16, 20]) test(`zero living participants cannot start capacity${capacity} unite or budget`, t => {
  const { m, plan } = fixture(t, { capacity, count: capacity }); for (const p of m.order) { p.alive = false; p.left = true; }
  let settled = 0; m.settle = (p, result) => { settled++; assert.equal(p, null); assert.equal(result, null); };
  const before = m.fields; m.startUnite(plan);
  assert.equal(settled, 1); assert.equal(m.fields, before); assert.equal(m._uniteBudget, undefined);
});

for (const capacity of [8, 12, 16, 20]) for (const reason of ['none', 'left', 'dead', 'synthetic', 'leaked', 'imperfect', 'used', 'replaced']) test(`capacity${capacity} no viable unused helper (${reason}): single300 without fake second metadata`, t => {
  const { m, plan } = fixture(t, { capacity, count: 8, relay: true });
  plan.relayCandidates = reason === 'none' ? [] : [m.order[1]];
  const p = m.order[1], r = m.lastResults.get(p.playerId);
  if (reason === 'left') p.left = true;
  if (reason === 'dead') p.alive = false;
  if (reason === 'synthetic') r.synthetic = true;
  if (reason === 'leaked') r.leaked.push({ counted: true });
  if (reason === 'imperfect') r.perfect = false;
  if (reason === 'used') plan.helpers.push(p);
  if (reason === 'replaced') plan.relayCandidates = [{ ...p }];
  m.startUnite(plan); assert.equal(plan.timeLimit, 300); assert.equal(plan.totalBudget, 300);
  assert.equal(m.publicView().uniteRounds, 1); assert.ok(m.publicView().unite.battleId);
});

test('budget ledger requires natural terminal, uses max duration, clamps overshoot, and freezes round-start balance', t => {
  const { m, plan } = fixture(t, { count: 8, relay: true }); m.startUnite(plan);
  const field = m.fields[0];
  assert.equal(plan.timeLimit, 150); assert.equal(plan.remainingBudget, 300);
  m._consumeUniteBudget(plan, { time: 7 }, field);
  assert.equal(m._uniteBudget.remaining, 300, 'unreleased or unfinished fields cannot consume budget');
  field.battle.finished = true; // isolated terminal-ledger unit check; natural simulation/release is covered below
  for (const time of [7, 4, 12, 12]) m._consumeUniteBudget(plan, { time }, field);
  assert.equal(plan.budgetSpent, 12); assert.equal(m._uniteBudget.remaining, 288, 'not sum(7,4,12,12)');
  assert.equal(m.publicView().unite.remainingBudget, 300, 'a frozen round-start balance, not a ticking field');
  m._consumeUniteBudget(plan, { time: 150.0333333333 }, field);
  assert.equal(m._uniteBudget.remaining, 150); assert.equal(plan.budgetSpent, 150);
});

function natural(t, { capacity = 20, count = capacity, clientCombat = false, headless = false, base = 40, firstTime = 0.2, secondTime = 0.2, firstLeft = 1 } = {}) {
  const h = makeMatch({ humans: count, experimental: rules(capacity), fake: true, instant: false, clientCombat,
    clients: !headless, captureFrames: false, seed: 9017,
    script: b => b.kind === 'normal' ? { duration: 0.2, leaks: { p_0: 1 } }
      : { duration: b.fieldId === 'u' ? firstTime : secondTime, survivors: { p_0: b.fieldId === 'u' ? firstLeft : 1 } } }).start();
  const m = h.m; t.after(() => m.dispose()); h.toPrep(1);
  for (const p of m.order) { p.lp = 28; if (headless) p.connected = false; }
  m.wave = { ...m.wave, timeLimit: base };
  const normal = m._normalOpts.bind(m);
  m._normalOpts = ps => { const o = normal(ps); return { ...o, spawns: ps.seat === 0 ? [{ time: 0, enemyKey: 'enemy_1007_slime', count: 1, routeIndex: 0 }] : [] }; };
  let settlements = 0; const settle = m.settle.bind(m); m.settle = (...args) => { settlements++; return settle(...args); };
  assert.ok(h.drive(() => m.phase === 'UNITE'));
  return { h, m, settlements: () => settlements };
}

for (const capacity of [8, 12, 16, 20]) for (const [clientCombat, headless] of [[false, false], [true, false], [true, true]]) test(`capacity${capacity} ${clientCombat ? headless ? 'headless legacy' : 'accepted legacy' : 'inline'}: early first never enlarges second150, roster frozen, LP once and stale callbacks fenced`, t => {
  const { h, m, settlements } = natural(t, { capacity, clientCombat, headless });
  const first = m.unitePlan, field1 = m.fields[0];
  assert.equal(first.timeLimit, 150); assert.equal(first.totalBudget, 300); assert.equal(first.remainingBudget, 300);
  assert.equal(m.wave.timeLimit, 40); assert.equal(settlements(), 0);
  m.onLeave(m.order.at(-1).playerId); assert.equal(m._uniteBudget.entryAlive, capacity);
  assert.ok(h.drive(() => m.phase === 'UNITE' && m.unitePlan.uniteRound === 2));
  const second = m.unitePlan, used = Math.min(first.timeLimit, m._uniteRelay.rounds[0].result.time);
  assert.equal(second.timeLimit, 150); closeTo(second.remainingBudget, 300 - used);
  assert.equal(first.timeLimit + second.timeLimit, 300, 'allocation contract is independent of actual elapsed consumption');
  assert.equal(second.totalBudget, 300); assert.equal(m._uniteBudget.entryAlive, capacity);
  assert.equal((m.fields[0].spec || m.fields[0].battle.opts).timeLimit, 150);
  assert.equal(m.deadline - h.sched.now(), Math.round(150 / m.gameSpeed * 1000));
  assert.equal(m.publicView().unite.remainingBudget, second.remainingBudget); assert.equal(m.publicView().unite.gameSpeed, m.gameSpeed);
  assert.equal(settlements(), 0); assert.equal(m.order[0].lp, 28);
  assert.equal(new Set([...first.helpers, ...second.helpers]).size, first.helpers.length + second.helpers.length);
  const remaining = m._uniteBudget.remaining;
  m._finishUniteField(first, m._uniteRelay.rounds[0].result, field1); assert.equal(m._uniteBudget.remaining, remaining);
  h.runToPhase('SETTLE'); assert.equal(settlements(), 1); assert.equal(m.order[0].lp, 27); assert.equal(m.order[0].stats.lpLost, 1);
  assert.equal(m._uniteRelay.rounds.length, 2); assert.equal(m.wave.timeLimit, 40);
  closeTo(m._uniteBudget.remaining, 300 - used - Math.min(second.timeLimit, m._uniteRelay.rounds[1].result.time));
  m.startRound(2); h.toPrep(2); m.startCombat(); assert.equal(m._uniteBudget, null, 'next normal round owns a fresh stage budget');
});

for (const clientCombat of [false, true]) test(`two full ${clientCombat ? 'legacy' : 'inline'} rounds exhaust exactly300, no third round or extra LP`, t => {
  const { h, m, settlements } = natural(t, { clientCombat, base: 0.4, firstTime: Infinity, secondTime: Infinity });
  assert.equal(m.unitePlan.timeLimit, 150); assert.equal(m.unitePlan.totalBudget, 300);
  h.runToPhase('SETTLE'); assert.equal(m._uniteBudget.remaining, 0);
  assert.equal(m._uniteRelay.rounds.length, 2); assert.equal(settlements(), 1); assert.equal(m.order[0].stats.lpLost, 1);
});

for (const cause of ['cleared', 'no-helpers']) test(`${cause}: finish early without waiting for unused/reserved budget`, t => {
  const { h, m, settlements } = natural(t, { firstLeft: cause === 'cleared' ? 0 : 1 });
  const first = m.unitePlan, start = h.sched.now();
  if (cause === 'no-helpers') for (const p of first.relayCandidates) m.lastResults.get(p.playerId).synthetic = true;
  assert.equal(m.publicView().uniteRounds, cause === 'no-helpers' ? 1 : 2);
  h.runToPhase('SETTLE'); assert.equal(m._uniteRelay.rounds.length, 1); assert.equal(settlements(), 1);
  assert.ok(h.sched.now() - start < first.timeLimit / m.gameSpeed * 1000);
  assert.ok(m._uniteBudget.remaining > 299); assert.equal(m.order[0].stats.lpLost, cause === 'cleared' ? 0 : 1);
});

test('headless future result cannot consume budget, enter relay, charge LP or finish through premature callback', t => {
  const { h, m, settlements } = natural(t, { clientCombat: true, headless: true, firstTime: 12, secondTime: 2 });
  const first = m.unitePlan, f = m.fields[0]; h.run(() => !!f.result);
  assert.equal(f.done, false); assert.ok(f.result.time >= 12); assert.equal(m._uniteBudget.remaining, 300);
  m._finishUniteField(first, f.result, f); m._consumeUniteBudget(first, f.result, f);
  assert.equal(f.uniteCompleted, undefined); assert.equal(m._uniteBudget.remaining, 300);
  assert.equal(m._uniteRelay.rounds.length, 0); assert.equal(settlements(), 0); assert.equal(m.order[0].lp, 28);
  h.sched.advance(1000); assert.equal(m.unitePlan, first); assert.equal(m._uniteBudget.remaining, 300);
  h.run(() => f.uniteCompleted); closeTo(m._uniteBudget.remaining, 300 - f.result.time);
  const before = m._uniteBudget.remaining; m._finishUniteField(first, f.result, f); assert.equal(m._uniteBudget.remaining, before);
  h.runToPhase('SETTLE'); assert.equal(settlements(), 1); assert.equal(m.order[0].stats.lpLost, 1);
});
