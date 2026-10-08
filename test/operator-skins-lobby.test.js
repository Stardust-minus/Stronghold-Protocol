import test from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry, HEAVY_TYPES } from '../server/net.js';
import { validateC2S } from '../shared/protocol.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';
import { OPERATOR_SKINS } from '../shared/skins.js';
import { DATA, makeMatch } from './match/harness.js';

const CHAR = 'char_103_angel', FIRST = OPERATOR_SKINS[0].id, SECOND = OPERATOR_SKINS[1].id;
const choices = (id = FIRST) => ({ [CHAR]: id });
const quiet = { info() {}, warn() {}, error() {} };

// In-process lobby only: no HTTP/WS listeners or browser services.
function fixture(t, MatchClass) {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, MatchClass, getData: () => DATA, log: quiet });
  t.after(() => lobby.shutdown());
  let count = 0;
  const player = () => {
    const s = registry.create(`Skin${++count}`);
    s.messages = []; s.connected = true; s.matchmakingVersion = MATCHMAKING_VERSION;
    s.ws = { readyState: 1, bufferedAmount: 0, send(raw, cb) { s.messages.push(JSON.parse(raw)); cb?.(); } };
    lobby.onHello(s, { resumed: false, repeat: false });
    return s;
  };
  return { lobby, registry, player };
}
class StubMatch {
  constructor(opts) { this.opts = opts; }
  start() {}
  dispose() {}
}

test('room.skins strictly admits only actual-char manifest choices and uses the heavy bucket', () => {
  assert.equal(validateC2S({ t: 'room.skins', choices: {} }), null);
  for (const skin of OPERATOR_SKINS) {
    assert.equal(validateC2S({ t: 'room.skins', choices: { [skin.charId]: skin.id } }), null);
    const wrongChar = skin.charId === CHAR ? 'char_112_siege' : CHAR;
    assert.match(validateC2S({ t: 'room.skins', choices: { [wrongChar]: skin.id } }), /bad field choices/);
  }
  for (const bad of [null, [], 'x', { [CHAR]: null }, { [CHAR]: '../assets/skin' },
    { char_112_siege: FIRST }, { [CHAR]: { id: FIRST } }, JSON.parse('{"__proto__":"x"}'), { [CHAR]: FIRST, unknown: FIRST }]) {
    assert.match(validateC2S({ t: 'room.skins', choices: bad }), /bad field choices/);
  }
  assert.match(validateC2S({ t: 'room.skins' }), /bad field choices/);
  assert.equal(validateC2S({ t: 'room.skins', choices: {}, loadout: {} }), null, 'outer unknown fields retain the existing ignored/not-copied protocol contract');
  assert.ok(HEAVY_TYPES.has('room.skins'));
});

test('session defaults, room creation/join/resume, immutable copies and next-match fallback preserve privacy', t => {
  const { lobby, registry, player } = fixture(t, StubMatch), a = player(), b = player(), spectator = player();
  assert.deepEqual(a.skins, {}); assert.ok(Object.isFrozen(a.skins));
  const input = choices();
  assert.deepEqual(lobby.onMessage(a, { t: 'room.skins', choices: input }), { ok: true });
  input[CHAR] = SECOND;
  assert.deepEqual(a.skins, choices()); assert.ok(Object.isFrozen(a.skins));
  assert.equal(lobby.skins(a, { choices: { [CHAR]: 'bad' } }).error, ERR.BAD_MSG);
  assert.deepEqual(a.skins, choices(), 'invalid input does not replace the saved map');
  lobby.create(a, { mode: 'coop', difficulty: 'NORMAL' });
  const room = lobby.roomOf(a);
  lobby.skins(b, { choices: choices(SECOND) }); lobby.join(b, { code: room.code });
  assert.deepEqual(room.seatOf(a.playerId).skins, choices());
  assert.notEqual(room.seatOf(a.playerId).skins, a.skins, 'new seat copies the session map');
  assert.ok(Object.isFrozen(room.seatOf(a.playerId).skins));
  assert.deepEqual(room.seatOf(b.playerId).skins, choices(SECOND));
  assert.ok(room.toState().seats.every(s => !s || !Object.hasOwn(s, 'skins')), 'room.state stays public');
  const saved = room.seatOf(a.playerId).skins;
  a.connected = false; lobby.onDisconnect(a); a.connected = true;
  assert.equal(registry.byToken(a.token), a);
  lobby.onHello(a, { resumed: true, repeat: false });
  assert.equal(room.seatOf(a.playerId).skins, saved, 'resume keeps the existing seat preference');
  lobby.spectate(spectator, { code: room.code });
  const frames = a.messages.length + b.messages.length;
  assert.deepEqual(lobby.skins(spectator, { choices: choices() }), { ok: true });
  assert.equal(a.messages.length + b.messages.length, frames, 'preference edits do not broadcast room frames');
  lobby.ready(b, { ready: true }); assert.deepEqual(lobby.start(a), { ok: true });
  assert.deepEqual(room.match.opts.seats.map(s => s.skins), [choices(), choices(SECOND)]);
  assert.ok(room.match.opts.seats.every(s => Object.isFrozen(s.skins)));
  assert.equal(lobby.skins(a, { choices: {} }).error, ERR.ROOM_STARTED, 'legacy/missing match hook stores for next match');
  assert.deepEqual(a.skins, {}); assert.deepEqual(room.seatOf(a.playerId).skins, {});
  assert.deepEqual(room.match.opts.seats[0].skins, choices(), 'the running actor retains its starting copy');
  assert.deepEqual(lobby.skins(spectator, { choices: {} }), { ok: true }, 'spectators never invoke the actor hook');
});

test('INFO_CHECK edits update only own match private map; later edits are stored for the next match', t => {
  const { lobby, player } = fixture(t, StubMatch), a = player(), b = player();
  lobby.create(a, { mode: 'coop', difficulty: 'NORMAL' }); const room = lobby.roomOf(a);
  lobby.join(b, { code: room.code });
  // Use the real virtual-scheduler Match without starting any server.
  const h = makeMatch({ seats: [a, b].map((s, seat) => ({ seat, playerId: s.playerId, name: s.name, isBot: false, connected: true })), spectators: ['watcher'] }).start();
  t.after(() => h.m.dispose());
  room.match = h.m;
  assert.deepEqual(lobby.skins(a, { choices: choices() }), { ok: true });
  assert.deepEqual(h.ps(a.playerId).skins, choices()); assert.deepEqual(h.ps(b.playerId).skins, {});
  assert.deepEqual(h.lastTo(a.playerId, 'm.private').skins, choices());
  assert.equal(h.sent.some(([id, msg]) => id === 'watcher' && msg.t === 'm.private'), false);
  assert.equal(JSON.stringify(h.m.publicView()).includes('skins'), false);
  h.toPrep(1);
  const result = lobby.skins(a, { choices: choices(SECOND) });
  assert.equal(result.error, ERR.WRONG_PHASE); assert.match(result.detail, /next match/);
  assert.deepEqual(a.skins, choices(SECOND)); assert.deepEqual(room.seatOf(a.playerId).skins, choices(SECOND));
  assert.deepEqual(h.ps(a.playerId).skins, choices());
  assert.equal(h.m.setSkins(b.playerId, {}).error, ERR.WRONG_PHASE);
  assert.equal(h.m.setSkins('watcher', {}).error, ERR.NOT_IN_ROOM);
});

test('public 2+1+1 allocation takes each current preference and keeps observers out of seats', t => {
  const { lobby, player } = fixture(t, StubMatch), ps = Array.from({ length: 4 }, player), observer = player();
  for (let i = 0; i < ps.length; i++) lobby.skins(ps[i], { choices: i % 2 ? {} : choices(i ? SECOND : FIRST) });
  lobby.create(ps[0], { mode: 'coop', difficulty: 'NORMAL' }); const old = lobby.roomOf(ps[0]);
  lobby.join(ps[1], { code: old.code }); lobby.spectate(observer, { code: old.code });
  assert.deepEqual(lobby.ready(ps[1], { ready: true }), { ok: true });
  lobby.skins(observer, { choices: choices(SECOND) });
  for (const s of [ps[0], ps[2], ps[3]]) assert.deepEqual(lobby.queue.join(s, { difficulty: 'NORMAL', party: s === ps[0] }), { ok: true });
  const states = ps.map(s => lobby.queue.state(s));
  for (let i = 0; i < ps.length; i++) assert.deepEqual(lobby.queue.accept(ps[i], states[i]), { ok: true });
  const room = lobby.roomOf(ps[0]);
  assert.notEqual(room, old); assert.equal(room.source, 'matchmaking');
  assert.deepEqual(room.match.opts.seats.map(s => s.skins), ps.map(s => s.skins));
  assert.equal(room.match.opts.seats.length, 4); assert.deepEqual(room.match.opts.spectators, [observer.playerId]);
  assert.ok(room.seats.every(s => Object.isFrozen(s.skins)));
});

test('skin hook failures remain isolated after storing the new preference', t => {
  const { lobby, player } = fixture(t, StubMatch), a = player();
  lobby.create(a, { mode: 'solo', difficulty: 'NORMAL' }); const room = lobby.roomOf(a);
  room.match = { setSkins() { throw new Error('synthetic'); }, dispose() {} };
  assert.equal(lobby.skins(a, { choices: choices() }).error, ERR.INTERNAL);
  assert.deepEqual(a.skins, choices());
});
