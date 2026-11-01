// The scope of a lone ticket (the owner, 2026-11-02): which room sizes it waits for and which rules it takes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { ClusterLobby } from '../server/cluster/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';
import { experimentalRuleChanged } from '../shared/experimental.js';
import { PLAYER_CAPACITY_VERSION, roomCapacity } from '../shared/playerCapacity.js';
import { validateC2S } from '../shared/protocol.js';

const MULTI = [8, 12, 16, 20];
const STANDARD = ['standard'], EXPERIMENTAL = ['experimental'], BOTH = ['standard', 'experimental'];

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
    const s = registry.create(`Scope${++count}`); s.connected = true; s.messages = [];
    s.playerCapacityVersion = PLAYER_CAPACITY_VERSION; s.matchmakingVersion = MATCHMAKING_VERSION;
    s.ws = { readyState: 1, bufferedAmount: 0, send(raw, cb) { s.messages.push(JSON.parse(raw)); cb?.(); } };
    return s;
  };
  const queue = lobby.queue;
  const lone = (fields) => { const p = player(); assert.deepEqual(queue.join(p, { difficulty: 'NORMAL', ...fields }), { ok: true }); return p; };
  /** a room of `size` humans, `capacity` seats, those rules, queued as a party */
  const party = (size, capacity = 4, extra = {}) => {
    const members = Array.from({ length: size }, player), host = members[0];
    const experimental = { revivalEnabled: false, disableSharedPool: false, ...(capacity > 4 ? { playerCapacity: capacity } : {}), ...extra };
    assert.deepEqual(lobby.create(host, { mode: 'coop', difficulty: 'NORMAL', experimental }), { ok: true });
    const room = lobby.roomOf(host);
    for (const member of members.slice(1)) {
      assert.deepEqual(lobby.join(member, { code: room.code }), { ok: true });
      assert.deepEqual(lobby.ready(member, { ready: true }), { ok: true });
    }
    assert.deepEqual(queue.join(host, { difficulty: 'NORMAL', party: true }), { ok: true });
    return members;
  };
  return { lobby, queue, player, lone, party, state: (s) => queue.state(s), advance: (ms) => { clock += ms; } };
}

test('rules: only what changes the game counts, the seat count does not', () => {
  assert.equal(experimentalRuleChanged({ revivalEnabled: false, disableSharedPool: false }), false);
  assert.equal(experimentalRuleChanged({ revivalEnabled: false, disableSharedPool: false, playerCapacity: 12 }), false);
  assert.equal(experimentalRuleChanged({ revivalEnabled: true, disableSharedPool: false }), true);
  assert.equal(experimentalRuleChanged({ revivalEnabled: false, disableSharedPool: false, enemyHpMul: 2 }), true);
  assert.equal(experimentalRuleChanged({ revivalEnabled: false, disableSharedPool: false, playerCapacity: 8, disableDuckLord: true }), true);
  assert.equal(experimentalRuleChanged({ revivalEnabled: false, disableSharedPool: false, poolPlan: [0, 0, 1, 1] }), true, 'any set key: a rule added later counts by itself');
  assert.equal(experimentalRuleChanged(null), false);
});

test('protocol: the scope is optional and checked', () => {
  const check = (m) => validateC2S({ t: 'queue.join', difficulty: 'NORMAL', ...m });
  for (const good of [{}, { capacities: [4] }, { capacities: [4, 8, 12, 16, 20], rules: BOTH }, { rules: EXPERIMENTAL }]) assert.equal(check(good), null, JSON.stringify(good));
  for (const bad of [{ capacities: [] }, { capacities: [5] }, { capacities: [4, 4] }, { capacities: 8 }, { rules: [] }, { rules: ['odd'] }, { rules: ['standard', 'standard'] }, { rules: 'standard' }]) {
    assert.equal(typeof check(bad), 'string', JSON.stringify(bad));
  }
});

test('a ticket asking nothing waits as before: four seats, any rules, the snapshot keeps its old shape', t => {
  const f = fixture(t), a = f.lone({});
  const state = f.state(a);
  assert.equal(state.required, 4);
  assert.equal(Object.hasOwn(state, 'capacities'), false);
  assert.equal(Object.hasOwn(state, 'rules'), false);
  const b = fixture(t), members = b.party(3, 4, { revivalEnabled: true }), old = b.lone({});
  const offered = b.state(old);
  assert.equal(offered.state, 'offered');
  assert.equal(offered.experimental.revivalEnabled, true, 'an older page still follows the room it joins');
  assert.ok(members.every((m) => b.state(m).offerId === offered.offerId));
});

test('a ticket of several sizes counts in each pool once and names them; its counts are per difficulty', t => {
  const f = fixture(t);
  const a = f.lone({ difficulties: ['NORMAL', 'HARD'], capacities: [4, ...MULTI] });
  const b = f.lone({ capacities: MULTI }), c = f.lone({ capacities: [12] });
  const state = f.state(a);
  assert.deepEqual(state.capacities, [4, 8, 12, 16, 20]);
  assert.equal(state.required, 4, 'its smallest size until an offer stands');
  assert.deepEqual(state.waitingCounts, [3, 1], 'NORMAL: 12 seats hold all three; HARD: only the ticket');
  assert.equal(state.waitingCount, 3);
  assert.equal(f.state(c).required, 12);
  assert.equal(Object.hasOwn(f.state(c), 'capacities'), false, 'one size is `required` alone');
  assert.deepEqual(f.state(b).capacities, MULTI);
  assert.equal(f.state(b).required, 8);
  const { counts } = f.queue.waitingPopulation();
  assert.equal(counts.get(`${MATCHMAKING_VERSION}:NORMAL:4`), 1);
  assert.equal(counts.get(`${MATCHMAKING_VERSION}:NORMAL:8`), 2);
  assert.equal(counts.get(`${MATCHMAKING_VERSION}:NORMAL:12`), 3);
  assert.equal(counts.get(`${MATCHMAKING_VERSION}:HARD:8`), 1);
});

test('eight lone tickets make an eight-seat room of ordinary rules: the offer, the room and the match agree', t => {
  RecordingMatch.made.length = 0;
  const f = fixture(t), people = Array.from({ length: 8 }, () => f.lone({ capacities: MULTI, rules: STANDARD }));
  const offer = [...f.queue.offers.values()][0];
  assert.equal(offer.required, 8);
  assert.equal(roomCapacity('coop', offer.experimental), 8);
  assert.deepEqual({ ...offer.experimental }, { revivalEnabled: false, disableSharedPool: false, playerCapacity: 8 });
  const first = f.state(people[0]);
  assert.equal(first.required, 8);
  assert.deepEqual(first.experimental, { revivalEnabled: false, disableSharedPool: false, playerCapacity: 8 });
  for (const p of people) assert.deepEqual(f.queue.accept(p, f.state(p)), { ok: true });
  const room = f.lobby.roomOf(people[0]);
  assert.equal(room.capacity, 8);
  assert.equal(room.source, 'matchmaking');
  assert.equal(room.seats.filter(Boolean).length, 8);
  assert.equal(RecordingMatch.made.length, 1);
  assert.equal(f.state(people[7]).state, 'matched');
  assert.equal(f.state(people[7]).required, 8);
  assert.equal(f.queue.size, 0, 'nobody stays behind in the other pools');
});

test('a broken offer gives the ticket its sizes back', t => {
  const f = fixture(t), people = Array.from({ length: 8 }, () => f.lone({ capacities: MULTI }));
  for (const p of people.slice(0, 7)) assert.deepEqual(f.queue.accept(p, f.state(p)), { ok: true });
  // the one who has not confirmed leaves: the seven who did keep their tickets
  f.queue.remove(people[7], 'cancelled');
  assert.equal(f.queue.offers.size, 0);
  for (const p of people.slice(0, 7)) {
    const state = f.state(p);
    assert.equal(state.state, 'queued');
    assert.equal(state.required, 8);
    assert.deepEqual(state.capacities, MULTI);
    assert.equal(f.queue.entries.get(p.playerId).party.required, 8);
  }
  const eighth = f.lone({ capacities: [16, 8] });
  assert.equal(f.state(eighth).state, 'offered');
  assert.equal(f.state(people[0]).required, 8, 'the same pool forms again');
});

test('a broken offer puts back the smallest size, not the offered one', t => {
  const f = fixture(t), team = f.party(7, 8), loner = f.lone({ capacities: [4, 8] });
  f.queue.accept(loner, f.state(loner));
  assert.equal(f.state(loner).state, 'offered');
  assert.equal(f.state(loner).required, 8);
  assert.equal(f.queue.entries.get(loner.playerId).party.required, 8);
  f.queue.remove(team[0], 'cancelled');
  const back = f.state(loner);
  assert.equal(back.state, 'queued');
  assert.equal(back.required, 4);
  assert.deepEqual(back.capacities, [4, 8]);
});

test('the largest room goes first: a waiting party takes the ticket that also fits a small room', t => {
  const f = fixture(t);
  const a = f.lone({ capacities: [4, 8] }), b = f.lone({ capacities: [4, 8] }), c = f.lone({ capacities: [4, 8] });
  const members = f.party(5, 8);
  assert.equal(f.state(a).state, 'offered');
  assert.equal(f.state(a).required, 8);
  assert.ok([b, c, ...members].every((p) => f.state(p).offerId === f.state(a).offerId));
  const g = fixture(t), lone = Array.from({ length: 4 }, () => g.lone({ capacities: [4, 8] }));
  assert.equal(g.state(lone[0]).required, 4, 'with no large room in reach the small one forms');
  assert.equal(g.queue.offers.size, 1);
});

test('tickets of several sizes and difficulties: nobody is in two offers', t => {
  const f = fixture(t), people = Array.from({ length: 14 }, () => f.lone({ difficulties: ['NORMAL', 'HARD'], capacities: [4, ...MULTI] }));
  const seen = new Set();
  for (const offer of f.queue.offers.values()) {
    assert.equal(offer.entries.length, offer.required);
    for (const e of offer.entries) { assert.equal(seen.has(e.session.playerId), false); seen.add(e.session.playerId); assert.equal(e.party.required, offer.required); }
  }
  assert.ok(seen.size >= 12);
  assert.equal(people.filter((p) => f.state(p).state === 'offered').length, seen.size);
});

test('a standard ticket stays out of a party with changed rules, and the party keeps waiting', t => {
  const f = fixture(t), members = f.party(3, 4, { revivalEnabled: true });
  const plain = f.lone({ rules: STANDARD });
  assert.equal(f.state(plain).state, 'queued');
  assert.equal(f.state(members[0]).state, 'queued');
  assert.deepEqual(f.state(plain).rules, STANDARD);
  const wide = f.lone({ rules: BOTH });
  assert.equal(Object.hasOwn(f.state(wide), 'rules'), false, 'both is the default: omitted');
  assert.equal(f.state(wide).state, 'offered');
  assert.equal(f.state(wide).experimental.revivalEnabled, true);
  assert.equal(f.state(plain).state, 'queued', 'still out of it');
});

test('a standard ticket joins a party of unchanged rules', t => {
  const f = fixture(t), members = f.party(3), plain = f.lone({ rules: STANDARD });
  assert.equal(f.state(plain).state, 'offered');
  assert.equal(f.state(members[0]).state, 'offered');
});

test('experimental tickets alone never make a game: changed rules come from a party', t => {
  const f = fixture(t), people = Array.from({ length: 8 }, () => f.lone({ rules: EXPERIMENTAL }));
  assert.equal(f.queue.offers.size, 0);
  const g = fixture(t), mixed = [g.lone({ rules: EXPERIMENTAL }), g.lone({ rules: BOTH }), g.lone({ rules: BOTH }), g.lone({ rules: BOTH })];
  assert.equal(g.queue.offers.size, 0, 'an experimental ticket does not pull the others into a game without rules');
  const one = g.lone({ rules: BOTH });
  assert.equal(g.queue.offers.size, 1, 'but the others go on without it');
  assert.equal(g.state(mixed[0]).state, 'queued');
  assert.equal(g.state(one).state, 'offered');
  assert.equal(f.state(people[0]).state, 'queued');
  const members = f.party(1, 4, { enemyHpMul: 2 });
  assert.equal(f.state(members[0]).state, 'offered');
  assert.equal(f.state(people[0]).experimental.enemyHpMul, 2);
  assert.equal(f.state(people[2]).state, 'offered');
  assert.equal(f.state(people[3]).state, 'queued', 'three lone seats filled');
});

test('an experimental ticket skips a party of unchanged rules', t => {
  const f = fixture(t), people = Array.from({ length: 3 }, () => f.lone({ rules: EXPERIMENTAL }));
  const members = f.party(1);
  assert.equal(f.state(people[0]).state, 'queued');
  assert.equal(f.state(members[0]).state, 'queued');
});

test('the rules\' party is found behind earlier tickets that alone would have filled the room', t => {
  const f = fixture(t), first = f.lone({ rules: EXPERIMENTAL });
  const others = [f.lone({ rules: EXPERIMENTAL }), f.lone({ rules: EXPERIMENTAL }), f.lone({ rules: EXPERIMENTAL })];
  const members = f.party(1, 4, { disableLayerCap: true });
  assert.equal(f.state(first).state, 'offered');
  assert.equal(f.state(first).experimental.disableLayerCap, true);
  assert.ok(others.slice(0, 2).every((p) => f.state(p).state === 'offered'));
  assert.equal(f.state(others[2]).state, 'queued', 'the party\'s seat comes out of the fourth ticket');
  assert.equal(f.state(members[0]).offerId, f.state(first).offerId);
});

test('a size and a rule together: an expanded party with changed rules takes only tickets of both', t => {
  const f = fixture(t), members = f.party(7, 8, { disableHitLimit: true });
  const noSize = f.lone({ rules: BOTH }), noRule = f.lone({ capacities: MULTI, rules: STANDARD });
  assert.equal(f.state(members[0]).state, 'queued');
  const both = f.lone({ capacities: MULTI, rules: EXPERIMENTAL });
  assert.equal(f.state(both).state, 'offered');
  assert.equal(f.state(both).required, 8);
  assert.equal(f.state(both).experimental.disableHitLimit, true);
  assert.equal(f.state(noSize).state, 'queued');
  assert.equal(f.state(noRule).state, 'queued');
});

test('a party cannot set a scope; a changed scope needs a cancel; an old page cannot wait for a large room', t => {
  const f = fixture(t), host = f.player();
  assert.deepEqual(f.lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' }), { ok: true });
  assert.equal(f.queue.join(host, { difficulty: 'NORMAL', party: true, capacities: [8] }).error, ERR.BAD_MSG);
  assert.equal(f.queue.join(host, { difficulty: 'NORMAL', party: true, rules: BOTH }).error, ERR.BAD_MSG);
  const a = f.lone({ capacities: [4, 8], rules: STANDARD });
  assert.deepEqual(f.queue.join(a, { difficulty: 'NORMAL', capacities: [8, 4], rules: STANDARD }), { ok: true }, 'the same ticket again');
  assert.equal(f.queue.join(a, { difficulty: 'NORMAL', capacities: [8], rules: STANDARD }).error, ERR.QUEUED);
  assert.equal(f.queue.join(a, { difficulty: 'NORMAL', capacities: [4, 8], rules: BOTH }).error, ERR.QUEUED);
  assert.equal(f.queue.join(f.player(), { difficulty: 'NORMAL', capacities: [5] }).error, ERR.BAD_MSG);
  assert.equal(f.queue.join(f.player(), { difficulty: 'NORMAL', rules: ['odd'] }).error, ERR.BAD_MSG);
  const old = f.player(); old.playerCapacityVersion = null;
  assert.equal(f.queue.join(old, { difficulty: 'NORMAL', capacities: [4, 8] }).error, ERR.BAD_MSG);
  assert.deepEqual(f.queue.join(old, { difficulty: 'NORMAL', capacities: [4] }), { ok: true });
});

test('a ticket whose page lost large rooms is dropped, not kept for a room it cannot show', t => {
  const f = fixture(t), a = f.lone({ capacities: [4, 8] });
  a.playerCapacityVersion = null;
  f.queue.sweep();
  assert.equal(f.queue.has(a), false);
});

test('cluster: lone tickets make an eight-seat room through the game-node prepare path', async t => {
  const clock = { time: 10_000 }, calls = [];
  const registry = new SessionRegistry({ now: () => clock.time });
  const platform = {
    build: 'synthetic-build', protocol: 1,
    prepare(spec, context) {
      calls.push({ spec: structuredClone(spec), context });
      const handle = { assignmentId: spec.assignmentId, nodeId: 'synthetic-node', generation: 'synthetic-generation',
        commit: () => ({ ownerAvailable: true }), publish: () => true, abort: () => Promise.resolve(true) };
      return Promise.resolve(handle);
    },
    resume: () => true, peer: () => Promise.resolve({ ok: true }), deliverEnd: () => true, release: () => Promise.resolve(true),
  };
  class ForbiddenLocalMatch { constructor() { throw new Error('local simulation forbidden in the cluster fixture'); } }
  const lobby = new ClusterLobby({ registry, platform, options: {}, getData: () => ({}), now: () => clock.time,
    log: { info() {}, warn() {}, error() {}, debug() {} }, seedFn: () => 123456, MatchClass: ForbiddenLocalMatch });
  t.after(() => lobby.shutdown());
  const player = (i) => {
    const s = registry.create(`Cluster${i}`); s.messages = []; s.connected = true; s.limitKey = null;
    s.matchmakingVersion = MATCHMAKING_VERSION; s.playerCapacityVersion = PLAYER_CAPACITY_VERSION;
    s.ws = { readyState: 1, bufferedAmount: 0, send(data, cb) { s.messages.push(JSON.parse(data)); cb?.(); } };
    lobby.onHello(s, { resumed: false, repeat: false });
    return s;
  };
  const people = Array.from({ length: 8 }, (_, i) => player(i));
  for (const p of people) assert.deepEqual(lobby.queue.join(p, { difficulty: 'NORMAL', capacities: MULTI, rules: STANDARD }), { ok: true });
  for (const p of people) assert.deepEqual(lobby.queue.accept(p, lobby.queue.state(p)), { ok: true });
  for (let i = 0; i < 40; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].spec.seats.length, 8);
  assert.deepEqual(calls[0].spec.experimental, { revivalEnabled: false, disableSharedPool: false, playerCapacity: 8 });
  const room = lobby.roomOf(people[0]);
  assert.equal(room.capacity, 8);
  assert.ok(room.match);
  assert.ok(people.every((p) => lobby.queue.state(p).state === 'matched' && lobby.queue.state(p).required === 8));
});
