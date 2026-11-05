// 点赞 on the cluster path (server/lobby.js like; test/lobby-likes.test.js is the single-process one): the coordinator
// lobby ends a remote match from the node's trusted end receipt (ClusterLobby.receiveEnd → Lobby.onMatchEnd), so the
// likes of its settlement live there too and room.like never reaches a game node. Fake platform, as test/cluster-lobby.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClusterLobby } from '../server/cluster/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(t) {
  const clock = { time: 10_000 }, calls = [], peers = [];
  const registry = new SessionRegistry({ now: () => clock.time });
  const platform = {
    build: 'synthetic-build', protocol: 1,
    prepare(spec, context) { const work = deferred(); calls.push({ spec: structuredClone(spec), context, work }); return work.promise; },
    resume() { return true; },
    peer(assignmentId, method, playerId) { peers.push({ assignmentId, method, playerId }); return Promise.resolve({ ok: true }); },
    deliverEnd() { return true; },
    release() { return Promise.resolve(true); },
  };
  class ForbiddenLocalMatch { constructor() { throw new Error('local simulation forbidden in cluster fixture'); } }
  const lobby = new ClusterLobby({ registry, platform, options: {}, getData: () => ({}), now: () => clock.time,
    log: { info() {}, warn() {}, error() {}, debug() {} }, seedFn: () => 123456, MatchClass: ForbiddenLocalMatch });
  t.after(() => lobby.shutdown());
  let name = 0;
  const player = () => {
    const session = registry.create(`Synthetic${++name}`);
    session.messages = []; session.connected = true; session.limitKey = null; session.matchmakingVersion = MATCHMAKING_VERSION;
    session.ws = { readyState: 1, bufferedAmount: 0, send(data, cb) { session.messages.push(JSON.parse(data)); cb?.(); } };
    lobby.onHello(session, { resumed: false, repeat: false });
    return session;
  };
  const complete = () => {
    const call = calls.at(-1);
    const handle = { assignmentId: call.spec.assignmentId, nodeId: 'synthetic-node', generation: 'synthetic-generation',
      commit() { return { ownerAvailable: true }; }, publish() { return true; }, abort() { return Promise.resolve(true); } };
    call.work.resolve(handle);
    return handle;
  };
  return { lobby, player, complete, calls, peers };
}

test('a remote match\'s settlement takes likes on the coordinator; the next match on a node refuses them', async (t) => {
  const h = harness(t);
  const [a, b] = [h.player(), h.player()];
  assert.deepEqual(h.lobby.create(a, { mode: 'coop', difficulty: 'NORMAL' }), { ok: true });
  const room = h.lobby.roomOf(a);
  assert.deepEqual(h.lobby.join(b, { code: room.code }), { ok: true });
  assert.deepEqual(h.lobby.ready(b, { ready: true }), { ok: true });
  const started = h.lobby.start(a); const handle = h.complete(); await started;
  assert.ok(room.match, 'placed on the (fake) node');
  assert.equal(h.lobby.handleMessage(a, { t: 'room.like', playerId: b.playerId }).error, ERR.WRONG_PHASE, 'not while it runs');
  const rows = [a, b].map((s, seat) => ({ playerId: s.playerId, seat, name: s.name, isBot: false, left: false }));
  rows.push({ playerId: 'ai_1', seat: 2, name: 'AI', isBot: true, left: false });
  const receipt = { assignmentId: handle.assignmentId, roomCode: room.code, generation: handle.generation,
    lastPublic: { t: 'm.public', phase: 'RESULT' },
    results: Object.fromEntries([a, b].map((s) => [s.playerId, { t: 'm.result', playerId: s.playerId, players: rows }])),
    summary: { victory: true, players: rows } };
  assert.equal(h.lobby.receiveEnd(handle.assignmentId, receipt), true);
  assert.equal(room.match, null);
  for (const s of [a, b]) s.messages.length = 0;
  assert.deepEqual(h.lobby.handleMessage(a, { t: 'room.like', playerId: b.playerId }), { ok: true });
  for (const s of [a, b]) {
    assert.deepEqual(s.messages.filter((m) => m.t === 'room.likes'),
      [{ t: 'room.likes', match: room.matchCount, counts: { [b.playerId]: 1 }, from: a.playerId, to: b.playerId }]);
  }
  assert.equal(h.lobby.handleMessage(a, { t: 'room.like', playerId: b.playerId }).error, ERR.ALREADY);
  assert.equal(h.lobby.handleMessage(a, { t: 'room.like', playerId: 'ai_1' }).error, ERR.BAD_TARGET);
  assert.equal(h.peers.filter((p) => p.method === 'like').length, 0, 'nothing for the node');

  // the next match on a node: refused while it runs
  assert.deepEqual(h.lobby.ready(b, { ready: true }), { ok: true });
  const again = h.lobby.start(a); h.complete(); await again;
  assert.ok(room.match);
  assert.equal(h.lobby.handleMessage(b, { t: 'room.like', playerId: a.playerId }).error, ERR.WRONG_PHASE);
});
