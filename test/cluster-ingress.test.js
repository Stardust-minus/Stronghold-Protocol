// Native HTTP/WS ingress and game endpoints; the coordinator here is a small
// protocol fixture, not full Lobby/browser/password-gate acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { startIngress } from '../server/cluster/ingress.js';
import { startGameNode } from '../server/cluster/game-node.js';
import { RemoteGamePlatform } from '../server/cluster/platform.js';
import { MATCHMAKING_VERSION } from '../shared/constants.js';

const ORIGIN = 'https://cluster-fixture.invalid';
const wait = (fn, ms = 2000) => new Promise((resolve, reject) => {
  const end = Date.now() + ms;
  const poll = () => { if (fn()) resolve(); else if (Date.now() >= end) reject(new Error('ingress fixture deadline')); else setTimeout(poll, 5); };
  poll();
});
async function connect(url, origin = ORIGIN) {
  const socket = new WebSocket(url.replace(/^http/, 'ws') + '/ws', { origin });
  const frames = [];
  socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
  socket.on('error', () => {});
  const closed = new Promise(resolve => socket.once('close', code => resolve(code)));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return { socket, frames, closed, send: message => socket.send(JSON.stringify(message)) };
}
class FixtureMatch {
  constructor(opts) { this.opts = opts; }
  start() {
    this.opts.broadcast({ t: 'm.public', phase: 'INFO_CHECK' });
    for (const seat of this.opts.seats) if (!seat.isBot) this.opts.send(seat.playerId, { t: 'm.private', playerId: seat.playerId });
  }
  onReconnect(id) { this.opts.send(id, { t: 'm.public', resync: true }); }
  onDisconnect() {}
  addSpectator(id) { this.opts.send(id, { t: 'm.public', observing: true }); }
  removeSpectator() {}
  handle(id, message) {
    if (message.t === 'g.watch') this.opts.sendEncoded(id, 'm.field', JSON.stringify({ t: 'm.field', fieldId: message.fieldId, padding: 'field'.repeat(500) }));
    return { ok: true };
  }
  dispose() {}
}
async function fixture(t) {
  const controlServer = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const controlWss = new WebSocketServer({ server: controlServer, path: '/ws', perMessageDeflate: false });
  const sessions = new Map(), controlRequests = [];
  controlWss.on('connection', socket => {
    socket.on('error', () => {});
    let uid;
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString()); controlRequests.push(message.t);
      if (message.t === 'hello') {
        uid = message.name;
        const previous = sessions.get(uid); if (previous && previous !== socket) previous.close(4001, 'session replaced');
        sessions.set(uid, socket);
        socket.send(JSON.stringify({ t: 'welcome', playerId: uid, token: 'fixture-only-token', name: uid, serverNow: Date.now(), version: 1 }));
      } else if (message.t === 'ping') socket.send(JSON.stringify({ t: 'pong', c: message.c, s: Date.now(), rid: message.rid, loadState: 'normal' }));
      else socket.send(JSON.stringify({ t: 'ok', rid: message.rid }));
    });
    socket.on('close', () => { if (sessions.get(uid) === socket) sessions.delete(uid); });
  });
  await new Promise(resolve => controlServer.listen(0, '127.0.0.1', resolve));
  const coordinatorUrl = `http://127.0.0.1:${controlServer.address().port}`;
  const key = randomBytes(32);
  const game = await startGameNode({ nodeId: 'game-a', generation: 'generation-a', build: 'test-build', key,
    MatchClass: FixtureMatch, streamMarkers: true, getLoadState: () => 'busy' });
  const nodes = [{ nodeId: 'game-a', url: game.url, key }];
  const entries = await Promise.all([0, 1].map(() => startIngress({ coordinatorUrl, nodes, origins: [ORIGIN], shutdownMs: 100 })));
  const platform = new RemoteGamePlatform({ nodes, build: 'test-build', protocol: 1,
    sendControl: (id, message) => {
      const socket = sessions.get(id); if (!socket || socket.readyState !== 1) return false;
      socket.send(JSON.stringify(message)); return true;
    } });
  const clients = [];
  t.after(async () => {
    await platform.close();
    for (const client of clients) client.socket.terminate();
    await Promise.all(entries.map(entry => entry.close()));
    await game.close();
    for (const socket of controlWss.clients) socket.terminate();
    await new Promise(resolve => controlWss.close(resolve));
    controlServer.closeAllConnections(); await new Promise(resolve => controlServer.close(resolve));
  });
  await platform.refresh();
  const client = async (id, entry = 0) => {
    const result = await connect(entries[entry].url); clients.push(result);
    result.send({ t: 'hello', name: id, version: 1, matchmakingVersion: MATCHMAKING_VERSION });
    await wait(() => result.frames.some(frame => frame.t === 'welcome'));
    return result;
  };
  const input = { roomCode: 'ABCD', build: 'test-build', protocol: 1, mode: 'coop', modeId: 'mode_multi_normal', difficulty: 'NORMAL',
    seed: 1, matchNo: 1, snapshotHz: 10, revivalEnabled: false,
    seats: [{ seat: 0, playerId: 'p1', name: 'Player1', isBot: false, connected: true, loadout: null }], spectators: ['watcher'] };
  const publish = staged => {
    staged.commit();
    for (const id of ['p1', 'watcher']) sessions.get(id)?.send(JSON.stringify({ t: 'room.state', code: 'ABCD', inMatch: true }));
    staged.publish();
    for (const id of ['p1', 'watcher']) sessions.get(id)?.send(JSON.stringify({ t: 'queue.state', state: 'matched', code: 'ABCD' }));
  };
  return { entries, game, platform, sessions, controlRequests, client, input, publish };
}

test('private ingress enforces Origin, exposes no health/RPC, and never accepts browser routing commands', async t => {
  const f = await fixture(t);
  await assert.rejects(connect(f.entries[0].url, 'https://foreign-fixture.invalid'));
  for (const path of ['/', '/healthz', '/_cluster/rpc']) assert.equal((await fetch(f.entries[0].url + path)).status, 404);
  const player = await f.client('p1');
  player.send({ t: 'cluster.prepare', nodeId: 'game-a', ticket: 'invalid', rid: 1 });
  await wait(() => player.frames.some(frame => frame.t === 'error'));
  assert.equal(f.controlRequests.includes('cluster.prepare'), false);
});

test('two real ingress endpoints preserve startup ordering, direct teammate view and spectator privacy', async t => {
  const f = await fixture(t);
  const player = await f.client('p1', 0), viewer = await f.client('watcher', 1);
  const staged = await f.platform.prepare(f.input);
  assert.equal(player.frames.some(frame => frame.t.startsWith('m.')), false);
  f.publish(staged);
  await f.platform.contexts.get(staged.assignmentId).publication;
  await wait(() => player.frames.some(frame => frame.t === 'queue.state') && viewer.frames.some(frame => frame.t === 'queue.state'));
  const roomIndex = player.frames.findIndex(frame => frame.t === 'room.state');
  const gameIndex = player.frames.findIndex(frame => frame.t === 'm.private');
  const matchedIndex = player.frames.findIndex(frame => frame.t === 'queue.state');
  assert.ok(roomIndex < gameIndex && gameIndex < matchedIndex);
  assert.equal(player.frames.some(frame => frame.t.startsWith('cluster.')), false);
  assert.equal(viewer.frames.some(frame => frame.t === 'm.private'), false);
  player.send({ t: 'g.watch', fieldId: 'teammate-field', rid: 2 });
  viewer.send({ t: 'g.watch', fieldId: 'teammate-field', rid: 3 });
  await wait(() => player.frames.some(frame => frame.t === 'm.field') && viewer.frames.some(frame => frame.t === 'm.field'));
  assert.equal(player.frames.find(frame => frame.t === 'm.field').padding.length, 2500);
  assert.equal(f.controlRequests.includes('g.watch'), false);
  player.send({ t: 'ping', c: Date.now(), rid: 4 });
  await wait(() => player.frames.some(frame => frame.t === 'pong' && frame.rid === 4));
  assert.equal(player.frames.find(frame => frame.t === 'pong' && frame.rid === 4).loadState, 'busy');
  assert.match(player.socket.extensions, /permessage-deflate/);
});

test('changing ingress restores the original spectator owner rather than allocating a second game', async t => {
  const f = await fixture(t);
  await f.client('p1', 0); const viewer = await f.client('watcher', 0);
  const staged = await f.platform.prepare(f.input); f.publish(staged);
  await f.platform.contexts.get(staged.assignmentId).publication;
  await wait(() => viewer.frames.some(frame => frame.t === 'queue.state'));
  viewer.socket.close(); await viewer.closed;
  const resumed = await f.client('watcher', 1);
  assert.equal(f.platform.resume(staged.assignmentId, 'watcher'), true);
  await wait(() => resumed.frames.some(frame => frame.t === 'm.public' && frame.observing));
  resumed.send({ t: 'g.watch', fieldId: 'teammate-field', rid: 9 });
  await wait(() => resumed.frames.some(frame => frame.t === 'm.field'));
  assert.equal(f.platform.directory.bySession('watcher').nodeId, 'game-a');
  assert.equal(f.game.gameHost.stats().matches, 1);
  assert.equal(resumed.frames.some(frame => frame.t.startsWith('cluster.')), false);
});
