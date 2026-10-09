import test from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { ClusterLobby } from '../server/cluster/lobby.js';
import { GameHost } from '../server/cluster/game-host.js';
import { SessionRegistry } from '../server/net.js';
import { ERR, MATCHMAKING_VERSION, PHASE } from '../shared/constants.js';
import { PLAYER_CAPACITY_VERSION } from '../shared/playerCapacity.js';
import { validateC2S } from '../shared/protocol.js';
import { EXPERIMENTAL_DEFAULTS, experimentalOptions, experimentalKey, sameExperimental, isExperimental } from '../shared/experimental.js';
import { botPickBand } from '../server/match/bot.js';
import { DATA, makeMatch } from './match/harness.js';

const duck = 'band_ducklord';
const rules = (capacity = 8, disabled = true, revivalEnabled = false, disableSharedPool = false) => ({
  revivalEnabled, disableSharedPool, ...(capacity === 4 ? {} : { playerCapacity: capacity }), ...(disabled ? { disableDuckLord: true } : {}),
});
class RecordingMatch {
  constructor(options) { this.opts = options; }
  start() { this.opts.broadcast({ t: 'm.public', phase: 'INFO_CHECK', experimental: this.opts.experimental }); }
  dispose() {}
  onLeave() {}
  onDisconnect() {}
}
function lobbyFixture(t, clustered = false) {
  const registry = new SessionRegistry(), specs = [];
  const platform = { build: 'fixture-build', protocol: 1, resume() { return true; }, release() { return true; }, deliverEnd() { return true; },
    async prepare(spec) {
      specs.push(structuredClone(spec));
      return { assignmentId: spec.assignmentId, nodeId: 'fixture-node', generation: 'fixture-generation',
        commit() { return { ownerAvailable: true }; }, publish() { return true; }, abort() { return true; } };
    } };
  const LobbyClass = clustered ? ClusterLobby : Lobby;
  const lobby = new LobbyClass({ registry, MatchClass: RecordingMatch, getData: () => ({}), seedFn: () => 7,
    ...(clustered ? { platform } : {}) });
  t.after(() => lobby.shutdown());
  let number = 0;
  const player = () => {
    const session = registry.create(`DuckOption${++number}`);
    session.messages = []; session.connected = true; session.matchmakingVersion = MATCHMAKING_VERSION;
    session.playerCapacityVersion = PLAYER_CAPACITY_VERSION;
    session.ws = { readyState: 1, bufferedAmount: 0, send(data, cb) { session.messages.push(JSON.parse(data)); cb?.(); } };
    return session;
  };
  const room = (size, experimental = rules()) => {
    const members = Array.from({ length: size }, player);
    assert.deepEqual(lobby.create(members[0], { mode: 'coop', difficulty: 'NORMAL', experimental }), { ok: true });
    const owner = lobby.roomOf(members[0]);
    for (const member of members.slice(1)) {
      assert.deepEqual(lobby.join(member, { code: owner.code }), { ok: true });
      assert.deepEqual(lobby.ready(member, { ready: true }), { ok: true });
    }
    return { owner, members };
  };
  return { lobby, registry, player, room, specs };
}
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

test('optional duck flag has strict own boolean schema, default false, legacy normalization/key/equality and immutable snapshot', () => {
  assert.equal(DATA.bands[duck].name, '鸭爵');
  assert.deepEqual(experimentalOptions(), EXPERIMENTAL_DEFAULTS);
  assert.equal(experimentalKey(EXPERIMENTAL_DEFAULTS), '00');
  for (const capacity of [4, 8, 12, 16, 20]) {
    const legacy = rules(capacity, false), off = { ...legacy, disableDuckLord: false }, on = rules(capacity);
    assert.equal(isExperimental(off), true); assert.equal(isExperimental(on), true);
    assert.deepEqual(experimentalOptions(off), legacy); assert.equal(sameExperimental(off, legacy), true);
    assert.equal(experimentalKey(off), experimentalKey(legacy));
    assert.equal(sameExperimental(on, legacy), capacity === 4);
    assert.equal(experimentalKey(on) === experimentalKey(legacy), capacity === 4);
    const snapshot = experimentalOptions(on); on.disableDuckLord = false;
    assert.ok(Object.isFrozen(snapshot)); assert.equal(snapshot.disableDuckLord, capacity > 4 ? true : undefined);
    assert.equal(validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', experimental: snapshot }), null);
    assert.equal(validateC2S({ t: 'room.setExperimental', experimental: snapshot }), null);
  }
  const accessor = Object.defineProperty(rules(8, false), 'disableDuckLord', { enumerable: true, get() { throw new Error('must not read'); } });
  const hidden = Object.defineProperty(rules(8, false), 'disableDuckLord', { value: true });
  for (const bad of [null, 0, 1, 'true', {}, [], undefined]) {
    const value = { ...rules(8, false), disableDuckLord: bad };
    assert.equal(isExperimental(value), false); assert.throws(() => experimentalOptions(value), TypeError);
    assert.ok(validateC2S({ t: 'room.setExperimental', experimental: value }));
  }
  for (const value of [accessor, hidden, { ...rules(), unknown: false }, { ...rules(), [Symbol('hidden')]: true }, Object.create(rules())]) {
    assert.equal(isExperimental(value), false); assert.throws(() => experimentalOptions(value), TypeError);
  }
  // The existing protocol ignores unknown top-level fields; handlers must still never copy this one.
  for (const frame of [
    { t: 'room.create', mode: 'coop', difficulty: 'NORMAL', disableDuckLord: true },
    { t: 'room.setExperimental', experimental: rules(8, false), disableDuckLord: true },
  ]) assert.equal(validateC2S(frame), null);
  for (const frame of [
    { t: 'queue.join', difficulty: 'NORMAL', experimental: rules() },
    { t: 'queue.accept', ticketId: 'ticket', offerId: 'offer', experimental: rules() },
  ]) assert.ok(validateC2S(frame), 'no new top-level or queue-owned flag authority');
});

test('duck flag is host-only, un-readies teammates, snapshots local launch, and is locked while queued/started', t => {
  const h = lobbyFixture(t), { owner, members } = h.room(2, rules(8, false)), observer = h.player();
  h.lobby.spectate(observer, { code: owner.code });
  assert.deepEqual(h.lobby.setExperimental(members[0], { experimental: rules(8, false), disableDuckLord: true }), { ok: true });
  assert.equal(owner.experimental.disableDuckLord, undefined, 'unknown top-level fields are ignored, not copied');
  for (const player of [members[1], observer]) assert.equal(h.lobby.setExperimental(player, { experimental: rules() }).error, ERR.NOT_HOST);
  assert.deepEqual(h.lobby.setExperimental(members[0], { experimental: rules() }), { ok: true });
  assert.equal(owner.seatOf(members[1].playerId).ready, false); assert.deepEqual(owner.toState().experimental, rules());
  h.lobby.ready(members[1], { ready: true });
  assert.deepEqual(h.lobby.queue.join(members[0], { difficulty: 'NORMAL', party: true }), { ok: true });
  assert.equal(h.lobby.setExperimental(members[0], { experimental: rules(8, false) }).error, ERR.QUEUED);
  h.lobby.queue.remove(members[0], 'cancelled');
  assert.deepEqual(h.lobby.start(members[0]), { ok: true });
  assert.deepEqual(owner.match.opts.experimental, rules()); assert.equal(Object.hasOwn(owner.match.opts, 'disableDuckLord'), false);
  assert.equal(h.lobby.setExperimental(members[0], { experimental: rules(8, false) }).error, ERR.ROOM_STARTED);
});

test('all eight option triples form only compatible intact eight-capacity parties and preserve FIFO/inheritance', t => {
  const flags = [];
  for (const revival of [false, true]) for (const pool of [false, true]) for (const disabled of [false, true]) flags.push(rules(8, disabled, revival, pool));
  for (const first of flags) for (const second of flags) {
    const h = lobbyFixture(t), a = h.room(4, first), b = h.room(4, second);
    h.lobby.queue.join(a.members[0], { difficulty: 'NORMAL', party: true });
    h.lobby.queue.join(b.members[0], { difficulty: 'NORMAL', party: true });
    if (sameExperimental(first, second)) {
      assert.equal(h.lobby.queue.offers.size, 1);
      assert.deepEqual([...h.lobby.queue.offers.values()][0].experimental, first);
    } else {
      assert.equal(h.lobby.queue.offers.size, 0);
      const c = h.room(4, first); h.lobby.queue.join(c.members[0], { difficulty: 'NORMAL', party: true });
      const offer = [...h.lobby.queue.offers.values()][0]; assert.deepEqual(offer.experimental, first);
      assert.deepEqual(new Set(offer.entries.map(entry => entry.session)), new Set([...a.members, ...c.members]));
      assert.ok(b.members.every(player => h.lobby.queue.state(player).state === 'queued'));
    }
  }
});

for (const clustered of [false, true]) test(`nested duck flag follows parties into ${clustered ? 'cluster' : 'local'} matchmade room/Match without top-level widening`, async t => {
  const h = lobbyFixture(t, clustered), a = h.room(3), b = h.room(5), players = [...a.members, ...b.members];
  for (const group of [a, b]) h.lobby.queue.join(group.members[0], { difficulty: 'NORMAL', party: true });
  for (const player of players) {
    const state = h.lobby.queue.state(player); assert.equal(state.required, 8); assert.deepEqual(state.experimental, rules());
    assert.deepEqual(h.lobby.queue.accept(player, state), { ok: true });
  }
  await flush();
  const matched = h.lobby.roomOf(players[0]);
  assert.ok(matched.match); assert.deepEqual(matched.experimental, rules()); assert.deepEqual(matched.match.opts.experimental, rules());
  assert.equal(Object.hasOwn(matched.match.opts, 'disableDuckLord'), false);
  assert.ok(a.owner.disposed && b.owner.disposed); assert.ok(players.every(player => player.roomCode === matched.code));
  if (clustered) {
    assert.equal(h.specs.length, 1); assert.deepEqual(h.specs[0].experimental, rules()); assert.equal(Object.hasOwn(h.specs[0], 'disableDuckLord'), false);
    const host = new GameHost({ MatchClass: RecordingMatch }); t.after(() => host.close());
    const view = host.prepare(h.specs[0]); assert.deepEqual(view.experimental, rules());
    assert.deepEqual(host.contexts.get(view.assignmentId).match.opts.experimental, rules());
    assert.throws(() => host.prepare({ ...h.specs[0], assignmentId: 'bad-flag', disableDuckLord: true }), e => e.code === 'INVALID_SPEC');
    assert.throws(() => host.prepare({ ...h.specs[0], assignmentId: 'bad-nested', experimental: { ...rules(), disableDuckLord: 1 } }), e => e.code === 'INVALID_SPEC');
  }
});

for (const capacity of [8, 12, 16, 20]) test(`capacity${capacity} sparse draft filters only duck strategy for focus/manual/timeout/bot/departure/fallback`, t => {
  const data = { ...DATA, config: { ...DATA.config, economy: { ...DATA.config.economy, defaultBandId: duck },
    bandDraft: { ...DATA.config.bandDraft, timeoutBandId: duck } } };
  const h = makeMatch({ humans: 4, fake: true, data, experimental: rules(capacity), seed: 7 }).start(), m = h.m;
  t.after(() => m.dispose()); h.runToPhase(PHASE.INFO_CHECK); m.enterBandDraft();
  assert.equal(m.disableDuckLord, true); assert.equal(m.gd.bandAllowed(duck), false); assert.equal(m.gd.bandIds().includes(duck), false);
  assert.equal(m.gd.band(duck), DATA.bands[duck]); assert.equal(m.gd.effect(DATA.bands[duck].effectId), DATA.effects[DATA.bands[duck].effectId]);
  assert.equal(DATA.bands[duck].name, '鸭爵'); assert.equal(m.gd.defaultBandId, 'band_bldsk');
  assert.equal(m.gd.bandDraft.timeoutBandId, 'band_bldsk');
  const player = m.players.get(m.draftTurn());
  assert.equal(m.bandFocus(player, duck).error, ERR.BAD_TARGET); assert.equal(m.pickBand(player, duck).error, ERR.BAD_TARGET);
  m.draft.focus.set(player.playerId, duck); assert.equal(m.timeoutBand(player.playerId), 'band_bldsk');
  m.defaultBand(player.playerId); m._applyBand(player, duck); assert.equal(player.bandId, 'band_bldsk');
  for (let i = 0; i < 128; i++) assert.notEqual(botPickBand(m, m.order[1]), duck);
  const departure = m.players.get(m.draftTurn()); m.onLeave(departure.playerId); assert.notEqual(departure.bandId, duck);
  const timed = m.players.get(m.draftTurn()); m.draft.focus.set(timed.playerId, duck);
  h.sched.advance(m.bandTurnMs()); assert.notEqual(timed.bandId, duck);
  m.finishBandDraft(true); assert.ok(m.order.every(p => p.bandId && p.bandId !== duck));
  assert.deepEqual(m.publicView().experimental, rules(capacity));
});

for (const options of [
  { mode: 'coop', humans: 4, capacity: 4, disabled: true },
  { mode: 'solo', humans: 1, capacity: 20, disabled: true },
  ...[8, 12, 16, 20].map(capacity => ({ mode: 'coop', humans: 4, capacity, disabled: false })),
]) test(`${options.mode} capacity${options.capacity} disabled=${options.disabled}: unchanged strategy pool, draft order, bot picks and RNG streams`, t => {
  const baseline = makeMatch({ mode: options.mode, humans: options.humans, fake: true, seed: 819,
    experimental: rules(options.capacity, false) }).start();
  const actual = makeMatch({ mode: options.mode, humans: options.humans, fake: true, seed: 819,
    experimental: rules(options.capacity, options.disabled) }).start();
  t.after(() => { baseline.m.dispose(); actual.m.dispose(); });
  const a = actual.m, b = baseline.m;
  assert.equal(a.disableDuckLord, false); assert.equal(a.gd.bandAllowed(duck), b.gd.bandAllowed(duck));
  assert.deepEqual(a.gd.bandIds(), b.gd.bandIds());
  a.enterBandDraft(); b.enterBandDraft(); assert.deepEqual(a.draft.order, b.draft.order);
  for (let i = 0; i < 256; i++) assert.equal(botPickBand(a, a.order[0]), botPickBand(b, b.order[0]));
  for (const name of ['rngSetup', 'rngShop', 'rngWaves', 'rngDraft', 'rngBots', 'rngMeta']) assert.equal(a[name](), b[name](), name);
});
