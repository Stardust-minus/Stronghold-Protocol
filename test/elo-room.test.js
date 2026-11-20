// Experimental ELO, step 2 (§37.275): `experimental.elo` is an optional strict flag of a private room — never at
// room.create, never matchmade or queued —, room.elo { rec } carries a player's own recent matches per mode and
// difficulty ([won, roundsPassed] newest first), stored on the session and the seat and never shown, and a match of such a
// room gets each human's list of the room's mode and difficulty (seats[].elo) — in process and on a game node — while
// every other room's match options are as before. No listeners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPERIMENTAL_DEFAULTS, EXPERIMENTAL_GROUPS, QUEUE_OPTION_KEYS, experimentalKey, experimentalOptions, isEloRoom, isExperimental,
  queueOptions, sameExperimental } from '../shared/experimental.js';
import { validateC2S } from '../shared/protocol.js';
import { ELO_LIMITS, eloEntriesOf, isEloRecords } from '../shared/elo.js';
import { autoPoolPlan } from '../shared/poolPlan.js';
import { Lobby } from '../server/lobby.js';
import { HEAVY_TYPES, SessionRegistry } from '../server/net.js';
import { copyAssignmentSpec } from '../server/cluster/game-host.js';

const ELO = Object.freeze({ ...EXPERIMENTAL_DEFAULTS, elo: true });
const ok = (r) => assert.deepEqual(r, { ok: true });

test('experimental.elo is an optional strict flag of the 特殊功能 group with its own key, never a ticket\'s', () => {
  const on = experimentalOptions(ELO);
  assert.equal(on.elo, true);
  assert.equal(isEloRoom(on), true);
  assert.equal(isEloRoom(experimentalOptions(EXPERIMENTAL_DEFAULTS)), false);
  assert.equal(Object.hasOwn(experimentalOptions({ ...EXPERIMENTAL_DEFAULTS, elo: false }), 'elo'), false, 'off is absent');
  assert.deepEqual(experimentalOptions(EXPERIMENTAL_DEFAULTS), { revivalEnabled: false, disableSharedPool: false }, 'a standard room keeps its shape');
  assert.equal(isExperimental({ ...EXPERIMENTAL_DEFAULTS, elo: 1 }), false);
  assert.equal(sameExperimental(on, experimentalOptions(EXPERIMENTAL_DEFAULTS)), false);
  assert.equal(sameExperimental(on, experimentalOptions(ELO)), true);
  assert.equal(experimentalKey(on), '00:elo');
  assert.equal(experimentalKey(experimentalOptions(EXPERIMENTAL_DEFAULTS)), '00');
  assert.equal(EXPERIMENTAL_GROUPS.find((g) => g.id === 'special').keys.includes('elo'), true);
  assert.equal(QUEUE_OPTION_KEYS.includes('elo'), false);
  assert.equal(queueOptions(ELO), null, 'a ticket never brings it');
  // every option at once still passes the shape check (15 keys)
  const all = { revivalEnabled: true, disableSharedPool: false, playerCapacity: 8, disableDuckLord: true, disableLayerCap: true, disableHitLimit: true,
    enemyHpMul: 2, enemyHpPlan: [[1, 1], [6, 2]], enemyAtkMul: 2, poolPlan: autoPoolPlan(8), collabOps: true, console: true, uniteHumansFirst: true,
    staticPoolSplit: true, elo: true };
  assert.equal(Object.keys(all).length, 15);
  assert.equal(isExperimental(all), true);
  assert.equal(experimentalOptions(all).elo, true);
});

test('room.elo: per mode:difficulty at most 30 matches [won, roundsPassed]; the list of a room', () => {
  assert.equal(ELO_LIMITS.last, 30);
  assert.equal(validateC2S({ t: 'room.elo', rec: {} }), null);
  const thirty = Array.from({ length: 30 }, (_, i) => [i % 2, 14]);
  assert.equal(validateC2S({ t: 'room.elo', rec: { 'solo:ABYSS': [[1, 14], [0, 3]], 'coop:HARD': thirty, 'coop:FUNNY': [] } }), null);
  for (const rec of [null, [], { 'solo:ABYSS': [[2, 14]] }, { 'solo:ABYSS': [[1, 31]] }, { 'solo:ABYSS': [[1, 1.5]] }, { 'solo:ABYSS': [[1, 3, 4]] },
    { 'solo:ABYSS': [...thirty, [1, 14]] }, { 'solo:TRAINING': [[1, 3]] }, { 'duo:ABYSS': [[1, 3]] }, { 'solo:ABYSS': [['1', 3]] }, { 'solo:ABYSS': [true, 3] }]) {
    assert.notEqual(validateC2S({ t: 'room.elo', rec }), null, JSON.stringify(rec));
    assert.equal(isEloRecords(rec), false);
  }
  assert.ok(HEAVY_TYPES.has('room.elo'));
  const rec = { 'solo:ABYSS': [[1, 14], [0, 3]], 'coop:HARD': thirty };
  assert.deepEqual(eloEntriesOf(rec, 'solo', 'ABYSS'), [[1, 14], [0, 3]]);
  assert.ok(Object.isFrozen(eloEntriesOf(rec, 'solo', 'ABYSS')) && Object.isFrozen(eloEntriesOf(rec, 'solo', 'ABYSS')[0]));
  assert.equal(eloEntriesOf(rec, 'coop', 'ABYSS'), null);
  assert.equal(eloEntriesOf(null, 'solo', 'ABYSS'), null);
});

function openLobby(t, extra = {}) {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, content: { cs: 'ab'.repeat(32) }, log: { info() {}, warn() {}, error() {}, debug() {} }, ...extra,
    options: { testMode: 'off' } });
  t.after(() => lobby.shutdown());
  const player = (name) => {
    const s = registry.create(name);
    s.connected = true;
    s.messages = [];
    s.ws = { readyState: 1, bufferedAmount: 0, send: (txt) => s.messages.push(JSON.parse(txt)) };
    return s;
  };
  return { lobby, player };
}

test('ELO is a private room setting: never at create, never in a matchmade room, never queued as a party', (t) => {
  const { lobby, player } = openLobby(t);
  const host = player('host');
  assert.equal(lobby.create(host, { mode: 'coop', difficulty: 'NORMAL', experimental: ELO }).error, 'BAD_MSG');
  ok(lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' }));
  const room = lobby.roomOf(host);
  ok(lobby.setExperimental(host, { experimental: ELO }));
  assert.equal(isEloRoom(room.experimental), true);
  assert.equal(lobby.matchmakingMembers(host, 'NORMAL', true).error, 'BAD_MSG');
  ok(lobby.setExperimental(host, { experimental: EXPERIMENTAL_DEFAULTS }));
  room.source = 'matchmaking';
  assert.equal(lobby.setExperimental(host, { experimental: ELO }).error, 'BAD_MSG');
  const solo = player('solo');
  ok(lobby.create(solo, { mode: 'solo', difficulty: 'ABYSS' }));
  ok(lobby.setExperimental(solo, { experimental: ELO }));
});

test('room.elo is kept on the session and the seat, never in room.state; a match of an ELO room gets each human\'s list', (t) => {
  const seen = [];
  class Rec { constructor(opts) { seen.push(opts); } start() {} dispose() {} handle() { return { ok: true }; } }
  const { lobby, player } = openLobby(t, { MatchClass: Rec });
  const host = player('host');
  const mine = [[1, 14], [1, 14], [0, 9], [1, 14], [0, 4]];
  const rec = { 'coop:NORMAL': mine, 'solo:ABYSS': [[0, 2]] };
  ok(lobby.onMessage(host, { t: 'room.elo', rec }));
  assert.deepEqual(host.elo, rec);
  ok(lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' }));
  const room = lobby.roomOf(host);
  assert.deepEqual(room.seatOf(host.playerId).elo, rec, 'the seat takes the session\'s');
  const friend = player('friend');
  ok(lobby.join(friend, { code: room.code }));
  ok(lobby.addBot(host));
  const stored = host.elo;
  ok(lobby.onMessage(host, { t: 'room.elo', rec: { ...rec } }));
  assert.equal(host.elo, stored, 'the same counts keep the stored object');
  const state = JSON.stringify(room.toState());
  assert.ok(!state.includes('"elo"') || !/"elo":\[|"elo":\{/.test(state), 'room.state carries no counts');
  assert.ok(!state.includes('[1,14]'));
  // off: no seat of the match carries a pair
  ok(lobby.startMatch(room));
  assert.ok(seen.at(-1).seats.every((s) => !Object.hasOwn(s, 'elo')), 'off: no seat carries matches');
  room.match = null;
  ok(lobby.setExperimental(host, { experimental: ELO }));
  ok(lobby.startMatch(room));
  const seats = seen.at(-1).seats;
  assert.deepEqual(seats.find((s) => s.playerId === host.playerId).elo, mine, 'the room\'s mode and difficulty only');
  assert.equal(seats.find((s) => s.playerId === friend.playerId).elo, null, 'a human without counts: null');
  assert.ok(seats.filter((s) => s.isBot).every((s) => !Object.hasOwn(s, 'elo')), 'an AI seat never has one');
  // during the match a new one is kept for the next match
  assert.equal(lobby.onMessage(host, { t: 'room.elo', rec: { 'coop:NORMAL': [[1, 14], ...mine] } }).error, 'ROOM_STARTED');
  assert.deepEqual(room.seatOf(host.playerId).elo, { 'coop:NORMAL': [[1, 14], ...mine] });
});

test('a game node takes a human seat\'s matches only in an ELO room, never an AI seat\'s', () => {
  const seat = (n, id, extra = {}) => ({ seat: n, playerId: id, name: id, isBot: id.startsWith('ai_'), connected: true, ...extra });
  const spec = (experimental, seats) => copyAssignmentSpec({ assignmentId: 'elo-a', roomCode: 'ABCD', build: 'b', protocol: 1, seed: 7, matchNo: 1,
    mode: 'coop', difficulty: 'NORMAL', modeId: 'mode_multi_normal', seats, spectators: [], experimental });
  const s = spec(ELO, [seat(0, 'p1', { elo: [[1, 14], [0, 3]] }), seat(1, 'p2', { elo: null }), seat(2, 'ai_1')]);
  assert.equal(s.experimental.elo, true);
  assert.deepEqual(s.seats[0].elo, [[1, 14], [0, 3]]);
  assert.equal(s.seats[1].elo, null);
  assert.equal(Object.hasOwn(s.seats[2], 'elo'), false);
  assert.throws(() => spec(ELO, [seat(0, 'p1'), seat(1, 'ai_1', { elo: [[1, 14]] })]), 'an AI seat');
  assert.throws(() => spec(EXPERIMENTAL_DEFAULTS, [seat(0, 'p1', { elo: [[1, 14]] })]), 'without the option');
  assert.throws(() => spec(ELO, [seat(0, 'p1', { elo: [[2, 14]] })]), 'a bad entry');
  assert.throws(() => spec(ELO, [seat(0, 'p1', { elo: Array.from({ length: 31 }, () => [1, 14]) })]), 'too many');
});
