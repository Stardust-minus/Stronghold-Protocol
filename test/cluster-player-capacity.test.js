import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import WebSocket from 'ws';
import { ClusterLobby } from '../server/cluster/lobby.js';
import { ClusterDirectory } from '../server/cluster/directory.js';
import { GameHost, copyAssignmentSpec } from '../server/cluster/game-host.js';
import { RemoteGamePlatform } from '../server/cluster/platform.js';
import { startGameNode } from '../server/cluster/game-node.js';
import { SessionRegistry } from '../server/net.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';
import { PLAYER_CAPACITIES, PLAYER_CAPACITY_VERSION } from '../shared/playerCapacity.js';
import { OPERATOR_SKINS, SKIN_LIMITS } from '../shared/skins.js';
import { LOADOUT_LIMITS, OWNERSHIP_LIMITS, DIY_LIMITS, validateC2S } from '../shared/protocol.js';
import { PREPARE_MAX_BYTES } from '../server/cluster/rpc.js';

const options = capacity => ({ revivalEnabled: false, disableSharedPool: false, playerCapacity: capacity });
const skin = { [OPERATOR_SKINS[0].charId]: OPERATOR_SKINS[0].id };
const seats = size => Array.from({ length: size }, (_, seat) => ({ seat, playerId: `p${seat}`, name: `Player${seat}`, isBot: false, connected: true, skins: { ...skin } }));
const spec = (extra = {}) => ({ assignmentId: 'capacity-assignment', roomCode: 'ABCD', build: 'capacity-build', protocol: 1,
  seed: 1, matchNo: 1, mode: 'coop', difficulty: 'NORMAL', modeId: 'mode_multi_normal', experimental: options(20), seats: seats(20), spectators: ['observer'], ...extra });
class PrivateMatch {
  constructor(opts) { this.opts = opts; }
  start() {
    this.opts.broadcast({ t: 'm.public', phase: 'INFO_CHECK', roomCode: this.opts.roomCode });
    for (const seat of this.opts.seats) if (!seat.isBot) this.opts.send(seat.playerId, { t: 'm.private', playerId: seat.playerId, skins: seat.skins });
    // Deliberate invalid personal emission must remain fenced for observers.
    for (const id of this.opts.spectators) this.opts.send(id, { t: 'm.private', skins: skin });
  }
  onReconnect(id) { this.opts.send(id, { t: 'm.private', playerId: id, skins: this.opts.seats.find(s => s.playerId === id)?.skins }); }
  onDisconnect() {}
  onLeave() {}
  addSpectator(id) { this.opts.send(id, { t: 'm.public', phase: 'INFO_CHECK' }); }
  dispose() {}
}
function channel() { return { messages: [], send(m) { this.messages.push(m); return true; }, sendEncoded(t, raw) { this.messages.push(JSON.parse(raw)); return true; }, close() {} }; }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function lobbyFixture(t) {
  const registry = new SessionRegistry(), calls = [];
  const platform = { build: 'capacity-build', protocol: 1, resume() { return true; }, release() { return Promise.resolve(true); }, deliverEnd() { return true; },
    prepare(spec, context) { const work = deferred(); calls.push({ spec, context, work }); return work.promise; } };
  const lobby = new ClusterLobby({ registry, platform, getData: () => ({}), seedFn: () => 13 });
  t.after(() => lobby.shutdown());
  let counter = 0;
  const player = () => {
    const s = registry.create(`Cluster${++counter}`); s.connected = true; s.messages = []; s.playerCapacityVersion = PLAYER_CAPACITY_VERSION; s.matchmakingVersion = MATCHMAKING_VERSION;
    s.ws = { readyState: 1, bufferedAmount: 0, send(raw, cb) { s.messages.push(JSON.parse(raw)); cb?.(); } }; return s;
  };
  const room = (capacity, size = 1) => {
    const members = Array.from({ length: size }, player), host = members[0];
    assert.deepEqual(lobby.create(host, { mode: 'coop', difficulty: 'NORMAL', experimental: options(capacity) }), { ok: true });
    const room = lobby.roomOf(host);
    for (const p of members.slice(1)) { assert.deepEqual(lobby.join(p, { code: room.code }), { ok: true }); lobby.ready(p, { ready: true }); }
    return { room, host, members };
  };
  const complete = (call = calls.at(-1), extra = {}) => {
    const counts = { abort: 0, commit: 0, publish: 0 };
    call.work.resolve({ assignmentId: call.spec.assignmentId, nodeId: 'node', generation: 'epoch',
      commit() { counts.commit++; }, publish() { counts.publish++; return true; }, abort() { counts.abort++; return Promise.resolve(true); }, ...extra }); return counts;
  };
  return { lobby, registry, calls, player, room, complete };
}

test('Directory human admission derives approved capacity, binds it to assignment identity and never trusts bare capacity', () => {
  const d = new ClusterDirectory();
  d.register({ nodeId: 'node', generation: 'epoch', build: 'capacity-build', protocol: 1 });
  d.heartbeat('node', { generation: 'epoch', ready: true, matches: 0 });
  const request = { assignmentId: 'twenty', roomCode: 'ABCD', sessionIds: seats(20).map(s => s.playerId), build: 'capacity-build', protocol: 1 };
  assert.throws(() => d.prepare({ ...request, capacity: 20 }), TypeError);
  assert.equal(d.rooms.size, 0); assert.equal(d.sessions.size, 0);
  assert.throws(() => d.prepare({ ...request, experimental: options(21) }), TypeError);
  assert.throws(() => d.prepare({ ...request, experimental: options(20), sessionIds: [...request.sessionIds, 'overflow'] }), TypeError);
  const input = { ...request, mode: 'coop', experimental: options(20) }, view = d.prepare(input);
  input.experimental.playerCapacity = 8;
  assert.equal(view.experimental.playerCapacity, 20); assert.ok(Object.isFrozen(view.experimental));
  assert.throws(() => d.prepare({ ...request, mode: 'coop', experimental: options(8) }), e => e.code === 'ASSIGNMENT_CONFLICT' || e instanceof TypeError);
  d.commit(view.assignmentId);
  assert.equal(d.bySession('p19').assignmentId, view.assignmentId);
  assert.equal(d.detachPlayer(view.assignmentId, 'p19'), true); assert.equal(d.bySession('p19'), null);
  assert.throws(() => d.attachSpectator(view.assignmentId, 'p19'), e => e.code === 'ROLE_CONFLICT');
  assert.equal(d.release(view.assignmentId), true); assert.equal(d.sessions.size, 0);
  // Even a small roster's policy is part of the idempotency identity.
  const small = { ...request, assignmentId: 'small', sessionIds: ['new-player'], experimental: options(20) };
  d.prepare(small);
  assert.throws(() => d.prepare({ ...small, experimental: options(16) }), e => e.code === 'ASSIGNMENT_CONFLICT');
});

test('GameHost admits approved twenty seats and keeps skin/private maps and high-seat reconnect fences', t => {
  const host = new GameHost({ MatchClass: PrivateMatch }); t.after(() => host.close());
  const input = spec(), view = host.prepare(input), clients = new Map([...input.seats.map(s => s.playerId), 'observer'].map(id => [id, channel()]));
  input.experimental.playerCapacity = 8;
  assert.equal(view.experimental.playerCapacity, 20); assert.ok(Object.isFrozen(view.experimental));
  for (const [id, c] of clients) host.bind(view.assignmentId, id, c);
  host.commit(view.assignmentId);
  for (const [id, c] of clients) {
    const privateFrames = c.messages.filter(m => m.t === 'm.private');
    if (id === 'observer') assert.equal(privateFrames.length, 0);
    else { assert.equal(privateFrames.length, 1); assert.equal(privateFrames[0].playerId, id); assert.deepEqual(privateFrames[0].skins, skin); }
  }
  const replacement = channel(); host.bind(view.assignmentId, 'p19', replacement);
  assert.equal(replacement.messages.at(-1).playerId, 'p19');
  assert.equal(host.handle(view.assignmentId, 'p19', { t: 'g.leave' }, clients.get('p19')).error, ERR.NOT_IN_ROOM);
  assert.equal(host.addSpectator(view.assignmentId, 'p19').error, ERR.BAD_TARGET);
  assert.throws(() => host.prepare(spec({ seats: [seats(20)[0]], experimental: options(16) })), e => e.code === 'ASSIGNMENT_CONFLICT');
});

for (const [name, patch] of [
  ['unapproved fifth', { experimental: undefined, seats: seats(5) }],
  ['unapproved high index', { experimental: undefined, seats: [{ ...seats(1)[0], seat: 4 }] }],
  ['capacity overflow', { experimental: options(8), seats: [{ ...seats(1)[0], seat: 8 }] }],
  ['twenty plus one', { seats: seats(21) }],
  ['duplicate identities', { seats: [seats(2)[0], { ...seats(2)[1], playerId: 'p0' }] }],
  ['duplicate seats', { seats: [seats(2)[0], { ...seats(2)[1], seat: 0 }] }],
  ['AI spoof', { seats: [{ ...seats(1)[0], playerId: 'ai_fake', isBot: false }] }],
  ['human spoof', { seats: [{ ...seats(1)[0], isBot: true }] }],
  ['spectator overlap', { spectators: ['p19'] }],
  ['AI spectator', { spectators: ['ai_observer'] }],
  ['solo high index', { mode: 'solo', modeId: 'mode_single_normal', seats: [{ ...seats(1)[0], seat: 1 }], spectators: [] }],
]) test(`GameHost refuses ${name} before actor construction`, () => {
  let constructions = 0;
  class Forbidden { constructor() { constructions++; } }
  const host = new GameHost({ MatchClass: Forbidden });
  assert.throws(() => host.prepare(spec(patch)), e => e.code === 'INVALID_SPEC');
  assert.equal(constructions, 0); assert.equal(host.contexts.size, 0); host.close();
});

test('GameHost capacity alone participates in immutable identity even with one human, while explicit default four canonicalizes', t => {
  const host = new GameHost({ MatchClass: PrivateMatch }); t.after(() => host.close());
  const input = spec({ assignmentId: 'one-large', seats: seats(1) });
  host.prepare(input);
  assert.throws(() => host.prepare({ ...input, experimental: options(16) }), e => e.code === 'ASSIGNMENT_CONFLICT');
  const ordinary = spec({ assignmentId: 'ordinary', seats: seats(1), experimental: { revivalEnabled: false, disableSharedPool: false } });
  const view = host.prepare(ordinary);
  assert.equal(host.prepare({ ...ordinary, experimental: options(4) }), view);
  assert.equal(Object.hasOwn(view.experimental, 'playerCapacity'), false);
});

test('cluster refused occupied shrink does not cancel twenty-human prepare, while high-seat kick cancels and compensates', async t => {
  const f = lobbyFixture(t), a = f.room(20, 20), starting = f.lobby.start(a.host), call = f.calls[0];
  assert.equal(f.lobby.setExperimental(a.host, { experimental: options(16) }).error, ERR.ROOM_FULL);
  assert.equal(call.context.signal.aborted, false); assert.equal(call.context.isCurrent(), true);
  const counts = f.complete(call); assert.deepEqual(await starting, { ok: true });
  assert.deepEqual(counts, { abort: 0, commit: 1, publish: 1 }); assert.equal(a.room.capacity, 20);
  const b = f.room(20, 20), next = f.lobby.start(b.host), nextCall = f.calls[1], high = b.members[19];
  assert.deepEqual(f.lobby.kick(b.host, { seat: 19, playerId: high.playerId }), { ok: true });
  assert.equal(nextCall.context.signal.aborted, true); assert.ok((await next).error);
  const cancelled = f.complete(nextCall); await nextTurn();
  assert.deepEqual(cancelled, { abort: 1, commit: 0, publish: 0 });
  assert.equal(b.room.seats[19], null); assert.equal(high.roomCode, null); assert.equal(b.room.seats[18].seat, 18);
});

test('cluster expansion cancels prepare immediately and compensates late actor without reverting new options', async t => {
  const f = lobbyFixture(t), { room, host } = f.room(8), starting = f.lobby.start(host), call = f.calls[0];
  assert.equal(call.spec.experimental.playerCapacity, 8);
  assert.deepEqual(f.lobby.setExperimental(host, { experimental: options(20) }), { ok: true });
  assert.equal(call.context.signal.aborted, true); assert.ok((await starting).error);
  const counts = f.complete(call); await nextTurn();
  assert.deepEqual(counts, { abort: 1, commit: 0, publish: 0 });
  assert.equal(room.match, null); assert.equal(room.capacity, 20); assert.equal(room.seats.length, 20);
});

for (const mutation of ['options', 'client capability', 'observer capability', 'high seat', 'skins', 'factory capacity', 'commit failure']) test(`cluster twenty-seat ${mutation} CAS/rollback preserves the original friend room`, async t => {
  const f = lobbyFixture(t), { room, host, members } = f.room(20, 20), array = room.seats, observer = f.player();
  assert.deepEqual(f.lobby.spectate(observer, { code: room.code }), { ok: true });
  const starting = f.lobby.start(host), call = f.calls[0];
  assert.equal(call.spec.seats.length, 20); assert.equal(call.context.isCurrent(), true);
  if (mutation === 'options') room.experimental = Object.freeze(options(16));
  if (mutation === 'client capability') members[19].playerCapacityVersion = null;
  if (mutation === 'observer capability') observer.playerCapacityVersion = null;
  if (mutation === 'high seat') room.seats[19].seat = 18;
  if (mutation === 'skins') { members[19].skins = Object.freeze(skin); room.seats[19].skins = members[19].skins; }
  if (mutation === 'factory capacity') {
    const factory = f.lobby.createMatch.bind(f.lobby);
    f.lobby.createMatch = opts => factory({ ...opts, experimental: options(16) });
  }
  const counts = f.complete(call, mutation === 'commit failure' ? { commit() { throw new Error('capacity fixture commit failure'); } } : {});
  assert.ok((await starting).error); await nextTurn();
  assert.equal(counts.abort, 1); assert.equal(counts.publish, 0);
  assert.equal(room.match, null); assert.equal(room.matchCount, 0); assert.equal(room.seats, array);
  assert.equal(room.disposed, false); assert.equal(f.lobby.rooms.get(room.code), room);
  assert.ok(members.every(s => s.roomCode === room.code));
  assert.ok(members.every(s => !s.messages.some(m => m.inMatch === true)));
});

test('ended cluster public room rejects large capacity before mutating options or creating an actor', async t => {
  const f = lobbyFixture(t), players = Array.from({ length: 4 }, f.player);
  for (const p of players) assert.deepEqual(f.lobby.queue.join(p, { difficulty: 'NORMAL' }), { ok: true });
  for (const p of players) assert.deepEqual(f.lobby.queue.accept(p, f.lobby.queue.state(p)), { ok: true });
  const call = f.calls[0]; f.complete(call); await nextTurn();
  const room = f.lobby.roomOf(players[0]); assert.equal(room.source, 'matchmaking');
  assert.equal(f.lobby.receiveEnd(call.spec.assignmentId, { assignmentId: call.spec.assignmentId, roomCode: room.code, generation: 'epoch', lastPublic: null, results: {}, summary: {} }), true);
  assert.equal(room.match, null);
  const before = structuredClone(room.toState()), seats = room.seats, replay = room.replay;
  assert.equal(f.lobby.setExperimental(players[0], { experimental: options(20) }).error, ERR.BAD_MSG);
  assert.deepEqual(room.toState(), before); assert.equal(room.seats, seats); assert.equal(room.replay, replay); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.lobby.setExperimental(players[0], { experimental: { revivalEnabled: true, disableSharedPool: true } }), { ok: true });
  assert.equal(room.capacity, 4);
});

test('cluster party rejects unready nonhost then rechecks readiness during four-player prepare', async t => {
  const f = lobbyFixture(t), { room, host, members } = f.room(4, 2), solos = [f.player(), f.player()];
  f.lobby.ready(members[1], { ready: false });
  assert.equal(f.lobby.queue.join(host, { difficulty: 'NORMAL', party: true }).error, ERR.NOT_READY);
  assert.equal(f.lobby.queue.size, 0); assert.equal(f.calls.length, 0);
  f.lobby.ready(members[1], { ready: true });
  assert.deepEqual(f.lobby.queue.join(host, { difficulty: 'NORMAL', party: true }), { ok: true });
  for (const p of solos) f.lobby.queue.join(p, { difficulty: 'NORMAL' });
  for (const p of [...members, ...solos]) f.lobby.queue.accept(p, f.lobby.queue.state(p));
  const call = f.calls[0]; assert.ok(call.context.isCurrent());
  room.seats[1].ready = false; assert.equal(call.context.isCurrent(), false);
  const counts = f.complete(call); await nextTurn();
  assert.equal(counts.abort, 1); assert.equal(counts.publish, 0); assert.equal(room.disposed, false); assert.equal(room.match, null);
});

for (const capacity of PLAYER_CAPACITIES) test(`cluster ${capacity}-mode parties prepare privately then commit the full cohort once`, async t => {
  const f = lobbyFixture(t), a = f.room(capacity, 1), b = f.room(capacity, capacity - 1), members = [...a.members, ...b.members];
  for (const group of [a, b]) assert.deepEqual(f.lobby.queue.join(group.host, { difficulty: 'NORMAL', party: true }), { ok: true });
  for (const p of members) assert.deepEqual(f.lobby.queue.accept(p, f.lobby.queue.state(p)), { ok: true });
  const call = f.calls[0]; assert.equal(f.calls.length, 1); assert.equal(call.spec.seats.length, capacity);
  assert.equal(call.spec.experimental.playerCapacity ?? 4, capacity);
  assert.ok(call.context.isCurrent()); assert.equal(a.room.match, null); assert.equal(b.room.match, null);
  assert.ok(members.every(p => f.lobby.queue.state(p).allocationPending && f.lobby.queue.state(p).required === capacity));
  const counts = f.complete(call); await nextTurn();
  assert.deepEqual(counts, { abort: 0, commit: 1, publish: 1 });
  const room = f.lobby.roomOf(a.host); assert.equal(room.capacity, capacity); assert.equal(room.source, 'matchmaking');
  assert.deepEqual(room.seats.map(s => s.seat), Array.from({ length: capacity }, (_, i) => i));
  assert.ok(members.every(p => p.roomCode === room.code && f.lobby.queue.state(p).state === 'matched' && f.lobby.queue.state(p).required === capacity));
  assert.equal(a.room.disposed, true); assert.equal(b.room.disposed, true);
});

for (const cause of ['cancel', 'client capability', 'observer capability', 'ready', 'rules', 'offer capacity', 'commit failure']) {
  test(`cluster twenty-mode ${cause} during preparation compensates without consuming either room`, async t => {
    const f = lobbyFixture(t), a = f.room(20, 8), b = f.room(20, 12), members = [...a.members, ...b.members], observer = f.player();
    f.lobby.spectate(observer, { code: a.room.code });
    for (const group of [a, b]) f.lobby.queue.join(group.host, { difficulty: 'NORMAL', party: true });
    for (const p of members) f.lobby.queue.accept(p, f.lobby.queue.state(p));
    const call = f.calls[0], oldSeats = [a.room.seats, b.room.seats];
    assert.equal(call.spec.seats.length, 20); assert.ok(call.context.isCurrent());
    if (cause === 'cancel') f.lobby.queue.cancel(a.members[7], f.lobby.queue.state(a.members[7]));
    if (cause === 'client capability') b.members.at(-1).playerCapacityVersion = 'capacity-1';
    if (cause === 'observer capability') observer.playerCapacityVersion = 'capacity-1';
    if (cause === 'ready') b.room.seats[11].ready = false;
    if (cause === 'rules') a.room.experimental = Object.freeze(options(16));
    if (cause === 'offer capacity') f.lobby.queue.offers.get(f.lobby.queue.state(a.host).offerId).required = 16;
    const counts = f.complete(call, cause === 'commit failure' ? { commit() { throw new Error('fixture commit failure'); } } : {});
    await nextTurn(); await nextTurn();
    assert.equal(counts.abort, 1); assert.equal(counts.publish, 0); assert.equal(f.lobby.queue.offers.size, 0);
    for (const [i, group] of [a, b].entries()) {
      assert.equal(f.lobby.rooms.get(group.room.code), group.room); assert.equal(group.room.disposed, false);
      assert.equal(group.room.match, null); assert.equal(group.room.seats, oldSeats[i]);
      assert.ok(group.members.every(p => p.roomCode === group.room.code && !p.messages.some(m => m.inMatch)));
    }
    assert.equal(observer.roomCode, a.room.code);
  });
}

function executableAssignment(kind) {
  let reads = 0;
  const input = spec({ seats: seats(5), experimental: options(8) });
  const accessor = (target, key, value) => Object.defineProperty(target, key, { enumerable: true, configurable: true, get() { reads++; return value(); } });
  if (kind === 'changing experimental getter') accessor(input, 'experimental', () => options(reads <= 8 ? 8 : 4));
  if (kind === 'top build getter') accessor(input, 'build', () => 'capacity-build');
  if (kind === 'seat index getter') accessor(input.seats[0], 'seat', () => 0);
  if (kind === 'seat skins getter') accessor(input.seats[0], 'skins', () => skin);
  if (kind === 'top custom prototype') Object.setPrototypeOf(input, { foreign: true });
  if (kind === 'seat custom prototype') Object.setPrototypeOf(input.seats[0], { foreign: true });
  if (kind === 'top hidden unknown field') Object.defineProperty(input, 'unapproved', { value: 20 });
  if (kind === 'seat hidden unknown field') Object.defineProperty(input.seats[0], 'unapproved', { value: 20 });
  if (kind === 'top symbol') input[Symbol('unapproved')] = 20;
  if (kind === 'seat symbol') input.seats[0][Symbol('unapproved')] = 20;
  if (kind === 'top symbol accessor') accessor(input, Symbol('unapproved'), () => 20);
  if (kind === 'array index getter') accessor(input.seats, '0', () => seats(1)[0]);
  if (kind === 'array iterator getter') accessor(input.seats, Symbol.iterator, () => Array.prototype[Symbol.iterator]);
  if (kind === 'nested loadout getter') {
    input.seats[0].loadout = { unit: { skill: 1, module: null } };
    accessor(input.seats[0].loadout.unit, 'skill', () => 1);
  }
  if (kind === 'nested skin getter') accessor(input.seats[0].skins, Object.keys(skin)[0], () => Object.values(skin)[0]);
  return { input, reads: () => reads };
}
for (const kind of ['changing experimental getter', 'top build getter', 'seat index getter', 'seat skins getter', 'top custom prototype', 'seat custom prototype',
  'top hidden unknown field', 'seat hidden unknown field', 'top symbol', 'seat symbol', 'top symbol accessor', 'array index getter', 'array iterator getter', 'nested loadout getter', 'nested skin getter']) {
  test(`descriptor-first GameHost/Platform reject ${kind} without getter, reservation, RPC or callback`, async t => {
    const hostile = executableAssignment(kind);
    let constructions = 0, callbacks = 0, rpc = 0, reservations = 0;
    class Forbidden { constructor() { constructions++; } }
    const host = new GameHost({ MatchClass: Forbidden, now() { callbacks++; return 100; }, onEnd() { callbacks++; } }); t.after(() => host.close());
    assert.throws(() => host.prepare(hostile.input), e => e.code === 'INVALID_SPEC');
    assert.equal(hostile.reads(), 0); assert.equal(constructions, 0); assert.equal(callbacks, 0); assert.equal(host.contexts.size, 0);
    const directory = new ClusterDirectory();
    directory.register({ nodeId: 'node', generation: 'epoch', build: 'capacity-build', protocol: 1 });
    directory.heartbeat('node', { generation: 'epoch', ready: true, matches: 0 });
    const admission = directory.prepare.bind(directory);
    directory.prepare = (...args) => { reservations++; return admission(...args); };
    const platform = new RemoteGamePlatform({ directory, nodes: [{ nodeId: 'node', key: Buffer.alloc(32, 3), client: { close() {}, async call() { rpc++; throw new Error('invalid input must never reach RPC'); } } }],
      build: 'capacity-build', protocol: 1, sendControl() { callbacks++; return true; } }); t.after(() => platform.close());
    await assert.rejects(platform.prepare(hostile.input), TypeError);
    assert.equal(hostile.reads(), 0); assert.equal(reservations, 0); assert.equal(rpc, 0); assert.equal(callbacks, 0);
    assert.equal(directory.assignments.size, 0); assert.equal(directory.rooms.size, 0); assert.equal(directory.sessions.size, 0); assert.equal(platform.contexts.size, 0);
  });
}

test('descriptor snapshots retain plain/null-prototype object admission and stable immutable capacity/keys', t => {
  const host = new GameHost({ MatchClass: PrivateMatch }); t.after(() => host.close());
  const input = spec({ seats: seats(5), experimental: options(8) });
  Object.setPrototypeOf(input, null);
  for (const seat of input.seats) {
    Object.setPrototypeOf(seat, null); Object.setPrototypeOf(seat.skins, null);
    seat.loadout = Object.assign(Object.create(null), { unit: Object.assign(Object.create(null), { skill: 1, module: null }) });
  }
  const view = host.prepare(input); assert.equal(view.experimental.playerCapacity, 8); assert.equal(view.seats.length, 5);
  input.experimental.playerCapacity = 4; input.seats[0].loadout.unit.skill = 2;
  assert.equal(view.experimental.playerCapacity, 8); assert.equal(view.seats[0].loadout.unit.skill, 1);
  assert.deepEqual(Object.keys(view.seats[0]).sort(), ['connected', 'isBot', 'loadout', 'name', 'playerId', 'seat', 'skins'].sort());
  assert.ok(Object.isFrozen(view.experimental)); assert.ok(Object.isFrozen(view.seats[0].loadout.unit));
});

async function until(check) {
  const end = Date.now() + 3000;
  while (!check()) { if (Date.now() >= end) throw new Error('capacity localhost deadline'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function networkFixture(t) {
  const node = await startGameNode({ nodeId: 'capacity-node', generation: 'capacity-epoch', build: 'capacity-build', protocol: 1,
    key: Buffer.alloc(32, 42), MatchClass: PrivateMatch });
  const channels = new Map(), controls = [];
  const platform = new RemoteGamePlatform({ nodes: [{ nodeId: 'capacity-node', key: Buffer.alloc(32, 42), url: node.url }], build: 'capacity-build', protocol: 1,
    sendControl(id, frame) {
      controls.push({ id, type: frame.t }); // no credentials are recorded
      if (frame.t === 'cluster.prepare') {
        const previous = channels.get(id), socket = new WebSocket(node.url.replace(/^http:/, 'ws:') + '/_cluster/game');
        const channel = { socket, messages: previous?.messages || [], bound: false }; channels.set(id, channel);
        socket.on('error', () => {});
        socket.on('open', () => socket.send(JSON.stringify({ t: 'cluster.bind', assignmentId: frame.assignmentId, sessionId: id, ticket: frame.ticket })));
        socket.on('message', raw => {
          const message = JSON.parse(raw);
          if (message.t === 'cluster.bound') { channel.bound = true; previous?.socket.close(); }
          else channel.messages.push(message);
        });
      }
      if (frame.t === 'cluster.abort' || frame.t === 'cluster.terminate') channels.get(id)?.socket.close();
      return true;
    } });
  t.after(async () => { await platform.close(); for (const c of channels.values()) c.socket.terminate(); await node.close(); });
  await platform.refresh(); return { node, platform, channels, controls };
}

test('actual unchanged private HTTP/RPC and WS admit twenty humans, preserve observer skin privacy and high-seat owner resume', async t => {
  const f = await networkFixture(t), handle = await f.platform.prepare(spec());
  assert.equal(f.channels.size, 21); assert.equal(f.node.gameHost.get(handle.assignmentId).seats.length, 20);
  assert.equal(f.platform.contexts.get(handle.assignmentId).spec.experimental.playerCapacity, 20);
  handle.commit(); handle.publish(); await f.platform.contexts.get(handle.assignmentId).publication;
  assert.equal(f.platform.directory.bySession('p19').assignmentId, handle.assignmentId);
  await until(() => [...f.channels].every(([id, c]) => c.messages.some(m => m.t === (id === 'observer' ? 'm.public' : 'm.private'))));
  for (const [id, c] of f.channels) {
    const privateFrames = c.messages.filter(m => m.t === 'm.private');
    if (id === 'observer') assert.equal(privateFrames.length, 0);
    else assert.ok(privateFrames.every(m => m.playerId === id && JSON.stringify(m.skins) === JSON.stringify(skin)));
  }
  const old = f.channels.get('p19'); old.socket.close();
  assert.equal(f.platform.resume(handle.assignmentId, 'p19'), true);
  await until(() => f.channels.get('p19') !== old && f.channels.get('p19').bound);
  assert.equal(f.platform.directory.bySession('p19').nodeId, handle.nodeId);
  assert.equal(f.node.gameHost.stats().matches, 1);
  assert.ok(f.controls.every(frame => frame.type.startsWith('cluster.')));
});

test('actual cluster twenty-mode party match binds all humans, preserves observer privacy and resumes seat nineteen', async t => {
  const f = await networkFixture(t), registry = new SessionRegistry();
  const lobby = new ClusterLobby({ registry, platform: f.platform, getData: () => ({}), seedFn: () => 17 });
  t.after(() => lobby.shutdown());
  const players = Array.from({ length: 21 }, (_, i) => {
    const s = registry.create(`PartyWire${i}`); s.connected = true; s.playerCapacityVersion = PLAYER_CAPACITY_VERSION;
    s.matchmakingVersion = MATCHMAKING_VERSION; s.skins = Object.freeze({ ...skin }); s.messages = [];
    s.ws = { readyState: 1, bufferedAmount: 0, send(raw, cb) { s.messages.push(JSON.parse(raw)); cb?.(); } }; return s;
  });
  const members = players.slice(0, 20), observer = players[20], groups = [members.slice(0, 7), members.slice(7)];
  const old = groups.map(group => {
    assert.deepEqual(lobby.create(group[0], { mode: 'coop', difficulty: 'NORMAL', experimental: options(20) }), { ok: true });
    const room = lobby.roomOf(group[0]);
    for (const p of group.slice(1)) { assert.deepEqual(lobby.join(p, { code: room.code }), { ok: true }); lobby.ready(p, { ready: true }); }
    return room;
  });
  assert.deepEqual(lobby.spectate(observer, { code: old[0].code }), { ok: true });
  for (const group of groups) assert.deepEqual(lobby.queue.join(group[0], { difficulty: 'NORMAL', party: true }), { ok: true });
  for (const p of members) assert.deepEqual(lobby.queue.accept(p, lobby.queue.state(p)), { ok: true });
  await until(() => lobby.queue.state(members[0]).state === 'matched');
  const room = lobby.roomOf(members[0]), assignment = f.platform.directory.bySession(members[19].playerId);
  assert.equal(room.capacity, 20); assert.equal(room.seats.length, 20); assert.equal(room.seats[19].playerId, members[19].playerId);
  assert.ok(old.every(r => r.disposed)); assert.equal(observer.roomCode, room.code);
  assert.ok(members.every(p => lobby.queue.state(p).required === 20));
  assert.equal(f.node.gameHost.get(assignment.assignmentId).seats.length, 20);
  await until(() => players.every(p => f.channels.get(p.playerId)?.messages.some(m => m.t === (p === observer ? 'm.public' : 'm.private'))));
  for (const p of players) {
    const messages = f.channels.get(p.playerId).messages.filter(m => m.t === 'm.private');
    if (p === observer) assert.equal(messages.length, 0);
    else assert.ok(messages.length > 0 && messages.every(m => m.playerId === p.playerId && JSON.stringify(m.skins) === JSON.stringify(skin)));
  }
  const high = members[19], original = f.channels.get(high.playerId); original.socket.close();
  assert.equal(f.platform.resume(assignment.assignmentId, high.playerId), true);
  await until(() => f.channels.get(high.playerId) !== original && f.channels.get(high.playerId).bound);
  assert.equal(f.platform.directory.bySession(high.playerId).assignmentId, assignment.assignmentId);
  assert.equal(f.node.gameHost.stats().matches, 1);
});

test('twenty maximally sized structural preference maps fit prepare while individual messages stay below 64 KiB', () => {
  const id = i => (`unit_${i}_`).padEnd(64, 'x'), choices = {};
  for (const skin of OPERATOR_SKINS) if (!choices[skin.charId] || skin.id.length > choices[skin.charId].length) choices[skin.charId] = skin.id;
  const preferences = {
    loadout: Object.fromEntries(Array.from({ length: LOADOUT_LIMITS.entries }, (_, i) => [id(i), { skill: 9, module: id(i) }])),
    ops: Object.fromEntries(Array.from({ length: LOADOUT_LIMITS.ops }, (_, i) => [id(i), { potential: 1, cultivate: 0 }])),
    notOwned: Array.from({ length: OWNERSHIP_LIMITS.notOwned }, (_, i) => id(i)),
    diy: Object.fromEntries(Array.from({ length: DIY_LIMITS.slots }, (_, i) => [id(i), { charId: id(i), skillIndex: 9, uniEquipId: id(i) }])),
    skins: Object.fromEntries(Object.entries(choices).slice(0, SKIN_LIMITS.choices)),
  };
  // Synthetic longest IDs bound the wire shape; only skins need the real catalogue.
  // This is not a claim that these unknown operator IDs pass semantic admission.
  for (const message of [
    { t: 'room.loadout', entries: preferences.loadout, ops: preferences.ops },
    { t: 'room.ownership', notOwned: preferences.notOwned },
    { t: 'room.diy', picks: preferences.diy },
    { t: 'room.skins', choices: preferences.skins },
  ]) {
    assert.equal(validateC2S(message), null);
    assert.ok(Buffer.byteLength(JSON.stringify({ ...message, rid: 2 ** 31 })) <= 64 * 1024);
  }
  const safe = copyAssignmentSpec(spec({ spectators: [], seats: seats(20).map((seat, i) => ({ ...seat, ...preferences, playerId: id(i + 1000), name: '中'.repeat(12) })) }));
  const bytes = Buffer.byteLength(JSON.stringify({ id: '0'.repeat(32), op: 'prepare', payload: safe }));
  assert.ok(bytes > 64 * 1024); assert.ok(bytes <= PREPARE_MAX_BYTES);
});

test('twenty individually valid loadouts over 64 KiB start atomically through the bounded prepare route', async t => {
  const f = await networkFixture(t), registry = new SessionRegistry();
  const lobby = new ClusterLobby({ registry, platform: f.platform, getData: () => ({}) }); t.after(() => lobby.shutdown());
  const loadout = Object.fromEntries(Array.from({ length: 160 }, (_, i) => [`unit_${i}`, { skill: 1, module: 'module'.repeat(8) }]));
  const members = Array.from({ length: 20 }, (_, i) => {
    const s = registry.create(`Budget${i}`); s.connected = true; s.playerCapacityVersion = PLAYER_CAPACITY_VERSION; s.loadout = loadout;
    s.ws = { readyState: 1, bufferedAmount: 0, send(raw, cb) { cb?.(); } }; return s;
  });
  lobby.create(members[0], { mode: 'coop', difficulty: 'NORMAL', experimental: options(20) }); const room = lobby.roomOf(members[0]);
  for (const p of members.slice(1)) { lobby.join(p, { code: room.code }); lobby.ready(p, { ready: true }); }
  const array = room.seats, pending = lobby.start(members[0]);
  assert.deepEqual(await pending, { ok: true });
  assert.ok(room.match); assert.equal(room.seats, array); assert.equal(room.matchCount, 1);
  const assignment = f.platform.directory.byRoom(room.code);
  await f.platform.contexts.get(assignment.assignmentId).publication;
  const actor = f.node.gameHost.contexts.get(assignment.assignmentId);
  assert.equal(actor.state, 'committed'); assert.equal(actor.match.opts.seats.length, 20);
  assert.ok(actor.match.opts.seats.every(seat => JSON.stringify(seat.loadout) === JSON.stringify(loadout)));
  assert.equal(f.platform.directory.rooms.size, 1); assert.equal(f.platform.directory.sessions.size, 20);
  assert.equal(f.platform.contexts.size, 1); assert.equal(f.node.gameHost.contexts.size, 1);
  assert.equal(f.controls.filter(frame => frame.type === 'cluster.prepare').length, 20);
});

test('prepare envelopes exceeding the finite 2 MiB budget fail before reservations, channels or actors', async t => {
  const f = await networkFixture(t);
  const spectators = Array.from({ length: 32000 }, (_, i) => (`observer_${i}_`).padEnd(64, 'x'));
  await assert.rejects(f.platform.prepare(spec({ spectators })), error => error.code === 'TOO_LARGE');
  assert.equal(f.platform.directory.rooms.size, 0); assert.equal(f.platform.directory.sessions.size, 0);
  assert.equal(f.platform.contexts.size, 0); assert.equal(f.node.gameHost.contexts.size, 0);
  assert.equal(f.controls.length, 0); assert.equal(f.channels.size, 0);
});
