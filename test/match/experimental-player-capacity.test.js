// Opt-in capacity rules only; ordinary generation, simulation content and golden files are not changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPoolGroups, SharedPool } from '../../server/match/pool.js';
import { collectViolations } from '../../server/match/invariants.js';
import { generateDraft, applyCard } from '../../server/match/choices.js';
import { bossPoolHp, hiddenEligible } from '../../server/match/finalAssault.js';
import { createRng } from '../../server/sim/rng.js';
import { attachAudit } from '../../server/match/audit.js';
import { GameData } from '../../server/match/gamedata.js';
import { DATA, makeMatch, give, giveItem, legalTileFor } from './harness.js';
import { planUnite } from '../../server/match/unite.js';

const exp = (playerCapacity = 20, extra = {}) => ({ revivalEnabled: false, disableSharedPool: false, playerCapacity, ...extra });
const seats = count => Array.from({ length: count }, (_, seat) => ({ seat, playerId: `p_${seat}`, name: `P${seat}`, isBot: false, connected: true }));
const own = ps => [...ps.board.values(), ...ps.hand, ...ps.temp].filter(p => p?.kind === 'chess');
const clean = m => {
  for (const ps of m.order) {
    for (const p of own(ps)) ps.returnCopies(p);
    ps.board.clear(); ps.hand.fill(null); ps.temp.fill(null); ps.offers.length = 0;
    ps.bandId = null; ps.layers = {}; ps.funds = 50; ps.pendingFunds = 0; ps.recompute();
  }
};

for (const [count, sizes] of [[5, [4, 1]], [6, [4, 2]], [7, [4, 3]], [9, [4, 4, 1]], [20, [4, 4, 4, 4, 4]]]) {
  test(`${count} actual players: fixed balanced pool groups and copy conservation through grants/death`, t => {
    const h = makeMatch({ humans: count, experimental: exp(), seed: 713, fake: true }).start();
    const m = h.m; t.after(() => m.dispose()); h.toPrep(1); clean(m);
    assert.deepEqual(m.poolGroups.map(g => g.playerIds.length), sizes);
    assert.equal(m.publicView().playerCapacity, 20);
    assert.deepEqual(m.publicView().poolGroups.map(g => g.playerIds.length), sizes);
    const identities = m.order.map(p => p.pool);
    for (const group of m.poolGroups) for (const [base, entry] of group.pool.entries) {
      const expected = m.gd.poolCopies(base);
      assert.equal(entry.cap, expected, `${base}: complete copies in every group, including groups of three`);
    }
    const base = [...m.pool.entries.keys()].find(id => m.gd.chess(id).tier === 1);
    for (const ps of m.order) assert.ok(ps.acquireChess(base));
    assert.deepEqual(collectViolations(m), []);
    const last = m.order.at(-1); last.eliminate(1);
    assert.deepEqual(m.order.map(p => p.pool), identities, 'death must not regroup surviving seats');
    assert.deepEqual(collectViolations(m), []);
    assert.throws(() => m.poolFor('stranger'), /player card pool/);
    assert.throws(() => m.poolFor(null), /player card pool/);
    // An accounting defect in ANY group, not just the diagnostic first pool, must be detected.
    const pool = m.poolGroups.at(-1).pool; pool.take(base);
    assert.ok(collectViolations(m).some(v => v.includes('!= cap')));
    pool.give(base); assert.deepEqual(collectViolations(m), []);
  });
}

for (const count of [5, 7, 20]) test(`${count} players: disableSharedPool takes priority over grouping/scaling`, t => {
  const h = makeMatch({ humans: count, experimental: exp(20, { disableSharedPool: true }), fake: true, seed: 4 });
  t.after(() => h.m.dispose());
  assert.equal(new Set(h.m.order.map(p => p.pool)).size, count);
  assert.equal(h.m.poolGroups.length, count);
  for (const ps of h.m.order) for (const [id, e] of ps.pool.entries) assert.equal(e.cap, h.m.gd.poolCopies(id));
  assert.deepEqual(collectViolations(h.m), []);
});

test('Match capacity is snapshotted and bounded; solo/default limits and default public shape remain', t => {
  for (const capacity of [8, 12, 16, 20]) {
    const options = exp(capacity);
    const h = makeMatch({ seats: seats(capacity), experimental: options }); t.after(() => h.m.dispose());
    options.playerCapacity = 4;
    assert.equal(h.m.players.size, capacity); assert.equal(h.m.playerCapacity, capacity);
    assert.ok(Object.isFrozen(h.m.experimental));
    assert.throws(() => makeMatch({ humans: capacity + 1, experimental: exp(capacity) }), /capacity/);
  }
  assert.throws(() => makeMatch({ humans: 5 }), /capacity/);
  assert.throws(() => makeMatch({ humans: 5, experimental: exp(4) }), /capacity/);
  assert.throws(() => makeMatch({ mode: 'solo', seats: seats(2), experimental: exp(20) }), /capacity/);
  for (const seat of [-1, 20, 0.5, NaN]) assert.throws(() => makeMatch({ seats: [{ ...seats(1)[0], seat }], experimental: exp() }), /seat index/);
  assert.throws(() => makeMatch({ seats: [seats(2)[0], { ...seats(2)[1], seat: 0 }], experimental: exp() }), /seat index/);
  for (const capacity of [5, 6, 7, 21, Infinity, '20']) assert.throws(() => makeMatch({ experimental: exp(capacity) }), /experimental/);
  const ordinary = makeMatch({ humans: 4 }); t.after(() => ordinary.m.dispose());
  const four = makeMatch({ humans: 4, experimental: exp(4) }); t.after(() => four.m.dispose());
  assert.deepEqual(four.m.publicView(), ordinary.m.publicView());
  assert.equal('playerCapacity' in ordinary.m.publicView(), false);
  assert.equal('poolGroups' in ordinary.m.publicView(), false);
  assert.equal(ordinary.m.playerPools, null);
  assert.throws(() => createPoolGroups(ordinary.m.gd, []), /1..20/);
  assert.throws(() => createPoolGroups(ordinary.m.gd, seats(21)), /1..20/);
  assert.throws(() => new SharedPool(ordinary.m.gd, { scale: Infinity }), /scale/);
});

test('cross-group beacon gifts debit the recipient pool, retry on its exhaustion, and conserve both caps', t => {
  const h = makeMatch({ humans: 7, difficulty: 'FUNNY', experimental: exp(), seed: 147, fake: true }).start();
  const m = h.m; t.after(() => m.dispose()); h.toPrep(1); h.setStage('act2autochess_m04'); clean(m);
  const sender = m.order[0], receiver = m.order[4];
  const plain = [...m.pool.entries.keys()].filter(id => {
    const c = m.gd.chess(id);
    return c.goldenId && c.bonds.length && (c.garrisonIds || []).every(g => DATA.garrisons[g].eventType === 'IN_BATTLE');
  });
  const base = plain.find(id => plain.filter(x => x !== id && m.gd.chess(x).bonds.some(b => m.gd.chess(id).bonds.includes(b))).length >= 2);
  assert.ok(base);
  const mates = plain.filter(x => x !== base && m.gd.chess(x).bonds.some(b => m.gd.chess(base).bonds.includes(b)));
  for (const id of mates.slice(0, 2)) give(m, receiver, id, 'board', legalTileFor(m, receiver, id));
  const original = give(m, sender, m.gd.goldenIdOf(base));
  const beforeSender = sender.pool.left(base), beforeReceiver = receiver.pool.left(base);
  assert.deepEqual(m.handle(sender.playerId, { t: 'g.equip', itemUid: giveItem(m, sender, 'chess_item_5_04_e_a').uid, targetUid: original.uid }), { ok: true });
  const gift = sender.effects.find(e => e.key === 'effect:builtin_gift');
  assert.equal(gift.params.toPlayerId, receiver.playerId);
  assert.equal(sender.pool.left(base), beforeSender + 3);
  const drained = receiver.pool.take(base, beforeReceiver);
  m.dispatch(sender, 'onRoundStart', { round: 2 });
  assert.ok(sender.effects.includes(gift), 'exhausted receiving group keeps the delayed gift');
  assert.equal(own(receiver).some(p => p.id === original.id), false);
  receiver.pool.give(base, drained);
  m.dispatch(sender, 'onRoundStart', { round: 3 });
  const received = own(receiver).find(p => p.id === original.id);
  assert.ok(received); assert.equal(received.poolCopies, 3);
  assert.equal(receiver.pool.left(base), beforeReceiver - 3);
  assert.equal(sender.pool.left(base), beforeSender + 3, 'never re-take the sender group copies');
  assert.equal(sender.effects.includes(gift), false);
  assert.deepEqual(collectViolations(m), []);
});

test('team reinforcement and fixed-list rewards route each recipient to its group/DIY stock', t => {
  const slot = 'chess_char_5_diy1_a';
  const roster = seats(7); roster[4].diy = { [slot]: { charId: 'char_112_siege', skillIndex: 2, uniEquipId: 'uniequip_002_siege' } };
  const h = makeMatch({ seats: roster, experimental: exp(), fake: true, seed: 910 }).start();
  const m = h.m; t.after(() => m.dispose()); h.toPrep(1); clean(m);
  const sender = m.order[0], receiver = m.order[4];
  assert.equal(receiver.poolOf(slot), receiver.diyStock); assert.notEqual(receiver.poolOf(slot), receiver.pool);
  assert.equal(receiver.diyStock.cap(slot), m.gd.poolCopies(slot));
  const drained = [];
  for (const g of m.poolGroups) for (const [id, e] of g.pool.entries) {
    if (e.tier === 5 || m.gd.chess(id).bonds.includes('victoriaShip')) drained.push([g.pool, id, g.pool.take(id, e.left)]);
  }
  const before = receiver.diyStock.left(slot);
  const card = DATA.choices.cards.tactic.find(c => c.effectId === 'allybuff_select_7_7'); assert.ok(card);
  applyCard(m, sender, { kind: 'tactic', family: 'tactic', id: card.effectId, name: card.name, team: true });
  assert.equal(receiver.diyStock.left(slot), before - 1, 'team card uses the teammate own DIY stock');
  assert.equal(own(sender).some(p => p.id === slot), false);
  for (const [pool, id, n] of drained) pool.give(id, n);
  assert.deepEqual(collectViolations(m), []);
  const custom = { kind: 'chess', items: [slot] };
  m.gd.raw = { ...m.gd.raw, choices: { ...m.gd.choices, pools: { ...m.gd.choices.pools, capacity_diy: custom } } };
  const held = receiver.diyStock.take(slot, 99);
  assert.equal(m.rollPool('capacity_diy', { player: receiver }), null, 'fixed list checks DIY stock before group stock');
  receiver.diyStock.give(slot, held);
  assert.equal(m.rollPool('capacity_diy', { player: receiver }).id, slot);
  assert.throws(() => m.rollPool('capacity_diy', { player: 'stranger' }), /player card pool/);
  assert.deepEqual(collectViolations(m), []);
});

for (const [capacity, count] of [[8, 2], [8, 5], [8, 6], [8, 7], [8, 8], [12, 9], [12, 12], [16, 16], [20, 20]]) for (const family of ['bounty', 'supply', 'shop', 'tactic']) {
  test(`${capacity}-mode ${count} alive: ${family} draft has six cards and gives every player one repeated pick`, t => {
    const round = family === 'bounty' ? 3 : 11;
    const modeId = 'mode_multi_normal';
    const data = { ...DATA, choices: { ...DATA.choices, schedule: { ...DATA.choices.schedule,
      [modeId]: { ...DATA.choices.schedule[modeId], rounds: { ...DATA.choices.schedule[modeId].rounds,
        [round]: { ...DATA.choices.schedule[modeId].rounds[round], families: [{ family, weight: 1 }] } } } } } };
    const cardCount = 6;
    const h = makeMatch({ humans: count, experimental: exp(capacity), data, fake: true, seed: 55 });
    const m = h.m; t.after(() => m.dispose()); m.round = round;
    for (const ps of m.order) ps.lp = 28;
    const audit = attachAudit(m);
    m.enterSpDraft(); const s = m.sp;
    assert.equal(s.family, family); assert.equal(s.cards.length, cardCount);
    assert.equal(new Set(s.cards).size, cardCount, 'every legal option is a detached object');
    while (m.spTurn()) {
      const ps = m.players.get(m.spTurn());
      const preferred = s.idx % 6;
      if (!m.spCardAvailable(s.cards[preferred])) {
        assert.equal(s.cards[preferred].kind, 'item');
        assert.equal(m.itemPool.canGain(s.cards[preferred].id), false);
        assert.equal(m.pickCard(ps, preferred).error, 'SOLD_OUT');
        assert.equal(s.picks[ps.playerId], undefined, 'an exhausted attempt never consumes the player confirmation');
      }
      const idx = m.spCardAvailable(s.cards[preferred]) ? preferred : s.cards.find(c => m.spCardAvailable(c))?.idx;
      assert.notEqual(idx, undefined, 'this seeded fixture has enough different legal equipment for all players');
      assert.deepEqual(m.pickCard(ps, idx), { ok: true });
      assert.equal(s.picks[ps.playerId], idx);
      assert.equal(m.pickCard(ps, idx).error, 'ALREADY');
    }
    h.sched.advance(0);
    assert.equal(m.phase, 'PREP', 'the final manual pick advances immediately without any timeout');
    assert.equal(Object.keys(s.picks).length, count);
    assert.equal(new Set(Object.values(s.picks)).size, Math.min(6, count));
    assert.deepEqual(audit.violations, []);
    assert.equal(m.errorCount, 0);
  });
}

test('four-player/solo source cards AND subsequent RNG stream stay unchanged at every expanded player count', () => {
  for (const modeId of ['mode_multi_normal', 'mode_single_normal']) {
    const gd = new GameData(DATA, modeId);
    for (let seed = 1; seed <= 20; seed++) for (const round of [3, 6, 9, 11]) for (const count of [2, 4, 5, 8, 12, 16, 20]) {
      const a = createRng(seed), b = createRng(seed);
      const legacy = generateDraft(gd, a, round);
      const enabled = generateDraft(gd, b, round, { experimental: true, playerCount: count });
      assert.deepEqual(enabled, legacy);
      assert.deepEqual(Array.from({ length: 8 }, () => b()), Array.from({ length: 8 }, () => a()));
    }
  }
});

test('only experimental >4-alive Boss HP and strict hidden threshold scale; default/solo are unchanged', () => {
  for (const modeId of ['mode_multi_normal', 'mode_single_normal']) {
    const gd = new GameData(DATA, modeId);
    for (const count of [1, 2, 3, 4, 5, 6, 7, 9, 20]) {
      const plain = bossPoolHp(gd, 'boss_1', count);
      const enlarged = bossPoolHp(gd, 'boss_1', count, { experimental: true });
      assert.equal(enlarged, !gd.isSolo && count > 4 ? Math.round(gd.boss('boss_1').bloodPoint.NORMAL * count / 4) : plain);
      const threshold = gd.isSolo ? gd.hiddenCore.single : gd.hiddenCore.multi * (count > 4 ? count / 4 : 1);
      assert.equal(hiddenEligible(gd, { layerSum: threshold, teamLp: 2, aliveCount: count, experimental: true }), false);
      assert.equal(hiddenEligible(gd, { layerSum: threshold + 1, teamLp: 2, aliveCount: count, experimental: true }), true);
      assert.equal(hiddenEligible(gd, { layerSum: threshold + 1, teamLp: 1, aliveCount: count, experimental: true }), false);
    }
  }
});

test('twenty-seat revival keeps LP>=11/pay10/once and the unchanged target holdings', t => {
  const h = makeMatch({ humans: 20, experimental: exp(20, { revivalEnabled: true }), fake: true, seed: 777 }).start();
  const m = h.m; t.after(() => m.dispose()); h.toPrep(1);
  const donor = m.order[0], target = m.order.at(-1);
  const before = { hand: target.hand.slice(), board: new Map(target.board), funds: target.funds, layers: { ...target.layers } };
  m.phase = 'SETTLE';
  m._revival = { round: m.round, eligible: new Set([donor.playerId]), windowOpen: true, deadline: m.sched.now() + 10000 };
  target.alive = false; target.pendingDeath = true; target.lp = 0;
  const intent = { matchId: m.battlePrefix, round: m.round, playerId: target.playerId };
  donor.lp = 10; assert.equal(m.revive(donor, intent).error, 'BAD_TARGET');
  donor.lp = 11; assert.deepEqual(m.revive(donor, intent), { ok: true });
  assert.equal(donor.lp, 1); assert.equal(target.lp, 1); assert.equal(target.revived, true);
  assert.deepEqual({ hand: target.hand, board: target.board, funds: target.funds, layers: target.layers }, before);
  assert.equal(m.revive(donor, intent).error, 'BAD_TARGET'); assert.equal(donor.lp, 1);
  assert.deepEqual(collectViolations(m), []);
});

test('twenty seats still get just one original-map unite field with <=2 helpers and all leaker sources', t => {
  const h = makeMatch({ humans: 20, experimental: exp(), fake: true }).start();
  const m = h.m; t.after(() => m.dispose()); h.toPrep(1);
  const results = new Map(m.order.map((p, i) => [p.playerId, { perfect: i < 2,
    leaked: i < 2 ? [] : [{ enemyKey: 'enemy_1007_slime', counted: true }], unitsEnd: [] }]));
  m.lastResults = results;
  const plan = planUnite(m, results);
  assert.equal(plan.helpers.length, 2); assert.equal(plan.leakers.length, 18);
  const opts = m._uniteOpts(plan, 4);
  assert.equal(opts.stageId, m.stageId);
  assert.equal(opts.players.length, 2);
  assert.equal(new Set(opts.spawns.map(s => s.sourcePlayerId)).size, 18);
});
