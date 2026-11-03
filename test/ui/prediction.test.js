// test/ui/prediction.test.js — client-side prediction of the prep intents (rel26, ui/prediction.js +
// ui/gameLogic/predict.js; the owner's request of 2026-11-02: 商店购买、出售、部署、刷新 must not wait for the server):
//   - predictIntent mirrors the server's direct effects (funds, shop slots, hand / temp / board, deploy count) and
//     declines what it cannot know (merges, items bought, summons, a full hand);
//   - the reconciler: accepted, refused, the reply before / after its state, duplicate acks, a dropped socket, the
//     placeholder of a purchase and the intents waiting for its real uid, the order of sends, the settle fallback;
//   - the server: m.private `ack` echoes the rid of the latest predictable intent (accepted or refused), resets on a
//     reconnect, never moves for a request without a rid, and is not saved in a checkpoint;
//   - parity: a seeded random prep against the real PlayerState — every intent predictIntent predicts ends exactly
//     where the server puts it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GEO, ERR } from '../../shared/constants.js';
import { ACKED_INTENTS } from '../../shared/protocol.js';
import { predictIntent, replayIntents, resolveBought, pieceUids, PREDICTABLE } from '../../public/js/ui/gameLogic/predict.js';
import { createPrediction, SETTLE_MS } from '../../public/js/ui/prediction.js';
import { PLAYER_FIELDS } from '../../server/match/snapshot.js';
import { DATA, makeMatch, give, chessOfTier } from '../match/harness.js';
import { tileKey, parseKey } from '../../server/match/board.js';

const L = { getChess: (id) => DATA.chess[id] || null, getItem: (id) => DATA.items[id] || null };
const T1 = chessOfTier(1).filter((id) => !(DATA.chess[id].tokens || []).length);
const [A, B, C] = T1;

function base(over = {}) {
  return {
    playerId: 'p', alive: true, funds: 10, ack: 0,
    shop: { level: 1, maxLevel: 6, upgradePrice: 4, refreshPrice: 1, freeRefreshes: 0, frozen: false, layout: { chess: 3, item: 0 },
      next: { layout: { chess: 4, item: 0 }, upgradePrice: 5 },
      slots: [A, B, C].map((id) => ({ kind: 'chess', id, price: 2, basePrice: 2, sold: false, frozen: false })) },
    hand: Array(GEO.HAND_SIZE).fill(null), temp: Array(GEO.TEMP_SIZE).fill(null), board: [], deployCap: 3, deployCount: 0,
    ...over,
  };
}
const piece = (uid, id, extra = {}) => ({ uid, kind: 'chess', id, golden: false, tier: 1, items: [], count: 1, ownerUid: null, ...extra });

describe('predictIntent: the direct effects, and nothing it cannot know', () => {
  test('the predicted set is exactly the acknowledged set', () => {
    assert.deepEqual([...PREDICTABLE].sort(), [...ACKED_INTENTS].sort());
  });

  test('g.buy: funds, the slot sold, the piece in the last free hand slot under a placeholder uid', () => {
    const r = predictIntent(base(), { t: 'g.buy', fields: { slot: 1 } }, L, -7);
    assert.equal(r.priv.funds, 8);
    assert.equal(r.priv.shop.slots[1].sold, true);
    assert.equal(r.priv.hand[GEO.HAND_SIZE - 1].uid, -7);
    assert.equal(r.priv.hand[GEO.HAND_SIZE - 1].id, B);
    assert.deepEqual(r.made, { uid: -7, area: 'hand', idx: GEO.HAND_SIZE - 1, id: B, kind: 'chess' });
    assert.equal(base().shop.slots[1].sold, false, 'the input view is never edited');
  });

  test('g.buy declines: sold, poor, a full hand; a merge-completing copy is paid for but not placed', () => {
    assert.equal(predictIntent(base({ funds: 1 }), { t: 'g.buy', fields: { slot: 0 } }, L), null);
    const sold = base(); sold.shop.slots[0] = { ...sold.shop.slots[0], sold: true };
    assert.equal(predictIntent(sold, { t: 'g.buy', fields: { slot: 0 } }, L), null);
    const full = base({ hand: Array.from({ length: GEO.HAND_SIZE }, (_, i) => piece(100 + i, C)) });
    assert.equal(predictIntent(full, { t: 'g.buy', fields: { slot: 0 } }, L), null);
    const two = base({ hand: [piece(1, A), piece(2, A), ...Array(GEO.HAND_SIZE - 2).fill(null)] });
    const r = predictIntent(two, { t: 'g.buy', fields: { slot: 0 } }, L, -3);
    assert.equal(r.priv.funds, 8);
    assert.equal(r.priv.shop.slots[0].sold, true);
    assert.equal(r.made, undefined, 'the elite and where it goes are the server\'s');
    assert.equal(r.priv.hand.filter(Boolean).length, 2);
  });

  test('g.buy of an item: in the last free hand slot under a placeholder, unless it completes a golden item', () => {
    const item = Object.values(DATA.items).find((i) => i.itemType === 'EQUIP' && !i.isGolden && !i.mergeable);
    const v = base(); v.shop.slots.push({ kind: 'item', id: item.id, price: 1, basePrice: 1, sold: false, frozen: false });
    const r = predictIntent(v, { t: 'g.buy', fields: { slot: 3 } }, L, -4);
    assert.equal(r.priv.funds, 9);
    assert.deepEqual([r.priv.hand[GEO.HAND_SIZE - 1].kind, r.priv.hand[GEO.HAND_SIZE - 1].id, r.priv.hand[GEO.HAND_SIZE - 1].uid], ['item', item.id, -4]);
    assert.equal(r.made.kind, 'item');
    const pairable = Object.values(DATA.items).find((i) => i.itemType === 'EQUIP' && !i.isGolden && i.mergeable && DATA.items[i.upgradeChessId || i.goldenId]);
    if (pairable) {
      const w = base({ hand: [{ uid: 3, kind: 'item', id: pairable.id, items: [], count: 1, ownerUid: null }, ...Array(GEO.HAND_SIZE - 1).fill(null)] });
      w.shop.slots.push({ kind: 'item', id: pairable.id, price: 1, basePrice: 1, sold: false, frozen: false });
      const m = predictIntent(w, { t: 'g.buy', fields: { slot: 3 } }, L, -5);
      assert.equal(m.made, undefined, 'the golden item is the server\'s');
      assert.equal(m.priv.funds, 9);
    }
  });

  test('g.sell: the piece and its summons go, its equipment comes back, the sell price is paid', () => {
    const item = Object.values(DATA.items).find((i) => i.itemType === 'EQUIP' && !i.isGolden && !i.mergeable)
      || Object.values(DATA.items).find((i) => i.itemType === 'EQUIP' && !i.isGolden);
    const v = base({ board: [{ ...piece(5, A, { items: [{ uid: 9, id: item.id }] }), row: 2, col: 3, dir: 'RIGHT' }, { uid: 6, kind: 'token', id: 'tok', ownerUid: 5, row: 2, col: 4 }], deployCount: 1 });
    const r = predictIntent(v, { t: 'g.sell', fields: { uid: 5 } }, L);
    assert.equal(r.priv.board.length, 0);
    assert.equal(r.priv.deployCount, 0);
    assert.equal(r.priv.funds, 10 + DATA.chess[A].sellPrice);
    assert.equal(r.priv.hand[GEO.HAND_SIZE - 1].uid, 9);
    assert.equal(predictIntent(v, { t: 'g.sell', fields: { uid: 6 } }, L), null, 'summons are not sold');
  });

  test('g.move: deploy, the deploy cap, board swaps, withdraw, bench swaps; summons and their owners are declined', () => {
    const v = base({ hand: [piece(1, A), piece(2, B), ...Array(GEO.HAND_SIZE - 2).fill(null)] });
    const d = predictIntent(v, { t: 'g.move', fields: { uid: 1, to: { area: 'board', row: 2, col: 3 }, dir: 'UP' } }, L).priv;
    assert.equal(d.hand[0], null);
    assert.deepEqual(d.board.map((p) => [p.uid, p.row, p.col, p.dir]), [[1, 2, 3, 'UP']]);
    assert.equal(d.deployCount, 1);
    assert.equal(predictIntent({ ...d, deployCap: 1 }, { t: 'g.move', fields: { uid: 2, to: { area: 'board', row: 2, col: 4 } } }, L), null, 'BOARD_FULL');
    const sw = predictIntent({ ...d, deployCap: 1 }, { t: 'g.move', fields: { uid: 2, to: { area: 'board', row: 2, col: 3 } } }, L).priv;
    assert.equal(sw.hand[1].uid, 1, 'a hand card onto an operator: the operator takes the card\'s slot (round53)');
    assert.equal(sw.hand[1].row, undefined);
    assert.deepEqual(sw.board.map((p) => p.uid), [2]);
    const bb = predictIntent(d, { t: 'g.move', fields: { uid: 1, to: { area: 'board', row: 1, col: 1 } } }, L).priv;
    assert.deepEqual(bb.board.map((p) => [p.row, p.col, p.dir]), [[1, 1, 'RIGHT']]);
    const back = predictIntent(d, { t: 'g.move', fields: { uid: 1, to: { area: 'hand', idx: 5 } } }, L).priv;
    assert.equal(back.hand[5].uid, 1);
    assert.equal(back.board.length, 0);
    const hh = predictIntent(v, { t: 'g.move', fields: { uid: 1, to: { area: 'hand', idx: 1 } } }, L).priv;
    assert.deepEqual([hh.hand[0].uid, hh.hand[1].uid], [2, 1]);
    const owner = { ...d, board: [...d.board, { uid: 50, kind: 'token', id: 'tok', ownerUid: 1, row: 2, col: 4 }] };
    assert.equal(predictIntent(owner, { t: 'g.move', fields: { uid: 1, to: { area: 'hand', idx: 5 } } }, L), null);
    assert.equal(predictIntent(owner, { t: 'g.move', fields: { uid: 50, to: { area: 'board', row: 1, col: 1 } } }, L), null);
  });

  test('g.refresh / g.freeze / g.levelUp', () => {
    const fr = base(); fr.shop.frozen = true; fr.shop.slots = fr.shop.slots.map((s) => ({ ...s, frozen: true }));
    const r = predictIntent(fr, { t: 'g.refresh' }, L).priv;
    assert.equal(r.funds, 9);
    assert.equal(r.shop.frozen, false);
    assert.equal(r.shop.rolling, true);
    assert.ok(r.shop.slots.every((s) => s === null), 'the new cards are the server\'s');
    const free = base(); free.shop.freeRefreshes = 2; free.shop.refreshPrice = 0;
    const rf = predictIntent(free, { t: 'g.refresh' }, L).priv;
    assert.equal(rf.funds, 10); assert.equal(rf.shop.freeRefreshes, 1);
    assert.equal(predictIntent(base({ funds: 0 }), { t: 'g.refresh' }, L), null);
    const fz = predictIntent(base(), { t: 'g.freeze' }, L).priv;
    assert.equal(fz.shop.frozen, true); assert.ok(fz.shop.slots.every((s) => s.frozen));
    const lv = predictIntent(base(), { t: 'g.levelUp' }, L).priv;
    assert.equal(lv.funds, 6); assert.equal(lv.shop.level, 2);
    assert.equal(lv.shop.upgradePrice, 5, 'the next price from shop.next');
    assert.deepEqual([lv.shop.slots.length, lv.shop.slots[3], lv.shop.layout.chess], [4, null, 4], 'the new slot opens empty');
    assert.equal(predictIntent(lv, { t: 'g.levelUp' }, L), null, 'a second one before the ack: the server\'s (no shop.next yet)');
    const top = base(); top.shop.level = 6;
    assert.equal(predictIntent(top, { t: 'g.levelUp' }, L), null);
    const withItem = base(); withItem.shop.layout = { chess: 3, item: 1 }; withItem.shop.slots.push({ kind: 'item', id: 'x', price: 1, sold: false });
    withItem.shop.next = { layout: { chess: 4, item: 1 }, upgradePrice: 6 };
    const li = predictIntent(withItem, { t: 'g.levelUp' }, L).priv;
    assert.deepEqual(li.shop.slots.map((x) => (x ? x.kind : null)), ['chess', 'chess', 'chess', null, 'item'], 'operators before the equipment column');
  });

  test('resolveBought: the hand slot used, else the only new copy', () => {
    const before = new Set([1]);
    const auth = base({ hand: [piece(1, A), ...Array(GEO.HAND_SIZE - 2).fill(null), piece(77, B)] });
    assert.equal(resolveBought(auth, before, { idx: GEO.HAND_SIZE - 1, id: B }), 77);
    assert.equal(resolveBought(auth, before, { idx: 3, id: B }), 77);
    assert.equal(resolveBought(auth, before, { idx: 3, id: C }), null);
  });
});

/** A prediction over a fake socket: requests are held until the test answers them. */
function rig(start = base()) {
  let rid = 100;
  const sent = [], shown = [];
  const pending = new Map();
  let tid = 0;
  const timers = { setTimeout: (fn, ms) => { const id = ++tid; pending.set(id, { fn, ms }); return id; }, clearTimeout: (id) => pending.delete(id), fire: () => { for (const [id, t] of [...pending]) { pending.delete(id); t.fn(); } }, count: () => pending.size };
  const request = (t, fields, opts = {}) => {
    const r = ++rid;
    opts.onRid?.(r);
    let ok, no;
    const p = new Promise((a, b) => { ok = a; no = b; });
    sent.push({ t, fields: { ...fields }, rid: r, ok: () => ok({ t: 'ok', rid: r }), fail: (code) => no(Object.assign(new Error(code), { code })) });
    return p;
  };
  const P = createPrediction({ request, lookups: L, publish: (v) => shown.push(v), timers });
  P.authoritative(start);
  return { P, sent, shown, timers, last: () => shown.at(-1) };
}
const tick = () => new Promise((r) => setImmediate(r));

describe('the reconciler', () => {
  test('a server without `ack` (rel25): no prediction, the plain request', async () => {
    const { ack, ...old } = base(); // eslint-disable-line no-unused-vars
    const { P, sent, shown } = rig(old);
    const { predicted } = P.submit('g.buy', { slot: 0 });
    assert.equal(predicted, false);
    assert.equal(sent.length, 1, 'sent at once');
    assert.equal(shown.length, 0);
    assert.equal(P.enabled, false);
  });

  test('accepted: shown at once, kept after the reply until the state with its ack, then the server\'s state', async () => {
    const { P, sent, last } = rig();
    const { promise, predicted } = P.submit('g.buy', { slot: 0 });
    assert.equal(predicted, true);
    assert.equal(sent.length, 1);
    assert.equal(last().funds, 8);
    sent[0].ok(); await promise;
    assert.equal(P.pending().length, 1, 'the reply alone (it may overtake the state) keeps it');
    const after = base({ funds: 8, ack: sent[0].rid, hand: [...Array(GEO.HAND_SIZE - 1).fill(null), piece(501, A)] });
    after.shop.slots[0] = { ...after.shop.slots[0], sold: true };
    const v = P.authoritative(after);
    assert.equal(v, after, 'nothing pending: the server\'s own object');
    assert.equal(v.hand.filter(Boolean).length, 1, 'never applied twice');
  });

  test('the state before the reply (the usual order): no double purchase, the reply then changes nothing', async () => {
    const { P, sent } = rig();
    const { promise } = P.submit('g.buy', { slot: 0 });
    const after = base({ funds: 8, ack: sent[0].rid, hand: [...Array(GEO.HAND_SIZE - 1).fill(null), piece(501, A)] });
    after.shop.slots[0] = { ...after.shop.slots[0], sold: true };
    assert.equal(P.authoritative(after).funds, 8);
    sent[0].ok(); await promise;
    assert.equal(P.pending().length, 0);
    assert.equal(P.authoritative(after).funds, 8, 'a duplicate state with the same ack');
  });

  test('refused: rolled back to the server\'s state, the caller sees the error', async () => {
    const { P, sent, last } = rig();
    const { promise } = P.submit('g.sell', { uid: 999 });
    const b = P.submit('g.buy', { slot: 2 });
    assert.equal(b.predicted, true);
    sent[1].fail(ERR.NO_FUNDS);
    await assert.rejects(b.promise, { code: ERR.NO_FUNDS });
    assert.equal(last().funds, 10, 'rolled back');
    sent[0].fail(ERR.BAD_TARGET);
    await assert.rejects(promise, { code: ERR.BAD_TARGET });
  });

  test('a later state still without the ack keeps replaying the intent over it (other changes show too)', () => {
    const { P } = rig();
    P.submit('g.buy', { slot: 0 });
    const other = base({ funds: 15 }); // e.g. an effect paid 5 meanwhile
    const v = P.authoritative(other);
    assert.equal(v.funds, 13);
    assert.equal(v.shop.slots[0].sold, true);
  });

  test('a dropped socket: the sent intent fails and is never replayed; a reconnect\'s ack 0 replays nothing', async () => {
    const { P, sent, last } = rig();
    const { promise } = P.submit('g.buy', { slot: 0 });
    sent[0].fail('DISCONNECTED');
    await assert.rejects(promise);
    assert.equal(last().funds, 10);
    assert.equal(P.authoritative(base({ ack: 0 })).funds, 10);
    assert.equal(P.pending().length, 0);
  });

  test('a purchase\'s placeholder: a move naming it is shown at once, sent with the real uid after the ack', async () => {
    const { P, sent, last } = rig();
    P.submit('g.buy', { slot: 0 });
    const ph = last().hand[GEO.HAND_SIZE - 1].uid;
    assert.ok(ph < 0);
    const mv = P.submit('g.move', { uid: ph, to: { area: 'board', row: 2, col: 3 }, dir: 'UP' });
    assert.equal(mv.predicted, true);
    assert.equal(sent.length, 1, 'waits for the real uid');
    assert.deepEqual(last().board.map((p) => [p.uid, p.row, p.col]), [[ph, 2, 3]]);
    const rdy = P.submit('g.ready', { ready: true });
    assert.equal(rdy.predicted, false);
    assert.equal(sent.length, 1, 'a later intent keeps the order');
    sent[0].ok();
    const after = base({ funds: 8, ack: sent[0].rid, hand: [...Array(GEO.HAND_SIZE - 1).fill(null), piece(501, A)] });
    after.shop.slots[0] = { ...after.shop.slots[0], sold: true };
    const v = P.authoritative(after);
    assert.deepEqual(sent.slice(1).map((s) => [s.t, s.fields.uid ?? null]), [['g.move', 501], ['g.ready', null]]);
    assert.deepEqual(v.board.map((p) => [p.uid, p.row, p.col, p.dir]), [[501, 2, 3, 'UP']], 'now shown on the real piece');
    assert.equal(v.hand.filter(Boolean).length, 0);
    sent[1].ok(); sent[2].ok();
    await mv.promise; await rdy.promise;
  });

  test('a placeholder named after its purchase settled (a drag begun before, dropped after) goes out as the real uid', async () => {
    const { P, sent, last } = rig();
    P.submit('g.buy', { slot: 1 });
    const ph = last().hand[GEO.HAND_SIZE - 1].uid;
    sent[0].ok();
    const after = base({ funds: 8, ack: sent[0].rid, hand: [...Array(GEO.HAND_SIZE - 1).fill(null), piece(601, B)] });
    after.shop.slots[1] = { ...after.shop.slots[1], sold: true };
    P.authoritative(after);
    const mv = P.submit('g.move', { uid: ph, to: { area: 'hand', idx: 0 } });
    assert.equal(mv.predicted, true);
    assert.deepEqual(sent.map((s) => [s.t, s.fields.uid ?? null]), [['g.buy', null], ['g.move', 601]]);
    assert.equal(last().hand[0].uid, 601);
    sent[1].ok(); await mv.promise;
  });

  test('the purchase refused: what waited for its piece fails and is never sent', async () => {
    const { P, sent, last } = rig();
    const buy = P.submit('g.buy', { slot: 0 });
    const ph = last().hand[GEO.HAND_SIZE - 1].uid;
    const sell = P.submit('g.sell', { uid: ph });
    sent[0].fail(ERR.SOLD_OUT);
    await assert.rejects(buy.promise, { code: ERR.SOLD_OUT });
    await assert.rejects(sell.promise, { code: ERR.SOLD_OUT });
    await tick();
    assert.equal(sent.length, 1);
    assert.equal(last().funds, 10);
  });

  test('a placeholder that matches nothing (unknown or already settled) is refused at once', async () => {
    const { P, sent } = rig();
    await assert.rejects(P.submit('g.move', { uid: -42, to: { area: 'hand', idx: 0 } }).promise, { code: 'BAD_TARGET' });
    assert.equal(sent.length, 0);
  });

  test('the settle fallback: a reply whose state never comes stops being replayed after SETTLE_MS', async () => {
    const { P, sent, timers, last } = rig();
    const { promise } = P.submit('g.freeze');
    assert.equal(last().shop.frozen, true);
    sent[0].ok(); await promise;
    assert.equal(timers.count(), 1);
    assert.ok(SETTLE_MS >= 1000);
    timers.fire();
    assert.equal(last().shop.frozen, false);
    assert.equal(P.pending().length, 0);
  });

  test('another seat\'s state (a new match) forgets everything', () => {
    const { P } = rig();
    P.submit('g.buy', { slot: 0 });
    const v = P.authoritative(base({ playerId: 'q', ack: 0 }));
    assert.equal(v.funds, 10);
    assert.equal(P.pending().length, 0);
  });

  test('replayIntents applies in order and reports what it made', () => {
    const r = replayIntents(base(), [{ id: 1, t: 'g.buy', fields: { slot: 0 } }, { id: 2, t: 'g.buy', fields: { slot: 1 } }], L);
    assert.equal(r.priv.funds, 6);
    assert.deepEqual([...r.made.keys()], [1, 2]);
    assert.equal(r.priv.hand[GEO.HAND_SIZE - 1].uid, -1);
    assert.equal(r.priv.hand[GEO.HAND_SIZE - 2].uid, -2);
  });
});

function prepMatch(t, seed = 77) {
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seed }).start().toPrep(1);
  t.after(() => h.m.dispose());
  return { h, m: h.m, ps: h.ps('p_0') };
}

describe('the server echoes the rid as m.private `ack`', () => {
  test('accepted and refused intents set it; other intents and rid-less ones do not; a reconnect resets it', (t) => {
    const { m, ps } = prepMatch(t);
    assert.equal(ps.privateView().ack, 0, 'present from the start: the capability');
    ps.funds = 50;
    assert.ok(m.handle(ps.playerId, { t: 'g.freeze', rid: 12 }).ok);
    assert.equal(ps.privateView().ack, 12);
    assert.ok(m.handle(ps.playerId, { t: 'g.sell', uid: 999999, rid: 13 }).error, 'refused');
    assert.equal(ps.privateView().ack, 13, 'a refusal is acknowledged too');
    m.handle(ps.playerId, { t: 'g.bondPlan', bondId: null, rid: 14 });
    assert.equal(ps.privateView().ack, 13, 'not a predicted intent');
    m.handle(ps.playerId, { t: 'g.freeze' });
    assert.equal(ps.privateView().ack, 13, 'no rid: an external AI or a test');
    m.onDisconnect(ps.playerId); m.onReconnect(ps.playerId);
    assert.equal(ps.privateView().ack, 0, 'a new socket starts over');
  });

  test('a refused intent still sends an m.private (the ack changed) before the reply', (t) => {
    const { h, m, ps } = prepMatch(t);
    const n0 = h.sent.filter(([id, msg]) => id === ps.playerId && msg.t === 'm.private').length;
    m.handle(ps.playerId, { t: 'g.sell', uid: 999999, rid: 40 });
    const privs = h.sent.filter(([id, msg]) => id === ps.playerId && msg.t === 'm.private');
    assert.equal(privs.length, n0 + 1);
    assert.equal(privs.at(-1)[1].ack, 40);
  });

  test('not saved in a checkpoint (transient)', () => {
    assert.ok(PLAYER_FIELDS.transient.includes('intentAck'));
    assert.ok(!PLAYER_FIELDS.saved.includes('intentAck'));
  });
});

/** Tiny seeded PRNG for the parity run. */
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

/** The parts a prediction claims, comparable between the predicted and the server's view (`map`: placeholder → uid). */
function claimed(v, map = new Map(), { slots = true } = {}) {
  const u = (x) => (map.has(x) ? map.get(x) : x);
  const pc = (p) => (p ? [u(p.uid), p.kind, p.id, ...(Number.isInteger(p.row) ? [p.row, p.col, p.dir] : [])].join(':') : '-');
  return {
    funds: v.funds, deployCount: v.deployCount,
    frozen: !!v.shop.frozen, level: v.shop.level, freeRefreshes: v.shop.freeRefreshes, upgradePrice: v.shop.upgradePrice,
    ...(slots ? { slots: v.shop.slots.map((s) => (s ? `${s.id}:${s.sold ? 1 : 0}:${s.frozen ? 1 : 0}` : '-')) } : {}),
    hand: v.hand.map(pc), temp: v.temp.map(pc),
    board: v.board.map(pc).sort(),
  };
}

describe('parity with the real PlayerState', () => {
  test('a seeded random prep: every predicted intent ends where the server puts it', (t) => {
    const { h, m, ps } = prepMatch(t, 4242);
    const R = rng(9);
    const stats = { predicted: 0, declined: 0, refusedButPredicted: 0, steps: 0 };
    const bad = [];
    const pick = (a) => a[Math.floor(R() * a.length)];
    for (let round = 1; round <= 4; round++) {
      if (round > 1) h.toPrep(round);
      ps.funds += 20;
      for (let step = 0; step < 90; step++) {
        const pv = ps.privateView();
        const pieces = [...pv.hand, ...pv.temp, ...pv.board].filter((p) => p && p.kind === 'chess');
        const roll = R();
        let op;
        if (roll < 0.3) op = { t: 'g.buy', fields: { slot: Math.floor(R() * pv.shop.slots.length) } };
        else if (roll < 0.4) op = { t: 'g.sell', fields: { uid: pick(pieces)?.uid ?? 1 } };
        else if (roll < 0.47) op = { t: 'g.refresh' };
        else if (roll < 0.52) op = { t: 'g.freeze' };
        else if (roll < 0.56) op = { t: 'g.levelUp' };
        else {
          const p = pick(pieces);
          if (!p) continue;
          const loc = ps.find(p.uid);
          if (R() < 0.6) {
            // a tile the UI would offer: legal for the piece, and a swapped occupant legal on the source tile
            const tiles = [];
            for (let r = 0; r < GEO.ROWS; r++) for (let c = 0; c < GEO.COLS; c++) {
              if (!ps._legal(loc.piece, r, c)) continue;
              const occ = ps.board.get(tileKey(r, c));
              if (occ && loc.area === 'board' && occ !== loc.piece) { const [sr, sc] = parseKey(loc.key); if (!ps._legal(occ, sr, sc)) continue; }
              tiles.push([r, c]);
            }
            if (!tiles.length) continue;
            const [row, col] = pick(tiles);
            op = { t: 'g.move', fields: { uid: p.uid, to: { area: 'board', row, col }, dir: pick(['UP', 'RIGHT', 'DOWN', 'LEFT']) } };
          } else {
            const idx = Math.floor(R() * GEO.HAND_SIZE);
            const occ = ps.hand[idx];
            if (occ && loc.area === 'board' && occ.kind === 'chess') { const [sr, sc] = parseKey(loc.key); if (!ps._legal(occ, sr, sc)) continue; }
            op = { t: 'g.move', fields: { uid: p.uid, to: { area: 'hand', idx } } };
          }
        }
        stats.steps++;
        const r = predictIntent(pv, op, L, -1);
        const res = m.handle(ps.playerId, { t: op.t, ...(op.fields || {}), rid: 1000 + stats.steps });
        const after = ps.privateView();
        if (!r) { stats.declined++; continue; }
        if (res.error) { stats.refusedButPredicted++; bad.push(`${op.t} ${JSON.stringify(op.fields)} predicted but refused: ${res.error} ${res.detail || ''}`); continue; }
        stats.predicted++;
        const map = new Map();
        if (r.made) {
          const real = resolveBought(after, new Set([...pv.hand, ...pv.temp, ...pv.board].filter(Boolean).map((p) => p.uid)), r.made);
          if (real == null) { bad.push(`${op.t} ${JSON.stringify(op.fields)}: the bought piece is not found`); continue; }
          map.set(r.made.uid, real);
        }
        // pieces the server added that no prediction claims: a summon stack granted on a deployment, a copy an effect
        // grants (those arrive with the server's state); everything else must match
        const known = new Set([...pieceUids(pv), ...map.values()]);
        const granted = [...after.hand, ...after.temp, ...after.board].filter((p) => p && !known.has(p.uid));
        stats.granted = (stats.granted || 0) + granted.length;
        const strip = (v) => ({ ...v, hand: v.hand.map((p) => (p && !known.has(p.uid) ? null : p)), temp: v.temp.map((p) => (p && !known.has(p.uid) ? null : p)), board: v.board.filter((p) => known.has(p.uid)) });
        const want = claimed(strip(after), new Map(), { slots: op.t !== 'g.refresh' }), got = claimed(r.priv, map, { slots: op.t !== 'g.refresh' });
        const diff = Object.keys(want).filter((k) => JSON.stringify(want[k]) !== JSON.stringify(got[k]));
        if (diff.length) bad.push(`${op.t} ${JSON.stringify(op.fields)} R${round}: ${diff.map((k) => `${k} predicted ${JSON.stringify(got[k])} server ${JSON.stringify(want[k])}`).join(' | ')}`);
      }
    }
    t.diagnostic(JSON.stringify(stats));
    assert.deepEqual(bad.slice(0, 12), [], `${bad.length} mismatches`);
    assert.ok(stats.predicted > 150, `most intents are predicted (${JSON.stringify(stats)})`);
  });
});
