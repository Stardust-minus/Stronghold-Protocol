// Experimental ELO tilt (§37.273, server/match/tilt.js; step 1: the server side, set by a test hook): a seat's strength
// s reweights its own operator and equipment draws inside the same single draw — every tier keeps its total, a card
// without stock never gets weight, a hindering floor may take a relevant card to 0 without touching the pool, and a seat
// without a tilt (or s = 0) takes the untouched path: the same draws, the same results, its teammates' too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeMatch, give, giveItem, chessOfTier } from './harness.js';
import { setTilt, tiltOf, tiltFactor, chessTilt, itemTilt, itemTierTilt, offerTilt, shiftTiers, tiltContext, chessRelevance,
  itemRelevance, STRATEGY_TAGS } from '../../server/match/tilt.js';
import { canSnapshot, snapshotMatch, restoreMatch } from '../../server/match/snapshot.js';
import { createRngFromState } from '../../server/sim/rng.js';
import { PHASE } from '../../shared/constants.js';

const QUIET = { warn() {}, info() {}, error() {} };

function solo(seed = 7) {
  const h = makeMatch({ mode: 'solo', humans: 1, seed, fake: true }).start().toPrep(1);
  const ps = h.m.players.get('p_0');
  ps.bandId = 'band_sarkazb'; // 歌利亚: no strategy tags, no home bond (the plain relevance)
  return { h, m: h.m, ps };
}
/** Tier totals of [id, weight, tier?] rows (tiers read from the data when the row has none). */
function tierTotals(m, rows) {
  const out = {};
  for (const [id, w, t] of rows) { const tier = t ?? m.gd.tierOf(id); out[tier] = (out[tier] || 0) + w; }
  return out;
}
const close = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => Math.abs(a[k] - b[k]) < 1e-9);
const counting = (v = 0.5) => { const f = () => { f.calls++; return typeof v === 'function' ? v(f.calls) : v; }; f.calls = 0; return f; };

test('setTilt normalizes the hook; s = 0 or null removes it, and without one every tilt is null', () => {
  const { m, ps } = solo();
  assert.equal(tiltOf(ps), null);
  assert.equal(chessTilt(ps), null);
  assert.equal(itemTilt(ps), null);
  assert.equal(itemTierTilt(ps), null);
  assert.deepEqual(setTilt(ps, { s: 3, m: 0.5, floor: -1, cut: 2, tier: 1 }), { s: 1, m: 1, floor: 0, cut: 1, tier: 0.25, core: true });
  assert.deepEqual(setTilt(ps, { s: -0.5 }), { s: -0.5, m: 2, floor: null, cut: 0.5, tier: 0, core: true });
  assert.equal(setTilt(ps, { s: 0, m: 3 }), null);
  assert.equal(Object.hasOwn(ps, 'tilt'), false, 's = 0: no field at all');
  setTilt(ps, { s: 1 });
  assert.equal(setTilt(ps, null), null);
  assert.equal(Object.hasOwn(ps, 'tilt'), false);
  // M^(s·r); the floor only when hindering, only from the cut, and exactly the floor at s = −1
  assert.equal(tiltFactor({ s: 1, m: 2, floor: 0, cut: 0.5, core: true }, 1), 2);
  assert.equal(tiltFactor({ s: -1, m: 2, floor: null, cut: 0.5, core: true }, 1), 0.5);
  assert.equal(tiltFactor({ s: -1, m: 2, floor: 0, cut: 0.5, core: true }, 0.6), 0);
  assert.equal(tiltFactor({ s: -1, m: 2, floor: 0, cut: 0.5, core: true }, 0.35), Math.pow(2, -0.35));
  assert.ok(Math.abs(tiltFactor({ s: -1, m: 2, floor: 0.1, cut: 0.5, core: true }, 1) - 0.1) < 1e-12);
  assert.equal(tiltFactor({ s: 1, m: 2, floor: null, cut: 0.5, core: false }, 1), 1);
  m.dispose();
});

test('a tilted roll: one rng() call, every tier keeps its total, the merge-completing copy weighs more (help) or 0 (floor), the pool untouched', () => {
  const { m, ps } = solo();
  const x = chessOfTier(1).find((id) => m.pool.left(id) >= 3 && m.gd.mergeCount(id) === 3);
  give(m, ps, x); give(m, ps, x);
  ps.shop.level = 3;
  const el = m.pool._eligible({ maxTier: 3 });
  const base = new Map(el.map(([id, n]) => [id, n]));
  assert.ok(ps.completesChessMerge(x));
  assert.equal(chessRelevance(tiltContext(ps), x), 0.7, 'plain relevance of the merge-completing copy');

  setTilt(ps, { s: 1, m: 2 });
  const up = chessTilt(ps)(/** @type {any} */ (el));
  assert.ok(close(tierTotals(m, up), tierTotals(m, el)), 'tier shares unchanged');
  const ratio = (rows, id) => rows.find((r) => r[0] === id)[1] / base.get(id);
  const other = chessOfTier(1).find((id) => id !== x && base.get(id) > 0 && !m.gd.chess(id).bonds.some((b) => m.gd.chess(x).bonds.includes(b)));
  assert.ok(ratio(up, x) > ratio(up, other) * 1.5, 'the copy that completes the merge is dealt more often');
  for (const [id, w] of up) assert.ok(w > 0 && base.get(id) > 0, `${id}: never a weight without stock, never 0 when helping`);
  const rng = counting(0.37);
  assert.ok(m.pool.roll(rng, { maxTier: 3, tilt: chessTilt(ps) }));
  assert.equal(rng.calls, 1, 'the same single draw');

  setTilt(ps, { s: -1, m: 2, floor: 0 });
  const left = m.pool.left(x);
  const down = chessTilt(ps)(/** @type {any} */ (el));
  assert.equal(down.find((r) => r[0] === x)[1], 0, 'floored to 0 for this seat');
  assert.ok(close(tierTotals(m, down), tierTotals(m, el)));
  for (let i = 0; i < 400; i++) assert.notEqual(m.pool.roll(() => i / 400, { maxTier: 3, tilt: chessTilt(ps) }), x);
  assert.equal(m.pool.left(x), left, 'the card stays in the pool: 「余 n」 is the same');
  // a tier whose every card is floored keeps its untilted weights (the tier is still drawn as often)
  assert.deepEqual(chessTilt(ps)([[x, 4, 1]]), [[x, 4]]);
  m.dispose();
});

test('no tilt, or a teammate\'s tilt: the shop rolls and every rng stream are exactly the untouched ones', () => {
  const run = (tilt) => {
    const h = makeMatch({ humans: 2, bots: 2, seed: 23, fake: true }).start().toPrep(1);
    const a = h.m.players.get('p_0'), b = h.m.players.get('p_1');
    if (tilt) setTilt(a, tilt);
    // a strategy without shop effects (歌利亚), so only the draws themselves differ
    a.bandId = 'band_sarkazb'; b.bandId = 'band_sarkazb';
    a.shop.level = 4; b.shop.level = 4;
    const out = [];
    for (let i = 0; i < 8; i++) {
      a.funds = 99; a.refresh();
      b.funds = 99; b.refresh();
      out.push(b.shop.slots.map((s) => s && s.id).join(','));
    }
    const rng = [h.m.rngShop.state(), h.m.rngMeta.state()];
    const aSlots = a.shop.slots.map((s) => s && s.id).join(',');
    h.m.dispose();
    return { out, rng, aSlots };
  };
  const plain = run(null), zero = run({ s: 0, m: 4 }), mate = run({ s: 1, m: 4, tier: 0.25 });
  assert.deepEqual(zero, plain, 's = 0 is the untouched path');
  assert.deepEqual(mate.out, plain.out, 'an untilted seat rolls as before while a teammate is tilted');
  assert.deepEqual(mate.rng, plain.rng, 'the tilted seat draws as many times');
});

test('the tier lever moves at most its share of the mass one tier up or down; the total is kept', () => {
  const t = new Map([[1, 50], [2, 35], [3, 15]]);
  const up = shiftTiers(t, 0.25), down = shiftTiers(t, -0.25);
  assert.deepEqual([...up.values()].map((v) => +v.toFixed(4)), [37.5, 38.75, 23.75]);
  assert.deepEqual([...down.values()].map((v) => +v.toFixed(4)), [58.75, 30, 11.25]);
  assert.equal([...up.values()].reduce((a, b) => a + b, 0), 100);
  assert.deepEqual([...shiftTiers(new Map([[2, 10]]), 0.25)], [[2, 10]], 'one tier: nothing to move');
  const { m, ps } = solo();
  ps.shop.level = 3;
  setTilt(ps, { s: 1, core: false, tier: 0.25 });
  assert.equal(chessTilt(ps), null, 'the tier lever is the shop\'s own rolls only');
  const el = m.pool._eligible({ maxTier: 3 });
  const rows = chessTilt(ps, { shop: true })(/** @type {any} */ (el));
  const a = tierTotals(m, el), b = tierTotals(m, rows);
  assert.ok(b[3] > a[3] && b[1] < a[1]);
  assert.ok(Math.abs(Object.values(b).reduce((x, y) => x + y, 0) - Object.values(a).reduce((x, y) => x + y, 0)) < 1e-6);
  const shares = itemTierTilt(ps)(m.pool.tierShares(3));
  assert.ok(Math.abs(Object.values(shares).reduce((x, y) => x + y, 0) - 1) < 1e-9 && shares[3] > m.pool.tierShares(3)[3]);
  const rng = counting(0.5);
  m.pool.rollItem(rng, 3, ps.itemPool, null, { weights: null, shares: itemTierTilt(ps) });
  assert.equal(rng.calls, 2, 'the item slot keeps its two draws');
  m.dispose();
});

test('equipment: the second copy of a held item and 转职装备 of a live bond weigh more, only items the stock can give', () => {
  const { m, ps } = solo();
  const tier = 1;
  const ids = m.gd.shopItemsByTier[tier].filter((id) => ps.itemPool.canGain(id));
  const held = ids.find((id) => ps._itemMergeable(id) && typeof m.gd.item(id).giveBondId !== 'string');
  giveItem(m, ps, held);
  setTilt(ps, { s: 1, m: 3 });
  const cx = tiltContext(ps);
  assert.equal(itemRelevance(cx, held), 0.7);
  const w = itemTilt(ps)(ids);
  const others = ids.filter((id) => id !== held && itemRelevance(cx, id) === 0);
  assert.ok(others.length && w.get(held) > w.get(others[0]) * 2);
  assert.ok(Math.abs([...w.values()].reduce((a, b) => a + b, 0) - ids.length) < 1e-9, 'the tier total is kept');
  for (let i = 0; i < 20; i++) assert.ok(ids.includes(m.rollItemId({ tier, player: ps, tilt: itemTilt(ps) })));
  // the 转职球 counts as 转职 with a 转职装备 held
  const morph = Object.values(m.gd.raw.items).find((it) => it.canGiveBond && !it.isGolden);
  const give1 = Object.values(m.gd.raw.items).find((it) => typeof it.giveBondId === 'string' && !it.isGolden);
  assert.equal(itemRelevance(tiltContext(ps), morph.id), 0.35);
  giveItem(m, ps, give1.id);
  assert.equal(itemRelevance(tiltContext(ps), morph.id), 0.7);
  m.dispose();
});

test('strategy offers: only 凯瑟琳 / 娜仁图亚 drawing their own pool get the equipment tilt; strategy tags raise the key cards', () => {
  const { m, ps } = solo();
  const cathy = { kind: 'band', bandId: 'band_cathy', band: m.gd.band('band_cathy') };
  const narant = { kind: 'band', bandId: 'band_narant', band: m.gd.band('band_narant') };
  assert.equal(offerTilt(ps, cathy, 'pool_equip_kathe'), null, 'untilted: none');
  setTilt(ps, { s: 1 });
  assert.equal(typeof offerTilt(ps, cathy, 'pool_equip_kathe'), 'function');
  assert.equal(typeof offerTilt(ps, narant, 'pool_equip_narant'), 'function');
  assert.equal(offerTilt(ps, cathy, 'pool_equip_normal'), null, 'another pool');
  assert.equal(offerTilt(ps, { kind: 'item', piece: null }, 'pool_equip_kathe'), null, 'another source');
  // 复奏-like merge strategy: the merge-completing copy is a key card (1), else 0.7
  const x = chessOfTier(1).find((id) => m.pool.left(id) >= 3 && m.gd.mergeCount(id) === 3);
  give(m, ps, x); give(m, ps, x);
  ps.bandId = 'band_ioleta';
  assert.equal(chessRelevance(tiltContext(ps), x), 1);
  ps.bandId = 'band_sarkazb';
  assert.equal(chessRelevance(tiltContext(ps), x), 0.7);
  // a strategy tied to a bond: its members are key cards
  ps.bandId = 'band_duyaoy';
  const yan = chessOfTier(1).find((id) => m.pool.has(id) && m.gd.chess(id).bonds.includes('yanShip'));
  if (yan) assert.ok(chessRelevance(tiltContext(ps), yan) >= 0.8);
  m.dispose();
});

test('STRATEGY_TAGS names known strategies and tags only', () => {
  const known = new Set(Object.keys(JSON.parse(fs.readFileSync(new URL('../../data/bands.json', import.meta.url), 'utf8'))));
  const dir = new URL('../../data/versions/', import.meta.url);
  for (const v of fs.readdirSync(dir)) for (const id of Object.keys(JSON.parse(fs.readFileSync(new URL(`${v}/bands.json`, dir), 'utf8')))) known.add(id);
  const tags = new Set(['merge', 'sameName', 'bonds', 'highTier', 'tierSpread', 'items', 'itemMerge', 'morph', 'refresh']);
  for (const [id, list] of Object.entries(STRATEGY_TAGS)) {
    assert.ok(known.has(id), `${id} is a strategy`);
    for (const t of list) assert.ok(tags.has(t), `${id}: ${t}`);
  }
});

test('checkpoint: the tilt travels only when set and comes back normalized; every other checkpoint keeps its shape', () => {
  const h = makeMatch({ humans: 2, bots: 2, seed: 31, fake: true }).start();
  h.drive(() => h.m.phase === PHASE.PREP && h.m.round === 2 && canSnapshot(h.m));
  const plain = JSON.parse(JSON.stringify(snapshotMatch(h.m)));
  assert.ok(plain.players.every((p) => !Object.hasOwn(p, 'tilt')));
  setTilt(h.m.players.get('p_0'), { s: -0.5, m: 3, floor: 0.1 });
  const doc = JSON.parse(JSON.stringify(snapshotMatch(h.m)));
  assert.deepEqual(doc.players.find((p) => p.playerId === 'p_0').tilt, { s: -0.5, m: 3, floor: 0.1, cut: 0.5, tier: 0, core: true });
  assert.ok(!Object.hasOwn(doc.players.find((p) => p.playerId === 'p_1'), 'tilt'));
  const r = makeMatch({ humans: 2, bots: 2, seats: doc.seats, seed: doc.seed, offlineHoldMs: 0, experimental: doc.experimental });
  assert.equal(restoreMatch(r.m, doc, { createRngFromState, log: QUIET }), true);
  assert.deepEqual(r.m.players.get('p_0').tilt, h.m.players.get('p_0').tilt);
  assert.equal(Object.hasOwn(r.m.players.get('p_1'), 'tilt'), false);
  const r2 = makeMatch({ humans: 2, bots: 2, seats: plain.seats, seed: plain.seed, offlineHoldMs: 0, experimental: plain.experimental });
  assert.equal(restoreMatch(r2.m, plain, { createRngFromState, log: QUIET }), true, 'a checkpoint without it restores');
  assert.equal(Object.hasOwn(r2.m.players.get('p_0'), 'tilt'), false);
  for (const x of [h, r, r2]) x.m.dispose();
});
