// Configured capacity, never a living-player threshold: reusable expanded drafts and fixed twenty-seat pools.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ERR } from '../../shared/constants.js';
import { generateDraft } from '../../server/match/choices.js';
import { createRng } from '../../server/sim/rng.js';
import { createRegistry } from '../../server/match/effectsMeta.js';
import { attachAudit } from '../../server/match/audit.js';
import { botPickBand } from '../../server/match/bot.js';
import { collectViolations } from '../../server/match/invariants.js';
import { makeMatch, DATA, checkInvariants } from './harness.js';
import { makeBattle, chessRec } from '../helpers/battleHarness.js';

const rules = (capacity = 20, extra = {}) => ({ revivalEnabled: false, disableSharedPool: false, playerCapacity: capacity, ...extra });
const forced = family => ({ ...DATA, choices: { ...DATA.choices, schedule: { ...DATA.choices.schedule,
  mode_multi_normal: { ...DATA.choices.schedule.mode_multi_normal, rounds: { ...DATA.choices.schedule.mode_multi_normal.rounds,
    3: { ...DATA.choices.schedule.mode_multi_normal.rounds[3], families: [{ family, weight: 1 }] } } } } } });
const make = (t, count = 20, extra = {}) => {
  const h = makeMatch({ humans: count, experimental: rules(), fake: true, seed: 713, ...extra });
  t.after(() => h.m.dispose()); return h;
};
const enterBand = h => {
  h.start(); for (const ps of h.m.order) if (!ps.isBot) assert.deepEqual(h.m.handle(ps.playerId, { t: 'g.infoReady' }), { ok: true });
  h.sched.advance(0); assert.equal(h.m.phase, 'BAND_DRAFT');
};

for (let count = 1; count <= 20; count++) test(`twenty target with ${count} participants keeps consecutive four-seat chunks at ordinary copy caps`, t => {
  const h = make(t, count), m = h.m;
  const sizes = Array.from({ length: Math.ceil(count / 4) }, (_, i) => Math.min(4, count - i * 4));
  assert.deepEqual(m.poolGroups.map(g => g.playerIds.length), sizes);
  assert.deepEqual(m.poolGroups.flatMap(g => g.playerIds), m.order.map(p => p.playerId));
  for (const group of m.poolGroups) for (const [id, e] of group.pool.entries) assert.equal(e.cap, m.gd.poolCopies(id));
  const groups = m.poolGroups.map(g => g.playerIds.slice()), pools = m.order.map(p => p.pool);
  m.order.at(-1).eliminate(1);
  assert.deepEqual(m.poolGroups.map(g => g.playerIds), groups); assert.deepEqual(m.order.map(p => p.pool), pools);
  assert.deepEqual(collectViolations(m), []);
});

test('twenty sparse/reversed seat input groups by actual seat order, not pid or occupied-seat modulo', t => {
  const roster = [0, 2, 4, 6, 8, 10, 12, 14, 19].map((seat, i) => ({ seat, playerId: `reverse_${9 - i}`, name: `Seat${seat}`, isBot: false, connected: true })).reverse();
  const h = make(t, 9, { seats: roster });
  assert.deepEqual(h.m.poolGroups.map(g => g.playerIds), [['reverse_9', 'reverse_8', 'reverse_7', 'reverse_6'], ['reverse_5', 'reverse_4', 'reverse_3', 'reverse_2'], ['reverse_1']]);
});

test('twenty partial tail cannot borrow first-group copies; promotion, sale and departure keep exact pool accounting', t => {
  const h = make(t, 9), m = h.m; m.phase = 'PREP'; m.round = 1;
  for (const ps of m.order) ps.lp = 28;
  const [a, b] = [m.order[0], m.order[8]], base = [...a.pool.entries].find(([, e]) => e.tier === 1)[0];
  const cap = a.pool.cap(base);
  for (let i = 0; i < 3; i++) assert.ok(a.acquireChess(base));
  const elite = [...a.hand, ...a.temp].find(p => p && m.gd.isGolden(p.id)); assert.ok(elite);
  assert.equal(elite.poolCopies, 3); assert.equal(a.pool.left(base), cap - 3); assert.equal(b.pool.left(base), cap);
  assert.deepEqual(a.sell(elite.uid), { ok: true }); assert.equal(a.pool.left(base), cap);
  assert.ok(b.acquireChess(base)); assert.equal(b.pool.left(base), cap - 1); assert.equal(a.pool.left(base), cap);
  const pools = m.poolGroups.map(g => g.pool); b.eliminate(1);
  assert.equal(b.pool.left(base), cap); assert.deepEqual(m.poolGroups.map(g => g.pool), pools);
  assert.deepEqual(collectViolations(m), []);
});

for (const independent of [false, true]) test(`Mimic overdraw stays in its ${independent ? 'private' : 'four-seat'} pool and both grouped invariant checkers accept the signed balance`, t => {
  const h = make(t, 9, { experimental: rules(20, { disableSharedPool: independent }) }), m = h.m;
  m.phase = 'PREP'; m.round = 1;
  for (const ps of m.order) ps.lp = 28;
  const a = m.order[0], tail = m.order[8], base = [...a.pool.entries].find(([, e]) => e.tier === 6)[0];
  const cap = a.pool.cap(base);
  assert.equal(cap, 10, 'the co-op shared tier VI capacity, including in a complete private pool');
  for (let i = 0; i <= cap; i++) assert.ok(a.acquireChess(base));
  assert.equal(a.pool.entries.get(base).left, -1, 'special grants retain full occupation beyond stock');
  const target = a.allChess().find(c => c.id === base);
  assert.ok(target);
  const mimic = a.acquireItem('chess_item_5_05_e_a'); assert.ok(mimic);
  assert.deepEqual(a.equip(mimic.uid, target.uid), { ok: true });
  assert.equal(a.pool.entries.get(base).left, -2, 'Mimic completes the third-copy branch beyond stock');
  assert.equal(a.pool.left(base), 0); assert.equal(a.pool.snapshot()[base], 0);
  assert.equal(a.pool.totalLeft(), [...a.pool.entries.values()].reduce((sum, e) => sum + Math.max(0, e.left), 0));
  assert.equal(tail.pool.left(base), tail.pool.cap(base), 'another group never pays for the overdraw');
  checkInvariants(m);
  const elite = a.allChess().find(c => m.gd.baseIdOf(c.id) === base && m.gd.isGolden(c.id)); assert.ok(elite);
  assert.deepEqual(a.sell(elite.uid), { ok: true });
  assert.equal(a.pool.left(base), 1, 'returning three occupied copies clears only the actual deficit');
  checkInvariants(m);
});

test('disableSharedPool takes precedence over fixed twenty chunks and grants each participant a complete private pool', t => {
  const h = make(t, 9, { experimental: rules(20, { disableSharedPool: true }) });
  assert.equal(h.m.poolGroups.length, 9); assert.equal(new Set(h.m.order.map(p => p.pool)).size, 9);
  for (const ps of h.m.order) for (const [id, e] of ps.pool.entries) assert.equal(e.cap, h.m.gd.poolCopies(id));
});

for (const [capacity, count, sizes, scale] of [[4, 4, [4], 1], [8, 2, [2], 1], [8, 5, [5], 1.25], [12, 9, [3, 3, 3], 1], [16, 13, [4, 3, 3, 3], 1]]) {
  test(`non-twenty ${capacity}-mode with ${count} participants retains prior pools and six-card draft RNG`, t => {
    const h = make(t, count, { experimental: rules(capacity) }), m = h.m, repeat = capacity > 4;
    assert.equal(m.twentyPlayerMode, false); assert.deepEqual(m.poolGroups.map(g => g.playerIds.length), sizes);
    for (const g of m.poolGroups) for (const [id, e] of g.pool.entries) assert.equal(e.cap, Math.ceil(m.gd.poolCopies(id) * scale));
    enterBand(h); assert.equal(m.publicView().draft.allowRepeat === true, repeat);
    const first = m.players.get(m.draftTurn()); assert.deepEqual(m.pickBand(first, 'band_bldsk'), { ok: true });
    const band = m.pickBand(m.players.get(m.draftTurn()), 'band_bldsk');
    assert.deepEqual(repeat ? band : { error: band.error }, repeat ? { ok: true } : { error: ERR.BAD_TARGET });
    m.round = 3;
    const rng = createRng(m.rngDraft.state()), order = m.alivePlayers().map(p => p.playerId);
    const original = generateDraft(m.gd, rng, 3, { stageId: m.stageId, bondAvailable: id => m.bondLive(id) });
    rng.shuffle(order); m.enterSpDraft();
    assert.deepEqual(m.sp.cards, original.cards); assert.deepEqual(m.sp.order, order); assert.equal(m.rngDraft.state(), rng.state());
    assert.equal(m.sp.cards.length, 6); assert.equal(m.publicView().sp.allowRepeat === true, repeat);
    const picker = m.players.get(m.spTurn()); assert.deepEqual(m.pickCard(picker, 0), { ok: true });
    const choice = m.pickCard(m.players.get(m.spTurn()), 0);
    assert.deepEqual(repeat ? choice : { error: choice.error }, repeat ? { ok: true } : { error: ERR.SOLD_OUT });
  });
}

for (const capacity of [8, 12, 16, 20]) test(`${capacity}-mode humans may all choose the same legal band once; skip, focus and turns stay authoritative`, t => {
  const h = make(t, capacity, { experimental: rules(capacity) }), m = h.m, audit = attachAudit(m); enterBand(h);
  assert.equal(m.publicView().draft.allowRepeat, true);
  const first = m.players.get(m.draftTurn()), second = m.players.get(m.draft.order[1]);
  assert.equal(m.pickBand(second, 'band_bldsk').error, ERR.NOT_YOUR_TURN);
  assert.deepEqual(m.skipBand(first), { ok: true }); assert.equal(m.draft.order.at(-1), first.playerId);
  for (const ps of m.order) assert.deepEqual(m.bandFocus(ps, 'band_bldsk'), { ok: true });
  while (m.draftTurn()) {
    const ps = m.players.get(m.draftTurn()); assert.deepEqual(m.pickBand(ps, 'band_bldsk'), { ok: true });
    assert.equal(m.pickBand(ps, 'band_bldsk').error, ERR.ALREADY);
    assert.equal(m.bandFocus(ps, 'band_bldsk').error, ERR.ALREADY);
  }
  h.sched.advance(0); assert.equal(m.phase, 'BATTLE_CHECK');
  assert.equal(Object.keys(m.draft.picks).length, capacity); assert.equal(new Set(Object.values(m.draft.picks)).size, 1);
  assert.ok(m.order.every(ps => ps.bandId === 'band_bldsk' && ps.lp === m.gd.startLp('band_bldsk')));
  assert.equal(new Set(m.order.map(ps => ps.counters)).size, capacity); assert.deepEqual(audit.violations, []);
});

for (const capacity of [8, 12, 16, 20]) test(`${capacity}-mode repeated timeout defaults and duplicate-band handlers maintain separate counters`, t => {
  const registry = createRegistry({ log: { warn() {}, error() {}, info() {} } });
  registry.register('band:band_bldsk', { onRoundStart(ctx) { ctx.incCounter('same-band'); ctx.addFunds(2, 'band'); } });
  const h = make(t, 5, { registry, experimental: rules(capacity) }), m = h.m; enterBand(h);
  for (let i = 0; i < 5; i++) { assert.equal(m.defaultBand(m.draftTurn()), 'band_bldsk'); h.sched.advance(m.bandTurnMs()); }
  h.sched.advance(0); assert.equal(new Set(Object.values(m.draft.picks)).size, 1);
  m.round = 1;
  m.dispatch(m.order[0], 'onRoundStart', { round: 1 });
  assert.equal(m.order[0].counters['same-band'], 1); assert.ok(m.order.slice(1).every(ps => !ps.counters['same-band']));
  for (const ps of m.order.slice(1)) m.dispatch(ps, 'onRoundStart', { round: 1 });
  assert.ok(m.order.every(ps => ps.counters['same-band'] === 1 && ps.funds === 2));
});

for (const [capacity, count] of [[8, 2], [8, 5], [8, 8], [12, 12], [16, 16], ...[1, 2, 4, 5, 6, 9, 17, 20].map(count => [20, count])]) for (const family of ['bounty', 'supply', 'shop', 'tactic']) {
  test(`${capacity}-mode ${count} living ${family}: six source options, repeat permission and one confirmation per player within stock`, t => {
    const h = make(t, count, { experimental: rules(capacity), data: forced(family) }), m = h.m; m.round = 3;
    for (const ps of m.order) ps.lp = 28;
    const audit = attachAudit(m); m.enterSpDraft(); const draft = m.sp;
    assert.equal(draft.cards.length, 6); assert.equal(draft.family, family); assert.equal(m.publicView().sp.allowRepeat, true);
    const options = structuredClone(draft.cards), first = draft.cards[0];
    const firstStock = first.kind === 'item' ? Math.floor(m.itemPool.left(first.id) / m.itemPool.need(first.id)) : Infinity;
    assert.ok(draft.cards.every((card, i) => card.idx === i));
    if (count > 1) assert.equal(m.pickCard(m.players.get(draft.order[1]), 0).error, ERR.NOT_YOUR_TURN);
    let confirmed = 0;
    while (m.spTurn()) {
      const ps = m.players.get(m.spTurn()); assert.equal(m.pickCard(ps, 6).error, ERR.BAD_TARGET);
      if (!m.spCardAvailable(first)) {
        assert.equal(first.kind, 'item', 'taken metadata alone cannot exhaust repeatable bounty/tactic cards');
        assert.equal(m.itemPool.canGain(first.id), false);
        assert.equal(m.pickCard(ps, 0).error, ERR.SOLD_OUT);
        assert.equal(draft.picks[ps.playerId], undefined, 'a rejected exhausted card consumes no confirmation');
      }
      const card = draft.cards.find(c => m.spCardAvailable(c));
      if (!card) {
        assert.ok(draft.cards.every(c => c.kind === 'item' && !m.itemPool.canGain(c.id)), 'only complete stock exhaustion can end before all picks');
        break;
      }
      assert.deepEqual(m.pickCard(ps, card.idx), { ok: true }); assert.equal(draft.picks[ps.playerId], card.idx);
      assert.equal(m.pickCard(ps, card.idx).error, ERR.ALREADY); confirmed++;
    }
    h.sched.advance(0); assert.equal(m.phase, 'PREP');
    assert.equal(Object.keys(draft.picks).length, confirmed);
    assert.equal(Object.values(draft.picks).filter(idx => idx === 0).length, Math.min(count, firstStock));
    if (first.kind !== 'item') {
      assert.equal(confirmed, count); assert.ok(Object.values(draft.picks).every(idx => idx === 0), 'unlimited bounty/tactic choices remain fully repeatable');
    }
    assert.equal(draft.taken[0], draft.order[0]); assert.deepEqual(draft.cards, options);
    assert.equal(m.errorCount, 0); assert.deepEqual(audit.violations, []);
  });
}

for (const capacity of [8, 12, 16, 20]) test(`${capacity}-mode repeated team choices isolate nested content mutations per picker and recipient`, t => {
  const chosen = DATA.choices.cards.tactic.find(c => c.team); assert.ok(chosen);
  const data = forced('tactic'); data.choices = { ...data.choices, cards: { ...data.choices.cards, tactic: [chosen] } };
  const registry = createRegistry({ log: { warn() {}, error() {}, info() {} } });
  const calls = new Map();
  registry.register(`choice:${chosen.effectId}`, { onChoicePick(ctx, ev) {
    const seen = calls.get(ctx.playerId) || []; seen.push(ev.picker); calls.set(ctx.playerId, seen);
    assert.equal(ctx.source.card.nested.count, 0); ctx.source.card.nested.count++;
    ctx.incCounter('repeat-team'); ctx.source.card.id = 'mutated-test-copy'; ctx.source.card.team = false;
  } });
  const h = make(t, capacity, { data, registry, experimental: rules(capacity) }), m = h.m; m.round = 3;
  for (const ps of m.order) ps.lp = 28;
  m.enterSpDraft(); m.sp.cards[0].nested = { count: 0 }; const draft = m.sp, source = structuredClone(draft.cards);
  while (m.spTurn()) { const ps = m.players.get(m.spTurn()); assert.deepEqual(m.pickCard(ps, 0), { ok: true }); m._applyCard(ps, 0); }
  h.sched.advance(0);
  for (const ps of m.order) { assert.equal(ps.counters['repeat-team'], capacity); assert.equal(calls.get(ps.playerId).length, capacity); assert.equal(new Set(calls.get(ps.playerId)).size, capacity); }
  assert.deepEqual(draft.cards, source); assert.equal(m.errorCount, 0);
});

for (const capacity of [8, 12, 16, 20]) test(`${capacity}-mode SP timeout/autoplay still sees all six options after all indices have been used`, t => {
  const h = make(t, capacity, { data: forced('supply'), experimental: rules(capacity) }), m = h.m; m.round = 3;
  for (const ps of m.order) ps.lp = 28;
  m.enterSpDraft(); const draft = m.sp;
  for (let idx = 0; idx < 6; idx++) assert.deepEqual(m.pickCard(m.players.get(m.spTurn()), idx), { ok: true });
  assert.equal(Object.keys(draft.taken).length, 6);
  const next = m.players.get(m.spTurn()); next.connected = false; m.onDisconnect(next.playerId);
  m.setAutoplay(next, true); h.sched.advance(m.scaled(900));
  assert.notEqual(draft.picks[next.playerId], undefined);
  while (m.phase === 'SP_DRAFT') { const turn = m.spTurn(); if (!turn) { h.sched.advance(0); break; } h.sched.advance(m.gd.timer('spTurn') * 1000); }
  assert.equal(m.phase, 'PREP'); assert.equal(Object.keys(draft.picks).length, capacity);
});

for (const capacity of [8, 12, 16, 20]) test(`${capacity}-mode AI seats repeat the human band and unlimited bounty index`, t => {
  const h = make(t, 2, { bots: capacity - 2, aiPicksLast: true, data: forced('bounty'), experimental: rules(capacity) }), m = h.m;
  m.rngBots = () => 0; enterBand(h);
  const band = botPickBand(m, m.order.find(ps => ps.isBot));
  for (let i = 0; i < 2; i++) assert.deepEqual(m.pickBand(m.players.get(m.draftTurn()), band), { ok: true });
  h.sched.advance(0); assert.equal(m.phase, 'BATTLE_CHECK');
  assert.ok(Object.values(m.draft.picks).every(id => id === band));
  m.setDeadline(0); m.round = 3; m.enterSpDraft(); const draft = m.sp;
  const source = draft.cards[0]; draft.cards = draft.cards.map((card, idx) => ({ ...source, idx }));
  for (let i = 0; i < 2; i++) assert.deepEqual(m.pickCard(m.players.get(m.spTurn()), 0), { ok: true });
  assert.ok(h.run(() => m.phase === 'PREP'));
  assert.equal(Object.keys(draft.picks).length, capacity); assert.ok(Object.values(draft.picks).every(idx => idx === 0));
  assert.equal(m.errorCount, 0);
});

for (const capacity of [8, 12, 16, 20]) test(`${capacity}-mode repeated equipment uses live stock; exhausted humans/AI switch to a remaining legal card`, t => {
  const h = make(t, 3, { bots: 2, experimental: rules(capacity) }), m = h.m;
  m.phase = 'SP_DRAFT'; m.round = 3;
  for (const ps of m.order) ps.lp = 28;
  const pack = 'chess_item_5_07_e_a', fallback = 'chess_item_2_03_e_a';
  assert.equal(m.itemPool.cap(pack), 2);
  assert.equal(m.itemPool.cap(fallback), null, 'effect-only gear has no shared cap');
  m.sp = { cards: [pack, fallback].map((id, idx) => ({ idx, id, kind: 'item' })),
    order: m.order.map(p => p.playerId), idx: 0, picks: {}, taken: {}, untimed: true };
  const draft = m.sp;
  for (const ps of m.order.slice(0, 2)) assert.deepEqual(m.pickCard(ps, 0), { ok: true });
  assert.equal(draft.taken[0], m.order[0].playerId, 'taken keeps only first-picker display metadata');
  assert.deepEqual(Object.values(draft.picks), [0, 0]);
  assert.equal(m.itemPool.left(pack), 0);
  const third = m.order[2];
  assert.equal(m.pickCard(third, 0).error, ERR.SOLD_OUT);
  assert.equal(draft.picks[third.playerId], undefined, 'an exhausted rejection consumes no pick');
  assert.equal(m.publicView().sp.cards[0].soldOut, true);
  assert.deepEqual(m.pickCard(third, 1), { ok: true });
  assert.ok(h.run(() => m.phase === 'PREP'), 'automatic picks skip the exhausted repeated card');
  assert.equal(Object.keys(draft.picks).length, 5);
  assert.deepEqual(Object.values(draft.picks), [0, 0, 1, 1, 1]);
  assert.ok(m.order.filter(ps => ps.isBot).every(ps => draft.picks[ps.playerId] === 1));
  assert.equal(m.itemPool.held(pack), m.itemPool.cap(pack));
  assert.deepEqual(collectViolations(m), []);
  assert.deepEqual(h.logs.error, []);
});

for (const capacity of [8, 12, 16, 20]) test(`${capacity}-mode timeout focus, departing defaults and later two survivors retain repeat rules`, t => {
  const h = make(t, 5, { experimental: rules(capacity), data: forced('bounty') }), m = h.m; enterBand(h);
  const focused = m.gd.bandIds().find(id => id !== m.gd.bandDraft.timeoutBandId); assert.ok(focused);
  for (let i = 0; i < 2; i++) {
    const ps = m.players.get(m.draftTurn()); assert.deepEqual(m.bandFocus(ps, focused), { ok: true });
    h.sched.advance(m.bandTurnMs()); assert.equal(m.draft.picks[ps.playerId], focused);
  }
  const departing = m.players.get(m.draftTurn()); m.onLeave(departing.playerId);
  assert.equal(m.draft.picks[departing.playerId], m.gd.bandDraft.timeoutBandId);
  m.finishBandDraft(true);
  assert.ok(m.order.filter(ps => ![m.draft.order[0], m.draft.order[1]].includes(ps.playerId)).every(ps => ps.bandId === m.gd.bandDraft.timeoutBandId));
  m.setDeadline(0);
  for (const ps of m.order.slice(2)) if (ps.alive) ps.eliminate(1);
  m.round = 9; m.enterSpDraft(); const draft = m.sp;
  assert.equal(m.playerCapacity, capacity); assert.equal(draft.order.length, 2); assert.equal(draft.cards.length, 6);
  assert.equal(m.publicView().sp.allowRepeat, true);
  for (let i = 0; i < 2; i++) assert.deepEqual(m.pickCard(m.players.get(m.spTurn()), 0), { ok: true });
  h.sched.advance(0); assert.equal(m.phase, 'PREP'); assert.equal(Object.keys(draft.picks).length, 2);
});

test('two battle owners with the same revive strategy each retain their own three-use hook counter', () => {
  const rec = chessRec('repeat_op', { hp: 1000, atk: 1, range: [[0, 0]], respawn: 20 });
  const players = ['left', 'right'].map((playerId, i) => ({ playerId, seat: i, side: 'L', colOffset: 0, bandId: 'band_ermengard', bonds: {}, playerEffects: [],
    units: [{ uid: i + 1, chessId: 'repeat_op', row: 10 + i, col: 4, dir: 'RIGHT' }] }));
  const h = makeBattle({ players, defs: { chess: { repeat_op: rec } }, autoFinish: false, timeLimit: 60 }); h.step(1);
  const a = h.b.allies('left')[0], b = h.b.allies('right')[0]; assert.ok(a && b);
  for (let i = 0; i < 3; i++) { h.b.kill(a); assert.equal(a.alive, true); }
  h.b.kill(a); assert.equal(a.alive, false);
  for (let i = 0; i < 3; i++) { h.b.kill(b); assert.equal(b.alive, true); }
  h.b.kill(b); assert.equal(b.alive, false);
  assert.deepEqual(h.b.errors, []);
});
