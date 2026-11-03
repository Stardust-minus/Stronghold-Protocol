// Another official version on the cluster with SP_VERSION_PLACEMENT=coordinator (the fallback; the default places it on a
// game node, test/persist-version-room.test.js (e)): the coordinator plays such a room in its own version host
// (server/match/host/, kind 'version') and its frames ride the control channel (ClusterLobby.start).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { startCoordinator } from '../server/cluster/coordinator.js';
import { MATCHMAKING_VERSION, PROTOCOL_VERSION } from '../shared/constants.js';
import { PLAYER_CAPACITY_VERSION } from '../shared/playerCapacity.js';

test('versionPlacement coordinator: a version room starts in the coordinator\'s version host, no game node involved', async (t) => {
  const app = await startCoordinator({ nodes: [{ nodeId: 'game-a', url: 'http://127.0.0.1:9', key: randomBytes(32) }], build: 'version-room',
    port: 0, host: '127.0.0.1', quiet: true, assetIndex: false, studio: false, trustProxy: false, versionPlacement: 'coordinator' });
  t.after(() => app.close());
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, { origin: 'http://127.0.0.1' });
  t.after(() => ws.close());
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const frames = [];
  ws.on('message', (bytes) => frames.push(JSON.parse(bytes.toString())));
  const wait = (fn, ms = 20_000) => new Promise((resolve, reject) => {
    const end = Date.now() + ms;
    const poll = () => { const v = fn(); if (v) resolve(v); else if (Date.now() > end) reject(new Error('timed out')); else setTimeout(poll, 10); };
    poll();
  });
  let rid = 1;
  const ask = async (message) => {
    const id = ++rid;
    ws.send(JSON.stringify({ ...message, rid: id }));
    const reply = await wait(() => frames.find((f) => (f.t === 'ok' || f.t === 'error') && f.rid === id));
    assert.equal(reply.t, 'ok', JSON.stringify(reply));
  };
  ws.send(JSON.stringify({ t: 'hello', rid: 1, name: 'Version', version: PROTOCOL_VERSION, matchmakingVersion: MATCHMAKING_VERSION,
    playerCapacityVersion: PLAYER_CAPACITY_VERSION }));
  await wait(() => frames.find((f) => f.t === 'welcome'));
  await ask({ t: 'room.create', mode: 'solo', difficulty: 'FUNNY', version: 'act1autochess' });
  const state = await wait(() => frames.findLast((f) => f.t === 'room.state'));
  assert.equal(state.version, 'act1autochess');
  await ask({ t: 'room.contentReady', cs: state.content.cs });
  await ask({ t: 'room.start' });
  const view = await wait(() => frames.find((f) => f.t === 'm.public'));
  assert.equal(view.version, 'act1autochess');
  assert.equal(app.lobby.getRoom(state.code).match.hosted, true);
  assert.equal(app.versionHosts.stats().matches, 1);
});

// (rel26: with node placement — the default — the match's pings reach its game node, whose pong names it:
// test/persist-version-room.test.js; this covers the coordinator fallback, where the HUD showed 「未知」)
test('versionPlacement coordinator: a version match\'s pongs carry the coordinator\'s own load, not the game-node summary (its HUD showed 「未知」)', async (t) => {
  const app = await startCoordinator({ nodes: [{ nodeId: 'game-a', url: 'http://127.0.0.1:9', key: randomBytes(32), publicSlot: 1 }], build: 'version-room',
    port: 0, host: '127.0.0.1', quiet: true, assetIndex: false, studio: false, trustProxy: false, versionPlacement: 'coordinator' });
  t.after(() => app.close());
  const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, { origin: 'http://127.0.0.1' });
  t.after(() => ws.close());
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const frames = [];
  ws.on('message', (bytes) => frames.push(JSON.parse(bytes.toString())));
  const wait = (fn, ms = 20_000) => new Promise((resolve, reject) => {
    const end = Date.now() + ms;
    const poll = () => { const v = fn(); if (v) resolve(v); else if (Date.now() > end) reject(new Error('timed out')); else setTimeout(poll, 10); };
    poll();
  });
  let rid = 1;
  const send = async (message) => {
    const id = ++rid;
    ws.send(JSON.stringify({ ...message, rid: id }));
    return wait(() => frames.find((f) => ['ok', 'error', 'pong'].includes(f.t) && f.rid === id));
  };
  const ask = async (message) => { const reply = await send(message); assert.equal(reply.t, 'ok', JSON.stringify(reply)); };
  ws.send(JSON.stringify({ t: 'hello', rid: 1, name: 'Version', version: PROTOCOL_VERSION, matchmakingVersion: MATCHMAKING_VERSION,
    playerCapacityVersion: PLAYER_CAPACITY_VERSION }));
  await wait(() => frames.find((f) => f.t === 'welcome'));
  await ask({ t: 'room.create', mode: 'solo', difficulty: 'FUNNY', version: 'act1autochess' });
  const state = await wait(() => frames.findLast((f) => f.t === 'room.state'));
  const inRoom = await send({ t: 'ping', c: 1, full: true });
  assert.equal(inRoom.clusterLoad?.scope, 'cluster', 'the room (no match yet) still sees the cluster summary');
  await ask({ t: 'room.contentReady', cs: state.content.cs });
  await ask({ t: 'room.start' });
  await wait(() => frames.find((f) => f.t === 'm.public'));
  assert.equal(app.lobby.hostsMatchOf(app.registry.byId(frames.find((f) => f.t === 'welcome').playerId)), true);
  const inMatch = await send({ t: 'ping', c: 2, full: true });
  assert.equal(inMatch.t, 'pong');
  assert.equal(Object.hasOwn(inMatch, 'clusterLoad'), false, 'no game-node summary for a match this process hosts');
  assert.equal(Object.hasOwn(inMatch, 'clusterLoadSame'), false);
  assert.ok(['unknown', 'normal', 'busy', 'overloaded'].includes(inMatch.loadState), 'the coordinator\'s own load state');
});
