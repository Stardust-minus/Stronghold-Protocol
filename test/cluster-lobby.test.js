// Fake-platform contract tests, NOT an end-to-end node/network/browser acceptance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { ClusterLobby } from '../server/cluster/lobby.js';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

function harness(t, options = {}) {
  const clock = { time: 10_000 }, events = [], calls = [], peers = [], resumes = [], releases = [];
  let seeds = 0, localMatches = 0;
  const registry = new SessionRegistry({ now: () => clock.time });
  const platform = {
    build: 'synthetic-build', protocol: 1,
    prepare(spec, context) { const work = deferred(); calls.push({ spec: structuredClone(spec), context, work }); return work.promise; },
    resume(assignmentId, playerId) { resumes.push({ assignmentId, playerId }); return true; },
    peer(assignmentId, method, playerId, loadout) {
      const work = deferred(); peers.push({ assignmentId, method, playerId, loadout, work }); return work.promise;
    },
    deliverEnd() { return true; },
    release(assignmentId) { releases.push(assignmentId); return Promise.resolve(true); },
  };
  class ForbiddenLocalMatch { constructor() { localMatches++; throw new Error('local simulation forbidden in cluster fixture'); } }
  const lobby = new ClusterLobby({ registry, platform, options, getData: () => ({}), now: () => clock.time,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    seedFn: () => { seeds++; return 123456; }, MatchClass: ForbiddenLocalMatch });
  t.after(() => lobby.shutdown());
  let name = 0;
  const player = (key = null) => {
    const session = registry.create(`Synthetic${++name}`);
    session.messages = []; session.connected = true; session.limitKey = key; session.matchmakingVersion = MATCHMAKING_VERSION;
    session.ws = { readyState: 1, bufferedAmount: 0, send(data, cb) {
      const message = JSON.parse(data); session.messages.push(message); events.push({ playerId: session.playerId, type: message.t, state: message.state, inMatch: message.inMatch }); cb?.();
    } };
    lobby.onHello(session, { resumed: false, repeat: false }); return session;
  };
  const group = () => Array.from({ length: 4 }, () => player());
  const privateRoom = (players, mode = 'coop') => {
    assert.deepEqual(lobby.create(players[0], { mode, difficulty: 'NORMAL' }), { ok: true });
    const room = lobby.roomOf(players[0]);
    for (const session of players.slice(1)) assert.deepEqual(lobby.join(session, { code: room.code }), { ok: true });
    return room;
  };
  const queue = (players) => {
    const seen = new Set();
    for (const session of players) {
      const room = lobby.roomOf(session);
      if (room && seen.has(room)) continue;
      if (room) seen.add(room);
      assert.deepEqual(lobby.queue.join(session, { difficulty: 'NORMAL', party: !!room }), { ok: true });
    }
    return players.map(s => ({ ...lobby.queue.state(s), revivalVote: false }));
  };
  const accept = (players, states) => players.forEach((session, i) => assert.deepEqual(lobby.queue.accept(session, states[i]), { ok: true }));
  const complete = (index = calls.length - 1, overrides = {}) => {
    const call = calls[index], counts = { commit: 0, publish: 0, abort: 0 };
    const handle = {
      assignmentId: call.spec.assignmentId, nodeId: 'synthetic-node', generation: 'synthetic-generation',
      commit() { counts.commit++; events.push({ type: 'platform.commit' }); return { ownerAvailable: true }; },
      publish() { counts.publish++; events.push({ type: 'platform.publish' }); return true; },
      abort() { counts.abort++; events.push({ type: 'platform.abort' }); return Promise.resolve(true); },
      ...overrides,
    };
    call.work.resolve(handle); return { call, handle, counts };
  };
  return { lobby, platform, registry, clock, events, calls, peers, resumes, releases, player, group, privateRoom, queue, accept, complete,
    seeds: () => seeds, localMatches: () => localMatches };
}
function tickets(h, players) {
  return players.map(s => {
    const e = h.lobby.queue.entries.get(s.playerId);
    return { e, ticketId: e.ticketId, sequence: e.sequence, joinedAt: e.joinedAt, expiresAt: e.expiresAt };
  });
}
function preserved(h, players, before) {
  for (let i = 0; i < players.length; i++) {
    const e = h.lobby.queue.entries.get(players[i].playerId);
    assert.ok(e === before[i].e && e.ticketId === before[i].ticketId, 'original queue ticket identity is preserved');
    for (const key of ['sequence', 'joinedAt', 'expiresAt']) assert.equal(e[key], before[i][key]);
    assert.equal(h.lobby.queue.state(players[i]).state, 'queued');
  }
}

test('base Lobby factory hook retains default local construction', () => {
  let constructions = 0;
  class Stub { constructor(opts) { constructions++; this.opts = opts; } }
  const lobby = new Lobby({ registry: new SessionRegistry(), MatchClass: Stub, getData: () => ({}) });
  const opts = { synthetic: true }, match = lobby.createMatch(opts);
  assert.ok(match instanceof Stub); assert.equal(match.opts, opts); assert.equal(constructions, 1);
  lobby.shutdown();
});

test('cluster constructor validates the small platform contract', () => {
  for (const platform of [null, {}, { prepare() {}, resume() {}, release() {}, build: 'bad build', protocol: 1 }]) {
    assert.throws(() => new ClusterLobby({ platform, registry: new SessionRegistry() }), TypeError);
  }
});

test('public 2+1+1 party commits only prepared DTO and publishes room state before ingress then matched', async t => {
  const h = harness(t), players = h.group(), old = h.privateRoom(players.slice(0, 2)), observer = h.player();
  assert.deepEqual(h.lobby.spectate(observer, { code: old.code }), { ok: true });
  players[0].loadout = Object.freeze({ synthetic_unit: Object.freeze({ skill: 1, module: null }) });
  old.seatOf(players[0].playerId).loadout = players[0].loadout;
  const states = h.queue(players), original = tickets(h, players); h.accept(players, states);
  assert.equal(h.calls.length, 1); assert.equal(h.seeds(), 1); assert.equal(h.localMatches(), 0);
  assert.ok(players.slice(0, 2).every(s => s.roomCode === old.code)); assert.equal(observer.roomCode, old.code);
  assert.equal(old.disposed, false); assert.equal(old.match, null); assert.equal(h.lobby.rooms.size, 1);
  const call = h.calls[0], spec = call.spec;
  assert.deepEqual(Object.keys(spec).sort(), ['assignmentId', 'build', 'protocol', 'roomCode', 'mode', 'difficulty', 'modeId',
    'revivalEnabled', 'disableSharedPool', 'experimental', 'seed', 'matchNo', 'seats', 'spectators'].sort());
  assert.equal(spec.seed, 123456); assert.equal(spec.matchNo, 1); assert.equal(spec.revivalEnabled, false);
  assert.deepEqual(spec.seats[0].loadout, { synthetic_unit: { skill: 1, module: null } });
  assert.deepEqual(spec.spectators, [observer.playerId]); assert.ok(call.context.isCurrent());
  for (const session of players) h.lobby.queue.accept(session, states[players.indexOf(session)]);
  assert.equal(h.calls.length, 1);
  const done = h.complete(); await flush();
  assert.deepEqual(done.counts, { commit: 1, publish: 1, abort: 0 });
  assert.equal(h.localMatches(), 0); assert.equal(h.seeds(), 1);
  const room = h.lobby.roomOf(players[0]); assert.ok(room && room !== old && room.match);
  assert.equal(old.disposed, true); assert.equal(h.lobby.rooms.has(old.code), false);
  assert.ok(players.every(s => s.roomCode === room.code && h.lobby.queue.state(s).state === 'matched'));
  assert.equal(observer.roomCode, room.code); assert.equal(room.spectators.length, 1); assert.equal(h.lobby.rooms.size, 1);
  const publish = h.events.findIndex(e => e.type === 'platform.publish');
  for (const session of [...players, observer]) {
    const at = h.events.findIndex(e => e.playerId === session.playerId && e.type === 'room.state' && e.inMatch === true);
    assert.ok(at >= 0 && at < publish, 'membership room publication precedes ingress startup release');
    assert.ok(!session.messages.some(m => m.t === 'room.closed'), 'retiring a friend room cannot close the new match');
    assert.ok(!session.messages.some(m => m.t.startsWith('b.') || m.t === 'm.field'), 'the fake does not send battle frames through coordination');
  }
  assert.ok(h.events.filter(e => e.state === 'matched').every(e => h.events.indexOf(e) > publish));
  assert.ok(original.every((x, i) => players[i].matchmakingResult.ticketId === x.ticketId));
});

for (const changed of ['loadout', 'observer', 'network', 'experimental']) test(`prepared public ${changed} change rejects old actor without consuming the friend room`, async t => {
  const h = harness(t), players = h.group(), old = h.privateRoom(players.slice(0, 2)), states = h.queue(players), before = tickets(h, players);
  h.accept(players, states);
  if (changed === 'loadout') { players[0].loadout = { synthetic_unit: { skill: 2, module: null } }; old.seatOf(players[0].playerId).loadout = players[0].loadout; }
  if (changed === 'observer') h.lobby.spectate(h.player(), { code: old.code });
  if (changed === 'network') players[0].limitKey = 'changed-network';
  if (changed === 'experimental') h.lobby.queue.offers.get(states[0].offerId).experimental = { revivalEnabled: true, disableSharedPool: true };
  const done = h.complete(); await flush();
  assert.deepEqual(done.counts, { commit: 0, publish: 0, abort: 1 });
  assert.equal(h.lobby.getRoom(old.code), old); assert.equal(old.disposed, false); assert.equal(old.match, null);
  assert.ok(players.slice(0, 2).every(s => s.roomCode === old.code));
  assert.ok(players.every(s => !s.messages.some(m => m.inMatch === true)));
  if (changed !== 'network') preserved(h, players, before);
});

for (const fault of ['commit', 'factory', 'dto', 'map-transfer', 'session-transfer']) test(`${fault} failure compensates actor and restores rooms, tickets and old timers`, async t => {
  const h = harness(t), players = h.group(), old = h.privateRoom(players.slice(0, 2)), observer = h.player();
  h.lobby.spectate(observer, { code: old.code });
  observer.connected = false; observer.ws.readyState = 3; h.lobby.onDisconnect(observer);
  const grace = h.lobby.graceTimers.get(observer.playerId);
  const resync = setTimeout(() => {}, 99_000); resync.unref(); h.lobby.resyncTimers.set(observer.playerId, resync);
  old.replay = { publicFrame: null, frames: new Map(), pending: new Set() }; const replay = old.replay;
  const states = h.queue(players), before = tickets(h, players); h.accept(players, states);
  if (fault === 'factory') h.lobby.createMatch = () => { throw new Error('synthetic construction failure'); };
  if (fault === 'dto') {
    const originalFactory = h.lobby.createMatch;
    h.lobby.createMatch = function(opts) { return originalFactory.call(this, { ...opts, seed: opts.seed + 1 }); };
  }
  if (fault === 'map-transfer') {
    const set = h.lobby.rooms.set.bind(h.lobby.rooms); let once = true;
    h.lobby.rooms.set = (key, room) => { if (once && key === h.calls[0].spec.roomCode) { once = false; throw new Error('synthetic map transfer'); } return set(key, room); };
  }
  if (fault === 'session-transfer') {
    let notice = players[1].notice, once = true;
    Object.defineProperty(players[1], 'notice', { configurable: true, get: () => notice, set(value) {
      if (once && value === null) { once = false; throw new Error('synthetic partial membership'); } notice = value;
    } });
  }
  let commitAttempts = 0;
  const done = h.complete(0, fault === 'commit' ? { commit() { commitAttempts++; throw new Error('synthetic commit failure'); } } : {});
  await flush();
  assert.equal(done.counts.abort, 1); assert.equal(done.counts.publish, 0);
  if (fault === 'commit') assert.equal(commitAttempts, 1);
  assert.equal(h.lobby.getRoom(old.code), old); assert.equal(old.disposed, false); assert.equal(old.replay, replay);
  assert.equal(h.lobby.rooms.size, 1); assert.equal(old.match, null); assert.equal(old.matchCount, 0);
  assert.ok(players.slice(0, 2).every(s => s.roomCode === old.code)); assert.equal(observer.roomCode, old.code);
  assert.equal(h.lobby.graceTimers.get(observer.playerId), grace); assert.equal(h.lobby.resyncTimers.get(observer.playerId), resync);
  preserved(h, players, before);
  assert.ok([...players, observer].every(s => !s.messages.some(m => m.inMatch === true || m.t === 'room.closed')));
});

test('prepare rejection preserves original party and FIFO without allocation retry', async t => {
  const h = harness(t), players = h.group(), old = h.privateRoom(players.slice(0, 2)), states = h.queue(players), before = tickets(h, players);
  h.accept(players, states); h.calls[0].work.reject(new Error('synthetic provider failure')); await flush();
  preserved(h, players, before); assert.equal(h.lobby.getRoom(old.code), old); assert.equal(h.calls.length, 1);
});

test('cancel and new offer race aborts a late actor without changing fresh tickets/rooms', async t => {
  const h = harness(t), players = h.group(), states = h.queue(players); h.accept(players, states);
  const first = h.calls[0]; h.lobby.queue.cancel(players[0], states[0]); await flush();
  assert.equal(first.context.signal.aborted, true);
  const fresh = h.queue(players); h.accept(players, fresh); assert.equal(h.calls.length, 2);
  const old = h.complete(0); await flush();
  assert.deepEqual(old.counts, { commit: 0, publish: 0, abort: 1 });
  assert.ok(h.lobby.queue.state(players[0]).ticketId === fresh[0].ticketId);
  assert.ok(h.calls[1].context.isCurrent());
  const next = h.complete(1); await flush();
  assert.deepEqual(next.counts, { commit: 1, publish: 1, abort: 0 });
});

test('solo manual start awaits one prepared actor, reuses base validation and consumes seed once', async t => {
  const h = harness(t), player = h.player(), room = h.privateRoom([player], 'solo');
  const promise = h.lobby.start(player), repeat = h.lobby.start(player);
  assert.equal(promise, repeat); assert.equal(h.calls.length, 1); assert.equal(room.match, null); assert.equal(room.matchCount, 0);
  const seedFn = h.lobby.seedFn, done = h.complete();
  assert.deepEqual(await promise, { ok: true });
  assert.equal(h.lobby.seedFn, seedFn); assert.equal(h.seeds(), 1); assert.equal(h.localMatches(), 0); assert.equal(room.matchCount, 1);
  assert.deepEqual(done.counts, { commit: 1, publish: 1, abort: 0 });
  assert.equal(h.lobby.start(player).error, ERR.ROOM_STARTED);
});

test('manual friend room enforces host/readiness and locks experimental rules before preparation', async t => {
  const h = harness(t), players = h.group().slice(0, 3), room = h.privateRoom(players);
  assert.equal(h.lobby.start(players[1]).error, ERR.NOT_HOST); assert.equal(h.lobby.start(players[0]).error, ERR.NOT_READY);
  h.lobby.setExperimental(players[0], { experimental: { revivalEnabled: true, disableSharedPool: false } });
  for (const p of players.slice(1)) h.lobby.ready(p, { ready: true });
  const promise = h.lobby.start(players[0]); assert.equal(h.calls[0].spec.revivalEnabled, true);
  h.complete(); assert.deepEqual(await promise, { ok: true }); assert.equal(room.revivalLocked.enabled, true);
});

for (const cancellation of ['disconnect', 'leave', 'timeout', 'shutdown', 'loadout']) test(`manual ${cancellation} cancels bounded prepare and late cleanup cannot start the old room`, async t => {
  const h = harness(t), player = h.player(), room = h.privateRoom([player], 'solo'), promise = h.lobby.start(player), call = h.calls[0];
  if (cancellation === 'disconnect') { player.connected = false; player.ws.readyState = 3; h.lobby.onDisconnect(player); }
  if (cancellation === 'leave') h.lobby.leave(player);
  if (cancellation === 'timeout') { h.clock.time += 6000; assert.equal(h.lobby.start(player), promise); }
  if (cancellation === 'shutdown') h.lobby.shutdown();
  if (cancellation === 'loadout') { player.loadout = { synthetic_unit: { skill: 2, module: null } }; room.seatOf(player.playerId).loadout = player.loadout; h.lobby.start(player); }
  const result = await promise; assert.ok(result.error); assert.equal(call.context.signal.aborted, true);
  const done = h.complete(); await flush();
  assert.deepEqual(done.counts, { commit: 0, publish: 0, abort: 1 }); assert.equal(room.match, null); assert.equal(room.matchCount, 0);
  assert.equal(h.lobby.manualPending.size, 0); assert.ok(!player.messages.some(m => m.inMatch === true));
});

test('manual DTO/start failure restores seed function and original host readiness/match count', async t => {
  const h = harness(t), player = h.player(), room = h.privateRoom([player], 'solo'), seedFn = h.lobby.seedFn;
  const promise = h.lobby.start(player);
  h.lobby.log.info = message => { if (message.includes('starting')) throw new Error('synthetic start failure'); };
  const done = h.complete(); assert.ok((await promise).error);
  assert.equal(h.lobby.seedFn, seedFn); assert.equal(h.seeds(), 1); assert.equal(room.matchCount, 0);
  assert.equal(room.seatOf(player.playerId).ready, false); assert.equal(room.match, null); assert.equal(room.matchCtx, null);
  assert.equal(done.counts.abort, 1); assert.equal(done.counts.publish, 0);
});

test('commit rechecks room and network capacity after await', async t => {
  const h = harness(t, { maxRooms: 1 }), players = h.group(), states = h.queue(players); h.accept(players, states);
  const other = h.player(); h.privateRoom([other], 'solo');
  const done = h.complete(); await flush();
  assert.deepEqual(done.counts, { commit: 0, publish: 0, abort: 1 });
  assert.equal(h.lobby.rooms.size, 1); assert.ok(players.every(s => s.roomCode === null && h.lobby.queue.state(s).state === 'queued'));
});

test('proxy reconnect resumes routing, coordination disconnect never drives engine, game input fails closed', async t => {
  const h = harness(t), player = h.player(), room = h.privateRoom([player], 'solo'), promise = h.lobby.start(player); h.complete(); await promise;
  const match = room.match;
  match.onDisconnect(player.playerId); assert.equal(h.peers.length, 0);
  assert.equal(match.onReconnect(player.playerId), true); assert.equal(h.resumes.length, 1);
  assert.equal(match.handle(player.playerId, { t: 'g.buy' }).error, ERR.WRONG_PHASE);
  match.dispose(); assert.equal(h.releases.length, 0, 'disposing coordination cannot invent an end/release for a live published actor');
});

test('spectate/remove/loadout/leave wait for normalized peer acknowledgements rather than treating promises as success', async t => {
  const h = harness(t), players = h.group(), room = h.privateRoom(players.slice(0, 2)); h.lobby.ready(players[1], { ready: true });
  const promise = h.lobby.start(players[0]); h.complete(); await promise;
  const spectator = players[2], added = h.lobby.spectate(spectator, { code: room.code });
  assert.ok(added && typeof added.then === 'function'); assert.equal(h.peers.at(-1).method, 'addSpectator');
  h.peers.at(-1).work.resolve({ ok: true }); assert.deepEqual(await added, { ok: true });
  room.match.addSpectator(spectator.playerId); assert.equal(h.resumes.length, 1, 'existing observer uses resume, not another role mutation');
  const loadout = h.lobby.loadout(players[0], { entries: {} });
  assert.ok(loadout && typeof loadout.then === 'function'); assert.equal(h.peers.at(-1).method, 'setLoadout');
  h.peers.at(-1).work.resolve({ error: ERR.ROOM_STARTED }); assert.equal((await loadout).error, ERR.ROOM_STARTED);
  const removed = h.lobby.removeSpectator(players[0], { playerId: spectator.playerId });
  assert.equal(h.peers.at(-1).method, 'removeSpectator'); h.peers.at(-1).work.resolve({ ok: true }); assert.deepEqual(await removed, { ok: true });
  const left = h.lobby.leave(players[1]); assert.equal(h.peers.at(-1).method, 'leave');
  h.peers.at(-1).work.reject(new Error('synthetic peer failure')); assert.equal((await left).error, ERR.INTERNAL);
  assert.equal(players[1].roomCode, null); assert.equal(room.seatOf(players[1].playerId).left, true);
});

test('failed new spectator authorization rolls back only its own current local observer incarnation', async t => {
  const h = harness(t), player = h.player(), room = h.privateRoom([player]), promise = h.lobby.start(player); h.complete(); await promise;
  const spectator = h.player(), added = h.lobby.spectate(spectator, { code: room.code });
  h.peers.at(-1).work.resolve(false); assert.equal((await added).error, ERR.INTERNAL);
  assert.equal(spectator.roomCode, null); assert.equal(room.spectatorOf(spectator.playerId), null);
});

test('trusted end receipt checks assignment/room/node epoch and stores original ctx replay, never fabricates termination', async t => {
  const h = harness(t), player = h.player(), room = h.privateRoom([player], 'solo'), promise = h.lobby.start(player), done = h.complete(); await promise;
  const assignmentId = done.handle.assignmentId;
  const receipt = { assignmentId, roomCode: room.code, generation: done.handle.generation,
    lastPublic: { t: 'm.public', phase: 'END' }, results: { [player.playerId]: { t: 'm.result', won: true } }, summary: { synthetic: true } };
  for (const changed of [{ generation: 'stale' }, { assignmentId: 'unknown' }, { roomCode: 'ZZZZ' },
    { results: { unknown: { t: 'm.result' } } }, { lastPublic: { t: 'b.snap' } }, { extra: true }]) {
    assert.equal(h.lobby.receiveEnd(assignmentId, { ...receipt, ...changed }), false);
    assert.ok(room.match, 'bad/missing end never terminates a live remote actor');
  }
  assert.equal(h.lobby.receiveEnd(assignmentId, receipt), true); assert.equal(room.match, null);
  assert.deepEqual(room.lastSummary, { synthetic: true }); assert.ok(room.replay.frames.has(player.playerId));
  assert.equal(JSON.parse(room.replay.publicFrame).t, 'm.public');
  assert.equal(h.lobby.receiveEnd(assignmentId, receipt), false);
  await nextTurn(); assert.ok(h.releases.length === 1 && h.releases[0] === assignmentId);
});

for (const layout of [[2, 2], [3, 1], [4]]) test(`remote public ${layout.join('+')} preserves indivisible parties and quota transfer credits`, async t => {
  const h = harness(t, { maxRooms: 2, maxRoomsPerAddr: 2, maxMatchesPerAddr: 1 }), players = h.group(), oldRooms = [], observers = [];
  for (const player of players) player.limitKey = 'synthetic-network';
  let at = 0;
  for (const size of layout) {
    if (size > 1) {
      const room = h.privateRoom(players.slice(at, at + size)); oldRooms.push(room);
      const observer = h.player('observer-network'); h.lobby.spectate(observer, { code: room.code }); observers.push(observer);
    }
    at += size;
  }
  for (const old of oldRooms) h.lobby.setExperimental(h.registry.byId(old.hostId), { experimental: { revivalEnabled: true, disableSharedPool: false } });
  const states = h.queue(players);
  h.accept(players, states);
  assert.equal(h.calls[0].spec.revivalEnabled, true);
  const done = h.complete(); await flush();
  assert.deepEqual(done.counts, { commit: 1, publish: 1, abort: 0 });
  const room = h.lobby.roomOf(players[0]); assert.ok(room.match); assert.equal(h.lobby.rooms.size, 1);
  assert.ok(oldRooms.every(old => old.disposed && !h.lobby.rooms.has(old.code)));
  assert.ok(observers.every(s => s.roomCode === room.code));
  assert.deepEqual([...room.ownerKeys], ['synthetic-network']); assert.equal(room.revivalLocked.enabled, true);
  assert.equal(h.localMatches(), 0); assert.equal(h.seeds(), 1);
});

for (const trigger of ['deadline', 'disconnect', 'shutdown']) test(`pending public ${trigger} prevents late actor publication`, async t => {
  const h = harness(t), players = h.group(), old = h.privateRoom(players.slice(0, 2)), states = h.queue(players), before = tickets(h, players);
  h.accept(players, states); const call = h.calls[0];
  if (trigger === 'deadline') { h.clock.time += 6000; h.lobby.queue.sweep(); }
  if (trigger === 'disconnect') { players[0].connected = false; players[0].ws.readyState = 3; h.lobby.onDisconnect(players[0]); }
  if (trigger === 'shutdown') h.lobby.shutdown();
  await flush(); assert.equal(call.context.signal.aborted, true);
  const done = h.complete(); await flush();
  assert.deepEqual(done.counts, { commit: 0, publish: 0, abort: 1 });
  assert.ok(players.every(s => !s.messages.some(m => m.inMatch === true)));
  if (trigger === 'deadline') { preserved(h, players, before); assert.equal(h.lobby.getRoom(old.code), old); }
});

test('manual cooperative bots remain DTO actors on the node, not a second local simulation', async t => {
  const h = harness(t), player = h.player(), room = h.privateRoom([player]);
  h.lobby.addBot(player); h.lobby.addBot(player);
  const promise = h.lobby.start(player), spec = h.calls[0].spec;
  assert.equal(spec.seats.length, 3); assert.equal(spec.seats.filter(s => s.isBot).length, 2);
  assert.ok(spec.seats.filter(s => s.isBot).every(s => s.loadout === null && s.playerId.startsWith('ai_')));
  const done = h.complete(); assert.deepEqual(await promise, { ok: true });
  assert.deepEqual(done.counts, { commit: 1, publish: 1, abort: 0 }); assert.equal(h.localMatches(), 0); assert.ok(room.match);
});

test('malformed or oversized trusted end DTO fails closed without ending the actor', async t => {
  const h = harness(t), player = h.player(), room = h.privateRoom([player], 'solo'), promise = h.lobby.start(player), done = h.complete();
  assert.deepEqual(await promise, { ok: true });
  const assignmentId = done.handle.assignmentId, receipt = { assignmentId, roomCode: room.code, generation: done.handle.generation,
    lastPublic: null, results: {}, summary: null };
  const accessor = { ...receipt }; Object.defineProperty(accessor, 'generation', { get() { throw new Error('synthetic receipt inspection failure'); } });
  assert.equal(h.lobby.receiveEnd(assignmentId, accessor), false);
  assert.equal(h.lobby.receiveEnd(assignmentId, { ...receipt, summary: { oversized: 'x'.repeat(2 * 1024 * 1024) } }), false);
  assert.ok(room.match); assert.equal(h.releases.length, 0);
});

test('spectator departure during pending role admission waits then revokes the old role without resurrecting local membership', async t => {
  const h = harness(t), owner = h.player(), room = h.privateRoom([owner]), start = h.lobby.start(owner); h.complete(); await start;
  const observer = h.player(), added = h.lobby.spectate(observer, { code: room.code });
  const repeat = h.lobby.spectate(observer, { code: room.code });
  assert.equal(h.peers.length, 1, 'repeated pending admission does not send another role change');
  const left = h.lobby.leave(observer); assert.ok(left && typeof left.then === 'function');
  assert.equal(h.peers.length, 1, 'departure must not lose to MEMBER_BUSY while add is pending');
  assert.equal(observer.roomCode, null);
  h.peers[0].work.resolve({ ok: true }); await flush();
  assert.equal(h.peers.length, 2); assert.equal(h.peers[1].method, 'removeSpectator');
  assert.deepEqual(await added, { ok: true }); assert.deepEqual(await repeat, { ok: true });
  h.peers[1].work.resolve({ ok: true }); assert.deepEqual(await left, { ok: true });
  assert.equal(room.spectatorOf(observer.playerId), null); assert.equal(observer.roomCode, null);
  assert.equal(room.match.members.has(observer.playerId), false);
});

test('permanent player leave waits behind one in-flight loadout RPC rather than leaking an old node role', async t => {
  const h = harness(t), owner = h.player(), room = h.privateRoom([owner]), start = h.lobby.start(owner); h.complete(); await start;
  const match = room.match, loadout = h.lobby.loadout(owner, { entries: {} });
  const busy = h.lobby.loadout(owner, { entries: {} }); assert.equal((await busy).error, ERR.INTERNAL);
  assert.equal(h.peers.length, 1);
  const left = h.lobby.leave(owner); assert.equal(h.peers.length, 1); assert.equal(owner.roomCode, null);
  h.peers[0].work.resolve({ ok: true }); await flush();
  assert.equal(h.peers.length, 2); assert.equal(h.peers[1].method, 'leave');
  assert.deepEqual(await loadout, { ok: true });
  h.peers[1].work.resolve({ ok: true }); assert.deepEqual(await left, { ok: true });
  assert.equal(match.members.has(owner.playerId), false); assert.equal(h.releases.length, 0);
});
