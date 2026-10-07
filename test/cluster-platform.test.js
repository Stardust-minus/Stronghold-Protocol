import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { RemoteGamePlatform } from '../server/cluster/platform.js';
import { createTicketAuthority } from '../server/cluster/tickets.js';
import { AllocationError } from '../server/cluster/directory.js';

const spec = (roomCode = 'ABCD', extra = {}) => ({ roomCode, build: 'test-build', protocol: 1, seed: 1, matchNo: 1, mode: 'coop',
  difficulty: 'NORMAL', modeId: 'mode_multi_normal', revivalEnabled: false, snapshotHz: 10, spectators: [],
  seats: [0, 1, 2, 3].map(seat => ({ seat, playerId: `${roomCode}-p${seat}`, name: `Player${seat}`, isBot: false, connected: true, loadout: null })), ...extra });
function peer(nodeId) {
  const state = { nodeId, key: randomBytes(32), generation: `${nodeId}-generation`, ready: true, playersReady: true, actors: new Map(), calls: [], failures: new Map(), closed: false };
  const metadata = actor => ({ assignmentId: actor.spec.assignmentId, roomCode: actor.spec.roomCode, generation: state.generation,
    build: actor.spec.build, protocol: actor.spec.protocol, actorGeneration: actor.generation, state: actor.phase, published: actor.published, playersReady: state.playersReady });
  state.client = {
    async call(op, payload) {
      state.calls.push(op);
      if (state.failures.has(op)) throw state.failures.get(op);
      if (op === 'status' && !payload.assignmentId) return { nodeId, generation: state.generation, build: 'test-build', protocol: 1, ready: state.ready,
        counts: { matches: [...state.actors.values()].filter(a => a.phase === 'committed').length } };
      if (op === 'prepare') { const actor = { spec: payload, generation: state.actors.size + 1, phase: 'prepared', published: false }; state.actors.set(payload.assignmentId, actor); return metadata(actor); }
      if (op === 'release') return state.actors.delete(payload.assignmentId);
      const actor = state.actors.get(payload.assignmentId);
      if (!actor) throw new AllocationError('STALE_ASSIGNMENT');
      if (op === 'commit') actor.phase = 'committed';
      if (op === 'publish') actor.published = true;
      return metadata(actor);
    },
    close() { state.closed = true; },
  };
  return state;
}
async function fixture(t, extra = {}) {
  const peers = [peer('game-a'), peer('game-b')], frames = [], failures = [];
  const platform = new RemoteGamePlatform({ nodes: peers, build: 'test-build', protocol: 1,
    sendControl: (sessionId, frame) => { frames.push({ sessionId, frame }); return true; },
    onUnavailable: value => failures.push(value), pollMs: 5, ...extra });
  t.after(() => platform.close());
  await platform.refresh();
  return { platform, peers, frames, failures };
}
const code = expected => e => e instanceof AllocationError && e.code === expected;

test('platform stages every player on one node, starts privately, and only publishes after local commit', async t => {
  const f = await fixture(t);
  const input = spec('ABCD', { spectators: ['watcher'] });
  const staged = await f.platform.prepare(input);
  assert.equal(f.platform.directory.byRoom('ABCD'), null);
  assert.equal(f.frames.length, 5);
  assert.ok(f.frames.every(({ frame }) => frame.t === 'cluster.prepare' && frame.nodeId === staged.nodeId && frame.published === false));
  const selected = f.peers.find(n => n.nodeId === staged.nodeId);
  const authority = createTicketAuthority({ key: selected.key });
  for (const { sessionId, frame } of f.frames) {
    assert.ok(authority.verify(frame.ticket, { sessionId, assignmentId: staged.assignmentId, nodeId: staged.nodeId,
      roomCode: 'ABCD', role: sessionId === 'watcher' ? 'spectator' : 'player', build: 'test-build', protocol: 1 }));
  }
  const view = staged.commit();
  assert.equal(view.state, 'committed');
  assert.equal(staged.publish(), true);
  await f.platform.contexts.get(staged.assignmentId).publication;
  assert.equal(selected.actors.get(staged.assignmentId).published, true);
  assert.equal(f.frames.filter(({ frame }) => frame.t === 'cluster.commit').length, 5);
  assert.equal(f.platform.directory.bySession('watcher').nodeId, staged.nodeId);
});

test('published routing survives consumed matching offers and resumes with a fresh ingress-only ticket', async t => {
  const f = await fixture(t);
  let current = true;
  const staged = await f.platform.prepare(spec(), { isCurrent: () => current });
  staged.commit();
  current = false; // Matcher consumed the offer immediately before publish.
  assert.equal(staged.publish(), true);
  await f.platform.contexts.get(staged.assignmentId).publication;
  assert.equal(f.platform.resume(staged.assignmentId, 'ABCD-p0'), true);
  const last = f.frames.at(-1).frame;
  assert.equal(last.t, 'cluster.prepare');
  assert.equal(last.published, true);
  assert.equal(f.platform.resume(staged.assignmentId, 'not-a-member'), false);
});

test('two entire matches are balanced to different nodes without splitting parties', async t => {
  const f = await fixture(t);
  const a = await f.platform.prepare(spec('ABCD'));
  const b = await f.platform.prepare(spec('EFGH'));
  assert.notEqual(a.nodeId, b.nodeId);
  a.commit(); b.commit(); a.publish(); b.publish();
  await Promise.all([f.platform.contexts.get(a.assignmentId).publication, f.platform.contexts.get(b.assignmentId).publication]);
  for (const id of spec('ABCD').seats.map(s => s.playerId)) assert.equal(f.platform.directory.bySession(id).nodeId, a.nodeId);
  for (const id of spec('EFGH').seats.map(s => s.playerId)) assert.equal(f.platform.directory.bySession(id).nodeId, b.nodeId);
});

test('cancellation while waiting for bindings releases privately started resources and fences late local commit', async t => {
  const f = await fixture(t);
  for (const p of f.peers) p.playersReady = false;
  const controller = new AbortController();
  const pending = f.platform.prepare(spec(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, code('CANCELLED'));
  assert.equal(f.platform.directory.rooms.size, 0);
  assert.equal(f.platform.directory.sessions.size, 0);
  assert.equal(f.peers.reduce((n, p) => n + p.actors.size, 0), 0);
  assert.ok(f.frames.every(({ frame }) => frame.t !== 'cluster.commit'));
});

test('lost validation after remote preparation cannot commit or leak a published room', async t => {
  const f = await fixture(t);
  const pending = await f.platform.prepare(spec());
  await pending.abort();
  assert.throws(() => pending.commit(), code('CANCELLED'));
  assert.equal(pending.publish(), false);
  assert.equal(f.platform.directory.byRoom('ABCD'), null);
  assert.equal(f.peers.reduce((n, p) => n + p.actors.size, 0), 0);
});

test('prebinding has a bounded allocation deadline and no visible partial game', async t => {
  const f = await fixture(t, { allocationMs: 25 });
  for (const p of f.peers) p.playersReady = false;
  await assert.rejects(f.platform.prepare(spec()), code('CANCELLED'));
  assert.equal(f.platform.contexts.size, 0);
  assert.equal(f.platform.directory.rooms.size, 0);
  assert.ok(f.frames.every(({ frame }) => frame.t !== 'cluster.commit'));
});

test('wrong-build or unavailable peers cannot receive a match', async t => {
  const f = await fixture(t);
  for (const p of f.peers) p.ready = false;
  await f.platform.refresh();
  await assert.rejects(f.platform.prepare(spec()), code('NO_NODE'));
  assert.ok(f.peers.every(p => !p.calls.includes('prepare')));
});

test('publication acknowledgement failure is explicit and compensates without inventing a match result', async t => {
  const f = await fixture(t);
  for (const p of f.peers) p.failures.set('publish', new AllocationError('STALE_ASSIGNMENT'));
  const staged = await f.platform.prepare(spec());
  staged.commit(); staged.publish();
  const context = f.platform.contexts.get(staged.assignmentId);
  assert.equal(await context.publication, false);
  assert.deepEqual(f.failures, [{ assignmentId: staged.assignmentId, roomCode: 'ABCD', nodeId: staged.nodeId, reason: 'PUBLICATION_FAILED' }]);
  assert.equal(f.platform.directory.byRoom('ABCD'), null);
  assert.equal(f.peers.reduce((n, p) => n + p.actors.size, 0), 0);
});

test('node recreation leaves an existing match marked lost, never relocates its room or identity', async t => {
  const f = await fixture(t);
  const staged = await f.platform.prepare(spec());
  staged.commit(); staged.publish();
  await f.platform.contexts.get(staged.assignmentId).publication;
  const selected = f.peers.find(p => p.nodeId === staged.nodeId);
  selected.generation = `${selected.nodeId}-replacement`;
  await f.platform.refresh();
  const old = f.platform.directory.byRoom('ABCD');
  assert.equal(old.nodeId, staged.nodeId);
  assert.equal(old.ownerAvailable, false);
  assert.equal(f.platform.resume(staged.assignmentId, 'ABCD-p0'), false);
});
