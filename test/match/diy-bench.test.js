// 自选候补 in a match (feedback #114; the owner's decision of 2026-11-02: four equal candidates per tier, any two play;
// server/match/player/diy.js, match/phases.js): a seat whose 自选 preset holds more candidates than a tier's slots
// chooses in the briefing (INFO_CHECK) which fill them — g.diyChoose, m.private diyChoice —, the slots and the stock follow at once, a 重刷本局 keeps the choice, the
// default skips a pick whose bonds are all banned, and from the strategy draft on the slots are fixed. A checkpoint's
// seat carries the slots as they are plus the other candidates as bench keys, `diyChoice` is saved: a restore fields
// the same slots, in the briefing and after it; a rel25 checkpoint (no bench, no choice) restores as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch, DATA } from './harness.js';
import { PHASE, ERR } from '../../shared/constants.js';
import { validateC2S } from '../../shared/protocol.js';
import { diyBenchId, diyPickOff, checkDiyPick } from '../../shared/diy.js';
import { snapshotMatch, restoreMatch, canSnapshot } from '../../server/match/snapshot.js';
import { createRngFromState } from '../../server/sim/rng.js';
import { KITTED_CHARS } from '../../server/sim/content/kits/index.js';

const T5A = 'chess_char_5_diy1_a', T5B = 'chess_char_5_diy2_a', T6A = 'chess_char_6_diy1_a';
const B51 = diyBenchId(5, 1), B52 = diyBenchId(5, 2);
const own = (charId) => ({ charId, skillIndex: 2, uniEquipId: null });
// 协防 only (never drawn): the default keeps the slotted two
const KALTS = 'char_003_kalts', SHINING = 'char_147_shining', IFRIT = 'char_134_ifrit', MGLLAN = 'char_248_mgllan';
const AMGOAT = 'char_180_amgoat'; // 6★ 协防 too (a 维多利亚 pick may be banned by the seed)
const PRESET = { [T5A]: own(KALTS), [T5B]: own(SHINING), [B51]: own(IFRIT), [B52]: own(MGLLAN), [T6A]: own(AMGOAT) };
const seatsWith = (diy) => [
  { seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true, diy },
  { seat: 1, playerId: 'ai_0', name: 'AI0', isBot: true, connected: true },
];
const charsOf = (diy) => Object.fromEntries(Object.entries(diy).map(([k, p]) => [k, p.charId]));
/** `seats`: the seats the fresh match is built from — the checkpoint's (local persister), else the platform's (cluster). */
function restored(doc, seats = null) {
  const json = JSON.parse(JSON.stringify(doc));
  const r = makeMatch({ mode: 'coop', seats: seats ?? json.seats, seed: json.seed });
  assert.equal(restoreMatch(r.m, json, { createRngFromState, log: { warn() {} } }), true);
  return r;
}

test('g.diyChoose on the wire: a tier and up to four ids', () => {
  assert.equal(validateC2S({ t: 'g.diyChoose', tier: 5, charIds: [IFRIT, MGLLAN] }), null);
  for (const bad of [{ tier: 5 }, { charIds: [] }, { tier: 'x', charIds: [] }, { tier: 5, charIds: [1] }, { tier: 5, charIds: ['a', 'b', 'c', 'd', 'e'] }]) {
    assert.notEqual(validateC2S({ t: 'g.diyChoose', ...bad }), null, JSON.stringify(bad));
  }
});

test('the briefing lists the candidates; a choice fields them and rebuilds the stock; the slots are fixed after the briefing', (t) => {
  const h = makeMatch({ mode: 'coop', seats: seatsWith(PRESET), seed: 7 }).start();
  t.after(() => h.m.dispose());
  const m = h.m, ps = h.ps('p_0');
  assert.equal(m.phase, PHASE.INFO_CHECK);
  assert.deepEqual(charsOf(ps.diy), { [T5A]: KALTS, [T5B]: SHINING, [T6A]: AMGOAT }, 'the default: the slotted two (协防 is never banned)');
  let priv = h.lastTo('p_0', 'm.private');
  assert.deepEqual(priv.diyChoice.tiers.map((x) => [x.tier, x.slots, x.candidates.map((c) => c.charId), x.chosen, x.picked]),
    [[5, 2, [KALTS, SHINING, IFRIT, MGLLAN], [KALTS, SHINING], false]], 'tier 6 has one candidate: no choice there');
  // refused: a tier without a choice, a wrong count, a repeat, someone not in the preset
  for (const [tier, ids] of [[6, [AMGOAT]], [5, [IFRIT]], [5, [IFRIT, IFRIT]], [5, [IFRIT, AMGOAT]], [5, [IFRIT, MGLLAN, KALTS]]]) {
    assert.equal(m.handle('p_0', { t: 'g.diyChoose', tier, charIds: ids }).error, ERR.BAD_TARGET, JSON.stringify([tier, ids]));
  }
  assert.deepEqual(m.handle('p_0', { t: 'g.diyChoose', tier: 5, charIds: [MGLLAN, KALTS] }), { ok: true });
  assert.deepEqual(charsOf(ps.diy), { [T5A]: KALTS, [T5B]: MGLLAN, [T6A]: AMGOAT }, '凯尔希 keeps slot 5-1, 麦哲伦 takes 5-2');
  assert.deepEqual([...ps.diyStock.entries.keys()].sort(), [T5A, T5B, T6A].sort());
  assert.equal(ps.gd.chess(T5B).charId, MGLLAN, 'the data view composes the new pick');
  assert.equal(ps.gd.chess('chess_char_5_diy2_b').charId, MGLLAN);
  priv = h.lastTo('p_0', 'm.private');
  assert.deepEqual(priv.diy[T5B].charId, MGLLAN);
  assert.deepEqual([priv.diyChoice.tiers[0].chosen, priv.diyChoice.tiers[0].picked], [[KALTS, MGLLAN], true]);
  // ready does not lock it; the briefing's end does
  assert.deepEqual(m.handle('p_0', { t: 'g.infoReady' }), { ok: true });
  h.drive(() => m.phase === PHASE.BAND_DRAFT);
  assert.equal(m.handle('p_0', { t: 'g.diyChoose', tier: 5, charIds: [IFRIT, KALTS] }).error, ERR.WRONG_PHASE);
  assert.deepEqual(charsOf(ps.diy), { [T5A]: KALTS, [T5B]: MGLLAN, [T6A]: AMGOAT });
  h.flushAll();
  assert.equal(h.lastTo('p_0', 'm.private').diyChoice, undefined, 'm.private carries the choice in the briefing only');
});

test('the default fields a 候补 for a slotted pick whose bonds are all banned this match', (t) => {
  // a seed whose bans switch off every bond of one of these owned 6★ (the setup does not depend on the seats' picks)
  const pool = (DATA.backups.diy.ownedPool || []).filter((id) => KITTED_CHARS.includes(id) && id !== KALTS && id !== IFRIT && 'ok' in checkDiyPick(T5A, own(id), DATA));
  let seed = 0, dead = null;
  for (let s = 1; s <= 80 && !dead; s++) {
    const probe = makeMatch({ mode: 'coop', seats: seatsWith(null), seed: s });
    const off = probe.m.diyOff();
    dead = pool.find((id) => diyPickOff(DATA, id, off)) ?? null;
    if (dead) seed = s;
    probe.m.dispose();
  }
  assert.ok(dead, 'some seed bans every bond of an owned pick');
  const h = makeMatch({ mode: 'coop', seats: seatsWith({ [T5A]: own(dead), [T5B]: own(KALTS), [B51]: own(IFRIT) }), seed }).start();
  t.after(() => h.m.dispose());
  const ps = h.ps('p_0');
  assert.deepEqual(charsOf(ps.diy), { [T5A]: IFRIT, [T5B]: KALTS }, `${dead} is out, 伊芙利特 takes its slot`);
  assert.deepEqual(ps.diyBanned, []);
  const tier = h.lastTo('p_0', 'm.private').diyChoice.tiers[0];
  assert.deepEqual(tier.candidates.map((c) => [c.charId, !!c.off]), [[dead, true], [KALTS, false], [IFRIT, false]]);
  assert.deepEqual(tier.candidates[0].banned, DATA.backups.diy.operators[dead].bonds, 'the banned bonds are named');
  assert.equal(tier.candidates[1].banned, undefined);
  assert.equal(tier.picked, false);
  // the player may still take the banned one (no stock: it leaves the shop like any banned 自选 piece)
  assert.deepEqual(h.m.handle('p_0', { t: 'g.diyChoose', tier: 5, charIds: [dead, KALTS] }), { ok: true });
  assert.deepEqual(charsOf(ps.diy), { [T5A]: dead, [T5B]: KALTS });
  assert.deepEqual(ps.diyBanned, [T5A]);
});

test('checkpoints: the briefing with a choice, a later prep, and a rel25 document without 候补 restore the same slots', (t) => {
  const h = makeMatch({ mode: 'coop', seats: seatsWith(PRESET), seed: 7 }).start();
  t.after(() => h.m.dispose());
  assert.deepEqual(h.m.handle('p_0', { t: 'g.diyChoose', tier: 5, charIds: [IFRIT, MGLLAN] }), { ok: true });
  const ps = h.ps('p_0');
  assert.deepEqual(charsOf(ps.diy), { [T5A]: IFRIT, [T5B]: MGLLAN, [T6A]: AMGOAT });
  const doc = snapshotMatch(h.m);
  // the seat: the slots as they are, the rest as bench keys in preset order
  assert.deepEqual(charsOf(doc.seats.find((s) => s.playerId === 'p_0').diy), { [T5A]: IFRIT, [T5B]: MGLLAN, [T6A]: AMGOAT, [B51]: KALTS, [B52]: SHINING });
  const r = restored(doc);
  t.after(() => r.m.dispose());
  const rp = r.ps('p_0');
  assert.equal(r.m.phase, PHASE.INFO_CHECK);
  assert.deepEqual(charsOf(rp.diy), charsOf(ps.diy));
  assert.deepEqual(rp.diyChoice, { 5: [IFRIT, MGLLAN] });
  assert.deepEqual([...rp.diyStock.entries.keys()].sort(), [T5A, T5B, T6A].sort());
  r.m.markPrivate(rp);
  r.flushAll();
  // still open after the restore: the player can change it again
  assert.deepEqual(r.m.handle('p_0', { t: 'g.diyChoose', tier: 5, charIds: [KALTS, SHINING] }), { ok: true });
  assert.deepEqual(charsOf(rp.diy), { [T5A]: KALTS, [T5B]: SHINING, [T6A]: AMGOAT });

  // the cluster builds the fresh match from its assignment's seats (the preset as the match started): the checkpoint's
  // seat still names the slots
  const rc = restored(doc, seatsWith(PRESET));
  t.after(() => rc.m.dispose());
  assert.deepEqual(charsOf(rc.ps('p_0').diy), { [T5A]: IFRIT, [T5B]: MGLLAN, [T6A]: AMGOAT });
  assert.deepEqual(rc.ps('p_0').diyStock.snapshot(), ps.diyStock.snapshot());

  // a later prep: the slots and the stock come back as they were, and stay fixed
  h.toPrep(1);
  h.run(() => canSnapshot(h.m));
  const prepDoc = snapshotMatch(h.m);
  assert.ok(prepDoc);
  const r2 = restored(prepDoc);
  t.after(() => r2.m.dispose());
  assert.equal(r2.m.phase, PHASE.PREP);
  assert.deepEqual(charsOf(r2.ps('p_0').diy), { [T5A]: IFRIT, [T5B]: MGLLAN, [T6A]: AMGOAT });
  assert.deepEqual(r2.ps('p_0').diyStock.snapshot(), ps.diyStock.snapshot());
  assert.equal(r2.m.handle('p_0', { t: 'g.diyChoose', tier: 5, charIds: [KALTS, SHINING] }).error, ERR.WRONG_PHASE);
  const r2c = restored(prepDoc, seatsWith(PRESET));
  t.after(() => r2c.m.dispose());
  assert.deepEqual(charsOf(r2c.ps('p_0').diy), { [T5A]: IFRIT, [T5B]: MGLLAN, [T6A]: AMGOAT }, 'cluster-style restore of a later prep');
  assert.deepEqual(r2c.ps('p_0').diyStock.snapshot(), ps.diyStock.snapshot());

  // a rel25 document: no bench keys, no diyChoice — the slots it names, nothing to choose
  const old = JSON.parse(JSON.stringify(prepDoc));
  const seat = old.seats.find((s) => s.playerId === 'p_0');
  for (const k of Object.keys(seat.diy)) if (k.startsWith('diyBench_')) delete seat.diy[k];
  for (const p of old.players) delete p.f.diyChoice;
  const r3 = restored(old);
  t.after(() => r3.m.dispose());
  assert.deepEqual(charsOf(r3.ps('p_0').diy), { [T5A]: IFRIT, [T5B]: MGLLAN, [T6A]: AMGOAT });
  assert.equal(r3.ps('p_0').hasDiyChoice(), false);
});

test('重刷本局 keeps an explicit choice and reads the default again against the new bans', (t) => {
  const h = makeMatch({ mode: 'coop', humans: 1, seats: seatsWith(PRESET), seed: 7 }).start();
  t.after(() => h.m.dispose());
  const m = h.m, ps = h.ps('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.diyChoose', tier: 5, charIds: [SHINING, IFRIT] }), { ok: true });
  const before = m.setupRevision;
  assert.deepEqual(m.requestSetupReroll('p_0', before), { ok: true }, 'a lone human rerolls at once');
  assert.equal(m.setupRevision, before + 1);
  assert.equal(m.phase, PHASE.INFO_CHECK);
  assert.deepEqual(charsOf(ps.diy), { [T5A]: IFRIT, [T5B]: SHINING, [T6A]: AMGOAT });
  assert.deepEqual([...ps.diyStock.entries.keys()].sort(), [T5A, T5B, T6A].sort());
});
