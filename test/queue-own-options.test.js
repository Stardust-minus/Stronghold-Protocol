// A lone ticket's own experimental options (the owner, 2026-11-16: 「匹配玩家也支持调整实验性功能，然后带着这个实验性功能配置
// 进入匹配」; server/matchmaking.js header): queue.join { rules: […, 'custom'], experimental } waits with those options and
// meets only tickets / parties of the same ones, or lone tickets that take any changed rules ('experimental'); the offer
// plays them, 确认入场 shows them (queue.state experimental / config), a decline follows the existing rules. Local and
// cluster (ClusterLobby: the game-node prepare path) alike.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { ClusterLobby } from '../server/cluster/lobby.js';
import { ASKED_RULES } from '../server/matchmaking.js';
import { SessionRegistry } from '../server/net.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';
import { EXPERIMENTAL_GROUPS, QUEUE_OPTION_KEYS, experimentalGroupOf, experimentalKey, queueOptions, queueOptionsAt } from '../shared/experimental.js';
import { PLAYER_CAPACITY_VERSION } from '../shared/playerCapacity.js';
import { validateC2S } from '../shared/protocol.js';

const MULTI = [8, 12, 16, 20];
const rules = (o = {}) => ({ revivalEnabled: false, disableSharedPool: false, ...o });
const REVIVE = rules({ revivalEnabled: true }), HP2 = rules({ enemyHpMul: 2 });

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
    const s = registry.create(`Own${++count}`); s.connected = true; s.messages = [];
    s.playerCapacityVersion = PLAYER_CAPACITY_VERSION; s.matchmakingVersion = MATCHMAKING_VERSION;
    s.ws = { readyState: 1, bufferedAmount: 0, send(raw, cb) { s.messages.push(JSON.parse(raw)); cb?.(); } };
    return s;
  };
  const queue = lobby.queue;
  const join = (p, fields) => queue.join(p, { difficulty: 'NORMAL', capacities: [4], ...fields });
  const lone = (fields) => { const p = player(); assert.deepEqual(join(p, fields), { ok: true }); return p; };
  const own = (experimental, extra = []) => lone({ rules: ['custom', ...extra], experimental });
  const party = (size, extra = {}) => {
    const members = Array.from({ length: size }, player), host = members[0];
    assert.deepEqual(lobby.create(host, { mode: 'coop', difficulty: 'NORMAL', experimental: rules(extra) }), { ok: true });
    const room = lobby.roomOf(host);
    for (const member of members.slice(1)) {
      assert.deepEqual(lobby.join(member, { code: room.code }), { ok: true });
      assert.deepEqual(lobby.ready(member, { ready: true }), { ok: true });
    }
    assert.deepEqual(queue.join(host, { difficulty: 'NORMAL', party: true }), { ok: true });
    return members;
  };
  const state = (s) => queue.state(s);
  const offered = (list) => { const id = state(list[0]).offerId; return !!id && list.every((p) => state(p).offerId === id); };
  return { lobby, queue, player, join, lone, own, party, state, offered, advance: (ms) => { clock += ms; } };
}

test('the groups hold every option once; a ticket may bring the rules of the game only', () => {
  const keys = EXPERIMENTAL_GROUPS.flatMap((g) => g.keys);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(EXPERIMENTAL_GROUPS.map((g) => g.id), ['seats', 'team', 'bonds', 'enemy', 'pools', 'special']);
  for (const key of ['revivalEnabled', 'disableSharedPool', 'playerCapacity', 'disableDuckLord', 'disableLayerCap', 'disableHitLimit', 'enemyHpMul', 'enemyHpPlan',
    'enemyAtkMul', 'poolPlan', 'collabOps', 'console', 'uniteHumansFirst']) assert.ok(experimentalGroupOf(key), key);
  assert.ok(QUEUE_OPTION_KEYS.every((k) => keys.includes(k)));
  for (const bad of [rules({ playerCapacity: 8 }), rules({ poolPlan: [0, 0, 1, 1] }), rules({ collabOps: true }), rules({ console: true }), { revivalEnabled: true }, rules({ odd: 1 })]) {
    assert.equal(queueOptions(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(queueOptions(rules({ disableDuckLord: true, enemyHpMul: 1 })), rules({ disableDuckLord: true }), 'kept as asked, ×1 dropped');
  assert.deepEqual(queueOptionsAt(queueOptions(rules({ disableDuckLord: true })), 4), rules(), '禁用鸭爵策略 counts above four seats only');
  assert.equal(experimentalKey(queueOptionsAt(queueOptions(rules({ disableDuckLord: true, revivalEnabled: true })), 8)), '10:8:duck');
  assert.ok(Object.isFrozen(queueOptions(REVIVE)));
});

test('protocol: the options come with the rule \'custom\', and \'custom\' only with them', () => {
  const check = (m) => validateC2S({ t: 'queue.join', difficulty: 'NORMAL', ...m });
  for (const good of [{ rules: ['custom'], experimental: REVIVE }, { rules: ['standard', 'custom', 'experimental'], experimental: HP2 }, { rules: ['experimental'] }]) {
    assert.equal(check(good), null, JSON.stringify(good));
  }
  for (const bad of [{ experimental: REVIVE }, { rules: ['custom'] }, { rules: ['standard'], experimental: REVIVE }, { rules: ['custom'], experimental: rules({ console: true }) },
    { rules: ['custom'], experimental: rules({ playerCapacity: 8 }) }, { rules: ['custom', 'custom'], experimental: REVIVE }]) {
    assert.equal(typeof check(bad), 'string', JSON.stringify(bad));
  }
  assert.ok(validateC2S({ t: 'queue.accept', ticketId: 'ticket', offerId: 'offer', experimental: REVIVE }), 'an accept never carries options');
});

test('join: checked again by the server; a party\'s room owns its rules; options must count in every size', (t) => {
  const f = fixture(t), p = f.player();
  assert.equal(f.join(p, { rules: ['custom'] }).error, ERR.BAD_MSG);
  assert.equal(f.join(p, { rules: ['standard'], experimental: REVIVE }).error, ERR.BAD_MSG);
  assert.equal(f.join(p, { rules: ['custom'], experimental: rules({ collabOps: true }) }).error, ERR.BAD_MSG);
  assert.equal(f.join(p, { rules: ['custom'], experimental: rules({ disableDuckLord: true }) }).error, ERR.BAD_MSG, 'nothing at four seats');
  assert.equal(f.join(p, { rules: ['custom'], experimental: rules({ disableDuckLord: true }), capacities: [4, 8] }).error, ERR.BAD_MSG);
  assert.deepEqual(f.join(p, { rules: ['custom'], experimental: rules({ disableDuckLord: true }), capacities: MULTI }), { ok: true });
  const host = f.party(1)[0];
  f.queue.cancel(host, f.state(host));
  assert.equal(f.queue.join(host, { difficulty: 'NORMAL', party: true, rules: ['custom'], experimental: REVIVE }).error, ERR.BAD_MSG);
  assert.equal(f.queue.join(host, { difficulty: 'NORMAL', party: true, experimental: REVIVE }).error, ERR.BAD_MSG);
});

test('the snapshot names what was asked and the options; a repeat join keeps the ticket, a change needs a cancel', (t) => {
  const f = fixture(t), a = f.own(REVIVE, ['standard']);
  const s = f.state(a);
  assert.deepEqual(s.rules, ['standard', 'custom']);
  assert.deepEqual(s.config, REVIVE);
  assert.deepEqual(f.join(a, { rules: ['standard', 'custom'], experimental: { ...REVIVE } }), { ok: true });
  assert.equal(f.state(a).ticketId, s.ticketId);
  assert.equal(f.join(a, { rules: ['standard', 'custom'], experimental: HP2 }).error, ERR.QUEUED);
  assert.equal(f.join(a, { rules: ['custom'], experimental: REVIVE }).error, ERR.QUEUED);
  const plain = f.lone({ rules: ['standard'] });
  assert.equal(Object.hasOwn(f.state(plain), 'config'), false, 'a ticket without options keeps its shape');
  assert.deepEqual(f.state(plain).rules, ['standard']);
});

test('four tickets of the same options make a game of them; other options, standard tickets never meet them', (t) => {
  const f = fixture(t);
  const others = [f.own(HP2), f.lone({ rules: ['standard'] }), f.own(rules({ revivalEnabled: true, enemyAtkMul: 2 }))];
  const same = [f.own(REVIVE), f.own({ ...REVIVE }), f.own(REVIVE)];
  assert.equal(f.queue.offers.size, 0);
  const last = f.own(rules({ revivalEnabled: true, disableSharedPool: false }));
  const group = [...same, last];
  assert.ok(f.offered(group));
  const offer = f.state(last);
  assert.deepEqual(offer.experimental, REVIVE);
  assert.deepEqual(offer.config, REVIVE, 'the page compares its own with the offer\'s');
  assert.ok(others.every((p) => f.state(p).state === 'queued'));
  for (const p of group) assert.deepEqual(f.queue.accept(p, f.state(p)), { ok: true });
  const room = f.lobby.roomOf(last);
  assert.deepEqual(room.experimental, REVIVE);
  assert.equal(room.source, 'matchmaking');
  assert.deepEqual(RecordingMatch.made.at(-1).experimental, REVIVE);
  assert.ok(group.every((p) => f.state(p).state === 'matched'));
});

test('tickets taking any changed rules fill a game of someone\'s options; alone they never make one', (t) => {
  const f = fixture(t);
  const any = [f.lone({ rules: ['experimental'] }), f.lone({ rules: ['experimental'] }), f.lone({ rules: ['standard', 'experimental'] }), f.lone({ rules: ['experimental'] })];
  assert.equal(f.queue.offers.size, 0, 'no options to play by');
  const mine = f.own(HP2);
  const offer = f.state(mine);
  assert.equal(offer.state, 'offered');
  assert.deepEqual(offer.experimental, HP2);
  const taken = any.filter((p) => f.state(p).offerId === offer.offerId);
  assert.equal(taken.length, 3);
  assert.deepEqual(f.state(taken[0]).experimental, HP2, 'the others see the options before they confirm');
  assert.equal(Object.hasOwn(f.state(taken[0]), 'config'), false);
});

test('a ticket of options and wildcards: its options with the same, a standard game with standard tickets, any changed rules with \'experimental\'', (t) => {
  const f = fixture(t);
  const std = [f.lone({ rules: ['standard'] }), f.lone({ rules: ['standard'] }), f.lone({ rules: ['standard'] })];
  const both = f.own(REVIVE, ['standard']);
  assert.ok(f.offered([...std, both]));
  assert.deepEqual(f.state(both).experimental, rules(), 'a standard game');
  const g = fixture(t);
  const party = g.party(3, { enemyHpMul: 2 });
  const wild = g.own(REVIVE, ['experimental']);
  assert.ok(g.offered([...party, wild]));
  assert.deepEqual(g.state(wild).experimental, HP2, 'the party\'s room options');
  const h = fixture(t);
  h.party(3, { enemyHpMul: 2 });
  const strict = h.own(REVIVE);
  assert.equal(h.state(strict).state, 'queued', 'its own options only: not the party\'s');
});

test('a party of the same options takes lone tickets of them, in FIFO order', (t) => {
  const f = fixture(t);
  const early = f.own(HP2), other = f.own(REVIVE);
  const members = f.party(3, { enemyHpMul: 2 });
  assert.ok(f.offered([...members, early]));
  assert.equal(f.state(other).state, 'queued');
  assert.deepEqual(f.state(early).experimental, HP2);
});

test('expanded pools: the options at the pool\'s size, 禁用鸭爵策略 among them', (t) => {
  const f = fixture(t), duck = rules({ revivalEnabled: true, disableDuckLord: true });
  const list = Array.from({ length: 8 }, () => f.lone({ capacities: MULTI, rules: ['custom'], experimental: duck }));
  assert.ok(f.offered(list));
  const s = f.state(list[0]);
  assert.equal(s.required, 8);
  assert.deepEqual(s.experimental, { ...rules({ revivalEnabled: true }), playerCapacity: 8, disableDuckLord: true });
});

test('declining a game of experimental options: the decliner\'s ticket ends, confirmed others wait again, unconfirmed others leave', (t) => {
  const f = fixture(t);
  const list = [f.own(HP2), f.lone({ rules: ['experimental'] }), f.lone({ rules: ['experimental'] }), f.lone({ rules: ['experimental'] })];
  assert.ok(f.offered(list));
  const offers = list.map(f.state);
  const joinedAt = offers[0].joinedAt;
  assert.deepEqual(f.queue.accept(list[0], offers[0]), { ok: true });
  assert.deepEqual(f.queue.cancel(list[1], offers[1]), { ok: true }, '退出本次匹配 after looking at the options');
  assert.equal(f.state(list[1]).state, 'idle');
  assert.equal(f.state(list[0]).state, 'queued');
  assert.equal(f.state(list[0]).reason, 'peer_cancelled');
  assert.equal(f.state(list[0]).joinedAt, joinedAt, 'its place in the queue kept');
  assert.deepEqual(f.state(list[0]).config, HP2);
  for (const p of list.slice(2)) {
    assert.equal(f.state(p).state, 'idle');
    assert.equal(p.messages.filter((m) => m.t === 'queue.state').at(-1).reason, 'unconfirmed');
  }
  assert.equal(f.lobby.rooms.size, 0);
});

test('the allocation checks every unit takes the offer\'s options', (t) => {
  const f = fixture(t);
  const list = Array.from({ length: 4 }, () => f.own(REVIVE));
  const offer = f.queue.offers.get(f.state(list[0]).offerId);
  const entry = f.queue.entries.get(list[3].playerId);
  assert.equal(f.queue.takes(entry.party, offer.experimental), true);
  assert.equal(f.queue.takes(entry.party, HP2), false);
  assert.equal(f.queue.takes(entry.party, rules()), false, 'no standard game without \'standard\'');
  entry.party.config = queueOptions(HP2); entry.party.configAt.clear(); // tampered: the lobby refuses the cohort
  for (const p of list.slice(0, 3)) f.queue.accept(p, f.state(p));
  assert.equal(f.queue.accept(list[3], f.state(list[3])).error, ERR.WRONG_PHASE);
  assert.equal(f.lobby.rooms.size, 0);
});

test('welcome names the rules this server takes', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.lobby.welcomeInfo().queueRules, ASKED_RULES);
  assert.deepEqual([...ASKED_RULES], ['standard', 'experimental', 'custom']);
});

test('cluster: four tickets of the same options start on a game node with them', async (t) => {
  const clock = { time: 10_000 }, calls = [];
  const registry = new SessionRegistry({ now: () => clock.time });
  const platform = {
    build: 'synthetic-build', protocol: 1,
    prepare(spec, context) {
      calls.push({ spec: structuredClone(spec), context });
      return Promise.resolve({ assignmentId: spec.assignmentId, nodeId: 'synthetic-node', generation: 'synthetic-generation',
        commit: () => ({ ownerAvailable: true }), publish: () => true, abort: () => Promise.resolve(true) });
    },
    resume: () => true, peer: () => Promise.resolve({ ok: true }), deliverEnd: () => true, release: () => Promise.resolve(true),
  };
  class ForbiddenLocalMatch { constructor() { throw new Error('local simulation forbidden in the cluster fixture'); } }
  const lobby = new ClusterLobby({ registry, platform, options: {}, getData: () => ({}), now: () => clock.time,
    log: { info() {}, warn() {}, error() {}, debug() {} }, seedFn: () => 123456, MatchClass: ForbiddenLocalMatch });
  t.after(() => lobby.shutdown());
  const player = (i) => {
    const s = registry.create(`ClusterOwn${i}`); s.messages = []; s.connected = true; s.limitKey = null;
    s.matchmakingVersion = MATCHMAKING_VERSION; s.playerCapacityVersion = PLAYER_CAPACITY_VERSION;
    s.ws = { readyState: 1, bufferedAmount: 0, send(data, cb) { s.messages.push(JSON.parse(data)); cb?.(); } };
    lobby.onHello(s, { resumed: false, repeat: false });
    return s;
  };
  const opts = rules({ enemyHpMul: 2, enemyAtkMul: 1.5, uniteHumansFirst: true });
  const people = Array.from({ length: 4 }, (_, i) => player(i));
  const stray = player(9);
  assert.deepEqual(lobby.queue.join(stray, { difficulty: 'NORMAL', capacities: [4], rules: ['custom'], experimental: REVIVE }), { ok: true });
  people.forEach((p, i) => assert.deepEqual(lobby.queue.join(p, { difficulty: 'NORMAL', capacities: [4], ...(i === 3 ? { rules: ['experimental'] } : { rules: ['custom'], experimental: opts }) }), { ok: true }));
  assert.ok(people.every((p) => lobby.queue.state(p).state === 'offered'));
  assert.equal(lobby.queue.state(stray).state, 'queued');
  for (const p of people) assert.deepEqual(lobby.queue.accept(p, lobby.queue.state(p)), { ok: true });
  for (let i = 0; i < 40; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].spec.experimental, opts);
  const room = lobby.roomOf(people[0]);
  assert.deepEqual(room.experimental, opts);
  assert.ok(room.match);
  assert.ok(people.every((p) => lobby.queue.state(p).state === 'matched'));
  assert.deepEqual(lobby.queue.state(people[3]).experimental, opts);
});
