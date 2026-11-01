// Feedback #87: one ticket waits in several difficulties, the first to fill takes it, and it is never in two offers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { Matchmaking } from '../server/matchmaking.js';
import { SessionRegistry } from '../server/net.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';
import { PLAYER_CAPACITY_VERSION } from '../shared/playerCapacity.js';
import { validateC2S } from '../shared/protocol.js';

class RecordingMatch {
  constructor(opts) { this.opts = opts; RecordingMatch.made.push(opts); }
  static made = [];
  start() {}
  dispose() {} onDisconnect() {} onReconnect() {} onLeave() {}
}

function fixture(t) {
  let clock = 10_000, count = 0;
  const registry = new SessionRegistry({ now: () => clock });
  const lobby = new Lobby({ registry, now: () => clock, MatchClass: RecordingMatch, getData: () => ({}), seedFn: () => 71 });
  t.after(() => lobby.shutdown());
  const player = () => {
    const s = registry.create(`Pick${++count}`); s.connected = true; s.messages = [];
    s.playerCapacityVersion = PLAYER_CAPACITY_VERSION; s.matchmakingVersion = MATCHMAKING_VERSION;
    s.ws = { readyState: 1, bufferedAmount: 0, send(raw, cb) { s.messages.push(JSON.parse(raw)); cb?.(); } };
    return s;
  };
  const queue = lobby.queue;
  return { lobby, queue, player, state: (s) => queue.state(s), advance: (ms) => { clock += ms; } };
}

test('a ticket counts in each of its pools; the snapshot names them and a plain ticket keeps its old shape', t => {
  const f = fixture(t), a = f.player(), b = f.player(), c = f.player();
  assert.deepEqual(f.queue.join(a, { difficulty: 'NORMAL', difficulties: ['NORMAL', 'HARD'] }), { ok: true });
  assert.deepEqual(f.queue.join(b, { difficulty: 'HARD' }), { ok: true });
  assert.deepEqual(f.queue.join(c, { difficulty: 'HARD' }), { ok: true });
  const state = f.state(a);
  assert.equal(state.difficulty, 'NORMAL');
  assert.deepEqual(state.difficulties, ['NORMAL', 'HARD']);
  assert.deepEqual(state.waitingCounts, [1, 3]);
  assert.equal(state.waitingCount, 3, 'its fullest pool');
  const plain = f.state(b);
  assert.equal(plain.waitingCount, 3);
  assert.equal(Object.hasOwn(plain, 'difficulties'), false);
  assert.equal(Object.hasOwn(plain, 'waitingCounts'), false);
});

test('the first pool to fill takes the ticket, at that difficulty, and the room is built there', t => {
  RecordingMatch.made.length = 0;
  const f = fixture(t), several = f.player(), others = [f.player(), f.player(), f.player()];
  f.queue.join(several, { difficulty: 'NORMAL', difficulties: ['HARD', 'NORMAL'] });
  for (const p of others) f.queue.join(p, { difficulty: 'HARD' });
  const offered = f.state(several);
  assert.equal(offered.state, 'offered');
  assert.equal(offered.difficulty, 'HARD');
  assert.deepEqual(offered.difficulties, ['NORMAL', 'HARD']);
  assert.equal(Object.hasOwn(offered, 'waitingCounts'), false);
  for (const p of [several, ...others]) assert.deepEqual(f.queue.accept(p, f.state(p)), { ok: true });
  const matched = f.state(several);
  assert.equal(matched.state, 'matched');
  assert.equal(matched.difficulty, 'HARD');
  assert.equal(f.lobby.roomOf(several).difficulty, 'HARD');
  assert.equal(f.queue.size, 0, 'no ticket stays behind in the other pool');
});

test('tickets filling two pools at once make one offer each: nobody is in two', t => {
  const f = fixture(t), people = Array.from({ length: 8 }, f.player);
  for (const p of people) f.queue.join(p, { difficulty: 'NORMAL', difficulties: ['NORMAL', 'HARD'] });
  const offers = [...f.queue.offers.values()];
  assert.equal(offers.length, 2);
  const seen = offers.flatMap((o) => o.entries.map((e) => e.session.playerId));
  assert.equal(new Set(seen).size, 8, 'every ticket in exactly one offer');
  for (const o of offers) assert.equal(new Set(o.entries.map((e) => e.difficulty)).size, 1);
});

test('a ticket offered in one pool is gone from the other, and counted nowhere while offered', t => {
  const f = fixture(t), several = f.player(), rest = [f.player(), f.player(), f.player()], hard = f.player();
  f.queue.join(hard, { difficulty: 'HARD' });
  f.queue.join(several, { difficulty: 'NORMAL', difficulties: ['NORMAL', 'HARD'] });
  assert.deepEqual(f.state(hard).waitingCount, 2);
  for (const p of rest) f.queue.join(p, { difficulty: 'NORMAL' });
  assert.equal(f.state(several).difficulty, 'NORMAL');
  assert.equal(f.state(several).state, 'offered');
  assert.equal(f.state(hard).waitingCount, 1);
  assert.equal(f.state(hard).state, 'queued');
});

test('a confirmed ticket of a broken offer waits in all its difficulties again', t => {
  const f = fixture(t), several = f.player(), rest = [f.player(), f.player(), f.player()];
  f.queue.join(several, { difficulty: 'NORMAL', difficulties: ['NORMAL', 'HARD'] });
  for (const p of rest) f.queue.join(p, { difficulty: 'HARD' });
  assert.equal(f.state(several).difficulty, 'HARD');
  assert.deepEqual(f.queue.accept(several, f.state(several)), { ok: true });
  f.queue.remove(rest[0], 'cancelled');
  const back = f.state(several);
  assert.equal(back.state, 'queued');
  assert.equal(back.difficulty, 'NORMAL', 'its first choice again');
  assert.deepEqual(back.difficulties, ['NORMAL', 'HARD']);
  const fill = [f.player(), f.player(), f.player()];
  for (const p of fill) f.queue.join(p, { difficulty: 'NORMAL' });
  assert.equal(f.state(several).state, 'offered');
  assert.equal(f.state(several).difficulty, 'NORMAL');
});

test('joining again: the same difficulties are idempotent, others need a cancel; duplicates collapse, the first comes first', t => {
  const f = fixture(t), a = f.player();
  f.queue.join(a, { difficulty: 'HARD', difficulties: ['NORMAL', 'HARD', 'NORMAL'] });
  assert.deepEqual(f.state(a).difficulties, ['HARD', 'NORMAL']);
  assert.deepEqual(f.queue.join(a, { difficulty: 'HARD', difficulties: ['HARD', 'NORMAL'] }), { ok: true });
  assert.equal(f.queue.join(a, { difficulty: 'HARD' }).error, ERR.QUEUED);
  assert.equal(f.queue.join(a, { difficulty: 'NORMAL', difficulties: ['NORMAL', 'HARD'] }).error, ERR.QUEUED);
});

test('a party queues at its room\'s one difficulty', t => {
  const f = fixture(t), host = f.player();
  assert.deepEqual(f.lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' }), { ok: true });
  assert.equal(f.queue.join(host, { difficulty: 'NORMAL', difficulties: ['NORMAL', 'HARD'], party: true }).error, ERR.BAD_MSG);
  assert.equal(f.queue.has(host), false);
  assert.deepEqual(f.queue.join(host, { difficulty: 'NORMAL', party: true }), { ok: true });
});

test('a party and a ticket of several difficulties meet in the party\'s pool', t => {
  const f = fixture(t), host = f.player(), mate = f.player(), mate2 = f.player(), solo = f.player();
  assert.deepEqual(f.lobby.create(host, { mode: 'coop', difficulty: 'HARD' }), { ok: true });
  const room = f.lobby.roomOf(host);
  for (const m of [mate, mate2]) {
    assert.deepEqual(f.lobby.join(m, { code: room.code }), { ok: true });
    assert.deepEqual(f.lobby.ready(m, { ready: true }), { ok: true });
  }
  assert.deepEqual(f.queue.join(host, { difficulty: 'HARD', party: true }), { ok: true });
  f.queue.join(solo, { difficulty: 'NORMAL', difficulties: ['NORMAL', 'HARD'] });
  assert.equal(f.state(solo).state, 'offered');
  assert.equal(f.state(solo).difficulty, 'HARD');
  assert.equal(f.state(host).offerId, f.state(solo).offerId);
});

test('the cluster path: preparation runs at the offered difficulty, and a failed one puts the ticket back in all its pools', async t => {
  const calls = [];
  const queue = new Matchmaking({ now: () => 10_000, send() {}, available: () => true,
    allocate: () => { throw new Error('the cluster path never allocates synchronously'); },
    asyncAllocate: (sessions, difficulty) => { calls.push({ sessions, difficulty }); return Promise.reject(new Error('no node')); } });
  t.after(() => queue.close());
  let n = 0;
  const player = () => ({ playerId: `prep_${++n}`, connected: true, roomCode: null, limitKey: null, matchmakingVersion: MATCHMAKING_VERSION, playerCapacityVersion: PLAYER_CAPACITY_VERSION });
  const several = player(), rest = [player(), player(), player()];
  queue.join(several, { difficulty: 'NORMAL', difficulties: ['NORMAL', 'HARD'] });
  for (const p of rest) queue.join(p, { difficulty: 'HARD' });
  for (const p of [several, ...rest]) assert.deepEqual(queue.accept(p, queue.state(p)), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].difficulty, 'HARD');
  for (let i = 0; i < 8; i++) await Promise.resolve();
  const back = queue.state(several);
  assert.equal(back.state, 'queued');
  assert.equal(back.difficulty, 'NORMAL');
  assert.equal(back.reason, 'allocation_failed');
});

test('the wire: a difficulties list must be real, unique difficulties', () => {
  const join = (extra) => validateC2S({ t: 'queue.join', difficulty: 'NORMAL', ...extra });
  assert.equal(join({}), null);
  assert.equal(join({ difficulties: ['NORMAL', 'HARD'] }), null);
  assert.ok(join({ difficulties: [] }));
  assert.ok(join({ difficulties: ['NORMAL', 'NORMAL'] }));
  assert.ok(join({ difficulties: ['IMPOSSIBLE'] }));
  assert.ok(join({ difficulties: 'NORMAL' }));
});
