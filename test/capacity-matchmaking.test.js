// Same-mode parties remain whole across offers, failures and actual wire admission.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { Matchmaking } from '../server/matchmaking.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';
import { PLAYER_CAPACITIES, PLAYER_CAPACITY_VERSION } from '../shared/playerCapacity.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

const rules = (capacity, extra = {}) => ({ revivalEnabled: false, disableSharedPool: false,
  ...(capacity > 4 ? { playerCapacity: capacity } : {}), ...extra });
class RecordingMatch {
  constructor(opts) { this.opts = opts; }
  start() {
    this.opts.broadcast({ t: 'm.public', phase: 'INFO_CHECK', roomCode: this.opts.roomCode });
    for (const seat of this.opts.seats) this.opts.send(seat.playerId, { t: 'm.private', playerId: seat.playerId, loadout: seat.loadout });
  }
  dispose() {} onDisconnect() {} onReconnect() {} onLeave() {}
}
function fixture(t, MatchClass = RecordingMatch) {
  let clock = 10_000, count = 0;
  const registry = new SessionRegistry({ now: () => clock });
  const lobby = new Lobby({ registry, now: () => clock, MatchClass, getData: () => ({}), seedFn: () => 71 });
  t.after(() => lobby.shutdown());
  const player = () => {
    const s = registry.create(`Mode${++count}`); s.connected = true; s.messages = [];
    s.playerCapacityVersion = PLAYER_CAPACITY_VERSION; s.matchmakingVersion = MATCHMAKING_VERSION;
    s.ws = { readyState: 1, bufferedAmount: 0, send(raw, cb) { s.messages.push(JSON.parse(raw)); cb?.(); } };
    return s;
  };
  const party = (capacity, size, extra = {}, difficulty = 'NORMAL') => {
    const members = Array.from({ length: size }, player), host = members[0];
    assert.deepEqual(lobby.create(host, { mode: 'coop', difficulty, experimental: rules(capacity, extra) }), { ok: true });
    const room = lobby.roomOf(host);
    for (const member of members.slice(1)) {
      assert.deepEqual(lobby.join(member, { code: room.code }), { ok: true });
      assert.deepEqual(lobby.ready(member, { ready: true }), { ok: true });
    }
    return { members, host, room };
  };
  const join = group => lobby.queue.join(group.host, { difficulty: group.room.difficulty, party: true });
  const accept = members => members.map(member => lobby.queue.accept(member, lobby.queue.state(member)));
  return { lobby, registry, player, party, join, accept, advance: ms => { clock += ms; } };
}

for (const capacity of PLAYER_CAPACITIES) test(`${capacity}-mode merges intact rooms and commits all confirmed humans at once`, t => {
  const f = fixture(t), a = f.party(capacity, 1), b = f.party(capacity, capacity - 1);
  const members = [...a.members, ...b.members], oldRooms = [a.room, b.room];
  assert.deepEqual(f.join(a), { ok: true });
  assert.equal(f.lobby.queue.state(a.host).state, 'queued');
  assert.equal(f.lobby.queue.state(a.host).required, capacity);
  assert.deepEqual(f.join(b), { ok: true });
  const offerId = f.lobby.queue.state(a.host).offerId;
  assert.ok(members.every(p => f.lobby.queue.state(p).offerId === offerId));
  for (const p of members.slice(0, -1)) assert.deepEqual(f.lobby.queue.accept(p, f.lobby.queue.state(p)), { ok: true });
  assert.equal(f.lobby.rooms.size, 2); assert.ok(oldRooms.every(r => r.match === null && !r.disposed));
  assert.deepEqual(f.lobby.queue.accept(members.at(-1), f.lobby.queue.state(members.at(-1))), { ok: true });
  const room = f.lobby.roomOf(a.host);
  assert.equal(f.lobby.rooms.size, 1); assert.equal(room.capacity, capacity); assert.equal(room.source, 'matchmaking');
  assert.equal(room.seats.length, capacity); assert.equal(room.match.opts.seats.length, capacity);
  assert.deepEqual(room.seats.map(s => s.seat), Array.from({ length: capacity }, (_, i) => i));
  assert.ok(oldRooms.every(r => r.disposed)); assert.equal(f.lobby.queue.size, 0);
  for (const p of members) {
    const state = f.lobby.queue.state(p);
    assert.equal(state.state, 'matched'); assert.equal(state.required, capacity); assert.equal(state.code, room.code);
    assert.equal(p.roomCode, room.code);
    assert.ok(p.messages.filter(m => m.t === 'm.private').every(m => m.playerId === p.playerId));
    assert.ok(!JSON.stringify(state).includes('loadout'));
  }
  room.match.opts.onEnd({ reason: 'fixture' });
  const before = structuredClone(room.toState());
  const other = capacity === 4 ? 8 : 4;
  assert.equal(f.lobby.setExperimental(room.hostId === a.host.playerId ? a.host : b.host, { experimental: rules(other) }).error, ERR.BAD_MSG);
  assert.deepEqual(room.toState(), before);
  assert.deepEqual(f.lobby.setExperimental(a.host, { experimental: rules(capacity, { revivalEnabled: true }) }), { ok: true });
  assert.equal(room.capacity, capacity);
});

test('different capacities/difficulties/flags never share an offer; lobby solo stays in four-mode', t => {
  const f = fixture(t), eight = f.party(8, 4), twelve = f.party(12, 4), twenty = f.party(20, 4);
  const otherFlags = f.party(8, 4, { revivalEnabled: true }), otherDifficulty = f.party(8, 4, {}, 'HARD');
  for (const group of [eight, twelve, twenty, otherFlags, otherDifficulty]) assert.deepEqual(f.join(group), { ok: true });
  assert.equal(f.lobby.queue.offers.size, 0);
  const solos = Array.from({ length: 4 }, f.player);
  for (const p of solos) assert.deepEqual(f.lobby.queue.join(p, { difficulty: 'NORMAL', playerCapacity: 20 }), { ok: true });
  assert.equal(f.lobby.queue.offers.size, 1); assert.ok(solos.every(p => f.lobby.queue.state(p).required === 4));
  assert.ok([eight, twelve, twenty, otherFlags, otherDifficulty].every(g => f.lobby.queue.state(g.host).state === 'queued'));
  const complement = f.party(8, 4); assert.deepEqual(f.join(complement), { ok: true });
  const offer = f.lobby.queue.offers.get(f.lobby.queue.state(eight.host).offerId);
  assert.equal(offer.required, 8); assert.deepEqual(offer.entries.map(e => e.session), [...eight.members, ...complement.members]);
});

test('twenty-mode uses earliest feasible whole-party fit and skips an unfillable older unit', t => {
  const f = fixture(t), a = f.party(20, 7), b = f.party(20, 8), c = f.party(20, 6), d = f.party(20, 6);
  for (const group of [a, b, c, d]) assert.deepEqual(f.join(group), { ok: true });
  assert.equal(f.lobby.queue.state(a.host).state, 'queued');
  const offer = f.lobby.queue.offers.get(f.lobby.queue.state(b.host).offerId);
  assert.equal(offer.required, 20); assert.deepEqual(offer.entries.map(e => e.session), [...b.members, ...c.members, ...d.members]);
  assert.ok(a.members.every(p => f.lobby.queue.state(p).state === 'queued'));
});

for (const capacity of PLAYER_CAPACITIES.slice(1)) test(`${capacity}-mode still rejects unready, AI or obsolete client parties before creating tickets`, t => {
  const f = fixture(t), group = f.party(capacity, 2), before = structuredClone(group.room.toState());
  f.lobby.ready(group.members[1], { ready: false });
  assert.equal(f.join(group).error, ERR.NOT_READY); assert.equal(f.lobby.queue.size, 0);
  f.lobby.ready(group.members[1], { ready: true });
  group.members[1].playerCapacityVersion = 'capacity-1';
  assert.equal(f.join(group).error, ERR.BAD_MSG); assert.equal(f.lobby.queue.size, 0);
  group.members[1].playerCapacityVersion = PLAYER_CAPACITY_VERSION;
  assert.deepEqual(f.lobby.addBot(group.host), { ok: true });
  assert.equal(f.join(group).error, ERR.BAD_MSG); assert.equal(f.lobby.queue.size, 0);
  assert.deepEqual(f.lobby.removeBot(group.host, { seat: 2 }), { ok: true });
  assert.deepEqual(group.room.toState(), before);
  assert.deepEqual(f.join(group), { ok: true });
  group.members[1].playerCapacityVersion = 'capacity-1';
  f.lobby.queue.sync(group.host); assert.equal(f.lobby.queue.size, 0);
  assert.ok(group.members.every(p => f.lobby.queue.state(p).state === 'idle'));
});

for (const cause of ['cancel', 'disconnect', 'unconfirmed', 'internal rule change', 'host migration']) test(`twenty-mode ${cause} removes the whole affected party without consuming its original room`, t => {
  const f = fixture(t), a = f.party(20, 4), b = f.party(20, 16), beforeA = a.room.seats, beforeB = b.room.seats;
  f.join(a); f.join(b);
  for (const p of b.members) f.lobby.queue.accept(p, f.lobby.queue.state(p));
  if (cause === 'cancel') assert.deepEqual(f.lobby.queue.cancel(a.members[2], f.lobby.queue.state(a.members[2])), { ok: true });
  if (cause === 'disconnect') { a.members[2].connected = false; a.members[2].ws.readyState = 3; f.lobby.onDisconnect(a.members[2]); }
  if (cause === 'unconfirmed') { f.lobby.queue.accept(a.host, f.lobby.queue.state(a.host)); f.advance(30_000); f.lobby.queue.sweep(); }
  if (cause === 'internal rule change') { a.room.experimental = rules(16); f.lobby.queue.sync(a.host); }
  if (cause === 'host migration') { a.room.hostId = a.members[1].playerId; f.lobby.queue.sync(a.host); }
  assert.equal(f.lobby.queue.offers.size, 0);
  assert.ok(a.members.every(p => f.lobby.queue.state(p).state === 'idle'));
  assert.ok(b.members.every(p => f.lobby.queue.state(p).state === 'queued' && f.lobby.queue.state(p).required === 20));
  for (const group of [a, b]) {
    assert.equal(group.room.match, null); assert.equal(group.room.disposed, false);
    assert.ok(group.members.every(p => p.roomCode === group.room.code));
  }
  assert.equal(a.room.seats, beforeA); assert.equal(b.room.seats, beforeB);
});

test('failed twenty-player construction keeps both rooms, FIFO tickets and full confirmation policy', t => {
  class BrokenMatch extends RecordingMatch { start() { throw new Error('local allocation failure'); } }
  const f = fixture(t, BrokenMatch), a = f.party(20, 5), b = f.party(20, 15), members = [...a.members, ...b.members];
  f.join(a); f.join(b);
  const saved = members.map(p => f.lobby.queue.entries.get(p.playerId));
  for (const p of members.slice(0, -1)) assert.deepEqual(f.lobby.queue.accept(p, f.lobby.queue.state(p)), { ok: true });
  assert.equal(f.lobby.queue.accept(members.at(-1), f.lobby.queue.state(members.at(-1))).error, ERR.INTERNAL);
  assert.equal(f.lobby.rooms.size, 2); assert.equal(f.lobby.queue.offers.size, 0);
  for (const [i, p] of members.entries()) {
    assert.equal(f.lobby.queue.entries.get(p.playerId), saved[i]);
    assert.equal(f.lobby.queue.state(p).state, 'queued'); assert.equal(f.lobby.queue.state(p).required, 20);
    assert.ok(!p.messages.some(m => m.t === 'room.state' && m.inMatch));
  }
  assert.ok([a, b].every(g => !g.room.disposed && g.room.match === null && g.members.every(p => p.roomCode === g.room.code)));
});

test('large unfillable queue has bounded size-fit search and cannot split parties', t => {
  let next = 0;
  const queue = new Matchmaking({ available: () => true, send() {}, allocate() { throw new Error('not confirmed'); },
    members: s => ({ sessions: s.group, roomCode: s.roomCode, leaderId: s.playerId, experimental: rules(20) }) });
  t.after(() => queue.close());
  for (let i = 0; i < 80; i++) {
    const group = Array.from({ length: 7 }, () => ({ playerId: `q${++next}`, matchmakingVersion: MATCHMAKING_VERSION, playerCapacityVersion: PLAYER_CAPACITY_VERSION }));
    for (const s of group) { s.group = group; s.roomCode = `room${i}`; }
    assert.deepEqual(queue.join(group[0], { difficulty: 'NORMAL', party: true }), { ok: true });
  }
  assert.equal(queue.size, 560); assert.equal(queue.offers.size, 0);
});

test('actual HTTP/WS twenty-mode queues two rooms, cancels intact, then commits with high-seat private identity', async t => {
  const srv = await startServer({ host: '127.0.0.1', port: 0, quiet: true, MatchClass: RecordingMatch }), clients = [];
  t.after(async () => { await Promise.all(clients.map(c => c.terminate())); await srv.close(); });
  const connect = async name => {
    const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`); clients.push(client);
    client.welcome = await client.hello(name, undefined, { matchmakingVersion: MATCHMAKING_VERSION, playerCapacityVersion: PLAYER_CAPACITY_VERSION });
    return client;
  };
  const members = [];
  for (let i = 0; i < 20; i++) members.push(await connect(`ModeWire${i}`));
  const makeParty = async (list) => {
    assert.equal((await list[0].request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', experimental: rules(20) })).t, 'ok');
    const room = await list[0].waitFor('room.state', m => m.hostId === list[0].welcome.playerId);
    for (const p of list.slice(1)) {
      assert.equal((await p.request({ t: 'room.join', code: room.code })).t, 'ok');
      assert.equal((await p.request({ t: 'room.ready', ready: true })).t, 'ok');
    }
    return room.code;
  };
  const a = members.slice(0, 9), b = members.slice(9), codeA = await makeParty(a), codeB = await makeParty(b);
  const join = p => p.request({ t: 'queue.join', difficulty: 'NORMAL', party: true, playerCapacity: 4 });
  assert.equal((await join(a[0])).t, 'ok'); assert.equal((await join(b[0])).t, 'ok');
  const offered = await a[0].waitFor('queue.state', m => m.state === 'offered'); assert.equal(offered.required, 20);
  const cancel = await a[8].waitFor('queue.state', m => m.state === 'offered');
  assert.equal((await a[8].request({ t: 'queue.cancel', ticketId: cancel.ticketId })).t, 'ok');
  for (const p of members) await p.waitFor('queue.state', m => m.state === 'idle' && ['cancelled', 'unconfirmed'].includes(m.reason));
  const response = await fetch(`http://127.0.0.1:${srv.port}/`);
  assert.equal(response.status, 200); assert.ok((await response.text()).includes('<html'));
  assert.ok(srv.lobby.rooms.has(codeA)); assert.ok(srv.lobby.rooms.has(codeB));
  assert.equal(srv.lobby.queue.size, 0);
  assert.equal((await join(a[0])).t, 'ok'); assert.equal((await join(b[0])).t, 'ok');
  for (const p of members) {
    const offer = await p.waitFor('queue.state', m => m.state === 'offered' && m.offerId !== offered.offerId);
    assert.equal(offer.required, 20);
    assert.equal((await p.request({ t: 'queue.accept', ticketId: offer.ticketId, offerId: offer.offerId })).t, 'ok');
  }
  for (const p of members) {
    const matched = await p.waitFor('queue.state', m => m.state === 'matched'); assert.equal(matched.required, 20);
    const room = await p.waitFor('room.state', m => m.inMatch && m.code === matched.code);
    assert.equal(room.seats.length, 20); assert.equal(room.experimental.playerCapacity, 20);
    const own = await p.waitFor('m.private'); assert.equal(own.playerId, p.welcome.playerId);
  }
  const room = members[19].log.findLast(m => m.t === 'room.state' && m.inMatch);
  assert.equal(room.seats[19].playerId, members[19].welcome.playerId);
});
