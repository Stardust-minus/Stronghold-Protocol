import test from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { ClusterLobby } from '../server/cluster/lobby.js';
import { GameHost } from '../server/cluster/game-host.js';
import { SessionRegistry } from '../server/net.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';
import { validateC2S } from '../shared/protocol.js';
import { EXPERIMENTAL_DEFAULTS, experimentalOptions, isExperimental } from '../shared/experimental.js';
import { makeMatch, give } from './match/harness.js';
import { collectViolations } from '../server/match/invariants.js';
import { makeCtx } from '../server/match/effectsMeta.js';

const opts = (revivalEnabled = false, disableSharedPool = false) => ({ revivalEnabled, disableSharedPool });
class RecordingMatch {
  constructor(options) { this.opts = options; }
  start() { this.opts.broadcast({ t: 'm.public', phase: 'INFO_CHECK', experimental: this.opts.experimental }); }
  dispose() {}
  onLeave() {}
  onDisconnect() {}
}
function lobbyFixture(t, LobbyClass = Lobby, extra = {}) {
  const registry = new SessionRegistry(), lobby = new LobbyClass({ registry, MatchClass: RecordingMatch,
    getData: () => ({}), seedFn: () => 7, ...extra });
  t.after(() => lobby.shutdown());
  let number = 0;
  const player = () => {
    const session = registry.create(`Option${++number}`);
    session.messages = []; session.connected = true; session.matchmakingVersion = MATCHMAKING_VERSION;
    session.ws = { readyState: 1, bufferedAmount: 0, send(data, cb) { session.messages.push(JSON.parse(data)); cb?.(); } };
    return session;
  };
  const room = (size, experimental = opts()) => {
    const members = Array.from({ length: size }, player);
    assert.deepEqual(lobby.create(members[0], { mode: 'coop', difficulty: 'NORMAL', experimental }), { ok: true });
    const owner = lobby.roomOf(members[0]);
    for (const member of members.slice(1)) {
      assert.deepEqual(lobby.join(member, { code: owner.code }), { ok: true });
      assert.deepEqual(lobby.ready(member, { ready: true }), { ok: true });
    }
    return { owner, members };
  };
  return { lobby, registry, player, room };
}

for (const value of [null, [], {}, { revivalEnabled: false }, { ...opts(), extra: false },
  { revivalEnabled: 1, disableSharedPool: false }, { revivalEnabled: false, disableSharedPool: 'false' },
  Object.assign(Object.create(opts()), {}), Object.defineProperty({ disableSharedPool: false }, 'revivalEnabled', { get() { throw new Error('must not read'); }, enumerable: true })]) {
  test('experimental schema rejects incomplete, coerced, inherited or accessor settings', () => {
    assert.equal(isExperimental(value), false);
    assert.throws(() => experimentalOptions(value), TypeError);
    assert.ok(validateC2S({ t: 'room.setExperimental', experimental: value }));
  });
}
for (const revivalEnabled of [false, true]) for (const disableSharedPool of [false, true]) {
  test(`room launch snapshots ${revivalEnabled}/${disableSharedPool} without votes`, t => {
    const h = lobbyFixture(t), source = opts(revivalEnabled, disableSharedPool), { owner, members } = h.room(2, source);
    source.revivalEnabled = !revivalEnabled;
    assert.deepEqual(owner.toState().experimental, opts(revivalEnabled, disableSharedPool));
    assert.ok(Object.isFrozen(owner.experimental));
    h.lobby.ready(members[1], { ready: true });
    assert.deepEqual(h.lobby.start(members[0]), { ok: true });
    assert.equal(owner.match.opts.revivalEnabled, revivalEnabled); assert.equal(owner.match.opts.disableSharedPool, disableSharedPool);
    assert.deepEqual(owner.match.opts.experimental, opts(revivalEnabled, disableSharedPool));
    assert.equal(h.lobby.setExperimental(members[0], { experimental: opts() }).error, ERR.ROOM_STARTED);
  });
  test(`public solos inherit ${revivalEnabled}/${disableSharedPool} from their intact party`, t => {
    const h = lobbyFixture(t), { owner, members } = h.room(2, opts(revivalEnabled, disableSharedPool)), solos = [h.player(), h.player()];
    for (const solo of solos) assert.deepEqual(h.lobby.queue.join(solo, { difficulty: 'NORMAL' }), { ok: true });
    assert.deepEqual(h.lobby.queue.join(members[0], { difficulty: 'NORMAL', party: true }), { ok: true });
    const players = [...solos, ...members];
    for (const player of players) {
      const offered = h.lobby.queue.state(player);
      assert.deepEqual(offered.experimental, opts(revivalEnabled, disableSharedPool));
      assert.deepEqual(h.lobby.queue.accept(player, { ticketId: offered.ticketId, offerId: offered.offerId }), { ok: true });
    }
    const matched = h.lobby.roomOf(solos[0]);
    assert.deepEqual(matched.experimental, opts(revivalEnabled, disableSharedPool));
    assert.ok(owner.disposed); assert.ok(players.every(player => player.roomCode === matched.code));
  });
}

test('option change un-readies teammates and does not grant non-host, spectator or solo queue authority', t => {
  const h = lobbyFixture(t), { owner, members } = h.room(2), observer = h.player(), solo = h.player();
  h.lobby.spectate(observer, { code: owner.code }); h.lobby.ready(members[1], { ready: true });
  for (const player of [members[1], observer]) assert.equal(h.lobby.setExperimental(player, { experimental: opts(true, true) }).error, ERR.NOT_HOST);
  assert.equal(h.lobby.setExperimental(solo, { experimental: opts(true, true) }).error, ERR.NOT_IN_ROOM);
  assert.deepEqual(h.lobby.setExperimental(members[0], { experimental: opts(true, true) }), { ok: true });
  assert.equal(owner.seatOf(members[1].playerId).ready, false);
  assert.ok(validateC2S({ t: 'queue.join', difficulty: 'NORMAL', experimental: opts(true, true) }));
  assert.ok(validateC2S({ t: 'queue.accept', ticketId: 'ticket', offerId: 'offer', experimental: opts(true, true) }));
  h.lobby.ready(members[1], { ready: true });
  h.lobby.queue.join(members[0], { difficulty: 'NORMAL', party: true });
  assert.equal(h.lobby.setExperimental(members[0], { experimental: opts() }).error, ERR.QUEUED);
  assert.deepEqual(owner.experimental, opts(true, true));
});

test('incompatible parties stay intact in the same global queue while wildcard solos fill compatible rooms', t => {
  const h = lobbyFixture(t), a = h.room(2, opts(true, true)), b = h.room(2, opts(false, false));
  h.lobby.queue.join(a.members[0], { difficulty: 'NORMAL', party: true });
  h.lobby.queue.join(b.members[0], { difficulty: 'NORMAL', party: true });
  assert.equal(h.lobby.queue.offers.size, 0); assert.equal(h.lobby.queue.size, 4);
  const solos = [h.player(), h.player()]; for (const solo of solos) h.lobby.queue.join(solo, { difficulty: 'NORMAL' });
  const offer = [...h.lobby.queue.offers.values()][0];
  assert.deepEqual(offer.experimental, opts(true, true));
  assert.deepEqual(new Set(offer.entries.map(entry => entry.session)), new Set([...a.members, ...solos]));
  assert.ok(b.members.every(player => h.lobby.queue.state(player).state === 'queued'));
  for (const player of [...a.members, ...solos]) h.lobby.queue.accept(player, h.lobby.queue.state(player));
  assert.deepEqual(h.lobby.roomOf(solos[0]).experimental, opts(true, true));
  assert.equal(h.lobby.roomOf(b.members[0]), b.owner); assert.equal(b.owner.disposed, false);
});

test('all sixteen party-option pairings only merge compatible intact rooms and preserve option FIFO', t => {
  const flags = [opts(), opts(false, true), opts(true, false), opts(true, true)];
  for (const first of flags) for (const second of flags) {
    const h = lobbyFixture(t), a = h.room(2, first), b = h.room(2, second);
    h.lobby.queue.join(a.members[0], { difficulty: 'NORMAL', party: true });
    h.lobby.queue.join(b.members[0], { difficulty: 'NORMAL', party: true });
    if (first.revivalEnabled === second.revivalEnabled && first.disableSharedPool === second.disableSharedPool) {
      assert.equal(h.lobby.queue.offers.size, 1);
      assert.deepEqual([...h.lobby.queue.offers.values()][0].experimental, first);
    } else {
      assert.equal(h.lobby.queue.offers.size, 0);
      const solos = [h.player(), h.player()]; for (const solo of solos) h.lobby.queue.join(solo, { difficulty: 'NORMAL' });
      const offer = [...h.lobby.queue.offers.values()][0]; assert.deepEqual(offer.experimental, first);
      assert.deepEqual(new Set(offer.entries.map(entry => entry.session)), new Set([...a.members, ...solos]));
      assert.ok(b.members.every(player => h.lobby.queue.state(player).state === 'queued'));
    }
  }
});

test('failed public startup preserves both experimental flags and original party tickets', t => {
  class BrokenMatch extends RecordingMatch { start() { throw new Error('fixture start failure'); } }
  const h = lobbyFixture(t, Lobby, { MatchClass: BrokenMatch }), a = h.room(2, opts(true, true)), solos = [h.player(), h.player()];
  h.lobby.queue.join(a.members[0], { difficulty: 'NORMAL', party: true });
  for (const solo of solos) h.lobby.queue.join(solo, { difficulty: 'NORMAL' });
  const players = [...a.members, ...solos], entries = players.map(player => h.lobby.queue.entries.get(player.playerId));
  const states = players.map(player => h.lobby.queue.state(player));
  for (let i = 0; i < 3; i++) assert.deepEqual(h.lobby.queue.accept(players[i], states[i]), { ok: true });
  assert.equal(h.lobby.queue.accept(players[3], states[3]).error, ERR.INTERNAL);
  assert.equal(h.lobby.roomOf(a.members[0]), a.owner); assert.equal(a.owner.disposed, false); assert.equal(a.owner.match, null);
  assert.deepEqual(a.owner.experimental, opts(true, true));
  for (let i = 0; i < players.length; i++) assert.equal(h.lobby.queue.entries.get(players[i].playerId), entries[i]);
  assert.equal(h.lobby.queue.offers.size, 0); assert.equal(h.lobby.queue.size, 4);
});

test('four solos cannot enable experimental settings via obsolete votes', t => {
  const h = lobbyFixture(t), players = Array.from({ length: 4 }, h.player);
  for (const player of players) h.lobby.queue.join(player, { difficulty: 'NORMAL' });
  for (const player of players) h.lobby.queue.accept(player, { ...h.lobby.queue.state(player), revivalVote: true });
  assert.deepEqual(h.lobby.roomOf(players[0]).experimental, EXPERIMENTAL_DEFAULTS);
});

test('cluster manual option change aborts the old actor immediately and preserves newly selected options', async t => {
  let resolve, aborted = 0, call;
  const platform = { build: 'fixture-build', protocol: 1, resume() {}, release() {},
    deliverEnd() { throw new Error('cancelled allocation cannot deliver terminal'); },
    prepare(spec, context) { call = { spec, context }; return new Promise(done => { resolve = done; }); } };
  const h = lobbyFixture(t, ClusterLobby, { platform }), { owner, members } = h.room(1), pending = h.lobby.start(members[0]);
  assert.deepEqual(call.spec.experimental, opts());
  assert.deepEqual(h.lobby.setExperimental(members[0], { experimental: opts(true, true) }), { ok: true });
  assert.equal(call.context.signal.aborted, true); assert.ok((await pending).error);
  resolve({ assignmentId: call.spec.assignmentId, nodeId: 'fixture-node', generation: 'fixture-generation',
    commit() { throw new Error('must not commit'); }, publish() { throw new Error('must not publish'); }, abort() { aborted++; } });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(aborted, 1); assert.equal(owner.match, null); assert.deepEqual(owner.experimental, opts(true, true));
});

for (const independent of [false, true]) test(`card pool shared=${!independent}: purchase/merge/refund/elimination use the owner stock`, t => {
  const h = makeMatch({ humans: 2, fake: true, experimental: opts(false, independent) }), m = h.m;
  t.after(() => m.dispose());
  const [a, b] = m.order, id = [...m.pool.entries].find(([id, e]) => e.tier === 1 && m.gd.goldenIdOf(id) && m.gd.mergeCount(id) === 3)[0];
  assert.equal(a.pool === b.pool, !independent);
  const cap = a.pool.cap(id), before = b.pool.left(id);
  a.acquireChess(id); a.acquireChess(id); const elite = a.acquireChess(id);
  assert.ok(m.gd.isGolden(elite.id)); assert.equal(elite.poolCopies, 3);
  assert.equal(a.pool.left(id), cap - 3); assert.equal(b.pool.left(id), independent ? before : before - 3);
  a.returnCopies(elite);
  assert.equal(a.pool.left(id), cap); assert.equal(b.pool.left(id), cap);
  give(m, a, id); give(m, b, id);
  assert.deepEqual(collectViolations(m), []);
  a.eliminate();
  assert.equal(a.pool.left(id), independent ? cap : cap - 1); assert.equal(b.pool.left(id), cap - 1);
  assert.deepEqual(collectViolations(m), []);
});

test('independent exhausted stock does not starve a teammate shop or chess effect pool', t => {
  const h = makeMatch({ humans: 2, fake: true, experimental: opts(false, true) }), m = h.m;
  t.after(() => m.dispose());
  const [a, b] = m.order, id = [...a.pool.entries.keys()][0];
  a.pool.take(id, a.pool.cap(id));
  assert.equal(a.pool.left(id), 0); assert.equal(b.pool.left(id), b.pool.cap(id));
  assert.equal(a.pool.roll(m.rngShop, { filter: candidate => candidate === id }), null);
  assert.equal(b.pool.roll(m.rngShop, { filter: candidate => candidate === id }), id);
  const stockBefore = b.pool.snapshot(); a.pool.give(id, 1);
  assert.deepEqual(b.pool.snapshot(), stockBefore);
  assert.throws(() => m.poolFor('not-a-player'), TypeError);
});

test('independent card pool full fake gameplay preserves bots, economy and per-seat stock accounting', t => {
  const h = makeMatch({ humans: 2, bots: 2, fake: true, seed: 31, experimental: opts(false, true) });
  t.after(() => h.m.dispose());
  h.autoHumans().start();
  h.onBroadcast.push(frame => { if (frame.t === 'm.public') assert.deepEqual(frame.experimental, opts(false, true)); });
  h.runToEnd({ maxSteps: 3e6 });
  assert.deepEqual(collectViolations(h.m), []);
  assert.equal(h.m.errorCount, 0); assert.equal(h.m.simErrors, 0);
  assert.equal(h.m.playerPools.size, 4); assert.equal(new Set(h.m.order.map(player => player.pool)).size, 4);
});

for (const independent of [false, true]) test(`exhausted owner stock shared=${!independent}: real shop buy and sale preserve funds and teammate copies`, t => {
  const h = makeMatch({ humans: 2, fake: true, experimental: opts(false, independent) });
  t.after(() => h.m.dispose()); h.start().toPrep();
  const m = h.m, [a, b] = m.order, id = [...a.pool.entries].find(([id, e]) => e.tier === 1 && m.gd.goldenIdOf(id) && m.gd.mergeCount(id) === 3)[0];
  const cap = a.pool.cap(id);
  for (let i = 0; i < cap; i++) a.acquireChess(id);
  assert.equal(a.pool.left(id), 0); assert.equal(b.pool.left(id), independent ? cap : 0);
  b.funds = 100; b.shop.slots[0] = { kind: 'chess', id, basePrice: 2, sold: false, frozen: false };
  const price = b.priceOf(b.shop.slots[0]), before = b.funds;
  if (independent) {
    assert.deepEqual(b.buy(0), { ok: true }); assert.equal(b.funds, before - price); assert.equal(b.pool.left(id), cap - 1);
    const piece = b.allChess().find(piece => m.gd.baseIdOf(piece.id) === id);
    assert.deepEqual(b.sell(piece.uid), { ok: true }); assert.equal(b.pool.left(id), cap); assert.equal(a.pool.left(id), 0);
  } else {
    assert.equal(b.buy(0).error, ERR.SOLD_OUT); assert.equal(b.funds, before); assert.equal(b.shop.slots[0].sold, false);
  }
  const held = a.allChess().find(piece => m.gd.baseIdOf(piece.id) === id);
  assert.deepEqual(a.sell(held.uid), { ok: true }); assert.equal(a.pool.left(id), held.poolCopies || 3);
  if (independent) assert.equal(b.pool.left(id), cap);
  h.invariants();
});

test('player-owned effect context draws and grants only its personal pool copies', t => {
  const h = makeMatch({ humans: 2, fake: true, experimental: opts(false, true) }), m = h.m;
  t.after(() => m.dispose()); const [a, b] = m.order;
  const id = [...a.pool.entries.keys()].find(id => m.gd.chess(id)?.tier === 1);
  for (let i = 0; i < a.pool.cap(id); i++) a.acquireChess(id);
  const ca = makeCtx(m, a, { key: 'fixture' }, 'onPrepStart'), cb = makeCtx(m, b, { key: 'fixture' }, 'onPrepStart');
  assert.equal(ca.rollChess({ filter: value => value === id }), null);
  assert.equal(ca.grantChess(id), null);
  assert.equal(cb.rollChess({ filter: value => value === id }), id);
  assert.ok(cb.grantChess(id)); assert.equal(b.pool.left(id), b.pool.cap(id) - 1); assert.equal(a.pool.left(id), 0);
  assert.deepEqual(collectViolations(m), []);
});

test('GameHost validates and forwards experimental options, rejecting incoherent redundant flags', t => {
  const host = new GameHost({ MatchClass: RecordingMatch }); t.after(() => host.close());
  const spec = { assignmentId: 'new-options', roomCode: 'TEST', build: 'fixture', protocol: 1, seed: 7, matchNo: 1,
    mode: 'coop', difficulty: 'NORMAL', modeId: 'mode_multi_normal', revivalEnabled: true, disableSharedPool: true,
    experimental: opts(true, true), seats: [{ seat: 0, playerId: 'p0', name: 'Fixture', isBot: false, connected: true }] };
  const view = host.prepare(spec);
  assert.deepEqual(view.experimental, opts(true, true)); assert.equal(view.disableSharedPool, true);
  assert.deepEqual(host.contexts.get(spec.assignmentId).match.opts.experimental, opts(true, true));
  for (const patch of [{ revivalEnabled: false }, { disableSharedPool: false }, { experimental: { ...opts(true, true), extra: true } }, { disableSharedPool: 'true' }]) {
    assert.throws(() => host.prepare({ ...spec, assignmentId: 'bad-options', ...patch }), error => error.code === 'INVALID_SPEC');
  }
});
