import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { MATCHMAKING_VERSION, ERR } from '../shared/constants.js';
import { validateC2S } from '../shared/protocol.js';

class RecordingMatch {
  constructor(opts) { this.opts = opts; }
  start() {}
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
    return players.map((p) => lobby.queue.state(p));
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
  assert.deepEqual(room.toState().revival, { yes: 0, required: 3, enabled: false });
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
  assert.ok(a.messages.some((m) => m.t === 'server.state'));
});

test('four matching humans accept atomically into one ordinary room without auto-start', (t) => {
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
  assert.equal(room.match, null);
  assert.equal(room.mode, 'coop');
  assert.equal(room.activeHumans().length, 4);
  assert.ok(players.every((p) => p.roomCode === room.code));
  assert.equal(h.lobby.queue.size, 0);
  for (const p of players) assert.ok(p.messages.some((m) => m.t === 'room.state' && m.seats.filter(Boolean).length === 4));
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
  assert.equal(h.lobby.queue.size, 3);
  assert.equal(h.lobby.queue.state(players[1]).joinedAt, states[1].joinedAt);
  assert.equal(h.lobby.queue.state(players[1]).reason, 'peer_cancelled');
  const replacement = h.player();
  h.lobby.queue.join(replacement, { difficulty: 'NORMAL' });
  const next = h.lobby.queue.state(players[1]);
  assert.notEqual(next.offerId, states[1].offerId);
  assert.equal(next.accepted, false);
});

test('disconnect removes ticket immediately and excludes it from the next offer', (t) => {
  const h = harness(t), players = h.group(), states = h.offer(players);
  h.disconnect(players[0]);
  assert.equal(h.lobby.queue.size, 3);
  assert.equal(h.lobby.queue.state(players[0]).state, 'idle');
  players[0].connected = true; players[0].ws.readyState = 1;
  h.lobby.onHello(players[0], { resumed: true, repeat: false });
  assert.equal(h.lobby.queue.state(players[0]).state, 'idle');
  assert.equal(h.lobby.queue.accept(players[0], states[0]).error, ERR.BAD_TARGET);
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
  assert.equal(h.lobby.queue.size, 0);
  assert.equal(h.lobby.queue.offers.size, 0);
  assert.ok(players.every((p) => p.roomCode === null));
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
  assert.equal(h.lobby.queue.size, 0);
});

test('public match quota follows all cohort networks across host migration', (t) => {
  const h = harness(t, { maxMatchesPerAddr: 1 }), players = h.group(['A', 'B', 'C', 'D']);
  h.accept(players, h.offer(players));
  const room = h.lobby.roomOf(players[0]);
  const outsider = h.player('同网新局', 'B');
  h.lobby.create(outsider, { mode: 'solo', difficulty: 'FUNNY' });
  h.lobby.start(outsider);
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

test('drain closes admission but retains rooms, running matches, votes and reconnects', (t) => {
  const h = harness(t), active = h.player('活动'), waiting = h.player('等待'), queued = h.player('排队');
  h.lobby.create(active, { mode: 'solo', difficulty: 'NORMAL' });
  h.lobby.start(active);
  const match = h.lobby.roomOf(active).match;
  h.lobby.create(waiting, { mode: 'coop', difficulty: 'NORMAL' });
  h.lobby.queue.join(queued, { difficulty: 'NORMAL' });
  h.lobby.setDraining(true, 'release-next');
  assert.equal(h.lobby.queue.size, 0);
  assert.equal(h.lobby.start(waiting).error, ERR.MAINTENANCE);
  assert.equal(h.lobby.create(queued, { mode: 'solo', difficulty: 'FUNNY' }).error, ERR.MAINTENANCE);
  assert.equal(h.lobby.join(queued, { code: waiting.roomCode }).error, ERR.MAINTENANCE);
  assert.equal(h.lobby.queue.join(queued, { difficulty: 'NORMAL' }).error, ERR.MAINTENANCE);
  assert.deepEqual(h.lobby.join(active, { code: active.roomCode }), { ok: true });
  assert.deepEqual(h.lobby.routeGame(active, { t: 'g.ready', ready: true }), { ok: true });
  assert.equal(h.lobby.roomOf(active).match, match);
  const status = h.lobby.getRollingStatus();
  assert.equal(status.canRetire, false);
  assert.equal(status.matches, 1);
  assert.equal(status.matchOnline, 1);
  assert.equal(status.lobbyOnline, 2);
  h.lobby.setDraining(false, 'release-next');
  assert.deepEqual(h.lobby.queue.join(queued, { difficulty: 'NORMAL' }), { ok: true });
});

test('retirement excludes roomless offline identities but includes pending game results/notices and live players', (t) => {
  const h = harness(t), p = h.player();
  h.lobby.setDraining(true, 'new');
  assert.equal(h.lobby.getRollingStatus().canRetire, false);
  h.disconnect(p);
  assert.equal(h.lobby.getRollingStatus().canRetire, true);
  assert.equal(h.lobby.getRollingStatus().sessions, 1);
  p.pendingResult = ['result'];
  assert.equal(h.lobby.getRollingStatus().canRetire, false);
  p.pendingResult = null; p.notice = 'timeout';
  assert.equal(h.lobby.getRollingStatus().retainedSessions, 1);
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

test('real websocket hello presence, replacement identity, queue confirmation and vote start', async (t) => {
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
  for (let i = 0; i < group.length; i++) assert.equal((await group[i].request({ t: 'queue.accept', ticketId: offers[i].ticketId, offerId: offers[i].offerId })).t, 'ok');
  const states = await Promise.all(group.map((c) => c.waitFor('room.state', (m) => m.source === 'matchmaking')));
  assert.ok(states.every((s) => s.code === states[0].code));
  for (const c of group.slice(0, 3)) assert.equal((await c.request({ t: 'room.voteRevival', enable: true })).t, 'ok');
  for (const c of group.slice(1)) assert.equal((await c.request({ t: 'room.ready', ready: true })).t, 'ok');
  assert.equal((await group[0].request({ t: 'room.start' })).t, 'ok');
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
  h.offer(players);
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
  assert.equal(h.lobby.queue.size, 0);
});

test('public-room replacement members must have a compatible handshake too', (t) => {
  const h = harness(t), players = h.group();
  h.accept(players, h.offer(players));
  const code = players[0].roomCode;
  h.lobby.leave(players[3]);
  const legacy = h.player('旧客户端'); legacy.matchmakingVersion = null;
  assert.equal(h.lobby.join(legacy, { code }).error, ERR.BAD_MSG);
  assert.equal(legacy.roomCode, null);
  legacy.matchmakingVersion = MATCHMAKING_VERSION;
  assert.deepEqual(h.lobby.join(legacy, { code }), { ok: true });
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
