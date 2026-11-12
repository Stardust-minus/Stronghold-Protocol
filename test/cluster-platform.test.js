import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { RemoteGamePlatform } from '../server/cluster/platform.js';
import { createTicketAuthority } from '../server/cluster/tickets.js';
import { AllocationError } from '../server/cluster/directory.js';
import { VerifyHub, mergeVerifyStats } from '../server/match/verify/hub.js';

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

test('setup reroll RPC forwards one bounded revision with fixed node/actor epochs and player-only authority', async t => {
  const f = await fixture(t), staged = await f.platform.prepare(spec('ABCD', { spectators: ['watcher'] }));
  staged.commit(); staged.publish();
  await f.platform.contexts.get(staged.assignmentId).publication;
  const selected = f.peers.find(p => p.nodeId === staged.nodeId), calls = [], invoke = selected.client.call;
  selected.client.call = async (method, payload) => {
    if (!method.endsWith('SetupReroll')) return invoke(method, payload);
    calls.push({ method, payload }); return method === 'requestSetupReroll' ? { error: 'BAD_TARGET' } : { ok: true };
  };
  assert.deepEqual(await f.platform.peer(staged.assignmentId, 'requestSetupReroll', 'ABCD-p0', 3), { error: 'BAD_TARGET' });
  assert.deepEqual(await f.platform.peer(staged.assignmentId, 'cancelSetupReroll', 'ABCD-p0', 7), { ok: true });
  const ctx = f.platform.contexts.get(staged.assignmentId);
  assert.deepEqual(calls, [
    { method: 'requestSetupReroll', payload: { assignmentId: staged.assignmentId, sessionId: 'ABCD-p0',
      nodeGeneration: selected.generation, actorGeneration: ctx.actorGeneration, setupRevision: 3 } },
    { method: 'cancelSetupReroll', payload: { assignmentId: staged.assignmentId, sessionId: 'ABCD-p0',
      nodeGeneration: selected.generation, actorGeneration: ctx.actorGeneration, voteId: 7 } },
  ]);
  await assert.rejects(f.platform.peer(staged.assignmentId, 'requestSetupReroll', 'watcher', 0), code('NOT_MEMBER'));
  await assert.rejects(f.platform.peer(staged.assignmentId, 'requestSetupReroll', 'ABCD-p0', -1), code('BAD_REQUEST'));
  await assert.rejects(f.platform.peer(staged.assignmentId, 'cancelSetupReroll', 'ABCD-p0', 0), code('BAD_REQUEST'));
  assert.equal(calls.length, 2);
});

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
  for (const p of f.peers) {
    p.playersReady = false;
    const call = p.client.call;
    p.client.call = async (op, payload) => { const out = await call(op, payload); return op === 'status' && payload.assignmentId ? { ...out, playersConnected: 2 } : out; };
  }
  // the deadline names itself (not a generic cancellation), with the step it stopped at and the last bound count
  await assert.rejects(f.platform.prepare(spec()), e => code('TIMEOUT')(e) && e.step === 'bind' && e.playersConnected === 2);
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

const settle = async (check, label) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), label);
};
const transport = () => Object.assign(new Error('synthetic transport loss'), { code: 'TRANSPORT' });

test('node recreation retires its old-generation match at once, never relocates its room or identity', async t => {
  const f = await fixture(t);
  const staged = await f.platform.prepare(spec()), other = await f.platform.prepare(spec('EFGH'));
  for (const handle of [staged, other]) { handle.commit(); handle.publish(); await f.platform.contexts.get(handle.assignmentId).publication; }
  const selected = f.peers.find(p => p.nodeId === staged.nodeId), oldGeneration = selected.generation;
  const actorGeneration = f.platform.contexts.get(staged.assignmentId).actorGeneration;
  selected.generation = `${selected.nodeId}-replacement`;
  selected.actors.clear(); // a new process has none of the old actors
  const releases = [], invoke = selected.client.call;
  selected.client.call = async (op, payload) => { if (op === 'release') releases.push(payload); return invoke(op, payload); };
  f.frames.length = 0;
  await f.platform.refresh();
  await settle(() => !f.platform.contexts.has(staged.assignmentId), 'the lost match is released');
  assert.deepEqual(f.failures, [{ assignmentId: staged.assignmentId, roomCode: 'ABCD', nodeId: staged.nodeId, reason: 'NODE_RESTARTED' }]);
  assert.equal(f.platform.directory.byRoom('ABCD'), null, 'never relocated to another node or generation');
  for (const id of spec().seats.map(s => s.playerId)) assert.equal(f.platform.directory.bySession(id), null);
  assert.equal(f.platform.resume(staged.assignmentId, 'ABCD-p0'), false);
  assert.ok(f.frames.filter(({ frame }) => frame.assignmentId === staged.assignmentId).every(({ frame }) => frame.t === 'cluster.abort'));
  assert.equal(f.frames.filter(({ frame }) => frame.t === 'cluster.abort').length, 4);
  // The compensation keeps the old epochs, so it can never touch an actor of the new generation.
  assert.deepEqual(releases, [{ assignmentId: staged.assignmentId, nodeGeneration: oldGeneration, actorGeneration }]);
  assert.equal(f.peers.reduce((n, p) => n + p.calls.filter(op => op === 'prepare').length, 0), 2);
  // The other node's match is untouched; repeated refreshes do not retire anything twice.
  await f.platform.refresh();
  assert.equal(f.failures.length, 1);
  if (other.nodeId !== staged.nodeId) assert.equal(f.platform.directory.byRoom('EFGH').ownerAvailable, true);
});

test('a node silent for nodeLostMs retires its matches; a missed release is re-sent when the same generation answers', async t => {
  let time = 1_000_000;
  const f = await fixture(t, { now: () => time, nodeLostMs: 15_000 });
  const staged = await f.platform.prepare(spec());
  staged.commit(); staged.publish();
  await f.platform.contexts.get(staged.assignmentId).publication;
  const selected = f.peers.find(p => p.nodeId === staged.nodeId);
  selected.failures.set('status', transport());
  selected.failures.set('release', transport());
  time += 14_999;
  await f.platform.refresh();
  assert.equal(f.failures.length, 0, 'a shorter outage keeps the match');
  assert.ok(f.platform.contexts.has(staged.assignmentId));
  time += 1;
  await f.platform.refresh();
  await settle(() => !f.platform.contexts.has(staged.assignmentId), 'the lost match is released');
  assert.deepEqual(f.failures, [{ assignmentId: staged.assignmentId, roomCode: 'ABCD', nodeId: staged.nodeId, reason: 'NODE_LOST' }]);
  assert.equal(f.platform.directory.byRoom('ABCD'), null);
  assert.equal(selected.actors.size, 1, 'the unreachable node still holds the actor');
  await f.platform.refresh();
  assert.equal(f.failures.length, 1, 'retired once');
  selected.failures.clear();
  await f.platform.refresh();
  await settle(() => selected.actors.size === 0, 'the orphaned actor is released once the node answers');
  const before = selected.calls.filter(op => op === 'release').length;
  await f.platform.refresh();
  assert.equal(selected.calls.filter(op => op === 'release').length, before, 'an acknowledged release is not repeated');
});

test('a node that comes back with a new generation drops its missed releases instead of replaying them', async t => {
  let time = 1_000_000;
  const f = await fixture(t, { now: () => time, nodeLostMs: 1000 });
  const staged = await f.platform.prepare(spec());
  staged.commit(); staged.publish();
  await f.platform.contexts.get(staged.assignmentId).publication;
  const selected = f.peers.find(p => p.nodeId === staged.nodeId);
  selected.failures.set('status', transport()); selected.failures.set('release', transport());
  time += 1000;
  await f.platform.refresh();
  await settle(() => !f.platform.contexts.has(staged.assignmentId), 'the lost match is released');
  selected.failures.clear(); selected.generation = `${selected.nodeId}-next`; selected.actors.clear();
  const releases = selected.calls.filter(op => op === 'release').length;
  await f.platform.refresh();
  await f.platform.refresh();
  assert.equal(selected.calls.filter(op => op === 'release').length, releases);
  assert.deepEqual(f.failures.map(value => value.reason), ['NODE_LOST']);
});

test('terminal frames are spliced from the validated JSON texts, byte-identical to encoding each member message', async t => {
  const sent = [];
  const f = await fixture(t, { sendControlEncoded: (sessionId, type, frame) => { sent.push({ sessionId, type, frame }); return true; } });
  const staged = await f.platform.prepare(spec('ABCD', { spectators: ['watcher'] }));
  staged.commit(); staged.publish();
  await f.platform.contexts.get(staged.assignmentId).publication;
  const lastPublic = { t: 'm.public', phase: 'RESULT', text: '回放⭐ "quoted" \\ \u2028', n: 1.5 };
  const results = new Map(['ABCD-p0', 'ABCD-p2', 'watcher'].map(id => [id, JSON.stringify({ t: 'm.result', playerId: id, rank: 2, note: '结算' })]));
  assert.equal(f.platform.deliverEnd(staged.assignmentId, { lastPublic: JSON.stringify(lastPublic), results }, ['ABCD-p0', 'ABCD-p1', 'watcher']), true);
  assert.deepEqual(sent.map(({ sessionId, type }) => [sessionId, type]), [['ABCD-p0', 'cluster.terminal'], ['watcher', 'cluster.terminal']]);
  for (const { sessionId, frame } of sent) {
    assert.ok(Buffer.isBuffer(frame), 'the shared public frame is UTF-8 encoded once, not per member');
    assert.equal(frame.toString('utf8'), JSON.stringify({ t: 'cluster.terminal', assignmentId: staged.assignmentId, sessionId,
      lastPublic, result: JSON.parse(results.get(sessionId)) }));
  }
  assert.equal(f.platform.deliverEnd(staged.assignmentId, { lastPublic: null, results }, ['ABCD-p0']), false, 'exactly once');
});

test('without an encoded sender the terminal frame is the same message object, and a null public frame stays null', async t => {
  const f = await fixture(t);
  const staged = await f.platform.prepare(spec());
  staged.commit(); staged.publish();
  await f.platform.contexts.get(staged.assignmentId).publication;
  f.frames.length = 0;
  const result = { t: 'm.result', playerId: 'ABCD-p1', rank: 1 };
  assert.equal(f.platform.deliverEnd(staged.assignmentId, { lastPublic: null, results: new Map([['ABCD-p1', JSON.stringify(result)]]) }, ['ABCD-p1']), true);
  assert.deepEqual(f.frames, [{ sessionId: 'ABCD-p1', frame: { t: 'cluster.terminal', assignmentId: staged.assignmentId, sessionId: 'ABCD-p1', lastPublic: null, result } }]);
});

test('shadow verification: each node\'s status `verify` is kept for the coordinator\'s /healthz, summed; a malformed one is dropped', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.platform.verifyStats(), [], 'nodes that report none');
  const hub = new VerifyHub({ config: { verify: true } });
  hub.noteFieldCpu('unite', { ms: 100, ticks: 900 });
  const snap = hub.snapshot();
  for (const p of f.peers) {
    const call = p.client.call;
    p.client.call = async (op, payload) => {
      const value = await call(op, payload);
      return op === 'status' && !payload.assignmentId ? { ...value, verify: p.nodeId === 'game-a' ? snap : ['not', 'a', 'snapshot'] } : value;
    };
  }
  await f.platform.refresh();
  assert.equal(f.platform.verifyStats().length, 1);
  const merged = mergeVerifyStats([snap, ...f.platform.verifyStats()]);
  assert.equal(merged.fields.unite.ms, 200);
  assert.equal(merged.fields.unite.fields, 2);
});

