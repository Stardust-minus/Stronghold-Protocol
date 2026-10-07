import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { MAX_PUBLIC_GAME_NODES, normalizeClusterLoad, normalizeGameLoad, publicGameLabel } from '../shared/cluster-load.js';
import { RemoteGamePlatform } from '../server/cluster/platform.js';
import { startGameNode } from '../server/cluster/game-node.js';
import { startGameRuntime } from '../server/cluster/game-runtime.js';
import { createRpcAuthenticator, createRpcClient } from '../server/cluster/rpc.js';
import { createTicketAuthority } from '../server/cluster/tickets.js';

const KEY = Buffer.alloc(32, 0x52); // Synthetic local fixture only.
const BUILD = 'load-fixture', PRIVATE_NODE = 'private-internal-node';
const details = extra => ({ windowMs: 10000, ageMs: 100, cpuPercent: 145.23, rssMiB: 250, heapMiB: 35,
  eluPercent: 89, p95Ms: 42, p99Ms: 59, ...extra });
const load = extra => ({ label: 'game-01', status: 'ready', loadState: 'busy', loadDetails: details(), ...extra });
const once = (socket, type) => new Promise((resolve, reject) => {
  const finish = (error, value) => { clearTimeout(timer); socket.off('message', receive); socket.off('close', closed); error ? reject(error) : resolve(value); };
  const receive = raw => { const message = JSON.parse(raw.toString()); if (message.t === type) finish(null, message); };
  const closed = () => finish(new Error('fixture socket closed'));
  const timer = setTimeout(() => finish(new Error('fixture frame timeout')), 2000);
  socket.on('message', receive); socket.once('close', closed);
});

function platformFixture(t, count = 16, extra = {}) {
  let at = 100_000;
  const peers = Array.from({ length: count }, (_, index) => {
    const nodeId = `private-${index + 1}`;
    const peer = { nodeId, publicSlot: index < MAX_PUBLIC_GAME_NODES ? index + 1 : undefined,
      key: KEY, calls: 0, failures: false, value: { nodeId, generation: 'fixture-epoch', build: BUILD, protocol: 1,
        ready: true, counts: { matches: 0 }, publicSlot: index < MAX_PUBLIC_GAME_NODES ? index + 1 : null,
        loadState: 'busy', loadDetails: details({ pid: 999, hostname: 'secret-hostname' }) } };
    peer.client = { async call(op) { assert.equal(op, 'status'); peer.calls++; if (peer.failures) throw new Error('fixture-only'); return peer.value; }, close() {} };
    return peer;
  });
  const platform = new RemoteGamePlatform({ nodes: peers, build: BUILD, protocol: 1, sendControl: () => true, now: () => at, ...extra });
  t.after(() => platform.close());
  return { platform, peers, advance: ms => { at += ms; } };
}

test('public cluster projection retains only fixed game labels and whitelisted measurements', () => {
  const output = normalizeClusterLoad({ scope: 'cluster', nodes: [load({ nodeId: PRIVATE_NODE, url: 'http://private.invalid/',
    generation: 'private-epoch', key: 'private-key', loadDetails: details({ pid: 100, hostname: 'private-host', thread: 'private-thread' }) })],
    ticket: 'private-ticket', health: { workerIds: [1, 2] } });
  assert.deepEqual(Object.keys(output), ['scope', 'nodes']);
  assert.deepEqual(Object.keys(output.nodes[0]), ['label', 'status', 'loadState', 'loadDetails']);
  assert.deepEqual(Object.keys(output.nodes[0].loadDetails), ['windowMs', 'ageMs', 'cpuPercent', 'rssMiB', 'heapMiB', 'eluPercent', 'p95Ms', 'p99Ms']);
  assert.equal(output.nodes[0].loadDetails.cpuPercent, 145.2);
  assert.equal(JSON.stringify(output).includes('private'), false);
});

test('fixed diagnostic labels reject arbitrary names, trailing newlines, duplicates and oversized inventories', () => {
  assert.equal(publicGameLabel(1), 'game-01'); assert.equal(publicGameLabel(256), 'game-256');
  for (const slot of [0, 257, '1', 1.5, NaN]) assert.equal(publicGameLabel(slot), null);
  for (const label of [PRIVATE_NODE, 'game-001', 'game-00', 'game-257', 'game-01\n']) assert.equal(normalizeGameLoad(load({ label })), null);
  assert.equal(normalizeClusterLoad({ scope: 'cluster', nodes: [load(), load()] }), null);
  assert.equal(normalizeClusterLoad({ scope: 'game', nodes: [load(), load({ label: 'game-02' })] }), null);
  assert.equal(normalizeClusterLoad({ scope: 'cluster', nodes: Array.from({ length: 257 }, (_, i) => load({ label: publicGameLabel(i + 1) })) }), null);
  assert.equal(normalizeClusterLoad({ scope: 'anything', nodes: [load()] }), null);
  assert.equal(normalizeClusterLoad({ scope: 'cluster', nodes: [] }), null);
});

test('warming, incomplete, stale, malformed and unavailable measurements never become healthy pressure hints', () => {
  for (const value of [load({ loadDetails: null }), load({ loadDetails: {} }), load({ loadDetails: details({ ageMs: 30001 }) }),
    load({ loadDetails: details({ eluPercent: null }) }), load({ loadDetails: details({ p95Ms: Infinity }) }), load({ loadState: 'fake-normal' })]) {
    assert.equal(normalizeGameLoad(value).loadState, 'unknown');
  }
  for (const status of ['unknown', 'unavailable', 'normal']) {
    const value = normalizeGameLoad(load({ status }));
    assert.equal(value.loadState, 'unknown'); assert.equal(value.loadDetails, null);
  }
  assert.equal(normalizeClusterLoad(Object.create({ scope: 'cluster', nodes: [load()] })), null);
  const malicious = { scope: 'cluster', get nodes() { throw new Error('private'); } };
  assert.equal(normalizeClusterLoad(malicious), null);
});

test('one cached authenticated refresh exposes all sixteen games without per-player RPC or private identities', async t => {
  const f = platformFixture(t);
  assert.ok(f.platform.publicLoad().nodes.every(node => node.status === 'unknown'));
  await f.platform.refresh();
  const output = f.platform.publicLoad();
  assert.equal(output.scope, 'cluster'); assert.equal(output.nodes.length, 16);
  assert.deepEqual(output.nodes.map(node => node.label), Array.from({ length: 16 }, (_, i) => publicGameLabel(i + 1)));
  assert.ok(output.nodes.every(node => node.status === 'ready' && node.loadState === 'busy'));
  for (let i = 0; i < 20; i++) f.platform.publicLoad();
  assert.ok(f.peers.every(peer => peer.calls === 1));
  assert.equal(JSON.stringify(output).includes('private'), false);
  assert.equal(JSON.stringify(output).includes('hostname'), false);
});

test('cached node and sample age advances locally and stale or backwards clocks return unknown', async t => {
  const f = platformFixture(t, 1, { loadTtlMs: 1000 });
  await f.platform.refresh(); f.advance(500);
  assert.equal(f.platform.publicLoad().nodes[0].loadDetails.ageMs, 600);
  f.advance(501);
  assert.deepEqual(f.platform.publicLoad().nodes[0], load({ status: 'unknown', loadState: 'unknown', loadDetails: null }));
  await f.platform.refresh(); f.advance(-1);
  assert.equal(f.platform.publicLoad().nodes[0].status, 'unknown');
  f.advance(1); f.peers[0].value.loadDetails.ageMs = 29950;
  await f.platform.refresh(); f.advance(100);
  assert.equal(f.platform.publicLoad().nodes[0].loadState, 'unknown');
  assert.equal(f.platform.publicLoad().nodes[0].loadDetails, null);
});

test('rejected identity, unreachable, missing telemetry and wrong public slots fail closed independently', async t => {
  const f = platformFixture(t, 4);
  f.peers[0].failures = true;
  f.peers[1].value.build = 'wrong-build';
  delete f.peers[2].value.loadDetails;
  f.peers[3].value.publicSlot = 1;
  await f.platform.refresh();
  assert.deepEqual(f.platform.publicLoad().nodes.map(node => node.status), ['unavailable', 'unavailable', 'unknown', 'unknown']);
  assert.ok(f.platform.publicLoad().nodes.every(node => node.loadState === 'unknown' && node.loadDetails === null));
  f.peers[0].failures = false; f.peers[0].value.ready = false;
  await f.platform.refresh(); assert.equal(f.platform.publicLoad().nodes[0].status, 'unavailable');
});

test('diagnostic slots are immutable and unique but the 256-row bound does not limit compute admission', async t => {
  const f = platformFixture(t, 1);
  assert.throws(() => f.platform.nodeConfiguration({ ...f.peers[0], publicSlot: 2 }), /NODE_CONFIG_CONFLICT/);
  assert.throws(() => f.platform.addNode({ ...f.peers[0], nodeId: 'new-peer', publicSlot: 1 }), /duplicate public node slot/);
  const large = platformFixture(t, 257);
  await large.platform.refresh();
  assert.equal(large.platform.nodes.size, 257);
  assert.equal(large.platform.directory.nodes.size, 257);
  assert.equal(large.platform.publicLoad().nodes.length, 256);
});

async function gameFixture(t, extra = {}) {
  const pool = workers => ({ stats: () => ({ status: 'ready', workers, ready: workers, workerIds: ['private-thread'], pid: 12 }) });
  class FixtureMatch { constructor(opts) { this.opts = opts; } start() {} onReconnect() {} onDisconnect() {} dispose() {} }
  const node = await startGameNode({ nodeId: PRIVATE_NODE, publicSlot: 17, generation: 'private-generation', build: BUILD, key: KEY,
    combatPool: pool(8), trialPool: pool(2), MatchClass: FixtureMatch, getLoadState: () => 'busy',
    getLoadDetails: () => details({ pid: 12, hostname: 'private-hostname' }), ...extra });
  const rpc = createRpcClient({ url: node.url, authority: createRpcAuthenticator({ key: KEY, scope: PRIVATE_NODE }) });
  const clients = [];
  t.after(async () => { for (const socket of clients) socket.terminate(); rpc.close(); await node.close(); });
  const assignment = { assignmentId: 'test-allocation', roomCode: 'ABCD', build: BUILD, protocol: 1, seed: 7, matchNo: 1,
    mode: 'solo', difficulty: 'NORMAL', modeId: 'mode_single_normal', revivalEnabled: false, snapshotHz: 10,
    spectators: [], seats: [{ seat: 0, playerId: 'player-one', name: 'Fixture', isBot: false, connected: true, loadout: null }] };
  const connect = async () => {
    await rpc.call('prepare', assignment);
    const socket = new WebSocket(node.url.replace(/^http/, 'ws') + '/_cluster/game'); clients.push(socket);
    socket.on('error', () => {});
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const bound = once(socket, 'cluster.bound');
    const claims = { sessionId: 'player-one', roomCode: 'ABCD', assignmentId: assignment.assignmentId, nodeId: PRIVATE_NODE,
      role: 'player', build: BUILD, protocol: 1 };
    socket.send(JSON.stringify({ t: 'cluster.bind', assignmentId: assignment.assignmentId, sessionId: claims.sessionId,
      ticket: createTicketAuthority({ key: KEY }).issue(claims) }));
    await bound; await rpc.call('commit', { assignmentId: assignment.assignmentId });
    return socket;
  };
  return { node, rpc, connect };
}

test('native private status has exact pool readiness for the host manager while game PONG exposes only its own projection', async t => {
  const f = await gameFixture(t);
  const status = await f.rpc.call('status');
  assert.deepEqual(status.health, { combat: { status: 'ready', workers: 8, ready: 8 }, trial: { status: 'ready', workers: 2, ready: 2 } });
  assert.equal(status.publicSlot, 17);
  assert.equal(Object.hasOwn(status.loadDetails, 'pid'), false);
  const socket = await f.connect(), response = once(socket, 'pong');
  socket.send(JSON.stringify({ t: 'ping', c: 7, rid: 10 }));
  const pong = await response;
  assert.equal(pong.rid, 10); assert.equal(pong.clusterLoad.scope, 'game');
  assert.deepEqual(pong.clusterLoad.nodes.map(node => node.label), ['game-17']);
  assert.equal(pong.clusterLoad.nodes[0].loadState, 'busy');
  assert.equal(Object.hasOwn(pong, 'health'), false);
  for (const forbidden of [PRIVATE_NODE, 'private-generation', 'hostname', 'workerIds', 'test-allocation']) assert.equal(JSON.stringify(pong).includes(forbidden), false);
});

test('private malformed pool stats and load providers degrade diagnostics without breaking an active heartbeat', async t => {
  const f = await gameFixture(t, { combatPool: { stats: () => ({ status: 'ready', ready: 1 }) }, trialPool: null,
    getLoadState: () => { throw new Error('private'); }, getLoadDetails: () => { throw new Error('private'); } });
  const status = await f.rpc.call('status');
  assert.deepEqual(status.health.combat, { status: 'unknown', workers: 0, ready: 0 });
  assert.deepEqual(status.health.trial, { status: 'disabled', workers: 0, ready: 0 });
  const socket = await f.connect(), response = once(socket, 'pong');
  socket.send(JSON.stringify({ t: 'ping', c: 8 }));
  const pong = await response;
  assert.equal(pong.loadState, 'unknown'); assert.equal(pong.clusterLoad.nodes[0].loadState, 'unknown');
  assert.equal(pong.clusterLoad.nodes[0].loadDetails, null);
});

test('the process-owned cluster runtime defaults to eight real combat and two real trial Workers', async t => {
  const runtime = await startGameRuntime({ nodeId: PRIVATE_NODE, publicSlot: 16, generation: 'real-runtime-epoch',
    build: BUILD, key: KEY, onEnd() {} });
  const rpc = createRpcClient({ url: runtime.url, authority: createRpcAuthenticator({ key: KEY, scope: PRIVATE_NODE }) });
  t.after(async () => { rpc.close(); await runtime.close(); });
  const status = await rpc.call('status');
  assert.deepEqual(status.health, { combat: { status: 'ready', workers: 8, ready: 8 }, trial: { status: 'ready', workers: 2, ready: 2 } });
  assert.equal(runtime.combatPool.stats().workers, 8);
  assert.equal(runtime.trialPool.stats().workers, 2);
  assert.equal(status.loadState, 'unknown'); // The ten-second performance cache is still warming.
  assert.equal(status.loadDetails, null);
  await runtime.close();
  assert.equal(runtime.combatPool.stats().status, 'closed');
  assert.equal(runtime.trialPool.stats().status, 'closed');
});
