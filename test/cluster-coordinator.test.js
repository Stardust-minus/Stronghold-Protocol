// Complete native transport assembly with the real Lobby/matching/registry and
// a fixture Match. Not a gameplay/browser or independent-process CPU benchmark.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { startCoordinator } from '../server/cluster/coordinator.js';
import { startGameNode } from '../server/cluster/game-node.js';
import { startIngress } from '../server/cluster/ingress.js';
import { createRpcAuthenticator, createRpcClient } from '../server/cluster/rpc.js';
import { sendEndReceipt } from '../server/cluster/receipts.js';
import { MATCHMAKING_VERSION } from '../shared/constants.js';

const ORIGIN = 'https://full-cluster-fixture.invalid';
const until = async (condition, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (!condition()) { if (Date.now() >= deadline) throw new Error('coordinator fixture deadline'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
async function client(url, name, token) {
  const socket = new WebSocket(url.replace(/^http/, 'ws') + '/ws', { origin: ORIGIN });
  const frames = [], pending = new Map(); let rid = 0;
  socket.on('error', () => {});
  socket.on('message', bytes => {
    const message = JSON.parse(bytes.toString()); frames.push(message);
    const request = pending.get(message.rid);
    if (request) { pending.delete(message.rid); clearTimeout(request.timer); if (message.t === 'error') request.reject(Object.assign(new Error(message.code), { code: message.code })); else request.resolve(message); }
  });
  const closed = new Promise(resolve => socket.once('close', code => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('fixture closed')); }
    pending.clear(); resolve(code);
  }));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ t: 'hello', name, token, version: 1, matchmakingVersion: MATCHMAKING_VERSION }));
  await until(() => frames.some(frame => frame.t === 'welcome'));
  const welcome = frames.find(frame => frame.t === 'welcome');
  assert.equal(Object.keys(welcome)[0], 't', 'the ingress can inspect the frame type without parsing optional DIY metadata');
  assert.ok(Array.isArray(welcome.diyKitted), 'the new operator kit catalog survives the cluster ingress');
  const request = (t, fields = {}) => new Promise((resolve, reject) => {
    const id = ++rid;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('fixture request deadline')); }, 7000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ t, ...fields, rid: id }));
  });
  return { socket, frames, request, playerId: welcome.playerId, token: welcome.token, closed };
}
async function fixture(t, options = {}) {
  const configs = (options.oneNode ? ['game-a'] : ['game-a', 'game-b']).map(nodeId => ({ nodeId, generation: `${nodeId}-generation`, key: randomBytes(32), build: 'whole-fixture' }));
  const matches = [], events = new Map(), receipts = [], receiptAcks = [];
  class FixtureMatch {
    constructor(opts) { this.opts = opts; this.spectators = new Set(opts.spectators); this.departures = []; matches.push(this); }
    start() {
      this.opts.broadcast({ t: 'm.public', phase: 'INFO_CHECK', marker: this.opts.roomCode });
      for (const seat of this.opts.seats) if (!seat.isBot) this.opts.send(seat.playerId, { t: 'm.private', playerId: seat.playerId });
    }
    onReconnect(id) { this.opts.send(id, { t: 'm.public', resync: true }); }
    onDisconnect() {}
    onLeave(id) { this.departures.push(['leave', id]); }
    addSpectator(id) { this.spectators.add(id); this.opts.send(id, { t: 'm.public', observer: true, marker: this.opts.roomCode }); }
    removeSpectator(id) { this.spectators.delete(id); this.departures.push(['removeSpectator', id]); }
    setLoadout() { return { ok: true }; }
    handle(id, message) {
      if (message.t === 'g.watch') this.opts.sendEncoded(id, 'm.field', JSON.stringify({ t: 'm.field', fieldId: message.fieldId, marker: this.opts.roomCode }));
      return { ok: true };
    }
    finish() {
      this.opts.broadcast({ t: 'm.public', phase: 'RESULT', marker: this.opts.roomCode });
      for (const id of [...this.opts.seats.filter(s => !s.isBot).map(s => s.playerId), ...this.spectators]) {
        this.opts.send(id, { t: 'm.result', marker: this.opts.roomCode, reason: 'fixture-end', playerId: id,
          own: `only-${id}`, ...(options.largeResult ? { padding: 'x'.repeat(70_000) } : {}) });
      }
      this.opts.onEnd({ reason: 'fixture-end' });
    }
    dispose() {}
  }
  const games = await Promise.all(configs.map(config => startGameNode({ ...config, streamMarkers: true, MatchClass: FixtureMatch,
    onEnd: async receipt => {
      receipts.push({ nodeId: config.nodeId, nodeGeneration: config.generation, receipt });
      const transport = events.get(config.nodeId);
      const event = options.receiptDelay ? { async call(op, payload, opts) {
        if (op === 'end.commit') await new Promise(resolve => setTimeout(resolve, options.receiptDelay));
        return transport.call(op, payload, opts);
      } } : transport;
      const ack = await sendEndReceipt({ client: event, nodeGeneration: config.generation, receipt });
      receiptAcks.push(ack);
    } })));
  const nodes = configs.map((config, i) => ({ ...config, url: games[i].url }));
  const coordinator = await startCoordinator({ nodes, build: 'whole-fixture', port: 0, quiet: true, heartbeatMs: 500 });
  for (const config of configs) events.set(config.nodeId, createRpcClient({ url: coordinator.privateUrl,
    authority: createRpcAuthenticator({ key: config.key, scope: config.nodeId }) }));
  const entries = await Promise.all([0, 1].map(() => startIngress({ coordinatorUrl: coordinator.url, nodes, origins: [ORIGIN], shutdownMs: 100 })));
  const clients = [];
  t.after(async () => {
    for (const connection of clients) connection.socket.terminate();
    await Promise.all(entries.map(entry => entry.close()));
    await coordinator.close();
    for (const event of events.values()) event.close();
    await Promise.all(games.map(game => game.close()));
  });
  const join = async (name, entry = 0, token) => { const connection = await client(entries[entry].url, name, token); clients.push(connection); return connection; };
  const match = async (prefix, difficulty = 'NORMAL') => {
    const players = await Promise.all([0, 1, 2, 3].map(i => join(`${prefix}${i}`, i % 2)));
    for (const player of players) await player.request('queue.join', { difficulty });
    await until(() => players.every(p => p.frames.some(frame => frame.t === 'queue.state' && frame.state === 'offered')));
    for (const player of players) {
      const offer = player.frames.filter(frame => frame.t === 'queue.state' && frame.state === 'offered').at(-1);
      await player.request('queue.accept', { ticketId: offer.ticketId, offerId: offer.offerId, revivalVote: true });
    }
    await until(() => players.every(p => p.frames.some(frame => frame.t === 'queue.state' && frame.state === 'matched')));
    const room = players[0].frames.filter(frame => frame.t === 'room.state' && frame.inMatch).at(-1);
    return { players, room, owner: coordinator.platform.directory.byRoom(room.code) };
  };
  return { coordinator, games, entries, matches, join, match, nodes, configs, events, receipts, receiptAcks, MatchClass: FixtureMatch };
}

test('real global matchmaking across two ingresses assigns intact cohorts to two game owners', async t => {
  const f = await fixture(t);
  const a = await f.match('Alpha'), b = await f.match('Beta');
  assert.notEqual(a.owner.nodeId, b.owner.nodeId);
  assert.equal(f.coordinator.lobby.stats().online, 8);
  assert.equal(f.coordinator.lobby.stats().matches, 2);
  for (const group of [a, b]) {
    for (const player of group.players) {
      assert.equal(f.coordinator.platform.directory.bySession(player.playerId).assignmentId, group.owner.assignmentId);
      const roomAt = player.frames.findIndex(frame => frame.t === 'room.state' && frame.code === group.room.code && frame.inMatch);
      const privateAt = player.frames.findIndex(frame => frame.t === 'm.private');
      const matchedAt = player.frames.findIndex(frame => frame.t === 'queue.state' && frame.state === 'matched');
      assert.ok(roomAt < privateAt && privateAt < matchedAt);
      assert.equal(player.frames.some(frame => frame.t.startsWith('cluster.')), false);
    }
  }
  await a.players[0].request('g.watch', { fieldId: a.players[1].playerId });
  await until(() => a.players[0].frames.some(frame => frame.t === 'm.field'));
  assert.equal(a.players[0].frames.find(frame => frame.t === 'm.field').marker, a.room.code);
  const watcher = await f.join('Observer', 1);
  await watcher.request('room.spectate', { code: a.room.code });
  await until(() => watcher.frames.some(frame => frame.t === 'm.public' && frame.observer));
  await watcher.request('g.watch', { fieldId: a.players[1].playerId });
  await until(() => watcher.frames.some(frame => frame.t === 'm.field'));
  assert.equal(watcher.frames.some(frame => frame.t === 'm.private'), false);
});

test('one live topology expands to four ingress endpoints without restarting its coordinator or game', async t => {
  const f = await fixture(t), group = await f.match('Entry');
  const registry = f.coordinator.registry, room = f.coordinator.lobby.getRoom(group.room.code);
  const added = await Promise.all([0, 1].map(() => startIngress({ coordinatorUrl: f.coordinator.url, nodes: f.nodes, origins: [ORIGIN] })));
  f.entries.push(...added); // The fixture cleanup owns these too.
  const player = group.players[0]; player.socket.close(); await player.closed;
  const resumed = await f.join('Entry0', 3, player.token);
  await until(() => resumed.frames.some(frame => frame.t === 'm.public' && frame.resync));
  assert.equal(resumed.playerId, player.playerId);
  assert.strictEqual(f.coordinator.registry, registry);
  assert.strictEqual(f.coordinator.lobby.getRoom(group.room.code), room);
  assert.equal(f.coordinator.platform.directory.bySession(player.playerId).assignmentId, group.owner.assignmentId);
  assert.equal(f.games.reduce((n, node) => n + node.gameHost.stats().matches, 0), 1);
});

test('hot compute registration is append-only and old matches keep their original owner', async t => {
  const f = await fixture(t), old = await f.match('Old');
  const config = { nodeId: 'game-c', generation: 'generation-c', key: randomBytes(32), build: 'whole-fixture' };
  f.events.set(config.nodeId, createRpcClient({ url: f.coordinator.privateUrl, authority: createRpcAuthenticator({ key: config.key, scope: config.nodeId }) }));
  const next = await startGameNode({ ...config, streamMarkers: true, MatchClass: f.MatchClass,
    onEnd: receipt => sendEndReceipt({ client: f.events.get(config.nodeId), nodeGeneration: config.generation, receipt }) });
  f.games.push(next);
  const all = [...f.nodes, { ...config, url: next.url }];
  for (const ingress of f.entries) assert.deepEqual(ingress.addRoutes(all), ['game-c']);
  assert.deepEqual(await f.coordinator.addNodes(all), ['game-c']);
  assert.equal(f.coordinator.platform.directory.byRoom(old.room.code).nodeId, old.owner.nodeId);
  const b = await f.match('Next'), c = await f.match('Third');
  assert.notEqual(b.owner.nodeId, c.owner.nodeId);
  assert.equal(c.owner.nodeId, 'game-c');
  await old.players[0].request('g.watch', { fieldId: old.players[1].playerId });
  assert.equal(f.coordinator.platform.directory.byRoom(old.room.code).assignmentId, old.owner.assignmentId);
  await assert.rejects(f.coordinator.addNodes(all.map(node => node.nodeId === old.owner.nodeId ? { ...node, key: randomBytes(32) } : node)));
  await assert.rejects(f.coordinator.addNodes(all.slice(1)));
  assert.throws(() => f.entries[0].addRoutes(all.map(node => node.nodeId === old.owner.nodeId ? { ...node, url: 'http://127.0.0.1:9/' } : node)));
  assert.throws(() => f.entries[0].addRoutes(all.slice(1)));
});

test('authenticated terminal receipt restores the original lobby and keeps per-member replay', async t => {
  const f = await fixture(t), group = await f.match('Gamma');
  await f.coordinator.platform.contexts.get(group.owner.assignmentId).publication;
  const match = f.matches.find(match => match.opts.roomCode === group.room.code);
  match.finish();
  await until(() => f.coordinator.lobby.getRoom(group.room.code)?.match === null);
  await until(() => group.players.every(player => player.frames.some(frame => frame.t === 'room.state' && !frame.inMatch)));
  const room = f.coordinator.lobby.getRoom(group.room.code);
  assert.ok(room.replay);
  assert.equal(room.replay.frames.size, 4);
  assert.equal(room.lastSummary.reason, 'fixture-end');
  const player = group.players[0]; player.socket.close(); await player.closed;
  const resumed = await f.join('Gamma0', 1, player.token);
  await until(() => resumed.frames.some(frame => frame.t === 'm.result'));
  assert.equal(resumed.playerId, player.playerId);
  assert.equal(resumed.frames.find(frame => frame.t === 'm.result').marker, group.room.code);
});

// Deliberately make the actual game endpoint emit the old direct terminal wire.
// Only the final public/result pair is delayed, in order, on each real game WS.
// This models an independent connection lagging the authenticated end RPC.
function delayGameEnd(t, game, ms) {
  game.gameHost.terminalControl = false;
  const timers = new Set(), held = [];
  for (const socket of game.wss.clients) {
    const original = socket.send.bind(socket);
    socket.send = (raw, ...args) => {
      const frame = JSON.parse(raw.toString());
      if (frame.t !== 'm.result' && !(frame.t === 'm.public' && frame.phase === 'RESULT')) return original(raw, ...args);
      held.push(frame.t);
      const timer = setTimeout(() => { timers.delete(timer); original(raw, ...args); }, ms);
      timers.add(timer);
    };
  }
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  return held;
}
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test('one real client receives terminal receipt exactly once before lobby/teardown despite ordered 200ms game-end lag; hello replays', async t => {
  const f = await fixture(t), player = await f.join('SoloEnd');
  await player.request('room.create', { mode: 'solo', difficulty: 'NORMAL' });
  await player.request('room.start');
  const room = f.coordinator.lobby.roomOf(f.coordinator.registry.byId(player.playerId));
  const owner = f.coordinator.platform.directory.byRoom(room.code);
  await f.coordinator.platform.contexts.get(owner.assignmentId).publication;
  const game = f.games.find(game => game.gameHost.get(owner.assignmentId));
  const held = delayGameEnd(t, game, 200);
  const start = player.frames.length;
  f.matches.find(match => match.opts.roomCode === room.code).finish();
  await until(() => f.receiptAcks.length === 1 && !f.coordinator.platform.contexts.has(owner.assignmentId) && !game.gameHost.get(owner.assignmentId));
  await until(() => player.frames.slice(start).some(frame => frame.t === 'room.state' && !frame.inMatch));
  assert.deepEqual(f.receiptAcks, [{ accepted: true, pending: false }]);
  assert.deepEqual(held, ['m.public', 'm.result']);
  await new Promise(resolve => setTimeout(resolve, 230));
  const end = player.frames.slice(start);
  assert.equal(end.filter(frame => frame.t === 'm.public' && frame.phase === 'RESULT').length, 1);
  assert.equal(end.filter(frame => frame.t === 'm.result').length, 1);
  assert.ok(end.findIndex(frame => frame.t === 'm.public' && frame.phase === 'RESULT') < end.findIndex(frame => frame.t === 'm.result'));
  assert.ok(end.findIndex(frame => frame.t === 'm.result') < end.findIndex(frame => frame.t === 'room.state' && !frame.inMatch));
  assert.equal(end.find(frame => frame.t === 'm.result').own, `only-${player.playerId}`);
  const event = f.receipts[0];
  assert.deepEqual(await sendEndReceipt({ client: f.events.get(event.nodeId), nodeGeneration: event.nodeGeneration, receipt: event.receipt }),
    { accepted: true, pending: false });
  assert.equal(player.frames.filter(frame => frame.t === 'm.result').length, 1, 'receipt retry does not redeliver live result');
  player.socket.close(); await player.closed;
  const resumed = await f.join('SoloEnd', 1, player.token);
  await until(() => resumed.frames.some(frame => frame.t === 'm.result'));
  assert.equal(resumed.playerId, player.playerId);
  assert.equal(resumed.frames.filter(frame => frame.t === 'm.result').length, 1);
  assert.equal(resumed.frames.find(frame => frame.t === 'm.result').own, `only-${player.playerId}`);
});

test('fast final game frames and delayed >64KiB terminal control preserve exact-once per-player/observer privacy', async t => {
  const f = await fixture(t, { receiptDelay: 200, largeResult: true }), group = await f.match('PrivateEnd');
  const observer = await f.join('EndObserver', 1);
  await observer.request('room.spectate', { code: group.room.code });
  await until(() => observer.frames.some(frame => frame.t === 'm.public' && frame.observer));
  await f.coordinator.platform.contexts.get(group.owner.assignmentId).publication;
  const game = f.games.find(game => game.gameHost.get(group.owner.assignmentId));
  game.gameHost.terminalControl = false; // Exercise ingress suppression too, not just host suppression.
  const all = [...group.players, observer], offsets = all.map(player => player.frames.length);
  f.matches.find(match => match.opts.roomCode === group.room.code).finish();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(all.every(player => player.frames.every(frame => frame.t !== 'm.result')));
  await until(() => f.receiptAcks.length === 1 && all.every(player => player.frames.some(frame => frame.t === 'm.result')));
  assert.ok(Buffer.byteLength(JSON.stringify(f.receipts[0].receipt)) > 64 * 1024);
  for (const [i, player] of all.entries()) {
    const frames = player.frames.slice(offsets[i]);
    assert.equal(frames.filter(frame => frame.t === 'm.result').length, 1);
    assert.equal(frames.filter(frame => frame.t === 'm.public' && frame.phase === 'RESULT').length, 1);
    const result = frames.find(frame => frame.t === 'm.result');
    assert.equal(result.playerId, player.playerId);
    assert.equal(result.own, `only-${player.playerId}`);
    assert.equal(result.padding.length, 70_000);
    assert.equal(frames.some(frame => frame.t.startsWith('cluster.')), false);
    assert.ok(frames.findIndex(frame => frame.t === 'm.result') < frames.findIndex(frame => frame.t === 'room.state' && !frame.inMatch));
  }
  assert.equal(observer.frames.some(frame => frame.t === 'm.private'), false);
});

test('one pre-dispatch remove RPC fault revokes observer ingress immediately; bounded guarded compensation cannot touch a new room', async t => {
  const f = await fixture(t), group = await f.match('Revoke'), other = await f.match('Unaffected');
  const observer = await f.join('RevokedObs', 1);
  await observer.request('room.spectate', { code: group.room.code });
  await until(() => observer.frames.some(frame => frame.t === 'm.public' && frame.observer && frame.marker === group.room.code));
  await observer.request('g.watch', { fieldId: group.players[1].playerId });
  const node = f.coordinator.platform.nodes.get(group.owner.nodeId), original = node.client.call.bind(node.client);
  const retry = deferred(); let attempts = 0;
  node.client = { close: node.client.close, call: async (op, payload, opts) => {
    if (op === 'removeSpectator' && payload.assignmentId === group.owner.assignmentId && payload.sessionId === observer.playerId) {
      attempts++;
      assert.equal(payload.nodeGeneration, group.owner.generation);
      assert.equal(payload.actorGeneration, f.coordinator.platform.assignmentInfo(group.owner.assignmentId).actorGeneration);
      if (attempts === 1) throw Object.assign(new Error('synthetic pre-dispatch failure'), { code: 'TRANSPORT' });
      await retry.promise;
    }
    return original(op, payload, opts);
  } };
  t.after(() => retry.resolve());
  const removed = group.players[0].request('room.removeSpectator', { playerId: observer.playerId });
  await until(() => attempts === 2 && observer.frames.some(frame => frame.t === 'room.closed' && frame.reason === 'kicked'));
  const context = f.coordinator.platform.contexts.get(group.owner.assignmentId);
  assert.equal(f.coordinator.registry.byId(observer.playerId).roomCode, null);
  assert.equal(f.coordinator.platform.directory.bySession(observer.playerId), null);
  assert.equal(context.members.has(observer.playerId), false);
  assert.equal(f.coordinator.platform.resume(group.owner.assignmentId, observer.playerId), false);
  const game = f.games.find(game => game.gameHost.get(group.owner.assignmentId));
  await until(() => game.gameHost.member(group.owner.assignmentId, observer.playerId)?.connected === false);
  const offset = observer.frames.length;
  await assert.rejects(observer.request('g.watch', { fieldId: group.players[1].playerId }), error => error.code === 'NOT_IN_ROOM');
  f.matches.find(match => match.opts.roomCode === group.room.code).opts.send(observer.playerId, { t: 'm.field', marker: 'revoked-private' });
  assert.equal(observer.frames.slice(offset).some(frame => frame.marker === 'revoked-private'), false);
  // Move the same session elsewhere BEFORE old-node cleanup finishes.
  await observer.request('room.spectate', { code: other.room.code });
  await until(() => observer.frames.some(frame => frame.t === 'm.public' && frame.observer && frame.marker === other.room.code));
  await observer.request('g.watch', { fieldId: other.players[1].playerId });
  retry.resolve();
  assert.equal((await removed).t, 'ok');
  await until(() => game.gameHost.member(group.owner.assignmentId, observer.playerId) === null);
  assert.equal(attempts, 2);
  assert.equal(f.coordinator.platform.directory.bySession(observer.playerId).assignmentId, other.owner.assignmentId);
  assert.equal(f.coordinator.lobby.getRoom(group.room.code).match !== null, true);
  assert.equal(f.coordinator.lobby.getRoom(other.room.code).match !== null, true);
  await observer.request('g.watch', { fieldId: other.players[0].playerId });
  assert.equal(observer.frames.slice(offset).some(frame => frame.marker === group.room.code), false);
  assert.equal(observer.frames.some(frame => frame.t === 'm.private'), false);
});

test('lost departure reply retries idempotently: player left remains permanent and onLeave is not repeated', async t => {
  const f = await fixture(t), group = await f.match('LostReply');
  const player = group.players[1], node = f.coordinator.platform.nodes.get(group.owner.nodeId), original = node.client.call.bind(node.client);
  let calls = 0;
  node.client = { close: node.client.close, call: async (op, payload, opts) => {
    const result = await original(op, payload, opts);
    if (op === 'leave' && payload.sessionId === player.playerId && ++calls === 1) {
      throw Object.assign(new Error('synthetic lost reply'), { code: 'TRANSPORT' });
    }
    return result;
  } };
  assert.equal((await player.request('room.leave')).t, 'ok');
  assert.equal(calls, 2);
  const game = f.games.find(game => game.gameHost.get(group.owner.assignmentId));
  assert.equal(game.gameHost.member(group.owner.assignmentId, player.playerId), null);
  assert.equal(f.coordinator.platform.directory.bySession(player.playerId), null);
  assert.equal(f.coordinator.platform.resume(group.owner.assignmentId, player.playerId), false);
  const match = f.matches.find(match => match.opts.roomCode === group.room.code);
  assert.equal(match.departures.filter(([method, id]) => method === 'leave' && id === player.playerId).length, 1);
  assert.equal(f.coordinator.lobby.getRoom(group.room.code).seatOf(player.playerId).left, true);
});

test('pending admission departure is fenced before its late reply; cleanup cannot reattach the observer after a room switch', async t => {
  const f = await fixture(t), group = await f.match('Pending'), other = await f.match('SafeRoom');
  const observer = await f.join('PendingObs', 1), node = f.coordinator.platform.nodes.get(group.owner.nodeId);
  const original = node.client.call.bind(node.client), held = deferred(); let dispatched = false;
  node.client = { close: node.client.close, call: async (op, payload, opts) => {
    const result = await original(op, payload, opts);
    if (op === 'addSpectator' && payload.assignmentId === group.owner.assignmentId && payload.sessionId === observer.playerId) {
      dispatched = true; await held.promise;
    }
    return result;
  } };
  t.after(() => held.resolve());
  const admitted = observer.request('room.spectate', { code: group.room.code }).then(() => null, error => error.code);
  await until(() => dispatched);
  const removed = group.players[0].request('room.removeSpectator', { playerId: observer.playerId });
  await until(() => observer.frames.some(frame => frame.t === 'room.closed' && frame.reason === 'kicked'));
  assert.equal(f.coordinator.platform.directory.bySession(observer.playerId), null);
  await assert.rejects(observer.request('g.watch', { fieldId: group.players[1].playerId }), error => error.code === 'NOT_IN_ROOM');
  await observer.request('room.spectate', { code: other.room.code });
  await until(() => observer.frames.some(frame => frame.t === 'm.public' && frame.observer && frame.marker === other.room.code));
  held.resolve();
  assert.equal(await admitted, 'WRONG_PHASE');
  assert.equal((await removed).t, 'ok');
  const game = f.games.find(game => game.gameHost.get(group.owner.assignmentId));
  assert.equal(game.gameHost.member(group.owner.assignmentId, observer.playerId), null);
  assert.equal(f.coordinator.platform.directory.bySession(observer.playerId).assignmentId, other.owner.assignmentId);
  await observer.request('g.watch', { fieldId: other.players[0].playerId });
  assert.equal(observer.frames.some(frame => frame.t === 'm.field' && frame.marker === group.room.code), false);
});

test('terminal receipt overtaking a successful observer admission reply still delivers once and never late-rebinds', async t => {
  const f = await fixture(t), group = await f.match('EndPending'), observer = await f.join('PendingEnd', 1);
  await f.coordinator.platform.contexts.get(group.owner.assignmentId).publication;
  const node = f.coordinator.platform.nodes.get(group.owner.nodeId), original = node.client.call.bind(node.client), held = deferred();
  let dispatched = false;
  node.client = { close: node.client.close, call: async (op, payload, opts) => {
    const result = await original(op, payload, opts);
    if (op === 'addSpectator' && payload.sessionId === observer.playerId) { dispatched = true; await held.promise; }
    return result;
  } };
  t.after(() => held.resolve());
  const admitted = observer.request('room.spectate', { code: group.room.code });
  await until(() => dispatched);
  f.matches.find(match => match.opts.roomCode === group.room.code).finish();
  await until(() => f.receiptAcks.length === 1 && observer.frames.some(frame => frame.t === 'm.result'));
  assert.equal(observer.frames.filter(frame => frame.t === 'm.result').length, 1);
  assert.equal(observer.frames.find(frame => frame.t === 'm.result').own, `only-${observer.playerId}`);
  held.resolve(); assert.equal((await admitted).t, 'ok');
  assert.equal(f.coordinator.platform.directory.bySession(observer.playerId), null);
  assert.equal(f.coordinator.lobby.getRoom(group.room.code).spectatorOf(observer.playerId) !== null, true);
  const offset = observer.frames.length;
  await assert.rejects(observer.request('g.watch', { fieldId: group.players[0].playerId }), error => error.code === 'WRONG_PHASE');
  assert.equal(observer.frames.slice(offset).some(frame => frame.t === 'm.public' || frame.t === 'm.result'), false);
});

test('exhausted member revocation retires only its assignment, never all games on the node', async t => {
  const f = await fixture(t, { oneNode: true }), group = await f.match('FailClosed'), other = await f.match('StayLive');
  assert.equal(group.owner.nodeId, other.owner.nodeId);
  const observer = await f.join('FailedObs', 1);
  await observer.request('room.spectate', { code: group.room.code });
  await until(() => observer.frames.some(frame => frame.t === 'm.public' && frame.observer));
  const node = f.coordinator.platform.nodes.get(group.owner.nodeId), original = node.client.call.bind(node.client); let attempts = 0;
  node.client = { close: node.client.close, call: async (op, payload, opts) => {
    if (op === 'removeSpectator' && payload.assignmentId === group.owner.assignmentId) {
      attempts++; throw Object.assign(new Error('synthetic persistent transport failure'), { code: 'TRANSPORT' });
    }
    return original(op, payload, opts);
  } };
  await assert.rejects(group.players[0].request('room.removeSpectator', { playerId: observer.playerId }), error => error.code === 'INTERNAL');
  assert.equal(attempts, 3);
  assert.equal(f.coordinator.lobby.getRoom(group.room.code), null);
  assert.equal(f.coordinator.platform.contexts.has(group.owner.assignmentId), false);
  const game = f.games.find(game => game.gameHost.get(other.owner.assignmentId));
  assert.equal(f.coordinator.lobby.getRoom(other.room.code).match !== null, true);
  assert.equal(game.gameHost.get(other.owner.assignmentId).state, 'committed');
  await other.players[0].request('g.watch', { fieldId: other.players[1].playerId });
});

test('node release may close game WS before delayed ordered control terminal without closing the browser', async t => {
  const f = await fixture(t), player = await f.join('EndClose');
  await player.request('room.create', { mode: 'solo', difficulty: 'NORMAL' });
  await player.request('room.start');
  const room = f.coordinator.lobby.roomOf(f.coordinator.registry.byId(player.playerId));
  const owner = f.coordinator.platform.directory.byRoom(room.code);
  await f.coordinator.platform.contexts.get(owner.assignmentId).publication;
  const game = f.games.find(game => game.gameHost.get(owner.assignmentId));
  const control = f.coordinator.registry.byId(player.playerId).ws, original = control.send.bind(control), timers = new Set();
  // Hold the complete ordered terminal control sequence, while actual node
  // release closes the independent game transport immediately. No delay exists
  // in the implementation; this is only a transport fault injection.
  control.send = (raw, ...args) => {
    const timer = setTimeout(() => { timers.delete(timer); original(raw, ...args); }, 250);
    timers.add(timer);
  };
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  const offset = player.frames.length;
  f.matches.find(match => match.opts.roomCode === room.code).finish();
  await until(() => f.receiptAcks.length === 1 && !game.gameHost.get(owner.assignmentId));
  await until(() => player.frames.slice(offset).some(frame => frame.t === 'room.state' && !frame.inMatch));
  assert.equal(player.socket.readyState, WebSocket.OPEN);
  const frames = player.frames.slice(offset);
  assert.equal(frames.filter(frame => frame.t === 'm.result').length, 1);
  assert.ok(frames.findIndex(frame => frame.t === 'm.result') < frames.findIndex(frame => frame.t === 'room.state' && !frame.inMatch));
  control.send = original;
  assert.equal((await player.request('ping', { c: Date.now() })).t, 'pong');
});

test('late old terminal/detach/terminate markers cannot deliver results to or close a newly bound actor', async t => {
  const f = await fixture(t), player = await f.join('EndFence');
  await player.request('room.create', { mode: 'solo', difficulty: 'NORMAL' });
  await player.request('room.start');
  const room = f.coordinator.lobby.roomOf(f.coordinator.registry.byId(player.playerId));
  const old = f.coordinator.platform.directory.byRoom(room.code);
  await f.coordinator.platform.contexts.get(old.assignmentId).publication;
  f.matches.find(match => match.opts.roomCode === room.code).finish();
  await until(() => player.frames.some(frame => frame.t === 'm.result') && f.coordinator.platform.directory.byRoom(room.code) === null);
  await player.request('room.start');
  const current = f.coordinator.platform.directory.byRoom(room.code);
  assert.notEqual(current.assignmentId, old.assignmentId);
  await f.coordinator.platform.contexts.get(current.assignmentId).publication;
  await until(() => player.frames.filter(frame => frame.t === 'm.private').length === 2);
  const offset = player.frames.length, control = f.coordinator.registry.byId(player.playerId).ws;
  for (const frame of [
    { t: 'cluster.terminal', assignmentId: old.assignmentId, sessionId: player.playerId,
      lastPublic: { t: 'm.public', phase: 'RESULT' }, result: { t: 'm.result', own: 'stale-result' } },
    { t: 'cluster.detach', assignmentId: old.assignmentId },
    { t: 'cluster.terminate', assignmentId: old.assignmentId },
  ]) control.send(JSON.stringify(frame));
  await player.request('g.watch', { fieldId: player.playerId });
  await until(() => player.frames.slice(offset).some(frame => frame.t === 'm.field'));
  assert.equal(player.frames.slice(offset).some(frame => frame.t === 'm.result'), false);
  assert.equal(player.socket.readyState, WebSocket.OPEN);
  assert.equal(f.coordinator.platform.directory.bySession(player.playerId).assignmentId, current.assignmentId);
});

test('unknown game transport closure still fails closed within its bounded deadline without retiring other actors', async t => {
  const f = await fixture(t, { oneNode: true }), group = await f.match('DropOne'), other = await f.match('LiveOther');
  const game = f.games.find(game => game.gameHost.get(group.owner.assignmentId));
  const player = group.players[0];
  game.gameHost.contexts.get(group.owner.assignmentId).members.get(player.playerId).binding.channel.close(1011, 'synthetic transport fault');
  await until(() => player.socket.readyState === WebSocket.CLOSED, 1500);
  assert.equal(player.frames.some(frame => frame.t === 'm.result'), false, 'transport loss cannot manufacture settlement');
  await other.players[0].request('g.watch', { fieldId: other.players[1].playerId });
  assert.equal(game.gameHost.get(other.owner.assignmentId).state, 'committed');
  assert.equal(f.coordinator.lobby.getRoom(other.room.code).match !== null, true);
});

test('slow terminal browser closes through existing backpressure and receives its bounded own replay on reconnect', async t => {
  const f = await fixture(t), group = await f.match('SlowEnd'), slow = group.players[0];
  const serverSocket = [...f.entries[0].wss.clients].find(socket => socket._socket.remotePort === slow.socket._socket.localPort);
  Object.defineProperty(serverSocket, 'bufferedAmount', { value: 17 * 1024 * 1024 });
  f.matches.find(match => match.opts.roomCode === group.room.code).finish();
  await slow.closed;
  await until(() => f.receiptAcks.length === 1 && f.coordinator.lobby.getRoom(group.room.code)?.replay);
  assert.equal(slow.frames.some(frame => frame.t === 'm.result'), false);
  const resumed = await f.join('SlowEnd0', 1, slow.token);
  await until(() => resumed.frames.some(frame => frame.t === 'm.result'));
  assert.equal(resumed.frames.find(frame => frame.t === 'm.result').own, `only-${slow.playerId}`);
  assert.equal(resumed.frames.filter(frame => frame.t === 'm.result').length, 1);
});
