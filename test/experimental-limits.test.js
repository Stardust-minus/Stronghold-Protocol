// disableLayerCap / disableHitLimit as room options: optional keys, absent when off; the option set a room, a queue and a
// cluster assignment carry (DESIGN §20.12). The rules themselves: test/match/experimental-limits.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { ClusterLobby } from '../server/cluster/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { ERR, MATCHMAKING_VERSION } from '../shared/constants.js';
import { PLAYER_CAPACITY_VERSION } from '../shared/playerCapacity.js';
import { validateC2S } from '../shared/protocol.js';
import { EXPERIMENTAL_DEFAULTS, experimentalOptions, experimentalKey, sameExperimental, isExperimental } from '../shared/experimental.js';

const rules = (o = {}) => ({ revivalEnabled: false, disableSharedPool: false, ...o });
const LAYERS = rules({ disableLayerCap: true }), HITS = rules({ disableHitLimit: true }), BOTH = rules({ disableLayerCap: true, disableHitLimit: true });

class RecordingMatch {
  constructor(options) { this.opts = options; }
  start() {}
  dispose() {}
  onLeave() {}
  onDisconnect() {}
}
function fixture(t, clustered = false) {
  const registry = new SessionRegistry(), specs = [];
  const platform = { build: 'fixture-build', protocol: 1, resume() { return true; }, release() { return true; }, deliverEnd() { return true; },
    async prepare(spec) {
      specs.push(structuredClone(spec));
      return { assignmentId: spec.assignmentId, nodeId: 'fixture-node', generation: 'fixture-generation',
        commit() { return { ownerAvailable: true }; }, publish() { return true; }, abort() { return true; } };
    } };
  const LobbyClass = clustered ? ClusterLobby : Lobby;
  const lobby = new LobbyClass({ registry, MatchClass: RecordingMatch, getData: () => ({}), seedFn: () => 7, ...(clustered ? { platform } : {}) });
  t.after(() => lobby.shutdown());
  let number = 0;
  const player = () => {
    const session = registry.create(`LimitOption${++number}`);
    session.connected = true; session.matchmakingVersion = MATCHMAKING_VERSION; session.playerCapacityVersion = PLAYER_CAPACITY_VERSION;
    session.ws = { readyState: 1, bufferedAmount: 0, send(data, cb) { cb?.(); } };
    return session;
  };
  const room = (size, experimental = rules(), mode = 'coop') => {
    const members = Array.from({ length: size }, player);
    assert.deepEqual(lobby.create(members[0], { mode, difficulty: 'NORMAL', experimental }), { ok: true });
    const owner = lobby.roomOf(members[0]);
    for (const member of members.slice(1)) {
      assert.deepEqual(lobby.join(member, { code: owner.code }), { ok: true });
      assert.deepEqual(lobby.ready(member, { ready: true }), { ok: true });
    }
    return { owner, members };
  };
  return { lobby, room, specs };
}

test('shape: off is absent, the key and equality of a room without them are the old ones', () => {
  const off = rules({ disableLayerCap: false, disableHitLimit: false });
  assert.equal(isExperimental(off), true);
  assert.deepEqual(experimentalOptions(off), EXPERIMENTAL_DEFAULTS);
  assert.deepEqual(Object.keys(experimentalOptions(rules())), ['revivalEnabled', 'disableSharedPool']);
  assert.equal(experimentalKey(off), '00'); assert.equal(sameExperimental(off, rules()), true);
  assert.equal(experimentalKey(rules({ revivalEnabled: true, playerCapacity: 8, disableDuckLord: true })), '10:8:duck');
});

test('shape: on is kept, keys and equality tell every combination apart, in any capacity', () => {
  assert.deepEqual(experimentalOptions(BOTH), BOTH);
  assert.equal(experimentalKey(LAYERS), '00:layers'); assert.equal(experimentalKey(HITS), '00:hits'); assert.equal(experimentalKey(BOTH), '00:layers:hits');
  const all = rules({ revivalEnabled: true, disableSharedPool: true, playerCapacity: 20, disableDuckLord: true, disableLayerCap: true, disableHitLimit: true });
  assert.equal(isExperimental(all), true); assert.deepEqual(experimentalOptions(all), all);
  assert.equal(experimentalKey(all), '11:20:duck:layers:hits');
  const set = [rules(), LAYERS, HITS, BOTH];
  for (const a of set) for (const b of set) assert.equal(sameExperimental(a, b), a === b);
  assert.equal(new Set(set.map(experimentalKey)).size, 4);
  assert.equal(JSON.stringify(experimentalOptions(JSON.parse(JSON.stringify(BOTH)))), JSON.stringify(experimentalOptions(BOTH)), 'a saved room reads back the same');
});

test('shape: strict booleans, no other keys, and no way in but the nested option set', () => {
  for (const key of ['disableLayerCap', 'disableHitLimit']) for (const bad of ['true', 1, null, undefined]) {
    assert.equal(isExperimental(rules({ [key]: bad })), false, `${key}: ${bad}`);
  }
  assert.equal(isExperimental(rules({ somethingElse: true })), false);
  assert.equal(isExperimental(rules({ disableDuckLord: false, disableLayerCap: false, disableHitLimit: false, playerCapacity: 8, extra: true })), false);
  assert.equal(validateC2S({ t: 'room.setExperimental', experimental: BOTH }), null);
  assert.equal(validateC2S({ t: 'room.create', mode: 'solo', experimental: BOTH }), null);
  assert.ok(validateC2S({ t: 'room.setExperimental', experimental: rules({ disableLayerCap: 'yes' }) }));
  assert.ok(validateC2S({ t: 'queue.join', difficulty: 'NORMAL', experimental: BOTH }));
});

for (const clustered of [false, true]) test(`host sets them in a ${clustered ? 'cluster' : 'local'} coop room: teammates un-ready, state shows them, the match gets them`, async t => {
  const h = fixture(t, clustered), { owner, members } = h.room(2);
  assert.equal(h.lobby.setExperimental(members[1], { experimental: BOTH }).error, ERR.NOT_HOST);
  assert.deepEqual(h.lobby.setExperimental(members[0], { experimental: BOTH }), { ok: true });
  assert.equal(owner.seatOf(members[1].playerId).ready, false);
  assert.deepEqual(owner.toState().experimental, BOTH);
  h.lobby.ready(members[1], { ready: true });
  assert.deepEqual(await h.lobby.start(members[0]), { ok: true });
  for (let i = 0; i < 40; i++) await Promise.resolve();
  if (clustered) assert.deepEqual(h.specs[0].experimental, BOTH);
  else assert.deepEqual(owner.match.opts.experimental, BOTH);
  assert.equal(h.lobby.setExperimental(members[0], { experimental: rules() }).error, ERR.ROOM_STARTED);
});

test('a solo room takes them too', t => {
  const h = fixture(t), { owner, members } = h.room(1, rules(), 'solo');
  assert.deepEqual(h.lobby.setExperimental(members[0], { experimental: BOTH }), { ok: true });
  assert.deepEqual(owner.toState().experimental, BOTH);
  assert.deepEqual(h.lobby.start(members[0]), { ok: true });
  assert.deepEqual(owner.match.opts.experimental, BOTH);
});

test('queue: parties with different rules never merge, parties with the same do', t => {
  const set = [rules(), LAYERS, HITS, BOTH];
  for (const first of set) for (const second of set) {
    const h = fixture(t), a = h.room(2, first), b = h.room(2, second);
    h.lobby.queue.join(a.members[0], { difficulty: 'NORMAL', party: true });
    h.lobby.queue.join(b.members[0], { difficulty: 'NORMAL', party: true });
    assert.equal(h.lobby.queue.offers.size, first === second ? 1 : 0);
    if (first === second) assert.deepEqual([...h.lobby.queue.offers.values()][0].experimental, first);
  }
});
