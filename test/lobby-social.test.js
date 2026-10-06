import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Lobby, LOBBY_DEFAULTS } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { MATCHMAKING_VERSION, ERR, DIFFICULTIES, MAX_SPECTATORS } from '../shared/constants.js';
import { Matchmaking, MATCHMAKING_DEFAULTS } from '../server/matchmaking.js';
import { validateC2S } from '../shared/protocol.js';

class RecordingMatch {
  constructor(opts) { this.opts = opts; }
  start() {
    this.opts.broadcast({ t: 'm.public', phase: 'INFO_CHECK', roomCode: this.opts.roomCode });
    for (const seat of this.opts.seats) this.opts.send(seat.playerId, { t: 'm.private', playerId: seat.playerId, loadout: seat.loadout });
  }
  handle() { return { ok: true }; }
  onLeave() {}
  onDisconnect() {}
  onReconnect() {}
  dispose() {}
}

function harness(t, options = {}, MatchClass = RecordingMatch) {
  let clock = 10_000;
  const registry = new SessionRegistry({ now: () => clock });
  const lobby = new Lobby({ registry, now: () => clock, options, MatchClass, getData: () => ({}), seedFn: () => 7 });
  const player = (name = '博士', key = null) => {
    const s = registry.create(name);
    s.messages = [];
    s.ws = { readyState: 1, bufferedAmount: 0, send: (data, cb) => { s.messages.push(JSON.parse(data)); cb?.(); } };
    s.connected = true;
    s.matchmakingVersion = MATCHMAKING_VERSION;
    s.limitKey = key;
    lobby.onHello(s, { resumed: false, repeat: false });
    return s;
  };
  const group = (keys = []) => Array.from({ length: 4 }, (_, i) => player(`博士${i}`, keys[i] || null));
  const privateRoom = (players) => {
    assert.deepEqual(lobby.create(players[0], { mode: 'coop', difficulty: 'NORMAL' }), { ok: true });
    const room = lobby.roomOf(players[0]);
    for (const p of players.slice(1)) assert.deepEqual(lobby.join(p, { code: room.code }), { ok: true });
    return room;
  };
  const offer = (players, difficulty = 'NORMAL') => {
    for (const p of players) assert.deepEqual(lobby.queue.join(p, { difficulty }), { ok: true });
    return players.map((p) => ({ ...lobby.queue.state(p), revivalVote: false }));
  };
  const accept = (players, states) => players.map((p, i) => lobby.queue.accept(p, states[i]));
  const disconnect = (s) => { s.connected = false; s.ws.readyState = 3; lobby.onDisconnect(s); };
  t.after(() => lobby.shutdown());
  return { lobby, registry, player, group, privateRoom, offer, accept, disconnect, advance: (n) => { clock += n; } };
}

test('revival votes require three distinct humans and are locked for the running match', (t) => {
  const h = harness(t), players = h.group(), room = h.privateRoom(players);
  for (const p of players.slice(0, 2)) assert.deepEqual(h.lobby.voteRevival(p, { enable: true }), { ok: true });
  h.lobby.voteRevival(players[0], { enable: true });
  assert.deepEqual(room.revivalState(), { yes: 2, required: 3, enabled: false });
  h.lobby.voteRevival(players[2], { enable: true });
  assert.equal(room.revivalState().enabled, true);
  h.lobby.voteRevival(players[2], { enable: false });
  assert.equal(room.revivalState().yes, 2);
  h.lobby.voteRevival(players[2], { enable: true });
  for (const p of players.slice(1)) h.lobby.ready(p, { ready: true });
  assert.deepEqual(h.lobby.start(players[0]), { ok: true });
  assert.equal(room.match.opts.revivalEnabled, true);
  assert.equal(h.lobby.voteRevival(players[3], { enable: true }).error, ERR.ROOM_STARTED);
  h.lobby.leave(players[2]);
  assert.deepEqual(room.toState().revival, { yes: 3, required: 3, enabled: true });
  room.match.opts.onEnd({});
  assert.deepEqual(room.toState().revival, { yes: 0, required: 2, enabled: false });
  assert.ok(room.activeHumans().every((s) => s.revivalVote === null));
});

test('votes survive a reconnect but leave/new seat clears them; bots never vote', (t) => {
  const h = harness(t), players = h.group().slice(0, 3), room = h.privateRoom(players);
  h.lobby.voteRevival(players[1], { enable: true });
  h.disconnect(players[1]);
  assert.equal(room.revivalState().yes, 1);
  players[1].connected = true; players[1].ws.readyState = 1;
  h.lobby.onHello(players[1], { resumed: true, repeat: false });
  assert.equal(room.seatOf(players[1].playerId).revivalVote, true);
  h.lobby.leave(players[1]);
  assert.equal(room.revivalState().yes, 0);
  h.lobby.join(players[1], { code: room.code });
  assert.equal(room.seatOf(players[1].playerId).revivalVote, null);
  h.lobby.addBot(players[0]);
  const bot = room.seats.find((s) => s?.isBot);
  bot.revivalVote = true;
  assert.equal(room.revivalState().yes, 0);
  assert.equal(room.toState().seats.find((s) => s?.isBot).revivalVote, null);
});

test('failed match start preserves votes and clears only its rule lock', (t) => {
  class BrokenMatch extends RecordingMatch { start() { throw new Error('fixture'); } }
  const h = harness(t, {}, BrokenMatch), players = h.group(), room = h.privateRoom(players);
  for (const p of players) { h.lobby.voteRevival(p, { enable: true }); h.lobby.ready(p, { ready: true }); }
  assert.equal(h.lobby.start(players[0]).error, ERR.INTERNAL);
  assert.equal(room.match, null);
  assert.equal(room.revivalLocked, null);
  assert.equal(room.revivalState().yes, 4);
  assert.equal(room.revivalState().enabled, true);
});

test('solo cannot lower the fixed voting threshold', (t) => {
  const h = harness(t), p = h.player();
  h.lobby.create(p, { mode: 'solo', difficulty: 'FUNNY' });
  assert.equal(h.lobby.voteRevival(p, { enable: true }).error, ERR.WRONG_PHASE);
  h.lobby.start(p);
  assert.equal(h.lobby.roomOf(p).match.opts.revivalEnabled, false);
});

test('presence counts identified live identities, not repeats, bots, retained sessions or obsolete sockets', (t) => {
  const h = harness(t), a = h.player(), b = h.player();
  h.lobby.create(a, { mode: 'coop', difficulty: 'NORMAL' });
  h.lobby.addBot(a);
  h.registry.create('未握手');
  assert.equal(h.lobby.presenceState().online, 2);
  const seq = h.lobby.presenceSeq;
  h.lobby.onHello(a, { resumed: false, repeat: true });
  h.lobby.onHello(a, { resumed: true, repeat: false });
  h.lobby.onDisconnect(a); // obsolete close delivered while its replacement is still live
  assert.equal(h.lobby.presenceState().online, 2);
  assert.equal(h.lobby.presenceSeq, seq);
  h.disconnect(b);
  assert.equal(h.lobby.presenceState().online, 1);
  assert.equal(h.registry.size, 3);
  assert.ok(a.messages.some((m) => m.t === 'presence.state'));
});

test('four matching humans accept atomically into a running ordinary coop match without room ready/start', (t) => {
  const h = harness(t), players = h.group(), states = h.offer(players);
  assert.equal(h.lobby.rooms.size, 0);
  assert.ok(states.every((s) => s.state === 'offered' && s.required === 4 && s.accepted === false));
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(h.lobby.queue.accept(players[i], states[i]), { ok: true });
    assert.ok(players.every((p) => p.roomCode === null));
  }
  assert.deepEqual(h.lobby.queue.accept(players[3], states[3]), { ok: true });
  const room = h.lobby.roomOf(players[0]);
  assert.ok(room);
  assert.equal(room.source, 'matchmaking');
  assert.ok(room.match);
  assert.equal(room.mode, 'coop');
  assert.equal(room.difficulty, 'NORMAL');
  assert.equal(room.match.opts.modeId, 'mode_multi_normal');
  assert.equal(room.match.opts.revivalEnabled, false);
  assert.equal(room.activeHumans().length, 4);
  assert.ok(room.seats.every((s) => s && !s.isBot && s.ready && s.connected && s.revivalVote === false));
  assert.ok(players.every((p) => p.roomCode === room.code));
  assert.equal(h.lobby.queue.size, 0);
  for (const p of players) {
    const initial = p.messages.findIndex((m) => m.t === 'room.state');
    assert.deepEqual(p.messages.slice(initial).map((m) => m.t), ['room.state', 'm.public', 'm.private', 'queue.state']);
    assert.equal(p.messages[initial].inMatch, true);
    assert.equal(p.messages.at(-1).state, 'matched');
  }
  assert.equal(h.lobby.ready(players[1], { ready: true }).error, ERR.ROOM_STARTED);
  assert.equal(h.lobby.start(players[0]).error, ERR.ROOM_STARTED);
  assert.deepEqual(h.lobby.queue.cancel(players[0], states[0]), { ok: true });
  assert.equal(h.lobby.queue.state(players[0]).state, 'matched');
  assert.deepEqual(h.lobby.queue.accept(players[0], states[0]), { ok: true });
  assert.equal(h.lobby.rooms.size, 1);
  assert.equal(players[0].roomCode, room.code);
});

test('queue rejects incompatible clients, existing rooms and implicit switching; repeat join keeps age', (t) => {
  const h = harness(t), a = h.player(), b = h.player();
  a.matchmakingVersion = null;
  assert.equal(h.lobby.queue.join(a, { difficulty: 'NORMAL' }).error, ERR.BAD_MSG);
  a.matchmakingVersion = MATCHMAKING_VERSION;
  h.lobby.create(b, { mode: 'solo', difficulty: 'FUNNY' });
  assert.equal(h.lobby.queue.join(b, { difficulty: 'NORMAL' }).error, ERR.WRONG_PHASE);
  h.lobby.queue.join(a, { difficulty: 'NORMAL' });
  const initial = h.lobby.queue.state(a);
  h.advance(100);
  h.lobby.queue.join(a, { difficulty: 'NORMAL' });
  assert.deepEqual(h.lobby.queue.state(a), initial);
  assert.equal(h.lobby.queue.join(a, { difficulty: 'HARD' }).error, ERR.QUEUED);
  assert.equal(h.lobby.create(a, { mode: 'coop', difficulty: 'NORMAL' }).error, ERR.QUEUED);
  assert.equal(h.lobby.join(a, { code: b.roomCode }).error, ERR.QUEUED);
  assert.equal(h.lobby.queue.cancel(a, { ticketId: 'stale' }).error, ERR.BAD_TARGET);
  assert.ok(h.lobby.queue.has(a));
});

test('cancel racing the fourth acceptance never allocates the cancelled cohort', (t) => {
  const h = harness(t), players = h.group(), states = h.offer(players);
  for (let i = 0; i < 3; i++) h.lobby.queue.accept(players[i], states[i]);
  h.lobby.queue.cancel(players[0], states[0]);
  assert.equal(h.lobby.queue.accept(players[3], states[3]).error, ERR.BAD_TARGET);
  assert.equal(h.lobby.rooms.size, 0);
  assert.equal(h.lobby.queue.size, 2);
  assert.equal(h.lobby.queue.state(players[3]).state, 'idle');
  assert.equal(players[3].messages.at(-1).reason, 'unconfirmed');
  assert.equal(h.lobby.queue.state(players[1]).joinedAt, states[1].joinedAt);
  assert.equal(h.lobby.queue.state(players[1]).reason, 'peer_cancelled');
  for (let i = 0; i < 2; i++) h.lobby.queue.join(h.player(), { difficulty: 'NORMAL' });
  const next = h.lobby.queue.state(players[1]);
  assert.notEqual(next.offerId, states[1].offerId);
  assert.equal(next.accepted, false);
});

test('disconnect removes ticket immediately and excludes it from the next offer', (t) => {
  const h = harness(t), players = h.group(), states = h.offer(players);
  h.accept(players.slice(1), states.slice(1));
  h.disconnect(players[0]);
  assert.equal(h.lobby.queue.size, 3);
  assert.equal(h.lobby.queue.state(players[0]).state, 'idle');
  players[0].connected = true; players[0].ws.readyState = 1;
  h.lobby.onHello(players[0], { resumed: true, repeat: false });
  assert.equal(h.lobby.queue.state(players[0]).state, 'idle');
  assert.equal(h.lobby.queue.accept(players[0], states[0]).error, ERR.BAD_TARGET);
});

for (const trigger of ['cancelled', 'disconnected', 'unavailable']) test(`early offer ${trigger} never requeues unconfirmed solo survivors`, (t) => {
  const h = harness(t), players = h.group(), offers = h.offer(players);
  const original = { ...h.lobby.queue.entries.get(players[0].playerId) };
  assert.deepEqual(h.lobby.queue.accept(players[0], offers[0]), { ok: true });
  if (trigger === 'cancelled') h.lobby.queue.cancel(players[1], offers[1]);
  else if (trigger === 'disconnected') h.disconnect(players[1]);
  else { players[1].matchmakingVersion = null; h.lobby.queue.sync(players[1]); }
  assert.equal(h.lobby.queue.size, 1);
  assert.equal(h.lobby.queue.offers.size, 0);
  const survivor = h.lobby.queue.entries.get(players[0].playerId);
  for (const key of ['ticketId', 'sequence', 'joinedAt', 'expiresAt']) assert.equal(survivor[key], original[key]);
  assert.equal(survivor.accepted, false); assert.equal(survivor.revivalVote, null);
  for (const p of players.slice(2)) {
    assert.equal(h.lobby.queue.state(p).state, 'idle');
    assert.equal(p.messages.filter((m) => m.t === 'queue.state').at(-1).reason, 'unconfirmed');
    assert.equal(h.lobby.queue.accept(p, offers[players.indexOf(p)]).error, ERR.BAD_TARGET);
  }
  const replacements = h.group().slice(0, 3);
  for (const p of replacements) h.lobby.queue.join(p, { difficulty: 'NORMAL' });
  assert.equal(h.lobby.queue.size, 4);
  assert.equal(h.lobby.queue.offers.size, 1);
  assert.ok([players[0], ...replacements].every((p) => h.lobby.queue.state(p).state === 'offered'));
  assert.ok(players.slice(1).every((p) => !h.lobby.queue.has(p)));
});

for (const trigger of ['cancelled', 'disconnected', 'unavailable']) test(`early offer ${trigger} drops a partially confirmed party intact and preserves its room`, (t) => {
  const h = harness(t), party = h.group().slice(0, 2), solos = h.group().slice(0, 2);
  const room = h.privateRoom(party);
  h.lobby.queue.join(party[0], { difficulty: 'NORMAL', party: true });
  for (const p of solos) h.lobby.queue.join(p, { difficulty: 'NORMAL' });
  const players = [...party, ...solos], offers = players.map((p) => ({ ...h.lobby.queue.state(p), revivalVote: false }));
  h.lobby.queue.accept(party[0], offers[0]);
  h.lobby.queue.accept(solos[0], offers[2]);
  const original = { ...h.lobby.queue.entries.get(solos[0].playerId) };
  if (trigger === 'cancelled') h.lobby.queue.cancel(solos[1], offers[3]);
  else if (trigger === 'disconnected') h.disconnect(solos[1]);
  else { solos[1].matchmakingVersion = null; h.lobby.queue.sync(solos[1]); }
  assert.equal(h.lobby.queue.size, 1);
  assert.equal(h.lobby.queue.parties.size, 1);
  assert.equal(h.lobby.queue.offers.size, 0);
  for (const p of party) {
    assert.equal(h.lobby.queue.state(p).state, 'idle');
    assert.equal(p.messages.filter((m) => m.t === 'queue.state').at(-1).reason, 'unconfirmed');
    assert.equal(h.lobby.roomOf(p), room);
    assert.equal(h.lobby.queue.accept(p, offers[players.indexOf(p)]).error, ERR.BAD_TARGET);
  }
  assert.equal(room.disposed, false); assert.equal(room.match, null);
  assert.equal(room.activeHumans().length, 2); assert.equal(h.lobby.roomQueued(room), false);
  const survivor = h.lobby.queue.entries.get(solos[0].playerId);
  for (const key of ['ticketId', 'sequence', 'joinedAt', 'expiresAt']) assert.equal(survivor[key], original[key]);
  assert.equal(survivor.accepted, false); assert.equal(survivor.revivalVote, null);
});

test('default thirty-second offer timeout exits every unconfirmed human without automatic rematching', (t) => {
  const h = harness(t), players = h.group(); h.offer(players);
  h.advance(29_999); h.lobby.queue.sweep();
  assert.equal(h.lobby.queue.size, 4);
  assert.ok(players.every((p) => h.lobby.queue.state(p).state === 'offered'));
  h.advance(1); h.lobby.queue.sweep();
  assert.equal(h.lobby.queue.size, 0); assert.equal(h.lobby.queue.offers.size, 0);
  assert.ok(players.every((p) => h.lobby.queue.state(p).state === 'idle'
    && p.messages.at(-1).reason === 'confirmation_timeout'));
  for (const p of h.group().slice(0, 3)) h.lobby.queue.join(p, { difficulty: 'NORMAL' });
  assert.equal(h.lobby.queue.offers.size, 0);
  assert.ok(players.every((p) => !h.lobby.queue.has(p)));
});

test('offer deadline drops unconfirmed players; accepted survivors retain FIFO and queue expires', (t) => {
  const h = harness(t, { matchmaking: { acceptMs: 100, waitMs: 500 } }), players = h.group(), states = h.offer(players);
  h.lobby.queue.accept(players[0], states[0]);
  h.advance(100);
  assert.equal(h.lobby.queue.accept(players[1], states[1]).error, ERR.BAD_TARGET);
  assert.equal(h.lobby.queue.size, 1);
  const waiting = h.lobby.queue.state(players[0]);
  assert.equal(waiting.state, 'queued');
  assert.equal(waiting.ticketId, states[0].ticketId);
  assert.equal(waiting.joinedAt, states[0].joinedAt);
  assert.equal(waiting.reason, 'confirmation_timeout');
  h.advance(400);
  h.lobby.queue.sweep();
  assert.equal(h.lobby.queue.size, 0);
  assert.equal(h.lobby.rooms.size, 0);
});

test('default concurrency admission allows same-network rooms/matches and four-human allocation without quantity caps', (t) => {
  for (const key of ['maxRooms', 'maxRoomsPerAddr', 'maxMatchesPerAddr']) assert.equal(LOBBY_DEFAULTS[key], 0);
  assert.equal(MATCHMAKING_DEFAULTS.maxEntries, 0);
  assert.equal(MATCHMAKING_DEFAULTS.maxPerAddr, 0);
  const h = harness(t);
  // Tiny stub matches cross the former per-network limits without simulating any battles.
  for (let i = 0; i < 17; i++) {
    const p = h.player(`房主${i}`, 'A');
    assert.deepEqual(h.lobby.create(p, { mode: 'solo', difficulty: 'NORMAL' }), { ok: true });
    assert.deepEqual(h.lobby.start(p), { ok: true });
  }
  const queued = Array.from({ length: 20 }, (_, i) => h.player(`队列${i}`, 'A'));
  for (const p of queued) assert.deepEqual(h.lobby.queue.join(p, { difficulty: 'NORMAL' }), { ok: true });
  assert.equal(h.lobby.queue.size, 20);
  assert.equal(h.lobby.queue.offers.size, 5);
  assert.ok([...h.lobby.queue.offers.values()].every((offer) => offer.entries.length === 4));
  const players = queued.slice(0, 4), states = players.map((p) => ({ ...h.lobby.queue.state(p), revivalVote: false }));
  assert.ok(h.accept(players, states).every((result) => result.ok));
  assert.equal(h.lobby.rooms.size, 18);
  assert.equal(h.lobby.stats().matches, 18);
  assert.equal(h.lobby.roomOf(players[0]).activeHumans().length, 4);
  assert.equal(h.lobby.queue.size, 16);
});

for (const options of [{ maxEntries: 2, maxPerAddr: 0 }, { maxEntries: 0, maxPerAddr: 2 }]) {
  test(`queue cap overrides are independent (${JSON.stringify(options)})`, (t) => {
    const h = harness(t, { matchmaking: options });
    const players = [h.player('队列0', 'A'), h.player('队列1', 'A'), h.player('队列2', 'A'), h.player('另一网络', 'B')];
    for (const p of players.slice(0, 2)) assert.deepEqual(h.lobby.queue.join(p, { difficulty: 'NORMAL' }), { ok: true });
    assert.equal(h.lobby.queue.join(players[2], { difficulty: 'NORMAL' }).error, ERR.RATE);
    const other = h.lobby.queue.join(players[3], { difficulty: 'NORMAL' });
    if (options.maxEntries > 0) assert.equal(other.error, ERR.RATE);
    else assert.deepEqual(other, { ok: true });
  });
}

test('matchmaking validation accepts zero quantity caps but rejects invalid caps and zero deadlines', () => {
  const construct = (options) => new Matchmaking({ options, send() {}, available: () => true, allocate() {} });
  const unlimited = construct({ maxEntries: 0, maxPerAddr: 0 });
  assert.equal(unlimited.opts.waitMs, 600_000);
  assert.equal(unlimited.opts.acceptMs, 30_000);
  unlimited.close();
  for (const key of ['maxEntries', 'maxPerAddr']) for (const value of [-1, .5, '0', 20_001]) {
    assert.throws(() => construct({ [key]: value }), TypeError);
  }
  for (const key of ['waitMs', 'acceptMs']) assert.throws(() => construct({ [key]: 0 }), TypeError);
});

test('positive global room admission cap still rejects a private create without moving its creator', (t) => {
  const h = harness(t, { maxRooms: 1 }), owner = h.player('房主'), other = h.player('满员');
  assert.deepEqual(h.lobby.create(owner, { mode: 'solo', difficulty: 'NORMAL' }), { ok: true });
  assert.equal(h.lobby.create(other, { mode: 'solo', difficulty: 'NORMAL' }).error, ERR.INTERNAL);
  assert.equal(other.roomCode, null);
  assert.equal(h.lobby.rooms.size, 1);
});

test('difficulties never mix; queue total and network capacity are bounded', (t) => {
  const h = harness(t, { matchmaking: { maxEntries: 4, maxPerAddr: 2 } });
  const players = h.group(['A', 'A', 'A', 'B']);
  h.lobby.queue.join(players[0], { difficulty: 'NORMAL' });
  h.lobby.queue.join(players[1], { difficulty: 'HARD' });
  assert.equal(h.lobby.queue.join(players[2], { difficulty: 'NORMAL' }).error, ERR.RATE);
  h.lobby.queue.join(players[3], { difficulty: 'NORMAL' });
  const extra = h.player('额外', 'C');
  h.lobby.queue.join(extra, { difficulty: 'HARD' });
  assert.ok([...h.lobby.queue.entries.values()].every((e) => !e.offerId));
  assert.equal(h.lobby.queue.join(h.player('满员', 'D'), { difficulty: 'NORMAL' }).error, ERR.RATE);
});

test('global room cap failure leaves no partially assigned seats or ghost offers', (t) => {
  const h = harness(t, { maxRooms: 1 }), players = h.group(), states = h.offer(players);
  const other = h.player('已有房间');
  h.lobby.create(other, { mode: 'solo', difficulty: 'FUNNY' });
  const results = h.accept(players, states);
  assert.equal(results[3].error, ERR.RATE);
  assert.equal(h.lobby.rooms.size, 1);
  assert.equal(h.lobby.queue.size, 4);
  assert.equal(h.lobby.queue.offers.size, 0);
  assert.ok(players.every((p, i) => p.roomCode === null && h.lobby.queue.state(p).ticketId === states[i].ticketId));
  assert.ok(players.every((p) => h.lobby.queue.state(p).state === 'queued' && h.lobby.queue.state(p).reason === 'allocation_failed'));
});

test('public rooms charge each distinct cohort network, and private creates share those limits', (t) => {
  const h = harness(t, { maxRoomsPerAddr: 1 }), players = h.group(['A', 'A', 'B', 'C']), states = h.offer(players);
  h.accept(players, states);
  const room = h.lobby.roomOf(players[0]);
  assert.equal(room.ownerKeys.size, 3);
  const outsider = h.player('同网络', 'B');
  assert.equal(h.lobby.create(outsider, { mode: 'solo', difficulty: 'FUNNY' }).error, ERR.RATE);
  h.lobby.leave(players[2]);
  assert.equal(h.lobby.create(outsider, { mode: 'solo', difficulty: 'FUNNY' }).error, ERR.RATE);
  for (const p of [players[0], players[1], players[3]]) h.lobby.leave(p);
  assert.deepEqual(h.lobby.create(outsider, { mode: 'solo', difficulty: 'FUNNY' }), { ok: true });
});

test('allocation revalidates every participant network quota without partial mutation', (t) => {
  const h = harness(t, { maxRoomsPerAddr: 1 }), players = h.group(['A', 'B', 'C', 'D']), states = h.offer(players);
  const occupant = h.player('占位', 'C');
  h.lobby.create(occupant, { mode: 'solo', difficulty: 'FUNNY' });
  const result = h.accept(players, states);
  assert.equal(result[3].error, ERR.RATE);
  assert.ok(players.every((p) => p.roomCode === null));
  assert.equal(h.lobby.queue.size, 4);
});

test('public match quota follows all cohort networks across host migration', (t) => {
  const h = harness(t, { maxMatchesPerAddr: 1 }), players = h.group(['A', 'B', 'C', 'D']);
  h.accept(players, h.offer(players));
  const room = h.lobby.roomOf(players[0]);
  const outsider = h.player('同网新局', 'B');
  h.lobby.create(outsider, { mode: 'solo', difficulty: 'FUNNY' });
  assert.equal(h.lobby.start(outsider).error, ERR.RATE);
  assert.equal(room.matchKeys.size, 4);
  // A post-game replay keeps ordinary room ready/start semantics and still rechecks the match quota.
  room.match.opts.onEnd({});
  assert.deepEqual(h.lobby.start(outsider), { ok: true });
  for (const p of players) h.lobby.ready(p, { ready: true });
  assert.equal(h.lobby.start(players[0]).error, ERR.RATE);
  h.lobby.roomOf(outsider).match.opts.onEnd({});
  assert.deepEqual(h.lobby.start(players[0]), { ok: true });
  assert.equal(room.matchKeys.size, 4);
  assert.equal(h.lobby.start(outsider).error, ERR.RATE);
  h.lobby.leave(players[0]);
  assert.equal(room.hostId, players[1].playerId);
  assert.equal(h.lobby.start(outsider).error, ERR.RATE);
});

test('new wire requests reject malformed boolean, ticket and resurrection identity fields', () => {
  for (const msg of [
    { t: 'room.voteRevival', enable: 'true' }, { t: 'queue.join', difficulty: 'ALL' },
    { t: 'queue.cancel', ticketId: '' }, { t: 'queue.accept', ticketId: 'ok', offerId: '../bad' },
    { t: 'g.revive', playerId: 'p1', round: 0, matchId: 'm' },
    { t: 'g.revive', playerId: 'p1', round: 1, matchId: 'x'.repeat(65) },
  ]) assert.ok(validateC2S(msg));
  assert.equal(validateC2S({ t: 'g.revive', playerId: 'p1', round: 1, matchId: 'm-1' }), null);
});

test('real websocket hello replacement identity and vote-bearing confirmation auto-start in wire order', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: RecordingMatch });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map((c) => c.terminate())); await srv.close(); });
  const connect = async (name, token, extra = {}) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`); clients.push(c);
    const w = await c.hello(name, token, { matchmakingVersion: MATCHMAKING_VERSION, ...extra });
    c.id = w.playerId; c.token = w.token;
    return c;
  };
  const a = await connect('博士0');
  assert.equal((await a.waitFor('presence.state')).online, 1);
  const same = await connect('博士0', a.token);
  await a.closed;
  assert.equal(a.closeInfo.code, 4001);
  assert.equal((await same.waitFor('presence.state')).online, 1);
  const group = [same, await connect('博士1'), await connect('博士2'), await connect('博士3')];
  for (const c of group) assert.equal((await c.request({ t: 'queue.join', difficulty: 'NORMAL' })).t, 'ok');
  const offers = await Promise.all(group.map((c) => c.waitFor('queue.state', (m) => m.state === 'offered')));
  const malformed = { t: 'queue.accept', ticketId: offers[0].ticketId, offerId: offers[0].offerId };
  for (const revivalVote of [undefined, null, 'true', 1]) {
    assert.equal((await group[0].request({ ...malformed, ...(revivalVote === undefined ? {} : { revivalVote }) })).code, ERR.BAD_MSG);
    assert.equal(srv.lobby.queue.state(srv.registry.byId(group[0].id)).accepted, false);
  }
  for (let i = 0; i < group.length; i++) assert.equal((await group[i].request({
    t: 'queue.accept', ticketId: offers[i].ticketId, offerId: offers[i].offerId, revivalVote: i < 3,
  })).t, 'ok');
  const states = await Promise.all(group.map((c) => c.waitFor('room.state', (m) => m.source === 'matchmaking')));
  assert.ok(states.every((s) => s.code === states[0].code && s.inMatch && s.seats.every((seat) => seat.ready)));
  for (const c of group) {
    await c.waitFor('queue.state', (m) => m.state === 'matched');
    const startAt = c.log.findIndex((m) => m.t === 'room.state');
    assert.deepEqual(c.log.slice(startAt, startAt + 4).map((m) => m.t), ['room.state', 'm.public', 'm.private', 'queue.state']);
  }
  assert.equal((await group[1].request({ t: 'room.ready', ready: true })).code, ERR.ROOM_STARTED);
  assert.equal((await group[0].request({ t: 'room.start' })).code, ERR.ROOM_STARTED);
  assert.equal(srv.lobby.getRoom(states[0].code).match.opts.revivalEnabled, true);
  assert.equal(srv.lobby.stats().online, 4);
  await group[3].terminate();
  await delay(15);
  assert.equal(srv.lobby.stats().online, 3);
});

test('same-session socket replacement preserves an offer; stale cancels cannot remove a later ticket', (t) => {
  const h = harness(t), players = h.group(), offers = h.offer(players);
  h.lobby.queue.accept(players[0], offers[0]);
  h.lobby.onHello(players[0], { resumed: true, repeat: false });
  assert.equal(h.lobby.queue.state(players[0]).offerId, offers[0].offerId);
  assert.equal(h.lobby.queue.state(players[0]).accepted, true);
  h.lobby.queue.cancel(players[0], offers[0]);
  h.lobby.queue.join(players[0], { difficulty: 'NORMAL' });
  const ticket = h.lobby.queue.state(players[0]).ticketId;
  assert.notEqual(ticket, offers[0].ticketId);
  assert.equal(h.lobby.queue.cancel(players[0], offers[0]).error, ERR.BAD_TARGET);
  assert.equal(h.lobby.queue.state(players[0]).ticketId, ticket);
});

test('hello and repeated queue intents do not scan the whole queue or re-broadcast acceptances', (t) => {
  const h = harness(t), players = h.group(), offers = h.offer(players);
  h.lobby.queue.sweep = () => { throw new Error('unexpected global scan'); };
  h.lobby.onHello(players[0], { resumed: false, repeat: true });
  assert.deepEqual(h.lobby.queue.join(players[0], { difficulty: 'NORMAL' }), { ok: true });
  h.lobby.queue.accept(players[0], offers[0]);
  const sent = players[1].messages.length;
  for (let i = 0; i < 20; i++) assert.deepEqual(h.lobby.queue.accept(players[0], offers[0]), { ok: true });
  assert.equal(players[1].messages.length, sent);
});

test('global presence broadcasts are coalesced independently of initial hello replies', (t) => {
  const h = harness(t), a = h.player();
  h.lobby.publishPresence();
  a.messages.length = 0;
  h.player('B'); h.player('C'); h.player('D');
  assert.equal(a.messages.filter((m) => m.t === 'presence.state').length, 0);
  assert.notEqual(h.lobby.presenceTimer, null);
  h.advance(1000);
  h.lobby.publishPresence();
  assert.equal(a.messages.filter((m) => m.t === 'presence.state').length, 1);
  assert.equal(a.messages.find((m) => m.t === 'presence.state').online, 4);
});

test('network or compatibility change cancels the old ticket instead of moving its frozen group', (t) => {
  const h = harness(t), players = h.group(['A', 'B', 'C', 'D']);
  const offers = h.offer(players);
  h.accept(players.slice(1), offers.slice(1));
  players[0].limitKey = 'E';
  h.lobby.onHello(players[0], { resumed: true, repeat: false });
  assert.equal(h.lobby.queue.state(players[0]).state, 'idle');
  assert.equal(h.lobby.queue.size, 3);
  players[1].matchmakingVersion = null;
  h.lobby.onHello(players[1], { resumed: true, repeat: false });
  assert.equal(h.lobby.queue.size, 2);
});

test('match quota is checked at allocation as well as at the later ordinary room start', (t) => {
  const h = harness(t, { maxMatchesPerAddr: 1 }), players = h.group(['A', 'B', 'C', 'D']), states = h.offer(players);
  const busy = h.player('已在作战', 'B');
  h.lobby.create(busy, { mode: 'solo', difficulty: 'NORMAL' });
  h.lobby.start(busy);
  assert.equal(h.accept(players, states)[3].error, ERR.RATE);
  assert.ok(players.every((p) => p.roomCode === null));
  assert.equal(h.lobby.queue.size, 4);
});

test('public-room replacement members must have a compatible handshake too', (t) => {
  const h = harness(t), players = h.group();
  h.accept(players, h.offer(players));
  const code = players[0].roomCode;
  h.lobby.roomOf(players[0]).match.opts.onEnd({});
  h.lobby.leave(players[3]);
  const legacy = h.player('旧客户端'); legacy.matchmakingVersion = null;
  assert.equal(h.lobby.join(legacy, { code }).error, ERR.BAD_MSG);
  assert.equal(legacy.roomCode, null);
  legacy.matchmakingVersion = MATCHMAKING_VERSION;
  assert.deepEqual(h.lobby.join(legacy, { code }), { ok: true });
});

test('queue acceptance requires an explicit boolean vote and locks it against replay changes', (t) => {
  const h = harness(t), players = h.group(), offers = h.offer(players);
  const intent = { ticketId: offers[0].ticketId, offerId: offers[0].offerId };
  for (const revivalVote of [undefined, null, 0, 1, '', 'false', {}, []]) {
    const msg = { ...intent, ...(revivalVote === undefined ? {} : { revivalVote }) };
    assert.equal(h.lobby.queue.accept(players[0], msg).error, ERR.BAD_MSG);
    assert.ok(validateC2S({ t: 'queue.accept', ...msg }));
    assert.equal(h.lobby.queue.state(players[0]).accepted, false);
    assert.equal(h.lobby.queue.state(players[0]).revivalVote, null);
  }
  for (const revivalVote of [true, false]) assert.equal(validateC2S({ t: 'queue.accept', ...intent, revivalVote }), null);
  assert.deepEqual(h.lobby.queue.accept(players[0], { ...intent, revivalVote: false }), { ok: true });
  assert.equal(h.lobby.queue.state(players[0]).revivalVote, false);
  assert.equal(h.lobby.queue.accept(players[0], { ...intent, revivalVote: true }).error, ERR.BAD_MSG);
  assert.equal(h.lobby.queue.state(players[0]).acceptedCount, 1);
  h.accept(players.slice(1), offers.slice(1));
  const room = h.lobby.roomOf(players[0]), match = room.match;
  assert.equal(h.lobby.queue.accept(players[0], intent).error, ERR.BAD_MSG);
  assert.equal(h.lobby.queue.accept(players[0], { ...intent, revivalVote: true }).error, ERR.BAD_MSG);
  assert.deepEqual(h.lobby.queue.accept(players[0], { ...intent, revivalVote: false }), { ok: true });
  assert.equal(room.match, match);
  assert.equal(room.matchCount, 1);
  assert.equal(h.lobby.queue.state(players[0]).revivalVote, false);
});

test('all sixteen public vote combinations enable revival iff at least three humans voted yes', (t) => {
  const h = harness(t);
  for (let mask = 0; mask < 16; mask++) {
    const players = h.group(), offers = h.offer(players, DIFFICULTIES[mask % DIFFICULTIES.length]);
    const votes = players.map((_, i) => !!(mask & (1 << i)));
    offers.forEach((offer, i) => { offer.revivalVote = votes[i]; });
    assert.ok(h.accept(players, offers).every((result) => result.ok));
    const room = h.lobby.roomOf(players[0]), yes = votes.filter(Boolean).length;
    assert.deepEqual(room.revivalState(), { yes, required: 3, enabled: yes >= 3 });
    assert.equal(room.match.opts.revivalEnabled, yes >= 3);
    assert.equal(room.match.opts.difficulty, offers[0].difficulty);
    assert.deepEqual(room.seats.map((seat) => seat.revivalVote), votes);
    assert.equal(h.lobby.voteRevival(players[0], { enable: !votes[0] }).error, ERR.ROOM_STARTED);
    h.lobby.leave(players[0]);
    assert.deepEqual(room.revivalState(), { yes, required: 3, enabled: yes >= 3 });
    for (const p of players.slice(1)) h.lobby.leave(p);
  }
  assert.equal(h.lobby.rooms.size, 0);
});

test('friend coop still needs manual readiness/start and uses only room votes', (t) => {
  const h = harness(t), players = h.group(), room = h.privateRoom(players);
  assert.equal(room.source, 'private');
  assert.ok(room.seats.every((s) => !s.ready && s.revivalVote === null));
  for (const p of players.slice(0, 3)) h.lobby.voteRevival(p, { enable: true });
  assert.equal(room.match, null);
  assert.equal(h.lobby.start(players[0]).error, ERR.NOT_READY);
  for (const p of players.slice(1)) h.lobby.ready(p, { ready: true });
  assert.equal(room.match, null);
  assert.deepEqual(h.lobby.start(players[0]), { ok: true });
  assert.equal(room.match.opts.revivalEnabled, true);
});

test('cancel/replacement requires all four fresh votes while preserving survivors FIFO and TTL', (t) => {
  const h = harness(t), players = h.group(), offers = h.offer(players);
  for (let i = 1; i < 4; i++) h.lobby.queue.accept(players[i], { ...offers[i], revivalVote: true });
  const old = players.slice(1).map((p) => ({ ...h.lobby.queue.entries.get(p.playerId) }));
  h.advance(50);
  h.lobby.queue.cancel(players[0], offers[0]);
  const replacement = h.player();
  h.lobby.queue.join(replacement, { difficulty: 'NORMAL' });
  const cohort = [...players.slice(1), replacement];
  const next = cohort.map((p) => ({ ...h.lobby.queue.state(p), revivalVote: false }));
  assert.notEqual(next[0].offerId, offers[0].offerId);
  old.forEach((entry, i) => {
    const current = h.lobby.queue.entries.get(cohort[i].playerId);
    assert.equal(current.ticketId, entry.ticketId);
    assert.equal(current.sequence, entry.sequence);
    assert.equal(current.expiresAt, entry.expiresAt);
    assert.equal(current.joinedAt, entry.joinedAt);
    assert.equal(current.revivalVote, null);
    assert.equal(current.accepted, false);
  });
  assert.equal(h.lobby.queue.accept(players[3], { ...offers[3], revivalVote: true }).error, ERR.BAD_TARGET);
  for (const p of players.slice(1)) assert.equal(h.lobby.queue.state(p).acceptedCount, 0);
  assert.ok(h.accept(cohort, next).every((r) => r.ok));
  assert.equal(h.lobby.roomOf(replacement).match.opts.revivalEnabled, false);
  assert.ok(cohort.every((p) => p.roomCode === replacement.roomCode));
  assert.equal(players[0].roomCode, null);
});

test('default queue still waits for four humans, uses thirty-second acceptance and ten-minute FIFO TTL', (t) => {
  assert.equal(MATCHMAKING_DEFAULTS.acceptMs, 30_000);
  assert.equal(MATCHMAKING_DEFAULTS.waitMs, 600_000);
  const h = harness(t), players = h.group();
  for (const p of players.slice(0, 3)) h.lobby.queue.join(p, { difficulty: 'HARD' });
  assert.equal(h.lobby.rooms.size, 0);
  assert.equal(h.lobby.queue.offers.size, 0);
  assert.ok(players.slice(0, 3).every((p) => h.lobby.queue.state(p).deadline === 610_000));
  h.advance(599_999);
  h.lobby.queue.join(players[3], { difficulty: 'HARD' });
  assert.equal(h.lobby.queue.state(players[0]).deadline, 610_000, 'offer does not renew original ticket TTL');
  const offer = h.lobby.queue.state(players[3]);
  h.lobby.queue.accept(players[3], { ...offer, revivalVote: true });
  const expired = h.lobby.queue.state(players[0]);
  h.advance(1);
  assert.equal(h.lobby.queue.accept(players[0], { ...expired, revivalVote: true }).error, ERR.BAD_TARGET);
  assert.equal(h.lobby.rooms.size, 0);
  assert.equal(h.lobby.queue.size, 1);
});

test('shutdown clears offers and rejects new admissions without rolling state', (t) => {
  const h = harness(t), players = h.group(), offers = h.offer(players);
  h.lobby.queue.close();
  assert.equal(h.lobby.queue.size, 0);
  assert.equal(h.lobby.queue.offers.size, 0);
  assert.equal(h.lobby.queue.timer, null);
  assert.equal(h.lobby.queue.join(players[0], { difficulty: 'NORMAL' }).error, ERR.WRONG_PHASE);
  assert.equal(h.lobby.queue.accept(players[0], offers[0]).error, ERR.WRONG_PHASE);
  assert.equal(players[0].messages.at(-1).reason, 'shutdown');
});

test('waiting coop uses strict human majority for one/two/three/four humans and never counts bots', (t) => {
  const h = harness(t);
  for (let size = 1; size <= 4; size++) {
    const players = h.group().slice(0, size), room = h.privateRoom(players);
    const required = Math.max(2, Math.floor(size / 2) + 1);
    assert.equal(room.revivalState().required, required);
    for (let yes = 1; yes <= size; yes++) {
      h.lobby.voteRevival(players[yes - 1], { enable: true });
      assert.deepEqual(room.revivalState(), { yes, required, enabled: size >= 2 && yes >= required });
    }
    if (size < 4) {
      h.lobby.addBot(players[0]);
      room.seats.find((s) => s?.isBot).revivalVote = true;
      assert.equal(room.revivalState().required, required);
      assert.equal(room.revivalState().yes, size);
      assert.equal(room.revivalState().enabled, size >= 2);
    }
    for (const p of players.slice(1)) h.lobby.ready(p, { ready: true });
    h.lobby.start(players[0]);
    assert.equal(room.match.opts.revivalEnabled, size >= 2);
  }
});

for (const sizes of [[2, 2], [3, 1], [2, 1, 1], [4]]) test(`indivisible parties ${sizes.join('+')} merge/start atomically and retire old rooms without closing new game`, (t) => {
  const h = harness(t, { maxRooms: sizes.length, maxRoomsPerAddr: 1 }), players = [], rooms = [], intents = [];
  for (let group = 0; group < sizes.length; group++) {
    const members = Array.from({ length: sizes[group] }, (_, i) => h.player(`组${group}人${i}`, `net${group}`));
    const room = h.privateRoom(members); rooms.push(room); players.push(...members);
    // Old room votes are not a substitute for the new queue vote.
    for (const p of members) h.lobby.voteRevival(p, { enable: true });
    assert.deepEqual(h.lobby.queue.join(members[0], { difficulty: 'NORMAL', party: true }), { ok: true });
    const partyStates = members.map((p) => h.lobby.queue.state(p));
    assert.ok(partyStates.every((state) => state.partySize === members.length && state.partyRoomCode === room.code && state.partyLeaderId === members[0].playerId));
    assert.equal(new Set(partyStates.map((state) => state.partyId)).size, 1);
    assert.equal(new Set(partyStates.map((state) => state.ticketId)).size, members.length);
  }
  for (const p of players) { p.messages.length = 0; intents.push({ ...h.lobby.queue.state(p), revivalVote: false }); }
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(h.lobby.queue.accept(players[i], intents[i]), { ok: true });
    assert.ok(rooms.every((room) => !room.disposed && !room.match && h.lobby.rooms.get(room.code) === room));
  }
  assert.deepEqual(h.lobby.queue.accept(players[3], intents[3]), { ok: true });
  const room = h.lobby.roomOf(players[0]);
  assert.equal(h.lobby.rooms.size, 1);
  assert.equal(room.source, 'matchmaking');
  assert.equal(room.ownerKeys.size, sizes.length);
  assert.equal(room.matchKeys.size, sizes.length);
  assert.equal(room.match.opts.revivalEnabled, false);
  assert.equal(h.lobby.queue.parties.size, 0);
  for (const old of rooms) { assert.equal(old.disposed, true); assert.equal(h.lobby.getRoom(old.code), null); }
  for (const p of players) {
    assert.equal(p.roomCode, room.code);
    assert.equal(p.messages.some((m) => m.t === 'room.closed'), false);
    const at = p.messages.findIndex((m) => m.t === 'room.state');
    assert.deepEqual(p.messages.slice(at).map((m) => m.t), ['room.state', 'm.public', 'm.private', 'queue.state']);
    assert.equal(p.messages[at].inMatch, true);
  }
});

test('party admission is host-only, compatible online humans only, and queue/network caps apply atomically', (t) => {
  const h = harness(t, { matchmaking: { maxEntries: 4, maxPerAddr: 2 } });
  const players = h.group(['A', 'A', 'A', 'A']), room = h.privateRoom(players.slice(0, 3));
  assert.equal(h.lobby.queue.join(players[1], { difficulty: 'NORMAL', party: true }).error, ERR.NOT_HOST);
  assert.equal(h.lobby.queue.join(players[0], { difficulty: 'HARD', party: true }).error, ERR.BAD_MSG);
  players[1].matchmakingVersion = 'alliance-1';
  assert.equal(h.lobby.queue.join(players[0], { difficulty: 'NORMAL', party: true }).error, ERR.BAD_MSG);
  players[1].matchmakingVersion = MATCHMAKING_VERSION;
  h.disconnect(players[1]);
  assert.equal(h.lobby.queue.join(players[0], { difficulty: 'NORMAL', party: true }).error, ERR.NOT_READY);
  players[1].connected = true; players[1].ws.readyState = 1;
  h.lobby.onHello(players[1], { resumed: true, repeat: false });
  h.lobby.addBot(players[0]);
  assert.equal(h.lobby.queue.join(players[0], { difficulty: 'NORMAL', party: true }).error, ERR.BAD_MSG);
  h.lobby.removeBot(players[0], { seat: room.seats.find((s) => s?.isBot).seat });
  assert.equal(h.lobby.queue.join(players[0], { difficulty: 'NORMAL', party: true }).error, ERR.RATE);
  assert.equal(h.lobby.queue.size, 0);
  h.lobby.leave(players[2]);
  assert.deepEqual(h.lobby.queue.join(players[0], { difficulty: 'NORMAL', party: true }), { ok: true });
  assert.equal(h.lobby.queue.size, 2);
  const others = [h.player('外组1', 'B'), h.player('外组2', 'C'), h.player('外组3', 'D')];
  h.privateRoom(others);
  assert.equal(h.lobby.queue.join(others[0], { difficulty: 'NORMAL', party: true }).error, ERR.RATE);
  assert.equal(h.lobby.queue.size, 2);
  assert.ok(others.every((p) => !h.lobby.queue.has(p)));
  assert.ok(validateC2S({ t: 'queue.join', difficulty: 'NORMAL', party: 'true' }));
  assert.equal(validateC2S({ t: 'queue.join', difficulty: 'NORMAL', party: true }), null);
});

test('party queue locks room mutations but permits loadout sync and leave cancels whole party before departure', (t) => {
  const h = harness(t), members = h.group().slice(0, 2), room = h.privateRoom(members), outsider = h.player();
  h.lobby.queue.join(members[0], { difficulty: 'NORMAL', party: true });
  for (const msg of [
    { t: 'room.ready', ready: true }, { t: 'room.voteRevival', enable: true }, { t: 'room.setDifficulty', difficulty: 'HARD' },
    { t: 'room.start' }, { t: 'room.addBot' }, { t: 'room.removeBot', seat: 2 },
    { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' },
  ]) assert.equal(h.lobby.onMessage(members[0], msg).error, ERR.QUEUED, msg.t);
  assert.equal(h.lobby.join(outsider, { code: room.code }).error, ERR.QUEUED);
  assert.deepEqual(h.lobby.loadout(members[1], { entries: {} }), { ok: true });
  assert.ok(Object.isFrozen(room.seatOf(members[1].playerId).loadout));
  assert.deepEqual(h.lobby.leave(members[1]), { ok: true });
  assert.equal(h.lobby.queue.size, 0);
  assert.equal(h.lobby.queue.parties.size, 0);
  assert.equal(members[1].roomCode, null);
  assert.equal(members[0].roomCode, room.code);
  assert.equal(room.disposed, false);
  assert.equal(h.lobby.queue.state(members[0]).state, 'idle');
  assert.deepEqual(h.lobby.join(outsider, { code: room.code }), { ok: true });
});

for (const reason of ['cancelled', 'disconnected']) test(`party ${reason} removes whole unit, never splits peers, and preserves other party FIFO`, (t) => {
  const h = harness(t), a = h.group().slice(0, 2), b = h.group().slice(0, 2);
  const ra = h.privateRoom(a), rb = h.privateRoom(b);
  h.lobby.queue.join(a[0], { difficulty: 'NORMAL', party: true });
  h.advance(10);
  h.lobby.queue.join(b[0], { difficulty: 'NORMAL', party: true });
  const old = b.map((p) => ({ ...h.lobby.queue.entries.get(p.playerId) }));
  for (const p of [a[0], ...b]) h.lobby.queue.accept(p, { ...h.lobby.queue.state(p), revivalVote: true });
  const oldOffer = { ...h.lobby.queue.state(b[1]), revivalVote: true };
  if (reason === 'cancelled') h.lobby.queue.cancel(a[1], h.lobby.queue.state(a[1])); else h.disconnect(a[1]);
  assert.equal(h.lobby.queue.size, 2);
  assert.ok(a.every((p) => !h.lobby.queue.has(p) && p.roomCode === ra.code));
  assert.ok(b.every((p) => p.roomCode === rb.code && h.lobby.queue.state(p).state === 'queued'));
  old.forEach((entry, i) => {
    const current = h.lobby.queue.entries.get(b[i].playerId);
    assert.equal(current.ticketId, entry.ticketId); assert.equal(current.sequence, entry.sequence);
    assert.equal(current.expiresAt, entry.expiresAt); assert.equal(current.accepted, false); assert.equal(current.revivalVote, null);
  });
  assert.equal(h.lobby.queue.accept(b[1], oldOffer).error, ERR.BAD_TARGET);
  assert.equal(h.lobby.rooms.size, 2);
});

test('party timeout removes an incomplete party together but keeps fully accepted parties original TTL', (t) => {
  const h = harness(t, { matchmaking: { acceptMs: 100, waitMs: 500 } }), a = h.group().slice(0, 2), b = h.group().slice(0, 2);
  h.privateRoom(a); h.privateRoom(b);
  h.lobby.queue.join(a[0], { difficulty: 'NORMAL', party: true });
  h.lobby.queue.join(b[0], { difficulty: 'NORMAL', party: true });
  for (const p of [a[0], ...b]) h.lobby.queue.accept(p, { ...h.lobby.queue.state(p), revivalVote: true });
  h.advance(100); h.lobby.queue.sweep();
  assert.equal(h.lobby.queue.size, 2);
  assert.ok(a.every((p) => !h.lobby.queue.has(p) && h.lobby.roomOf(p)));
  assert.ok(b.every((p) => h.lobby.queue.state(p).state === 'queued' && h.lobby.queue.state(p).deadline === 10_500));
  h.advance(400); h.lobby.queue.sweep();
  assert.equal(h.lobby.queue.size, 0);
  assert.equal(h.lobby.rooms.size, 2);
});

test('unit FIFO takes earliest exact fit, never splits parties, and an unfillable old party does not starve later fits', (t) => {
  const h = harness(t), units = [];
  for (const size of [3, 2, 2]) {
    const players = h.group().slice(0, size); h.privateRoom(players); units.push(players);
    h.lobby.queue.join(players[0], { difficulty: 'NORMAL', party: true }); h.advance(1);
  }
  assert.equal(h.lobby.queue.state(units[0][0]).state, 'queued');
  const paired = h.lobby.queue.state(units[1][0]).offerId;
  assert.ok(paired);
  assert.equal(h.lobby.queue.state(units[2][0]).offerId, paired);
  const solo = h.player(); h.lobby.queue.join(solo, { difficulty: 'NORMAL' });
  assert.equal(h.lobby.queue.state(solo).offerId, h.lobby.queue.state(units[0][0]).offerId);
  assert.notEqual(h.lobby.queue.state(solo).offerId, paired);
  const entries = [...h.lobby.queue.offers.values()].flatMap((offer) => offer.entries);
  assert.equal(entries.length, 8);
  assert.equal(new Set(entries).size, 8);
});

test('party startup failure buffers every frame and preserves original rooms, tickets and unrelated offers', (t) => {
  let broken = true;
  const disposed = [];
  class BrokenMatch extends RecordingMatch {
    start() {
      super.start();
      this.opts.sendEncoded(this.opts.seats[0].playerId, 'm.field', JSON.stringify({ t: 'm.field', initial: true }));
      if (broken) throw new Error('injected startup failure');
    }
    dispose() { disposed.push(this); this.opts.broadcast({ t: 'm.public', phase: 'RESULT' }); }
  }
  const h = harness(t, {}, BrokenMatch), party = h.group().slice(0, 2), solo = h.group().slice(0, 2);
  const oldRoom = h.privateRoom(party);
  h.lobby.voteRevival(party[0], { enable: true });
  h.lobby.ready(party[1], { ready: true });
  h.lobby.queue.join(party[0], { difficulty: 'NORMAL', party: true });
  for (const p of solo) h.lobby.queue.join(p, { difficulty: 'NORMAL' });
  const others = h.group(), otherOffers = h.offer(others, 'HARD');
  h.lobby.queue.accept(others[0], { ...otherOffers[0], revivalVote: true });
  const waiting = h.player(); h.lobby.queue.join(waiting, { difficulty: 'ABYSS' });
  const waitingBefore = h.lobby.queue.state(waiting);
  const players = [...party, ...solo], original = players.map((p) => ({ ...h.lobby.queue.entries.get(p.playerId) }));
  const intents = players.map((p) => ({ ...h.lobby.queue.state(p), revivalVote: true }));
  for (const p of players) { p.notice = 'retained'; p.pendingResult = ['old-result']; p.messages.length = 0; }
  assert.equal(h.accept(players, intents)[3].error, ERR.INTERNAL);
  assert.equal(h.lobby.rooms.size, 1);
  assert.equal(oldRoom.disposed, false);
  assert.equal(oldRoom.match, null);
  assert.equal(oldRoom.seatOf(party[1].playerId).ready, true);
  assert.equal(oldRoom.seatOf(party[0].playerId).revivalVote, true);
  assert.equal(disposed.length, 1);
  assert.equal(disposed[0].opts.send(party[0].playerId, { t: 'm.private' }), false);
  players.forEach((p, i) => {
    assert.equal(p.roomCode, i < 2 ? oldRoom.code : null);
    assert.equal(p.notice, 'retained'); assert.deepEqual(p.pendingResult, ['old-result']);
    const e = h.lobby.queue.entries.get(p.playerId);
    assert.equal(e.ticketId, original[i].ticketId); assert.equal(e.sequence, original[i].sequence); assert.equal(e.expiresAt, original[i].expiresAt);
    assert.equal(h.lobby.queue.state(p).state, 'queued'); assert.equal(e.revivalVote, null); assert.equal(e.accepted, false);
    assert.equal(p.messages.some((m) => m.t === 'room.state' || m.t.startsWith('m.') || m.t === 'room.closed'), false);
  });
  assert.equal(h.lobby.queue.state(others[0]).offerId, otherOffers[0].offerId);
  assert.equal(h.lobby.queue.state(others[0]).accepted, true);
  assert.equal(h.lobby.queue.state(others[0]).revivalVote, true);
  assert.deepEqual(h.lobby.queue.state(waiting), waitingBefore);
  assert.equal(h.lobby.queue.accept(players[3], intents[3]).error, ERR.BAD_TARGET);
  broken = false;
  assert.deepEqual(h.lobby.queue.join(party[0], { difficulty: 'NORMAL', party: true }), { ok: true });
  const retry = players.map((p) => ({ ...h.lobby.queue.state(p), revivalVote: false }));
  assert.notEqual(retry[0].offerId, intents[0].offerId);
  assert.ok(h.accept(players, retry).every((r) => r.ok));
  assert.equal(oldRoom.disposed, true);
  assert.equal(h.lobby.roomOf(party[0]).match.opts.revivalEnabled, false);
  assert.ok(players.every((p) => p.notice === null && p.pendingResult === null));
  assert.equal(h.lobby.queue.state(others[0]).accepted, true);
});

for (const fault of ['constructor', 'ended', 'promise', 'room-code']) test(`public ${fault} allocation failure cannot create a ghost room or lose a party`, async (t) => {
  let disposed = 0;
  class FaultMatch extends RecordingMatch {
    constructor(opts) { super(opts); if (fault === 'constructor') throw new Error('constructor failed'); }
    start() {
      super.start();
      if (fault === 'ended') this.opts.onEnd({ reason: 'error' });
      if (fault === 'promise') return Promise.reject(new Error('async start rejected'));
    }
    dispose() { disposed++; }
  }
  const h = harness(t, {}, FaultMatch), players = h.group(), oldRoom = h.privateRoom(players);
  h.lobby.queue.join(players[0], { difficulty: 'NORMAL', party: true });
  if (fault === 'room-code') h.lobby.genCode = () => null;
  const intents = players.map((p) => ({ ...h.lobby.queue.state(p), revivalVote: true }));
  for (const p of players) p.messages.length = 0;
  assert.equal(h.accept(players, intents)[3].error, ERR.INTERNAL);
  await Promise.resolve(); // rejected async contracts are handled, not unhandled rejections
  assert.equal(h.lobby.rooms.size, 1);
  assert.equal(h.lobby.getRoom(oldRoom.code), oldRoom);
  assert.equal(oldRoom.match, null); assert.equal(oldRoom.disposed, false);
  assert.ok(players.every((p) => p.roomCode === oldRoom.code && h.lobby.queue.state(p).state === 'queued'));
  assert.ok(players.every((p) => !p.messages.some((m) => m.t === 'room.state' || m.t.startsWith('m.') || m.t === 'room.closed')));
  assert.equal(h.lobby.queue.offers.size, 0);
  assert.equal(disposed, fault === 'ended' || fault === 'promise' ? 1 : 0);
});

test('party quota transfer credits only consumed rooms and keeps unrelated network limits enforced', (t) => {
  const h = harness(t, { maxRooms: 3, maxRoomsPerAddr: 1, maxMatchesPerAddr: 1 });
  const players = h.group(['A', 'B', 'C', 'D']), a = h.privateRoom(players.slice(0, 2)), b = h.privateRoom(players.slice(2));
  h.lobby.queue.join(players[0], { difficulty: 'NORMAL', party: true });
  h.lobby.queue.join(players[2], { difficulty: 'NORMAL', party: true });
  const unrelated = h.player('独立占位', 'B');
  h.lobby.create(unrelated, { mode: 'solo', difficulty: 'NORMAL' });
  const room = h.lobby.roomOf(unrelated);
  const intents = players.map((p) => ({ ...h.lobby.queue.state(p), revivalVote: true }));
  assert.equal(h.accept(players, intents)[3].error, ERR.RATE);
  assert.equal(h.lobby.rooms.size, 3);
  assert.equal(h.lobby.getRoom(room.code), room);
  assert.ok(players.every((p, i) => p.roomCode === (i < 2 ? a.code : b.code)));
  assert.equal(h.lobby.queue.size, 4);
  h.lobby.leave(unrelated);
  h.lobby.queue.join(players[0], { difficulty: 'NORMAL', party: true });
  const retry = players.map((p) => ({ ...h.lobby.queue.state(p), revivalVote: true }));
  assert.ok(h.accept(players, retry).every((r) => r.ok));
  const matchRoom = h.lobby.roomOf(players[0]);
  assert.equal(h.lobby.rooms.size, 1);
  assert.deepEqual([...matchRoom.ownerKeys].sort(), ['A', 'B', 'C', 'D']);
  assert.deepEqual([...matchRoom.matchKeys].sort(), ['A', 'B', 'C', 'D']);
  assert.equal(h.lobby.create(unrelated, { mode: 'solo', difficulty: 'NORMAL' }).error, ERR.RATE);
  h.lobby.leave(players[0]);
  assert.equal(matchRoom.hostId, players[1].playerId);
  assert.equal(h.lobby.create(unrelated, { mode: 'solo', difficulty: 'NORMAL' }).error, ERR.RATE);
});

test('fourth acceptance winning a cancel/disconnect race retains exactly one running match and its locked votes', (t) => {
  const h = harness(t), players = h.group(), room = h.privateRoom(players);
  h.lobby.queue.join(players[0], { difficulty: 'NORMAL', party: true });
  const offers = players.map((p) => ({ ...h.lobby.queue.state(p), revivalVote: true }));
  assert.ok(h.accept(players, offers).every((r) => r.ok));
  const current = h.lobby.roomOf(players[0]), match = current.match;
  h.lobby.queue.cancel(players[0], offers[0]);
  h.disconnect(players[3]);
  assert.equal(h.lobby.rooms.size, 1); assert.equal(room.disposed, true);
  assert.equal(current.match, match); assert.equal(current.matchCount, 1);
  assert.deepEqual(current.revivalState(), { yes: 4, required: 3, enabled: true });
  assert.equal(h.lobby.queue.size, 0);
  assert.equal(h.lobby.queue.state(players[0]).state, 'matched');
});

test('real four-socket party replacement uses default Match, latest checked loadouts, isolated private states and no late room close', async (t) => {
  const errors = [];
  const srv = await startServer({ port: 0, host: '127.0.0.1', seedFn: () => 4242,
    log: { info() {}, warn() {}, debug() {}, error: (...args) => errors.push(args.map(String).join(' ')) } });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map((c) => c.terminate())); await srv.close(); });
  const connect = async (name, token) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`); clients.push(c);
    const w = await c.hello(name, token, { matchmakingVersion: MATCHMAKING_VERSION });
    c.id = w.playerId; c.token = w.token;
    return c;
  };
  let group = await Promise.all(Array.from({ length: 4 }, (_, i) => connect(`实机${i}`)));
  const INSIDE = 'chess_char_1_01_a';
  for (let i = 0; i < 4; i++) assert.equal((await group[i].request({ t: 'room.loadout', entries: i ? {} : { [INSIDE]: { skill: 0 } } })).t, 'ok');
  const codes = [];
  for (const at of [0, 2]) {
    assert.equal((await group[at].request({ t: 'room.create', mode: 'coop', difficulty: 'HARD' })).t, 'ok');
    const room = await group[at].waitFor('room.state', (m) => m.hostId === group[at].id); codes.push(room.code);
    assert.equal((await group[at + 1].request({ t: 'room.join', code: room.code })).t, 'ok');
    assert.equal((await group[at].request({ t: 'queue.join', difficulty: 'HARD', party: true })).t, 'ok');
  }
  const offers = await Promise.all(group.map((c) => c.waitFor('queue.state', (m) => m.state === 'offered')));
  assert.equal((await group[0].request({ t: 'queue.accept', ticketId: offers[0].ticketId, offerId: offers[0].offerId, revivalVote: true })).t, 'ok');
  const replaced = group[0], replacement = await connect('实机0', replaced.token);
  await replaced.closed; assert.equal(replaced.closeInfo.code, 4001); assert.equal(replacement.id, replaced.id);
  const restored = await replacement.waitFor('queue.state', (m) => m.state === 'offered');
  assert.equal(restored.accepted, true); assert.equal(restored.revivalVote, true); assert.equal(restored.offerId, offers[0].offerId);
  group = [replacement, ...group.slice(1)];
  assert.equal((await replacement.request({ t: 'room.loadout', entries: { [INSIDE]: { skill: 0, module: 'none' } } })).t, 'ok');
  for (let i = 1; i < 4; i++) assert.equal((await group[i].request({
    t: 'queue.accept', ticketId: offers[i].ticketId, offerId: offers[i].offerId, revivalVote: i < 3,
  })).t, 'ok');
  const roomStates = await Promise.all(group.map((c) => c.waitFor('room.state', (m) => m.source === 'matchmaking')));
  const matchRoom = srv.lobby.getRoom(roomStates[0].code), match = matchRoom.match;
  assert.ok(match);
  assert.ok(codes.every((code) => srv.lobby.getRoom(code) === null));
  assert.equal(match.phase, 'INFO_CHECK'); assert.equal(match.order.length, 4); assert.equal(match.revivalEnabled, true);
  assert.equal(match.modeId, 'mode_multi_hard'); assert.ok(match.order.every((ps) => !ps.isBot && ps.connected && !ps.infoReady));
  for (const c of group) {
    const priv = await c.waitFor('m.private');
    const pub = await c.waitFor('m.public', (m) => m.phase === 'INFO_CHECK');
    await c.waitFor('queue.state', (m) => m.state === 'matched');
    assert.equal(priv.playerId, c.id); assert.equal(pub.modeId, 'mode_multi_hard'); assert.equal(pub.players.length, 4);
    assert.equal(pub.revival.enabled, true);
    if (c === replacement) assert.deepEqual(priv.loadout, { [INSIDE]: { skill: 0, module: 'none' } });
    else assert.deepEqual(priv.loadout, {});
    assert.ok(c.log.filter((m) => m.t === 'm.private').every((m) => m.playerId === c.id));
    const at = c.log.findIndex((m) => m.t === 'room.state' && m.source === 'matchmaking');
    assert.deepEqual(c.log.slice(at, at + 4).map((m) => m.t), ['room.state', 'm.private', 'm.public', 'queue.state']);
    assert.equal(c.log.some((m) => m.t === 'room.closed'), false);
  }
  // The game's own info/draft flow is intentionally not skipped by room-level auto-start.
  for (const c of group) assert.equal((await c.request({ t: 'g.infoReady' })).t, 'ok');
  await group[0].waitFor('m.public', (m) => m.phase === 'BAND_DRAFT');
  const resumed = await connect('实机2', group[2].token);
  await group[2].closed;
  const restoredRoom = await resumed.waitFor('room.state', (m) => m.inMatch);
  assert.equal(restoredRoom.code, matchRoom.code); assert.equal(resumed.id, group[2].id);
  await resumed.waitFor('m.public', (m) => m.phase === 'BAND_DRAFT');
  assert.equal((await resumed.waitFor('m.private')).playerId, resumed.id);
  assert.equal(matchRoom.match, match); assert.equal(srv.lobby.queue.size, 0);
  assert.deepEqual(errors, []);
});

test('seeded 140-cohort party fuzz preserves identities, quotas, FIFO and atomic starts across seven race schedules', (t) => {
  let seed = 0x61a110ce, failNext = false, successes = 0, failures = 0, h;
  const rand = (max) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % max; };
  class CheckedMatch extends RecordingMatch {
    constructor(opts) {
      super(opts);
      assert.equal(opts.seats.length, 4);
      assert.equal(new Set(opts.seats.map((s) => s.playerId)).size, 4);
      const entries = opts.seats.map((seat) => h.lobby.queue.entries.get(seat.playerId));
      assert.ok(entries.every((e) => e.accepted && typeof e.revivalVote === 'boolean' && e.expiresAt > h.lobby.now()));
      assert.equal(new Set(entries.map((e) => e.offerId)).size, 1);
      assert.ok(entries.every((e) => e.difficulty === opts.difficulty && h.lobby.matchmakingAvailable(e.session, e)));
      assert.equal(opts.revivalEnabled, entries.filter((e) => e.revivalVote).length >= 3);
      for (const e of entries) assert.ok(e.party.entries.every((peer) => entries.includes(peer)), 'no split party at constructor');
    }
    start() { super.start(); if (failNext) { failures++; throw new Error('seeded start fault'); } successes++; }
  }
  h = harness(t, { maxRooms: 20, maxRoomsPerAddr: 4, maxMatchesPerAddr: 3, matchmaking: { acceptMs: 50, waitMs: 1000 } }, CheckedMatch);
  const invariant = () => {
    const { queue } = h.lobby;
    assert.equal(queue.size, [...queue.parties.values()].reduce((n, party) => n + party.entries.length, 0));
    for (const party of queue.parties.values()) {
      assert.ok(party.entries.length >= 1 && party.entries.length <= 4);
      assert.equal(new Set(party.entries.map((e) => e.offerId)).size, 1);
      assert.equal(new Set(party.entries.map((e) => e.sequence)).size, 1);
      for (const e of party.entries) {
        assert.equal(queue.entries.get(e.session.playerId), e);
        assert.equal(e.accepted, typeof e.revivalVote === 'boolean');
        assert.equal(e.session.roomCode, party.roomCode);
      }
    }
    for (const offer of queue.offers.values()) {
      assert.equal(offer.entries.length, 4); assert.equal(new Set(offer.entries).size, 4);
      assert.equal(new Set(offer.entries.map((e) => e.difficulty)).size, 1);
      assert.ok(offer.entries.every((e) => e.offerId === offer.id && queue.entries.get(e.session.playerId) === e));
      assert.ok(offer.entries.every((e) => e.party.entries.every((peer) => offer.entries.includes(peer))));
      assert.ok(offer.entries.every((e) => offer.deadline <= e.expiresAt));
    }
    for (const room of h.lobby.rooms.values()) {
      assert.equal(room.disposed, false);
      assert.equal(h.lobby.countRooms((r) => h.lobby.roomCharges(r, room.ownerKey)), room.ownerKey ? 1 : 0);
      if (!room.match) continue;
      assert.equal(room.source, 'matchmaking'); assert.equal(room.seats.length, 4);
      assert.ok(room.seats.every((s) => !s.isBot));
      assert.equal(room.matchCount, 1);
      for (const seat of room.activeHumans()) assert.equal(h.registry.byId(seat.playerId).roomCode, room.code);
    }
  };
  for (let iteration = 0; iteration < 140; iteration++) {
    const sizes = [[3, 1], [2, 2], [2, 1, 1], [4], [1, 1, 1, 1], [3, 2, 2, 1]][rand(6)];
    const players = [], originalRooms = [];
    for (let unit = 0; unit < sizes.length; unit++) {
      const members = Array.from({ length: sizes[unit] }, (_, i) => h.player(`测${unit}人${i}`, `f${iteration}-${unit}`));
      players.push(...members);
      if (sizes[unit] > 1 || rand(2)) {
        originalRooms.push(h.privateRoom(members));
        assert.deepEqual(h.lobby.queue.join(members[0], { difficulty: 'NORMAL', party: true }), { ok: true });
      } else assert.deepEqual(h.lobby.queue.join(members[0], { difficulty: 'NORMAL' }), { ok: true });
      invariant();
    }
    const other = h.player('无关队列', `other${iteration}`);
    h.lobby.queue.join(other, { difficulty: 'ABYSS' });
    const otherBefore = h.lobby.queue.state(other);
    const offer = [...h.lobby.queue.offers.values()].find((o) => o.entries[0].difficulty === 'NORMAL');
    assert.ok(offer);
    const members = offer.entries.map((e) => e.session);
    for (let i = members.length - 1; i > 0; i--) { const j = rand(i + 1); [members[i], members[j]] = [members[j], members[i]]; }
    const intents = members.map((p) => ({ ...h.lobby.queue.state(p), revivalVote: !!rand(2) }));
    const before = offer.entries.map((e) => ({ e, ticket: e.ticketId, ttl: e.expiresAt, sequence: e.sequence }));
    for (let i = 0; i < 3; i++) { assert.deepEqual(h.lobby.queue.accept(members[i], intents[i]), { ok: true }); invariant(); }
    switch (iteration % 7) {
      case 0:
        h.lobby.queue.cancel(members[rand(3)], intents[members.indexOf(members[0])]); // stale tickets cannot cancel another member
        h.lobby.queue.cancel(members[0], intents[0]);
        assert.equal(h.lobby.queue.accept(members[3], intents[3]).error, ERR.BAD_TARGET);
        break;
      case 1:
        h.disconnect(members[0]);
        assert.equal(h.lobby.queue.accept(members[3], intents[3]).error, ERR.BAD_TARGET);
        break;
      case 2: {
        const p = members[0], oldSocket = p.ws;
        p.ws = { readyState: 1, bufferedAmount: 0, send: (data, cb) => { p.messages.push(JSON.parse(data)); cb?.(); } };
        oldSocket.readyState = 3;
        h.lobby.onDisconnect(p); h.lobby.onHello(p, { resumed: true, repeat: false });
        assert.equal(h.lobby.queue.state(p).accepted, true); assert.equal(h.lobby.queue.state(p).revivalVote, intents[0].revivalVote);
        assert.deepEqual(h.lobby.queue.accept(members[3], intents[3]), { ok: true });
        break;
      }
      case 3:
        failNext = true;
        assert.equal(h.lobby.queue.accept(members[3], intents[3]).error, ERR.INTERNAL);
        failNext = false;
        for (const old of before) {
          assert.equal(h.lobby.queue.entries.get(old.e.session.playerId), old.e);
          assert.equal(old.e.ticketId, old.ticket); assert.equal(old.e.expiresAt, old.ttl); assert.equal(old.e.sequence, old.sequence);
          assert.equal(old.e.offerId, null); assert.equal(old.e.accepted, false);
        }
        assert.ok(originalRooms.every((room) => !room.disposed));
        h.lobby.queue.join(members[0], { difficulty: 'NORMAL', party: !!before.find((old) => old.e.session === members[0]).e.party.roomCode });
        for (const p of members) assert.deepEqual(h.lobby.queue.accept(p, { ...h.lobby.queue.state(p), revivalVote: false }), { ok: true });
        break;
      case 4:
        h.advance(50); h.lobby.queue.sweep();
        assert.equal(h.lobby.queue.accept(members[3], intents[3]).error, ERR.BAD_TARGET);
        break;
      case 5:
        assert.deepEqual(h.lobby.queue.accept(members[3], intents[3]), { ok: true });
        h.lobby.queue.cancel(members[0], intents[0]); h.disconnect(members[3]);
        assert.ok(h.lobby.roomOf(members[0]).match);
        break;
      case 6:
        assert.equal(h.lobby.queue.accept(members[3], { ...intents[3], revivalVote: undefined }).error, ERR.BAD_MSG);
        assert.equal(h.lobby.queue.state(members[3]).accepted, false);
        assert.deepEqual(h.lobby.queue.accept(members[3], intents[3]), { ok: true });
        assert.deepEqual(h.lobby.queue.accept(members[3], intents[3]), { ok: true });
        break;
    }
    invariant();
    assert.deepEqual(h.lobby.queue.state(other), otherBefore);
    for (const p of [...players, other]) {
      if (h.lobby.queue.has(p)) h.lobby.queue.cancel(p, h.lobby.queue.state(p));
      if (h.lobby.roomOf(p)) h.lobby.leave(p);
    }
    assert.equal(h.lobby.rooms.size, 0); assert.equal(h.lobby.queue.size, 0); assert.equal(h.lobby.queue.parties.size, 0);
  }
  assert.ok(successes >= 70, `successful starts: ${successes}`);
  assert.equal(failures, 20);
});

test('a full four-person party replaces its room at the global/network cap but cannot bypass running match quotas', (t) => {
  const h = harness(t, { maxRooms: 2, maxRoomsPerAddr: 2, maxMatchesPerAddr: 1 }), players = h.group(['A', 'B', 'C', 'D']);
  const original = h.privateRoom(players), busy = h.player('作战占位', 'B');
  h.lobby.voteRevival(players[0], { enable: true });
  h.lobby.loadout(players[1], { entries: {} });
  const loadout = players[1].loadout;
  h.lobby.create(busy, { mode: 'solo', difficulty: 'NORMAL' }); h.lobby.start(busy);
  h.lobby.queue.join(players[0], { difficulty: 'NORMAL', party: true });
  const intents = players.map((p) => ({ ...h.lobby.queue.state(p), revivalVote: true }));
  assert.equal(h.accept(players, intents)[3].error, ERR.RATE);
  assert.equal(h.lobby.rooms.size, 2); assert.equal(original.disposed, false);
  assert.equal(original.seatOf(players[0].playerId).revivalVote, true);
  assert.equal(original.seatOf(players[1].playerId).loadout, loadout);
  h.lobby.leave(busy);
  // A room-code failure also preserves old votes and the exact checked loadout, not only identity.
  const gen = h.lobby.genCode; h.lobby.genCode = () => null;
  h.lobby.queue.join(players[0], { difficulty: 'NORMAL', party: true });
  let retry = players.map((p) => ({ ...h.lobby.queue.state(p), revivalVote: true }));
  assert.equal(h.accept(players, retry)[3].error, ERR.INTERNAL);
  assert.equal(original.seatOf(players[0].playerId).revivalVote, true);
  assert.equal(original.seatOf(players[1].playerId).loadout, loadout);
  h.lobby.genCode = gen;
  h.lobby.opts.maxRooms = 1; h.lobby.opts.maxRoomsPerAddr = 1;
  assert.equal(h.lobby.rooms.size, 1);
  h.lobby.queue.join(players[0], { difficulty: 'NORMAL', party: true });
  retry = players.map((p) => ({ ...h.lobby.queue.state(p), revivalVote: true }));
  assert.ok(h.accept(players, retry).every((r) => r.ok));
  assert.equal(h.lobby.rooms.size, 1); assert.equal(original.disposed, true);
  assert.equal(h.lobby.roomOf(players[1]).match.opts.seats[1].loadout, loadout);
});

test('startup publication snapshots mutable constructor frames before room-first dispatch', (t) => {
  class MutableMatch extends RecordingMatch {
    constructor(opts) {
      super(opts);
      const state = { t: 'm.public', phase: 'INFO_CHECK', value: { first: true } };
      opts.broadcast(state); state.value.first = false;
      const priv = { t: 'm.private', playerId: opts.seats[0].playerId, value: [1] };
      opts.send(priv.playerId, priv); priv.value.push(2);
    }
    start() {}
  }
  const h = harness(t, {}, MutableMatch), players = h.group();
  assert.ok(h.accept(players, h.offer(players)).every((r) => r.ok));
  for (const p of players) {
    const at = p.messages.findIndex((m) => m.t === 'room.state');
    assert.equal(p.messages[at].inMatch, true);
    assert.deepEqual(p.messages.find((m) => m.t === 'm.public').value, { first: true });
    assert.equal(p.messages.at(-1).state, 'matched');
  }
  assert.deepEqual(players[0].messages.find((m) => m.t === 'm.private').value, [1]);
  assert.ok(players.slice(1).every((p) => !p.messages.some((m) => m.t === 'm.private')));
});

test('spectators are online identities but never revival voters or queued party players', (t) => {
  const h = harness(t), players = [h.player('房主'), h.player('队友')], room = h.privateRoom(players), spectator = h.player('观战', 'S');
  assert.deepEqual(h.lobby.spectate(spectator, { code: room.code }), { ok: true });
  assert.equal(h.lobby.presenceState().online, 3);
  assert.deepEqual(h.lobby.stats(), { rooms: 1, matches: 0, humans: 2, bots: 0, spectators: 1, online: 3, queued: 0 });
  assert.equal(h.lobby.voteRevival(spectator, { enable: true }).error, ERR.SPECTATOR);
  for (const p of players) h.lobby.voteRevival(p, { enable: true });
  assert.deepEqual(room.revivalState(), { yes: 2, required: 2, enabled: true });
  assert.equal(h.lobby.queue.join(spectator, { difficulty: 'NORMAL', party: true }).error, ERR.SPECTATOR);
  assert.deepEqual(h.lobby.queue.join(players[0], { difficulty: 'NORMAL', party: true }), { ok: true });
  assert.equal(h.lobby.queue.size, 2);
  assert.equal(h.lobby.queue.has(spectator), false);
  assert.equal(h.lobby.join(spectator, { code: room.code }).error, ERR.QUEUED);
  assert.equal(room.seatOf(spectator.playerId), null);
  assert.ok(room.spectatorOf(spectator.playerId));
  const queued = h.player('队列');
  h.lobby.queue.join(queued, { difficulty: 'NORMAL' });
  assert.equal(h.lobby.spectate(queued, { code: room.code }).error, ERR.QUEUED);
  assert.equal(queued.roomCode, null);
});

test('party allocation atomically transfers unlimited spectator identities without seats, votes, quotas or private frames', (t) => {
  const h = harness(t), players = h.group(['A', 'B', 'C', 'D']);
  const rooms = [h.privateRoom(players.slice(0, 2)), h.privateRoom(players.slice(2))];
  assert.equal(MAX_SPECTATORS, 0);
  const observers = Array.from({ length: 6 }, (_, i) => h.player(`观战${i}`, `S${i}`));
  observers.forEach((s, i) => assert.deepEqual(h.lobby.spectate(s, { code: rooms[i % 2].code }), { ok: true }));
  const expectedSpectators = rooms.flatMap((room) => room.spectators.map((s) => s.playerId));
  h.disconnect(observers[1]);
  assert.ok(h.lobby.graceTimers.has(observers[1].playerId));
  for (const at of [0, 2]) h.lobby.queue.join(players[at], { difficulty: 'NORMAL', party: true });
  const offers = players.map((p, i) => ({ ...h.lobby.queue.state(p), revivalVote: i < 3 }));
  for (const s of observers) s.messages.length = 0;
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(h.lobby.queue.accept(players[i], offers[i]), { ok: true });
    observers.forEach((s, j) => assert.equal(s.roomCode, rooms[j % 2].code));
  }
  assert.deepEqual(h.lobby.queue.accept(players[3], offers[3]), { ok: true });
  const room = h.lobby.roomOf(players[0]);
  assert.deepEqual(room.match.opts.spectators, expectedSpectators);
  assert.deepEqual(room.match.opts.seats.map((s) => s.playerId), players.map((s) => s.playerId));
  assert.deepEqual([...room.ownerKeys].sort(), ['A', 'B', 'C', 'D']);
  assert.deepEqual([...room.matchKeys].sort(), ['A', 'B', 'C', 'D']);
  assert.deepEqual(room.revivalState(), { yes: 3, required: 3, enabled: true });
  for (const s of observers) {
    assert.equal(s.roomCode, room.code);
    assert.ok(room.spectatorOf(s.playerId));
    assert.equal(room.seatOf(s.playerId), null);
    assert.equal(h.lobby.queue.state(s).state, 'idle');
    assert.equal(h.lobby.graceTimers.has(s.playerId), false);
    assert.equal(s.messages.some((m) => m.t === 'm.private' || m.t === 'room.closed'), false);
  }
  assert.deepEqual(observers[0].messages.map((m) => m.t), ['room.state', 'm.public']);
  assert.ok(rooms.every((old) => old.disposed && h.lobby.getRoom(old.code) === null));
  observers[1].connected = true; observers[1].ws.readyState = 1;
  h.lobby.onHello(observers[1], { resumed: true, repeat: false });
  assert.equal(observers[1].messages.find((m) => m.t === 'room.state').code, room.code);
});

test('spectator party startup failure preserves every original room and unlimited observer', (t) => {
  class BrokenMatch extends RecordingMatch { start() { super.start(); throw new Error('fixture'); } }
  const h = harness(t, {}, BrokenMatch), players = h.group();
  const rooms = [h.privateRoom(players.slice(0, 2)), h.privateRoom(players.slice(2))];
  const observers = Array.from({ length: 6 }, (_, i) => h.player(`观战${i}`));
  observers.forEach((s, i) => h.lobby.spectate(s, { code: rooms[i % 2].code }));
  h.disconnect(observers[0]);
  const timer = h.lobby.graceTimers.get(observers[0].playerId);
  for (const at of [0, 2]) h.lobby.queue.join(players[at], { difficulty: 'NORMAL', party: true });
  for (const s of observers) s.messages.length = 0;
  const offers = players.map((p) => ({ ...h.lobby.queue.state(p), revivalVote: true }));
  const results = h.accept(players, offers);
  assert.equal(results[3].error, ERR.INTERNAL);
  assert.equal(h.lobby.rooms.size, 2);
  assert.equal(h.lobby.queue.size, 4);
  assert.equal(h.lobby.queue.offers.size, 0);
  rooms.forEach((room) => { assert.equal(h.lobby.getRoom(room.code), room); assert.equal(room.disposed, false); assert.equal(room.match, null); });
  observers.forEach((s, i) => {
    assert.equal(s.roomCode, rooms[i % 2].code);
    assert.ok(rooms[i % 2].spectatorOf(s.playerId));
    assert.deepEqual(s.messages, []);
  });
  assert.equal(h.lobby.graceTimers.get(observers[0].playerId), timer);
  players.forEach((p, i) => assert.equal(h.lobby.queue.state(p).ticketId, offers[i].ticketId));
});

test('kicking an offered participant cancels its whole party before removal and prevents phantom acceptance', (t) => {
  const h = harness(t), players = h.group(), rooms = [h.privateRoom(players.slice(0, 2)), h.privateRoom(players.slice(2))];
  for (const at of [0, 2]) h.lobby.queue.join(players[at], { difficulty: 'NORMAL', party: true });
  const offers = players.map((p) => ({ ...h.lobby.queue.state(p), revivalVote: true }));
  for (const i of [0, 2, 3]) h.lobby.queue.accept(players[i], offers[i]);
  assert.deepEqual(h.lobby.kick(players[0], { seat: 1, playerId: players[1].playerId }), { ok: true });
  assert.equal(players[1].roomCode, null);
  assert.equal(rooms[0].seatOf(players[1].playerId), null);
  assert.equal(h.lobby.queue.size, 2);
  assert.ok(players.slice(0, 2).every((p) => !h.lobby.queue.has(p)));
  assert.ok(players.slice(2).every((p) => h.lobby.queue.state(p).state === 'queued' && p.roomCode === rooms[1].code));
  assert.equal(h.lobby.queue.accept(players[3], offers[3]).error, ERR.BAD_TARGET);
  const frames = players[1].messages;
  assert.ok(frames.findIndex((m) => m.t === 'queue.state' && m.reason === 'cancelled') < frames.findIndex((m) => m.t === 'room.closed' && m.reason === 'kicked'));
});

test('a spectator cannot claim the last human room credit when creating at its cohort network limit', (t) => {
  const h = harness(t, { maxRoomsPerAddr: 1 }), players = h.group(['A', 'B', 'C', 'D']);
  h.accept(players, h.offer(players));
  const room = h.lobby.roomOf(players[0]);
  room.match.opts.onEnd({});
  for (const p of players.slice(1)) h.lobby.leave(p);
  const observer = h.player('同网观战', 'B');
  h.lobby.spectate(observer, { code: room.code });
  assert.equal(h.lobby.create(observer, { mode: 'solo', difficulty: 'NORMAL' }).error, ERR.RATE);
  assert.equal(observer.roomCode, room.code);
  assert.equal(room.activeHumans().length, 1);
  assert.equal(h.lobby.rooms.size, 1);
});

test('legacy and invalid hello capabilities cannot enter public queue', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: RecordingMatch });
  const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  t.after(async () => { await c.terminate(); await srv.close(); });
  await c.hello('旧客户端');
  assert.equal((await c.request({ t: 'queue.join', difficulty: 'NORMAL' })).code, ERR.BAD_MSG);
  assert.equal((await c.request({ t: 'hello', name: '不匹配', version: 1, matchmakingVersion: 'foreign' })).code, ERR.BAD_MSG);
  assert.equal(srv.registry.size, 1);
  assert.equal((await c.request({ t: 'room.create', mode: 'solo', difficulty: 'FUNNY' })).t, 'ok');
});
