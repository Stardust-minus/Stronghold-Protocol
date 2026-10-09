// Two real, independent ingress Node processes on localhost, one real coordinator
// (Lobby/queue/registry/platform) and one real authenticated game-node transport.
// The Match below is deliberately a FIXTURE: no combat Worker, renderer, browser,
// TLS/password gate, Nginx, WAN throughput or capacity/CPU benchmark is claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startCoordinator } from '../server/cluster/coordinator.js';
import { startGameNode } from '../server/cluster/game-node.js';
import { CLOSE } from '../server/net.js';
import { MATCHMAKING_VERSION, PROTOCOL_VERSION } from '../shared/constants.js';

const ORIGIN = 'https://two-ingress-process-fixture.invalid';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ingressModule = new URL('../server/cluster/ingress.js', import.meta.url).href;
// Test-only IPC bootstrap, not a new application endpoint or production launcher.
// No keys/config files are read: ingress needs routes, not the node signing key.
const CHILD_SOURCE = `
import { startIngress } from ${JSON.stringify(ingressModule)};
let runtime, starting = false, stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await runtime?.close(); process.exit(0); }
  catch { process.exit(1); }
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('disconnect', stop);
process.on('message', async message => {
  if (starting || stopping || message?.op !== 'start') return;
  starting = true;
  try {
    runtime = await startIngress({ ...message.options, host: '127.0.0.1', port: 0 });
    if (stopping) { await runtime.close(); return; }
    process.send({ event: 'ready', url: runtime.url });
  } catch { process.send({ event: 'failed' }, () => process.exit(1)); }
});
`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= end) throw new Error(`two-ingress fixture deadline: ${label}`);
    await pause(5);
  }
}
// Whitespace, a JSON escape and a non-canonical numeric literal prove that encoded
// game frames are forwarded byte-for-byte, not parsed/stringified by the ingress.
const fieldRaw = fieldId => `{"t":"m.field", "fieldId":${JSON.stringify(fieldId)}, "fixture":"two-process", "escaped":"\\u0061", "number":1.2300, "padding":"${'encoded-field '.repeat(250)}" }`;

async function fixture(t) {
  const entries = [], clients = [], matches = [], controlTypes = [], admissionTickets = [];
  let game, coordinator;
  t.after(async () => {
    for (const client of clients) client.socket.terminate();
    await Promise.all(entries.map(async entry => {
      if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGTERM');
      const force = setTimeout(() => entry.child.kill('SIGKILL'), 3000);
      try { await entry.exited; } finally { clearTimeout(force); }
    }));
    await coordinator?.close();
    await game?.close();
  });
  class FixtureMatch {
    constructor(opts) { this.opts = opts; this.disconnects = []; this.reconnects = []; this.disposed = false; matches.push(this); }
    start() {
      this.opts.broadcast({ t: 'm.public', phase: 'INFO_CHECK', fixture: 'two-process', marker: this.opts.roomCode });
      for (const seat of this.opts.seats) if (!seat.isBot) this.opts.send(seat.playerId, { t: 'm.private', playerId: seat.playerId });
    }
    onReconnect(id) {
      this.reconnects.push(id);
      this.opts.send(id, { t: 'm.public', fixture: 'two-process', resync: true });
      this.opts.send(id, { t: 'm.private', playerId: id });
    }
    onDisconnect(id) { this.disconnects.push(id); }
    addSpectator(id) {
      this.opts.send(id, { t: 'm.public', fixture: 'two-process', observing: true });
      // Deliberate private-frame attempt: the REAL GameHost must reject it.
      this.opts.send(id, { t: 'm.private', fixture: 'must-not-reach-observer', playerId: id });
    }
    removeSpectator() {}
    handle(id, message) {
      if (message.t === 'g.watch') this.opts.sendEncoded(id, 'm.field', fieldRaw(message.fieldId));
      return { ok: true };
    }
    dispose() { this.disposed = true; }
  }
  const key = randomBytes(32); // Fresh local test key, never loaded from deployment.
  game = await startGameNode({ nodeId: 'two-ingress-game', generation: 'two-ingress-generation',
    build: 'two-ingress-fixture', key, streamMarkers: true, MatchClass: FixtureMatch,
    getLoadState: () => 'busy', shutdownMs: 100 });
  const nodes = [{ nodeId: 'two-ingress-game', url: game.url, key }];
  coordinator = await startCoordinator({ nodes, build: 'two-ingress-fixture', host: '127.0.0.1', port: 0,
    quiet: true, heartbeatMs: 500 });
  const onMessage = coordinator.lobby.onMessage;
  coordinator.lobby.onMessage = function (session, message) {
    controlTypes.push(message.t);
    return onMessage.call(this, session, message);
  };
  const sendControl = coordinator.platform.sendControl;
  coordinator.platform.sendControl = function (id, message) {
    if (message.t === 'cluster.prepare') admissionTickets.push(message.ticket);
    return sendControl.call(this, id, message);
  };
  for (let i = 0; i < 2; i++) {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', CHILD_SOURCE], {
      cwd: ROOT, env: { TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const entry = { child, url: null, stdout: '', stderr: '' };
    entries.push(entry); // Own it before awaiting startup, including failure paths.
    child.stdout.on('data', bytes => { entry.stdout += bytes.toString(); });
    child.stderr.on('data', bytes => { entry.stderr += bytes.toString(); });
    child.on('error', () => {});
    // 'close' also fires on spawn failure and follows stdout/stderr draining.
    entry.exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(() => reject(new Error('ingress child startup deadline'))), 8000);
      const finish = fn => { clearTimeout(timer); child.off('message', onReady); child.off('error', onError); child.off('exit', onExit); fn(); };
      const onReady = message => {
        if (message?.event === 'ready') { entry.url = message.url; finish(resolve); }
        else if (message?.event === 'failed') finish(() => reject(new Error('ingress child startup failed')));
      };
      const onError = () => finish(() => reject(new Error('ingress child spawn failed')));
      const onExit = () => finish(() => reject(new Error('ingress child exited before ready')));
      child.on('message', onReady); child.once('error', onError); child.once('exit', onExit);
      child.send({ op: 'start', options: { coordinatorUrl: coordinator.url,
        nodes: nodes.map(({ nodeId, url }) => ({ nodeId, url })), origins: [ORIGIN],
        wsCompression: 'on', shutdownMs: 100, replacementGraceMs: 500 } });
    });
  }
  assert.notEqual(entries[0].child.pid, entries[1].child.pid);
  assert.ok(entries.every(entry => entry.child.pid !== process.pid));
  assert.notEqual(entries[0].url, entries[1].url);

  const join = async (name, index = 0, token) => {
    const socket = new WebSocket(entries[index].url.replace(/^http/, 'ws') + '/ws', { origin: ORIGIN, handshakeTimeout: 5000 });
    const frames = [], raws = [], pending = new Map(); let rid = 0;
    const connection = { socket, frames, raws, index };
    clients.push(connection);
    socket.on('error', () => {});
    socket.on('message', bytes => {
      const raw = bytes.toString(), message = JSON.parse(raw); raws.push(raw); frames.push(message);
      const request = pending.get(message.rid);
      if (!request) return;
      pending.delete(message.rid); clearTimeout(request.timer);
      if (message.t === 'error') request.reject(Object.assign(new Error(message.code), { code: message.code }));
      else request.resolve(message);
    });
    connection.closed = new Promise(resolve => socket.once('close', (code, reason) => {
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('two-ingress client closed')); }
      pending.clear(); resolve({ code, reason: reason.toString() });
    }));
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ t: 'hello', name, token, version: PROTOCOL_VERSION, matchmakingVersion: MATCHMAKING_VERSION }));
    await until(() => frames.some(frame => frame.t === 'welcome' || frame.t === 'error'), 'hello response');
    const welcome = frames.find(frame => frame.t === 'welcome' || frame.t === 'error');
    assert.equal(welcome.t, 'welcome', `fixture hello rejected: ${welcome.code ?? 'none'}`);
    connection.playerId = welcome.playerId; connection.token = welcome.token; connection.welcome = welcome;
    connection.request = (type, fields = {}) => new Promise((resolve, reject) => {
      const id = ++rid, timer = setTimeout(() => { pending.delete(id); reject(new Error('two-ingress request deadline')); }, 7000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ t: type, ...fields, rid: id }));
    });
    return connection;
  };
  const match = async () => {
    const players = [];
    for (let i = 0; i < 4; i++) players.push(await join(`TwinPlayer${i}`, i % 2));
    for (const player of players) await player.request('queue.join', { difficulty: 'NORMAL' });
    await until(() => players.every(player => player.frames.some(frame => frame.t === 'queue.state' && frame.state === 'offered')), 'shared offer');
    const offers = players.map(player => player.frames.filter(frame => frame.t === 'queue.state' && frame.state === 'offered').at(-1));
    assert.equal(new Set(offers.map(offer => offer.offerId)).size, 1, 'both processes share one coordinator offer/pool');
    for (let i = 0; i < players.length; i++) await players[i].request('queue.accept', {
      offerId: offers[i].offerId, ticketId: offers[i].ticketId, revivalVote: false,
    });
    await until(() => players.every(player => player.frames.some(frame => frame.t === 'queue.state' && frame.state === 'matched')), 'matched');
    const roomFrame = players[0].frames.filter(frame => frame.t === 'room.state' && frame.inMatch).at(-1);
    const owner = coordinator.platform.directory.byRoom(roomFrame.code);
    await coordinator.platform.contexts.get(owner.assignmentId).publication;
    const room = coordinator.lobby.getRoom(roomFrame.code), context = game.gameHost.contexts.get(owner.assignmentId);
    assert.equal(matches.length, 1);
    return { players, owner, room, context, fixtureMatch: context.match };
  };
  const watch = async (player, fieldId) => {
    const offset = player.raws.length;
    assert.equal((await player.request('g.watch', { fieldId })).t, 'ok');
    await until(() => player.raws.slice(offset).includes(fieldRaw(fieldId)), 'unchanged encoded field');
  };
  const assertNoRoutingLeak = connections => {
    const forbidden = new Set(['ticket', 'assignmentId', 'nodeId', 'actorGeneration', 'generation', 'ingressId', 'keyFile', 'coordinatorUrl']);
    const inspect = value => {
      if (!value || typeof value !== 'object') return;
      for (const [name, child] of Object.entries(value)) { assert.equal(forbidden.has(name), false, `private routing key ${name}`); inspect(child); }
    };
    for (const connection of connections) {
      for (const frame of connection.frames) {
        assert.equal(frame.t.startsWith('cluster.'), false); inspect(frame);
        if (frame.t !== 'welcome') assert.equal(Object.hasOwn(frame, 'token'), false);
      }
      for (const raw of connection.raws) {
        for (const ticket of admissionTickets) assert.equal(raw.includes(ticket), false, 'node admission ticket is private');
        for (const other of connections) if (other.playerId !== connection.playerId) {
          assert.equal(raw.includes(other.token), false, 'another session reconnect token is private');
        }
      }
    }
  };
  return { entries, clients, game, coordinator, matches, controlTypes, join, match, watch, assertNoRoutingLeak };
}

function upgradeStatus(url, origin = ORIGIN, path = '/ws') {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url.replace(/^http/, 'ws') + path, { ...(origin ? { origin } : {}), handshakeTimeout: 2000 });
    socket.on('error', () => {});
    socket.once('unexpected-response', (request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode); });
    socket.once('open', () => { socket.close(); resolve(101); });
    socket.once('error', error => reject(error));
  });
}

test('two independent ingress processes keep the native HTTP404/OriginWS health and private routing contract', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  for (const entry of f.entries) {
    for (const path of ['/', '/healthz', '/_cluster/rpc']) {
      const response = await fetch(entry.url + path);
      assert.equal(response.status, 404); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(await response.text(), '');
    }
    assert.equal(await upgradeStatus(entry.url), 101);
    assert.equal(await upgradeStatus(entry.url, 'https://foreign-fixture.invalid'), 403);
    assert.equal(await upgradeStatus(entry.url, null), 403);
    assert.equal(await upgradeStatus(entry.url, ORIGIN, '/ws?ticket=not-an-admission'), 404);
  }
  const player = await f.join('WireFence');
  await assert.rejects(player.request('cluster.prepare', { nodeId: 'two-ingress-game', ticket: 'fixture-invalid' }), error => error.code === 'BAD_MSG');
  assert.equal(f.controlTypes.includes('cluster.prepare'), false, 'browser routing commands never reach coordinator');
  assert.equal(f.game.gameHost.stats().matches, 0);
  f.assertNoRoutingLeak([player]);
});

test('one actual global pool matches clients from both ingress processes; private tickets stay internal and raw game frames bypass control', { timeout: 20000 }, async t => {
  const f = await fixture(t), group = await f.match();
  assert.equal(f.coordinator.lobby.stats().online, 4); assert.equal(f.coordinator.lobby.stats().matches, 1);
  assert.equal(f.game.gameHost.stats().matches, 1); assert.equal(group.owner.nodeId, 'two-ingress-game');
  for (const player of group.players) {
    assert.equal(f.coordinator.platform.directory.bySession(player.playerId).assignmentId, group.owner.assignmentId);
    assert.match(player.socket.extensions, /permessage-deflate/);
    const roomAt = player.frames.findIndex(frame => frame.t === 'room.state' && frame.inMatch);
    const privateAt = player.frames.findIndex(frame => frame.t === 'm.private');
    const matchedAt = player.frames.findIndex(frame => frame.t === 'queue.state' && frame.state === 'matched');
    assert.ok(roomAt >= 0 && roomAt < privateAt && privateAt < matchedAt);
  }
  await f.watch(group.players[0], group.players[1].playerId);
  await f.watch(group.players[1], group.players[0].playerId);
  assert.equal(f.controlTypes.includes('g.watch'), false);
  assert.equal((await group.players[1].request('ping', { c: Date.now() })).loadState, 'busy', 'bound ping uses game, not coordinator');
  for (const socket of f.game.wss.clients) assert.equal(socket.extensions, '', 'private game stream never negotiates compression');
  for (const connection of f.coordinator.network.conns.values()) assert.equal(connection.ws.extensions, '', 'private control stream never negotiates compression');
  f.assertNoRoutingLeak(group.players);
});

test('live cross-ingress resume preserves identity/assignment/actor; delayed real old close callbacks cannot detach its replacement', { timeout: 20000 }, async t => {
  const f = await fixture(t), group = await f.match(), old = group.players[0];
  const session = f.coordinator.registry.byId(old.playerId), oldControl = session.ws;
  const oldConnection = f.coordinator.network.conns.get(oldControl);
  const oldBinding = group.context.members.get(old.playerId).binding;
  const delayedControl = [], delayedGame = [];
  const onClose = f.coordinator.network.onClose, unbind = f.game.gameHost._unbind;
  // Test-only callback scheduling fault. Both transports still really close; only
  // their original cleanup callbacks are held until the NEW transport is bound.
  f.coordinator.network.onClose = function (connection) {
    if (connection === oldConnection) { delayedControl.push(connection); return; }
    return onClose.call(this, connection);
  };
  f.game.gameHost._unbind = function (context, id, binding) {
    if (binding === oldBinding) { delayedGame.push([context, id, binding]); return false; }
    return unbind.call(this, context, id, binding);
  };
  t.after(() => {
    f.coordinator.network.onClose = onClose; f.game.gameHost._unbind = unbind;
    for (const connection of delayedControl.splice(0)) onClose.call(f.coordinator.network, connection);
    for (const args of delayedGame.splice(0)) unbind.call(f.game.gameHost, ...args);
  });
  const resumed = await f.join('TwinPlayer0', 1, old.token);
  await until(() => resumed.frames.some(frame => frame.t === 'm.public' && frame.resync), 'player rebind');
  assert.equal((await old.closed).code, CLOSE.REPLACED);
  await until(() => delayedControl.length > 0 && delayedGame.length > 0, 'old cleanup callbacks actually reached');
  const currentControl = session.ws, currentBinding = group.context.members.get(old.playerId).binding;
  assert.notStrictEqual(currentControl, oldControl); assert.notStrictEqual(currentBinding, oldBinding);
  f.coordinator.network.onClose = onClose; f.game.gameHost._unbind = unbind;
  for (const connection of delayedControl.splice(0)) onClose.call(f.coordinator.network, connection);
  for (const args of delayedGame.splice(0)) assert.equal(unbind.call(f.game.gameHost, ...args), false, 'stale node cleanup is fenced');
  assert.strictEqual(session.ws, currentControl); assert.equal(session.connected, true);
  assert.strictEqual(group.context.members.get(old.playerId).binding, currentBinding);
  assert.equal(group.fixtureMatch.disconnects.includes(old.playerId), false, 'replacement never causes disconnected-player autoplay');
  assert.equal(resumed.welcome.resumed, true); assert.equal(resumed.playerId, old.playerId); assert.equal(resumed.token, old.token);
  assert.strictEqual(f.coordinator.lobby.getRoom(group.room.code), group.room);
  assert.strictEqual(f.game.gameHost.contexts.get(group.owner.assignmentId), group.context);
  assert.strictEqual(group.context.match, group.fixtureMatch); assert.equal(group.fixtureMatch.disposed, false);
  assert.deepEqual(f.coordinator.platform.directory.bySession(old.playerId), group.owner);
  await f.watch(resumed, group.players[1].playerId);
  f.assertNoRoutingLeak([...group.players, resumed]);
});

test('spectator resumes across independent ingress processes with the same owner and zero private frames, including deliberate private sends', { timeout: 20000 }, async t => {
  const f = await fixture(t), group = await f.match(), observer = await f.join('TwinObserver', 0);
  await observer.request('room.spectate', { code: group.room.code });
  await until(() => observer.frames.some(frame => frame.t === 'm.public' && frame.observing), 'observer bound');
  await f.watch(observer, group.players[0].playerId);
  const resumed = await f.join('TwinObserver', 1, observer.token);
  await until(() => resumed.frames.some(frame => frame.t === 'm.public' && frame.observing), 'observer rebind');
  assert.equal((await observer.closed).code, CLOSE.REPLACED);
  assert.equal(resumed.playerId, observer.playerId); assert.equal(resumed.token, observer.token); assert.equal(resumed.welcome.resumed, true);
  assert.deepEqual(f.coordinator.platform.directory.bySession(resumed.playerId), { ...group.owner, spectatorIds: [observer.playerId] });
  assert.equal(f.game.gameHost.member(group.owner.assignmentId, resumed.playerId).role, 'spectator');
  assert.equal(f.game.gameHost.stats().matches, 1);
  await f.watch(resumed, group.players[1].playerId);
  assert.equal(observer.frames.some(frame => frame.t === 'm.private'), false);
  assert.equal(resumed.frames.some(frame => frame.t === 'm.private'), false);
  f.assertNoRoutingLeak([...group.players, observer, resumed]);
});

for (const signal of ['SIGTERM', 'SIGKILL']) {
  test(`${signal} of one ingress process does not terminate the other ingress, surviving clients or match owner; lost clients resume there`, { timeout: 20000 }, async t => {
    const f = await fixture(t), group = await f.match(), failed = f.entries[0], survivor = f.entries[1];
    const observer = await f.join('SurviveObs', 1);
    await observer.request('room.spectate', { code: group.room.code });
    await until(() => observer.frames.some(frame => frame.t === 'm.public' && frame.observing), 'surviving observer bound');
    const expectedOwner = { ...group.owner, spectatorIds: [observer.playerId] };
    const survivorPid = survivor.child.pid;
    assert.equal(failed.child.kill(signal), true);
    const exited = await failed.exited;
    assert.deepEqual(exited, signal === 'SIGTERM' ? { code: 0, signal: null } : { code: null, signal: 'SIGKILL' });
    for (const player of group.players.filter(player => player.index === 0)) await player.closed;
    await until(() => group.players.filter(player => player.index === 0).every(player =>
      !f.coordinator.registry.byId(player.playerId).connected && !f.game.gameHost.member(group.owner.assignmentId, player.playerId).connected), 'failed-ingress disconnect observed');
    assert.equal(survivor.child.exitCode, null); assert.equal(survivor.child.signalCode, null); assert.equal(survivor.child.pid, survivorPid);
    assert.strictEqual(f.coordinator.lobby.getRoom(group.room.code), group.room);
    assert.strictEqual(f.game.gameHost.contexts.get(group.owner.assignmentId), group.context);
    assert.strictEqual(group.context.match, group.fixtureMatch); assert.equal(group.fixtureMatch.disposed, false);
    assert.equal(f.game.gameHost.get(group.owner.assignmentId).state, 'committed');
    for (const player of [...group.players.filter(player => player.index === 1), observer]) {
      assert.equal(player.socket.readyState, WebSocket.OPEN);
      assert.equal(f.game.gameHost.member(group.owner.assignmentId, player.playerId).connected, true);
      await f.watch(player, group.players[1].playerId);
      assert.equal((await player.request('ping', { c: Date.now() })).loadState, 'busy');
      assert.deepEqual(f.coordinator.platform.directory.bySession(player.playerId), expectedOwner);
    }
    const lost = group.players[0], resumed = await f.join('TwinPlayer0', 1, lost.token);
    await until(() => resumed.frames.some(frame => frame.t === 'm.public' && frame.resync), 'failed-entry player recovery');
    assert.equal(resumed.playerId, lost.playerId); assert.equal(resumed.token, lost.token); assert.equal(resumed.welcome.resumed, true);
    assert.deepEqual(f.coordinator.platform.directory.bySession(resumed.playerId), expectedOwner);
    assert.equal(f.coordinator.lobby.stats().matches, 1); assert.equal(f.game.gameHost.stats().matches, 1);
    await f.watch(resumed, group.players[1].playerId);
    assert.equal(observer.frames.some(frame => frame.t === 'm.private'), false);
    assert.ok(f.clients.every(client => client.frames.every(frame => frame.t !== 'm.result' && frame.t !== 'room.closed')), 'ingress loss cannot manufacture match termination');
    f.assertNoRoutingLeak([...group.players, observer, resumed]);
    assert.equal(failed.stdout, ''); assert.equal(failed.stderr, '');
  });
}
