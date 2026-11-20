// Experimental ELO, step 2 (§37.275, shared/elo.js ELO_MAP / eloSummary): in a room with `experimental.elo` every human
// seat is tilted by its own recent matches (seats[].elo, [won, roundsPassed]; a quick loss weighs little), AI seats never;
// the streams a tilt draws from come from the match's private secret like every stream of every match (server/match/
// secret.js, §37.277), which the checkpoint keeps; an AI teammate's rescue of a hindered human is a draw of that secret.
// Without the option nothing of it exists: the same streams, no field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Match } from '../../server/match/Match.js';
import { VirtualScheduler } from '../../server/match/scheduler.js';
import { makeMatch, DATA, give, chessOfTier, legalTileFor } from './harness.js';
import { FakeBattle } from './fakeBattle.js';
import { ELO_MAP, eloSummary, eloTilt, eloTiltAt, eloSeed, eloWillRescue, setTilt, tiltOf, tiltFactor } from '../../server/match/tilt.js';
import { isMatchSecret, secretSeed, seedSecret } from '../../server/match/secret.js';
import { canSnapshot, snapshotMatch, restoreMatch, checkSnapshot } from '../../server/match/snapshot.js';
import { createRng, createRngFromState } from '../../server/sim/rng.js';
import { EXPERIMENTAL_DEFAULTS } from '../../shared/experimental.js';
import { PHASE } from '../../shared/constants.js';

const QUIET = { warn() {}, info() {}, error() {} };
const ELO = Object.freeze({ ...EXPERIMENTAL_DEFAULTS, elo: true });
/** `wins` wins and `losses` losses on the wire (newest first), each loss after `rounds` rounds (14: a full loss). */
const ent = (wins, losses, rounds = 14) => [...Array.from({ length: wins }, () => [1, 14]), ...Array.from({ length: losses }, () => [0, rounds])];
const S1 = 'ab'.repeat(32), S2 = '0f'.repeat(32);
const seatsOf = (lists, bots = 0) => [
  ...lists.map((elo, seat) => ({ seat, playerId: `p_${seat}`, name: `P${seat}`, isBot: false, connected: true, ...(elo !== undefined ? { elo } : {}) })),
  ...Array.from({ length: bots }, (_, i) => ({ seat: lists.length + i, playerId: `ai_${i}`, name: `AI${i}`, isBot: true, connected: true, elo: ent(30, 0) })),
];

test('ELO_MAP: fewer than 5 weighted games or 50 % → no tilt; help to s = +1 by w 0.3 (M 8); hinder to −1 by w 0.9 (M 4), the floor from 0.8', () => {
  assert.equal(eloTilt(null), null);
  assert.equal(eloTilt([]), null);
  assert.equal(eloTilt(ent(4, 0)), null, 'fewer than minGames');
  assert.equal(eloTilt(ent(15, 15)), null, 'exactly 50 %');
  assert.equal(eloSummary(ent(0, 30)).w, 2 / 34);
  // a quick loss weighs roundsPassed / 10 (the owner: five quick losses must not mean full help)
  assert.equal(ELO_MAP.lossRounds, 10);
  assert.deepEqual(eloSummary(ent(0, 5, 2)), { n: 5, wins: 0, losses: 5, games: 1, w: null, s: 0, tilt: null });
  assert.equal(eloSummary(ent(0, 10, 5)).games, 5, 'ten losses after 5 rounds: 5 games');
  assert.equal(eloSummary(ent(18, 12, 7)).games, 26.4);
  assert.equal(eloSummary([...ent(1, 0), [0, 30]]).games, 2, 'a loss never weighs more than 1');
  // the owner's shape: { victory, roundsPassed, mode, difficulty } entries, filtered by the room's mode and difficulty
  const objs = [{ victory: true, roundsPassed: 14, mode: 'solo', difficulty: 'ABYSS' }, { victory: false, roundsPassed: 4, mode: 'solo', difficulty: 'ABYSS' },
    { victory: false, roundsPassed: 14, mode: 'coop', difficulty: 'ABYSS' }];
  assert.deepEqual(eloSummary(objs, { mode: 'solo', difficulty: 'ABYSS' }), { n: 2, wins: 1, losses: 1, games: 1.4, w: null, s: 0, tilt: null });
  assert.equal(eloSummary(objs).n, 3);
  assert.equal(eloSummary(ent(40, 0)).n, 30, 'the newest 30 only');
  assert.deepEqual(eloTiltAt(0.3), { s: 1, m: 8 });
  assert.deepEqual(eloTiltAt(0.1), { s: 1, m: 8 });
  assert.deepEqual(eloTiltAt(0.4), { s: 0.5, m: 8 });
  assert.deepEqual(eloTiltAt(0.7), { s: -0.5, m: 4 });
  assert.deepEqual(eloTiltAt(0.8), { s: -0.75, m: 4 }, 'no floor yet');
  assert.deepEqual(eloTiltAt(0.85), { s: -0.875, m: 4, floor: 0, mix: 0.5 });
  assert.deepEqual(eloTiltAt(0.9), { s: -1, m: 4, floor: 0, mix: 1 });
  assert.deepEqual(eloTiltAt(1), { s: -1, m: 4, floor: 0, mix: 1 });
  assert.equal(ELO_MAP.minGames, 5);
  // over a full window the strength never rises with a win, and a key card's weight never rises either
  let last = Infinity, lastKey = Infinity;
  for (let w = 0; w <= 30; w++) {
    const o = eloTilt(ent(w, 30 - w));
    const s = o ? o.s : 0;
    assert.ok(s <= last, `s at ${w}/30`);
    const t = o ? { cut: 0.5, core: true, floor: null, ...o } : null;
    const key = t ? tiltFactor(t, 1) : 1;
    assert.ok(key <= lastKey + 1e-12, `key-card weight at ${w}/30`);
    last = s; lastKey = key;
  }
  assert.equal(tiltFactor({ cut: 0.5, core: true, ...eloTilt(ent(30, 0)) }, 0.7), 0, 'w 0.94: a key card is never dealt');
  assert.ok(tiltFactor({ cut: 0.5, core: true, ...eloTilt(ent(30, 0)) }, 0.35) > 0, 'below the cut: M^(s·r)');
});

test('setTilt keeps `mix` only with a floor; the floor share is mix (step 1: |s|)', () => {
  const h = makeMatch({ mode: 'solo', seed: 3, fake: true });
  const ps = h.m.players.get('p_0');
  assert.deepEqual(setTilt(ps, { s: -0.5, m: 4, mix: 0.5 }), { s: -0.5, m: 4, floor: null, cut: 0.5, tier: 0, core: true });
  assert.deepEqual(setTilt(ps, { s: -0.5, m: 4, floor: 0, mix: 2 }), { s: -0.5, m: 4, floor: 0, cut: 0.5, mix: 1, tier: 0, core: true });
  const f = Math.pow(4, -0.5);
  assert.equal(tiltFactor({ s: -0.5, m: 4, floor: 0, cut: 0.5, core: true }, 1), f * 0.5, 'step 1: lerp by |s|');
  assert.equal(tiltFactor({ s: -0.5, m: 4, floor: 0, cut: 0.5, mix: 0.25, core: true }, 1), f * 0.75);
  assert.equal(tiltFactor({ s: -0.5, m: 4, floor: 0, cut: 0.5, mix: 0, core: true }, 1), f);
  h.m.dispose();
});

test('an ELO room tilts every human by its own matches and no AI; without the option nothing is set; every stream is the secret\'s', () => {
  const on = makeMatch({ seats: seatsOf([ent(25, 5), ent(5, 25), ent(2, 1)], 1), seed: 11, experimental: ELO, matchSecret: S1, fake: true });
  const p = (h, id) => h.m.players.get(id);
  assert.deepEqual(tiltOf(p(on, 'p_0')), { s: -0.735, m: 4, floor: null, cut: 0.5, tier: 0, core: true }, '25 of 30: w 0.794');
  assert.equal(tiltOf(p(on, 'p_1')).s, 1, '5 of 30: w 0.206');
  for (const id of ['p_2', 'ai_0']) assert.equal(Object.hasOwn(p(on, id), 'tilt'), false, id);
  const none = makeMatch({ seats: seatsOf([null, undefined]), seed: 11, experimental: ELO, matchSecret: S1, fake: true });
  for (const id of ['p_0', 'p_1']) assert.equal(Object.hasOwn(p(none, id), 'tilt'), false, `${id}: no matches`);
  none.m.dispose();
  assert.equal(on.m.elo, true);
  assert.equal(on.m.matchSecret, S1);
  const off = makeMatch({ seats: seatsOf([ent(25, 5), ent(5, 25)]), seed: 11, fake: true });
  assert.equal(off.m.elo, false);
  assert.equal(off.m.matchSecret, seedSecret(11), 'the harness fixes the secret by the seed');
  for (const ps of off.m.players.values()) assert.equal(Object.hasOwn(ps, 'tilt'), false);
  // every stream is the match secret's (§37.277), with the option or without: the tilted ones untouched yet, and the
  // setup's, the waves' and the bots' (drawn by the constructor) the same for another seed with the same secret
  for (const name of ['shop', 'draft', 'meta']) {
    const key = `rng${name[0].toUpperCase()}${name.slice(1)}`;
    assert.equal(on.m[key].state(), createRng(secretSeed(S1, name)).state(), key);
    assert.equal(off.m[key].state(), createRng(secretSeed(seedSecret(11), name)).state(), key);
  }
  const twin = makeMatch({ seats: seatsOf([ent(25, 5), ent(5, 25)]), seed: 9999, matchSecret: seedSecret(11), fake: true });
  for (const key of ['rngSetup', 'rngShop', 'rngWaves', 'rngDraft', 'rngBots', 'rngMeta']) assert.equal(twin.m[key].state(), off.m[key].state(), key);
  twin.m.dispose();
  assert.equal(eloSeed(on.m, 'x'), secretSeed(S1, 'x'));
  assert.notEqual(secretSeed(S1, 'x'), secretSeed(S2, 'x'));
  assert.equal(eloSeed(off.m, 'x'), secretSeed(seedSecret(11), 'x'));
  // a fresh random secret without one given (never a function of the seed)
  const fresh = makeMatch({ mode: 'solo', seed: 11, experimental: ELO, fake: true, randomSecret: true });
  const fresh2 = makeMatch({ mode: 'solo', seed: 11, experimental: ELO, fake: true, randomSecret: true });
  assert.ok(isMatchSecret(fresh.m.matchSecret));
  assert.notEqual(fresh.m.matchSecret, fresh2.m.matchSecret);
  fresh2.m.dispose();
  for (const h of [on, off, fresh]) h.m.dispose();
});

test('a tilt by the test hook alone draws from the match secret\'s streams too; so does the ELO room\'s solo second draft', () => {
  const hook = makeMatch({ mode: 'solo', seed: 21, fake: true });
  setTilt(hook.m.players.get('p_0'), { s: 1 });
  assert.equal(hook.m.rngShop.state(), createRng(secretSeed(seedSecret(21), 'shop')).state());
  assert.equal(eloSeed(hook.m, 'tilt-sp:3'), secretSeed(seedSecret(21), 'tilt-sp:3'));
  const room = makeMatch({ mode: 'solo', seats: seatsOf([ent(0, 30)]), seed: 21, experimental: ELO, matchSecret: S2, fake: true });
  assert.equal(eloSeed(room.m, 'tilt-sp:3'), secretSeed(S2, 'tilt-sp:3'));
  for (const h of [hook, room]) h.m.dispose();
});

test('checkpoint: an ELO match keeps its secret (and every tilt); a document without it, or of another secret, is refused', () => {
  const h = makeMatch({ seats: seatsOf([ent(28, 2), ent(3, 27)], 2), seed: 31, experimental: ELO, matchSecret: S1, fake: true }).start();
  h.drive(() => h.m.phase === PHASE.PREP && h.m.round === 2 && canSnapshot(h.m));
  const doc = JSON.parse(JSON.stringify(snapshotMatch(h.m)));
  assert.equal(doc.matchSecret, S1);
  assert.equal(doc.experimental.elo, true);
  assert.ok(doc.seats.every((s) => !Object.hasOwn(s, 'elo')), 'the seats carry no matches: the tilt travels itself');
  // a fresh instance of the platform's (built with the saved secret, §37.277; its seats without matches) takes the saved
  // tilts and streams
  const r = makeMatch({ seats: doc.seats, seed: doc.seed, offlineHoldMs: 0, experimental: doc.experimental, matchSecret: doc.matchSecret });
  assert.equal(restoreMatch(r.m, doc, { createRngFromState, log: QUIET }), true);
  assert.equal(r.m.matchSecret, S1);
  for (const id of ['p_0', 'p_1', 'ai_0', 'ai_1']) assert.deepEqual(r.m.players.get(id).tilt, h.m.players.get(id).tilt, id);
  for (const key of ['rngShop', 'rngDraft', 'rngMeta']) assert.equal(r.m[key].state(), h.m[key].state(), key);
  const { matchSecret, ...without } = doc;
  void matchSecret;
  const r2 = makeMatch({ seats: doc.seats, seed: doc.seed, offlineHoldMs: 0, experimental: doc.experimental, matchSecret: doc.matchSecret });
  assert.equal(checkSnapshot(r2.m, without), 'secret');
  assert.equal(checkSnapshot(r2.m, { ...doc, matchSecret: 1234 }), 'secret', 'a malformed secret');
  assert.equal(checkSnapshot(r2.m, { ...doc, matchSecret: S2 }), 'secret', 'another secret than the match was built with');
  assert.equal(restoreMatch(r2.m, without, { createRngFromState, log: QUIET }), false);
  // a match built with its own random secret cannot take the document either (a restore must pass the saved one)
  const r3 = makeMatch({ seats: doc.seats, seed: doc.seed, offlineHoldMs: 0, experimental: doc.experimental, randomSecret: true });
  assert.ok(isMatchSecret(r3.m.matchSecret));
  assert.equal(restoreMatch(r3.m, doc, { createRngFromState, log: QUIET }), false);
  // without the option the document carries the match's secret just the same
  const o = makeMatch({ humans: 2, bots: 2, seed: 31, fake: true }).start();
  o.drive(() => o.m.phase === PHASE.PREP && o.m.round === 2 && canSnapshot(o.m));
  const plain = JSON.parse(JSON.stringify(snapshotMatch(o.m)));
  assert.equal(plain.matchSecret, seedSecret(31));
  for (const x of [h, r, r2, r3, o]) x.m.dispose();
});

test('eloWillRescue: always outside an ELO room, for an untilted or helped target; a hindered one with chance 1 + s, a pure draw', () => {
  const h = makeMatch({ seats: seatsOf([ent(30, 0), ent(0, 30), ent(22, 8), null]), seed: 41, experimental: ELO, matchSecret: S2, fake: true });
  const m = h.m, ps = (id) => m.players.get(id);
  const states = () => ['rngSetup', 'rngShop', 'rngWaves', 'rngDraft', 'rngBots', 'rngMeta'].map((k) => m[k].state());
  const before = states();
  assert.equal(tiltOf(ps('p_0')).s, -1);
  for (let r = 1; r <= 14; r++) { m.round = r; assert.equal(eloWillRescue(m, ps('p_0')), false, 's = −1: never'); }
  for (let r = 1; r <= 14; r++) { m.round = r; assert.equal(eloWillRescue(m, ps('p_1')), true); assert.equal(eloWillRescue(m, ps('p_3')), true); }
  // s ≈ −0.51 (22 of 30): the draw of (round, seat), the same however often it is asked
  const t = tiltOf(ps('p_2'));
  let yes = 0;
  for (let r = 1; r <= 400; r++) {
    m.round = r;
    const a = eloWillRescue(m, ps('p_2'));
    assert.equal(eloWillRescue(m, ps('p_2')), a);
    assert.equal(a, createRng(secretSeed(S2, `rescue:${r}:2`))() < 1 + t.s);
    if (a) yes++;
  }
  assert.ok(Math.abs(yes / 400 - (1 + t.s)) < 0.1, `${yes} of 400`);
  assert.deepEqual(states(), before, 'no stream moved');
  // outside an ELO room a hook tilt changes nothing of the rescue
  const off = makeMatch({ humans: 2, seed: 41, fake: true });
  setTilt(off.m.players.get('p_0'), { s: -1 });
  assert.equal(eloWillRescue(off.m, off.m.players.get('p_0')), true);
  for (const x of [h, off]) x.m.dispose();
});

/** 队友复活 with AI teammates (test/match/revival.test.js scenario): p_0 at LP 1 leaks and dies as the round settles. */
function rescueScenario(t, list) {
  const sched = new VirtualScheduler();
  FakeBattle.reset();
  FakeBattle.script = (b) => (b.kind === 'normal' ? { leaks: { p_0: 1 }, coins: {} } : { survivors: { p_0: 1 }, coins: {} });
  const seats = [{ seat: 0, playerId: 'p_0', name: 'Target', connected: true, isBot: false, elo: list },
    { seat: 1, playerId: 'p_1', name: 'AI1', isBot: true }, { seat: 2, playerId: 'p_2', name: 'AI2', isBot: true }];
  const m = new Match({
    roomCode: 'ELO', mode: 'coop', difficulty: 'NORMAL', data: DATA, seats, seed: 4501, matchNo: 1,
    experimental: { ...ELO, revivalEnabled: true }, matchSecret: S1, scheduler: sched, BattleClass: FakeBattle, clientCombat: false, botRehearsal: 0,
    afkRemoveRounds: 0, send: () => true, broadcast: () => {}, onEnd: () => {},
  });
  t.after(() => m.dispose());
  for (const p of m.order) p.lp = p.playerId === 'p_0' ? 1 : 25;
  m.startRound(1);
  assert.ok(sched.runUntil(() => m.phase === PHASE.PREP));
  const target = m.players.get('p_0');
  const id = chessOfTier(1).find((x) => m.pool.has(x));
  give(m, target, id, 'board', legalTileFor(m, target, id));
  assert.deepEqual(m.handle('p_0', { t: 'g.ready', ready: true }), { ok: true });
  assert.ok(sched.runUntil(() => m.phase === PHASE.SETTLE || m.phase === PHASE.RESULT || m.ended));
  return { m, target };
}

test('in an ELO room the AI teammates rescue a helped human at once and never one at s = −1', (t) => {
  const helped = rescueScenario(t, ent(0, 30));
  assert.equal(helped.target.alive, true);
  assert.equal(helped.target.revived, true);
  assert.equal(helped.target.lp, 1);
  const hindered = rescueScenario(t, ent(30, 0));
  assert.equal(tiltOf(hindered.target).s, -1);
  assert.equal(hindered.target.alive, false);
  assert.equal(hindered.target.revived, false);
  assert.equal(hindered.target.pendingDeath, false, 'no human can pay: the death is final at once');
});
