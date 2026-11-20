// A lone ticket's own experimental options (the owner, 2026-11-16: 「匹配玩家也支持调整实验性功能，然后带着这个实验性功能配置
// 进入匹配」; server/matchmaking.js header): queue.join { rules: […, 'custom'], experimental } waits with those options and
// meets only tickets / parties of the same ones, or lone tickets that take any changed rules ('experimental'); the offer
// plays them, 确认入场 shows them (queue.state experimental / config). Someone leaving 确认入场 (the owner, 2026-11-16:
// 「有人主动退出时，未确认的人也保留原排队位置回到队列……超时没确认的人仍然踢出」): the leaver's party leaves, everyone else —
// confirmed or not, a lone ticket of standard rules, of its own options or of any changed rules, a friend party — waits
// again in its place; a confirmation timeout still drops the unconfirmed. Local and cluster (ClusterLobby: the game-node
// prepare path) alike.
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
/** queue.state.config holds these options (canonical: the same fields) */
const sameConfig = (config, options) => !!config && experimentalKey(config) === experimentalKey(options);

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

test('卡池静态初始化 (§37.272): only tickets that bring it meet, the room and the match get it', (t) => {
  const f = fixture(t), SPLIT = rules({ staticPoolSplit: true }), BOTH = rules({ staticPoolSplit: true, revivalEnabled: true });
  const others = [f.own(REVIVE), f.own(BOTH), f.own(REVIVE), f.lone({ rules: ['standard'] })];
  const same = [f.own(SPLIT), f.own(SPLIT), f.own(SPLIT)];
  assert.equal(f.queue.offers.size, 0, 'configs must match exactly');
  const last = f.own(SPLIT);
  const group = [...same, last];
  assert.ok(f.offered(group));
  assert.deepEqual(f.state(last).experimental, SPLIT);
  assert.ok(others.every((p) => f.state(p).state === 'queued'));
  for (const p of group) assert.deepEqual(f.queue.accept(p, f.state(p)), { ok: true });
  assert.deepEqual(f.lobby.roomOf(last).experimental, SPLIT);
  assert.deepEqual(RecordingMatch.made.at(-1).experimental, SPLIT);
  assert.equal(queueOptions(rules({ staticPoolSplit: true, disableSharedPool: true })).staticPoolSplit, undefined, 'under 禁用共享卡池 nothing to deal');
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

/** Each of `list` waits again in its place after a broken offer: its ticket, sequence, joinedAt and expiresAt (`before`). */
function waitsAgain(f, list, before, reason = 'peer_cancelled') {
  for (const [i, p] of list.entries()) {
    const s = f.state(p), e = f.queue.entries.get(p.playerId);
    assert.equal(s.state, 'queued', `${i} queued`);
    assert.equal(s.reason, reason, `${i} reason`);
    for (const key of ['ticketId', 'sequence', 'joinedAt', 'expiresAt']) assert.equal(e[key], before[i][key], `${i} ${key}`);
    assert.equal(e.accepted, false);
  }
}
const saved = (f, list) => list.map((p) => ({ ...f.queue.entries.get(p.playerId) }));

// 退出本次匹配 before everyone confirmed, one test per kind of the doctors left behind
const LEAVE_CASES = {
  // 标准规则: four lone standard tickets; the next standard ticket completes the game again
  standard: (f) => {
    const list = Array.from({ length: 4 }, () => f.lone({ rules: ['standard'] }));
    return { list, confirms: list[0], leaves: list[1], next: () => f.lone({ rules: ['standard'] }), plays: rules() };
  },
  // 我的实验性: the same options only — another set never fills the place, the same does
  own: (f) => {
    const list = Array.from({ length: 4 }, () => f.own(HP2));
    return { list, confirms: list[0], leaves: list[1], plays: HP2,
      next: () => { const other = f.own(REVIVE); assert.equal(f.state(other).state, 'queued', 'other options never meet them'); return f.own(HP2); } };
  },
  // 任意实验性: the one who brought the options leaves; the rest wait (alone they make no game) and take the next options
  any: (f) => {
    const bringer = f.own(HP2), list = [bringer, ...Array.from({ length: 3 }, () => f.lone({ rules: ['experimental'] }))];
    return { list, confirms: list[1], leaves: bringer, plays: REVIVE, next: () => { assert.equal(f.queue.offers.size, 0, 'no options to play by'); return f.own(REVIVE); } };
  },
  // 好友小队: an unconfirmed party waits again as one, with its room
  party: (f) => {
    const members = f.party(2, { enemyHpMul: 2 }), mine = f.own(HP2), any = f.lone({ rules: ['experimental'] });
    return { list: [...members, mine, any], confirms: mine, leaves: any, plays: HP2, members, next: () => f.lone({ rules: ['experimental'] }) };
  },
};
for (const [kind, make] of Object.entries(LEAVE_CASES)) test(`someone leaves 确认入场 (${kind}): the leaver's ticket ends, everyone else waits again in place, confirmed or not`, (t) => {
  const f = fixture(t), c = make(f);
  assert.ok(f.offered(c.list));
  const offers = c.list.map(f.state), stay = c.list.filter((p) => p !== c.leaves), before = saved(f, stay);
  assert.deepEqual(f.queue.accept(c.confirms, f.state(c.confirms)), { ok: true });
  assert.deepEqual(f.queue.cancel(c.leaves, f.state(c.leaves)), { ok: true }, '退出本次匹配 after looking at the options');
  assert.equal(f.state(c.leaves).state, 'idle');
  assert.equal(c.leaves.messages.filter((m) => m.t === 'queue.state').at(-1).reason, 'cancelled');
  assert.equal(f.queue.has(c.leaves), false);
  waitsAgain(f, stay, before);
  for (const p of stay) {
    assert.equal(p.messages.filter((m) => m.t === 'queue.state').at(-1).reason, 'peer_cancelled');
    assert.equal(f.queue.accept(p, offers[c.list.indexOf(p)]).error, ERR.BAD_TARGET, 'the broken offer cannot be confirmed');
  }
  if (kind === 'own') assert.ok(stay.every((p) => sameConfig(f.state(p).config, HP2)), 'own options kept');
  if (c.members) {
    const room = f.lobby.roomOf(c.members[0]);
    assert.ok(room && room.match === null && !room.disposed);
    assert.ok(c.members.every((p) => f.lobby.roomOf(p) === room && f.state(p).partySize === 2));
    assert.equal(f.lobby.roomQueued(room), true);
  }
  assert.equal(f.lobby.rooms.size, c.members ? 1 : 0);
  const newcomer = c.next();
  const group = [...stay, newcomer];
  assert.ok(f.offered(group), 'the survivors and the newcomer');
  for (const p of group) assert.deepEqual(f.state(p).experimental, c.plays);
  for (const p of group) assert.deepEqual(f.queue.accept(p, f.state(p)), { ok: true });
  assert.ok(group.every((p) => f.state(p).state === 'matched'));
  assert.deepEqual(RecordingMatch.made.at(-1).experimental, c.plays);
});

test('a confirmation timeout still drops whoever had not confirmed; the confirmed wait again', (t) => {
  const f = fixture(t);
  const members = f.party(2, { enemyHpMul: 2 }), mine = f.own(HP2), any = f.lone({ rules: ['experimental'] });
  assert.ok(f.offered([...members, mine, any]));
  const before = saved(f, [mine]);
  assert.deepEqual(f.queue.accept(mine, f.state(mine)), { ok: true });
  assert.deepEqual(f.queue.accept(members[0], f.state(members[0])), { ok: true }, 'the party only half confirmed');
  f.advance(29_999); f.queue.sweep();
  assert.ok([...members, mine, any].every((p) => f.state(p).state === 'offered'));
  f.advance(1); f.queue.sweep();
  waitsAgain(f, [mine], before, 'confirmation_timeout');
  assert.ok(sameConfig(f.state(mine).config, HP2));
  for (const p of [...members, any]) {
    assert.equal(f.state(p).state, 'idle');
    assert.equal(p.messages.filter((m) => m.t === 'queue.state').at(-1).reason, 'confirmation_timeout');
  }
  const room = f.lobby.roomOf(members[0]);
  assert.ok(room && !room.disposed && room.match === null, 'the party is back in its room');
  assert.equal(f.lobby.roomQueued(room), false);
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

/** A ClusterLobby whose game-node platform records every prepare (the game-node path of a matchmade room). */
function clusterFixture(t) {
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
  let count = 0;
  const player = () => {
    const s = registry.create(`ClusterOwn${++count}`); s.messages = []; s.connected = true; s.limitKey = null;
    s.matchmakingVersion = MATCHMAKING_VERSION; s.playerCapacityVersion = PLAYER_CAPACITY_VERSION;
    s.ws = { readyState: 1, bufferedAmount: 0, send(data, cb) { s.messages.push(JSON.parse(data)); cb?.(); } };
    lobby.onHello(s, { resumed: false, repeat: false });
    return s;
  };
  const join = (fields) => { const p = player(); assert.deepEqual(lobby.queue.join(p, { difficulty: 'NORMAL', capacities: [4], ...fields }), { ok: true }); return p; };
  const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); await new Promise((resolve) => setImmediate(resolve)); };
  return { lobby, queue: lobby.queue, calls, player, join, settle, state: (p) => lobby.queue.state(p), advance: (ms) => { clock.time += ms; } };
}

test('cluster: four tickets of the same options start on a game node with them', async (t) => {
  const f = clusterFixture(t), { lobby, calls } = f;
  const opts = rules({ enemyHpMul: 2, enemyAtkMul: 1.5, uniteHumansFirst: true });
  const stray = f.join({ rules: ['custom'], experimental: REVIVE });
  const people = [0, 1, 2, 3].map((i) => f.join(i === 3 ? { rules: ['experimental'] } : { rules: ['custom'], experimental: opts }));
  assert.ok(people.every((p) => f.state(p).state === 'offered'));
  assert.equal(f.state(stray).state, 'queued');
  for (const p of people) assert.deepEqual(lobby.queue.accept(p, f.state(p)), { ok: true });
  await f.settle();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].spec.experimental, opts);
  const room = lobby.roomOf(people[0]);
  assert.deepEqual(room.experimental, opts);
  assert.ok(room.match);
  assert.ok(people.every((p) => f.state(p).state === 'matched'));
  assert.deepEqual(f.state(people[3]).experimental, opts);
});

test('cluster: someone leaves 确认入场, the unconfirmed wait again in place; a timeout drops the unconfirmed; the next offer starts on a game node', async (t) => {
  const f = clusterFixture(t), { lobby, calls } = f;
  const opts = rules({ enemyHpMul: 2, enemyAtkMul: 1.5, uniteHumansFirst: true });
  const mine = [0, 1, 2].map(() => f.join({ rules: ['custom'], experimental: opts }));
  const any = f.join({ rules: ['experimental'] });
  assert.ok([...mine, any].every((p) => f.state(p).state === 'offered'));
  const before = mine.map((p) => ({ ...lobby.queue.entries.get(p.playerId) }));
  assert.deepEqual(lobby.queue.accept(mine[0], f.state(mine[0])), { ok: true });
  assert.deepEqual(lobby.queue.cancel(any, f.state(any)), { ok: true });
  assert.equal(f.state(any).state, 'idle');
  for (const [i, p] of mine.entries()) {
    const s = f.state(p), e = lobby.queue.entries.get(p.playerId);
    assert.equal(s.state, 'queued'); assert.equal(s.reason, 'peer_cancelled');
    for (const key of ['ticketId', 'sequence', 'joinedAt', 'expiresAt']) assert.equal(e[key], before[i][key], `${i} ${key}`);
    assert.ok(sameConfig(s.config, opts));
  }
  // a second offer: one of them lets the time run out
  const late = f.join({ rules: ['experimental'] });
  const second = [...mine, late];
  const offerId = f.state(mine[0]).offerId;
  assert.ok(offerId && second.every((p) => f.state(p).offerId === offerId));
  for (const p of [mine[0], mine[1], late]) assert.deepEqual(lobby.queue.accept(p, f.state(p)), { ok: true });
  f.advance(30_000); lobby.queue.sweep();
  assert.equal(f.state(mine[2]).state, 'idle');
  assert.equal(mine[2].messages.filter((m) => m.t === 'queue.state').at(-1).reason, 'confirmation_timeout');
  for (const p of [mine[0], mine[1], late]) { assert.equal(f.state(p).state, 'queued'); assert.equal(f.state(p).reason, 'confirmation_timeout'); }
  await f.settle();
  assert.equal(calls.length, 0, 'no broken offer reached a game node');
  // the third fills and starts with the options
  const last = f.join({ rules: ['custom'], experimental: opts });
  const third = [mine[0], mine[1], late, last];
  for (const p of third) assert.deepEqual(lobby.queue.accept(p, f.state(p)), { ok: true });
  await f.settle();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].spec.experimental, opts);
  assert.ok(third.every((p) => f.state(p).state === 'matched'));
  assert.ok(lobby.roomOf(mine[0]).match);
});
