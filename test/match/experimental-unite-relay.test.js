// Expanded-room relay regressions. Existing entry/start>=8 relay qualification stays; sparse rounds get one300.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { OPERATOR_SKINS } from '../../shared/skins.js';
import { Battle } from '../../server/sim/Battle.js';
import { planUnite, planUniteRelay, uniteSurvivors } from '../../server/match/unite.js';
import { FakeBattle } from './fakeBattle.js';
import { makeMatch, give, legalTileFor, checkInvariants } from './harness.js';

const experiment = { playerCapacity: 20, revivalEnabled: true, disableSharedPool: false };
const enemyKey = 'enemy_1007_slime';
const pp = (leaked = [], extra = {}) => ({ leaked, perfect: !leaked.some(l => l.counted !== false), killed: 0,
  total: leaked.length, coins: 0, damageDealt: 0, healingDone: 0, layerGains: {}, unitsEnd: [], unitStats: [], ...extra });
const leak = (sourcePlayerId, extra = {}) => ({ enemyKey, sourcePlayerId, counted: true, mods: { hpMul: 2 }, lpr: 1, ...extra });
const ownerRows = (players, amount) => ({ owners: players.map(playerId => ({ playerId, total: amount, otherDamage: amount, operators: [] })) });

function fixture(t, options = {}) {
  const h = makeMatch({ humans: options.humans ?? 8, experimental: options.experimental ?? experiment,
    fake: true, instant: options.instant, clientCombat: options.clientCombat, clients: options.clients,
    spectators: ['observer'], seed: 9017,
    script: b => b.kind === 'normal' ? { leaks: options.normalLeaks ?? { p_0: 4 }, coins: { [b.players[0]]: 1 } }
      : { survivors: { p_0: b.fieldId === 'u' ? options.firstLeft ?? 2 : options.secondLeft ?? 1 },
        coins: Object.fromEntries(b.players.map(id => [id, b.fieldId === 'u' ? 3 : 5])),
        damage: Object.fromEntries(b.players.map(id => [id, b.fieldId === 'u' ? 31 : 53])) },
  }).start();
  const m = h.m;
  t.after(() => m.dispose());
  h.toPrep(1); h.setStage('act2autochess_m04');
  for (const p of m.order) p.lp = p.seat === 0 ? options.targetLp ?? 20 : 20;
  for (const p of m.order.slice(1, 5)) {
    const id = options.kitId ?? 'chess_char_1_19_a';
    give(m, p, id, 'board', legalTileFor(m, p, id));
  }
  h.statsBefore = new Map(m.order.map(p => [p.playerId, structuredClone(p.stats)]));
  let settlements = 0;
  const settle = m.settle.bind(m);
  m.settle = (...args) => { settlements++; return settle(...args); };
  h.settlements = () => settlements;
  return h;
}

function first(h) { h.drive(() => h.m.phase === PHASE.UNITE); return h.m.fields[0]; }
function second(h) {
  assert.ok(h.drive(() => h.m.phase === PHASE.UNITE && h.m.unitePlan.uniteRound === 2));
  return h.m.fields[0];
}
function settle(h) { h.runToPhase(PHASE.SETTLE, 1); assert.equal(h.settlements(), 1); }

for (const clientCombat of [false, true]) test(`relay ${clientCombat ? 'legacy client' : 'inline server'}: first residual only, distinct helpers, original map/carry, final LP once and both rewards`, t => {
  const h = fixture(t, { clientCombat }), m = h.m;
  const f1 = first(h), plan1 = m.unitePlan;
  assert.deepEqual(plan1.helpers.map(p => p.playerId), ['p_1', 'p_2']);
  assert.equal(m.publicView().uniteRound, 1); assert.equal(m.publicView().uniteRounds, 2);
  assert.equal(h.settlements(), 0); assert.equal(h.ps('p_0').lp, 20);
  const f2 = second(h), plan2 = m.unitePlan;
  assert.equal(f1.fieldId, 'u'); assert.equal(f2.fieldId, 'u:2');
  assert.deepEqual(plan2.helpers.map(p => p.playerId), ['p_3', 'p_4']);
  assert.equal(new Set([...plan1.helpers, ...plan2.helpers]).size, 4);
  assert.equal(plan2.leaked.length, 2); assert.ok(plan2.leaked.every(l => l.sourcePlayerId === 'p_0'));
  assert.equal(h.ps('p_0').lp, 20); assert.equal(h.ps('p_0').alive, true); assert.equal(h.settlements(), 0);
  const opts = f2.spec || f2.battle.opts;
  assert.equal(opts.stageId, m.stageId); assert.equal(opts.flags.layerGainsEnabled, false);
  for (const p of opts.players) {
    assert.equal(p.units[0].carryState.hpPct, 0.5);
    assert.equal(p.units[0].carryState.sp, 3);
    assert.equal(Object.hasOwn(p.units[0].carryState, 'skillActive'), false);
  }
  const result1 = m._uniteRelay.rounds[0].result;
  settle(h);
  assert.equal(h.ps('p_0').lp, 19); assert.equal(h.ps('p_0').stats.lpLost, 1);
  assert.equal(m.uniteResultView.through, 1);
  assert.deepEqual(m.uniteResultView.helpers, ['p_1', 'p_2', 'p_3', 'p_4']);
  assert.deepEqual(m.publicView().uniteResult.rounds.map(r => [r.round, r.fieldId, r.through]), [[1, 'u', 2], [2, 'u:2', 1]]);
  assert.notEqual(m.uniteResultView.rounds[0].battleId, m.uniteResultView.rounds[1].battleId);
  for (const id of ['p_1', 'p_2', 'p_3', 'p_4']) {
    const p = h.ps(id), normal = m.lastResults.get(id), u = m._uniteRelay.rounds.find(r => r.plan.helpers.includes(p)).result.perPlayer[id];
    assert.equal(p.pendingFunds, 1 + (p.seat < 3 ? 3 : 5));
    assert.equal(p.stats.kills, normal.killed + u.killed);
    assert.equal(p.stats.dmgDealt, normal.damageDealt + u.damageDealt);
    assert.equal(p.stats.fundsGained - h.statsBefore.get(id).fundsGained, 1 + (p.seat < 3 ? 3 : 5));
  }
  assert.equal(m._uniteRelay.rounds[0].result, result1, 'round one result is never overwritten by round two');
  const stats = structuredClone(m.order.map(p => p.stats));
  m.settle(plan2, m._uniteRelay.rounds[1].result); // existing settlement fence
  assert.deepEqual(m.order.map(p => p.stats), stats);
  checkInvariants(m);
});

for (const [label, options] of [
  ['ordinary four', { humans: 4, experimental: { ...experiment, playerCapacity: 4 } }],
  ['expanded seven alive', { humans: 7 }],
  ['expanded four alive', { humans: 4 }],
]) test(`${label}: unchanged single-round plan/identity, expanded single300 and own losses/rewards`, t => {
  const h = fixture(t, options), m = h.m;
  first(h);
  assert.equal(m.unitePlan.uniteRound, undefined); assert.equal(m._uniteRelay, null);
  assert.equal(Object.hasOwn(m.publicView(), 'uniteRound'), false);
  assert.equal(Object.hasOwn(m.publicView().unite, 'rounds'), false);
  if (m.capacityExperiment) assert.equal(m.unitePlan.timeLimit, 300);
  settle(h);
  assert.equal(h.ps('p_0').lp, 18);
  assert.equal(m.publicView().uniteResult.rounds, undefined);
  assert.deepEqual(m.uniteResultView.helpers, ['p_1', 'p_2']);
});

for (const when of ['normal-start', 'qualification']) test(`eight threshold uses actual alive at ${when}; below threshold gets single300 without new relay eligibility`, t => {
  const h = fixture(t), m = h.m;
  if (when === 'normal-start') m.onLeave('p_7');
  else {
    const after = m._afterCombat.bind(m);
    m._afterCombat = () => { m.onLeave('p_7'); return after(); };
  }
  first(h); assert.equal(m._uniteRelay, null); assert.equal(m.unitePlan.uniteRound, undefined);
  assert.equal(m.unitePlan.timeLimit, 300);
  settle(h); assert.equal(h.ps('p_0').lp, 18);
});

test('no first residual: no second field, reserves never become donors, result metadata records only actual first field', t => {
  const h = fixture(t, { firstLeft: 0 }), m = h.m;
  first(h); settle(h);
  assert.equal(h.ps('p_0').lp, 20); assert.equal(m._uniteRelay.rounds.length, 1);
  assert.equal(m.uniteResultView.through, 0);
  assert.deepEqual(m.uniteResultView.helpers, ['p_1', 'p_2']);
  assert.equal(m._revival.eligible.has('p_3'), false); assert.equal(m._revival.eligible.has('p_4'), false);
});

for (const candidates of [0, 1]) test(`only ${candidates} unused qualified helper(s): no empty/repeated helper, final settle still once`, t => {
  const normalLeaks = Object.fromEntries(['p_0', ...Array.from({ length: 5 - candidates }, (_, i) => `p_${i + 3}`)].map(id => [id, 2]));
  const h = fixture(t, { normalLeaks }), m = h.m;
  first(h);
  if (candidates) { second(h); assert.equal(m.unitePlan.helpers.length, 1); assert.equal(m.unitePlan.helpers[0].playerId, 'p_7'); }
  settle(h);
  assert.equal(m._uniteRelay.rounds.length, candidates ? 2 : 1);
  assert.equal(new Set(m.uniteResultView.helpers).size, candidates ? 3 : 2);
});

test('second helper qualification excludes departure, synthetic, counted leaks and perfect:false', t => {
  const h = fixture(t), m = h.m; first(h);
  m.onLeave('p_3'); m.lastResults.get('p_4').synthetic = true;
  m.lastResults.get('p_5').leaked.push(leak('p_5')); m.lastResults.get('p_6').perfect = false;
  second(h); assert.deepEqual(m.unitePlan.helpers.map(p => p.playerId), ['p_7']);
  settle(h); assert.equal(m._revival.eligible.has('p_3'), false); assert.equal(m._revival.eligible.has('p_4'), false);
});

test('source ledger: leaks + unspawned residuals, unknown/noncounted enemies, mods and bounty remain source-owned', t => {
  const h = fixture(t), m = h.m; first(h);
  const plan = m.unitePlan;
  plan.leaked = [leak('p_0', { mods: { hpMul: 4, bountyCoins: 9 }, bounty: { coins: 9, ownerPlayerId: 'p_0' } })];
  plan.notReentered.set('p_0', 1);
  const result = { reason: 'timeout', perPlayer: { p_1: pp([leak('p_0'), leak('p_0', { counted: false }), leak('foreign')]) },
    unspawned: [{ enemyKey, sourcePlayerId: 'p_0' }, { enemyKey: 'not_an_enemy', sourcePlayerId: 'p_0' }] };
  const next = planUniteRelay(m, plan, result);
  assert.equal(next.leaked.length, 2); assert.equal(next.notReentered.get('p_0'), 2);
  assert.deepEqual(next.leaked[1].mods, { hpMul: 4, bountyCoins: 9 });
  assert.deepEqual(next.leaked[1].bounty, { coins: 9, ownerPlayerId: 'p_0' });
  assert.equal(next.leaked[1].sourcePlayerId, 'p_0');
  assert.equal(planUniteRelay(m, plan, { ...result, synthetic: true }), null);
});

test('unspawned recovery consumes exact original schedule entries once for repeated enemy keys and distinct mods/bounties/counts', t => {
  const h = fixture(t), m = h.m; first(h);
  const plan = m.unitePlan;
  const spawns = [
    { enemyKey, sourcePlayerId: 'p_0', time: 12, count: 2, interval: 3, mods: { hpMul: 2, bountyCoins: 2 }, bounty: { coins: 2, ownerPlayerId: 'p_0' } },
    { enemyKey, sourcePlayerId: 'p_0', time: 13, count: 1, mods: { hpMul: 7, bountyCoins: 7 }, bounty: { coins: 7, ownerPlayerId: 'p_0' } },
  ];
  const result = { reason: 'timeout', perPlayer: { p_1: pp() },
    unspawned: [13, 15, 12].map(time => ({ enemyKey, sourcePlayerId: 'p_0', time })) };
  const next = planUniteRelay(m, plan, result, spawns);
  assert.deepEqual(next.leaked.map(l => l.mods.hpMul), [7, 2, 2]);
  assert.deepEqual(next.leaked.map(l => l.bounty.coins), [7, 2, 2]);
  assert.ok(next.leaked.every(l => l.sourcePlayerId === 'p_0' && l.bounty.ownerPlayerId === 'p_0'));
  assert.deepEqual(spawns.map(s => s.mods.hpMul), [2, 7], 'input schedule is never mutated');
});

test('synthetic second result charges only first residual, never restores original leak count; preserves first rewards', t => {
  const h = fixture(t), m = h.m; first(h);
  const normalBattle = m.BattleClass;
  class FailingSecond extends normalBattle { constructor(o) { if (o.fieldId === 'u:2') throw new Error('relay fixture failure'); super(o); } }
  m.BattleClass = FailingSecond;
  second(h); settle(h);
  assert.equal(m._uniteRelay.rounds[1].result.synthetic, true);
  assert.equal(m.uniteResultView.through, 2); assert.equal(h.ps('p_0').lp, 18);
  assert.equal(h.ps('p_1').pendingFunds, 4);
  assert.equal(m._revival.eligible.has('p_3'), false);
});

test('relay death/rescue only after final LP: actual leak-free participants qualify, reserves/leaky participants do not', t => {
  const h = fixture(t, { targetLp: 1 }), m = h.m;
  first(h); assert.equal(h.ps('p_0').alive, true); assert.equal(h.ps('p_0').pendingDeath, false);
  second(h); assert.equal(h.ps('p_0').alive, true); assert.equal(m._revival, null);
  settle(h);
  assert.equal(h.ps('p_0').pendingDeath, true);
  assert.equal(m._revival.eligible.has('p_1'), false, 'helper whose half leaked cannot pay');
  assert.equal(m._revival.eligible.has('p_3'), false, 'second-round leaking helper cannot pay');
  assert.deepEqual([...m._revival.eligible].sort(), ['p_2', 'p_4']);
  assert.equal(m._revival.eligible.has('p_5'), false, 'perfect reserve never participated');
  const request = { t: 'g.revive', playerId: 'p_0', round: 1, matchId: m.battlePrefix };
  assert.equal(m.handle('p_1', request).detail, 'revival-not-helper');
  assert.equal(m.handle('p_5', request).detail, 'revival-not-helper');
  assert.deepEqual(m.handle('p_4', request), { ok: true });
  assert.equal(h.ps('p_4').lp, 10); assert.equal(h.ps('p_0').lp, 1);
  assert.equal(m.handle('p_2', request).detail, 'revival-target-ineligible');
  assert.equal(h.ps('p_2').lp, 20);
});

test('twenty seats preserve independent high-seat residual sources and final per-leaker losses', t => {
  const h = fixture(t, { humans: 20, normalLeaks: { p_8: 4, p_19: 5 } }), m = h.m;
  const script = FakeBattle.script;
  FakeBattle.script = b => b.kind === 'normal' ? script(b) : { ...script(b),
    survivors: b.fieldId === 'u' ? { p_8: 2, p_19: 3 } : { p_8: 1 } };
  first(h); second(h);
  assert.deepEqual(m.unitePlan.leaked.map(l => l.sourcePlayerId).sort(), ['p_19', 'p_19', 'p_19', 'p_8', 'p_8']);
  const view = m.publicView();
  assert.equal(view.players.find(p => p.playerId === 'p_8').uniteLeft, 2);
  assert.equal(view.players.find(p => p.playerId === 'p_19').uniteLeft, 3);
  settle(h);
  assert.equal(m.uniteResultView.losses.p_8, 1); assert.equal(m.uniteResultView.losses.p_19, 0);
  assert.equal(h.ps('p_8').lp, 19); assert.equal(h.ps('p_19').lp, 20);
  assert.equal(h.ps('p_8').stats.lpLost, 1); assert.equal(h.ps('p_19').stats.lpLost, 0);
  assert.equal(m.uniteResultView.through, 1);
  checkInvariants(m);
});

test('relay threshold is frozen at qualification: a later departure does not disable eligible second helpers', t => {
  const h = fixture(t), m = h.m; first(h);
  m.onLeave('p_7'); assert.equal(m.alivePlayers().length, 7);
  second(h); assert.deepEqual(m.unitePlan.helpers.map(p => p.playerId), ['p_3', 'p_4']);
  settle(h); assert.equal(m.uniteResultView.rounds.length, 2);
});

test('final LP cap is applied once across two rounds, not once per relay field', t => {
  const h = fixture(t, { normalLeaks: { p_0: 40 }, firstLeft: 30, secondLeft: 20, targetLp: 40 }), m = h.m;
  first(h); second(h); assert.equal(h.ps('p_0').lp, 40);
  settle(h);
  assert.equal(m.uniteResultView.through, 20); assert.equal(m.uniteResultView.losses.p_0, m.gd.lpCapPerRound);
  assert.equal(h.ps('p_0').lp, 40 - m.gd.lpCapPerRound);
  assert.equal(h.ps('p_0').stats.lpLost, m.gd.lpCapPerRound);
});

test('second-round downed/HP/SP carry and skins are original helper-owned, never observer preferences or reset units', t => {
  const h = fixture(t, { clientCombat: true, kitId: 'chess_char_3_01_a' }), m = h.m;
  const skins = OPERATOR_SKINS.filter(s => s.charId === 'char_103_angel'); assert.ok(skins.length >= 2);
  const p3 = h.ps('p_3'), p4 = h.ps('p_4'), uid3 = [...p3.board.values()][0].uid;
  assert.equal(p3.setSkins({ char_103_angel: skins[0].id }), true);
  assert.equal(p4.setSkins({ char_103_angel: skins[1].id }), true);
  h.ps('p_0').setSkins({ char_103_angel: skins[1].id });
  const script = FakeBattle.script;
  FakeBattle.script = b => ({ ...script(b), deadUids: b.kind === 'normal' ? [uid3] : [] });
  first(h); const f = second(h);
  const inputs = new Map(f.spec.players.map(p => [p.playerId, p.units[0]]));
  assert.deepEqual(inputs.get('p_3').carryState, { down: true });
  assert.deepEqual(inputs.get('p_4').carryState, { hpPct: 0.5, sp: 3 });
  assert.equal(inputs.get('p_3').skinId, skins[0].id); assert.equal(inputs.get('p_4').skinId, skins[1].id);
  const uidBefore = m.uidSeq; m.addSpectator('observer'); m.onReconnect('p_0');
  assert.equal(m.uidSeq, uidBefore);
  assert.equal(JSON.stringify(m.publicView()).includes('skins'), false);
  const observer = h.lastTo('observer', 'b.start');
  assert.equal(observer.spec.players.find(p => p.playerId === 'p_3').units[0].skinId, skins[0].id);
  assert.equal(observer.authoritative, false); assert.equal(h.lastTo('observer', 'm.private'), null);
  settle(h); assert.equal(m.uidSeq, uidBefore);
});

test('legacy headless relay waits natural field release; precomputed results cannot start round two or rescue early', t => {
  const h = fixture(t, { clientCombat: true, clients: false, instant: false, targetLp: 1 }), m = h.m;
  for (const p of m.order) p.connected = false;
  m.startCombat();
  h.run(() => m.fields.every(f => !!f.result));
  assert.equal(m.phase, PHASE.COMBAT); assert.ok(m.fields.every(f => !f.done));
  h.run(() => m.phase === PHASE.UNITE);
  const f1 = m.fields[0]; h.run(() => !!f1.result);
  assert.equal(f1.done, false); assert.equal(m.unitePlan.uniteRound, 1);
  assert.equal(m._uniteRelay.rounds.length, 0); assert.equal(h.ps('p_0').alive, true); assert.equal(m._revival, null);
  second(h); const f2 = m.fields[0]; h.run(() => !!f2.result);
  assert.equal(f2.done, false); assert.equal(m._uniteRelay.rounds.length, 1);
  assert.equal(h.ps('p_0').lp, 1); assert.equal(h.settlements(), 0);
  settle(h); assert.equal(h.ps('p_0').pendingDeath, true);
});

test('legacy late first-round results/progress cannot mutate round-two authority or residual counts', t => {
  const h = fixture(t, { clientCombat: true }), m = h.m;
  const f1 = first(h); second(h); const f2 = m.fields[0];
  const before = structuredClone({ progress: f2.progress, result: f2.result, verified: m.verifyStats });
  assert.deepEqual(m.handle('p_1', { t: 'b.progress', battleId: f1.battleId, gt: 999, killed: 999, total: 999,
    leaks: 999, left: { p_0: 999 } }), { ok: true });
  assert.deepEqual(m.handle('p_1', { t: 'b.result', battleId: f1.battleId, result: { perPlayer: {} } }), { ok: true });
  assert.deepEqual({ progress: f2.progress, result: f2.result, verified: m.verifyStats }, before);
  assert.equal(m._uniteRelay.rounds.length, 1); assert.equal(h.settlements(), 0);
  settle(h); assert.equal(h.ps('p_0').stats.lpLost, 1);
});

test('damage ledger preserves normal + first + second absolute fields; late first field cannot erase or add rows', t => {
  const h = fixture(t), m = h.m;
  class MeterBattle extends FakeBattle { damageRows() { return ownerRows(this.players, this.kind === 'normal' ? 10 : this.fieldId === 'u' ? 20 : 30); } }
  m.BattleClass = MeterBattle;
  const f1 = first(h); const f2 = second(h);
  assert.equal(m._onDamageRows(f1, ownerRows(f1.players, 9999)), false);
  settle(h);
  const packet = m.damageBoard.packet(), totals = new Map(packet.owners.map(p => [p.playerId, p.total]));
  assert.equal(totals.get('p_1'), 30); assert.equal(totals.get('p_2'), 30);
  assert.equal(totals.get('p_3'), 40); assert.equal(totals.get('p_4'), 40);
  assert.equal(m.damageBoard.fields.size, 10);
  assert.equal(packet.status, 'frozen');
  m._onDamageRows(f2, ownerRows(f2.players, 9000)); assert.deepEqual(m.damageBoard.packet(), packet);
});

test('relay preserves normal layer watermarks: no unite gains or duplicated final delta', t => {
  const h = fixture(t), m = h.m;
  const p = h.ps('p_3'); p.layers.kazimierzShip = 10; p.battleLayerGains.kazimierzShip = 0;
  const script = FakeBattle.script;
  FakeBattle.script = b => ({ ...script(b), layerGains: b.kind === 'normal' ? { p_3: { kazimierzShip: 4 } } : {} });
  first(h); assert.ok(p.layers.kazimierzShip >= 14); assert.equal(p.battleLayerGains.kazimierzShip, 4);
  const layersAfterNormal = p.layers.kazimierzShip;
  second(h); settle(h);
  assert.equal(p.layers.kazimierzShip, layersAfterNormal); assert.equal(p.battleLayerGains.kazimierzShip, 4);
  assert.equal(m._applyBattleLayerGains(p, { kazimierzShip: 4 }), false);
});

for (const clientCombat of [false, true]) test(`observer/reconnect ${clientCombat ? 'client specs' : 'streaming'}: current second battle + first history, no private DTO, independent IDs`, t => {
  const h = fixture(t, { clientCombat }), m = h.m;
  first(h); const f = second(h);
  m.addSpectator('observer'); m.onReconnect('p_3'); m.flush(true);
  const observer = h.lastTo('observer', 'm.public');
  assert.equal(observer.uniteRound, 2); assert.equal(observer.uniteRounds, 2);
  assert.deepEqual(observer.unite.helpers, ['p_3', 'p_4']);
  assert.deepEqual(observer.unite.rounds.map(r => r.fieldId), ['u']);
  assert.equal(observer.unite.battleId, f.battleId || f.spec?.battleId || f.battle.opts.battleId);
  assert.equal(h.lastTo('observer', 'm.private'), null);
  if (clientCombat) {
    assert.equal(h.lastTo('observer', 'b.start').fieldId, 'u:2');
    assert.equal(h.lastTo('observer', 'b.start').authoritative, false);
    assert.ok(h.lastTo('observer', 'b.start').spec.players.every(p => !Object.hasOwn(p.contentInfo || {}, 'funds')));
    assert.equal(h.lastTo('p_3', 'b.start').battleId, f.battleId);
  } else assert.equal(h.lastTo('observer', 'm.field').fieldId, 'u:2');
  settle(h); m.addSpectator('observer');
  assert.equal(h.lastTo('observer', 'm.public').uniteResult.rounds.length, 2);
});

test('sim unite leak ownership is helper-half pp, with original source attribution distinct', t => {
  const h = fixture(t), m = h.m; first(h);
  const opts = m._uniteOpts(m.unitePlan, 10);
  const b = new Battle({ ...opts, data: m.ds, content: 'none', logger: m.log, spawns: [] });
  const source = m.unitePlan.leakers[0].playerId;
  const e = b.spawnEnemy(enemyKey, { pos: [9, 17], sourcePlayerId: source, ownerPlayerId: 'p_1' });
  b._recordLeak(e, true); b.forceEnd('forced');
  const r = b.result();
  assert.equal(r.perPlayer.p_1.perfect, false);
  assert.equal(r.perPlayer.p_1.leaked[0].sourcePlayerId, source);
  assert.equal(r.perPlayer.p_2.perfect, true);
  assert.equal(uniteSurvivors(m.unitePlan, r).get(source), 1);
});

test('duplicate first completion and replaced-phase callback cannot launch a third field or settle twice', t => {
  const h = fixture(t), m = h.m;
  const f1 = first(h), plan1 = m.unitePlan;
  h.run(() => f1.uniteCompleted);
  const result1 = m._uniteRelay.rounds[0].result;
  m._finishUniteField(plan1, result1, f1);
  assert.equal(m._uniteRelay.rounds.length, 1);
  second(h); m._finishUniteField(plan1, result1, f1);
  settle(h); assert.equal(m._uniteRelay.rounds.length, 2);
  assert.equal(h.ps('p_0').stats.lpLost, 1);
  m.startRound(2); assert.equal(m._uniteRelay, null); assert.equal(m._normalAliveCount, 0);
  assert.equal(Object.hasOwn(m.publicView(), 'uniteRound'), false);
});
