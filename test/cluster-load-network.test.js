// Actual loopback HTTP/WS and real coordinator/Lobby; fixture Match/pools only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { startCoordinator } from '../server/cluster/coordinator.js';
import { startGameNode } from '../server/cluster/game-node.js';
import { startIngress } from '../server/cluster/ingress.js';
import { startServer } from '../server/index.js';
import { MATCHMAKING_VERSION } from '../shared/constants.js';
import { publicGameLabel } from '../shared/cluster-load.js';

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
    pending.set(rid, { timer, resolve, reject }); socket.send(JSON.stringify({ t: type, ...fields, rid }));
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
  const returned = await conn.request('ping', { c: 3 });
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
