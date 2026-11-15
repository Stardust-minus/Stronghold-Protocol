// 卡池剩余 (feedback #160, server/match/pool.js poolCountsView): m.private poolLeft — the copies left in the chess pool and
// the capped shop equipment a seat shares with its pool group; absent when nothing is shared; refreshed for the group when
// another seat's purchase moves it; never a checkpoint field, never sent to a spectator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { makeMatch } from './harness.js';
import { poolCountsView, poolGroupOf } from '../../server/match/pool.js';
import { getVersionData } from '../../server/data.js';
import { createRngFromState } from '../../server/sim/rng.js';
import { canSnapshot, snapshotMatch, restoreMatch, MATCH_FIELDS } from '../../server/match/snapshot.js';

const ACT3 = getVersionData('act3autochess@V3_1', { log: { warn() {}, info() {}, error() {} } });

/** The shop's capped equipment ids (every tier of gd.shopItemsByTier with an itemPoolCopies cap). */
const cappedShopItems = (m) => Object.values(m.gd.shopItemsByTier).flat().filter((id) => m.gd.itemPoolCopies(id) != null).sort();

function coop(o = {}) {
  const h = makeMatch({ humans: 2, bots: 2, seed: 41, fake: true, ...o }).start().toPrep(1);
  return { h, m: h.m, a: h.m.players.get('p_0'), b: h.m.players.get('p_1') };
}

test('co-op: poolLeft lists every chess of the shared pool (×2 the solo copies) and only capped shop equipment', () => {
  const { m, a, b } = coop();
  try {
    const v = a.privateView().poolLeft;
    assert.ok(v, 'a shared pool sends its counts');
    const pool = m.poolFor(a);
    assert.deepEqual(Object.keys(v.chess).sort(), [...pool.entries.keys()].sort(), 'every chess of the pool, nothing else');
    for (const [id, e] of pool.entries) assert.equal(v.chess[id], Math.max(0, e.left), id);
    assert.ok(m.bannedChess.every((id) => !(id in v.chess)), 'a banned operator has no count');
    // ×2 in co-op (coopPoolMultiplier, GitHub #650): an operator without an override has twice its tier's solo copies
    const plain = [...pool.entries.keys()].find((id) => !(id in (m.gd.economy.poolCopiesOverrides || {})));
    assert.equal(pool.cap(plain), m.gd.economy.poolCopies[m.gd.tierOf(plain)] * 2);
    // equipment is not doubled: the measured shop stock, per pool group
    assert.deepEqual(Object.keys(v.items).sort(), cappedShopItems(m));
    for (const [id, n] of Object.entries(v.items)) assert.equal(n, m.itemPoolFor(a).left(id), id);
    const one = Object.keys(v.items).find((id) => !(id in (m.gd.economy.itemPoolCopiesOverrides || {})));
    assert.equal(m.itemPoolFor(a).cap(one), m.gd.economy.itemPoolCopies[m.gd.item(one).tier], 'equipment keeps its solo copies');
    assert.deepEqual(b.privateView().poolLeft, v, 'both humans of the group read the same stock');
  } finally { m.dispose(); }
});

test('co-op: a teammate\'s purchase re-sends the other human\'s m.private with the lower count; a move that leaves the stock alone does not', () => {
  const { h, m, a } = coop();
  try {
    m.flush(true);
    const slot = a.shop.slots.findIndex((s) => s && s.kind === 'chess' && !s.sold);
    assert.ok(slot >= 0);
    const id = a.shop.slots[slot].id;
    const before = h.lastTo('p_1', 'm.private').poolLeft.chess[id];
    const sent = h.allTo('p_1', 'm.private').length;
    a.funds = 99;
    m.handle('p_0', { t: 'g.buy', slot });
    m.flush();
    assert.equal(h.allTo('p_1', 'm.private').length, sent + 1, 'the teammate gets its view again');
    assert.equal(h.lastTo('p_1', 'm.private').poolLeft.chess[id], Math.max(0, before - 1));
    // an equipment purchase moves the shared equipment stock the same way
    const islot = a.shop.slots.findIndex((s) => s && s.kind === 'item' && !s.sold && m.gd.itemPoolCopies(s.id) != null);
    if (islot >= 0) {
      const iid = a.shop.slots[islot].id;
      const ibefore = h.lastTo('p_1', 'm.private').poolLeft.items[iid];
      m.handle('p_0', { t: 'g.buy', slot: islot });
      m.flush();
      assert.equal(h.lastTo('p_1', 'm.private').poolLeft.items[iid], Math.max(0, ibefore - 1));
    }
    // 冻结 changes only the buyer's own view: nobody else is sent anything
    const quiet = h.allTo('p_1', 'm.private').length;
    m.handle('p_0', { t: 'g.freeze' });
    m.flush();
    assert.equal(h.allTo('p_1', 'm.private').length, quiet, 'an unchanged stock re-sends nothing to the group');
  } finally { m.dispose(); }
});

test('nothing shared, nothing sent: 单人, 独立卡池; bots, disconnected and eliminated seats get no counts, spectators no m.private', () => {
  const solo = makeMatch({ mode: 'solo', humans: 1, seed: 5, fake: true }).start().toPrep(1);
  try {
    const ps = solo.m.players.get('p_0');
    assert.equal(poolGroupOf(solo.m, ps).playerIds.length, 1);
    assert.equal(poolCountsView(solo.m, ps), null);
    assert.ok(!('poolLeft' in ps.privateView()), '单人: the pool is the player\'s own');
    const id = [...solo.m.poolFor(ps).entries.keys()].find((x) => !(x in (solo.m.gd.economy.poolCopiesOverrides || {})));
    assert.equal(solo.m.poolFor(ps).cap(id), solo.m.gd.economy.poolCopies[solo.m.gd.tierOf(id)], '×1 in solo');
  } finally { solo.m.dispose(); }
  const own = coop({ experimental: { revivalEnabled: false, disableSharedPool: true } });
  try {
    assert.ok(!('poolLeft' in own.a.privateView()), '独立卡池: one seat per pool');
  } finally { own.m.dispose(); }
  const { h, m, a, b } = coop({ spectators: ['s_0'] });
  try {
    assert.ok(!('poolLeft' in m.players.get('ai_0').privateView()), 'a bot');
    b.connected = false;
    assert.ok(!('poolLeft' in b.privateView()), 'a disconnected seat');
    b.connected = true;
    b.alive = false;
    assert.ok(!('poolLeft' in b.privateView()), 'an eliminated seat');
    b.alive = true;
    m.flush(true);
    assert.ok('poolLeft' in a.privateView());
    assert.equal(h.allTo('s_0', 'm.private').length, 0, 'a spectator never gets an m.private');
    assert.ok(!JSON.stringify(m.publicView()).includes('poolLeft'), 'never in m.public');
  } finally { m.dispose(); }
});

test('规程 co-op: the same counts (the 规程 pool and its capped equipment)', () => {
  const { m, a } = coop({ data: ACT3 });
  try {
    const v = a.privateView().poolLeft;
    assert.ok(v);
    for (const [id, e] of m.poolFor(a).entries) assert.equal(v.chess[id], Math.max(0, e.left));
    assert.deepEqual(Object.keys(v.items).sort(), cappedShopItems(m));
  } finally { m.dispose(); }
});

test('checkpoint: the flushed signatures are transient and a restored match sends the same counts', () => {
  assert.ok(MATCH_FIELDS.transient.includes('_poolCountSigs'));
  const h = makeMatch({ humans: 2, bots: 2, seed: 31 });
  h.start();
  h.drive(() => h.m.phase === PHASE.PREP && h.m.round === 2 && canSnapshot(h.m));
  h.m.flush(true);
  const want = h.m.players.get('p_0').privateView().poolLeft;
  assert.ok(want);
  const doc = JSON.parse(JSON.stringify(snapshotMatch(h.m)));
  assert.ok(!JSON.stringify(doc).includes('_poolCountSigs'));
  const r = makeMatch({ humans: 2, bots: 2, seats: doc.seats, seed: doc.seed, offlineHoldMs: 0 });
  assert.equal(restoreMatch(r.m, doc, { createRngFromState, log: { warn() {} } }), true);
  r.m.onReconnect('p_0');
  r.m.flush(true);
  assert.deepEqual(r.lastTo('p_0', 'm.private').poolLeft, want);
  h.m.dispose();
  r.m.dispose();
});
