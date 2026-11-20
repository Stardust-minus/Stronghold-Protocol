// Match receipts in the lobby (docs/history/0.4.0.md §37.276): the 规程 名片 trophies counted from presented receipts (any
// identity, one per match) and shown on the seat card only in a room of that season — 二期 keeps the page's own number —,
// rc.verify, a session's identity persisted for a restart, and a cluster coordinator issuing the receipts of a remote
// match from the node's end receipt (ClusterLobby.receiveEnd → Lobby.onMatchEnd). Throwaway keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Lobby } from '../server/lobby.js';
import { ClusterLobby } from '../server/cluster/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { parseKeyring } from '../server/identity.js';
import { createReceipts } from '../server/resultReceipts.js';
import { restoreLobby, sessionDoc } from '../server/persist/lobbyState.js';
import { parseReceipt } from '../shared/receipts.js';
import { MATCHMAKING_VERSION } from '../shared/constants.js';

const receiptsAuthority = () => createReceipts({ keys: parseKeyring(`r1 ${randomBytes(32).toString('base64')}`) });
const sub = (c) => c.repeat(21) + 'A';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function openLobby(t) {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, content: { cs: 'ab'.repeat(32) }, log: quiet, options: { testMode: 'off' } });
  lobby.receipts = receiptsAuthority();
  t.after(() => lobby.shutdown());
  const player = (name, id = 'M') => {
    const s = registry.create(name);
    s.connected = true; s.sub = sub(id); s.messages = [];
    s.ws = { readyState: 1, bufferedAmount: 0, send: (txt) => s.messages.push(JSON.parse(txt)) };
    return s;
  };
  return { lobby, registry, player };
}
const ok = (r) => assert.deepEqual(r, { ok: true });
const seatCard = (room, s) => room.toState().seats.find((x) => x && x.playerId === s.playerId)?.card ?? null;

test('the 规程 名片 trophies: counted from verified receipts, any identity, one per match; 二期 rooms show the page\'s own number', (t) => {
  const { lobby, player } = openLobby(t);
  const a = player('A', 'M');
  ok(lobby.create(a, { mode: 'coop', difficulty: 'ABYSS' }));
  const room = lobby.roomOf(a);
  ok(lobby.setCard(a, { trophies: 500 }));
  assert.equal(seatCard(room, a).trophies, 500, '二期 (the default version): the page\'s own claim, as before');
  const r = lobby.receipts;
  const issue = (o) => r.issue({ sub: sub('M'), rec: 'a'.repeat(16), mode: 'coop', diff: 'ABYSS', ver: 'act3autochess@V3_1', w: true, rp: 14, tr: 6, ai: false, mod: false, elo: false, ...o });
  const forged = createReceipts({ keys: parseKeyring(`r1 ${randomBytes(32).toString('base64')}`) }).issue({ sub: sub('M'), rec: 'z'.repeat(16), mode: 'coop', diff: 'ABYSS',
    ver: 'act3autochess@V3_1', w: true, rp: 14, tr: 8, ai: false, mod: false, elo: false });
  const list = [issue({}), issue({ sub: sub('Q') }), issue({ rec: 'b'.repeat(16), tr: 3, sub: sub('Q') }), issue({ rec: 'c'.repeat(16), tr: 5, ver: 'act2autochess' }), forged];
  ok(lobby.onMessage(a, { t: 'room.trophies', rc: list }));
  assert.equal(a.rcTrophies, 9, '6 + 3 (the same match once, 二期 and the forged one left out)');
  assert.equal(seatCard(room, a).trophies, 500, 'still a 二期 room');
  room.version = 'act3autochess@V3_1';
  assert.equal(seatCard(room, a).trophies, 9, 'a 规程 room shows the server\'s count, never the page\'s 500');
  ok(lobby.onMessage(a, { t: 'room.trophies', rc: [] }));
  assert.equal(seatCard(room, a), null, 'no receipts: no trophies (and no card left)');
  // a new seat takes the session's count
  const b = player('B', 'Q');
  ok(lobby.onMessage(b, { t: 'room.trophies', rc: [issue({ sub: sub('Q'), rec: 'd'.repeat(16), tr: 4 })] }));
  ok(lobby.join(b, { code: room.code }));
  assert.equal(seatCard(room, b).trophies, 4);
  // rc.verify answers in order
  assert.deepEqual(lobby.onMessage(a, { t: 'rc.verify', rc: [list[0], forged, 'nonsense'] }), { ok: true, reply: { valid: [1, 0, 0] } });
});

test('a session\'s identity is saved with it and restored only well-formed', () => {
  const registry = new SessionRegistry();
  const s = registry.create('Doc');
  s.sub = sub('S');
  const doc = sessionDoc(s);
  assert.equal(doc.sub, sub('S'));
  const into = new SessionRegistry();
  restoreLobby({ doc: { v: 1, sessions: [doc, { ...sessionDoc(registry.create('Bad')), sub: 'not-a-sub' }], rooms: [] }, registry: into, lobby: { rooms: new Map() }, now: Date.now() });
  const back = [...into.byPlayerId.values()];
  assert.equal(back.find((x) => x.name === 'Doc')?.sub, sub('S'));
  assert.equal(back.find((x) => x.name === 'Bad')?.sub ?? null, null);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('a cluster coordinator issues the receipts of a remote match from the node\'s end receipt', async (t) => {
  const calls = [];
  const registry = new SessionRegistry();
  const platform = {
    build: 'synthetic-build', protocol: 1,
    prepare(spec, context) { const work = deferred(); calls.push({ spec, context, work }); return work.promise; },
    resume() { return true; }, peer() { return Promise.resolve({ ok: true }); }, deliverEnd() { return true; }, release() { return Promise.resolve(true); },
  };
  class ForbiddenLocalMatch { constructor() { throw new Error('local simulation forbidden'); } }
  const lobby = new ClusterLobby({ registry, platform, options: {}, getData: () => ({}), log: quiet, seedFn: () => 1, MatchClass: ForbiddenLocalMatch });
  lobby.receipts = receiptsAuthority();
  t.after(() => lobby.shutdown());
  const player = (name, id) => {
    const s = registry.create(name);
    s.messages = []; s.connected = true; s.limitKey = null; s.matchmakingVersion = MATCHMAKING_VERSION; s.sub = id ? sub(id) : null;
    s.ws = { readyState: 1, bufferedAmount: 0, send(data, cb) { s.messages.push(JSON.parse(data)); cb?.(); } };
    lobby.onHello(s, { resumed: false, repeat: false });
    return s;
  };
  const [a, b, c] = [player('A', 'A'), player('B', 'B'), player('C', null)];
  ok(lobby.create(a, { mode: 'coop', difficulty: 'HARD' }));
  const room = lobby.roomOf(a);
  for (const s of [b, c]) { ok(lobby.join(s, { code: room.code })); ok(lobby.ready(s, { ready: true })); }
  const started = lobby.start(a);
  const call = calls.at(-1);
  const handle = { assignmentId: call.spec.assignmentId, nodeId: 'n', generation: 'g', commit() { return { ownerAvailable: true }; }, publish() { return true; }, abort() { return Promise.resolve(true); } };
  call.work.resolve(handle); await started;
  assert.ok(room.match);
  const rows = [
    { playerId: a.playerId, seat: 0, isBot: false, left: false, victory: true, roundsPassed: 14, trophies: 5 },
    { playerId: b.playerId, seat: 1, isBot: false, left: false, victory: false, roundsPassed: 9, trophies: 2, aiTakeoverRound: 6 },
    { playerId: c.playerId, seat: 2, isBot: false, left: false, victory: true, roundsPassed: 14, trophies: 5 },
  ];
  const results = Object.fromEntries([a, b, c].map((s) => [s.playerId, { t: 'm.result', playerId: s.playerId, players: rows }]));
  for (const s of [a, b, c]) s.messages.length = 0;
  assert.equal(lobby.receiveEnd(handle.assignmentId, { assignmentId: handle.assignmentId, roomCode: room.code, generation: 'g',
    lastPublic: { t: 'm.public', phase: 'RESULT' }, results, summary: { victory: true, difficulty: 'HARD', players: rows } }), true);
  const ra = a.messages.find((m) => m.t === 'm.receipt'), rb = b.messages.find((m) => m.t === 'm.receipt');
  assert.ok(ra && rb, 'both seats with an identity');
  assert.equal(c.messages.some((m) => m.t === 'm.receipt'), false, 'a session without one: none');
  const fa = parseReceipt(ra.rc), fb = parseReceipt(rb.rc);
  assert.deepEqual([fa.sub, fa.mode, fa.diff, fa.w, fa.rp, fa.tr, fa.ai], [sub('A'), 'coop', 'HARD', 1, 14, 5, 0]);
  assert.deepEqual([fb.sub, fb.w, fb.rp, fb.ai], [sub('B'), 0, 9, 1]);
  assert.ok(lobby.receipts.verify(ra.rc));
  assert.equal(a.messages.find((m) => m.t === 'm.receipt'), ra, 'to that player alone');
  assert.ok(!a.messages.some((m) => m.t === 'm.receipt' && m.rc === rb.rc));
  assert.deepEqual(lobby.replayFor(room, a.playerId).map((f) => JSON.parse(f).t), ['m.public', 'm.result', 'm.receipt'], 'in the replay');
});
