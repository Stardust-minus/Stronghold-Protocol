import test from 'node:test';
import assert from 'node:assert/strict';
import { ClusterLobby } from '../server/cluster/lobby.js';
import { GameHost, GameHostError } from '../server/cluster/game-host.js';
import { RemoteGamePlatform } from '../server/cluster/platform.js';
import { SessionRegistry } from '../server/net.js';
import { Match } from '../server/match/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { DATA } from './match/harness.js';
import { OPERATOR_SKINS } from '../shared/skins.js';
import { ERR, PHASE, MATCHMAKING_VERSION } from '../shared/constants.js';

const CHAR = 'char_103_angel', A = OPERATOR_SKINS[0].id, B = OPERATOR_SKINS[1].id;
const choices = (skin = A) => ({ [CHAR]: skin });
const quiet = { info() {}, warn() {}, error() {} };
const spec = extra => ({ assignmentId: 'skins-assignment', roomCode: 'ABCD', build: 'skin-fixture', protocol: 1,
  seed: 71, matchNo: 1, mode: 'coop', difficulty: 'NORMAL', modeId: 'mode_multi_normal',
  seats: [{ seat: 0, playerId: 'p1', name: 'P1', isBot: false, connected: true, skins: choices() },
    { seat: 1, playerId: 'p2', name: 'P2', isBot: false, connected: true, skins: choices(B) }], spectators: ['s1'], ...extra });
const channel = () => ({ sent: [], send(msg) { this.sent.push(msg); return true; }, sendEncoded(type, raw) { this.sent.push(JSON.parse(raw)); return true; }, close() {} });
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

// These fixtures are entirely in-process; no network listener or external RPC is started.
function lobbyFixture(t) {
  const registry = new SessionRegistry(), calls = [], peers = [];
  const platform = { build: 'skin-fixture', protocol: 1,
    prepare(spec, context) { const work = deferred(); calls.push({ spec, context, work }); return work.promise; },
    resume() { return true; }, release() { return Promise.resolve(true); }, deliverEnd() { return true; },
    peer(assignmentId, method, playerId, value) { const work = deferred(); peers.push({ assignmentId, method, playerId, value, work }); return work.promise; },
  };
  const lobby = new ClusterLobby({ registry, platform, getData: () => DATA, log: quiet });
  t.after(() => lobby.shutdown());
  let counter = 0;
  const player = () => {
    const s = registry.create(`Skin${++counter}`); s.connected = true; s.messages = []; s.matchmakingVersion = MATCHMAKING_VERSION;
    s.ws = { readyState: 1, bufferedAmount: 0, send(raw, cb) { s.messages.push(JSON.parse(raw)); cb?.(); } };
    lobby.onHello(s, { resumed: false, repeat: false }); return s;
  };
  const complete = () => { const c = calls.at(-1); c.work.resolve({ assignmentId: c.spec.assignmentId, nodeId: 'node', generation: 'epoch', commit() { return { ownerAvailable: true }; }, publish() { return true; }, abort() { return Promise.resolve(true); } }); };
  return { lobby, player, calls, peers, complete };
}

test('cluster private admission freezes/copies choices; asynchronous skin ACK is returned, spectators never invoke it', async t => {
  const f = lobbyFixture(t), p = f.player();
  f.lobby.skins(p, { choices: choices() }); f.lobby.create(p, { mode: 'solo', difficulty: 'NORMAL' });
  const room = f.lobby.roomOf(p), starting = f.lobby.start(p);
  assert.deepEqual(f.calls[0].spec.seats[0].skins, choices());
  assert.ok(Object.isFrozen(f.lobby.manualPending.get(room.code).dto.seats[0].skins));
  assert.ok(Object.isFrozen(f.lobby.manualPending.get(room.code).spec.seats[0].skins));
  f.complete(); assert.deepEqual(await starting, { ok: true });
  const result = f.lobby.onMessage(p, { t: 'room.skins', choices: choices(B) });
  assert.equal(typeof result.then, 'function'); assert.equal(f.peers.at(-1).method, 'setSkins');
  assert.deepEqual(f.peers.at(-1).value, choices(B)); assert.ok(Object.isFrozen(f.peers.at(-1).value));
  f.peers.at(-1).work.resolve({ error: ERR.WRONG_PHASE }); assert.equal((await result).error, ERR.WRONG_PHASE);
  assert.deepEqual(p.skins, choices(B)); assert.deepEqual(room.seatOf(p.playerId).skins, choices(B));
  const again = f.lobby.skins(p, { choices: {} }); f.peers.at(-1).work.resolve({ ok: true });
  assert.deepEqual(await again, { ok: true });
  assert.equal(JSON.stringify(room.toState()).includes('skins'), false);
});

test('cluster public 2+1+1 carries each preference and aborts stale in-flight changes before publication', async t => {
  const f = lobbyFixture(t), players = Array.from({ length: 4 }, f.player);
  players.forEach((s, i) => f.lobby.skins(s, { choices: i % 2 ? {} : choices(i ? B : A) }));
  f.lobby.create(players[0], { mode: 'coop', difficulty: 'NORMAL' });
  const old = f.lobby.roomOf(players[0]); f.lobby.join(players[1], { code: old.code });
  assert.deepEqual(f.lobby.ready(players[1], { ready: true }), { ok: true });
  for (const p of [players[0], players[2], players[3]]) f.lobby.queue.join(p, { difficulty: 'NORMAL', party: p === players[0] });
  const states = players.map(p => f.lobby.queue.state(p)); players.forEach((p, i) => f.lobby.queue.accept(p, states[i]));
  const call = f.calls[0];
  assert.deepEqual(call.spec.seats.map(s => s.skins), players.map(p => p.skins));
  assert.equal(call.context.isCurrent(), true);
  f.lobby.skins(players[2], { choices: {} });
  assert.equal(call.context.isCurrent(), false, 'skin edit invalidates staged assignment just like other preferences');
  f.complete(); await flush();
  assert.ok(players.every(p => !f.lobby.roomOf(p)?.match)); assert.equal(old.disposed, false);
});

test('cluster spectator edits only its own session and never become another player\'s appearance or a peer call', async t => {
  const f = lobbyFixture(t), p = f.player(), s = f.player();
  f.lobby.create(p, { mode: 'coop', difficulty: 'NORMAL' }); const room = f.lobby.roomOf(p);
  f.lobby.spectate(s, { code: room.code });
  const starting = f.lobby.start(p); f.complete(); await starting;
  assert.deepEqual(f.lobby.skins(s, { choices: choices() }), { ok: true });
  assert.deepEqual(s.skins, choices()); assert.deepEqual(room.seatOf(p.playerId).skins, {});
  assert.equal(f.peers.length, 0); assert.equal(Object.hasOwn(f.calls[0].spec, 'skins'), false);
});

test('GameHost whitelist/copy/freeze/fingerprint and real Match INFO_CHECK/channel fences preserve observer privacy', t => {
  const matches = [];
  class LocalMatch extends Match {
    constructor(opts) { super({ ...opts, scheduler: new VirtualScheduler(), botRehearsal: 0 }); matches.push(this); }
  }
  const host = new GameHost({ data: DATA, MatchClass: LocalMatch, log: quiet }); t.after(() => host.close());
  const input = spec(), view = host.prepare(input);
  input.seats[0].skins[CHAR] = B;
  assert.deepEqual(view.seats[0].skins, choices()); assert.ok(Object.isFrozen(view.seats[0].skins));
  assert.deepEqual(matches[0].players.get('p1').skins, choices());
  assert.throws(() => host.prepare(input), e => e instanceof GameHostError && e.code === 'ASSIGNMENT_CONFLICT');
  for (const invalid of [null, [], { [CHAR]: 'bad' }, { other: A }, { [CHAR]: A, sessionToken: 'x' }]) {
    assert.throws(() => host.prepare(spec({ assignmentId: 'invalid', seats: [{ ...spec().seats[0], skins: invalid }] })),
      e => e instanceof GameHostError && e.code === 'INVALID_SPEC');
  }
  const channels = { p1: channel(), p2: channel(), s1: channel() };
  for (const [id, c] of Object.entries(channels)) host.bind(view.assignmentId, id, c);
  host.commit(view.assignmentId);
  assert.equal(host.setSkins(view.assignmentId, 's1', choices()).error, ERR.SPECTATOR);
  assert.equal(host.setSkins(view.assignmentId, 'p1', { [CHAR]: 'bad' }).error, ERR.BAD_MSG);
  assert.deepEqual(host.setSkins(view.assignmentId, 'p1', choices(B)), { ok: true });
  assert.deepEqual(matches[0].players.get('p1').skins, choices(B));
  assert.deepEqual(channels.p1.sent.filter(f => f.t === 'm.private').at(-1).skins, choices(B));
  assert.equal(channels.s1.sent.some(f => f.t === 'm.private'), false);
  assert.ok(channels.s1.sent.every(f => !Object.hasOwn(f, 'skins')));
  const old = channels.p1, resumed = channel(); host.bind(view.assignmentId, 'p1', resumed);
  assert.equal(host.setSkins(view.assignmentId, 'p1', choices(), old).error, ERR.NOT_IN_ROOM);
  assert.deepEqual(resumed.sent.filter(f => f.t === 'm.private').at(-1).skins, choices(B));
  matches[0].phase = PHASE.PREP;
  assert.equal(host.setSkins(view.assignmentId, 'p1', choices()).error, ERR.WRONG_PHASE);
  assert.deepEqual(matches[0].players.get('p1').skins, choices(B));
});

test('RemoteGamePlatform validates/freeze-copies assignment choices and forwards only guarded choices DTO for player members', async t => {
  const calls = [], actors = new Map(), frames = [];
  const metadata = a => ({ assignmentId: a.spec.assignmentId, roomCode: a.spec.roomCode, generation: 'epoch', build: 'skin-fixture', protocol: 1,
    actorGeneration: 1, state: a.state, published: a.published, playersReady: true });
  const client = { close() {}, async call(method, payload) {
    calls.push({ method, payload });
    if (method === 'status' && !payload.assignmentId) return { nodeId: 'node', generation: 'epoch', build: 'skin-fixture', protocol: 1, ready: true, counts: { matches: 0 } };
    if (method === 'prepare') { const a = { spec: payload, state: 'prepared', published: false }; actors.set(payload.assignmentId, a); return metadata(a); }
    if (method === 'release') return actors.delete(payload.assignmentId);
    if (method === 'setSkins') return { error: ERR.WRONG_PHASE };
    const a = actors.get(payload.assignmentId);
    if (method === 'commit') a.state = 'committed'; if (method === 'publish') a.published = true;
    return metadata(a);
  } };
  // Fixed synthetic key used only by the in-memory ticket fixture; no private runtime configuration is read.
  const platform = new RemoteGamePlatform({ nodes: [{ nodeId: 'node', key: Buffer.alloc(32, 7), client }], build: 'skin-fixture', protocol: 1,
    sendControl(id, frame) { frames.push({ id, frame }); return true; } }); t.after(() => platform.close());
  await platform.refresh();
  await assert.rejects(platform.prepare(spec({ seats: [{ ...spec().seats[0], skins: { [CHAR]: 'unsafe' } }] })), TypeError);
  const input = spec(), handle = await platform.prepare(input);
  input.seats[0].skins[CHAR] = B;
  assert.deepEqual(platform.contexts.get(handle.assignmentId).spec.seats[0].skins, choices());
  assert.ok(Object.isFrozen(platform.contexts.get(handle.assignmentId).spec.seats[0].skins));
  handle.commit(); handle.publish(); await platform.contexts.get(handle.assignmentId).publication;
  assert.equal((await platform.peer(handle.assignmentId, 'setSkins', 'p1', choices(B))).error, ERR.WRONG_PHASE);
  const rpc = calls.at(-1);
  assert.equal(rpc.method, 'setSkins');
  assert.deepEqual(rpc.payload, { assignmentId: handle.assignmentId, sessionId: 'p1', nodeGeneration: 'epoch', actorGeneration: 1, choices: choices(B) });
  await assert.rejects(platform.peer(handle.assignmentId, 'setSkins', 's1', choices()), e => e.code === 'NOT_MEMBER');
  assert.ok(frames.every(({ frame }) => !Object.hasOwn(frame, 'skins') && !Object.hasOwn(frame, 'choices')), 'skin preferences never enter routing tickets');
});
