import test from 'node:test';
import assert from 'node:assert/strict';
import { ClusterDirectory, AllocationError } from '../server/cluster/directory.js';

const node = (nodeId, extra = {}) => ({ nodeId, generation: `${nodeId}-generation-1`, build: 'test-build', protocol: 1, ...extra });
const request = (roomCode = 'ABCD', extra = {}) => ({ roomCode, sessionIds: ['p1', 'p2', 'p3', 'p4'], build: 'test-build', protocol: 1, ...extra });
const isCode = code => e => e instanceof AllocationError && e.code === code;
function fixture(options = {}) {
  let now = 100_000;
  const directory = new ClusterDirectory({ now: () => now, ...options });
  const add = (nodeId, extra = {}) => {
    const config = node(nodeId, extra);
    directory.register(config);
    directory.heartbeat(nodeId, { generation: config.generation, ready: true, matches: 0 });
  };
  return { directory, add, advance: ms => { now += ms; }, time: () => now };
}

test('one complete party is assigned to one node; only commit publishes room/session routing', () => {
  const { directory: d, add } = fixture();
  add('game-a'); add('game-b');
  const pending = d.prepare(request());
  assert.equal(pending.state, 'prepared');
  assert.equal(d.byRoom('ABCD'), null);
  for (const id of pending.sessionIds) assert.equal(d.bySession(id), null);
  const committed = d.commit(pending.assignmentId);
  assert.equal(committed.state, 'committed');
  assert.equal(d.byRoom('ABCD').nodeId, committed.nodeId);
  for (const id of committed.sessionIds) assert.equal(d.bySession(id).assignmentId, committed.assignmentId);
  assert.ok(Object.isFrozen(committed));
  assert.ok(Object.isFrozen(committed.sessionIds));
});

test('pending reservations count toward least-loaded assignment before heartbeats catch up', () => {
  const { directory: d, add } = fixture();
  add('game-a'); add('game-b');
  const a = d.prepare(request('ABCD', { sessionIds: ['p1'] }));
  const b = d.prepare(request('EFGH', { sessionIds: ['p2'] }));
  assert.notEqual(a.nodeId, b.nodeId);
  d.commit(a.assignmentId); d.commit(b.assignmentId);
  assert.equal(d.load(d.nodes.get('game-a')), 1);
  d.heartbeat('game-a', { generation: node('game-a').generation, ready: true, matches: 1 });
  assert.equal(d.load(d.nodes.get('game-a')), 1);
});

test('prepare and commit retries are idempotent, but conflicting payloads are rejected', () => {
  const { directory: d, add } = fixture();
  add('game-a');
  const input = request('ABCD', { assignmentId: 'allocation-one' });
  const pending = d.prepare(input);
  assert.deepEqual(d.prepare(input), pending);
  assert.throws(() => d.prepare({ ...input, sessionIds: ['p2', 'p1', 'p3', 'p4'] }), isCode('ASSIGNMENT_CONFLICT'));
  const committed = d.commit(pending.assignmentId);
  assert.deepEqual(d.commit(pending.assignmentId), committed);
  assert.deepEqual(d.prepare(input), committed);
  assert.equal(d.assignments.size, 1);
});

test('room names and all party identities are locked across concurrent preparations', () => {
  const { directory: d, add } = fixture();
  add('game-a');
  d.prepare(request());
  assert.throws(() => d.prepare(request('ABCD', { sessionIds: ['other'] })), isCode('ROOM_BUSY'));
  assert.throws(() => d.prepare(request('EFGH', { sessionIds: ['p4'] })), isCode('SESSION_BUSY'));
  assert.equal(d.assignments.size, 1);
});

test('cancel before commit releases every party identity and rejects a late commit', () => {
  const { directory: d, add } = fixture();
  add('game-a');
  const pending = d.prepare(request('ABCD', { assignmentId: 'cancelled-allocation' }));
  assert.equal(d.abort(pending.assignmentId), true);
  assert.equal(d.abort(pending.assignmentId), false);
  assert.throws(() => d.commit(pending.assignmentId), isCode('STALE_ASSIGNMENT'));
  assert.throws(() => d.prepare(request('ABCD', { assignmentId: pending.assignmentId })), isCode('STALE_ASSIGNMENT'));
  const next = d.prepare(request());
  assert.notEqual(next.assignmentId, pending.assignmentId);
});

test('prepare deadline is exclusive and expired work is compensatable', () => {
  const { directory: d, add, advance } = fixture({ prepareMs: 100 });
  add('game-a');
  const a = d.prepare(request());
  advance(100);
  assert.throws(() => d.commit(a.assignmentId), isCode('STALE_ASSIGNMENT'));
  assert.equal(d.rooms.size, 0);
  assert.equal(d.sessions.size, 0);
});

test('stale, unready, wrong-build and wrong-protocol nodes do not receive new work', () => {
  const { directory: d, add, advance } = fixture({ heartbeatMs: 100 });
  d.register(node('cold'));
  add('wrong-build', { build: 'different-build' });
  add('wrong-protocol', { protocol: 2 });
  add('ready');
  d.disable('ready');
  assert.throws(() => d.prepare(request()), isCode('NO_NODE'));
  d.heartbeat('ready', { generation: node('ready').generation, ready: true, matches: 0 });
  advance(100);
  assert.throws(() => d.prepare(request()), isCode('NO_NODE'));
});

test('health loss prevents commit but does not silently move an existing match', () => {
  const { directory: d, add, advance } = fixture({ heartbeatMs: 100 });
  add('game-a'); add('game-b');
  const active = d.prepare(request());
  d.commit(active.assignmentId);
  const pending = d.prepare(request('EFGH', { sessionIds: ['p5'] }));
  advance(100);
  assert.throws(() => d.commit(pending.assignmentId), isCode('NODE_UNAVAILABLE'));
  assert.equal(d.byRoom('ABCD').nodeId, active.nodeId);
  assert.equal(d.byRoom('ABCD').ownerAvailable, true);
  assert.equal(d.byRoom('EFGH'), null);
});

test('node recreation cancels preparations and marks committed rooms as lost, not migrated', () => {
  const { directory: d, add } = fixture();
  add('game-a');
  const active = d.prepare(request());
  d.commit(active.assignmentId);
  const pending = d.prepare(request('EFGH', { sessionIds: ['p5'] }));
  d.register(node('game-a', { generation: 'replacement-generation' }));
  assert.throws(() => d.commit(pending.assignmentId), isCode('STALE_ASSIGNMENT'));
  const lost = d.byRoom('ABCD');
  assert.equal(lost.assignmentId, active.assignmentId);
  assert.equal(lost.generation, active.generation);
  assert.equal(lost.ownerAvailable, false);
  assert.equal(d.heartbeat('game-a', { generation: active.generation, ready: true, matches: 10 }), false);
  assert.throws(() => d.prepare(request('IJKL', { sessionIds: ['p1'] })), isCode('SESSION_BUSY'));
});

test('changing build or capacity without changing generation is rejected', () => {
  const { directory: d, add } = fixture();
  add('game-a');
  assert.throws(() => d.register(node('game-a', { build: 'other-build' })), isCode('NODE_CONFLICT'));
  assert.throws(() => d.register(node('game-a', { capacity: 1 })), isCode('NODE_CONFLICT'));
});

test('spectators follow the same room owner but cannot become players or occupy another room', () => {
  const { directory: d, add } = fixture();
  add('game-a'); add('game-b');
  const a = d.prepare(request());
  d.commit(a.assignmentId);
  d.attachSpectator(a.assignmentId, 'watcher');
  assert.equal(d.bySession('watcher').nodeId, a.nodeId);
  assert.deepEqual(d.attachSpectator(a.assignmentId, 'watcher').spectatorIds, ['watcher']);
  assert.throws(() => d.attachSpectator(a.assignmentId, 'p1'), isCode('ROLE_CONFLICT'));
  const b = d.prepare(request('EFGH', { sessionIds: ['p5'] }));
  d.commit(b.assignmentId);
  assert.throws(() => d.attachSpectator(b.assignmentId, 'watcher'), isCode('SESSION_BUSY'));
  assert.equal(d.detachSpectator(a.assignmentId, 'watcher'), true);
  assert.equal(d.bySession('watcher'), null);
  d.attachSpectator(b.assignmentId, 'watcher');
  assert.equal(d.bySession('watcher').nodeId, b.nodeId);
});

test('abort cannot revoke a live game; explicit end/release clears all player and spectator routes', () => {
  const { directory: d, add } = fixture();
  add('game-a');
  const a = d.prepare(request());
  d.commit(a.assignmentId); d.attachSpectator(a.assignmentId, 'watcher');
  assert.equal(d.abort(a.assignmentId), false);
  assert.equal(d.release(a.assignmentId), true);
  assert.equal(d.release(a.assignmentId), false);
  assert.equal(d.byRoom('ABCD'), null);
  assert.equal(d.sessions.size, 0);
});

test('capacity is opt-in and zero remains unlimited', () => {
  const { directory: d, add } = fixture();
  add('limited', { capacity: 1 });
  d.prepare(request());
  assert.throws(() => d.prepare(request('EFGH', { sessionIds: ['p5'] })), isCode('NO_NODE'));
  add('unlimited');
  const b = d.prepare(request('EFGH', { sessionIds: ['p5'] }));
  d.commit(b.assignmentId);
  assert.equal(b.nodeId, 'unlimited');
  assert.equal(d.prepare(request('IJKL', { sessionIds: ['p6'] })).nodeId, 'unlimited');
});

test('invalid configuration and assignments fail before mutating any routing state', () => {
  for (const options of [{ heartbeatMs: 0 }, { prepareMs: NaN }, { tombstoneMs: 300001 }, { now: null }]) {
    assert.throws(() => new ClusterDirectory(options));
  }
  const { directory: d, add } = fixture();
  add('game-a');
  for (const input of [request('abcd'), request('ABC\n'), request('ABCD', { sessionIds: ['p1', 'p1'] }), request('ABCD', { sessionIds: [] }),
    request('ABCD', { protocol: '1' }), request('ABCD', { sessionIds: ['../user'] }), request('ABCD', { sessionIds: ['user\n'] })]) {
    assert.throws(() => d.prepare(input), TypeError);
  }
  assert.equal(d.assignments.size, 0);
  assert.equal(d.rooms.size, 0);
  assert.equal(d.sessions.size, 0);
});
