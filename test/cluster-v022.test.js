// Official 0.2.2 settings/counters across the native adapters, alongside the fork's privacy/epoch contracts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyAssignmentSpec, GameHost, GameHostError } from '../server/cluster/game-host.js';
import { ClusterLobby } from '../server/cluster/lobby.js';
import { RemoteGamePlatform } from '../server/cluster/platform.js';
import { startGameNode } from '../server/cluster/game-node.js';
import { createRpcAuthenticator, createRpcClient } from '../server/cluster/rpc.js';
import { SessionRegistry } from '../server/net.js';
import { Match } from '../server/match/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { CombatEngine } from '../server/match/combat/engine.js';
import { RemoteBattle } from '../server/match/combat/runner.js';
import { MatchViews } from '../server/match/match/views.js';
import { DATA, QUIET, phase } from './match/combat-fixtures.js';
import { ERR, PHASE, MATCHMAKING_VERSION } from '../shared/constants.js';
import { LOADOUT_LIMITS } from '../shared/protocol.js';
import { OPERATOR_SKINS } from '../shared/skins.js';

const BUILD = 'v022-fixture', NODE = 'v022-game', EPOCH = 'v022-epoch';
const CHAR = 'char_103_angel', settings = potential => ({ [CHAR]: { potential, cultivate: 0 } });
const skins = { [CHAR]: OPERATOR_SKINS.find(s => s.charId === CHAR).id };
const seat = (seat, playerId, extra = {}) => ({ seat, playerId, name: playerId, isBot: false, connected: true, ...extra });
const spec = extra => ({ assignmentId: 'v022-assignment', roomCode: 'ABCD', build: BUILD, protocol: 1,
  seed: 71, matchNo: 1, mode: 'coop', difficulty: 'NORMAL', modeId: 'mode_multi_normal',
  seats: [seat(0, 'p1', { ops: settings(2), skins }), seat(1, 'p2')], spectators: ['s1'], aiPicksLast: true, ...extra });
const invalidSpec = e => e instanceof GameHostError && e.code === 'INVALID_SPEC';
const channel = () => ({ sent: [], send(msg) { this.sent.push(msg); return true; },
  sendEncoded(type, raw) { this.sent.push(JSON.parse(raw)); return true; }, close() {} });
const recordedMatch = records => class extends Match {
  constructor(opts) { super({ ...opts, scheduler: new VirtualScheduler(), botRehearsal: 0 }); records.push(this); }
};

// No listeners or pools: descriptor/schema, actor identity and origin fencing.
test('v0.2.2 assignment ops/aiPicksLast are copied, bounded, frozen and included in actor identity', t => {
  const host = new GameHost({ data: DATA, MatchClass: recordedMatch([]), log: QUIET }); t.after(() => host.close());
  const input = spec(), prepared = host.prepare(input);
  input.seats[0].ops[CHAR].potential = 3;
  assert.deepEqual(prepared.seats[0].ops, settings(2));
  assert.ok(Object.isFrozen(prepared.seats[0].ops) && Object.isFrozen(prepared.seats[0].ops[CHAR]));
  assert.equal(prepared.aiPicksLast, true);
  assert.throws(() => host.prepare(input), e => e.code === 'ASSIGNMENT_CONFLICT');
  assert.throws(() => host.prepare(spec({ aiPicksLast: false })), e => e.code === 'ASSIGNMENT_CONFLICT');
  assert.equal(Object.hasOwn(copyAssignmentSpec(spec({ aiPicksLast: undefined })), 'aiPicksLast'), false, 'legacy spec stays optional');
  const many = Object.fromEntries(Array.from({ length: LOADOUT_LIMITS.ops }, (_, i) => [`char_${i}`, { potential: 1 }]));
  assert.equal(Object.keys(copyAssignmentSpec(spec({ seats: [seat(0, 'p1', { ops: many })] })).seats[0].ops).length, 256);
  for (const ops of [[], { [CHAR]: {} }, { [CHAR]: { potential: 0 } }, { [CHAR]: { potential: 7 } },
    { [CHAR]: { potential: 1.5 } }, { [CHAR]: { cultivate: 4 } }, { [CHAR]: { potential: 1, credential: true } },
    { ...many, extra_char: { potential: 1 } }, JSON.parse('{"__proto__":{"potential":1}}')]) {
    assert.throws(() => copyAssignmentSpec(spec({ seats: [seat(0, 'p1', { ops })] })), invalidSpec);
  }
  let reads = 0;
  const accessor = Object.defineProperty({}, 'potential', { enumerable: true, get() { reads++; return 1; } });
  assert.throws(() => copyAssignmentSpec(spec({ seats: [seat(0, 'p1', { ops: { [CHAR]: accessor } })] })), invalidSpec);
  assert.equal(reads, 0, 'invalid descriptor is refused before executing it');
  assert.throws(() => copyAssignmentSpec(spec({ aiPicksLast: 'true' })), invalidSpec);
});

test('v0.2.2 GameHost edits retain channel arg4, ops arg5, INFO_CHECK lock and spectator privacy', t => {
  const records = [], host = new GameHost({ data: DATA, MatchClass: recordedMatch(records), log: QUIET }); t.after(() => host.close());
  const view = host.prepare(spec()), channels = { p1: channel(), p2: channel(), s1: channel() };
  for (const [id, c] of Object.entries(channels)) host.bind(view.assignmentId, id, c);
  host.commit(view.assignmentId);
  const match = records[0], ps = match.players.get('p1');
  assert.equal(match.aiPicksLast, true); assert.deepEqual(ps.ops, settings(2)); assert.deepEqual(ps.skins, skins);
  assert.deepEqual(host.setLoadout(view.assignmentId, 'p1', {}, channels.p1, settings(1)), { ok: true });
  assert.deepEqual(ps.ops, settings(1));
  assert.deepEqual(host.setLoadout(view.assignmentId, 'p1', {}), { ok: true }, 'legacy call keeps current settings');
  assert.deepEqual(ps.ops, settings(1));
  assert.equal(host.setLoadout(view.assignmentId, 's1', {}, undefined, settings(2)).error, ERR.SPECTATOR);
  assert.equal(host.setLoadout(view.assignmentId, 'p1', {}, undefined, { [CHAR]: { cultivate: 4 } }).error, ERR.BAD_MSG);
  assert.deepEqual(ps.ops, settings(1), 'invalid settings do not mutate either loadout');
  const old = channels.p1, replacement = channel(); host.bind(view.assignmentId, 'p1', replacement);
  assert.equal(host.setLoadout(view.assignmentId, 'p1', {}, old, settings(2)).error, ERR.NOT_IN_ROOM);
  assert.deepEqual(replacement.sent.filter(f => f.t === 'm.private').at(-1).ops, settings(1));
  assert.equal(channels.s1.sent.some(f => f.t === 'm.private' || Object.hasOwn(f, 'ops') || Object.hasOwn(f, 'skins')), false);
  match.phase = PHASE.PREP;
  assert.equal(host.setLoadout(view.assignmentId, 'p1', {}, replacement, settings(2)).error, ERR.WRONG_PHASE);
  assert.deepEqual(ps.ops, settings(1));
});

function admissionFixture(t) {
  const registry = new SessionRegistry(), calls = [];
  const platform = { build: BUILD, protocol: 1, resume() { return true; }, release() { return Promise.resolve(true); }, deliverEnd() { return true; },
    prepare(spec, context) { let resolve; const promise = new Promise(yes => { resolve = yes; }); calls.push({ spec, context, resolve }); return promise; } };
  const lobby = new ClusterLobby({ registry, platform, getData: () => DATA, log: QUIET }); t.after(() => lobby.shutdown());
  const player = registry.create('Player'); player.connected = true;
  player.ws = { readyState: 1, bufferedAmount: 0, send(raw, options, done) { done?.(); } };
  lobby.onHello(player, { resumed: false, repeat: false });
  assert.deepEqual(lobby.loadout(player, { entries: {}, ops: settings(2) }), { ok: true });
  assert.deepEqual(lobby.create(player, { mode: 'coop', difficulty: 'NORMAL' }), { ok: true });
  const finish = () => { const c = calls.at(-1); c.resolve({ assignmentId: c.spec.assignmentId, nodeId: NODE, generation: EPOCH,
    commit() { return { ownerAvailable: true }; }, publish() { return true; }, abort() { return Promise.resolve(true); } }); };
  return { lobby, player, calls, finish };
}

test('v0.2.2 settings changed during native preparation invalidate staged admission before publication', async t => {
  for (const field of ['ops', 'aiPicksLast']) {
    const f = admissionFixture(t), room = f.lobby.roomOf(f.player), starting = f.lobby.start(f.player);
    assert.deepEqual(f.calls[0].spec.seats[0].ops, settings(2));
    assert.equal(f.calls[0].spec.aiPicksLast, false);
    assert.equal(f.calls[0].context.isCurrent(), true);
    if (field === 'ops') f.lobby.loadout(f.player, { entries: {}, ops: settings(1) });
    else f.lobby.setAiPicksLast(f.player, { on: true });
    assert.equal(f.calls[0].context.isCurrent(), false, field);
    f.finish(); assert.equal((await starting).error, ERR.WRONG_PHASE);
    assert.equal(room.match, null); assert.equal(room.matchCount, 0);
  }
});

test('v0.2.2 AI-picks-last mutation follows the existing queued-room fence without expanding party rules', t => {
  const f = admissionFixture(t), room = f.lobby.roomOf(f.player);
  f.player.matchmakingVersion = MATCHMAKING_VERSION;
  assert.deepEqual(f.lobby.queue.join(f.player, { difficulty: room.difficulty, party: true }), { ok: true });
  const before = room.toState();
  assert.equal(f.lobby.setAiPicksLast(f.player, { on: true }).error, ERR.QUEUED);
  assert.deepEqual(room.toState(), before); assert.equal(f.lobby.queue.has(f.player), true);
});

test('v0.2.2 dense twenty-seat settings retain the 64 KiB native envelope refusal before any side effect', async t => {
  const calls = [], frames = [], client = { close() {}, call(...args) { calls.push(args); throw new Error('must not dispatch'); } };
  const platform = new RemoteGamePlatform({ nodes: [{ nodeId: NODE, key: Buffer.alloc(32, 0x23), client }], build: BUILD, protocol: 1,
    sendControl(...args) { frames.push(args); return true; } }); t.after(() => platform.close());
  const ops = Object.fromEntries(Array.from({ length: LOADOUT_LIMITS.ops }, (_, i) => [`char_${i}`, { potential: 1, cultivate: 0 }]));
  const input = spec({ seats: Array.from({ length: 20 }, (_, i) => seat(i, `p${i}`, { ops })),
    experimental: { revivalEnabled: false, disableSharedPool: false, playerCapacity: 20 } });
  await assert.rejects(platform.prepare(input), e => e.code === 'TOO_LARGE');
  assert.deepEqual(calls, []); assert.deepEqual(frames, []); assert.equal(platform.contexts.size, 0);
});

// Actual ephemeral loopback RPC, with in-process ingress channels. No external service/credentials or Worker pool.
test('v0.2.2 native lobby/platform/node chain carries ops and manual AI option; guarded RPC stays backward-compatible', async t => {
  const key = Buffer.alloc(32, 0x22), records = [], transports = new Map(), controlFrames = [], registry = new SessionRegistry();
  const node = await startGameNode({ nodeId: NODE, generation: EPOCH, build: BUILD, key, data: DATA,
    MatchClass: recordedMatch(records), log: QUIET, shutdownMs: 50 });
  const rpc = createRpcClient({ url: node.url, authority: createRpcAuthenticator({ key, scope: NODE }) });
  const platform = new RemoteGamePlatform({ nodes: [{ nodeId: NODE, key, url: node.url }], build: BUILD, protocol: 1,
    sendControl(playerId, frame) {
      controlFrames.push({ playerId, frame });
      if (frame.t === 'cluster.prepare') {
        const c = channel(); transports.set(playerId, c); node.gameHost.bind(frame.assignmentId, playerId, c);
      }
      return true;
    } });
  const lobby = new ClusterLobby({ registry, platform, getData: () => DATA, log: QUIET });
  t.after(async () => { lobby.shutdown(); rpc.close(); await platform.close(); await node.close(); });
  const player = name => {
    const p = registry.create(name); p.connected = true;
    p.ws = { readyState: 1, bufferedAmount: 0, send(raw, options, done) { done?.(); } };
    lobby.onHello(p, { resumed: false, repeat: false }); return p;
  };
  const p = player('Player'), observer = player('Observer');
  assert.deepEqual(lobby.loadout(p, { entries: {}, ops: settings(2) }), { ok: true });
  assert.deepEqual(lobby.skins(p, { choices: skins }), { ok: true });
  assert.deepEqual(lobby.create(p, { mode: 'coop', difficulty: 'NORMAL' }), { ok: true });
  const room = lobby.roomOf(p);
  assert.deepEqual(lobby.addBot(p), { ok: true });
  assert.deepEqual(lobby.setAiPicksLast(p, { on: true }), { ok: true });
  assert.deepEqual(lobby.spectate(observer, { code: room.code }), { ok: true });
  await platform.refresh(); assert.deepEqual(await lobby.start(p), { ok: true });
  const plan = [...lobby.assignments.values()][0], assignmentId = plan.spec.assignmentId;
  await platform.contexts.get(assignmentId).publication;
  const match = records[0], ps = match.players.get(p.playerId);
  assert.equal(match.aiPicksLast, true); assert.deepEqual(ps.ops, settings(2)); assert.deepEqual(ps.skins, skins);
  assert.deepEqual(match.order.find(s => s.isBot).ops, {}, 'bots keep official defaults');
  assert.deepEqual(await lobby.loadout(p, { entries: {}, ops: settings(1) }), { ok: true });
  assert.deepEqual(ps.ops, settings(1));
  assert.deepEqual(lobby.loadout(observer, { entries: {}, ops: settings(2) }), { ok: true }, 'observer stores only its own session');
  assert.deepEqual(ps.ops, settings(1));
  const payload = { assignmentId, sessionId: p.playerId, nodeGeneration: EPOCH, actorGeneration: node.gameHost.get(assignmentId).generation, loadout: {} };
  assert.deepEqual(await rpc.call('setLoadout', payload), { ok: true });
  assert.deepEqual(ps.ops, settings(1), 'legacy RPC omits ops without clearing the Match setting');
  assert.deepEqual(await rpc.call('setLoadout', { ...payload, ops: settings(2) }), { ok: true });
  assert.deepEqual(ps.ops, settings(2));
  assert.equal((await rpc.call('setLoadout', { ...payload, ops: { [CHAR]: { potential: 9 } } })).error, ERR.BAD_MSG);
  await assert.rejects(rpc.call('setLoadout', { ...payload, nodeGeneration: 'old-epoch', ops: settings(1) }), e => e.code === 'STALE_ASSIGNMENT');
  await assert.rejects(rpc.call('setLoadout', { ...payload, actorGeneration: payload.actorGeneration + 1, ops: settings(1) }), e => e.code === 'STALE_ASSIGNMENT');
  await assert.rejects(rpc.call('setLoadout', { ...payload, ops: settings(1), extra: true }), e => e.code === 'BAD_REQUEST');
  await assert.rejects(platform.peer(assignmentId, 'setLoadout', observer.playerId, {}, settings(1)), e => e.code === 'NOT_MEMBER');
  assert.deepEqual(ps.ops, settings(2));
  assert.equal(JSON.stringify(room.toState()).includes('ops'), false);
  assert.ok(controlFrames.every(({ frame }) => !Object.hasOwn(frame, 'ops') && !Object.hasOwn(frame, 'loadout') && !Object.hasOwn(frame, 'skins')));
  assert.equal(transports.get(observer.playerId).sent.some(f => f.t === 'm.private' || Object.hasOwn(f, 'ops') || Object.hasOwn(f, 'skins')), false);
});

test('v0.2.2 resolved count crosses low-rate worker state even without watched snapshots, independently of kills', () => {
  const input = phase('normal'), engine = new CombatEngine(input, { data: DATA, log: QUIET });
  try {
    const battle = engine.fields[0].battle, remote = new RemoteBattle(input.specs[0]);
    assert.equal(remote.resolved, null);
    // A runtime child kill does not resolve another own scheduled enemy; a leak does resolve one.
    battle.killed = 8; battle.total = 4; battle.killedInTotal = 1; battle.leakedInTotal = 2;
    const out = engine.state(), view = out.fields[0];
    assert.equal(out.frames.length, 0, 'unwatched live field has no snapshot payload');
    assert.equal(view.killed, 8); assert.equal(view.resolved, 3);
    remote.update(view);
    assert.deepEqual(MatchViews.prototype._fieldProgress.call({}, { battle: remote, live: true }), { killed: 8, resolved: 3, total: 4, done: false });
    remote.update({ ...view, resolved: undefined });
    assert.equal(remote.resolved, null, 'old worker view remains unknown, never fabricated zero');
  } finally { engine.dispose(); }
});
