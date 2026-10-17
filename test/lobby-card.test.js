// room.card (fork lobby, 2026-10-14): a player's display card — portrait and avatar operators, namecard background, self-reported
// trophies — kept on the session, copied to the player's seat and shown to the room (room.state seats[].card); a real
// operator only, rate-limited changes, never part of a match (local or cluster).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Lobby, CARD_CHANGES, CARD_WINDOW_MS } from '../server/lobby.js';
import { ClusterLobby } from '../server/cluster/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { validateC2S, CARD_LIMITS } from '../shared/protocol.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';
import { DATA } from './match/harness.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const OPS = [...new Set(Object.values(DATA.chess).map((c) => c.charId).filter(Boolean))].sort();
const [AMIYA, OTHER] = OPS;

class StubMatch {
  constructor(opts) { this.opts = opts; }
  start() {}
  dispose() {}
}

function fixture(t, { LobbyClass = Lobby, extra = {}, getData = () => DATA } = {}) {
  const clock = { time: 50_000 };
  const registry = new SessionRegistry({ now: () => clock.time });
  const lobby = new LobbyClass({ registry, MatchClass: StubMatch, getData, log: quiet, now: () => clock.time, ...extra });
  t.after(() => lobby.shutdown());
  let count = 0;
  const player = () => {
    const s = registry.create(`Card${++count}`);
    s.messages = []; s.connected = true; s.matchmakingVersion = MATCHMAKING_VERSION;
    s.ws = { readyState: 1, bufferedAmount: 0, send(raw, cb) { s.messages.push(JSON.parse(raw)); cb?.(); } };
    lobby.onHello(s, { resumed: false, repeat: false });
    return s;
  };
  const states = (s) => s.messages.filter((m) => m.t === 'room.state');
  const card = (s, msg) => lobby.onMessage(s, { t: 'room.card', ...msg });
  return { clock, registry, lobby, player, states, card };
}

test('room.card wire shape: optional charId / avatar / bg ids ("" clears) and an integer trophy count', () => {
  const ok = (msg) => assert.equal(validateC2S({ t: 'room.card', ...msg }), null, JSON.stringify(msg));
  const bad = (msg, field) => assert.equal(validateC2S({ t: 'room.card', ...msg }), `bad field ${field}`, JSON.stringify(msg));
  ok({});
  ok({ charId: '', avatar: '', bg: '', trophies: 0 });
  ok({ charId: 'char_002_amiya', avatar: 'char_017_huang', bg: 'namecard/skin:01-a_b', trophies: CARD_LIMITS.trophies });
  ok({ bg: 'BG_Default' });
  ok({ avatar: 'char_002_amiya' });
  for (const avatar of ['Char_002_amiya', 'amiya', `char_${'a'.repeat(44)}`, null, 7]) bad({ avatar }, 'avatar');
  bad({ charId: 'Char_002_amiya' }, 'charId');
  bad({ charId: 'amiya' }, 'charId');
  bad({ charId: `char_${'a'.repeat(44)}` }, 'charId');
  bad({ charId: null }, 'charId');
  bad({ bg: '-leading' }, 'bg');
  bad({ bg: 'a b' }, 'bg');
  bad({ bg: 'x'.repeat(49) }, 'bg');
  bad({ bg: 7 }, 'bg');
  for (const trophies of [-1, 1.5, CARD_LIMITS.trophies + 1, '5', null]) bad({ trophies }, 'trophies');
});

test('a card follows the session into rooms, shows on human seats only and changes are broadcast to the room', (t) => {
  const { lobby, player, states, card } = fixture(t);
  const a = player(), b = player(), watcher = player();
  assert.deepEqual(card(a, { charId: AMIYA, bg: 'bg_1', trophies: 12 }), { ok: true });
  assert.deepEqual(a.card, { charId: AMIYA, bg: 'bg_1', trophies: 12 });
  assert.ok(Object.isFrozen(a.card));
  assert.deepEqual(lobby.create(a, { mode: 'coop', difficulty: 'NORMAL' }), { ok: true });
  const room = lobby.roomOf(a);
  assert.deepEqual(lobby.join(b, { code: room.code }), { ok: true });
  assert.deepEqual(lobby.addBot(a), { ok: true });
  assert.deepEqual(lobby.spectate(watcher, { code: room.code }), { ok: true });
  let seats = states(b).at(-1).seats;
  assert.deepEqual(seats[0].card, { charId: AMIYA, bg: 'bg_1', trophies: 12 }, 'the seat took the session card');
  assert.equal(Object.hasOwn(seats[1], 'card'), false, 'no card, no key');
  assert.equal(Object.hasOwn(seats[2], 'card'), false, 'an AI seat has none');
  assert.ok(states(b).at(-1).spectators.every((s) => !Object.hasOwn(s, 'card')));

  const before = { a: states(a).length, b: states(b).length, w: states(watcher).length };
  assert.deepEqual(card(b, { charId: OTHER }), { ok: true });
  assert.deepEqual(states(a).at(-1).seats[1].card, { charId: OTHER });
  assert.equal(states(a).length, before.a + 1);
  assert.equal(states(watcher).length, before.w + 1, 'the whole room (spectators too) sees the change');
  // the same card again: no broadcast
  assert.deepEqual(card(b, { charId: OTHER }), { ok: true });
  assert.equal(states(a).length, before.a + 1);
  // merge: a field left out keeps its value, '' / 0 clears one, all cleared = no card
  card(a, { bg: 'bg_2' });
  assert.deepEqual(room.seatOf(a.playerId).card, { charId: AMIYA, bg: 'bg_2', trophies: 12 });
  const shown = states(b).length;
  card(a, { avatar: OTHER });
  assert.deepEqual(room.seatOf(a.playerId).card, { charId: AMIYA, avatar: OTHER, bg: 'bg_2', trophies: 12 });
  assert.deepEqual(states(b).at(-1).seats[0].card.avatar, OTHER, 'the avatar is shown to the room');
  assert.equal(states(b).length, shown + 1, 'an avatar change alone is a change');
  card(a, { charId: '', trophies: 0 });
  assert.deepEqual(room.seatOf(a.playerId).card, { avatar: OTHER, bg: 'bg_2' });
  card(a, { avatar: '' });
  assert.deepEqual(room.seatOf(a.playerId).card, { bg: 'bg_2' });
  card(a, { bg: '' });
  assert.equal(a.card, null);
  seats = states(b).at(-1).seats;
  assert.equal(Object.hasOwn(seats[0], 'card'), false);
  // a spectator's card stays on its session (no broadcast) until it takes a player seat
  const quietBefore = states(a).length;
  assert.deepEqual(card(watcher, { charId: AMIYA }), { ok: true });
  assert.equal(states(a).length, quietBefore);
  assert.deepEqual(lobby.removeBot(a, { seat: 2 }), { ok: true });
  assert.deepEqual(lobby.join(watcher, { code: room.code }), { ok: true });
  assert.deepEqual(room.seatOf(watcher.playerId).card, { charId: AMIYA });
});

test('only a real operator of the game data; nothing is stored on a refusal', (t) => {
  const { lobby, player, card } = fixture(t);
  const a = player();
  card(a, { charId: AMIYA });
  for (const charId of ['char_999_nobody', 'char_']) {
    const res = card(a, { charId, bg: 'bg_x' });
    assert.equal(res.error, ERR.BAD_MSG, charId);
    assert.deepEqual(a.card, { charId: AMIYA }, 'the stored card is kept');
    assert.equal(card(a, { avatar: charId, bg: 'bg_x' }).error, ERR.BAD_MSG, `avatar ${charId}`);
    assert.deepEqual(a.card, { charId: AMIYA }, 'the stored card is kept (avatar)');
  }
  const pool = DATA.backups?.diy?.ownedPool || [];
  if (pool.length) assert.deepEqual(card(a, { charId: pool[0] }), { ok: true }, 'a 自选 operator is a real operator');
  assert.deepEqual(lobby.setCard(a, { bg: 'bg_y' }).ok, true, 'handlers may be called without the wire fields');
});

test(`at most ${CARD_CHANGES} changes per ${CARD_WINDOW_MS / 1000} s per session (RATE), repeats are free`, (t) => {
  const { clock, lobby, player, states, card } = fixture(t);
  const a = player(), b = player();
  lobby.create(a, { mode: 'coop', difficulty: 'NORMAL' });
  lobby.join(b, { code: lobby.roomOf(a).code });
  const start = states(b).length;
  for (let i = 1; i <= CARD_CHANGES; i++) assert.deepEqual(card(a, { trophies: i }), { ok: true }, `change ${i}`);
  assert.equal(card(a, { trophies: 99 }).error, ERR.RATE);
  assert.equal(a.card.trophies, CARD_CHANGES, 'the refused change is not stored');
  assert.deepEqual(card(a, { trophies: CARD_CHANGES }), { ok: true }, 'an unchanged card is no change');
  assert.equal(states(b).length, start + CARD_CHANGES, 'one broadcast per accepted change');
  assert.deepEqual(card(b, { trophies: 1 }), { ok: true }, 'the budget is per session');
  clock.time += Math.ceil(CARD_WINDOW_MS / CARD_CHANGES);
  assert.deepEqual(card(a, { trophies: 99 }), { ok: true }, 'the budget refills');
  assert.equal(card(a, { trophies: 100 }).error, ERR.RATE);
});

// 2026-10-17 (card variants): `art` / `face` say which variant the card's `charId` / `avatar` is drawn as — Elite 1
// (`e1`), Elite 2 (`e2`, also the default for an empty string) or one of that operator's own skins (`skin:<id>`).
// Display-only, like the rest of the card; a made-up or foreign skin is dropped on its own, the rest of the card lands.
test('room.card art / face variants: Elite 1 / Elite 2 always, a skin only when it is that operator\'s own', (t) => {
  const ok = (msg) => assert.equal(validateC2S({ t: 'room.card', ...msg }), null, JSON.stringify(msg));
  const bad = (msg, field) => assert.equal(validateC2S({ t: 'room.card', ...msg }), `bad field ${field}`, JSON.stringify(msg));
  ok({});
  ok({ art: '', face: '' });
  ok({ art: 'e1', face: 'e2' });
  ok({ face: 'skin:char_290_vigna_summer_1' });
  for (const v of ['E1', 'elite', 'skin:', 'skin:has-dash', `skin:${'a'.repeat(CARD_LIMITS.idLength + 1)}`, null, 7]) bad({ art: v }, 'art');
  bad({ face: 'e3' }, 'face');

  const { lobby, player, states, card } = fixture(t);
  const a = player(), b = player();
  assert.deepEqual(card(a, { charId: AMIYA, art: 'e1', face: 'e2' }), { ok: true });
  assert.deepEqual(a.card, { charId: AMIYA, art: 'e1', face: 'e2' }, 'the variants sit on the card');
  assert.deepEqual(lobby.create(a, { mode: 'coop', difficulty: 'NORMAL' }), { ok: true });
  assert.deepEqual(lobby.join(b, { code: lobby.roomOf(a).code }), { ok: true });
  assert.deepEqual(states(b).at(-1).seats[0].card, { charId: AMIYA, art: 'e1', face: 'e2' }, 'and reach the room');

  // a variant-only change is a change: the room is told, the seat plate follows the card
  const before = states(b).length;
  assert.deepEqual(card(a, { art: 'e2' }), { ok: true });
  assert.equal(states(b).length, before + 1);
  assert.equal(states(b).at(-1).seats[0].card.art, 'e2');

  // a made-up skin is dropped on its own (that field falls back to Elite 2) while the rest of the card still lands
  assert.deepEqual(card(a, { art: 'skin:not_a_real_skin', trophies: 3 }), { ok: true });
  assert.deepEqual(a.card, { charId: AMIYA, face: 'e2', trophies: 3 });
  assert.equal(states(b).length, before + 2);
  // '' clears a variant back to the default too (the UI stores '' for Elite 2)
  assert.deepEqual(card(a, { face: '' }), { ok: true });
  assert.deepEqual(a.card, { charId: AMIYA, trophies: 3 });
  assert.equal(states(b).length, before + 3);
  // the same card again is no change
  assert.deepEqual(card(a, { charId: AMIYA, trophies: 3 }), { ok: true });
  assert.equal(states(b).length, before + 3);
});

test('the card never enters a match: local seats and the cluster DTO carry none, and an edit cannot abort a pending start', async (t) => {
  const local = fixture(t);
  const a = local.player(), b = local.player();
  local.card(a, { charId: AMIYA, avatar: OTHER, trophies: 3 });
  local.lobby.create(a, { mode: 'coop', difficulty: 'NORMAL' });
  local.lobby.join(b, { code: local.lobby.roomOf(a).code });
  local.lobby.ready(b, { ready: true });
  assert.deepEqual(local.lobby.start(a), { ok: true });
  const room = local.lobby.roomOf(a);
  assert.ok(room.match.opts.seats.every((s) => !Object.hasOwn(s, 'card')));
  assert.deepEqual(local.card(a, { trophies: 4 }), { ok: true }, 'a display edit is fine during a match');
  assert.deepEqual(room.seatOf(a.playerId).card, { charId: AMIYA, avatar: OTHER, trophies: 4 });

  const calls = [];
  const platform = {
    build: 'synthetic-build', protocol: 1,
    prepare(spec, context) { let resolve; const promise = new Promise((r) => { resolve = r; }); calls.push({ spec, context, resolve }); return promise; },
    resume() { return true; }, deliverEnd() { return true; }, release() { return Promise.resolve(true); },
  };
  class ClusterWithPlatform extends ClusterLobby { constructor(opts) { super({ ...opts, platform }); } }
  const cluster = fixture(t, { LobbyClass: ClusterWithPlatform });
  const c = cluster.player(), d = cluster.player();
  cluster.card(c, { charId: AMIYA });
  cluster.lobby.create(c, { mode: 'coop', difficulty: 'NORMAL' });
  cluster.lobby.join(d, { code: cluster.lobby.roomOf(c).code });
  cluster.lobby.ready(d, { ready: true });
  const pending = cluster.lobby.start(c);
  assert.equal(typeof pending.then, 'function');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].spec.seats.every((s) => !Object.hasOwn(s, 'card')), 'the node never sees a card');
  assert.equal(calls[0].context.isCurrent(), true);
  assert.deepEqual(cluster.card(d, { charId: OTHER, bg: 'bg_1' }), { ok: true });
  assert.equal(calls[0].context.isCurrent(), true, 'a display edit leaves the pending start valid');
  assert.deepEqual(cluster.lobby.ready(d, { ready: false }), { ok: true });
  assert.equal(calls[0].context.isCurrent(), false, 'a real seat change still invalidates it');
  calls[0].resolve(null);
  assert.ok((await pending).error);
});
