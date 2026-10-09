import test from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';
import { PLAYER_CAPACITIES, PLAYER_CAPACITY_VERSION } from '../shared/playerCapacity.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

const options = capacity => ({ revivalEnabled: false, disableSharedPool: false, ...(capacity === undefined ? {} : { playerCapacity: capacity }) });
class RecordingMatch {
  constructor(opts) { this.opts = opts; }
  start() {}
  dispose() {}
  onLeave() {}
  onDisconnect() {}
  onReconnect() {}
}
function fixture(t) {
  const registry = new SessionRegistry(), lobby = new Lobby({ registry, MatchClass: RecordingMatch, getData: () => ({}), seedFn: () => 17 });
  t.after(() => lobby.shutdown());
  let count = 0;
  const player = (compatible = true) => {
    const s = registry.create(`Capacity${++count}`); s.connected = true; s.messages = [];
    s.matchmakingVersion = MATCHMAKING_VERSION; s.playerCapacityVersion = compatible ? PLAYER_CAPACITY_VERSION : null;
    s.ws = { readyState: 1, bufferedAmount: 0, send(raw, cb) { s.messages.push(JSON.parse(raw)); cb?.(); } };
    return s;
  };
  const room = (capacity, size = 1) => {
    const members = Array.from({ length: size }, () => player());
    assert.deepEqual(lobby.create(members[0], { mode: 'coop', difficulty: 'NORMAL', experimental: options(capacity) }), { ok: true });
    const room = lobby.roomOf(members[0]);
    for (const member of members.slice(1)) assert.deepEqual(lobby.join(member, { code: room.code }), { ok: true });
    return { room, members, host: members[0] };
  };
  return { lobby, registry, player, room };
}

for (const capacity of PLAYER_CAPACITIES) test(`friend capacity ${capacity} is finite for humans and AI; next admission has no effect`, t => {
  const f = fixture(t), { room, host, members } = f.room(capacity, capacity);
  assert.equal(room.seats.length, capacity); assert.equal(room.capacity, capacity);
  assert.equal(f.lobby.join(f.player(), { code: room.code }).error, ERR.ROOM_FULL);
  assert.equal(f.lobby.addBot(host).error, ERR.ROOM_FULL);
  assert.equal(room.activeHumans().length, capacity);
  for (const member of members.slice(1)) f.lobby.ready(member, { ready: true });
  assert.deepEqual(f.lobby.start(host), { ok: true });
  assert.deepEqual(room.match.opts.seats.map(s => s.seat), Array.from({ length: capacity }, (_, i) => i));
  assert.equal(f.lobby.setExperimental(host, { experimental: options(4) }).error, ERR.ROOM_STARTED);
});

test('expansion preserves seat identities; shrink with any high human/AI rejects with zero mutation', t => {
  const f = fixture(t), { room, host, members } = f.room(4, 2);
  const seats = room.seats.slice(); f.lobby.ready(members[1], { ready: true });
  assert.equal(f.lobby.setExperimental(members[1], { experimental: options(20) }).error, ERR.NOT_HOST);
  assert.deepEqual(f.lobby.setExperimental(host, { experimental: options(20) }), { ok: true });
  assert.equal(room.seats.length, 20); assert.equal(room.seats[0], seats[0]); assert.equal(room.seats[1], seats[1]);
  assert.equal(room.seats[1].ready, false); assert.ok(room.seats.slice(2).every(s => s === null));
  while (room.freeSeat() >= 0) assert.deepEqual(f.lobby.addBot(host), { ok: true });
  assert.equal(f.lobby.addBot(host).error, ERR.ROOM_FULL);
  room.replay = { publicFrame: null, frames: new Map(), pending: new Set([host.playerId]) };
  const replay = room.replay, previous = room.experimental, array = room.seats, snapshot = structuredClone(room.toState()), messages = host.messages.length;
  assert.equal(f.lobby.setExperimental(host, { experimental: options(4) }).error, ERR.ROOM_FULL);
  assert.equal(room.replay, replay); assert.equal(room.experimental, previous); assert.equal(room.seats, array);
  assert.deepEqual(room.toState(), snapshot); assert.equal(host.messages.length, messages);
  assert.equal(f.lobby.removeBot(host, { seat: 20 }).error, ERR.BAD_TARGET);
  assert.equal(f.lobby.removeBot(host, { seat: 19.5 }).error, ERR.BAD_TARGET);
  for (let seat = 4; seat < 20; seat++) assert.deepEqual(f.lobby.removeBot(host, { seat }), { ok: true });
  assert.deepEqual(f.lobby.setExperimental(host, { experimental: options(4) }), { ok: true });
  assert.equal(room.seats.length, 4); assert.equal(room.seats[0], seats[0]); assert.equal(room.seats[1], seats[1]);
});

test('high human disconnect/reconnect/kick preserves index; shrink rejects disconnected high humans', t => {
  const f = fixture(t), { room, host, members } = f.room(20, 20), high = members[19], seat = room.seats[19];
  high.connected = false; high.ws.readyState = 3; f.lobby.onDisconnect(high);
  const grace = f.lobby.graceTimers.get(high.playerId);
  assert.ok(grace); assert.equal(seat.connected, false);
  assert.equal(f.lobby.setExperimental(host, { experimental: options(16) }).error, ERR.ROOM_FULL);
  assert.equal(f.lobby.graceTimers.get(high.playerId), grace); assert.equal(room.seats[19], seat);
  assert.equal(f.lobby.helloAdmission(high, {}).error, ERR.BAD_MSG);
  assert.deepEqual(f.lobby.helloAdmission(high, { playerCapacityVersion: PLAYER_CAPACITY_VERSION }), { ok: true });
  high.connected = true; high.ws.readyState = 1; f.lobby.onHello(high, { resumed: true, repeat: false });
  assert.equal(room.seats[19], seat); assert.equal(seat.connected, true); assert.equal(f.lobby.graceTimers.has(high.playerId), false);
  assert.equal(f.lobby.kick(host, { seat: 20, playerId: high.playerId }).error, ERR.BAD_TARGET);
  assert.deepEqual(f.lobby.kick(host, { seat: 19, playerId: high.playerId }), { ok: true });
  assert.equal(high.roomCode, null); assert.equal(room.seats[19], null); assert.equal(room.seats[18].seat, 18);
  assert.equal(high.messages.at(-1).reason, 'kicked');
  const replacement = f.player(); assert.deepEqual(f.lobby.join(replacement, { code: room.code }), { ok: true });
  assert.equal(room.seatOf(replacement.playerId).seat, 19);
});

test('legacy clients keep ordinary/solo room shapes but cannot create, enter, observe, expand or resume large rooms', t => {
  const f = fixture(t), legacy = f.player(false);
  assert.equal(f.lobby.create(legacy, { mode: 'coop', difficulty: 'NORMAL', experimental: options(8) }).error, ERR.BAD_MSG);
  assert.equal(legacy.roomCode, null);
  const normal = f.room(4);
  assert.deepEqual(f.lobby.join(legacy, { code: normal.room.code }), { ok: true });
  assert.equal(f.lobby.setExperimental(normal.host, { experimental: options(8) }).error, ERR.BAD_MSG);
  assert.equal(normal.room.seats.length, 4);
  f.lobby.leave(legacy);
  assert.deepEqual(f.lobby.spectate(legacy, { code: normal.room.code }), { ok: true });
  assert.equal(f.lobby.setExperimental(normal.host, { experimental: options(8) }).error, ERR.BAD_MSG);
  assert.equal(normal.room.seats.length, 4);
  f.lobby.leave(legacy);
  const expanded = f.room(8);
  assert.equal(f.lobby.join(legacy, { code: expanded.room.code }).error, ERR.BAD_MSG);
  assert.equal(f.lobby.spectate(legacy, { code: expanded.room.code }).error, ERR.BAD_MSG);
  expanded.host.playerCapacityVersion = null;
  assert.equal(f.lobby.start(expanded.host).error, ERR.BAD_MSG);
  assert.equal(f.lobby.helloAdmission(expanded.host, {}).error, ERR.BAD_MSG);
  assert.deepEqual(f.lobby.create(legacy, { mode: 'solo', difficulty: 'NORMAL', experimental: options(20) }), { ok: true });
  const solo = f.lobby.roomOf(legacy); assert.equal(solo.seats.length, 4); assert.equal(solo.capacity, 1);
  assert.equal(f.lobby.join(f.player(), { code: solo.code }).error, ERR.ROOM_FULL);
  assert.equal(f.lobby.addBot(legacy).error, ERR.ROOM_FULL);
});

for (const size of [1, 2, 3, 4]) test(`expanded ${size}-human party enters only its eight-player queue without changing the room`, t => {
  const f = fixture(t), { room, host, members } = f.room(8, size);
  for (const p of members.slice(1)) f.lobby.ready(p, { ready: true });
  const before = room.toState();
  assert.deepEqual(f.lobby.queue.join(host, { difficulty: 'NORMAL', party: true }), { ok: true });
  assert.equal(f.lobby.queue.size, size); assert.equal(f.lobby.queue.offers.size, 0); assert.deepEqual(room.toState(), before);
  for (const member of members) assert.equal(f.lobby.queue.state(member).required, 8);
});

test('party matchmaking requires ready nonhosts without tickets/side effects; host action is implicit ready', t => {
  const f = fixture(t), { room, host, members } = f.room(4, 2), before = room.toState();
  assert.equal(f.lobby.queue.join(host, { difficulty: 'NORMAL', party: true }).error, ERR.NOT_READY);
  assert.equal(f.lobby.queue.size, 0); assert.equal(f.lobby.queue.offers.size, 0); assert.deepEqual(room.toState(), before);
  f.lobby.ready(members[1], { ready: true });
  assert.deepEqual(f.lobby.queue.join(host, { difficulty: 'NORMAL', party: true }), { ok: true });
  assert.equal(room.seats[0].ready, false); assert.equal(f.lobby.queue.size, 2);
  assert.equal(f.lobby.ready(members[1], { ready: false }).error, ERR.QUEUED);
  assert.equal(f.lobby.setExperimental(host, { experimental: options(8) }).error, ERR.QUEUED);
  // Admission is checked again, including an internal race bypassing public locks.
  room.seats[1].ready = false;
  assert.equal(f.lobby.matchmakingAvailable(host, f.lobby.queue.entries.get(host.playerId)), false);
});

test('ended public matchmaking rooms cannot become expanded friend rooms; ordinary experimental flags remain editable', t => {
  const f = fixture(t), players = Array.from({ length: 4 }, () => f.player());
  for (const p of players) assert.deepEqual(f.lobby.queue.join(p, { difficulty: 'NORMAL' }), { ok: true });
  for (const p of players) assert.deepEqual(f.lobby.queue.accept(p, f.lobby.queue.state(p)), { ok: true });
  const room = f.lobby.roomOf(players[0]); assert.equal(room.source, 'matchmaking');
  room.match.opts.onEnd({ reason: 'fixture-ended' }); assert.equal(room.match, null);
  f.lobby.ready(players[1], { ready: true });
  const before = structuredClone(room.toState()), seats = room.seats, experimental = room.experimental, replay = room.replay, messages = players[0].messages.length;
  for (const capacity of [8, 12, 16, 20]) {
    assert.equal(f.lobby.setExperimental(players[0], { experimental: options(capacity) }).error, ERR.BAD_MSG);
    assert.equal(room.seats, seats); assert.equal(room.experimental, experimental); assert.equal(room.replay, replay);
    assert.deepEqual(room.toState(), before); assert.equal(players[0].messages.length, messages);
  }
  assert.deepEqual(f.lobby.setExperimental(players[0], { experimental: { revivalEnabled: true, disableSharedPool: true, playerCapacity: 4 } }), { ok: true });
  assert.equal(room.capacity, 4); assert.equal(room.seats.length, 4); assert.equal(room.seats[1].ready, false);
  assert.deepEqual(room.experimental, { revivalEnabled: true, disableSharedPool: true });
});

test('actual native WS twenty-seat room rejects overflow/legacy resume without replacing compatible socket', async t => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: RecordingMatch }), clients = [];
  t.after(async () => { await Promise.all(clients.map(c => c.terminate())); await srv.close(); });
  const connect = async (name, compatible = true) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`); clients.push(c);
    c.welcome = await c.hello(name, undefined, { matchmakingVersion: MATCHMAKING_VERSION, ...(compatible ? { playerCapacityVersion: PLAYER_CAPACITY_VERSION } : {}) }); return c;
  };
  const members = [];
  for (let i = 0; i < 20; i++) members.push(await connect(`Wire${i}`));
  const host = members[0];
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', experimental: options(20) })).t, 'ok');
  const room = await host.waitFor('room.state', m => m.hostId === host.welcome.playerId);
  for (const c of members.slice(1)) assert.equal((await c.request({ t: 'room.join', code: room.code })).t, 'ok');
  const full = await host.waitFor('room.state', m => m.seats.filter(Boolean).length === 20);
  assert.equal(full.seats[19].playerId, members[19].welcome.playerId);
  const overflow = await connect('Overflow'); assert.equal((await overflow.request({ t: 'room.join', code: room.code })).code, ERR.ROOM_FULL);
  assert.equal((await members[19].request({ t: 'room.setExperimental', experimental: options(4) })).code, ERR.NOT_HOST);
  assert.equal((await host.request({ t: 'room.setExperimental', experimental: options(16) })).code, ERR.ROOM_FULL);
  const legacy = await connect('Legacy', false); assert.equal((await legacy.request({ t: 'room.spectate', code: room.code })).code, ERR.BAD_MSG);
  const attemptedResume = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`); clients.push(attemptedResume);
  assert.equal((await attemptedResume.request({ t: 'hello', version: 1, name: 'Wire19', token: members[19].welcome.token })).code, ERR.BAD_MSG);
  assert.equal(members[19].closeInfo, null);
  assert.equal((await members[19].request({ t: 'room.ready', ready: true })).t, 'ok');
  assert.equal((await host.request({ t: 'queue.join', difficulty: 'NORMAL', party: true })).code, ERR.NOT_READY);
  assert.equal((await host.request({ t: 'room.kick', seat: 19, playerId: members[19].welcome.playerId })).t, 'ok');
  assert.equal((await members[19].waitFor('room.closed')).reason, 'kicked');
});

test('actual native WS party requires nonhost readiness before allocating any queue ticket', async t => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: RecordingMatch }), clients = [];
  t.after(async () => { await Promise.all(clients.map(c => c.terminate())); await srv.close(); });
  for (const name of ['ReadyHost', 'ReadyPeer']) { const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`); clients.push(c); await c.hello(name, undefined, { matchmakingVersion: MATCHMAKING_VERSION }); }
  const [host, peer] = clients;
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  const room = await host.waitFor('room.state');
  assert.equal((await peer.request({ t: 'room.join', code: room.code })).t, 'ok');
  assert.equal((await host.request({ t: 'queue.join', difficulty: 'NORMAL', party: true })).code, ERR.NOT_READY);
  assert.equal(srv.lobby.queue.size, 0);
  assert.equal((await peer.request({ t: 'room.ready', ready: true })).t, 'ok');
  assert.equal((await host.request({ t: 'queue.join', difficulty: 'NORMAL', party: true })).t, 'ok');
  assert.equal(srv.lobby.queue.size, 2);
  assert.equal((await peer.request({ t: 'room.ready', ready: false })).code, ERR.QUEUED);
});

test('normal four-player exact-fill and wildcard solo queues retain capacity four', t => {
  const f = fixture(t), { room: old, host, members } = f.room(4, 2), solos = [f.player(false), f.player(false)];
  f.lobby.ready(members[1], { ready: true });
  assert.deepEqual(f.lobby.queue.join(host, { difficulty: 'NORMAL', party: true }), { ok: true });
  for (const solo of solos) assert.deepEqual(f.lobby.queue.join(solo, { difficulty: 'NORMAL' }), { ok: true });
  for (const p of [...members, ...solos]) assert.deepEqual(f.lobby.queue.accept(p, f.lobby.queue.state(p)), { ok: true });
  const room = f.lobby.roomOf(host); assert.notEqual(room, old); assert.equal(room.capacity, 4); assert.equal(room.seats.length, 4);
  assert.ok(room.match); assert.equal(old.disposed, true);
});
