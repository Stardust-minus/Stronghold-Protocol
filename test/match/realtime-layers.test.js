// The authoritative Match must retain normal-battle layers before settlement, even with no viewers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { PHASE } from '../../shared/constants.js';
import { CombatEngine } from '../../server/match/combat/engine.js';
import { CombatWorkerPool } from '../../server/match/combat/pool.js';
import { buildBattleSpec } from '../../server/sim/spec.js';
import { DATA, makeMatch, give, legalTileFor } from './harness.js';

const quiet = { error() {}, warn() {}, info() {}, debug() {} };
const bondEntry = (bonds, id) => bonds.find(b => b.bondId === id);

function fixture(t, pool = null) {
  const h = makeMatch({ mode: 'solo', instant: false, seed: 8301 }).start();
  t.after(() => h.m.dispose());
  h.toPrep(1);
  h.setStage('act2autochess_m04');
  const ps = h.ps('p_0');
  for (const id of ['chess_char_2_12_a', 'chess_char_3_12_a', 'chess_char_1_19_a']) {
    const tile = legalTileFor(h.m, ps, id);
    assert.ok(tile, `legal tile for ${id}`);
    give(h.m, ps, id, 'board', tile);
  }
  ps.layers.kazimierzShip = 10;
  ps.recompute();
  assert.equal(ps.bonds.kazimierzShip.active, true);
  // A future real wave keeps the battle open while the actual deployment traits run.
  h.m.wave = { ...h.m.wave, spawns: h.m.wave.spawns.map(s => ({ ...s, time: 20 + (s.time || 0) })) };
  h.m.combatPool = pool;
  return { h, m: h.m, ps };
}

function assertLive(m, ps, gains) {
  assert.equal(m.phase, PHASE.COMBAT);
  assert.equal(m.fields[0].live, true, 'the field has not finished');
  assert.ok(gains > 0, 'real Gravel/Blemishine deployment traits earned layers');
  assert.equal(ps.layers.kazimierzShip, 10 + gains, 'persistent count changes during the battle');
  assert.equal(bondEntry(ps.privateView().bonds, 'kazimierzShip').layers, 10 + gains);
  assert.equal(bondEntry(m.publicView().players[0].bonds, 'kazimierzShip').layers, 10 + gains);
  assert.equal(ps.pendingLayerGains, null, 'already retained layers must not remain as a display overlay');
}

test('inline: real deployment traits persist while an unwatched normal field is still running', t => {
  const { h, m, ps } = fixture(t);
  m.startCombat();
  m.watchers.clear();
  h.sched.advance(100);
  const gains = m.fields[0].battle._perPlayer[ps.playerId].layerGains.kazimierzShip;
  assertLive(m, ps, gains);
  m.flush(true);
  assert.equal(bondEntry(h.lastTo(ps.playerId, 'm.private').bonds, 'kazimierzShip').layers, 10 + gains);
  assert.equal(bondEntry(h.lastBc('m.public').players[0].bonds, 'kazimierzShip').layers, 10 + gains);
});

test('engine: cumulative gains cross the DTO boundary without snapshots or watchers and are detached', t => {
  const { m, ps } = fixture(t);
  const opts = m._normalOpts(ps);
  const engine = new CombatEngine({ specs: [buildBattleSpec({ ...opts, battleId: 'layer-fixture' })] }, { data: DATA, log: quiet });
  t.after(() => engine.dispose());
  const out = engine.advance(6);
  assert.equal(out.done, false);
  assert.equal(out.frames.length, 1, 'the first tick publishes the immutable panel cache even without watchers');
  const opening = out.frames[0];
  assert.deepEqual(Object.keys(opening).sort(), ['fieldId', 'startMeta']);
  assert.equal(opening.fieldId, opts.fieldId);
  assert.equal(opening.startMeta.t, 'm.field');
  assert.equal(opening.startMeta.live, true);
  assert.ok(opening.startMeta.unitStats.length > 0);
  const listed = new Set(opening.startMeta.units.map(u => u.id));
  assert.ok(opening.startMeta.unitStats.every(u => listed.has(u.id)), 'only listed units have cached details');
  const savedOpening = structuredClone(opening);
  const live = engine.fields[0].battle._perPlayer[ps.playerId].layerGains;
  assert.ok(live.kazimierzShip > 0);
  assert.deepEqual(out.fields[0].layerGains, { [ps.playerId]: live });
  const saved = structuredClone(out.fields[0].layerGains);
  engine.fields[0].battle.addLayers(ps.playerId, 'kazimierzShip', 1, 'fixture');
  assert.deepEqual(out.fields[0].layerGains, saved, 'later simulation cannot mutate an accepted DTO');
  const next = engine.advance(6);
  assert.equal(next.done, false, 'opening metadata never completes or settles the battle');
  assert.deepEqual(next.frames, [], 'no second opening cache, periodic snapshots or events without watchers');
  assert.equal(next.fields[0].layerGains[ps.playerId].kazimierzShip, saved[ps.playerId].kazimierzShip + 1);
  const state = engine.state();
  assert.deepEqual(state.frames, [], 'a state query does not replay first-tick metadata');
  assert.equal(state.fields[0].layerGains[ps.playerId].kazimierzShip, saved[ps.playerId].kazimierzShip + 1);
  assert.deepEqual(opening, savedOpening, 'the opening cache is detached from later simulation');
});

test('real Worker: an unwatched field persists layers before finishing; resync and settlement do not double them', async t => {
  const pool = new CombatWorkerPool({ size: 1, data: DATA, log: quiet });
  t.after(() => pool.close());
  await pool.start();
  const { h, m, ps } = fixture(t, pool);
  m.startCombat();
  m.watchers.clear();
  const deadline = Date.now() + 10000;
  while (!(ps.layers.kazimierzShip > 10)) {
    assert.ok(Date.now() < deadline, 'worker publishes live layers');
    h.sched.advance(33);
    await delay(5);
  }
  assert.equal(m.phase, PHASE.COMBAT, 'layers must arrive before the phase settles');
  const field = m.fields[0];
  const gains = field.battle.layerGains[ps.playerId].kazimierzShip;
  assertLive(m, ps, gains);
  const before = ps.layers.kazimierzShip;
  m._syncNormalLayers(field, field.battle.layerGains);
  m.onReconnect(ps.playerId);
  assert.equal(bondEntry(h.lastTo(ps.playerId, 'm.private').bonds, 'kazimierzShip').layers, before);
  assert.equal(ps.layers.kazimierzShip, before, 'reconnect cannot re-credit the cumulative count');
  field.battle.forceEnd('timeout');
  while (m.phase !== PHASE.SETTLE) {
    assert.ok(Date.now() < deadline, 'worker settlement completes');
    h.sched.advance(33);
    await delay(5);
  }
  assert.equal(ps.layers.kazimierzShip, before, 'terminal result is reconciled once');
  assert.equal(m.errorCount, 0);
  assert.equal(m.simErrors, 0);
});

test('cumulative watermarks reject repeats/regressions, clamp at 999, and reset for the next round', t => {
  const { m, ps } = fixture(t);
  m.startCombat();
  const f = m.fields[0];
  const seen = [];
  const dispatch = m.dispatch.bind(m);
  m.dispatch = (player, hook, ev, opts) => {
    if (hook === 'onLayers' && ev.reason === 'battle') seen.push([ev.bondId, ev.from, ev.to]);
    return dispatch(player, hook, ev, opts);
  };
  ps.layers.yanShip = 998;
  ps.recompute();
  const apply = n => m._syncNormalLayers(f, { [ps.playerId]: { yanShip: n } });
  apply(5);
  apply(5);
  apply(2);
  apply(10);
  assert.equal(ps.layers.yanShip, 999);
  assert.equal(ps.battleLayerGains.yanShip, 10, 'even capped excess is consumed, not deferred');
  assert.deepEqual(seen, [['yanShip', 998, 999]], 'no duplicate/capped reward dispatch');
  ps.startRound(2);
  assert.deepEqual(ps.battleLayerGains, {});
});

test('stale fields, other players, invalid gains and no-gain phases cannot mutate persistent layers', t => {
  const { m, ps } = fixture(t);
  m.startCombat();
  const field = m.fields[0];
  m._syncNormalLayers({ ...field }, { [ps.playerId]: { yanShip: 10 } });
  m._syncNormalLayers(field, { stranger: { yanShip: 10 } });
  m._syncNormalLayers(field, { [ps.playerId]: { yanShip: Infinity, noSuchBond: 10, sargonShip: '10' } });
  assert.equal(ps.layers.yanShip || 0, 0);
  assert.equal(ps.layers.sargonShip || 0, 0);
  assert.deepEqual(ps.battleLayerGains, {});
  for (const kind of ['unite', 'boss', 'hidden']) {
    field.kind = kind;
    m._syncNormalLayers(field, { [ps.playerId]: { yanShip: 10 } });
  }
  field.kind = 'normal';
  field.battle.flags.layerGainsEnabled = false;
  m._syncNormalLayers(field, { [ps.playerId]: { yanShip: 10 } });
  field.battle.flags.layerGainsEnabled = true;
  m.phase = PHASE.UNITE;
  m._syncNormalLayers(field, { [ps.playerId]: { yanShip: 10 } });
  assert.equal(ps.layers.yanShip || 0, 0);
  assert.deepEqual(ps.battleLayerGains, {});
});

test('real layer milestones award funds and a Victoria hammer during COMBAT, exactly once', t => {
  const { h, m, ps } = fixture(t);
  for (const id of ['chess_char_1_06_a', 'chess_char_2_05_a', 'chess_char_2_10_a']) {
    const tile = legalTileFor(m, ps, id);
    assert.ok(tile);
    give(m, ps, id, 'board', tile);
  }
  for (const id of ['chess_char_2_02_a', 'chess_char_3_03_a']) give(m, ps, id, 'hand');
  ps.layers.visiShip = 9;
  ps.layers.victoriaShip = 24;
  ps.recompute();
  assert.equal(ps.bonds.visiShip.active, true);
  assert.equal(ps.bonds.victoriaShip.active, true);
  const funds = ps.funds;
  const items = () => [...ps.hand, ...ps.temp].filter(p => p?.kind === 'item').length;
  const beforeItems = items();
  m.startCombat();
  const field = m.fields[0];
  field.battle.addLayers(ps.playerId, 'visiShip', 1, 'fixture');
  field.battle.addLayers(ps.playerId, 'victoriaShip', 1, 'fixture');
  h.sched.advance(100);
  assert.equal(m.phase, PHASE.COMBAT);
  assert.equal(field.live, true);
  assert.equal(ps.layers.visiShip, 10);
  assert.equal(ps.layers.victoriaShip, 25);
  assert.equal(ps.funds, funds + 2, 'the milestone is paid now, not at settlement');
  assert.equal(items(), beforeItems + 1, 'a real hammer is already in the inventory');
  m._syncNormalLayers(field, { [ps.playerId]: { visiShip: 1, victoriaShip: 1 } });
  assert.equal(ps.funds, funds + 2);
  assert.equal(items(), beforeItems + 1);
});

test('a paused Worker reply retains no layers until resume; late replies after disposal are ignored', t => {
  let engine;
  const pool = {
    create(input) {
      engine = new CombatEngine(input, { data: DATA, log: quiet });
      return { ready: new Promise(() => {}), request: () => new Promise(() => {}), close() { engine.dispose(); } };
    },
  };
  const { m, ps } = fixture(t, pool);
  m.startCombat();
  const runner = m.runner;
  const out = engine.advance(6);
  assert.ok(out.fields[0].layerGains[ps.playerId].kazimierzShip > 0);
  assert.deepEqual(m.handle(ps.playerId, { t: 'g.pause', on: true }), { ok: true });
  runner._receive(out, true);
  assert.equal(runner.held, out);
  assert.equal(ps.layers.kazimierzShip, 10);
  assert.deepEqual(ps.battleLayerGains, {});
  assert.deepEqual(m.handle(ps.playerId, { t: 'g.pause', on: false }), { ok: true });
  assertLive(m, ps, out.fields[0].layerGains[ps.playerId].kazimierzShip);
  const before = ps.layers.kazimierzShip;
  runner.resume();
  assert.equal(ps.layers.kazimierzShip, before);
  const late = engine.advance(6);
  late.fields[0].layerGains[ps.playerId].kazimierzShip += 10;
  m.dispose();
  runner._receive(late);
  assert.equal(ps.layers.kazimierzShip, before);
});

test('a final result reconciles only the gain missed after the last live update, once', t => {
  const { h, m, ps } = fixture(t);
  m.startCombat();
  h.sched.advance(100);
  const field = m.fields[0];
  const before = ps.layers.kazimierzShip;
  const add = field.battle.addLayers(ps.playerId, 'kazimierzShip', 2, 'fixture');
  assert.equal(add, 2);
  assert.equal(ps.layers.kazimierzShip, before, 'the last simulation update has not yet crossed the boundary');
  field.battle.forceEnd('timeout');
  m.runner.stop();
  m._finishCombat(f => f.battle.result());
  assert.equal(ps.layers.kazimierzShip, before + add);
  assert.equal(ps.pendingLayerGains, null);
  m.settle(null, null);
  m.settle(null, null);
  assert.equal(ps.layers.kazimierzShip, before + add, 'settlement cannot re-credit the final delta');
});
