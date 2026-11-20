// 卡池静态初始化 (the room's experimental staticPoolSplit, the owner 2026-11-20; shared/experimental.js isStaticPoolSplit,
// server/match/pool.js PoolShare / dealByTier / dealChessShares / dealItemShares, Match._redealPools): every pool group of
// two seats or more is dealt to its seats by tier at the start — the same number of a tier's copies per seat (one more for
// the seats the rng picks), each its own mix of operators; equipment by its shop tier the same way. Each seat's shop,
// rewards and grants draw on its own share, its buys / sales / temp losses move only that share; an eliminated or departed
// seat's pieces go back first, then the group's copies are dealt again among the seats still in it (AI 托管 keeps its
// share). Checkpoints carry the shares (additive); nothing changes without the option.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { makeMatch, give, giveItem, checkInvariants, chessOfTier } from './harness.js';
import { dealByTier, PoolShare, poolCountsView, poolGroupOf, SharedPool } from '../../server/match/pool.js';
import { createRng, createRngFromState } from '../../server/sim/rng.js';
import { canSnapshot, snapshotMatch, restoreMatch, matchState } from '../../server/match/snapshot.js';
import { adoptAiSeat } from '../../server/aiTakeover.js';
import { EXPERIMENTAL_GROUPS, QUEUE_OPTION_KEYS, experimentalKey, experimentalOptions, experimentalRuleChanged, isExperimental, isStaticPoolSplit,
  queueOptions, sameExperimental } from '../../shared/experimental.js';

const SPLIT = Object.freeze({ revivalEnabled: false, disableSharedPool: false, staticPoolSplit: true });
const QUIET = { warn() {}, info() {}, error() {} };

function split(o = {}) {
  const h = makeMatch({ humans: 2, bots: 2, seed: 41, fake: true, experimental: SPLIT, ...o }).start().toPrep(1);
  return { h, m: h.m, a: h.m.players.get('p_0'), b: h.m.players.get('p_1') };
}

/** A share's copies by tier (`key` 'cap': what it was dealt and kept; 'left': what it can still draw). */
function perTier(share, key = 'cap') {
  const out = {};
  for (const e of share.entries.values()) out[e.tier] = (out[e.tier] || 0) + e[key];
  return out;
}
/** Every tier's spread among `shares` (max − min of perTier). */
function spreads(shares, key = 'cap') {
  const rows = shares.map((s) => perTier(s, key));
  return Object.keys(rows[0]).map((tier) => Math.max(...rows.map((r) => r[tier])) - Math.min(...rows.map((r) => r[tier])));
}
/** A seat's free equipment by tier (cap − held) in its own stock. */
function itemFreeByTier(m, ps) {
  const stock = m.itemPoolFor(ps), held = stock.heldCounts(), out = {};
  for (const [tier, ids] of Object.entries(m.gd.shopItemsByTier)) {
    for (const id of ids) {
      const cap = stock.cap(id);
      if (cap != null) out[tier] = (out[tier] || 0) + cap - (held.get(m.gd.baseIdOf(id)) || 0);
    }
  }
  return out;
}
/** Move copies of `id` from one share to another of the same group (cap and left together: no invariant moves). */
function moveCopies(from, to, id, n) {
  const a = from.entries.get(id), b = to.entries.get(id);
  a.cap -= n; a.left -= n; b.cap += n; b.left += n;
}
const sharesOf = (m) => poolGroupOf(m, 'p_0').shares;
const copyState = (m) => JSON.stringify(matchState(m).poolSplit);

test('dealByTier: every hand the same number of a tier\'s copies (the remainder one more, the rng\'s pick), every copy dealt, a seed deals the same', () => {
  const cards = [['a', 1, 5], ['b', 1, 8], ['c', 2, 3], ['d', 2, 2], ['e', 3, 0]];
  const rows = (dealt, hand) => Object.fromEntries([...dealt].map(([id, per]) => [id, per[hand]]));
  const extra = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const dealt = dealByTier(cards, 3, createRng(seed));
    for (const [id, , n] of cards) assert.equal(dealt.get(id).reduce((x, y) => x + y, 0), n, `${id}: every copy dealt`);
    const tier1 = [0, 1, 2].map((h) => dealt.get('a')[h] + dealt.get('b')[h]);
    const tier2 = [0, 1, 2].map((h) => dealt.get('c')[h] + dealt.get('d')[h]);
    assert.deepEqual([...tier1].sort(), [4, 4, 5], '13 copies of tier 1: 4 / 4 / 5');
    assert.deepEqual([...tier2].sort(), [1, 2, 2], '5 copies of tier 2: 1 / 2 / 2');
    assert.deepEqual(dealt.get('e'), [0, 0, 0]);
    extra.add(tier1.indexOf(5));
    assert.deepEqual(dealByTier(cards, 3, createRng(seed)), dealt, 'the same seed, the same deal');
    if (seed === 1) assert.notDeepEqual(rows(dealt, 0), rows(dealt, 1), 'hands differ by operator');
  }
  assert.equal(extra.size, 3, 'the remainder goes to every hand over the seeds');
  assert.deepEqual(dealByTier(cards, 0, createRng(1)).get('a'), [], 'no hands, nothing dealt');
});

test('options: a canonical optional flag, kept out under 禁用共享卡池, its own key and equality, a ticket may bring it', () => {
  const on = experimentalOptions(SPLIT);
  assert.equal(on.staticPoolSplit, true);
  assert.equal(isStaticPoolSplit(on), true);
  assert.deepEqual(Object.keys(experimentalOptions({ revivalEnabled: false, disableSharedPool: false })), ['revivalEnabled', 'disableSharedPool'], 'off: the old shape');
  assert.deepEqual(experimentalOptions({ ...SPLIT, staticPoolSplit: false }), experimentalOptions({ revivalEnabled: false, disableSharedPool: false }));
  assert.equal(experimentalOptions({ ...SPLIT, disableSharedPool: true }).staticPoolSplit, undefined, '独立卡池: every seat has a whole pool');
  assert.equal(experimentalOptions({ ...SPLIT, disableSharedPool: true, poolPlan: [0, 0, 1, 1] }).staticPoolSplit, true, 'a manual plan replaces 独立卡池: split within each group');
  assert.equal(experimentalKey(on), '00:split');
  assert.equal(experimentalKey(experimentalOptions({ revivalEnabled: false, disableSharedPool: false })), '00');
  assert.equal(sameExperimental(on, experimentalOptions(SPLIT)), true);
  assert.equal(sameExperimental(on, experimentalOptions({ revivalEnabled: false, disableSharedPool: false })), false, 'matchmaking: configs must match exactly');
  assert.equal(experimentalRuleChanged(on), true);
  assert.equal(isExperimental({ ...SPLIT, staticPoolSplit: 1 }), false, 'a strict boolean');
  assert.ok(QUEUE_OPTION_KEYS.includes('staticPoolSplit'));
  assert.deepEqual(queueOptions(SPLIT), on, 'a lone ticket may bring it');
  assert.ok(EXPERIMENTAL_GROUPS.find((g) => g.id === 'pools').keys.includes('staticPoolSplit'));
  // every option at once still validates (14 keys)
  const all = { revivalEnabled: true, disableSharedPool: false, playerCapacity: 8, disableDuckLord: true, disableLayerCap: true, disableHitLimit: true,
    enemyHpMul: 2, enemyAtkMul: 2, enemyHpPlan: [[1, 1], [6, 2]], poolPlan: [0, 0, 0, 0, 1, 1, 1, 1], collabOps: true, console: true, uniteHumansFirst: true, staticPoolSplit: true };
  assert.equal(isExperimental(all), true);
});

test('the start: each seat of the group its own share — the same copies per tier (±1), its own mix, the sum the group\'s pool; equipment the same', () => {
  const { m, a, b } = split();
  try {
    const g = poolGroupOf(m, a);
    assert.equal(m.poolGroups.length, 1);
    assert.deepEqual([...g.shares.keys()], ['p_0', 'p_1', 'ai_0', 'ai_1'], 'AI seats are dealt too');
    const shares = [...g.shares.values()];
    for (const ps of m.order) {
      assert.ok(m.poolFor(ps) instanceof PoolShare);
      assert.equal(m.poolFor(ps), g.shares.get(ps.playerId));
      assert.equal(ps.pool, m.poolFor(ps));
    }
    assert.ok(spreads(shares).every((d) => d <= 1), 'per tier: one copy apart at most');
    for (const [id, e] of g.pool.entries) {
      assert.equal(shares.reduce((n, s) => n + s.entries.get(id).cap, 0), e.cap, `${id}: every copy dealt`);
      assert.equal(shares.reduce((n, s) => n + s.entries.get(id).left, 0), e.left, `${id}: the group's left is its shares'`);
    }
    const ids = [...g.pool.entries.keys()];
    assert.ok(ids.some((id) => g.shares.get('p_0').entries.get(id).cap !== g.shares.get('p_1').entries.get(id).cap), 'the operators differ');
    // equipment: its own stock per seat, dealt by the shop's tiers
    assert.notEqual(m.itemPoolFor(a), m.itemPoolFor(b));
    const caps = m.order.map((ps) => {
      const out = {};
      for (const [tier, list] of Object.entries(m.gd.shopItemsByTier)) for (const id of list) if (m.itemPoolFor(ps).cap(id) != null) out[tier] = (out[tier] || 0) + m.itemPoolFor(ps).cap(id);
      return out;
    });
    for (const tier of Object.keys(caps[0])) assert.ok(Math.max(...caps.map((c) => c[tier])) - Math.min(...caps.map((c) => c[tier])) <= 1, `equipment tier ${tier}`);
    for (const id of Object.values(m.gd.shopItemsByTier).flat()) {
      const whole = m.gd.itemPoolCopies(id);
      if (whole != null) assert.equal(m.order.reduce((n, ps) => n + m.itemPoolFor(ps).cap(id), 0), whole, `${id}: every copy dealt`);
    }
    // 余 n is the seat's own share
    const view = poolCountsView(m, a);
    for (const [id, e] of m.poolFor(a).entries) assert.equal(view.chess[id], Math.max(0, e.left));
    for (const [id, n] of Object.entries(view.items)) assert.equal(n, m.itemPoolFor(a).left(id));
    checkInvariants(m);
  } finally { m.dispose(); }
  // the same seed deals the same; another seed another way
  const x = split(), y = split(), z = split({ seed: 42 });
  try {
    assert.equal(JSON.stringify(matchState(x.m).poolSplit), JSON.stringify(matchState(y.m).poolSplit));
    const capsOf = (m) => [...sharesOf(m).get('p_0').entries].map(([, e]) => e.cap).join();
    assert.notEqual(capsOf(x.m), capsOf(z.m));
  } finally { x.m.dispose(); y.m.dispose(); z.m.dispose(); }
});

test('rolls draw on the own share only; a shown card overdraws the share, later rolls skip it; teammates\' shares never move', () => {
  const { m, a, b } = split();
  try {
    const mine = m.poolFor(a), theirs = m.poolFor(b);
    const x = [...mine.entries].find(([, e]) => e.tier === 1 && e.left >= 1)?.[0];
    assert.ok(x);
    // everything of p_0's share but one copy of x goes to p_1 (cap and left together: the accounting stays whole)
    for (const [id, e] of mine.entries) if (e.left > 0) moveCopies(mine, theirs, id, id === x ? e.left - 1 : e.left);
    checkInvariants(m);
    assert.equal(mine.totalLeft(), 1);
    const before = copyState(m), otherLeft = theirs.snapshot(), group = m.pool.entries.get(x).left;
    a.shop.slots = [];
    a.funds = 99;
    assert.deepEqual(m.handle('p_0', { t: 'g.refresh' }), { ok: true });
    const chess = a.shop.slots.map((s, i) => [s, i]).filter(([s]) => s && s.kind === 'chess');
    assert.ok(chess.length >= 2);
    assert.ok(chess.every(([s]) => s.id === x), 'the one operator left in the share is all the shop shows');
    // the promotion reward and random grants roll the same share
    assert.equal(a.pool.roll(createRng(3), { maxTier: 6 }), x);
    assert.deepEqual(m.handle('p_0', { t: 'g.buy', slot: chess[0][1] }), { ok: true });
    assert.equal(mine.entries.get(x).left, 0);
    assert.deepEqual(m.handle('p_0', { t: 'g.buy', slot: chess[1][1] }), { ok: true }, 'an operator already shown can still be bought');
    assert.equal(mine.entries.get(x).left, -1, 'and overdraws the share');
    assert.equal(mine.left(x), 0);
    assert.equal(m.pool.entries.get(x).left, group - 2, 'the group\'s pool follows its shares');
    assert.deepEqual(theirs.snapshot(), otherLeft, 'the teammate\'s share did not move');
    assert.notEqual(copyState(m), before);
    checkInvariants(m);
    a.shop.slots = [];
    m.handle('p_0', { t: 'g.refresh' });
    assert.ok(!a.shop.slots.some((s) => s && s.kind === 'chess'), 'an empty share rolls no operator');
    assert.equal(a.pool.roll(createRng(3), { maxTier: 6 }), null, 'nor does a grant');
  } finally { m.dispose(); }
});

test('buy, sell and a temp wipe move the own share; equipment the same', () => {
  const { m, a, b } = split();
  try {
    const mine = m.poolFor(a), theirs = m.poolFor(b);
    const slot = b.shop.slots.findIndex((s) => s && s.kind === 'chess' && !s.sold);
    assert.ok(slot >= 0);
    const id = m.gd.baseIdOf(b.shop.slots[slot].id);
    const mineBefore = mine.snapshot(), theirsLeft = theirs.entries.get(id).left;
    b.funds = 99;
    assert.deepEqual(m.handle('p_1', { t: 'g.buy', slot }), { ok: true });
    assert.equal(theirs.entries.get(id).left, theirsLeft - 1);
    assert.deepEqual(mine.snapshot(), mineBefore, 'a teammate\'s purchase never changes my share');
    const piece = [...b.hand, ...b.temp].find((p) => p && m.gd.baseIdOf(p.id) === id && !m.gd.isGolden(p.id));
    if (piece) {
      assert.deepEqual(m.handle('p_1', { t: 'g.sell', uid: piece.uid }), { ok: true });
      assert.equal(theirs.entries.get(id).left, theirsLeft, 'a sale returns to the seller\'s share');
    }
    // a temp piece resolved at the prep's end goes back to its owner's share (a full hand keeps it in the temp row)
    const spare = [...mine.entries].filter(([, e]) => e.left > 0).map(([id]) => id);
    const t1 = spare.pop();
    for (let i = 0; i < a.hand.length; i++) if (!a.hand[i]) give(m, a, spare.shift(), 'hand', i);
    const left = mine.entries.get(t1).left;
    const p = give(m, a, t1, 'temp', 0);
    assert.equal(a.temp[0], p);
    assert.equal(mine.entries.get(t1).left, left - 1);
    a.resolveTemp();
    assert.ok(!a.temp.includes(p));
    assert.equal(mine.entries.get(t1).left, left);
    // equipment: the own stock only
    const item = Object.values(m.gd.shopItemsByTier).flat().find((iid) => m.itemPoolFor(a).left(iid) > 0 && m.gd.itemPoolCopies(iid) != null);
    const itemLeft = m.itemPoolFor(a).left(item), otherItem = m.itemPoolFor(b).left(item);
    giveItem(m, a, item, 'temp', 1);
    assert.equal(m.itemPoolFor(a).left(item), itemLeft - 1);
    assert.equal(m.itemPoolFor(b).left(item), otherItem, 'a teammate\'s equipment stock did not move');
    checkInvariants(m);
  } finally { m.dispose(); }
});

test('an elimination: the seat\'s pieces go back, then the group\'s copies are dealt again among the seats still in it (held pieces untouched)', () => {
  const { m, a, b } = split();
  try {
    const g = poolGroupOf(m, a);
    for (const id of chessOfTier(1).filter((c) => m.poolFor(b).left(c) > 0).slice(0, 3)) give(m, b, id);
    for (const id of chessOfTier(2).filter((c) => m.poolFor(a).left(c) > 0).slice(0, 2)) give(m, a, id);
    const item = Object.values(m.gd.shopItemsByTier).flat().find((iid) => m.itemPoolFor(b).left(iid) > 0);
    giveItem(m, b, item);
    checkInvariants(m);
    const held = JSON.stringify([...a.hand, ...a.board.values()].filter(Boolean).map((p) => [p.uid, p.id, p.poolCopies]));
    const groupLeft = new Map([...g.pool.entries].map(([id, e]) => [id, e.left]));
    const bHeld = new Map();
    for (const p of [...b.hand, ...b.temp, ...b.board.values()]) if (p?.kind === 'chess') bHeld.set(m.gd.baseIdOf(p.id), (bHeld.get(m.gd.baseIdOf(p.id)) || 0) + p.poolCopies);
    b.lp = 0;
    m._finalizeDeath(b);
    assert.equal(b.alive, false);
    const out = g.shares.get('p_1');
    assert.equal(out.totalLeft(), 0);
    assert.ok([...out.entries.values()].every((e) => e.cap === 0 && e.left === 0), 'the eliminated seat keeps nothing');
    for (const [id, e] of g.pool.entries) assert.equal(e.left, groupLeft.get(id) + (bHeld.get(id) || 0), `${id}: its copies came back, nothing else moved`);
    const live = ['p_0', 'ai_0', 'ai_1'].map((id) => g.shares.get(id));
    assert.ok(spreads(live, 'left').every((d) => d <= 1), 'what is left, dealt evenly by tier');
    const free = ['p_0', 'ai_0', 'ai_1'].map((id) => itemFreeByTier(m, m.players.get(id)));
    for (const tier of Object.keys(free[0])) assert.ok(Math.max(...free.map((f) => f[tier])) - Math.min(...free.map((f) => f[tier])) <= 1, `equipment tier ${tier}`);
    assert.equal(JSON.stringify([...a.hand, ...a.board.values()].filter(Boolean).map((p) => [p.uid, p.id, p.poolCopies])), held, 'owned pieces untouched');
    checkInvariants(m);
    // the same round and seat deal the same again (a replayed round)
    const again = split();
    try {
      const b2 = again.m.players.get('p_1');
      for (const id of chessOfTier(1).filter((c) => again.m.poolFor(b2).left(c) > 0).slice(0, 3)) give(again.m, b2, id);
      for (const id of chessOfTier(2).filter((c) => again.m.poolFor(again.a).left(c) > 0).slice(0, 2)) give(again.m, again.a, id);
      giveItem(again.m, b2, item);
      b2.lp = 0;
      again.m._finalizeDeath(b2);
      assert.equal(copyState(again.m), copyState(m));
    } finally { again.m.dispose(); }
  } finally { m.dispose(); }
});

test('leaving is an elimination: the group is dealt again; AI 托管, a disconnect and a spectator taking an AI seat keep every share', () => {
  const { m, a, b } = split({ humans: 3, bots: 1 });
  try {
    const before = copyState(m);
    assert.deepEqual(m.handle('p_1', { t: 'g.autoplay', on: true }), { ok: true });
    assert.equal(b.botControlled, true);
    m.onDisconnect?.('p_2');
    adoptAiSeat(m, 'ai_0', 'Watcher', true);
    assert.equal(copyState(m), before, 'nobody is out: nothing is dealt');
    m.onLeave('p_2');
    assert.equal(m.players.get('p_2').alive, false);
    assert.notEqual(copyState(m), before);
    const g = poolGroupOf(m, a);
    assert.equal(g.shares.get('p_2').totalLeft(), 0);
    assert.ok(spreads(['p_0', 'p_1', 'ai_0'].map((id) => g.shares.get(id)), 'left').every((d) => d <= 1));
    checkInvariants(m);
  } finally { m.dispose(); }
});

test('a whole match where seats fall: every phase keeps the accounting whole, every fallen seat\'s share goes to the seats still in', () => {
  const h = makeMatch({ humans: 1, bots: 3, seed: 77, fake: true, experimental: SPLIT,
    script: (b) => (b.kind === 'normal' ? { leaks: { ai_1: 3, ai_2: 3 } } : b.kind === 'unite' ? { survivors: { ai_1: 3, ai_2: 3 } } : {}) });
  try {
    h.autoHumans().start();
    let last = '';
    const out = new Set();
    h.run(() => {
      const key = `${h.m.phase}:${h.m.round}`;
      if (key !== last) {
        last = key;
        checkInvariants(h.m);
        // two seats about to fall: their next leaks finish them
        if (h.m.phase === PHASE.PREP && h.m.round === 2) for (const id of ['ai_1', 'ai_2']) h.m.players.get(id).lp = 1;
        const g = poolGroupOf(h.m, 'p_0');
        for (const ps of h.m.order) {
          if (ps.alive || out.has(ps.playerId)) continue;
          out.add(ps.playerId);
          assert.equal(g.shares.get(ps.playerId).totalLeft(), 0, `${ps.playerId} keeps no share`);
        }
      }
      return h.ended != null || (out.size >= 2 && h.m.phase === PHASE.PREP);
    });
    assert.deepEqual([...out].sort(), ['ai_1', 'ai_2']);
    const g = poolGroupOf(h.m, 'p_0');
    for (const [id, e] of g.pool.entries) {
      assert.equal(g.shares.get('p_0').entries.get(id).cap + g.shares.get('ai_0').entries.get(id).cap, e.cap, `${id}: the two seats left hold the whole pool`);
    }
    checkInvariants(h.m);
  } finally { h.m.dispose(); }
});

test('a whole match with the option keeps the accounting whole; the checkpoint carries the shares and restores them', () => {
  const h = makeMatch({ humans: 2, bots: 2, seed: 31, experimental: SPLIT });
  h.start();
  h.drive(() => h.m.phase === PHASE.PREP && h.m.round === 3 && canSnapshot(h.m));
  checkInvariants(h.m);
  const doc = JSON.parse(JSON.stringify(snapshotMatch(h.m)));
  assert.ok(Array.isArray(doc.poolSplit) && doc.poolSplit[0].chess.p_0, 'the shares are saved');
  const r = makeMatch({ humans: 2, bots: 2, seats: doc.seats, seed: doc.seed, offlineHoldMs: 0, experimental: doc.experimental });
  assert.equal(restoreMatch(r.m, doc, { createRngFromState, log: QUIET }), true);
  assert.equal(copyState(r.m), copyState(h.m));
  assert.deepEqual(matchState(r.m).pools, matchState(h.m).pools);
  for (const ps of r.m.order) {
    assert.deepEqual([...r.m.itemPoolFor(ps).caps], [...h.m.itemPoolFor(h.m.players.get(ps.playerId)).caps]);
    assert.deepEqual([...r.m.itemPoolFor(ps).debt], [...h.m.itemPoolFor(h.m.players.get(ps.playerId)).debt]);
  }
  checkInvariants(r.m);
  // a split match's checkpoint without its shares cannot come back; one whose shares do not add up neither
  const { poolSplit, ...bare } = doc;
  const r2 = makeMatch({ humans: 2, bots: 2, seats: doc.seats, seed: doc.seed, offlineHoldMs: 0, experimental: doc.experimental });
  assert.equal(restoreMatch(r2.m, bare, { createRngFromState, log: QUIET }), false);
  const bad = JSON.parse(JSON.stringify(doc));
  const some = Object.keys(bad.poolSplit[0].chess.p_0)[0];
  bad.poolSplit[0].chess.p_0[some][0] += 1;
  const r3 = makeMatch({ humans: 2, bots: 2, seats: doc.seats, seed: doc.seed, offlineHoldMs: 0, experimental: doc.experimental });
  assert.equal(restoreMatch(r3.m, bad, { createRngFromState, log: QUIET }), false);
  for (const x of [h, r, r2, r3]) x.m.dispose();
});

test('without the option nothing changes: no shares, the old checkpoint shape, and a checkpoint without the field loads', () => {
  const h = makeMatch({ humans: 2, bots: 2, seed: 31 });
  h.start();
  assert.equal(h.m.staticPoolSplit, false);
  assert.ok(h.m.poolGroups.every((g) => !g.shares && !g.itemCaps));
  assert.equal(h.m.playerPools, null, 'an ordinary match still routes every seat to the one pool');
  assert.ok(h.m.order.every((ps) => ps.pool === h.m.pool && !(ps.pool instanceof PoolShare)));
  assert.ok(!(h.m.pool instanceof PoolShare) && h.m.pool instanceof SharedPool);
  h.drive(() => h.m.phase === PHASE.PREP && h.m.round === 2 && canSnapshot(h.m));
  const doc = JSON.parse(JSON.stringify(snapshotMatch(h.m)));
  assert.equal('poolSplit' in doc, false);
  assert.equal('poolSplit' in matchState(h.m), false);
  const r = makeMatch({ humans: 2, bots: 2, seats: doc.seats, seed: doc.seed, offlineHoldMs: 0 });
  assert.equal(restoreMatch(r.m, doc, { createRngFromState, log: QUIET }), true);
  assert.deepEqual(matchState(r.m).pools, matchState(h.m).pools);
  h.m.dispose();
  r.m.dispose();
});

test('with the other pool rules: 独立卡池 drops it; a one-seat group is left whole; enlarged / fixed-chunk / manual groups are each dealt to their own seats', () => {
  const solo = makeMatch({ humans: 2, bots: 2, seed: 7, experimental: { ...SPLIT, disableSharedPool: true } });
  try {
    assert.equal(solo.m.staticPoolSplit, false);
    assert.ok(solo.m.poolGroups.every((g) => g.playerIds.length === 1 && !g.shares));
  } finally { solo.m.dispose(); }
  const plan = makeMatch({ humans: 2, bots: 2, seed: 7, experimental: { ...SPLIT, poolPlan: [0, 0, 0, 1] } });
  try {
    const [three, one] = plan.m.poolGroups;
    assert.deepEqual([three.playerIds.length, one.playerIds.length], [3, 1]);
    assert.deepEqual([...three.shares.keys()], three.playerIds);
    assert.equal(one.shares, undefined, 'a one-seat group is its seat\'s own pool');
    assert.equal(plan.m.poolFor(one.playerIds[0]), one.pool);
    assert.ok(spreads([...three.shares.values()]).every((d) => d <= 1));
    checkInvariants(plan.m);
  } finally { plan.m.dispose(); }
  const seats = Array.from({ length: 8 }, (_, i) => ({ seat: i, playerId: i < 2 ? `p_${i}` : `ai_${i}`, name: `S${i}`, isBot: i >= 2, connected: true }));
  const big = makeMatch({ seats, seed: 9, experimental: { ...SPLIT, playerCapacity: 8 } });
  try {
    assert.ok(big.m.poolGroups.length >= 1);
    for (const g of big.m.poolGroups) {
      assert.deepEqual([...g.shares.keys()], g.playerIds);
      assert.ok(spreads([...g.shares.values()]).every((d) => d <= 1));
      for (const [id, e] of g.pool.entries) assert.equal([...g.shares.values()].reduce((n, s) => n + s.entries.get(id).cap, 0), e.cap, `${id}: the group's enlarged copies dealt`);
    }
    checkInvariants(big.m);
  } finally { big.m.dispose(); }
});
