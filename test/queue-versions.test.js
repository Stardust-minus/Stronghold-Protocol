// test/queue-versions.test.js — one matchmaking pool per official version (this fork, the owner 2026-11-15:
// 「大厅可以选择匹配不同版本的，组队匹配就进入对应版本匹配池」; server/matchmaking.js and server/lobby.js header "Matchmaking per
// version"): the pool keys, a lone ticket's `version`, a party from a 规程 room, the isolation of two versions, the versions
// that cannot be queued, the confirm that waits for the version's data, the matched version room, and the cluster's two
// placements. A Lobby over a stub of the version service on the real version data (made-up cs values), as
// test/lobby-versions.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Lobby } from '../server/lobby.js';
import { ClusterLobby } from '../server/cluster/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { getData, getVersionData } from '../server/data.js';
import { DIFFICULTIES, ERR, MATCHMAKING_VERSION, modeIdFor } from '../shared/constants.js';
import { PLAYER_CAPACITY_VERSION } from '../shared/playerCapacity.js';
import { validateC2S } from '../shared/protocol.js';
import { DEFAULT_VERSION, VERSIONS, versionById } from '../shared/versions.js';

const REG = 'act3autochess@V3_1', V1 = 'act1autochess';
const VANILLA = 'a0'.repeat(32);
const CS = { 'act2autochess@V2_1': 'b1'.repeat(32), act1autochess: 'c1'.repeat(32), 'act1autochess@V1_1': 'd1'.repeat(32), [REG]: 'e1'.repeat(32) };
const ALL = VERSIONS.map((v) => v.id);
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** server/versions.js's surface the lobby reads, over the real version data (cs values made up). */
function versionStub({ enabled = ALL, defaultId = REG } = {}) {
  const ids = ALL.filter((id) => enabled.includes(id));
  const csOf = (id) => (!ids.includes(id) ? null : id === DEFAULT_VERSION ? VANILLA : CS[id]);
  const data = (id) => (!ids.includes(id) ? null : id === DEFAULT_VERSION ? getData() : getVersionData(id));
  const official = (id, mode) => (!ids.includes(id) || !versionById(id).roomModes.includes(mode) ? [] : Object.entries(data(id).config.modes)
    .filter(([, m]) => m.type === (mode === 'solo' ? 'SINGLE' : 'MULTI'))
    .map(([mid, m]) => ({ id: mid, type: m.type, difficulty: m.difficulty, name: m.name, code: m.code ?? '', sortId: m.sortId ?? 0 }))
    .sort((a, b) => a.sortId - b.sortId || (a.id < b.id ? -1 : 1)));
  const laddered = (id, mode) => official(id, mode).some((m) => m.id !== modeIdFor(mode, m.difficulty));
  return {
    ids, defaultId, nonDefault: ids.filter((id) => id !== DEFAULT_VERSION),
    isEnabled: (id) => ids.includes(id), csOf,
    content: (id) => (!ids.includes(id) ? null : id === DEFAULT_VERSION
      ? Object.freeze({ cs: VANILLA, vanilla: true, plugins: Object.freeze([]) })
      : Object.freeze({ cs: CS[id], vanilla: true, version: id, plugins: Object.freeze([]) })),
    data, dataOfCs: (cs) => { const id = ids.find((x) => csOf(x) === cs); return id ? data(id) : null; },
    offered: (id, mode) => {
      if (!ids.includes(id) || !versionById(id).roomModes.includes(mode)) return [];
      if (laddered(id, mode)) return DIFFICULTIES.filter((d) => official(id, mode).some((m) => m.difficulty === d));
      return DIFFICULTIES.filter((d) => Object.hasOwn(data(id).config.modes, modeIdFor(mode, d)));
    },
    modesOf: official, laddered,
    welcome: () => ids.map((id) => ({ id, cs: csOf(id), ...(id === defaultId ? { default: true } : {}) })),
  };
}

class Rec {
  static made = [];
  constructor(opts) { this.opts = opts; Rec.made.push(opts); }
  start() {}
  dispose() {} onDisconnect() {} onReconnect() {} onLeave() {}
}

/** Players and the lobby (`Kind`: Lobby, or a ClusterLobby with `extra`; `MatchClass: null` — the lobby's own Match). */
function harness(t, { versions = versionStub(), MatchClass = Rec, versionHosts = null, Kind = Lobby, extra = {} } = {}) {
  const clock = { t: 1_000_000 };
  const registry = new SessionRegistry({ now: () => clock.t });
  const lobby = new Kind({ registry, log: quiet, ...(MatchClass ? { MatchClass } : {}), content: { cs: VANILLA }, getData, versions, versionHosts,
    now: () => clock.t, seedFn: () => 7, options: {}, ...extra });
  t.after(() => lobby.shutdown());
  let n = 0;
  const player = () => {
    const s = registry.create(`Doctor${++n}`);
    s.connected = true; s.disconnectedAt = null; s.limitKey = null;
    s.matchmakingVersion = MATCHMAKING_VERSION; s.playerCapacityVersion = PLAYER_CAPACITY_VERSION;
    s.ws = { readyState: 1, bufferedAmount: 0, send(data, cb) { cb?.(); }, terminate() {} };
    lobby.onHello?.(s, { resumed: false, repeat: false });
    return s;
  };
  const state = (s) => lobby.queue.state(s);
  const lone = (version, difficulty = 'NORMAL', fields = {}) => {
    const p = player();
    ok(lobby.queue.join(p, { difficulty, capacities: [4], rules: ['standard'], ...(version ? { version } : {}), ...fields }));
    return p;
  };
  return { lobby, player, state, lone, clock };
}

const ok = (r) => assert.deepEqual(r, { ok: true });
const refused = (r, code, detail) => {
  assert.equal(r?.error, code, JSON.stringify(r));
  if (detail) assert.equal(r.detail, detail);
};
/** a 规程 party room of `size` humans, every page having reported the room's data ready */
function regParty(h, size, { contentReady = true } = {}) {
  const members = Array.from({ length: size }, () => h.player()), host = members[0];
  ok(h.lobby.create(host, { mode: 'coop', difficulty: 'NORMAL', version: REG }));
  const room = h.lobby.roomOf(host);
  assert.equal(room.version, REG);
  for (const m of members.slice(1)) ok(h.lobby.join(m, { code: room.code }));
  for (const m of members) if (contentReady) ok(h.lobby.contentReady(m, { cs: CS[REG] }));
  for (const m of members.slice(1)) if (contentReady) ok(h.lobby.ready(m, { ready: true }));
  return { members, host, room };
}

test('protocol: queue.join `version` and queue.accept `cs` are optional and checked', () => {
  assert.equal(validateC2S({ t: 'queue.join', difficulty: 'NORMAL', version: REG }), null);
  assert.equal(validateC2S({ t: 'queue.join', difficulty: 'NORMAL' }), null, 'an older page names none');
  assert.equal(typeof validateC2S({ t: 'queue.join', difficulty: 'NORMAL', version: 'Not a version!' }), 'string');
  assert.equal(validateC2S({ t: 'queue.accept', ticketId: 'a', offerId: 'b', cs: CS[REG] }), null);
  assert.equal(validateC2S({ t: 'queue.accept', ticketId: 'a', offerId: 'b' }), null);
  assert.equal(typeof validateC2S({ t: 'queue.accept', ticketId: 'a', offerId: 'b', cs: 'short' }), 'string');
});

test('pool keys: the official version is an axis; a 第二期下半 snapshot keeps its shape, another names its version', (t) => {
  const h = harness(t);
  const reg = h.lone(REG), old = h.lone(undefined), def = h.lone(DEFAULT_VERSION);
  const er = h.lobby.queue.entries.get(reg.playerId), ed = h.lobby.queue.entries.get(def.playerId);
  assert.equal(er.party.versionId, REG);
  assert.equal(h.lobby.queue.entries.get(old.playerId).party.versionId, DEFAULT_VERSION, 'no version: 第二期下半 (an older page)');
  assert.equal(h.lobby.queue.poolKey(er), `${MATCHMAKING_VERSION}:${REG}:NORMAL:4`);
  assert.equal(h.lobby.queue.poolKey(ed), `${MATCHMAKING_VERSION}:${DEFAULT_VERSION}:NORMAL:4`);
  assert.equal(h.state(reg).version, REG);
  assert.equal(Object.hasOwn(h.state(def), 'version'), false);
  assert.equal(h.state(reg).waitingCount, 1, 'its own pool only');
  assert.equal(h.state(def).waitingCount, 2, 'the two 第二期下半 tickets share theirs');
  refused(h.lobby.queue.join(reg, { difficulty: 'NORMAL', capacities: [4], rules: ['standard'], version: DEFAULT_VERSION }), ERR.QUEUED, 'cancel before changing the version');
  ok(h.lobby.queue.join(reg, { difficulty: 'NORMAL', capacities: [4], rules: ['standard'], version: REG }));
});

test('isolation: two versions\' tickets never meet; four of one version make its offer', (t) => {
  const h = harness(t);
  const regs = [h.lone(REG), h.lone(REG)], defs = [h.lone(DEFAULT_VERSION), h.lone(DEFAULT_VERSION)];
  assert.equal(h.lobby.queue.offers.size, 0, '2 + 2 of two versions: no offer');
  assert.ok([...regs, ...defs].every((p) => h.state(p).state === 'queued'));
  regs.push(h.lone(REG), h.lone(REG));
  assert.equal(h.lobby.queue.offers.size, 1);
  const offer = [...h.lobby.queue.offers.values()][0];
  assert.equal(offer.versionId, REG);
  assert.deepEqual(offer.entries.map((e) => e.session.playerId).sort(), regs.map((p) => p.playerId).sort());
  assert.ok(regs.every((p) => h.state(p).state === 'offered' && h.state(p).version === REG));
  assert.ok(defs.every((p) => h.state(p).state === 'queued'));
});

test('a lone 规程 offer: the confirm waits for the version\'s data; the matched room is a 规程 version room, ready to run', (t) => {
  Rec.made.length = 0;
  const h = harness(t);
  const people = [h.lone(REG), h.lone(REG), h.lone(REG), h.lone(REG)];
  const s0 = h.state(people[0]);
  refused(h.lobby.queue.accept(people[0], { ticketId: s0.ticketId, offerId: s0.offerId }), ERR.CONTENT_NOT_READY);
  refused(h.lobby.queue.accept(people[0], { ticketId: s0.ticketId, offerId: s0.offerId, cs: CS[V1] }), ERR.CONTENT_NOT_READY, undefined);
  assert.equal(h.state(people[0]).accepted, false, 'not counted');
  for (const p of people) { const s = h.state(p); ok(h.lobby.queue.accept(p, { ticketId: s.ticketId, offerId: s.offerId, cs: CS[REG] })); }
  const room = h.lobby.roomOf(people[0]);
  assert.ok(room, 'matched');
  assert.equal(room.source, 'matchmaking');
  assert.equal(room.version, REG);
  assert.equal(room.content.cs, CS[REG]);
  assert.equal(room.needsContent, true);
  assert.ok(room.seats.filter(Boolean).every((s) => s.content === 'ready' && s.ready === true));
  assert.equal(Rec.made.length, 1);
  const opts = Rec.made[0];
  assert.equal(opts.version, REG);
  assert.equal(opts.requireCs, true);
  assert.equal(opts.cs, CS[REG]);
  assert.equal(opts.modeId, 'mode_multi_normal', '规程\'s co-op keeps one official mode per difficulty');
  assert.equal(h.state(people[3]).state, 'matched');
  assert.equal(h.state(people[3]).version, REG);
});

test('a default lone offer is exactly as before: no cs needed, a room of 第二期下半 without content', (t) => {
  Rec.made.length = 0;
  const h = harness(t);
  const people = Array.from({ length: 4 }, () => h.lone(DEFAULT_VERSION));
  for (const p of people) ok(h.lobby.queue.accept(p, h.state(p)));
  const room = h.lobby.roomOf(people[0]);
  assert.equal(room.version, DEFAULT_VERSION);
  assert.equal(room.content, null);
  assert.equal(Object.hasOwn(Rec.made[0], 'version'), false);
});

test('a party from a 规程 room waits in the 规程 pool; its pages\' data counts for the confirm', (t) => {
  Rec.made.length = 0;
  const h = harness(t);
  const { members, host, room } = regParty(h, 2);
  ok(h.lobby.queue.join(host, { difficulty: 'NORMAL', party: true }));
  assert.equal(h.state(host).version, REG);
  assert.equal(h.lobby.queue.entries.get(host.playerId).party.versionId, REG);
  // while it waits the room keeps its version and mode
  refused(h.lobby.proposeVersion(host, { version: DEFAULT_VERSION }), ERR.QUEUED);
  refused(h.lobby.setMode(host, { modeId: 'mode_multi_hard' }), ERR.QUEUED);
  const loners = [h.lone(DEFAULT_VERSION), h.lone(DEFAULT_VERSION)];
  assert.equal(h.lobby.queue.offers.size, 0, 'two 第二期下半 tickets do not fill a 规程 party');
  loners.push(h.lone(REG), h.lone(REG));
  const offer = [...h.lobby.queue.offers.values()][0];
  assert.equal(offer.versionId, REG);
  // the party's members confirm on their seats' report; the lone ones with the cs
  for (const m of members) ok(h.lobby.queue.accept(m, h.state(m)));
  for (const p of loners.slice(2)) { const s = h.state(p); ok(h.lobby.queue.accept(p, { ...s, cs: CS[REG] })); }
  const matched = h.lobby.roomOf(host);
  assert.notEqual(matched, room);
  assert.equal(matched.version, REG);
  assert.equal(matched.seats.filter(Boolean).length, 4);
  assert.equal(Rec.made.at(-1).version, REG);
  assert.ok(loners.slice(0, 2).every((p) => h.state(p).state === 'queued'));
});

test('party refusals: a seat still loading the data, a different named version, gameplay plugins', (t) => {
  const h = harness(t);
  const { host, members } = regParty(h, 2, { contentReady: false });
  // the guest could not even ready before its data; the host alone loaded it
  ok(h.lobby.contentReady(host, { cs: CS[REG] }));
  refused(h.lobby.queue.join(host, { difficulty: 'NORMAL', party: true }), ERR.NOT_READY);
  ok(h.lobby.contentReady(members[1], { cs: CS[REG] }));
  ok(h.lobby.ready(members[1], { ready: true }));
  const room = h.lobby.roomOf(host);
  room.seatOf(members[1].playerId).content = null; // a page that reloaded after readying
  refused(h.lobby.queue.join(host, { difficulty: 'NORMAL', party: true }), ERR.CONTENT_NOT_READY);
  room.seatOf(members[1].playerId).content = 'ready';
  refused(h.lobby.queue.join(host, { difficulty: 'NORMAL', party: true, version: DEFAULT_VERSION }), ERR.BAD_MSG, 'a party queues in its room\'s version');
  const content = room.content;
  room.content = Object.freeze({ cs: 'f0'.repeat(32), vanilla: false, version: REG, plugins: Object.freeze([]) });
  refused(h.lobby.queue.join(host, { difficulty: 'NORMAL', party: true }), ERR.BAD_TARGET, 'a room with gameplay plugins cannot enter matchmaking');
  room.content = content;
  ok(h.lobby.queue.join(host, { difficulty: 'NORMAL', party: true, version: REG }));
  // gameplay plugins switched on while it waits: the ticket is stale and goes
  room.content = Object.freeze({ cs: 'f0'.repeat(32), vanilla: false, version: REG, plugins: Object.freeze([]) });
  h.lobby.queue.sweep();
  assert.equal(h.lobby.queue.has(host), false);
});

test('versions that cannot be queued: not enabled, a missing difficulty, no match host (welcome says so)', (t) => {
  const narrowed = harness(t, { versions: versionStub({ enabled: [DEFAULT_VERSION, REG] }) });
  refused(narrowed.lobby.queue.join(narrowed.player(), { difficulty: 'NORMAL', version: V1 }), ERR.VERSION_UNKNOWN);
  refused(narrowed.lobby.queue.join(narrowed.player(), { difficulty: 'NORMAL', version: 'act9autochess' }), ERR.VERSION_UNKNOWN);
  assert.equal(narrowed.lobby.welcomeInfo().versions.some((v) => Object.hasOwn(v, 'queue')), false, 'a test MatchClass runs them: all queueable');
  const all = harness(t);
  refused(all.lobby.queue.join(all.player(), { difficulty: 'ABYSS', version: V1 }), ERR.BAD_TARGET, 'not a mode of this version');
  refused(all.lobby.queue.join(all.player(), { difficulty: 'HARD', difficulties: ['HARD', 'ABYSS'], version: V1 }), ERR.BAD_TARGET);
  ok(all.lobby.queue.join(all.player(), { difficulty: 'HARD', version: V1 }));
  // the real Match class and no version hosts: nothing here runs another version's match
  const hostless = harness(t, { MatchClass: null });
  refused(hostless.lobby.queue.join(hostless.player(), { difficulty: 'NORMAL', version: REG }), ERR.VERSION_UNSUPPORTED, 'no match host for this version');
  ok(hostless.lobby.queue.join(hostless.player(), { difficulty: 'NORMAL', version: DEFAULT_VERSION }));
  const marks = Object.fromEntries(hostless.lobby.welcomeInfo().versions.map((v) => [v.id, v.queue]));
  assert.equal(marks[DEFAULT_VERSION], undefined);
  assert.equal(marks[REG], false);
  // a server without 第二期下半 refuses an older page's ticket (it names no version)
  const noDefault = harness(t, { versions: versionStub({ enabled: [REG] }) });
  refused(noDefault.lobby.queue.join(noDefault.player(), { difficulty: 'NORMAL' }), ERR.VERSION_UNKNOWN);
});

/** A game-node platform that records what it is asked to place. */
function fakePlatform(calls) {
  return {
    build: 'synthetic-build', protocol: 1,
    prepare(spec, context) {
      calls.push({ spec: structuredClone(spec), context });
      return Promise.resolve({ assignmentId: spec.assignmentId, nodeId: 'synthetic-node', generation: 'synthetic-generation',
        commit: () => ({ ownerAvailable: true }), publish: () => true, abort: () => Promise.resolve(true) });
    },
    resume: () => true, peer: () => Promise.resolve({ ok: true }), deliverEnd: () => true, release: () => Promise.resolve(true),
  };
}
class ForbiddenLocalMatch { constructor() { throw new Error('local simulation forbidden in the cluster fixture'); } }
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };

test('cluster: a 规程 offer is placed on a game node in its version (versionPlacement node)', async (t) => {
  const calls = [];
  const h = harness(t, { Kind: ClusterLobby, MatchClass: ForbiddenLocalMatch, extra: { platform: fakePlatform(calls), versionPlacement: 'node' } });
  const people = [h.lone(REG), h.lone(REG), h.lone(REG), h.lone(REG)];
  const defs = [h.lone(DEFAULT_VERSION)];
  for (const p of people) { const s = h.state(p); ok(h.lobby.queue.accept(p, { ...s, cs: CS[REG] })); }
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].spec.version, REG);
  assert.equal(calls[0].spec.seats.length, 4);
  const room = h.lobby.roomOf(people[0]);
  assert.equal(room.version, REG);
  assert.equal(room.content.cs, CS[REG]);
  assert.ok(room.match);
  assert.ok(people.every((p) => h.state(p).state === 'matched'));
  assert.equal(h.state(defs[0]).state, 'queued');
});

test('cluster: with versionPlacement coordinator a 规程 offer runs in this process\'s version host, no node is asked', async (t) => {
  const calls = [], made = [];
  const versionHosts = {
    create(cs, opts) { made.push({ cs, opts }); return { hosted: true, start() {}, dispose() {}, onDisconnect() {}, onReconnect() {}, onLeave() {} }; },
  };
  const h = harness(t, { Kind: ClusterLobby, MatchClass: ForbiddenLocalMatch, versionHosts,
    extra: { platform: fakePlatform(calls), versionPlacement: 'coordinator' } });
  const people = [h.lone(REG), h.lone(REG), h.lone(REG), h.lone(REG)];
  for (const p of people) { const s = h.state(p); ok(h.lobby.queue.accept(p, { ...s, cs: CS[REG] })); }
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(made.length, 1);
  assert.equal(made[0].cs, CS[REG]);
  assert.equal(made[0].opts.version, REG);
  assert.equal(h.lobby.roomOf(people[0]).version, REG);
  assert.ok(people.every((p) => h.state(p).state === 'matched'));
});
