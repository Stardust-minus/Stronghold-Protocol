import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startGameNode } from '../server/cluster/game-node.js';
import { createRpcAuthenticator, createRpcClient } from '../server/cluster/rpc.js';
import { createTicketAuthority } from '../server/cluster/tickets.js';
import { Match } from '../server/match/Match.js';
import { ERR, PHASE } from '../shared/constants.js';

const KEY = Buffer.alloc(32, 0x44); // Synthetic fixture key, never an external credential.
const NODE = 'game-a', BUILD = 'test-build';
const seat = (seat, playerId, extra = {}) => ({ seat, playerId, name: playerId, isBot: false, connected: true, ...extra });
const spec = extra => ({ assignmentId: 'allocation-a', roomCode: 'ABCD', build: BUILD, protocol: 1, seed: 7, matchNo: 1,
  mode: 'coop', difficulty: 'NORMAL', modeId: 'mode_multi_normal', seats: [seat(0, 'p1'), seat(2, 'p2')],
  spectators: ['s1'], revivalEnabled: true, snapshotHz: 10, ...extra });
const code = expected => error => error?.code === expected;
const turn = () => new Promise(resolve => setImmediate(resolve));

async function connect(url, options = {}) {
  const { path = '/_cluster/game', ...socketOptions } = options;
  const ws = new WebSocket(url.replace(/^http/, 'ws') + path, { perMessageDeflate: true, ...socketOptions });
  const log = [], inbox = [], waiters = [];
  const closed = new Promise(resolve => ws.once('close', (code, reason) => {
    resolve({ code, reason: reason.toString() });
    for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(new Error('socket closed')); }
  }));
  ws.on('message', raw => {
    const entry = { raw: raw.toString(), message: JSON.parse(raw.toString()) };
    log.push(entry.message);
    const index = waiters.findIndex(w => w.predicate(entry.message));
    if (index >= 0) { const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(entry); }
    else inbox.push(entry);
  });
  ws.on('error', () => {});
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const take = (predicate, timeout = 1500) => {
    const index = inbox.findIndex(entry => predicate(entry.message));
    if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(new Error('frame timeout')); }, timeout);
      waiters.push(waiter);
    });
  };
  return { ws, log, closed, take, send: message => ws.send(JSON.stringify(message)),
    wait: (type, predicate = () => true) => take(message => message.t === type && predicate(message)).then(entry => entry.message) };
}

async function fixture(t, options = {}) {
  let clock = 100_000;
  const matches = [], logs = [];
  class FakeMatch {
    constructor(opts) { this.opts = opts; this.starts = 0; this.disposes = 0; this.calls = []; matches.push(this); }
    start() {
      this.starts++;
      this.opts.broadcast({ t: 'm.public', phase: PHASE.INFO_CHECK, room: this.opts.roomCode });
      for (const s of this.opts.seats) if (!s.isBot) this.opts.send(s.playerId, { t: 'm.private', playerId: s.playerId, funds: 4 });
      options.start?.(this);
    }
    handle(playerId, message) {
      this.calls.push(['handle', playerId, message]);
      if (message.t === 'g.watch') {
        const wire = JSON.stringify({ t: 'm.field', fieldId: message.fieldId, kind: 'normal', prep: true, units: [{ uid: 1 }] });
        this.lastWire = wire;
        this.opts.sendEncoded(playerId, 'm.field', wire);
      }
      return options.handle?.(this, playerId, message) ?? { ok: true };
    }
    onReconnect(playerId) {
      this.calls.push(['onReconnect', playerId]);
      this.opts.send(playerId, { t: 'm.public', resync: true });
      this.opts.send(playerId, { t: 'm.private', playerId, funds: 4 });
      this.opts.sendEncoded(playerId, 'b.ev', '{"t":"b.ev","marker":"reconnect","data":[]}');
    }
    onDisconnect(playerId) { this.calls.push(['onDisconnect', playerId]); }
    onLeave(playerId) { this.calls.push(['onLeave', playerId]); }
    setLoadout(playerId, loadout) { this.calls.push(['setLoadout', playerId, loadout]); return { ok: true }; }
    addSpectator(playerId) {
      this.calls.push(['addSpectator', playerId]);
      this.opts.send(playerId, { t: 'm.public', spectatorResync: true });
      this.opts.send(playerId, { t: 'm.private', funds: 'must not escape' });
    }
    removeSpectator(playerId) { this.calls.push(['removeSpectator', playerId]); }
    dispose() { this.disposes++; }
  }
  const now = () => clock;
  const node = await startGameNode({ nodeId: NODE, generation: 'node-generation-1', build: BUILD, key: KEY, now,
    MatchClass: options.MatchClass ?? FakeMatch, log: { info() {}, warn() {}, debug() {}, error: (...a) => logs.push(a) },
    shutdownMs: 50, ...options });
  const authority = createRpcAuthenticator({ key: KEY, scope: NODE, now });
  const rpc = createRpcClient({ url: node.url, authority });
  const tickets = createTicketAuthority({ key: KEY, now, ttlMs: options.ticketTtlMs ?? 30_000 });
  const clients = [];
  t.after(async () => { rpc.close(); for (const client of clients) client.ws.terminate(); await node.close(); });
  const claims = (sessionId, extra = {}) => ({ sessionId, roomCode: 'ABCD', assignmentId: 'allocation-a', nodeId: NODE,
    role: sessionId.startsWith('s') ? 'spectator' : 'player', build: BUILD, protocol: 1, ...extra });
  const socket = async opts => { const client = await connect(node.url, opts); clients.push(client); return client; };
  const bind = async (sessionId, extra = {}, socketOptions) => {
    const client = await socket(socketOptions);
    client.send({ t: 'cluster.bind', assignmentId: 'allocation-a', sessionId, ticket: tickets.issue(claims(sessionId)), ...extra });
    await client.wait('cluster.bound'); return client;
  };
  const start = async extra => {
    await rpc.call('prepare', spec(extra));
    const p1 = await bind('p1'), p2 = await bind('p2'), s1 = await bind('s1');
    await rpc.call('commit', { assignmentId: 'allocation-a' });
    await p1.wait('m.private'); await p2.wait('m.private'); await s1.wait('m.public');
    return { p1, p2, s1 };
  };
  const serverSocket = client => [...node.wss.clients].find(ws => ws._socket?.remotePort === client.ws._socket?.localPort);
  return { node, rpc, authority, tickets, matches, logs, now, claims, socket, bind, start, serverSocket,
    advance: ms => { clock += ms; } };
}

// Real loopback HTTP/WS; no pool creation, external service or production traffic.
test('guarded setup reroll RPC and direct human votes mutate one real actor, never spectator or stale epochs', async t => {
  const real = [];
  class RealMatch extends Match { constructor(opts) { super({ ...opts, now: f.now }); real.push(this); } }
  const data = { chess: { chess_fixture: { chessId: 'chess_fixture', visible: true, tier: 1, bonds: [] } } };
  const f = await fixture(t, { MatchClass: RealMatch, data, streamMarkers: true });
  const { p1, p2, s1 } = await f.start(), actor = f.node.gameHost.get('allocation-a');
  const member = { assignmentId: actor.assignmentId, sessionId: 'p1', nodeGeneration: 'node-generation-1', actorGeneration: actor.generation };
  for (const change of [{ nodeGeneration: 'old-node' }, { actorGeneration: actor.generation + 1 },
    { nodeGeneration: undefined }, { setupRevision: -1 }, { setupRevision: '0' }]) {
    await assert.rejects(f.rpc.call('requestSetupReroll', { ...member, setupRevision: 0, ...change }),
      error => ['STALE_ASSIGNMENT', 'BAD_REQUEST'].includes(error.code));
  }
  assert.deepEqual(await f.rpc.call('requestSetupReroll', { ...member, sessionId: 's1', setupRevision: 0 }), { error: ERR.SPECTATOR });
  assert.equal(real[0].setupVote, null);
  assert.deepEqual(await f.rpc.call('requestSetupReroll', { ...member, setupRevision: 0 }), { ok: true });
  const vote = (await p1.wait('m.public', m => m.rerollVote)).rerollVote.id;
  s1.send({ t: 'g.rerollVote', voteId: vote, agree: true, rid: 91 });
  assert.equal((await s1.wait('error', m => m.rid === 91)).code, ERR.SPECTATOR);
  p1.send({ t: 'room.rerollSetup', setupRevision: 0, rid: 92 });
  assert.equal((await p1.wait('error', m => m.rid === 92)).code, ERR.BAD_MSG);
  assert.equal((await f.rpc.call('cancelSetupReroll', { ...member, voteId: vote + 1 })).error, ERR.BAD_TARGET);
  assert.deepEqual(await f.rpc.call('cancelSetupReroll', { ...member, voteId: vote }), { ok: true });
  assert.equal(real[0].setupRevision, 0); assert.equal(real[0].setupVote, null);
  f.advance(300);
  assert.deepEqual(await f.rpc.call('requestSetupReroll', { ...member, setupRevision: 0 }), { ok: true });
  const nextVote = real[0].setupVote.id;
  p2.send({ t: 'g.rerollVote', voteId: nextVote, agree: true, rid: 93 });
  await p2.wait('ok', m => m.rid === 93);
  await p1.wait('m.public', m => m.setupRevision === 1);
  assert.equal(real[0].setupRevision, 1);
  p2.send({ t: 'g.infoReady', setupRevision: 0, rid: 94 });
  assert.equal((await p2.wait('error', m => m.rid === 94)).code, ERR.BAD_TARGET);
  f.advance(300);
  assert.deepEqual(await f.rpc.call('requestSetupReroll', { ...member, setupRevision: 1 }), { ok: true });
  p2.ws.terminate(); await p2.closed;
  await p1.wait('m.public', m => m.setupRevision === 1 && m.rerollVote === null && m.players.some(p => p.playerId === 'p2' && !p.connected));
  assert.equal(real[0].setupVote, null, 'actual game-channel disconnect cancels consent');
  assert.equal((await f.rpc.call('requestSetupReroll', { ...member, setupRevision: 1 })).error, ERR.NOT_READY);
  assert.equal(s1.log.some(m => m.t === 'm.private' || m.t === 'm.unitStats'), false);
  assert.equal(real.length, 1);
});

test('setup reroll RPC requires both epochs even on a legacy stream without cluster markers', async t => {
  const f = await fixture(t); await f.start();
  const request = { assignmentId: 'allocation-a', sessionId: 'p1', setupRevision: 0 };
  await assert.rejects(f.rpc.call('requestSetupReroll', request), code('BAD_REQUEST'));
  const actor = f.node.gameHost.get('allocation-a');
  assert.deepEqual(await f.rpc.call('requestSetupReroll', { ...request, nodeGeneration: 'node-generation-1', actorGeneration: actor.generation }),
    { error: ERR.WRONG_PHASE }, 'a legacy actor missing reroll support does not acknowledge success');
  await assert.rejects(f.rpc.call('cancelSetupReroll', { assignmentId: 'allocation-a', sessionId: 'p1', voteId: 1 }), code('BAD_REQUEST'));
});

test('active game pongs retain safe cached load details and diagnostic failures cannot break heartbeat', async t => {
  const f = await fixture(t, { getLoadState: () => 'busy', getLoadDetails: () => ({ windowMs: 10000, ageMs: 1,
    cpuPercent: 123, rssMiB: 200, heapMiB: 30, eluPercent: 80, p95Ms: 22, p99Ms: 30,
    pid: 'fixture-only', hostname: 'fixture-only' }) });
  const { p1 } = await f.start();
  p1.send({ t: 'ping', c: 1, rid: 101 });
  const pong = await p1.wait('pong');
  assert.equal(pong.loadState, 'busy');
  assert.equal(pong.loadDetails.cpuPercent, 123);
  assert.equal(Object.hasOwn(pong.loadDetails, 'pid'), false);
  assert.equal(Object.hasOwn(pong.loadDetails, 'hostname'), false);
  const bad = await fixture(t, { getLoadState: () => { throw new Error('fixture-only'); }, getLoadDetails: () => { throw new Error('fixture-only'); } });
  const client = (await bad.start()).p1;
  client.send({ t: 'ping', c: 2, rid: 102 });
  const fallback = await client.wait('pong');
  assert.equal(fallback.loadState, 'unknown');
  assert.equal(Object.hasOwn(fallback, 'loadDetails'), false);
});

test('unready borrowed combat pool blocks new preparation and commit but is never started or closed here', async t => {
  let ready = 0;
  const pool = { stats: () => ({ status: 'ready', ready }) };
  const f = await fixture(t, { combatPool: pool });
  assert.equal((await f.rpc.call('status')).ready, false);
  await assert.rejects(f.rpc.call('prepare', spec()), code('NOT_READY'));
  ready = 2;
  await f.rpc.call('prepare', spec());
  await f.bind('p1'); await f.bind('p2');
  ready = 0;
  await assert.rejects(f.rpc.call('commit', { assignmentId: 'allocation-a' }), code('NOT_READY'));
  assert.equal(f.node.gameHost.stats().matches, 0);
  ready = 2;
  await f.rpc.call('commit', { assignmentId: 'allocation-a' });
  assert.equal(f.node.gameHost.stats().matches, 1);
});

test('malformed type is a protocol error; late rid-less battle progress stays silent', async t => {
  const f = await fixture(t, { handle: () => ({ error: ERR.WRONG_PHASE }) });
  const { p1 } = await f.start();
  p1.send({ t: { toString: 'fixture-only' }, rid: 10 });
  assert.equal((await p1.wait('error')).code, ERR.BAD_MSG);
  const before = p1.log.filter(message => message.t === 'error').length;
  p1.send({ t: 'b.progress', battleId: 'test-battle', gt: 0, killed: 0, total: 1 });
  p1.send({ t: 'ping', c: 1, rid: 11 });
  await p1.wait('pong');
  assert.equal(p1.log.filter(message => message.t === 'error').length, before);
  p1.send({ t: 'b.progress', battleId: 'test-battle', gt: 0, killed: 0, total: 1, rid: 12 });
  assert.equal((await p1.wait('error')).code, ERR.WRONG_PHASE);
});

test('private RPC authenticates fixed node scope and exposes only the selected control operations', async t => {
  const { node, rpc, authority, matches, now, logs } = await fixture(t);
  const body = Buffer.from(JSON.stringify({ id: 'request-1', op: 'status', payload: {} }));
  let response = await fetch(node.url + '/_cluster/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, code: 'UNAUTHORIZED' });
  const wrong = createRpcAuthenticator({ key: KEY, scope: 'other-node', now });
  response = await fetch(node.url + '/_cluster/rpc', { method: 'POST', headers: { ...wrong.sign(body), 'content-type': 'application/json' }, body });
  assert.equal(response.status, 401);
  const headers = authority.sign(body);
  response = await fetch(node.url + '/_cluster/rpc', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: body.toString().replace('status', 'member') });
  assert.equal(response.status, 401);
  const status = await rpc.call('status');
  assert.equal(status.nodeId, NODE); assert.equal(status.generation, 'node-generation-1');
  assert.equal(status.counts.matches, 0); assert.equal(status.ready, true);
  await assert.rejects(rpc.call('handle', {}), code('UNKNOWN_OPERATION'));
  await assert.rejects(rpc.call('close', {}), code('UNKNOWN_OPERATION'));
  await assert.rejects(rpc.call('prepare', spec({ build: 'other-build' })), code('CONTEXT'));
  await assert.rejects(rpc.call('prepare', spec({ protocol: 2 })), code('CONTEXT'));
  assert.equal(matches.length, 0);
  assert.equal((await fetch(node.url + '/')).status, 404, 'no public game/lobby routes');
  assert.equal(JSON.stringify(logs).includes('x-ark-cluster-signature'), false);
});

test('game upgrade rejects query parameters; first frame is exact and anonymous traffic cannot bind', async t => {
  const { node, socket, rpc } = await fixture(t);
  await assert.rejects(connect(node.url, { path: '/_cluster/game?ticket=never-in-url' }));
  await assert.rejects(connect(node.url, { path: '/ws' }));
  await rpc.call('prepare', spec());
  for (const message of [{ t: 'ping', c: 1 }, { t: 'hello', name: 'intruder' },
    { t: 'cluster.bind', assignmentId: 'allocation-a', sessionId: 'p1', ticket: 'bad', role: 'player' },
    { t: 'cluster.bind', assignmentId: 'allocation-a', sessionId: 'p1' }]) {
    const client = await socket(); client.send(message);
    assert.equal((await client.wait('error')).code, 'BAD_BIND');
    assert.equal((await client.closed).code, 1008);
  }
  const client = await socket(); client.ws.send(Buffer.from('{}'));
  assert.equal((await client.wait('error')).code, 'BAD_BIND');
  assert.equal((await client.closed).code, 1008);
});

test('tickets bind all seven expected fields to current membership, never self-reported roles', async t => {
  const { rpc, socket, tickets, claims, logs } = await fixture(t);
  await rpc.call('prepare', spec());
  const variations = [
    ['p1', { nodeId: 'other-node' }], ['p1', { roomCode: 'EFGH' }], ['p1', { assignmentId: 'other-allocation' }],
    ['p1', { build: 'other-build' }], ['p1', { protocol: 2 }], ['p1', { sessionId: 'p2' }],
    ['s1', { role: 'player' }], ['intruder', {}],
  ];
  for (const [sessionId, extra] of variations) {
    const client = await socket();
    client.send({ t: 'cluster.bind', assignmentId: 'allocation-a', sessionId, ticket: tickets.issue(claims(sessionId, extra)) });
    assert.equal((await client.wait('error')).code, 'UNAUTHORIZED');
    assert.equal((await client.closed).code, 1008);
  }
  const client = await socket();
  const ticket = tickets.issue(claims('p1'));
  const at = ticket.indexOf('.') + 1;
  const tampered = ticket.slice(0, at) + (ticket[at] === 'a' ? 'b' : 'a') + ticket.slice(at + 1);
  client.send({ t: 'cluster.bind', assignmentId: 'allocation-a', sessionId: 'p1', ticket: tampered });
  assert.equal((await client.wait('error')).code, 'UNAUTHORIZED');
  await client.closed;
  assert.equal(JSON.stringify(logs).includes(ticket), false);
});

test('expiry remains exclusive; optional future-clock tolerance does not change context or expiry', async t => {
  const { rpc, socket, claims, advance, now } = await fixture(t, { futureSkewMs: 1000, ticketTtlMs: 2000 });
  await rpc.call('prepare', spec());
  const future = createTicketAuthority({ key: KEY, now: () => now() + 1000, ttlMs: 2000 });
  const token = future.issue(claims('p1'));
  const accepted = await socket();
  accepted.send({ t: 'cluster.bind', assignmentId: 'allocation-a', sessionId: 'p1', ticket: token });
  await accepted.wait('cluster.bound');
  advance(3000);
  const expired = await socket();
  expired.send({ t: 'cluster.bind', assignmentId: 'allocation-a', sessionId: 'p1', ticket: token });
  assert.equal((await expired.wait('error')).code, 'UNAUTHORIZED');
  await expired.closed;
  const tooFuture = createTicketAuthority({ key: KEY, now: () => now() + 1001, ttlMs: 2000 });
  const refused = await socket();
  refused.send({ t: 'cluster.bind', assignmentId: 'allocation-a', sessionId: 'p2', ticket: tooFuture.issue(claims('p2')) });
  assert.equal((await refused.wait('error')).code, 'UNAUTHORIZED');
  await refused.closed;
});

test('prepare → all-human bind barrier → commit: bound precedes startup and intents stay blocked until commit', async t => {
  const { rpc, bind, matches } = await fixture(t);
  const prepared = await rpc.call('prepare', spec());
  assert.equal(prepared.state, 'prepared'); assert.equal(prepared.playersReady, false);
  assert.equal(Object.hasOwn(prepared, 'seats'), false);
  await assert.rejects(rpc.call('commit', { assignmentId: 'allocation-a' }), code('NOT_READY'));
  const p1 = await bind('p1');
  p1.send({ t: 'g.ready', ready: true, rid: 1 });
  assert.equal((await p1.wait('error', m => m.rid === 1)).code, ERR.WRONG_PHASE);
  assert.equal(matches[0].calls.length, 0); assert.equal(matches[0].starts, 0);
  await assert.rejects(rpc.call('commit', { assignmentId: 'allocation-a' }), code('NOT_READY'));
  const p2 = await bind('p2');
  const status = await rpc.call('status', { assignmentId: 'allocation-a' });
  assert.equal(status.playersReady, true, 'observer is not a commit barrier');
  const s1 = await bind('s1');
  for (const client of [p1, p2, s1]) assert.equal(client.log.some(m => m.t.startsWith('m.')), false);
  const committed = await rpc.call('commit', { assignmentId: 'allocation-a' });
  assert.equal(committed.state, 'committed'); assert.equal(matches[0].starts, 1);
  await p1.wait('m.private'); await p2.wait('m.private'); await s1.wait('m.public');
  for (const client of [p1, p2, s1]) assert.equal(client.log[0].t, 'cluster.bound');
  assert.equal(s1.log.some(m => m.t === 'm.private'), false);
  await rpc.call('commit', { assignmentId: 'allocation-a' });
  assert.equal(matches[0].starts, 1);
  assert.equal(matches[0].opts.clientCombat, false);
});

test('reconnect acknowledges bound before sync resync/encoded frames; old socket cannot disconnect or act through new socket', async t => {
  const { start, bind, matches, serverSocket } = await fixture(t);
  const { p1 } = await start();
  const oldServer = serverSocket(p1);
  const resumed = await bind('p1');
  await resumed.wait('m.private'); await resumed.wait('b.ev');
  assert.deepEqual(resumed.log.slice(0, 4).map(m => m.t), ['cluster.bound', 'm.public', 'm.private', 'b.ev']);
  assert.equal((await p1.closed).code, 1000);
  oldServer.emit('message', Buffer.from('{"t":"g.ready","ready":true,"rid":9}'), false);
  resumed.send({ t: 'g.ready', ready: true, rid: 10 });
  await resumed.wait('ok', m => m.rid === 10);
  const calls = matches[0].calls;
  assert.equal(calls.filter(c => c[0] === 'onDisconnect' && c[1] === 'p1').length, 0);
  assert.equal(calls.filter(c => c[0] === 'handle' && c[1] === 'p1').length, 1);
  assert.equal(calls.filter(c => c[0] === 'onReconnect' && c[1] === 'p1').length, 1);
});

test('g.watch streams a teammate field verbatim; spectators receive public battle frames but no private classes', async t => {
  const { start, matches } = await fixture(t);
  const { p1, s1 } = await start();
  for (const client of [p1, s1]) {
    client.send({ t: 'g.watch', fieldId: 'n:p2', rid: 1 });
    const entry = await client.take(m => m.t === 'm.field');
    assert.equal(entry.raw, matches[0].lastWire);
    assert.equal(entry.message.fieldId, 'n:p2');
    await client.wait('ok', m => m.rid === 1);
  }
  for (const type of ['m.private', 'm.toast', 'm.unitStats']) {
    matches[0].opts.broadcast({ t: type, private: 'not for observers' });
    assert.equal(matches[0].opts.send('s1', { t: type }), false);
    assert.equal(matches[0].opts.sendEncoded('s1', type, '{}'), false);
  }
  s1.send({ t: 'ping', c: 1, rid: 2 }); await s1.wait('pong', m => m.rid === 2);
  assert.equal(s1.log.some(m => ['m.private', 'm.toast', 'm.unitStats'].includes(m.t)), false);
  s1.send({ t: 'g.ready', ready: true, rid: 3 });
  assert.equal((await s1.wait('error', m => m.rid === 3)).code, ERR.SPECTATOR);
  assert.equal(matches[0].calls.some(c => c[0] === 'handle' && c[1] === 's1' && c[2].t === 'g.ready'), false);
});

test('only validated ping/game/combat reports pass WS; leave/loadout/session actions require RPC', async t => {
  const { start, matches, rpc } = await fixture(t);
  const { p1 } = await start();
  const refused = [{ t: 'g.ready', ready: 1 }, { t: 'g.leave' }, { t: 'room.loadout', entries: {} },
    { t: 'room.leave' }, { t: 'hello', name: 'evil' }, { t: 'constructor' }, { t: 'cluster.bind' }, { t: 'b.progress', battleId: 'x' }];
  for (let i = 0; i < refused.length; i++) {
    p1.send({ ...refused[i], rid: i + 1 });
    assert.equal((await p1.wait('error', m => m.rid === i + 1)).code, ERR.BAD_MSG);
  }
  p1.send({ t: 'ping', c: 2, rid: 9 });
  assert.equal((await p1.wait('pong', m => m.rid === 9)).c, 2);
  p1.send({ t: 'b.progress', battleId: 'battle-1', gt: 0, killed: 0, total: 1, rid: 10 });
  await p1.wait('ok', m => m.rid === 10);
  assert.equal(matches[0].calls.filter(c => c[0] === 'handle').length, 1);
  assert.deepEqual(await rpc.call('setLoadout', { assignmentId: 'allocation-a', sessionId: 'p1', loadout: {} }), { ok: true });
  assert.equal(matches[0].calls.some(c => c[0] === 'setLoadout'), true);
  assert.deepEqual(await rpc.call('leave', { assignmentId: 'allocation-a', sessionId: 'p1' }), { ok: true });
  await p1.closed;
  assert.equal(matches[0].calls.filter(c => c[0] === 'onLeave' && c[1] === 'p1').length, 1);
  assert.equal(matches[0].calls.filter(c => c[0] === 'onDisconnect' && c[1] === 'p1').length, 0);
});

test('RPC observer membership controls ticket role, removal, stale cleanup and re-admission', async t => {
  const { start, rpc, socket, claims, tickets, bind, matches } = await fixture(t);
  await start();
  assert.deepEqual(await rpc.call('addSpectator', { assignmentId: 'allocation-a', sessionId: 's2' }), { ok: true });
  const promoted = await socket();
  promoted.send({ t: 'cluster.bind', assignmentId: 'allocation-a', sessionId: 's2', ticket: tickets.issue(claims('s2', { role: 'player' })) });
  assert.equal((await promoted.wait('error')).code, 'UNAUTHORIZED'); await promoted.closed;
  const observer = await bind('s2');
  await observer.wait('m.public');
  assert.equal(observer.log[0].t, 'cluster.bound');
  assert.equal(observer.log.some(m => m.t === 'm.private'), false);
  assert.equal((await rpc.call('member', { assignmentId: 'allocation-a', sessionId: 's2' })).role, 'spectator');
  await rpc.call('removeSpectator', { assignmentId: 'allocation-a', sessionId: 's2' });
  await observer.closed;
  assert.equal(await rpc.call('member', { assignmentId: 'allocation-a', sessionId: 's2' }), null);
  const late = await socket();
  late.send({ t: 'cluster.bind', assignmentId: 'allocation-a', sessionId: 's2', ticket: tickets.issue(claims('s2')) });
  assert.equal((await late.wait('error')).code, 'UNAUTHORIZED'); await late.closed;
  assert.equal(matches[0].calls.some(c => c[0] === 'onDisconnect' && c[1] === 's2'), false);
});

test('guarded member/release RPC requires both fixed epochs and cannot touch a replacement actor', async t => {
  const f = await fixture(t, { streamMarkers: true });
  await f.start();
  const current = f.node.gameHost.get('allocation-a');
  const member = { assignmentId: 'allocation-a', sessionId: 's1', nodeGeneration: 'node-generation-1', actorGeneration: current.generation };
  for (const changed of [{ nodeGeneration: 'old-node-generation' }, { actorGeneration: current.generation + 1 }, { actorGeneration: undefined }]) {
    await assert.rejects(f.rpc.call('removeSpectator', { ...member, ...changed }), error => ['STALE_ASSIGNMENT', 'BAD_REQUEST'].includes(error.code));
    assert.equal(f.node.gameHost.member('allocation-a', 's1').role, 'spectator');
  }
  await assert.rejects(f.rpc.call('release', { assignmentId: 'allocation-a', nodeGeneration: 'old-node-generation', actorGeneration: current.generation }), code('STALE_ASSIGNMENT'));
  await assert.rejects(f.rpc.call('release', { assignmentId: 'allocation-a', nodeGeneration: 'node-generation-1', actorGeneration: current.generation + 1 }), code('STALE_ASSIGNMENT'));
  assert.equal(f.node.gameHost.get('allocation-a').state, 'committed');
  assert.deepEqual(await f.rpc.call('removeSpectator', member), { ok: true });
  assert.deepEqual(await f.rpc.call('removeSpectator', member), { ok: true }, 'lost replies may retry without repeating the engine hook');
  assert.equal(f.matches[0].calls.filter(call => call[0] === 'removeSpectator' && call[1] === 's1').length, 1);
  assert.equal(f.node.gameHost.member('allocation-a', 's1'), null);
  // A second actor has a new generation even within the same node process.
  const next = await f.rpc.call('prepare', spec({ assignmentId: 'allocation-b', roomCode: 'EFGH' }));
  await assert.rejects(f.rpc.call('removeSpectator', { ...member, assignmentId: next.assignmentId }), code('STALE_ASSIGNMENT'));
  await assert.rejects(f.rpc.call('release', { assignmentId: next.assignmentId, nodeGeneration: member.nodeGeneration, actorGeneration: member.actorGeneration }), code('STALE_ASSIGNMENT'));
  assert.equal(f.node.gameHost.member(next.assignmentId, 's1').role, 'spectator');
  assert.equal(f.node.gameHost.get(next.assignmentId).state, 'prepared');
});

test('cancelled/expired assignment tickets and delayed commits cannot resurrect an old Match', async t => {
  const { rpc, bind, socket, tickets, claims, matches, advance } = await fixture(t, { prepareMs: 100 });
  await rpc.call('prepare', spec());
  const token = tickets.issue(claims('p1'));
  const p1 = await bind('p1');
  assert.equal(await rpc.call('abort', { assignmentId: 'allocation-a' }), true);
  await p1.closed;
  assert.equal(matches[0].disposes, 1); assert.equal(matches[0].starts, 0);
  const late = await socket(); late.send({ t: 'cluster.bind', assignmentId: 'allocation-a', sessionId: 'p1', ticket: token });
  assert.equal((await late.wait('error')).code, 'UNAUTHORIZED'); await late.closed;
  await assert.rejects(rpc.call('commit', { assignmentId: 'allocation-a' }), code('STALE_ASSIGNMENT'));
  await assert.rejects(rpc.call('prepare', spec()), code('STALE_ASSIGNMENT'));
  await rpc.call('prepare', spec({ assignmentId: 'allocation-b', roomCode: 'EFGH' }));
  advance(100);
  await assert.rejects(rpc.call('commit', { assignmentId: 'allocation-b' }), code('STALE_ASSIGNMENT'));
  assert.equal(matches[1].disposes, 1); assert.equal(matches[1].starts, 0);
});

test('status stays small; terminal receipt is explicit/personal, and WS replays after dispose with bound first', async t => {
  const { start, rpc, matches, bind } = await fixture(t);
  const { p2 } = await start();
  p2.ws.terminate(); await p2.closed;
  const m = matches[0];
  m.opts.broadcast({ t: 'm.public', phase: 'END', round: 9 });
  for (const playerId of ['p1', 'p2', 's1']) m.opts.send(playerId, { t: 'm.result', playerId, victory: true });
  m.opts.onEnd({ victory: true }); await turn();
  assert.equal(m.disposes, 1);
  const status = await rpc.call('status', { assignmentId: 'allocation-a' });
  assert.equal(status.state, 'ended');
  for (const field of ['receipt', 'lastPublic', 'results', 'seats', 'spectators']) assert.equal(Object.hasOwn(status, field), false);
  const receipt = await rpc.call('status', { assignmentId: 'allocation-a', sessionId: 'p2', receipt: true });
  assert.equal(receipt.receipt.result.playerId, 'p2');
  assert.equal(Object.hasOwn(receipt.receipt, 'lastPublic'), false);
  assert.equal(Object.hasOwn(receipt.receipt, 'results'), false);
  await assert.rejects(rpc.call('status', { assignmentId: 'allocation-a', sessionId: 'intruder', receipt: true }), code('NOT_MEMBER'));
  const resumed = await bind('p2');
  await resumed.wait('m.result');
  assert.deepEqual(resumed.log.map(m => m.t), ['cluster.bound', 'm.public', 'm.result']);
  assert.equal(resumed.log.at(-1).playerId, 'p2');
  assert.equal(m.calls.some(c => c[0] === 'onReconnect' && c[1] === 'p2'), false);
  resumed.send({ t: 'g.ready', ready: true, rid: 1 });
  assert.equal((await resumed.wait('error', m => m.rid === 1)).code, ERR.WRONG_PHASE);
});

test('64KiB payload guard, disabled inner compression, heartbeat, and bind timeout remain active', async t => {
  const first = await fixture(t, { bindTimeoutMs: 30 });
  const idle = await first.socket();
  assert.equal(first.node.wss.options.maxPayload, 64 * 1024);
  assert.equal(first.node.wss.options.perMessageDeflate, false);
  assert.equal(idle.ws.extensions, '');
  assert.equal((await idle.closed).code, 4002);
  const second = await fixture(t, { heartbeatMs: 40, bindTimeoutMs: 1000 });
  await second.rpc.call('prepare', spec({ seats: [seat(0, 'p1')], spectators: [] }));
  const silent = await second.bind('p1', {}, { autoPong: false });
  await second.rpc.call('commit', { assignmentId: 'allocation-a' });
  assert.equal((await silent.closed).code, 1006, 'missed WS pong terminates transport');
  assert.equal(second.matches[0].calls.filter(c => c[0] === 'onDisconnect').length, 1);
  const third = await fixture(t);
  const { p1 } = await third.start();
  p1.ws.send('x'.repeat(64 * 1024 + 1));
  assert.equal((await p1.closed).code, 1009);
  assert.equal(third.matches[0].calls.some(c => c[0] === 'handle'), false);
});

test('40/s burst40 and watch2/s burst6 are per socket; abusive flooding closes only that socket', async t => {
  const { start, advance, matches, bind, rpc } = await fixture(t);
  const { p1 } = await start();
  for (let rid = 1; rid <= 7; rid++) p1.send({ t: 'g.watch', fieldId: 'n:p2', rid });
  for (let rid = 1; rid <= 6; rid++) await p1.wait('ok', m => m.rid === rid);
  assert.equal((await p1.wait('error', m => m.rid === 7)).code, ERR.RATE);
  assert.equal(matches[0].calls.filter(c => c[0] === 'handle').length, 6);
  advance(500);
  p1.send({ t: 'g.watch', fieldId: 'n:p2', rid: 8 }); await p1.wait('ok', m => m.rid === 8);
  for (let rid = 10; rid < 50; rid++) p1.send({ t: 'ping', c: rid, rid });
  for (let rid = 10; rid < 49; rid++) await p1.wait('pong', m => m.rid === rid);
  assert.equal((await p1.wait('error', m => m.rid === 49)).code, ERR.RATE);
  for (let rid = 100; rid < 600; rid++) p1.send({ t: 'ping', c: rid, rid });
  assert.equal((await p1.closed).code, 1008);
  assert.equal((await rpc.call('status')).counts.matches, 1);
  const replacement = await bind('p1');
  replacement.send({ t: 'ping', c: 1, rid: 1 }); await replacement.wait('pong', m => m.rid === 1);
});

test('existing send protection softly drops only b.snap and terminates at the hard buffer limit', async t => {
  const { start, matches, serverSocket } = await fixture(t);
  const { p1 } = await start();
  const ws = serverSocket(p1);
  Object.defineProperty(ws, 'bufferedAmount', { configurable: true, get: () => 2 << 20 });
  assert.equal(matches[0].opts.sendEncoded('p1', 'b.snap', '{"t":"b.snap"}'), false);
  assert.equal(ws.readyState, 1);
  assert.equal(matches[0].opts.send('p1', { t: 'm.public', reliable: true }), true);
  await p1.wait('m.public', m => m.reliable === true);
  Object.defineProperty(ws, 'bufferedAmount', { configurable: true, get: () => (16 << 20) + 1 });
  assert.equal(matches[0].opts.sendEncoded('p1', 'b.ev', '{"t":"b.ev"}'), false);
  await p1.closed;
  assert.equal(matches[0].calls.filter(c => c[0] === 'onDisconnect' && c[1] === 'p1').length, 1);
});

test('unpublished commit has an exclusive bounded lease; commit retries never extend it', async t => {
  const { rpc, bind, matches, advance, node } = await fixture(t, { publicationMs: 100 });
  const prepared = await rpc.call('prepare', spec());
  assert.equal(prepared.published, false);
  await assert.rejects(rpc.call('publish', { assignmentId: 'allocation-a' }), code('WRONG_PHASE'));
  const p1 = await bind('p1'); await bind('p2');
  assert.equal((await rpc.call('commit', { assignmentId: 'allocation-a' })).published, false);
  assert.equal((await rpc.call('status', { assignmentId: 'allocation-a' })).published, false);
  advance(70);
  assert.equal((await rpc.call('commit', { assignmentId: 'allocation-a' })).published, false);
  assert.equal(matches[0].starts, 1);
  advance(30);
  await assert.rejects(rpc.call('publish', { assignmentId: 'allocation-a' }), code('STALE_ASSIGNMENT'));
  await p1.closed;
  assert.equal(matches[0].disposes, 1);
  assert.equal(node.gameHost.get('allocation-a'), null);
  await assert.rejects(rpc.call('commit', { assignmentId: 'allocation-a' }), code('STALE_ASSIGNMENT'));
});

test('coordinator silence after commit physically reclaims only that actor, even with a frozen injected clock', async t => {
  const { start, node, matches, rpc } = await fixture(t, { publicationMs: 30 });
  const { p1 } = await start();
  assert.equal((await p1.closed).code, 1001);
  assert.equal(matches[0].disposes, 1);
  assert.equal(node.gameHost.get('allocation-a'), null);
  assert.equal(node.server.listening, true);
  const status = await rpc.call('status');
  assert.equal(status.ready, true); assert.equal(status.counts.matches, 0);
});

test('publish is idempotent and cancels new-allocation cleanup without resetting the Match', async t => {
  const { start, rpc, node, matches, advance } = await fixture(t, { publicationMs: 250 });
  await start();
  assert.equal((await rpc.call('publish', { assignmentId: 'allocation-a' })).published, true);
  assert.equal((await rpc.call('publish', { assignmentId: 'allocation-a' })).published, true);
  advance(1000);
  await new Promise(resolve => setTimeout(resolve, 280));
  assert.equal((await rpc.call('status', { assignmentId: 'allocation-a' })).published, true);
  assert.equal((await rpc.call('commit', { assignmentId: 'allocation-a' })).published, true);
  assert.equal(matches[0].starts, 1); assert.equal(matches[0].disposes, 0);
  assert.equal(node.gameHost.get('allocation-a').state, 'committed');
});

test('handler and clock errors cross the WS boundary only as fixed codes, never input or exception text', async t => {
  const secret = 'synthetic-ticket-secret';
  const first = await fixture(t, { handle: () => { throw new Error(secret); } });
  const { p1 } = await first.start();
  p1.send({ t: 'g.ready', ready: true, rid: 1, secret });
  const failure = await p1.wait('error', m => m.rid === 1);
  assert.deepEqual(failure, { t: 'error', code: ERR.INTERNAL, rid: 1 });
  assert.equal(JSON.stringify(first.logs).includes(secret), false);
  let bad = false;
  const second = await fixture(t, { now: () => { if (bad) throw new Error(secret); return 100_000; } });
  bad = true;
  const refused = await second.socket();
  assert.equal((await refused.closed).code, 1011);
  assert.equal(JSON.stringify(second.logs).includes(secret), false);
});

test('close is idempotent, disposes only owned actors/sockets, and never starts/closes borrowed pools', async t => {
  const combatPool = { stats: () => ({ status: 'ready', ready: 2 }), close() { assert.fail('combat pool closed'); } }, trialPool = { close() { assert.fail('trial pool closed'); } };
  const { node, start, matches } = await fixture(t, { combatPool, trialPool });
  const { p1 } = await start();
  await Promise.all([node.close(), node.close()]);
  await p1.closed;
  assert.equal(node.server.listening, false);
  assert.equal(node.gameHost.stats().closed, true);
  assert.equal(matches[0].disposes, 1);
  assert.strictEqual(matches[0].opts.combatPool, combatPool);
  assert.strictEqual(matches[0].opts.trialPool, trialPool);
});

test('a real server-authoritative Match uses the private loopback endpoint without Network/session hello', async t => {
  const real = [];
  class RealMatch extends Match { constructor(opts) { super(opts); real.push(this); } }
  const data = { chess: { chess_fixture: { chessId: 'chess_fixture', visible: true, tier: 1, bonds: [] } } };
  const { rpc, bind, node } = await fixture(t, { MatchClass: RealMatch, data });
  await rpc.call('prepare', spec({ mode: 'solo', modeId: 'mode_single_normal', seats: [seat(0, 'p1')], spectators: [] }));
  const p1 = await bind('p1');
  assert.deepEqual(p1.log.map(m => m.t), ['cluster.bound']);
  await rpc.call('commit', { assignmentId: 'allocation-a' });
  await p1.wait('m.public', m => m.phase === PHASE.INFO_CHECK); await p1.wait('m.private');
  assert.equal(real[0].clientCombat, false); assert.equal(real[0].registry.constructor.name, 'MetaRegistry');
  assert.equal(p1.log.some(m => m.t === 'welcome' || m.token !== undefined), false);
  assert.deepEqual(await rpc.call('setLoadout', { assignmentId: 'allocation-a', sessionId: 'p1', loadout: {} }), { ok: true });
  p1.send({ t: 'g.ready', ready: true, rid: 1 });
  assert.equal((await p1.wait('error', m => m.rid === 1)).code, ERR.WRONG_PHASE);
  await rpc.call('leave', { assignmentId: 'allocation-a', sessionId: 'p1' });
  await p1.closed; await turn();
  assert.equal(node.gameHost.get('allocation-a').state, 'ended');
  assert.equal(real[0].disposed, true);
});
