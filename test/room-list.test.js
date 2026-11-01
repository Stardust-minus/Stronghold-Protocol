// Feedback #30: 公开同盟 — a host's opt-in, rooms that fall off the list by themselves, one shared scan, nothing private on the wire.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Lobby, ROOM_LIST_CACHE_MS } from '../server/lobby.js';
import { HEAVY_TYPES, SessionRegistry } from '../server/net.js';
import { ERR, MATCHMAKING_VERSION, ROOM_LIST_MAX } from '../shared/constants.js';
import { PLAYER_CAPACITY_VERSION } from '../shared/playerCapacity.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { restoreLobby, snapshotLobby } from '../server/persist/lobbyState.js';

const rules = (capacity, extra = {}) => ({ revivalEnabled: false, disableSharedPool: false,
  ...(capacity > 4 ? { playerCapacity: capacity } : {}), ...extra });
class RecordingMatch {
  constructor(opts) { this.opts = opts; }
  start() {}
  dispose() {} onDisconnect() {} onReconnect() {} onLeave() {}
}

function fixture(t) {
  let clock = 10_000, count = 0;
  const registry = new SessionRegistry({ now: () => clock });
  const lobby = new Lobby({ registry, now: () => clock, MatchClass: RecordingMatch, getData: () => ({}), seedFn: () => 71 });
  t.after(() => lobby.shutdown());
  const player = () => {
    const s = registry.create(`List${++count}`); s.connected = true; s.messages = [];
    s.playerCapacityVersion = PLAYER_CAPACITY_VERSION; s.matchmakingVersion = MATCHMAKING_VERSION;
    s.ws = { readyState: 1, bufferedAmount: 0, send(raw, cb) { s.messages.push(JSON.parse(raw)); cb?.(); } };
    return s;
  };
  const room = (capacity = 8, opts = {}) => {
    const host = player();
    assert.deepEqual(lobby.create(host, { mode: 'coop', difficulty: 'NORMAL', experimental: rules(capacity), ...opts }), { ok: true });
    return { host, room: lobby.roomOf(host) };
  };
  const list = () => { clock += ROOM_LIST_CACHE_MS; return lobby.roomList().reply.rooms; };
  return { lobby, player, room, list, advance: (ms) => { clock += ms; } };
}

test('a room is off the list until its host lists it; the list carries what it shows and no more', t => {
  const f = fixture(t), { host, room } = f.room(8);
  assert.deepEqual(f.list(), []);
  assert.equal(room.toState(0).listed, undefined, 'room.state stays identical while off');
  assert.deepEqual(f.lobby.setListed(host, { listed: true }), { ok: true });
  assert.equal(room.toState(0).listed, true);
  const [row, ...rest] = f.list();
  assert.equal(rest.length, 0);
  assert.deepEqual(Object.keys(row).sort(), ['capacity', 'code', 'difficulty', 'experimental', 'filled', 'host', 'humans']);
  assert.deepEqual([row.code, row.host, row.humans, row.filled, row.capacity, row.difficulty], [room.code, host.name, 1, 1, 8, 'NORMAL']);
});

test('who may list: the host of a private co-op room of eight or more, never a smaller, solo or test room', t => {
  const f = fixture(t), small = f.room(4), big = f.room(8), guest = f.player();
  assert.equal(f.lobby.setListed(small.host, { listed: true }).error, ERR.BAD_TARGET);
  assert.deepEqual(f.lobby.join(guest, { code: big.room.code }), { ok: true });
  assert.equal(f.lobby.setListed(guest, { listed: true }).error, ERR.NOT_HOST);
  assert.equal(f.lobby.setListed(f.player(), { listed: true }).error, ERR.NOT_IN_ROOM);
  const solo = f.player();
  assert.deepEqual(f.lobby.create(solo, { mode: 'solo', difficulty: 'NORMAL' }), { ok: true });
  assert.equal(f.lobby.setListed(solo, { listed: true }).error, ERR.BAD_TARGET);
  assert.deepEqual(f.lobby.setListed(small.host, { listed: false }), { ok: true }, 'off is always fine');
});

test('a host cutting the capacity below eight takes the room off, and it does not come back by itself', t => {
  const f = fixture(t), { host, room } = f.room(8);
  f.lobby.setListed(host, { listed: true });
  assert.deepEqual(f.lobby.setExperimental(host, { experimental: rules(4) }), { ok: true });
  assert.equal(room.listed, false);
  assert.deepEqual(f.lobby.setExperimental(host, { experimental: rules(8) }), { ok: true });
  assert.deepEqual(f.list(), []);
});

test('a full room, a started match and a disconnected host drop out; the room comes back when it waits again', t => {
  const f = fixture(t), { host, room } = f.room(8), guests = [];
  f.lobby.setListed(host, { listed: true });
  for (let i = 0; i < 7; i++) {
    assert.equal(f.list().length, 1);
    const guest = f.player(); guests.push(guest);
    assert.deepEqual(f.lobby.join(guest, { code: room.code }), { ok: true });
  }
  assert.deepEqual(f.list(), [], 'full');
  assert.deepEqual(f.lobby.leave(guests.pop()), { ok: true });
  assert.equal(f.list()[0].filled, 7);
  room.match = {}; assert.deepEqual(f.list(), [], 'started'); room.match = null;
  room.seatOf(host.playerId).connected = false; assert.deepEqual(f.list(), [], 'host away');
  room.seatOf(host.playerId).connected = true;
  assert.equal(f.list().length, 1);
});

test('a dissolved room is gone', t => {
  const f = fixture(t), { host } = f.room(8);
  f.lobby.setListed(host, { listed: true });
  assert.deepEqual(f.lobby.leave(host), { ok: true });
  assert.deepEqual(f.list(), []);
});

test('a party in the queue is not waiting for strangers', t => {
  const f = fixture(t), { host, room } = f.room(8);
  f.lobby.setListed(host, { listed: true });
  assert.deepEqual(f.lobby.queue.join(host, { difficulty: room.difficulty, party: true }), { ok: true });
  assert.deepEqual(f.list(), []);
  assert.equal(f.lobby.setListed(host, { listed: false }).error, ERR.QUEUED);
});

test('askers share one scan; a host\'s own change is seen at once', t => {
  const f = fixture(t), a = f.room(8), b = f.room(8);
  f.lobby.setListed(a.host, { listed: true });
  const first = f.lobby.roomList().reply.rooms;
  assert.equal(first.length, 1);
  let scans = 0;
  const open = f.lobby.roomOpen.bind(f.lobby);
  f.lobby.roomOpen = (room) => { scans++; return open(room); };
  assert.equal(f.lobby.roomList().reply.rooms, first, 'the same answer');
  assert.equal(scans, 0);
  f.lobby.setListed(b.host, { listed: true });
  assert.equal(f.lobby.roomList().reply.rooms.length, 2);
  assert.ok(HEAVY_TYPES.has('room.list'));
});

test('the fullest come first, and an answer holds at most ROOM_LIST_MAX', t => {
  const f = fixture(t), rooms = Array.from({ length: ROOM_LIST_MAX + 3 }, () => f.room(8));
  for (const r of rooms) f.lobby.setListed(r.host, { listed: true });
  const last = rooms.at(-1);
  assert.deepEqual(f.lobby.join(f.player(), { code: last.room.code }), { ok: true });
  const list = f.list();
  assert.equal(list.length, ROOM_LIST_MAX);
  assert.equal(list[0].code, last.room.code);
  assert.equal(list[1].code, rooms[0].room.code, 'then the oldest');
});

test('the list survives a restart with the room', t => {
  const f = fixture(t), { host, room } = f.room(8), plain = f.room(8);
  f.lobby.setListed(host, { listed: true });
  const doc = JSON.parse(JSON.stringify(snapshotLobby({ registry: f.lobby.registry, lobby: f.lobby, now: 10_000 })));
  const rooms = Array.isArray(doc.rooms) ? doc.rooms : Object.values(doc.rooms);
  assert.equal(rooms.find((r) => r.code === room.code).listed, true);
  assert.equal(Object.hasOwn(rooms.find((r) => r.code === plain.room.code), 'listed'), false);
  const registry = new SessionRegistry({ now: () => 10_000 });
  const lobby = new Lobby({ registry, now: () => 10_000, MatchClass: RecordingMatch, getData: () => ({}), seedFn: () => 71 });
  t.after(() => lobby.shutdown());
  restoreLobby({ doc, registry, lobby, now: 10_000 });
  assert.equal(lobby.rooms.get(room.code).listed, true);
  assert.equal(lobby.rooms.get(plain.room.code).listed, false);
});

test('on the wire: room.list answers on its ok, room.setListed reaches room.state, a listed room is joined by its key', async t => {
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true, MatchClass: RecordingMatch }), clients = [];
  t.after(async () => { await Promise.all(clients.map((c) => c.terminate())); await srv.close(); });
  const connect = async (name) => {
    const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`); clients.push(client);
    await client.hello(name, undefined, { matchmakingVersion: MATCHMAKING_VERSION, playerCapacityVersion: PLAYER_CAPACITY_VERSION });
    return client;
  };
  const [host, seeker] = await Promise.all(['Listed', 'Seeker'].map(connect));
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', experimental: rules(8) })).t, 'ok');
  const room = await host.waitFor('room.state');
  assert.equal((await host.request({ t: 'room.setListed', listed: true })).t, 'ok');
  await host.waitFor('room.state', (s) => s.listed === true);
  const answer = await seeker.request({ t: 'room.list' });
  assert.equal(answer.t, 'ok');
  assert.equal(answer.rooms.length, 1);
  assert.equal(answer.rooms[0].code, room.code);
  assert.equal(JSON.stringify(answer).includes(host.welcome?.playerId ?? 'no-such-id'), false);
  assert.equal((await seeker.request({ t: 'room.join', code: answer.rooms[0].code })).t, 'ok');
  assert.equal((await seeker.waitFor('room.state')).seats.filter(Boolean).length, 2);
});
