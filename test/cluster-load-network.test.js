// Actual loopback HTTP/WS and real coordinator/Lobby; fixture Match/pools only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { startCoordinator } from '../server/cluster/coordinator.js';
import { startGameNode } from '../server/cluster/game-node.js';
import { startIngress } from '../server/cluster/ingress.js';
import { startServer } from '../server/index.js';
import { CLUSTER_LOAD_EVERY_MS } from '../server/net.js';
import { MATCHMAKING_VERSION } from '../shared/constants.js';
import { DEFAULT_VERSION } from '../shared/versions.js';
import { publicGameLabel } from '../shared/cluster-load.js';

// a room.create names 第二期下半 unless the test names a version (as test/helpers/wsClient.js does): the lobby's default
// is 规程·序列Ⅰ (shared/versions.js LOBBY_DEFAULT_VERSION), whose rooms wait for the page's content check
const withVersion = (type, fields) => (type === 'room.create' && !Object.hasOwn(fields, 'version') ? { ...fields, version: DEFAULT_VERSION } : fields);

const ORIGIN = 'https://cluster-load-fixture.invalid';
const details = { windowMs: 10000, ageMs: 1, cpuPercent: 80, rssMiB: 240, heapMiB: 50, eluPercent: 50, p95Ms: 22, p99Ms: 30 };
const until = async (predicate, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('fixture condition timeout'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
async function client(url) {
  const socket = new WebSocket(url.replace(/^http/, 'ws') + '/ws', { origin: ORIGIN }), frames = [], pending = new Map();
  let nextRid = 0;
  socket.on('error', () => {});
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString()); frames.push(message);
    const work = pending.get(message.rid);
    if (!work) return;
    pending.delete(message.rid); clearTimeout(work.timer);
    if (message.t === 'error') work.reject(new Error(message.code)); else work.resolve(message);
  });
  socket.on('close', () => {
    for (const work of pending.values()) { clearTimeout(work.timer); work.reject(new Error('fixture socket closed')); }
    pending.clear();
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ t: 'hello', name: 'LoadFixture', version: 1, matchmakingVersion: MATCHMAKING_VERSION }));
  await until(() => frames.some(message => message.t === 'welcome'));
  const request = (type, fields = {}) => new Promise((resolve, reject) => {
    const rid = ++nextRid;
    const timer = setTimeout(() => { pending.delete(rid); reject(new Error('fixture request timeout')); }, 6500);
    pending.set(rid, { timer, resolve, reject }); socket.send(JSON.stringify({ t: type, ...withVersion(type, fields), rid }));
  });
  return { socket, frames, request, playerId: frames.find(message => message.t === 'welcome').playerId };
}

async function topology(t) {
  class FixtureMatch {
    constructor(opts) { this.opts = opts; }
    start() { this.opts.broadcast({ t: 'm.public', phase: 'INFO_CHECK' }); }
    onReconnect() {} onDisconnect() {} onLeave() {} dispose() {}
  }
  const configs = Array.from({ length: 16 }, (_, i) => ({ nodeId: `private-game-${i + 1}`, publicSlot: i + 1,
    generation: `private-epoch-${i + 1}`, build: 'network-load-fixture', key: randomBytes(32) }));
  const games = await Promise.all(configs.map(config => startGameNode({ ...config, MatchClass: FixtureMatch, streamMarkers: true,
    getLoadState: () => 'normal', getLoadDetails: () => ({ ...details, pid: 999, hostname: 'private-hostname' }) })));
  const nodes = configs.map((config, i) => ({ ...config, url: games[i].url }));
  const coordinator = await startCoordinator({ nodes, build: 'network-load-fixture', port: 0, quiet: true, heartbeatMs: 1000 });
  const entry = await startIngress({ coordinatorUrl: coordinator.url, nodes, origins: [ORIGIN], shutdownMs: 100 });
  const clients = [];
  t.after(async () => { for (const conn of clients) conn.socket.terminate(); await entry.close(); await coordinator.close(); await Promise.all(games.map(game => game.close())); });
  const join = async () => { const conn = await client(entry.url); clients.push(conn); return conn; };
  return { coordinator, games, entry, join };
}

test('one browser WS switches from all sixteen cached game summaries to only its owner and back to lobby', async t => {
  const f = await topology(t), conn = await f.join();
  const lobbyPong = await conn.request('ping', { c: 1 });
  assert.equal(lobbyPong.clusterLoad.scope, 'cluster');
  assert.equal(lobbyPong.clusterLoad.nodes.length, 16);
  assert.deepEqual(lobbyPong.clusterLoad.nodes.map(node => node.label), Array.from({ length: 16 }, (_, i) => publicGameLabel(i + 1)));
  assert.ok(lobbyPong.clusterLoad.nodes.every(node => node.status === 'ready' && node.loadState === 'normal'));
  assert.equal(JSON.stringify(lobbyPong).includes('private-'), false);
  await conn.request('room.create', { mode: 'coop', difficulty: 'NORMAL' });
  await conn.request('room.start');
  await until(() => conn.frames.some(message => message.t === 'room.state' && message.inMatch));
  const owner = f.coordinator.platform.directory.bySession(conn.playerId);
  assert.ok(owner);
  const inMatch = await conn.request('ping', { c: 2 });
  assert.equal(inMatch.clusterLoad.scope, 'game');
  assert.deepEqual(inMatch.clusterLoad.nodes.map(node => node.label), [publicGameLabel(f.coordinator.platform.nodes.get(owner.nodeId).publicSlot)]);
  assert.equal(JSON.stringify(inMatch).includes(owner.nodeId), false);
  assert.equal(Object.hasOwn(inMatch, 'health'), false);
  await conn.request('g.leave');
  await until(() => f.coordinator.platform.directory.bySession(conn.playerId) === null);
  // back in the lobby the browser holds a game-scope sample, so its ping asks for the whole summary (public/js/net.js)
  const returned = await conn.request('ping', { c: 3, full: true });
  assert.equal(returned.clusterLoad.scope, 'cluster'); assert.equal(returned.clusterLoad.nodes.length, 16);
  assert.equal(conn.frames.some(message => message.t.startsWith('cluster.')), false);
});

test('a game endpoint becoming unavailable changes only that lobby row and never exposes its identity', async t => {
  const f = await topology(t), conn = await f.join();
  await f.games[6].close(); await f.coordinator.platform.refresh();
  const pong = await conn.request('ping', { c: 4 });
  assert.equal(pong.clusterLoad.nodes[6].label, 'game-07');
  assert.equal(pong.clusterLoad.nodes[6].status, 'unavailable');
  assert.equal(pong.clusterLoad.nodes[6].loadState, 'unknown');
  assert.ok(pong.clusterLoad.nodes.filter((_, i) => i !== 6).every(node => node.status === 'ready'));
  assert.equal(JSON.stringify(pong).includes('private-'), false);
});

test('singleton pongs stay unchanged and a failing optional diagnostics provider does not break heartbeat', async t => {
  for (const getClusterLoad of [undefined, () => { throw new Error('private'); }, () => ({ scope: 'cluster', nodes: [{ label: 'private-hostname' }] })]) {
    const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, combatWorkers: 0, trialWorkers: 0, getClusterLoad });
    const conn = await client(server.url);
    t.after(async () => { conn.socket.terminate(); await server.close(); });
    const pong = await conn.request('ping', { c: 5 });
    assert.equal(Object.hasOwn(pong, 'clusterLoad'), false); assert.equal(pong.t, 'pong');
    assert.equal(JSON.stringify(pong).includes('private'), false);
  }
});

test('lobby heartbeats share one normalized cluster summary per second instead of rebuilding it per ping', async t => {
  let calls = 0;
  const getClusterLoad = () => { calls++; return { scope: 'cluster', nodes: Array.from({ length: 32 }, (_, i) => ({ label: publicGameLabel(i + 1), status: 'ready', loadState: 'normal', loadDetails: details })) }; };
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, combatWorkers: 0, trialWorkers: 0, getClusterLoad });
  const conn = await client(server.url);
  t.after(async () => { conn.socket.terminate(); await server.close(); });
  const pongs = [];
  for (let c = 1; c <= 3; c++) pongs.push(await conn.request('ping', c === 3 ? { c, full: true } : { c }));
  assert.equal(calls, 1);
  assert.equal(pongs[0].clusterLoad.nodes.length, 32);
  assert.deepEqual(pongs[2].clusterLoad, pongs[0].clusterLoad);
  await new Promise(resolve => setTimeout(resolve, 1050));
  await conn.request('ping', { c: 4 });
  assert.equal(calls, 2);
});

test('a connection gets the whole cluster summary once per CLUSTER_LOAD_EVERY_MS or when it asks; the pongs between are small', async t => {
  const getClusterLoad = () => ({ scope: 'cluster', nodes: Array.from({ length: 32 }, (_, i) => ({ label: publicGameLabel(i + 1), status: 'ready', loadState: 'normal', loadDetails: details })) });
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, combatWorkers: 0, trialWorkers: 0, getClusterLoad });
  const conn = await client(server.url), other = await client(server.url);
  t.after(async () => { conn.socket.terminate(); other.socket.terminate(); await server.close(); });
  const first = await conn.request('ping', { c: 1 });
  assert.equal(first.clusterLoad.nodes.length, 32);
  assert.equal(Object.hasOwn(first, 'clusterLoadSame'), false);
  const next = await conn.request('ping', { c: 2 });
  assert.equal(Object.hasOwn(next, 'clusterLoad'), false);
  assert.equal(next.clusterLoadSame, true);
  assert.ok(JSON.stringify(next).length < 400, `a heartbeat between summaries stays small (${JSON.stringify(next).length} B)`);
  const asked = await conn.request('ping', { c: 3, full: true });
  assert.equal(asked.clusterLoad.nodes.length, 32);
  // per connection: another browser still gets its own first summary
  assert.equal((await other.request('ping', { c: 1 })).clusterLoad.nodes.length, 32);
  assert.equal(CLUSTER_LOAD_EVERY_MS, 10_000);
});
