// Rescue cancels a deferred current SETTLE death in place. Donors need >=11 LP and spend exactly 10.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match, DELAYS } from '../../server/match/Match.js';
import { VirtualScheduler } from '../../server/match/scheduler.js';
import { collectViolations } from '../../server/match/invariants.js';
import { ERR, PHASE } from '../../shared/constants.js';
import { validateC2S, loadoutOptions } from '../../shared/protocol.js';
import { FakeBattle } from './fakeBattle.js';
import { DATA, give, giveItem, chessOfTier, legalTileFor, checkInvariants } from './harness.js';

function scenario(t, o = {}) {
  const sched = new VirtualScheduler();
  const sent = [], broadcasts = [], ended = [];
  const seats = o.seats || Array.from({ length: 4 }, (_, seat) => ({ seat, playerId: `p_${seat}`, name: `P${seat}`, connected: true, isBot: false }));
  FakeBattle.reset();
  FakeBattle.script = (b) => {
    if (o.script) return o.script(b);
    if (b.kind === 'normal') {
      if (o.syntheticNormal?.includes(b.players[0])) return { throwInCtor: true };
      return { leaks: o.leaks || { p_0: 1 }, coins: { p_0: 2, p_1: 3 } };
    }
    return o.uniteFailure ? { throwInCtor: true } : { survivors: o.survivors || { p_0: 1 }, coins: { p_1: 2 } };
  };
  const m = new Match({
    roomCode: 'REVIVAL', mode: 'coop', difficulty: 'NORMAL', data: DATA, seats, seed: 4501, matchNo: o.matchNo ?? 1,
    revivalEnabled: o.enabled ?? true, scheduler: sched, timerScale: o.timerScale,
    BattleClass: FakeBattle, clientCombat: false, botRehearsal: 0,
    send: (id, msg) => { sent.push([id, msg]); return true; }, broadcast: (msg) => broadcasts.push(msg), onEnd: (msg) => ended.push(msg),
  });
  t.after(() => m.dispose());
  const ps = (id) => m.players.get(id);
  for (const p of m.order) p.lp = o.lp?.[p.playerId] ?? (p.playerId === 'p_0' ? 1 : 20);
  m.startRound(1);
  assert.ok(sched.runUntil(() => m.phase === PHASE.PREP));
  const runTo = (phase, round = 1) => {
    assert.ok(sched.runUntil(() => ended.length || (m.phase === phase && m.round === round)));
    assert.equal(m.phase, phase);
    assert.equal(m.round, round);
  };
  const fight = (beforeSettle = o.beforeSettle) => {
    for (const p of m.alivePlayers()) if (!p.isBot) assert.deepEqual(m.handle(p.playerId, { t: 'g.ready', ready: true }), { ok: true });
    if (beforeSettle) { runTo(PHASE.UNITE); beforeSettle({ m, sched, ps }); }
    runTo(PHASE.SETTLE);
  };
  return { m, sched, ps, sent, broadcasts, ended, runTo, fight };
}

function request(m, playerId = 'p_0', extra = {}) {
  const { matchId, round } = m.publicView().revival;
  return { t: 'g.revive', playerId, matchId, round, ...extra };
}
const rescue = (s, donor = 'p_1', target = 'p_0', extra = {}) => s.m.handle(donor, request(s.m, target, extra));
const poolState = (m) => [...m.pool.entries].map(([id, e]) => [id, e.left, e.cap]);
const rngState = (m) => ['rngSetup', 'rngShop', 'rngWaves', 'rngDraft', 'rngBots', 'rngMeta'].map((k) => [k, m[k].state()]);
const assertValid = (m) => {
  assert.deepEqual(collectViolations(m), []);
  // The legacy harness assumes all !alive players are finalized; do not weaken it for ordinary matches.
  if (!m.order.some((p) => p.pendingDeath)) checkInvariants(m);
};
const emptyHoldings = (p) => {
  assert.equal(p.pendingDeath, false);
  assert.equal(p.board.size, 0);
  assert.ok(p.hand.every((x) => x == null));
  assert.ok(p.temp.every((x) => x == null));
  assert.deepEqual(p.shop.slots, []);
  assert.deepEqual(p.offers, []);
  assert.deepEqual(p.bounties, []);
  assert.equal(p.funds, 0);
  assert.equal(p.pendingFunds, 0);
};

const retainedKeys = [
  'board', 'hand', 'temp', 'shop', 'offers', 'funds', 'pendingFunds', 'bounties', 'layers', 'effects', 'counters', 'loadout',
  'bonds', 'round', 'lastResult', 'pendingLayerGains', '_tempDue', 'prepsEnded', 'ready', 'eliminatedRound', 'lpAtFinal',
  'bondCountBonus', 'deployCapBonus', 'deployCapMin', 'deviceOverrides', 'tileOverrides', 'stats', 'bandId',
];
const retained = (p) => structuredClone(Object.fromEntries(retainedKeys.map((k) => [k, p[k]])));
const refs = (p) => Object.fromEntries(retainedKeys.filter((k) => p[k] && typeof p[k] === 'object').map((k) => [k, p[k]]));
const assertRetained = (p, snapshot, originalRefs) => {
  assert.deepEqual(retained(p), snapshot, 'death cancellation preserves every ordinary settled field');
  for (const [k, v] of Object.entries(originalRefs)) assert.equal(p[k], v, `${k} is the same actual object, not a replacement`);
};

function richPending(t, o = {}) {
  const s = scenario(t, o), { m } = s, target = s.ps('p_0');
  const ids = [...chessOfTier(1), ...chessOfTier(2)].filter((id) => m.pool.has(id));
  const boardPiece = give(m, target, ids[0], 'board', legalTileFor(m, target, ids[0]));
  give(m, target, ids[1]);
  const originalCleanup = target.eliminate.bind(target);
  const cleanup = { count: 0 };
  target.eliminate = (...args) => { cleanup.count++; return originalCleanup(...args); };
  let snapshot, originalRefs;
  const defer = m._deferDeath.bind(m);
  m._deferDeath = (p) => {
    if (p === target) { snapshot = retained(p); originalRefs = refs(p); }
    return defer(p);
  };
  s.fight(({ m }) => {
    // Representative late grants/settled state, which are normally usable through the next prep.
    const tempPiece = give(m, target, ids[2], 'temp');
    target._tempDue.set(tempPiece.uid, target.prepsEnded);
    const equipment = Object.entries(DATA.items).filter(([, item]) => item.itemType === 'EQUIP' && !item.isGolden).map(([id]) => id);
    boardPiece.items.push(target.newPiece('item', equipment[0]));
    giveItem(m, target, equipment[1]);
    target.funds = 23;
    target.pendingFunds = 7;
    target.shop.frozen = true;
    target.shop.slots[0] = { kind: 'chess', id: ids[0], basePrice: m.gd.chessPrice(ids[0]), sold: false, frozen: true };
    target.offers.push({ tier: 1, source: 'effect', label: 'retained', slots: [{ kind: 'chess', id: ids[1], price: 0, sold: false }] });
    target.layers[m.gd.bondIds[0]] = 19;
    target.effects.push({ id: 'retained-effect', key: 'test:retained-effect', name: 'Retained', battle: false, counter: 3, data: { marker: 17 } });
    target.counters.retained = 9;
    target.bounties.push({ id: 'retained-bounty', roundsLeft: 3, card: { name: 'Retained', payout: 'kill', coin: 4, enemyKey: 'enemy_1007_slime', count: 1 } });
    const c = Object.values(DATA.chess).find((c) => c.visible && !c.isGolden && loadoutOptions(c, m.gd.chess(c.goldenId)).skills.length > 1);
    assert.ok(c, 'fixture includes a nondefault operator loadout');
    const opt = loadoutOptions(c, m.gd.chess(c.goldenId));
    assert.equal(target.setLoadout({ [c.chessId]: { skill: opt.skills.find((n) => n !== opt.defaultSkill) } }), true);
    target.recompute();
    o.beforeSettle?.({ m, target });
  });
  assert.equal(target.pendingDeath, true);
  assert.equal(cleanup.count, 0, 'lethal settlement has not called eliminate');
  assertRetained(target, snapshot, originalRefs);
  assertValid(m);
  return { ...s, target, boardPiece, cleanup, snapshot, originalRefs };
}

for (const lp of [9, 10, 11, 20]) {
  test(`donor LP${lp}: >=11 required, exactly10 paid, no sacrifice or state refresh`, (t) => {
    const s = scenario(t, { lp: { p_1: lp } });
    const donor = s.ps('p_1'), target = s.ps('p_0');
    const id = chessOfTier(1).find((id) => s.m.pool.has(id));
    const targetPiece = give(s.m, target, id), donorPiece = give(s.m, donor, id);
    s.fight();
    assert.deepEqual(s.m.unitePlan.helpers.map((p) => p.playerId), ['p_1', 'p_2']);
    assert.equal(target.pendingDeath, true);
    assert.equal(target.alive, false);
    assert.equal(targetPiece.poolCopies, 1);
    const state = retained(target), originals = refs(target), pool = poolState(s.m), rng = rngState(s.m);
    const donorBefore = retained(donor), donorLp = donor.lp;
    const deadline = s.m.publicView().revival.deadline;
    assert.equal(deadline - s.sched.now(), 15_000);
    assert.equal(s.m.publicView().revival.minDonorLp, 11);
    const result = rescue(s);
    if (lp < 11) {
      assert.deepEqual(result, { error: ERR.BAD_TARGET, detail: 'revival-lp-insufficient' });
      assert.equal(donor.lp, donorLp);
      assert.deepEqual(retained(donor), donorBefore);
      assert.equal(target.alive, false);
      assert.equal(target.pendingDeath, true);
      assert.equal(target.revived, false);
    } else {
      assert.deepEqual(result, { ok: true });
      assert.equal(donor.lp, lp - 10);
      assert.equal(donor.alive, true);
      assert.equal(donor.pendingDeath, false);
      assert.equal(donorPiece.poolCopies, 1);
      assert.equal(target.lp, 1);
      assert.equal(target.alive, true);
      assert.equal(target.pendingDeath, false);
      assert.equal(target.revived, true);
      assert.equal(donor.stats.lpLost, donorBefore.stats.lpLost + 10);
      assert.equal(donor.stats.perfectRounds, donorBefore.stats.perfectRounds);
      assert.equal(donor.pendingFunds, donorBefore.pendingFunds);
      assert.equal(s.m.publicView().revival.deadline, deadline);
    }
    assertRetained(target, state, originals);
    assert.deepEqual(poolState(s.m), pool);
    assert.deepEqual(rngState(s.m), rng);
    assertValid(s.m);
    assert.equal(s.m.errorCount, 0);
  });
}

test('rich pending state and every actual object survive rescue without reroll, reconstruction or hooks', (t) => {
  const s = richPending(t), { m, target } = s;
  const pool = poolState(m), rng = rngState(m), uid = m.uidSeq;
  let resultHooks = 0, incomeHooks = 0;
  const dispatch = m.dispatch.bind(m);
  m.dispatch = (p, hook, ...rest) => {
    if (hook === 'onBattleResult') resultHooks++;
    if (hook === 'onIncome') incomeHooks++;
    return dispatch(p, hook, ...rest);
  };
  assert.equal(m.publicView().players.find((p) => p.playerId === target.playerId).pendingDeath, true);
  assert.equal(target.privateView().pendingDeath, true);
  assert.ok(s.sent.some(([id, msg]) => id === target.playerId && msg.t === 'm.toast' && msg.text.includes('等待救援')));
  assert.ok(!s.sent.some(([id, msg]) => id === target.playerId && msg.t === 'm.toast' && msg.text.includes('已被淘汰')));
  assert.deepEqual(rescue(s), { ok: true });
  assertRetained(target, s.snapshot, s.originalRefs);
  assert.deepEqual(poolState(m), pool);
  assert.deepEqual(rngState(m), rng);
  assert.equal(m.uidSeq, uid);
  assert.equal(resultHooks, 0);
  assert.equal(incomeHooks, 0);
  assert.equal(s.cleanup.count, 0);
  assert.equal(target.pendingDeath, false);
  assertValid(m);
  const expectedFunds = target.funds + target.pendingFunds + m.gd.income(2);
  const beforeIncomeCalls = [];
  const start = target.startRound.bind(target);
  target.startRound = (r) => { beforeIncomeCalls.push(r); return start(r); };
  s.sched.advance(15_000);
  assert.deepEqual(beforeIncomeCalls, [2]);
  assert.equal(incomeHooks, m.alivePlayers().length, 'normal lifecycle dispatches income exactly once per alive player');
  assert.equal(target.funds, expectedFunds);
  assert.equal(target.pendingFunds, 0);
  assert.equal(target.lp, 1);
  assert.equal(target.board.get([...target.board.keys()][0]), s.boardPiece);
  assert.ok(target.hand.some(Boolean));
  assert.ok(target.temp.some(Boolean));
  assert.equal(target.offers.length, 1);
  assert.equal(target.bounties[0].roundsLeft, 2, 'ordinary settlement decremented once, not again on rescue');
  assert.deepEqual(poolState(m), pool);
  assert.equal(s.cleanup.count, 0);
  assertValid(m);
});

for (const outcome of ['rescued', 'timeout']) test(`upstream gift survives pending death ${outcome} and is delivered once as the original elite`, (t) => {
  const cid = Object.values(DATA.chess).find((c) => c.visible && !c.isGolden && c.tier === 3 && c.goldenId
    && (c.garrisonIds || []).every((id) => DATA.garrisons[id].eventType === 'IN_BATTLE')).chessId;
  const gid = DATA.chess[cid].goldenId;
  const s = richPending(t, { beforeSettle: ({ target }) => target.effects.push({
    id: 'merge-gift', key: 'effect:builtin_gift', hidden: true, battle: false,
    params: { toPlayerId: 'p_2', chessId: gid, bonds: DATA.chess[cid].bonds },
  }) });
  const receiver = s.ps('p_2'), before = s.m.pool.left(cid);
  assert.ok(s.target.effects.some((e) => e.id === 'merge-gift'));
  assert.equal(receiver.allChess().filter((p) => p.id === gid).length, 0);
  if (outcome === 'rescued') assert.deepEqual(rescue(s), { ok: true });
  s.runTo(PHASE.PREP, 2);
  assert.equal(s.target.alive, outcome === 'rescued');
  assert.equal(s.cleanup.count, outcome === 'rescued' ? 0 : 1);
  assert.equal(s.target.effects.some((e) => e.id === 'merge-gift'), false);
  const got = receiver.allChess().filter((p) => p.id === gid);
  assert.equal(got.length, 1);
  assert.equal(got[0].poolCopies, 3);
  assert.equal(s.m.pool.left(cid), before - 3);
  assertValid(s.m);
});

test('upstream prep-end deferred items stay equipped through pending death/rescue and merge only at the next prep', (t) => {
  const HAMMER = 'chess_item_2_03_e_a', GOLDEN = 'chess_item_2_03_e_b';
  let carrier, equipped, pending;
  const s = richPending(t, { beforeSettle: ({ target }) => {
    carrier = [...target.board.values()].find((p) => p.kind === 'chess');
    equipped = target.newPiece('item', HAMMER); carrier.items.push(equipped);
    pending = target.acquireItem(HAMMER, { silent: true, deferMerge: true });
    assert.ok(pending && pending.deferMerge);
  } });
  const before = s.target.stats.itemMerges;
  assert.equal(s.target.find(equipped.uid).area, 'equipped');
  assert.ok(s.target.find(pending.uid));
  assert.deepEqual(rescue(s), { ok: true });
  assert.equal(s.target.find(equipped.uid).area, 'equipped');
  assert.equal(s.target.stats.itemMerges, before);
  s.runTo(PHASE.PREP, 2);
  assert.equal(s.target.stats.itemMerges, before + 1);
  assert.equal(s.target.find(equipped.uid), null);
  assert.equal(s.target.find(pending.uid), null);
  assert.equal([...s.target.hand, ...s.target.temp].filter((p) => p?.id === GOLDEN).length, 1);
  assert.equal(s.cleanup.count, 0);
  assertValid(s.m);
});

test('timeout finalizes an unrescued pending death exactly once before next-round income/pairing', (t) => {
  const s = richPending(t), { m, target } = s;
  const pieces = [...target.board.values(), ...target.hand.filter(Boolean), ...target.temp.filter(Boolean)].filter((p) => p.kind === 'chess');
  const beforePool = poolState(m);
  const expectedReturns = new Map();
  for (const p of pieces) expectedReturns.set(m.gd.baseIdOf(p.id), (expectedReturns.get(m.gd.baseIdOf(p.id)) || 0) + p.poolCopies);
  let targetStarts = 0;
  const start = target.startRound.bind(target);
  target.startRound = (r) => { targetStarts++; return start(r); };
  s.sched.advance(14_999);
  assertRetained(target, s.snapshot, s.originalRefs);
  assert.equal(s.cleanup.count, 0);
  assert.deepEqual(poolState(m), beforePool);
  s.sched.advance(1);
  assert.equal(s.cleanup.count, 1);
  assert.equal(targetStarts, 0);
  assert.equal(target.alive, false);
  assert.equal(target.eliminatedRound, 1);
  emptyHoldings(target);
  for (const [id, left] of beforePool) assert.equal(m.pool.left(id), left + (expectedReturns.get(id) || 0));
  for (const p of pieces) assert.equal(p.poolCopies, 0);
  assert.ok(s.sent.some(([id, msg]) => id === target.playerId && msg.t === 'm.toast' && msg.text.includes('已被淘汰')));
  m._finalizePendingDeaths();
  m.onLeave(target.playerId);
  m.finish({ victory: false, reason: 'test' });
  m.dispose();
  assert.equal(s.cleanup.count, 1, 'timeout/leave/finish/dispose cannot clean the same holdings twice');
  assertValid(m);
});

for (const [label, action] of [
  ['voluntary leave', (s) => s.m.onLeave('p_0')],
  ['match defeat', (s) => s.m.finish({ victory: false, reason: 'defeat' })],
  ['match error', (s) => s.m.finish({ victory: false, reason: 'error' })],
  ['match cancellation', (s) => s.m.finish({ victory: false, reason: 'cancelled' })],
  ['dispose', (s) => s.m.dispose()],
  ['forced next-round transition', (s) => s.m.startRound(2)],
]) {
  test(`${label}: pending holdings receive one normal cleanup, never leak returned copies`, (t) => {
    const s = richPending(t);
    action(s);
    assert.equal(s.cleanup.count, 1);
    emptyHoldings(s.target);
    assert.equal(s.target.alive, false);
    assert.notEqual(rescue(s).ok, true);
    s.m._finalizePendingDeaths();
    s.m.dispose();
    assert.equal(s.cleanup.count, 1);
    assertValid(s.m);
  });
}

test('disconnect/reconnect keeps original pending state and can cancel death without refreshing usage', (t) => {
  const s = richPending(t);
  s.m.onDisconnect('p_0');
  assert.equal(s.target.pendingDeath, true);
  assert.equal(s.cleanup.count, 0);
  assertRetained(s.target, s.snapshot, s.originalRefs);
  s.m.onReconnect('p_0');
  const view = s.sent.filter(([id, x]) => id === 'p_0' && x.t === 'm.public').at(-1)[1];
  assert.equal(view.players.find((p) => p.playerId === 'p_0').pendingDeath, true);
  assert.deepEqual(rescue(s), { ok: true });
  s.m.onDisconnect('p_0');
  s.m.onReconnect('p_0');
  assertRetained(s.target, s.snapshot, s.originalRefs);
  assert.equal(s.target.revived, true);
  assert.equal(s.target.pendingDeath, false);
  assert.equal(s.cleanup.count, 0);
});

test('two donors/duplicate requests spend once and preserve the exact target state', (t) => {
  const s = richPending(t), msg = request(s.m);
  const pool = poolState(s.m);
  assert.deepEqual(s.m.handle('p_1', msg), { ok: true });
  assert.equal(s.m.handle('p_2', { ...msg, rid: 2 }).error, ERR.BAD_TARGET);
  assert.equal(s.m.handle('p_1', msg).error, ERR.BAD_TARGET);
  assert.equal(s.ps('p_1').lp, 10);
  assert.equal(s.ps('p_2').lp, 20);
  assert.equal(s.target.lp, 1);
  assertRetained(s.target, s.snapshot, s.originalRefs);
  assert.deepEqual(poolState(s.m), pool);
});

test('prior-round finalized elimination is not a target, even while a new pending target opens a window', (t) => {
  const s = scenario(t);
  const old = s.ps('p_3');
  give(s.m, old, chessOfTier(1).find((id) => s.m.pool.has(id)));
  old.lp = 0;
  old.eliminate(0);
  s.fight();
  assert.equal(s.m.publicView().revival.windowOpen, true);
  assert.equal(old.pendingDeath, false);
  assert.deepEqual(rescue(s, 'p_1', 'p_3'), { error: ERR.BAD_TARGET, detail: 'revival-target-finalized' });
  assert.equal(s.ps('p_1').lp, 20);
  emptyHoldings(old);
});

test('a finalized old death alone cannot open a rescue window', (t) => {
  const s = scenario(t, { lp: { p_0: 20 } });
  s.ps('p_3').lp = 0;
  s.ps('p_3').eliminate(0);
  s.fight();
  assert.equal(s.m.publicView().revival.windowOpen, false);
  assert.equal(s.m.deadline - s.sched.now(), DELAYS.SETTLE);
});

test('used target dies naturally next round: cleanup immediately, no second rescue even during another valid window', (t) => {
  const s = scenario(t, { script: (b) => b.kind === 'normal'
    ? { leaks: { p_0: 1, ...(b.round === 2 ? { p_3: 1 } : {}) } }
    : { survivors: { p_0: 1, ...(b.round === 2 ? { p_3: 1 } : {}) } } });
  s.ps('p_3').lp = 1;
  s.fight();
  assert.deepEqual(rescue(s), { ok: true });
  s.sched.advance(15_000);
  s.runTo(PHASE.PREP, 2);
  for (const p of s.m.alivePlayers()) s.m.handle(p.playerId, { t: 'g.ready', ready: true });
  s.runTo(PHASE.SETTLE, 2);
  assert.equal(s.ps('p_0').alive, false);
  assert.equal(s.ps('p_0').pendingDeath, false);
  assert.equal(s.ps('p_0').revived, true);
  emptyHoldings(s.ps('p_0'));
  assert.equal(s.ps('p_3').pendingDeath, true);
  assert.equal(s.m.publicView().revival.windowOpen, true);
  assert.equal(rescue(s, 'p_2').error, ERR.BAD_TARGET);
  assert.equal(s.ps('p_2').lp, 20);
  assert.deepEqual(rescue(s, 'p_2', 'p_3'), { ok: true });
  assertValid(s.m);
});

test('only a genuine helper can donate; an alive leaker and an unselected perfect teammate cannot', (t) => {
  const s = scenario(t, { script: (b) => b.kind === 'normal' ? { leaks: { p_0: 1, p_3: 1 } } : { survivors: { p_0: 1, p_3: 1 } }, lp: { p_3: 20 } });
  s.fight();
  assert.deepEqual(s.m.publicView().revival.eligible, ['p_1', 'p_2']);
  assert.deepEqual(rescue(s, 'p_3'), { error: ERR.BAD_TARGET, detail: 'revival-not-helper' });
  const other = scenario(t);
  other.fight();
  assert.equal(other.m.lastResults.get('p_3').perfect, true);
  assert.deepEqual(rescue(other, 'p_3'), { error: ERR.BAD_TARGET, detail: 'revival-not-helper' });
});

for (const [label, options] of [
  ['no unite', { leaks: {}, survivors: {} }],
  ['synthetic unite', { uniteFailure: true }],
  ['all synthetic normal helpers', { syntheticNormal: ['p_1', 'p_2', 'p_3'] }],
  ['all donors LP10', { lp: { p_1: 10, p_2: 10 } }],
  ['no current lethal target', { lp: { p_0: 20 } }],
  ['disabled rule', { enabled: false }],
  ['truthy nonboolean activation', { enabled: 'yes' }],
]) {
  test(`${label}: normal immediate elimination and normal SETTLE delay are unchanged`, (t) => {
    const s = scenario(t, options);
    s.fight();
    assert.equal(s.m.publicView().revival.windowOpen, false);
    assert.equal(s.m.publicView().revival.deadline, 0);
    assert.deepEqual(s.m.publicView().revival.eligible, []);
    assert.equal(s.m.deadline - s.sched.now(), DELAYS.SETTLE);
    assert.equal(s.ps('p_0').pendingDeath, false);
    if (!s.ps('p_0').alive) emptyHoldings(s.ps('p_0'));
    assert.equal(rescue(s).error, ERR.WRONG_PHASE);
    s.sched.advance(DELAYS.SETTLE);
    assert.equal(s.m.round, 2);
    assertValid(s.m);
  });
}

for (const [label, mutate] of [
  ['counted leak', (m) => m.lastResults.get('p_1').leaked.push({ counted: true })],
  ['perfect:false', (m) => { m.lastResults.get('p_1').perfect = false; }],
  ['synthetic normal', (m) => { m.lastResults.get('p_1').synthetic = true; }],
  ['missing normal result', (m) => m.lastResults.delete('p_1')],
  ['missing unite participant result', (_m, b) => { const result = b.result.bind(b); b.result = () => { const r = result(); r.perPlayer.p_2.leaked = r.perPlayer.p_1.leaked; delete r.perPlayer.p_1; return r; }; }],
  ['absent actual field participant', (m) => { m.fields[0].players = ['p_2']; }],
]) {
  test(`${label}: helper plan alone cannot qualify a donor`, (t) => {
    const s = scenario(t, { beforeSettle: ({ m }) => mutate(m, m.fields[0].battle) });
    s.fight();
    assert.equal(s.m.publicView().revival.windowOpen, true);
    assert.deepEqual(s.m.publicView().revival.eligible, ['p_2']);
    assert.deepEqual(rescue(s), { error: ERR.BAD_TARGET, detail: 'revival-not-helper' });
  });
}

test('uncounted normal leak does not disqualify an actual helper; cancelled unite does', (t) => {
  const s = scenario(t, { beforeSettle: ({ m }) => m.lastResults.get('p_1').leaked.push({ counted: false }) });
  s.fight();
  assert.deepEqual(rescue(s), { ok: true });
  const cancelled = scenario(t, { beforeSettle: ({ m }) => m.fields[0].battle.forceEnd('left') });
  cancelled.fight();
  assert.equal(cancelled.m.publicView().revival.windowOpen, false);
  assert.equal(cancelled.ps('p_0').pendingDeath, false);
});

test('normal synthetic provenance is retained, including missing per-player results', (t) => {
  const s = scenario(t, { syntheticNormal: ['p_1'], beforeSettle: ({ m }) => assert.equal(m.lastResults.get('p_1').synthetic, true) });
  s.fight();
  assert.ok(!s.m.publicView().revival.eligible.includes('p_1'));
  const other = scenario(t);
  other.m.startCombat();
  other.m._finishCombat((f) => f.players[0] === 'p_1' ? { perPlayer: {} } : { perPlayer: { [f.players[0]]: { leaked: [], perfect: true } } });
  assert.equal(other.m.lastResults.get('p_1').synthetic, true);
});

test('live donor departure/elimination revokes qualification; pending target departure finalizes immediately', (t) => {
  const s = richPending(t);
  s.m.onLeave('p_1');
  assert.equal(rescue(s).error, ERR.NOT_IN_ROOM);
  assert.deepEqual(s.m.publicView().revival.eligible, ['p_2']);
  s.m.onLeave('p_0');
  assert.equal(s.cleanup.count, 1);
  assert.equal(s.m.publicView().players.find((p) => p.playerId === 'p_0').left, true);
  assert.equal(rescue(s, 'p_2').error, ERR.BAD_TARGET);
  s.ps('p_2').lp = 0;
  s.ps('p_2').eliminate(1);
  assert.equal(rescue(s, 'p_2').error, ERR.ELIMINATED);
  assert.deepEqual(s.m.publicView().revival.eligible, []);
});

test('last human abandonment finalizes pending bot holdings and cancels the window', (t) => {
  const seats = [{ seat: 0, playerId: 'p_0', name: 'Bot', isBot: true }, { seat: 1, playerId: 'p_1', name: 'Human', connected: true }];
  const s = scenario(t, { seats });
  const piece = give(s.m, s.ps('p_0'), chessOfTier(1).find((id) => s.m.pool.has(id)));
  s.fight();
  assert.equal(s.ps('p_0').pendingDeath, true);
  s.m.onLeave('p_1');
  assert.equal(s.ended.length, 1);
  assert.equal(s.ended[0].reason, 'abandoned');
  emptyHoldings(s.ps('p_0'));
  assert.equal(piece.poolCopies, 0);
  assert.equal(s.m.publicView().revival.windowOpen, false);
  assertValid(s.m);
});

test('AI may be a pending rescue target but cannot initiate, even after actually helping', (t) => {
  const seats = [
    { seat: 0, playerId: 'p_0', name: 'AI target', isBot: true },
    { seat: 1, playerId: 'p_1', name: 'Donor', connected: true },
    { seat: 2, playerId: 'p_2', name: 'AI helper', isBot: true },
    { seat: 3, playerId: 'p_3', name: 'Other', connected: true },
  ];
  const s = scenario(t, { seats });
  s.fight();
  assert.equal(s.m.unitePlan.helpers.some((p) => p.playerId === 'p_2'), true);
  assert.equal(rescue(s, 'p_2').error, ERR.NOT_IN_ROOM);
  assert.deepEqual(rescue(s), { ok: true });
  assert.equal(s.ps('p_0').lp, 1);
  assert.equal(s.ps('p_0').pendingDeath, false);
});

for (const [label, extra, code, detail] of [
  ['old round', { round: 0 }, ERR.WRONG_PHASE, 'stale-round'],
  ['future round', { round: 2 }, ERR.WRONG_PHASE, 'stale-round'],
  ['noninteger round', { round: 1.5 }, ERR.WRONG_PHASE, 'stale-round'],
  ['missing round', { round: undefined }, ERR.WRONG_PHASE, 'stale-round'],
  ['other match', { matchId: 'other-1' }, ERR.BAD_TARGET, 'stale-match'],
  ['missing match', { matchId: undefined }, ERR.BAD_TARGET, 'stale-match'],
]) {
  test(`${label} is rejected without LP or retained-state mutations`, (t) => {
    const s = scenario(t);
    s.fight();
    const before = retained(s.ps('p_0'));
    assert.deepEqual(rescue(s, 'p_1', 'p_0', extra), { error: code, detail });
    assert.equal(s.ps('p_1').lp, 20);
    assert.equal(s.ps('p_0').revived, false);
    assert.deepEqual(retained(s.ps('p_0')), before);
  });
}

test('new match number cannot accept a previous match rescue request', (t) => {
  const first = scenario(t);
  first.fight();
  const old = request(first.m);
  const second = scenario(t, { matchNo: 2 });
  second.fight();
  assert.deepEqual(second.m.handle('p_1', old), { error: ERR.BAD_TARGET, detail: 'stale-match' });
  assert.equal(second.ps('p_1').lp, 20);
});

for (const target of ['p_1', 'p_2', 'unknown', undefined]) {
  test(`target ${target}: self, alive or absent cannot be rescued`, (t) => {
    const s = scenario(t);
    s.fight();
    const msg = request(s.m);
    msg.playerId = target;
    assert.equal(s.m.handle('p_1', msg).error, ERR.BAD_TARGET);
    assert.equal(s.ps('p_1').lp, 20);
    assert.equal(s.ps('p_0').pendingDeath, true);
  });
}

test('internal window state and deadline, not client flags, gate rescue before callback execution', (t) => {
  const s = richPending(t), msg = request(s.m);
  s.m._revival.windowOpen = false;
  assert.equal(s.m.handle('p_1', { ...msg, windowOpen: true }).error, ERR.WRONG_PHASE);
  s.m._revival.windowOpen = true;
  s.sched.t = s.m._revival.deadline;
  assert.equal(s.m.phase, PHASE.SETTLE);
  assert.equal(s.m.handle('p_1', msg).error, ERR.WRONG_PHASE);
  assert.equal(s.ps('p_1').lp, 20);
  assertRetained(s.target, s.snapshot, s.originalRefs);
  s.sched.advance(0);
  assert.equal(s.cleanup.count, 1);
  assert.equal(s.m.round, 2);
});

for (const phase of [PHASE.ROUND_START, PHASE.SP_DRAFT, PHASE.PREP, PHASE.COMBAT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]) {
  test(`${phase}: a frozen valid snapshot does not permit mid-phase rescue`, (t) => {
    const s = scenario(t);
    s.fight();
    const msg = request(s.m);
    s.m.phase = phase;
    assert.equal(s.m.handle('p_1', msg).error, ERR.WRONG_PHASE);
    assert.equal(s.m.publicView().revival.windowOpen, false);
    assert.equal(s.ps('p_1').lp, 20);
    s.m.phase = PHASE.SETTLE;
  });
}

test('shared boss LP is never eligible and future pairing includes a rescued target, not unresolved pending deaths', (t) => {
  const s = richPending(t);
  s.m.teamLp = 40;
  assert.equal(rescue(s).error, ERR.WRONG_PHASE);
  s.m.teamLp = null;
  assert.deepEqual(rescue(s), { ok: true });
  s.m.startRound(s.m.gd.bossRound);
  assert.ok(s.m.bossWaves.flatMap((g) => g.players).includes('p_0'));
  assert.equal(s.target.lp, 1);
  const other = scenario(t);
  other.fight();
  other.m.startRound(other.m.gd.bossRound);
  assert.ok(!other.m.bossWaves.flatMap((g) => g.players).includes('p_0'));
  emptyHoldings(other.ps('p_0'));
});

test('pending and rescued players cannot mutate economy/board during SETTLE; private reconnect view still retains it', (t) => {
  const s = richPending(t);
  const intents = [
    { t: 'g.buy', slot: 0 }, { t: 'g.refresh' }, { t: 'g.levelUp' },
    { t: 'g.move', uid: s.boardPiece.uid, to: { area: 'hand', idx: 0 } },
  ];
  for (const msg of intents) assert.equal(s.m.handle('p_0', msg).error, ERR.ELIMINATED);
  assertRetained(s.target, s.snapshot, s.originalRefs);
  const priv = s.target.privateView();
  assert.equal(priv.pendingDeath, true);
  assert.equal(priv.canReady, false);
  assert.equal(priv.board[0].uid, s.boardPiece.uid);
  assert.equal(priv.funds, s.snapshot.funds);
  assert.deepEqual(rescue(s), { ok: true });
  for (const msg of intents) assert.equal(s.m.handle('p_0', msg).error, ERR.WRONG_PHASE);
  assertRetained(s.target, s.snapshot, s.originalRefs);
});

for (const timing of ['before-expiry', 'after-expiry', 'before-finish', 'after-finish']) {
  test(`rescue ${timing}: exactly one race outcome without clearing a successfully rescued state`, (t) => {
    const s = richPending(t), donor = s.ps('p_1');
    if (timing === 'before-expiry') {
      s.sched.advance(14_999);
      assert.deepEqual(rescue(s), { ok: true });
      assertRetained(s.target, s.snapshot, s.originalRefs);
      s.sched.advance(1);
      assert.equal(s.cleanup.count, 0);
      assert.equal(s.target.alive, true);
      assert.equal(donor.lp, 10);
    } else if (timing === 'after-expiry') {
      s.sched.advance(15_000);
      assert.equal(rescue(s).error, ERR.WRONG_PHASE);
      assert.equal(s.cleanup.count, 1);
      assert.equal(donor.lp, 20);
      emptyHoldings(s.target);
    } else if (timing === 'before-finish') {
      assert.deepEqual(rescue(s), { ok: true });
      s.m.finish({ victory: false, reason: 'cancelled' });
      assertRetained(s.target, s.snapshot, s.originalRefs);
      assert.equal(s.cleanup.count, 0);
      assert.equal(donor.lp, 10);
    } else {
      s.m.finish({ victory: false, reason: 'cancelled' });
      assert.equal(rescue(s).error, ERR.WRONG_PHASE);
      assert.equal(s.cleanup.count, 1);
      assert.equal(donor.lp, 20);
      emptyHoldings(s.target);
    }
    assertValid(s.m);
  });
}

test('duplicate settle does not reapply settlement/income or close a legitimate window', (t) => {
  const s = richPending(t);
  const before = retained(s.target), deadline = s.m.publicView().revival.deadline;
  s.m.settle(s.m.unitePlan, FakeBattle.instances.find((b) => b.kind === 'unite').result());
  assert.deepEqual(retained(s.target), before);
  assert.equal(s.m.publicView().revival.deadline, deadline);
  assert.equal(s.target.pendingDeath, true);
  assert.equal(s.cleanup.count, 0);
});

test('pending-death invariants retain full pool/UID/shop checking and do not exempt finalized players', (t) => {
  const s = richPending(t), { m, target } = s;
  assertValid(m);
  target.pendingDeath = false;
  assert.ok(collectViolations(m).some((v) => v.includes('eliminated but keeps')));
  target.pendingDeath = true;
  target.revived = true;
  assert.ok(collectViolations(m).some((v) => v.includes('invalid pending death')));
  target.revived = false;
  m.phase = PHASE.PREP;
  assert.ok(collectViolations(m).some((v) => v.includes('invalid pending death')));
  m.phase = PHASE.SETTLE;
  const oldHand = target.hand[0];
  target.hand[0] = s.boardPiece;
  assert.ok(collectViolations(m).some((v) => v.includes('duplicate uid')));
  target.hand[0] = oldHand;
  const entry = m.pool.entries.get(m.gd.baseIdOf(s.boardPiece.id));
  entry.left--;
  assert.ok(collectViolations(m).some((v) => v.includes('pool ')));
  entry.left++;
  const slots = target.shop.slots;
  target.shop.slots = [];
  assert.ok(collectViolations(m).some((v) => v.includes('shop slots for layout')));
  target.shop.slots = slots;
  assertValid(m);
});

test('scaled and zero-scale virtual timers retain bounded settlement and finalize cleanly', (t) => {
  const s = scenario(t, { timerScale: 0.1 });
  s.fight();
  assert.equal(s.m.publicView().revival.deadline - s.sched.now(), 1500);
  assert.deepEqual(rescue(s), { ok: true });
  const zero = scenario(t, { timerScale: 0 });
  zero.fight();
  assert.equal(zero.m.publicView().revival.windowOpen, false);
  assert.equal(rescue(zero).error, ERR.WRONG_PHASE);
  zero.sched.advance(0);
  assert.equal(zero.ps('p_0').pendingDeath, false);
  emptyHoldings(zero.ps('p_0'));
});

test('protocol requires target + round + match identity', () => {
  const valid = { t: 'g.revive', playerId: 'p_0', round: 1, matchId: '3h1-1' };
  assert.equal(validateC2S(valid), null);
  for (const key of ['playerId', 'round', 'matchId']) {
    const invalid = { ...valid };
    delete invalid[key];
    assert.equal(validateC2S(invalid), `bad field ${key}`);
  }
  assert.equal(validateC2S({ ...valid, round: 1.5 }), 'bad field round');
});
