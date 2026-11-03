// Checkpoints of an official version's rooms (server/persist/persister.js header, docs/DEPLOY.md「断点续玩」): their matches
// run in this process's version hosts (server/match/host/, kind 'version' — also on the cluster coordinator), which post
// the checkpoints this process stores under V.<room>.<matchNo>.<seed>.
//   (a) the host: a 第一期下半 and a 第二期上半 match post checkpoints at their safe points; a match created from a
//       mid-match one (a prep's end: that round fought again) is applied in the host and plays to its end without an
//       engine error; a checkpoint that does not fit is refused (`restored` false, the match ends 'version-start')
//   (b) a single-process server restarts: a 第一期下半 co-op room and a 第二期上半 solo room come back in their matches
//       from the checkpoints their hosts gave at the shutdown; the players resume with their tokens — same round, funds
//       and LP — and play on
//   (c) a reference this release cannot place (its checkpoint gone): that room closes ('node-restarted'), the rest
//       restores
//   (d) the cluster with SP_VERSION_PLACEMENT=coordinator (the fallback): the whole stack restarts (a release) — the
//       coordinator's version room comes back in its host, no game node involved
//   (e) the cluster (versionPlacement 'node', the default): a 第一期下半 and a 第二期上半 match are placed on game nodes and
//       run in their version hosts there (none on the coordinator); the in-match ping answers with the node's own load
//       (the HUD's server label); round 2's prep is held, the whole stack restarts, both are rebuilt on nodes from the
//       nodes' checkpoints (restoreStats.rebuilt), the players resume at round 2 with the same funds and LP and play
//       to the end
//   (f) placement (directory.js): a version match only on nodes that run the version, the node already running its host
//       first unless VERSION_HOST_WEIGHT busier, at most versionHostLimit busy hosts a node, default matches weighed
//   the host messages are checked by their outline (ipc.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { MemoryValkey, memoryStore } from './helpers/memoryStore.js';
import { stack, stop, nodeConfigs, client, until, actorOf } from './helpers/clusterStack.js';
import { ClusterDirectory, VERSION_HOST_WEIGHT } from '../server/cluster/directory.js';
import { publicGameLabel } from '../shared/cluster-load.js';
import { createMatchHosts } from '../server/match/host/index.js';
import { validHostMessage } from '../server/match/host/ipc.js';
import { createVersionSets } from '../server/versions.js';
import { computeVanillaContent } from '../server/plugins/identity.js';
import { DATA_DIR, ROOT, getData } from '../server/data.js';
import { DATA_SHIM_JS } from '../server/http/static.js';
import { MATCHMAKING_VERSION } from '../shared/constants.js';
import { VERSIONS } from '../shared/versions.js';
import { HOSTED_CHECKPOINT_VERSION } from '../server/persist/persister.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Version hosts that fight quickly: server-run battles at the engine's top speed, no bot rehearsal, inline combat. */
const QUICK = Object.freeze({ clientCombat: false, botRehearsal: 0, combatSpeed: 200 });

test('(a) a version host posts checkpoints; a match from a mid-match one plays to its end; one that does not fit is refused', { timeout: 240_000 }, async () => {
  const vanilla = computeVanillaContent({ simDir: path.join(ROOT, 'server', 'sim'), sharedDir: path.join(ROOT, 'shared'), dataDir: DATA_DIR, shim: DATA_SHIM_JS });
  const versions = createVersionSets({ enabled: VERSIONS.map((v) => v.id), vanilla, defaultData: getData({ log: quiet }), log: quiet });
  const hosts = createMatchHosts({ contents: versions, log: quiet, options: { kind: 'version', virtualTime: true, matchOptions: { botRehearsal: 0 } } });
  try {
    for (const [version, difficulty, modeId, n] of [['act1autochess', 'HARD', 'mode_multi_hard', 4], ['act2autochess@V2_1', 'NORMAL', 'mode_multi_normal', 2]]) {
      const cs = versions.csOf(version);
      const run = (seats, extra = {}) => {
        const out = { cps: [], broadcast: [] };
        out.end = new Promise((r) => { out.done = r; });
        const p = hosts.create(cs, { roomCode: 'VERS', mode: 'coop', difficulty, modeId, seats, spectators: [], seed: 11, matchNo: 1, cs, requireCs: true,
          version, checkpoints: true, send: () => true, broadcast: (m) => out.broadcast.push(m), onEnd: (s) => out.done(s),
          onCheckpoint: (proxy, reason) => out.cps.push({ reason, doc: JSON.parse(proxy.lastCheckpoint.json) }), ...extra });
        return { p, out };
      };
      const bots = Array.from({ length: n }, (_, i) => ({ seat: i, playerId: `ai_${i}`, name: `AI ${i}`, isBot: true, connected: true }));
      const a = run(bots);
      a.p.start();
      const first = await a.out.end;
      assert.ok(first.roundsPassed >= 3, `${version}: ${JSON.stringify(first).slice(0, 200)}`);
      const reasons = new Set(a.out.cps.map((c) => c.reason));
      for (const r of ['band-draft', 'prep-end']) assert.ok(reasons.has(r), `${version}: no ${r} checkpoint (${[...reasons]})`);
      const mid = a.out.cps.find((c) => c.reason === 'prep-end' && c.doc.round >= 3);
      assert.ok(mid, `${version}: a prep-end checkpoint of round 3+`);
      assert.equal(mid.doc.phase, 'PREP');
      // a match back from it in the host: the round's battle fought again, then on to the end
      const b = run(mid.doc.seats);
      assert.equal(await b.p.restore(mid.doc, { replay: true }), true, `${version}: restored`);
      const again = await b.out.end;
      assert.ok(again.roundsPassed >= mid.doc.round, `${version}: ${again.roundsPassed} rounds after a restore at ${mid.doc.round}`);
      const d = await b.p.diag();
      assert.equal(d.errorCount, 0, `${version}: engine errors ${JSON.stringify(d.errors)}`);
      assert.equal(d.version, version);
      assert.ok(b.out.cps.some((c) => c.doc.round > mid.doc.round), `${version}: the restored match checkpoints again`);
      b.p.dispose();
      // another seed: refused, the match ends as a failed start
      const c = run(mid.doc.seats);
      assert.equal(await c.p.restore({ ...mid.doc, seed: 12 }), false);
      const refused = await c.out.end;
      assert.equal(refused.reason, 'version-start');
      assert.match(refused.detail, /checkpoint refused/);
      a.p.dispose();
    }
  } finally { hosts.close(); }
  // the messages' outline
  assert.equal(validHostMessage({ type: 'checkpoint', matchId: 'VERS-1-1', reason: 'tick', json: '{"v":1}' }), true);
  assert.equal(validHostMessage({ type: 'checkpoint', matchId: 'VERS-1-1', reason: 'tick', json: '[1]' }), false);
  assert.equal(validHostMessage({ type: 'checkpoint', matchId: 'VERS-1-1', reason: 'x'.repeat(33), json: '{}' }), false);
  assert.equal(validHostMessage({ type: 'checkpoint', matchId: 'VERS-1-1', reason: 'tick', json: '{}', extra: 1 }), false);
  assert.equal(validHostMessage({ type: 'restored', matchId: 'VERS-1-1' }), true);
  assert.equal(validHostMessage({ type: 'restored', matchId: 'VERS-1-1', ok: true }), false);
});

const serverOpts = (store) => ({ host: '127.0.0.1', port: 0, quiet: true, combatWorkers: 0, trialWorkers: 0, studio: false, assetIndex: false,
  versionCombatWorkers: 0, matchHost: { matchOptions: QUICK }, persistStore: memoryStore(store), persistSaveMs: 60_000 });

/** A version room: one human (and `bots` AI seats in co-op), the page's content check, started. */
async function versionRoom(url, name, { version, mode, difficulty = 'NORMAL', bots = 0 }) {
  const c = await TestClient.connect(url);
  const welcome = await c.hello(name, undefined, { matchmakingVersion: MATCHMAKING_VERSION });
  assert.equal((await c.request({ t: 'room.create', mode, difficulty, version })).t, 'ok');
  const state = await c.waitFor('room.state');
  assert.equal(state.version, version);
  for (let i = 0; i < bots; i++) assert.equal((await c.request({ t: 'room.addBot' })).t, 'ok');
  assert.equal((await c.request({ t: 'room.contentReady', cs: state.content.cs })).t, 'ok');
  assert.equal((await c.request({ t: 'room.start' }, 10_000)).t, 'ok');
  return { c, welcome, name, code: state.code };
}

/** The last frame of a type a client got. */
const last = (c, type) => c.log.filter((f) => f.t === type).at(-1);

/**
 * Play a version room's human on autoplay through round 1, then hold it in round `round`'s prep (autoplay off: a lone
 * human's prep waits for its Ready). Resolves with that prep's own view.
 */
async function holdInPrep(c, round) {
  await c.request({ t: 'g.infoReady' }, 10_000).catch(() => null);
  assert.equal((await c.request({ t: 'g.autoplay', on: true }, 10_000)).t, 'ok');
  await c.waitFor('m.public', (m) => m.round === round - 1 && m.phase !== 'PREP' && m.phase !== 'ROUND_START', 90_000);
  assert.equal((await c.request({ t: 'g.autoplay', on: false }, 10_000)).t, 'ok');
  await c.waitFor('m.public', (m) => m.phase === 'PREP' && m.round === round, 90_000);
  await sleep(500);
  return last(c, 'm.private');
}

/** The stored checkpoint of a room's hosted match (decoded), or null. */
async function storedCheckpoint(store, code) {
  const key = store.keys(`sp:cp:V.${code}.`)[0];
  if (!key) return null;
  return (await memoryStore(store).loadCheckpoint(key.slice('sp:cp:'.length))).value;
}


test('(b)(c) a single-process server restarts: its version rooms come back in their matches; one whose checkpoint is gone closes', { timeout: 300_000 }, async (t) => {
  const store = new MemoryValkey();
  const a = await startServer(serverOpts(store));
  const url = `ws://127.0.0.1:${a.port}/ws`;
  const rooms = [
    await versionRoom(url, 'First', { version: 'act1autochess', mode: 'coop', bots: 3 }),
    await versionRoom(url, 'Second', { version: 'act2autochess@V2_1', mode: 'solo' }),
  ];
  assert.equal(a.lobby.rooms.get(rooms[0].code).match.hosted, true);
  const held = await Promise.all(rooms.map((r) => holdInPrep(r.c, 2)));
  // the AI seats finish their prep before a checkpoint may be taken (canSnapshot): the round's ask until it is the prep's
  for (const r of rooms) {
    let cp = null;
    for (let i = 0; i < 40 && !(cp?.match?.phase === 'PREP' && cp.match.round === 2 && cp.reason === 'tick'); i++) {
      await a.persistence.persister.flush('tick');
      cp = await storedCheckpoint(store, r.code);
      if (!(cp?.match?.round === 2 && cp.reason === 'tick')) await sleep(250);
    }
    assert.equal(cp?.v, HOSTED_CHECKPOINT_VERSION);
    assert.equal(cp.kind, 'hosted');
    assert.equal(cp.room, r.code);
    assert.equal(cp.match.round, 2, `${r.code}: the round-2 prep is stored (${cp?.reason} ${cp?.match?.phase} R${cp?.match?.round})`);
  }
  assert.equal(a.persistence.snapshot().hosted.captures >= 2, true);
  const doc = JSON.parse(JSON.stringify([...store.hashes.get('sp:lobby:rooms').values()].map((v) => JSON.parse(String(v)))));
  for (const r of rooms) {
    const rec = doc.find((x) => x.code === r.code);
    assert.equal(rec.match.kind, 'hosted');
    assert.equal(rec.match.version, rec.version);
    assert.match(rec.match.id, new RegExp(`^V\\.${r.code}\\.1\\.`));
  }
  // a copy of the store with the second room's checkpoint gone, for (c)
  await a.close();
  await Promise.all(rooms.map((r) => r.c.closed));
  const gone = new MemoryValkey();
  for (const [k, v] of store.data) gone.data.set(k, Buffer.from(v));
  for (const [k, h] of store.hashes) gone.hashes.set(k, new Map([...h].map(([f, v]) => [f, Buffer.from(v)])));
  for (const k of gone.keys(`sp:cp:V.${rooms[1].code}.`)) gone.data.delete(k);

  const b = await startServer(serverOpts(store));
  t.after(() => b.close());
  assert.equal(b.persistence.restored.rooms, 2);
  assert.equal(b.persistence.restored.matches, 2);
  await until(() => b.persistence.snapshot().hosted.restored === 2, 30_000, 'both applied in their hosts');
  assert.equal(b.persistence.snapshot().hosted.refused, 0);
  for (const [i, r] of rooms.entries()) {
    const c = await TestClient.connect(`ws://127.0.0.1:${b.port}/ws`);
    t.after(() => c.close());
    const again = await c.hello(r.name, r.welcome.token, { matchmakingVersion: MATCHMAKING_VERSION });
    assert.equal(again.playerId, r.welcome.playerId, 'the same identity');
    const state = await c.waitFor('room.state', (m) => m.inMatch, 10_000);
    assert.equal(state.code, r.code);
    assert.equal(state.version, i ? 'act2autochess@V2_1' : 'act1autochess');
    await c.request({ t: 'room.contentReady', cs: state.content.cs }, 10_000).catch(() => null);
    const pub = await c.waitFor('m.public', (m) => m.phase === 'PREP', 20_000);
    assert.equal(pub.round, 2);
    assert.equal(pub.replayRound, undefined, 'stopped during the prep: nothing is fought again');
    const priv = await c.waitFor('m.private', () => true, 10_000);
    assert.equal(priv.funds, held[i].funds, 'the same funds');
    assert.equal(priv.lp, held[i].lp, 'the same LP');
    // it plays on: Ready → the round's battle
    assert.equal((await c.request({ t: 'g.ready', ready: true }, 10_000)).t, 'ok');
    await c.waitFor('m.public', (m) => m.phase !== 'PREP' || m.round > 2, 30_000);
  }
  await b.close();

  // (c) the second room's checkpoint is gone: that room closes, the first comes back
  const g = await startServer(serverOpts(gone));
  t.after(() => g.close());
  assert.equal(g.persistence.restored.matches, 1);
  assert.equal(g.persistence.snapshot().droppedMatches, 1);
  assert.equal(g.lobby.rooms.has(rooms[1].code), false, 'closed');
  assert.ok(g.lobby.rooms.get(rooms[0].code)?.match, 'the other room is back in its match');
  const c = await TestClient.connect(`ws://127.0.0.1:${g.port}/ws`);
  t.after(() => c.close());
  const back = await c.hello('Second', rooms[1].welcome.token, { matchmakingVersion: MATCHMAKING_VERSION });
  assert.equal(back.playerId, rooms[1].welcome.playerId);
  await c.waitFor('room.closed', (m) => m.reason === 'node-restarted', 10_000);
});

test('(d) SP_VERSION_PLACEMENT=coordinator: the whole cluster restarts, the coordinator\'s version room comes back in its version host', { timeout: 240_000 }, async (t) => {
  const store = new MemoryValkey(), storeFor = () => memoryStore(store), configs = nodeConfigs();
  const coordinator = { versionCombatWorkers: 0, matchHost: { matchOptions: QUICK }, versionPlacement: 'coordinator' };
  const first = await stack(storeFor, { configs, coordinator });
  const c = await client(first.ingress.url, 'Doctor');
  await c.request('room.create', { mode: 'coop', difficulty: 'NORMAL', version: 'act1autochess' });
  const state = c.last('room.state');
  const code = state.code;
  for (let i = 0; i < 3; i++) await c.request('room.addBot');
  await c.request('room.contentReady', { cs: state.content.cs });
  await c.request('room.start');
  await until(() => first.coordinator.lobby.getRoom(code)?.match?.hosted, 10_000, 'hosted');
  await c.request('g.infoReady').catch(() => null);
  await c.request('g.autoplay', { on: true });
  await until(() => c.frames.some((f) => f.t === 'm.public' && f.round === 1 && f.phase !== 'PREP' && f.phase !== 'ROUND_START'), 90_000, 'round 1 fought');
  await c.request('g.autoplay', { on: false });
  await until(() => c.frames.some((f) => f.t === 'm.public' && f.phase === 'PREP' && f.round === 2), 90_000, 'round 2 prep');
  let cp = null;
  for (let i = 0; i < 40 && !(cp?.match?.round === 2 && cp.reason === 'tick'); i++) {
    await first.coordinator.persistence.persister.flush('tick');
    cp = await storedCheckpoint(store, code);
    if (!(cp?.match?.round === 2 && cp.reason === 'tick')) await sleep(250);
  }
  assert.equal(cp?.match?.round, 2);
  await stop(first);
  await c.closed;
  const second = await stack(storeFor, { configs, coordinator });
  t.after(() => stop(second));
  const room = second.coordinator.lobby.getRoom(code);
  assert.ok(room?.match?.hosted, 'the room is back in its match, in the coordinator\'s version host');
  await until(() => second.coordinator.persistence.snapshot().hosted.restored === 1, 30_000, 'applied');
  assert.equal(second.coordinator.lobby.restoreStats.rebuilt, 0, 'no game node involved');
  const back = await client(second.ingress.url, 'Doctor', c.token);
  assert.equal(back.playerId, c.playerId);
  await back.request('room.contentReady', { cs: second.coordinator.lobby.getRoom(code).content.cs }).catch(() => null);
  await until(() => back.frames.some((f) => f.t === 'm.public' && f.phase === 'PREP'), 20_000, 'resync');
  assert.equal(back.last('m.public').round, 2);
  await back.request('g.ready', { ready: true });
  await until(() => back.frames.some((f) => f.t === 'm.public' && (f.phase !== 'PREP' || f.round > 2)), 30_000, 'plays on');
  back.socket.close();
});

/** Every game node's version hosts: quick matches, inline combat, both other versions offered. */
const GAME = Object.freeze({ versionCombatWorkers: 0, versionHosts: 1, matchHost: { matchOptions: QUICK } });
const hostedActor = (s, code) => {
  for (const g of s.games) for (const ctx of g.gameHost.contexts.values()) if (ctx.spec.roomCode === code && ctx.state === 'committed') return { ctx, node: g };
  return null;
};

test('(e) the cluster places version matches on game nodes, rebuilds them there after a restart, and they play to the end', { timeout: 420_000 }, async (t) => {
  const store = new MemoryValkey(), storeFor = () => memoryStore(store);
  const configs = nodeConfigs().map((c, i) => ({ ...c, publicSlot: i + 1 }));
  const first = await stack(storeFor, { configs, game: GAME });
  const rooms = [];
  for (const [name, version, bots] of [['First', 'act1autochess', 3], ['Second', 'act2autochess@V2_1', 1]]) {
    const c = await client(first.ingress.url, name);
    await c.request('room.create', { mode: 'coop', difficulty: 'NORMAL', version });
    const st = c.last('room.state');
    for (let i = 0; i < bots; i++) await c.request('room.addBot');
    await c.request('room.contentReady', { cs: st.content.cs });
    await c.request('room.start');
    rooms.push({ name, version, code: st.code, c });
  }
  for (const r of rooms) {
    await until(() => hostedActor(first, r.code), 15_000, `${r.name} on a node`);
    const { ctx } = hostedActor(first, r.code);
    assert.equal(ctx.spec.version, r.version);
    assert.equal(ctx.match.hosted, true, 'in the node\'s version host');
    assert.equal(first.coordinator.lobby.getRoom(r.code).match.hosted, undefined, 'not the coordinator\'s');
  }
  assert.equal(first.coordinator.versionHosts.stats().matches, 0, 'no version host on the coordinator');
  for (const r of rooms) { await r.c.request('g.infoReady').catch(() => null); await r.c.request('g.autoplay', { on: true }); }
  const pub = (c, f) => c.frames.some((m) => m.t === 'm.public' && f(m));
  for (const r of rooms) {
    await until(() => pub(r.c, (m) => m.round === 1 && !['PREP', 'ROUND_START', 'INFO_CHECK', 'BAND_DRAFT', 'SP_DRAFT'].includes(m.phase)), 120_000, `${r.name} round 1 fought`);
    await r.c.request('g.autoplay', { on: false });
  }
  for (const r of rooms) await until(() => pub(r.c, (m) => m.phase === 'PREP' && m.round === 2), 120_000, `${r.name} round 2 prep`);
  // the HUD's label: in the match, a ping answers with the game node's own load (scope 'game', its public label)
  for (const r of rooms) {
    const { node } = hostedActor(first, r.code);
    r.c.socket.send(JSON.stringify({ t: 'ping', c: 7, rid: 9000 }));
    await until(() => r.c.frames.some((f) => f.t === 'pong' && f.c === 7), 10_000, `${r.name} pong`);
    const pong = r.c.frames.find((f) => f.t === 'pong' && f.c === 7);
    assert.equal(pong.clusterLoad?.scope, 'game', `${r.name}: the node's own load (${JSON.stringify(pong).slice(0, 200)})`);
    const nodeIndex = first.games.indexOf(node);
    assert.equal(pong.clusterLoad.nodes[0].label, publicGameLabel(configs[nodeIndex].publicSlot), 'its node\'s label');
  }
  // the nodes' checkpoints of round 2's prep (the AI seats finish theirs first)
  const held = new Map();
  for (const r of rooms) {
    const { ctx, node } = hostedActor(first, r.code);
    let cp = null;
    for (let i = 0; i < 40 && !(cp?.match?.round === 2 && cp.match.phase === 'PREP'); i++) {
      await node.checkpoints.tick('tick');
      cp = (await memoryStore(store).loadCheckpoint(ctx.spec.assignmentId)).value;
      if (!(cp?.match?.round === 2)) await sleep(250);
    }
    assert.equal(cp?.kind, 'cluster');
    assert.equal(cp.spec.version, r.version, 'the checkpoint names the version');
    assert.equal(cp.match.round, 2);
    held.set(r.code, { funds: r.c.last('m.private')?.funds, lp: r.c.last('m.private')?.lp });
  }
  await first.coordinator.persistence.persister.flush('tick');
  await stop(first);
  await Promise.all(rooms.map((r) => r.c.closed));

  const second = await stack(storeFor, { configs, game: GAME });
  t.after(() => stop(second));
  await until(() => second.coordinator.lobby.restoreStats.rebuilt === 2, 30_000, 'both rebuilt on nodes');
  assert.equal(second.coordinator.lobby.restoreStats.failed, 0);
  assert.equal(second.coordinator.versionHosts.stats().matches, 0, 'still none on the coordinator');
  const back = [];
  for (const r of rooms) {
    const { ctx } = hostedActor(second, r.code);
    assert.equal(ctx.match.hosted, true);
    assert.equal(ctx.spec.version, r.version);
    const c = await client(second.ingress.url, r.name, r.c.token);
    assert.equal(c.playerId, r.c.playerId, 'the same identity');
    const room = second.coordinator.lobby.getRoom(r.code);
    await c.request('room.contentReady', { cs: room.content.cs }).catch(() => null);
    await until(() => c.frames.some((f) => f.t === 'm.public' && f.phase === 'PREP'), 20_000, `${r.name} resync`);
    assert.equal(c.last('m.public').round, 2);
    assert.equal(c.last('m.public').replayRound, undefined, 'stopped during the prep: nothing is fought again');
    await until(() => c.last('m.private'), 10_000, 'private');
    assert.equal(c.last('m.private').funds, held.get(r.code).funds, 'the same funds');
    assert.equal(c.last('m.private').lp, held.get(r.code).lp, 'the same LP');
    back.push({ ...r, c });
  }
  // they play to the end (autoplay), the results through the game-node path (the receipt)
  for (const r of back) await r.c.request('g.autoplay', { on: true });
  for (const r of back) {
    await until(() => r.c.frames.some((f) => f.t === 'm.result'), 300_000, `${r.name} ends`);
    await until(() => second.coordinator.lobby.getRoom(r.code)?.match == null, 20_000, `${r.name} room back in its lobby`);
  }
  for (const r of back) r.c.socket.close();
});

test('(f) placement weighs version hosts', () => {
  let now = 1000;
  const d = new ClusterDirectory({ now: () => now });
  const up = (nodeId, extra = {}, matches = 0) => {
    d.register({ nodeId, generation: `g-${nodeId}`, build: 'b', protocol: 1 });
    d.heartbeat(nodeId, { generation: `g-${nodeId}`, ready: true, matches, ...extra });
  };
  const all = { versions: ['act2autochess@V2_1', 'act1autochess', 'act1autochess@V1_1'], versionHostLimit: 1 };
  // n3: a node that runs 第二期下半 alone (a release before rel26 reports no versions), three matches busy already
  up('n1', all); up('n2', all); up('n3', {}, 3);
  let n = 0;
  const place = (version = null) => d.prepare({ roomCode: `R${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[n % 26]}${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(n / 26) % 26]}Z`.slice(0, 4),
    sessionIds: [`p${n++}`], build: 'b', protocol: 1, version }).nodeId;
  const v1 = place('act1autochess');
  assert.ok(['n1', 'n2'].includes(v1), 'only a node that runs the version');
  // the same version again: to the node that already runs its host (VERSION_HOST_WEIGHT keeps it there)
  for (let i = 1; i < VERSION_HOST_WEIGHT; i++) assert.equal(place('act1autochess'), v1);
  // …until it is VERSION_HOST_WEIGHT busier than an idle node, which then starts a host of its own
  // (n1/n2 run at most one busy host each: here the other node starts act1autochess's)
  const other = v1 === 'n1' ? 'n2' : 'n1';
  assert.equal(place('act1autochess'), other);
  // both run act1autochess's host now: another version finds no node with room for its host (a limit of one each)
  assert.throws(() => place('act2autochess@V2_1'), (e) => e.code === 'NO_NODE');
  // a default match: n1 / n2 count VERSION_HOST_WEIGHT more for their busy host than their load; n3 (3, none) goes first
  assert.ok(1 + VERSION_HOST_WEIGHT > 3);
  assert.equal(place(), 'n3');
});
