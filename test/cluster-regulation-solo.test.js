// 规程's solo on the cluster (rel40 preflight, 2026-11-16): a laddered room keeps its official mode (规程等级 N:
// mode_single_N; 极速模拟: mode_single_funny), and with versionPlacement 'node' (the default) its match runs in a game
// node's version host. The coordinator's assignment names the mode Lobby.createMatch names (matchDTO), and the node
// accepts another version's own mode (copyAssignmentSpec) — before, every 规程 solo start answered INTERNAL
// (「remote admission invalid」). The single-process server never took this path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stack, stop, nodeConfigs, client, until } from './helpers/clusterStack.js';
import { MemoryValkey, memoryStore } from './helpers/memoryStore.js';
import { copyAssignmentSpec } from '../server/cluster/game-host.js';

const QUICK = Object.freeze({ clientCombat: false, botRehearsal: 0, combatSpeed: 200 });
const GAME = Object.freeze({ versionCombatWorkers: 0, versionHosts: 1, matchHost: { matchOptions: QUICK } });
const REG = 'act3autochess@V3_1';

const spec = (fields) => ({ assignmentId: 'a1', roomCode: 'ABCD', build: 'b', protocol: 1, seed: 1, matchNo: 1, mode: 'solo',
  difficulty: 'FUNNY', modeId: 'mode_single_funny', spectators: [],
  seats: [{ seat: 0, playerId: 'p1', name: 'P', isBot: false, connected: true }], ...fields });

test('copyAssignmentSpec: 第二期下半 names the difficulty\'s mode; another version may name one of its own', () => {
  assert.equal(copyAssignmentSpec(spec({})).modeId, 'mode_single_funny');
  assert.throws(() => copyAssignmentSpec(spec({ modeId: 'mode_single_5' })), 'the default version: modeIdFor only');
  assert.equal(copyAssignmentSpec(spec({ version: REG, difficulty: 'HARD', modeId: 'mode_single_5' })).modeId, 'mode_single_5');
  for (const modeId of [undefined, '', 'single_5', 'mode_single_5;', 'mode_' + 'x'.repeat(41), 5]) {
    assert.throws(() => copyAssignmentSpec(spec({ version: REG, modeId })), String(modeId));
  }
});

test('a 规程 solo room (规程等级 5) starts in a game node\'s version host', { timeout: 240_000 }, async (t) => {
  const store = new MemoryValkey(), storeFor = () => memoryStore(store);
  const configs = nodeConfigs().map((c, i) => ({ ...c, publicSlot: i + 1 }));
  const s = await stack(storeFor, { configs, game: GAME });
  t.after(() => stop(s));
  const c = await client(s.ingress.url, 'Regulation');
  t.after(() => c.socket.close());
  await c.request('room.create', { mode: 'solo', difficulty: 'HARD', version: REG, modeId: 'mode_single_5' });
  const st = c.last('room.state');
  assert.equal(st.version, REG);
  assert.equal(s.coordinator.lobby.getRoom(st.code).modeId, 'mode_single_5');
  await c.request('room.contentReady', { cs: st.content.cs });
  await c.request('room.start');
  const actor = () => {
    for (const g of s.games) for (const ctx of g.gameHost.contexts.values()) if (ctx.spec.roomCode === st.code && ctx.state === 'committed') return ctx;
    return null;
  };
  await until(actor, 30_000, 'the match on a node');
  assert.equal(actor().spec.modeId, 'mode_single_5');
  assert.equal(actor().match.hosted, true, 'in the node\'s version host');
  await until(() => c.frames.some((f) => f.t === 'm.public'), 30_000, 'the match view');
});
