// A match whose game node was lost twice is not placed a third time (ClusterLobby.recoverRemote, NODE_LOST_PLACEMENTS;
// 2026-11-04 game-08): a match that holds its node's main thread would otherwise walk across the nodes, each held until
// its watchdog kills it. A release's restart (NODE_RESTARTED) is not a loss. Real ClusterLobby, platform and directory
// over a scripted game node (as test/cluster-restore-departed.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ClusterLobby, NODE_LOST_PLACEMENTS } from '../server/cluster/lobby.js';
import { RemoteGamePlatform } from '../server/cluster/platform.js';
import { AllocationError } from '../server/cluster/directory.js';
import { SessionRegistry } from '../server/net.js';
import { restoreLobby, LOBBY_DOC_VERSION } from '../server/persist/lobbyState.js';
import { modeIdFor } from '../shared/constants.js';
import { EXPERIMENTAL_DEFAULTS } from '../shared/experimental.js';

const BUILD = 'test-build';
const until = async (condition, ms = 10_000, what = 'condition') => {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

function node(nodeId) {
  const state = { nodeId, key: randomBytes(32), generation: `${nodeId}-g2`, ready: true, actors: new Map(), calls: [] };
  const view = (a) => ({ assignmentId: a.assignmentId, roomCode: a.roomCode, generation: state.generation, build: BUILD, protocol: 1,
    actorGeneration: a.generation, state: 'committed', published: a.published });
  state.client = {
    async call(op, payload) {
      state.calls.push({ op, ...payload });
      if (op === 'status' && !payload.assignmentId) return { nodeId, generation: state.generation, build: BUILD, protocol: 1, ready: state.ready,
        counts: { matches: state.actors.size } };
      if (op === 'restore') {
        const actor = { assignmentId: payload.assignmentId, roomCode: payload.roomCode, generation: state.actors.size + 1, published: false };
        state.actors.set(payload.assignmentId, actor);
        return view(actor);
      }
      if (op === 'release') return state.actors.delete(payload.assignmentId);
      const actor = state.actors.get(payload.assignmentId);
      if (!actor) throw new AllocationError('STALE_ASSIGNMENT');
      if (op === 'publish') actor.published = true;
      if (op === 'leave' || op === 'removeSpectator') return { ok: true };
      return view(actor);
    },
    close() {},
  };
  return state;
}

const human = (seat, playerId) => ({ seat, playerId, name: playerId, isBot: false, ready: true, left: false, loadout: null, skins: {} });
const bot = (seat) => ({ seat, playerId: `ai_A${seat}`, name: `AI${seat}`, isBot: true, ready: true, skins: {} });

function matchRoom(code, seats) {
  const spec = { roomCode: code, mode: 'coop', difficulty: 'NORMAL', modeId: modeIdFor('coop', 'NORMAL'), revivalEnabled: false,
    disableSharedPool: false, experimental: { ...EXPERIMENTAL_DEFAULTS }, aiPicksLast: false, seed: 7, matchNo: 1,
    seats: seats.map((s) => ({ seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot, connected: !s.isBot, loadout: null,
      ops: null, notOwned: null, diy: null, skins: {} })), spectators: [] };
  return { code, mode: 'coop', difficulty: 'NORMAL', aiPicksLast: false, hostId: seats.find((s) => !s.isBot).playerId,
    experimental: { ...EXPERIMENTAL_DEFAULTS }, source: 'private', ownerKey: null, ownerKeys: null, matchKey: null, matchKeys: null,
    matchCount: 1, createdAt: 1, seats, spectators: [],
    match: { kind: 'remote', assignmentId: randomBytes(16).toString('hex'), nodeId: 'game-a', nodeGeneration: 'game-a-g1',
      actorGeneration: 1, matchNo: 1, spec } };
}

test(`a match placed again after NODE_LOST ${NODE_LOST_PLACEMENTS} time(s) is not placed after the next loss; NODE_RESTARTED does not count`, async (t) => {
  assert.equal(NODE_LOST_PLACEMENTS, 1);
  const clock = { time: 1_000_000 }, game = node('game-a'), warnings = [];
  const platform = new RemoteGamePlatform({ nodes: [game], build: BUILD, protocol: 1, sendControl: () => true, now: () => clock.time });
  const registry = new SessionRegistry({ now: () => clock.time });
  const lobby = new ClusterLobby({ registry, platform, options: {}, getData: () => ({}), now: () => clock.time,
    log: { info() {}, warn: (line) => warnings.push(line), error() {}, debug() {} }, MatchClass: class { constructor() { throw new Error('no local match'); } } });
  t.after(async () => { lobby.shutdown(); await platform.close({ release: false }); });
  await platform.refresh();
  const doc = { v: LOBBY_DOC_VERSION, kind: 'cluster', savedAt: clock.time,
    sessions: [{ playerId: 'quinn', token: randomBytes(16).toString('hex'), name: 'quinn', roomCode: 'AAAA', notice: null,
      connected: true, disconnectedAt: null, resumeWindowMs: null, matchHeld: false, skins: {} }],
    rooms: [matchRoom('AAAA', [human(0, 'quinn'), bot(1), bot(2), bot(3)])] };
  const out = restoreLobby({ doc, registry, lobby, now: clock.time });
  const { room, ref, departed } = out.matches[0];
  assert.equal(lobby.restoreRemoteMatch(room, ref, departed), true);
  const placed = async (n) => {
    await until(() => lobby.restoreStats.pending === 0 && lobby.restoreStats.rebuilt === n && room.match?.plan?.published, 10_000, `placement ${n}`);
    return room.match.plan;
  };
  lobby.checkpointsOn = true;
  let plan = await placed(1);
  assert.equal(lobby.recoverRemote(room, plan, 'NODE_LOST'), true, 'the first loss: placed again');
  plan = await placed(2);
  assert.equal(lobby.recoverRemote(room, plan, 'NODE_RESTARTED'), true, 'a restart is not a loss');
  plan = await placed(3);
  assert.equal(lobby.recoverRemote(room, plan, 'NODE_LOST'), false, 'the second loss: not placed again (the caller ends the room)');
  assert.ok(warnings.some((w) => w.includes('AAAA') && w.includes('not placed again')), warnings.join('; '));
  assert.equal(room.match, plan.proxy, 'nothing was touched: the coordinator disposes the room as without checkpoints');
  lobby.disposeRoom(room, 'node-unavailable');
  assert.equal([...lobby.nodeLostPlacements.keys()].some((k) => k.startsWith('AAAA#')), false, 'forgotten with the room');
});
