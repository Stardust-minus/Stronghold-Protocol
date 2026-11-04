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
import { OPERATOR_SKINS as SKINS } from '../shared/skins.js';
import { CARD_ROSTER } from '../shared/card-roster.js';

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

test('feedback #62 / #99: the whole roster is real, whatever data the room plays — 协防干员 and the other versions\' operators', (t) => {
  const { player, card } = fixture(t);
  const a = player();
  for (const id of ['char_1035_wisdel', 'char_109_fmout', 'char_4045_heidi']) {
    assert.ok(CARD_ROSTER.some((r) => r.charId === id), id);
    assert.deepEqual(card(a, { charId: id }), { ok: true }, id);
    assert.deepEqual(card(a, { avatar: id }), { ok: true }, `avatar ${id}`);
  }
  assert.deepEqual(a.card, { charId: 'char_4045_heidi', avatar: 'char_4045_heidi' });
});

test('feedback #78: a card sent outside any room reaches the seat of the next room, and a stale seat is corrected', (t) => {
  const { lobby, player, card, states } = fixture(t);
  const a = player(), b = player();
  assert.deepEqual(card(a, { charId: AMIYA }), { ok: true }, 'no room needed');
  const code = lobby.onMessage(b, { t: 'room.create', mode: 'coop' }).code ?? b.messages.filter((m) => m.t === 'room.state').at(-1).code;
  assert.ok(lobby.onMessage(a, { t: 'room.join', code }).ok !== false);
  assert.deepEqual(states(b).at(-1).seats.find((s) => s?.playerId === a.playerId).card, { charId: AMIYA });
  const room = lobby.roomOf(a);
  room.seatOf(a.playerId).card = null; // a seat restored without its card
  const before = states(b).length;
  assert.deepEqual(card(a, { charId: AMIYA }), { ok: true }, 'the same card again');
  assert.equal(states(b).length, before + 1, 'the room hears the correction');
  assert.deepEqual(states(b).at(-1).seats.find((s) => s?.playerId === a.playerId).card, { charId: AMIYA });
});

test('bgY (feedback #61): the background\'s position travels with it, -1 clears it, no background keeps none', (t) => {
  const { player, card } = fixture(t);
  const a = player();
  assert.equal(validateC2S({ t: 'room.card', bgY: 101 }) != null, true);
  assert.equal(validateC2S({ t: 'room.card', bgY: 0.5 }) != null, true);
  assert.equal(validateC2S({ t: 'room.card', bgY: -1 }), null);
  card(a, { bg: 'loading:core', bgY: 30 });
  assert.deepEqual(a.card, { bg: 'loading:core', bgY: 30 });
  card(a, { bgY: 0 });
  assert.deepEqual(a.card, { bg: 'loading:core', bgY: 0 }, 'the top of the picture is a position, not a cleared one');
  card(a, { trophies: 5 });
  assert.equal(a.card.bgY, 0, 'a field left out keeps its value');
  card(a, { bgY: -1 });
  assert.equal(Object.hasOwn(a.card, 'bgY'), false);
  card(a, { bg: '', bgY: 40 });
  assert.equal(a.card.bgY, undefined, 'no background, no position');
});

test('bgX / bgZoom (feedback #129): the background\'s horizontal position and zoom travel with it like bgY; -1 clears; the room sees them', (t) => {
  const ok = (msg) => assert.equal(validateC2S({ t: 'room.card', ...msg }), null, JSON.stringify(msg));
  const bad = (msg, field) => assert.equal(validateC2S({ t: 'room.card', ...msg }), `bad field ${field}`, JSON.stringify(msg));
  ok({ bgX: 0 }); ok({ bgX: 100 }); ok({ bgX: -1 }); ok({ bgZoom: 100 }); ok({ bgZoom: CARD_LIMITS.bgZoomMax }); ok({ bgZoom: -1 });
  bad({ bgX: 101 }, 'bgX'); bad({ bgX: 2.5 }, 'bgX'); bad({ bgX: -2 }, 'bgX');
  bad({ bgZoom: 99 }, 'bgZoom'); bad({ bgZoom: 0 }, 'bgZoom'); bad({ bgZoom: CARD_LIMITS.bgZoomMax + 1 }, 'bgZoom'); bad({ bgZoom: 150.5 }, 'bgZoom');
  const f = fixture(t);
  const a = f.player(), b = f.player();
  const code = f.lobby.onMessage(a, { t: 'room.create', mode: 'coop' }).code ?? f.states(a).at(-1).code;
  assert.ok(f.lobby.onMessage(b, { t: 'room.join', code }).ok !== false);
  // a skin card and the plain ones alike (every look of the 名片干员 — 精二 '', 精一 'e1', a skin — keeps it)
  for (const look of ['', 'e1']) {
    f.clock.time += CARD_WINDOW_MS;
    assert.deepEqual(f.card(a, { charId: AMIYA, look, bg: 'skin:char_103_angel_wild_1', bgX: 80, bgY: 30, bgZoom: 250 }), { ok: true });
    assert.deepEqual({ ...a.card }, { charId: AMIYA, ...(look ? { look } : {}), bg: 'skin:char_103_angel_wild_1', bgX: 80, bgY: 30, bgZoom: 250 }, `look '${look}'`);
  }
  assert.deepEqual(f.states(b).at(-1).seats.find((s) => s?.playerId === a.playerId).card.bgZoom, 250, 'the room sees the framing');
  const heard = f.states(b).length;
  f.clock.time += CARD_WINDOW_MS;
  f.card(a, { bgX: 0 });
  assert.equal(a.card.bgX, 0, '0 is a position, not a cleared one');
  assert.equal(f.states(b).length, heard + 1, 'a change of bgX alone is a change of the card');
  f.card(a, { bgZoom: 300 });
  assert.equal(f.states(b).length, heard + 2, 'and of bgZoom alone');
  f.card(a, { trophies: 2 });
  assert.deepEqual([a.card.bgX, a.card.bgY, a.card.bgZoom], [0, 30, 300], 'left out: kept');
  f.clock.time += CARD_WINDOW_MS;
  f.card(a, { bgX: -1, bgZoom: -1 });
  assert.equal(Object.hasOwn(a.card, 'bgX') || Object.hasOwn(a.card, 'bgZoom'), false, '-1 clears');
  assert.equal(a.card.bgY, 30, 'bgY stays');
  f.card(a, { bgX: 20, bgZoom: 200 });
  f.card(a, { bg: '' });
  assert.deepEqual([a.card.bg, a.card.bgX, a.card.bgY, a.card.bgZoom], [undefined, undefined, undefined, undefined], 'no background, no framing');
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

test('look / avatarLook (feedback #9 / #24): 精一 or a skin of that very operator; an operator change drops an orphaned look', (t) => {
  const ok = (msg) => assert.equal(validateC2S({ t: 'room.card', ...msg }), null, JSON.stringify(msg));
  const bad = (msg, field) => assert.equal(validateC2S({ t: 'room.card', ...msg }), `bad field ${field}`, JSON.stringify(msg));
  ok({ look: '' }); ok({ look: 'e1' }); ok({ avatarLook: 'char_103_angel_wild_1' }); ok({ bg: 'skin:char_103_angel_wild_1' });
  bad({ look: 'e2' }, 'look'); bad({ avatarLook: '/assets/x.png' }, 'avatarLook'); bad({ look: 1 }, 'look');
  const withSkin = SKINS.find((s) => OPS.includes(s.charId));
  assert.ok(withSkin, 'an operator of the data with a skin');
  const other = OPS.find((id) => id !== withSkin.charId);
  const f = fixture(t);
  const s = f.player();
  assert.deepEqual(f.card(s, { charId: withSkin.charId, look: withSkin.id, avatar: withSkin.charId, avatarLook: 'e1' }), { ok: true });
  assert.deepEqual({ ...s.card }, { charId: withSkin.charId, look: withSkin.id, avatar: withSkin.charId, avatarLook: 'e1' });
  assert.equal(f.card(s, { charId: other, look: withSkin.id }).error, ERR.BAD_MSG, 'another operator\'s skin');
  assert.equal(f.card(s, { avatarLook: 'char_unknown_skin_1' }).error, ERR.BAD_MSG);
  assert.deepEqual({ ...s.card }, { charId: withSkin.charId, look: withSkin.id, avatar: withSkin.charId, avatarLook: 'e1' }, 'nothing stored on a refusal');
  // a new portrait operator: the skin look no longer fits and is dropped; 'e1' fits every operator and stays
  assert.deepEqual(f.card(s, { charId: other, avatar: other }), { ok: true });
  assert.deepEqual({ ...s.card }, { charId: other, avatar: other, avatarLook: 'e1' });
  // a look without its operator is not kept; '' clears
  assert.deepEqual(f.card(s, { avatar: '', avatarLook: 'e1' }), { ok: true });
  assert.deepEqual({ ...s.card }, { charId: other });
});

test('artX / artY / artZoom (rel27): the seat card\'s framing of the look\'s 动态立绘 — all three, only with that look, dropped on a new look', (t) => {
  const ok = (msg) => assert.equal(validateC2S({ t: 'room.card', ...msg }), null, JSON.stringify(msg));
  const bad = (msg, field) => assert.equal(validateC2S({ t: 'room.card', ...msg }), `bad field ${field}`, JSON.stringify(msg));
  ok({ artX: 0, artY: 1000, artZoom: 100 }); ok({ artX: -1, artY: -1, artZoom: -1 }); ok({ artZoom: 2500 });
  bad({ artX: 1001 }, 'artX'); bad({ artY: -2 }, 'artY'); bad({ artZoom: 99 }, 'artZoom'); bad({ artZoom: 2501 }, 'artZoom'); bad({ artX: 0.5 }, 'artX');
  // a rel26 server's schema (no art fields) passes the message and reads named fields only
  assert.equal(validateC2S({ t: 'room.card', charId: AMIYA, extraField: 1 }), null, 'unknown keys are ignored, never refused');
  const withSkin = SKINS.find((s) => OPS.includes(s.charId) && SKINS.filter((x) => x.charId === s.charId).length > 1);
  assert.ok(withSkin, 'an operator of the data with two skins');
  const second = SKINS.find((s) => s.charId === withSkin.charId && s.id !== withSkin.id);
  const f = fixture(t);
  const a = f.player(), b = f.player();
  const code = f.lobby.onMessage(a, { t: 'room.create', mode: 'coop' }).code ?? f.states(a).at(-1).code;
  assert.ok(f.lobby.onMessage(b, { t: 'room.join', code }).ok !== false);
  const art = { artX: 420, artY: 310, artZoom: 260 };
  assert.deepEqual(f.card(a, { charId: withSkin.charId, look: withSkin.id, ...art }), { ok: true });
  assert.deepEqual({ ...a.card }, { charId: withSkin.charId, look: withSkin.id, ...art });
  assert.deepEqual(f.states(b).at(-1).seats.find((s) => s?.playerId === a.playerId).card, { charId: withSkin.charId, look: withSkin.id, ...art }, 'the room sees the framing');
  f.clock.time += CARD_WINDOW_MS;
  f.card(a, { trophies: 3 });
  assert.equal(a.card.artZoom, 260, 'left out: kept');
  f.card(a, { artX: 100, artY: 5 });
  assert.equal(a.card.artX, undefined, 'a partial framing is none');
  f.card(a, art);
  assert.equal(a.card.artX, 420);
  f.clock.time += CARD_WINDOW_MS;
  f.card(a, { look: second.id });
  assert.equal(a.card.artX, undefined, 'a new look starts at its portrait crop');
  f.card(a, { look: second.id, ...art });
  f.card(a, { artX: -1, artY: -1, artZoom: -1 });
  assert.equal(a.card.artZoom, undefined, '-1 clears');
  // rel30 (the owner, 2026-11-04): every look of a picked operator keeps one — 精二 and 精一 frame the static portrait
  f.clock.time += CARD_WINDOW_MS;
  f.card(a, { look: 'e1', ...art });
  assert.deepEqual([a.card.look, a.card.artX, a.card.artY, a.card.artZoom], ['e1', 420, 310, 260], '精一: its static portrait framed');
  f.card(a, { look: '', ...art });
  assert.deepEqual([a.card.look, a.card.artX, a.card.artZoom], [undefined, 420, 260], '精二 (no look): framed too');
  f.card(a, { trophies: 4 });
  assert.equal(a.card.artX, 420, 'left out: kept');
  f.clock.time += CARD_WINDOW_MS;
  f.card(a, { look: 'e1' });
  assert.equal(a.card.artX, undefined, '精二 → 精一: a new look starts at its default');
  f.card(a, { look: 'e1', ...art });
  const another = OPS.find((id) => id !== withSkin.charId);
  f.card(a, { charId: another });
  assert.deepEqual([a.card.charId, a.card.look, a.card.artX], [another, 'e1', undefined], 'another operator in the same look starts at its default');
  f.clock.time += CARD_WINDOW_MS;
  f.card(a, { charId: '', ...art });
  assert.equal(a.card.artX, undefined, 'no 名片干员 picked: no framing');
  assert.deepEqual(f.states(b).at(-1).seats.find((s) => s?.playerId === a.playerId).card?.artX, undefined, 'and the room sees none');
});
