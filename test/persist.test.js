// Checkpoints across a restart of a single-process server (server/persist/, docs/DEPLOY.md「断点续玩」): real HTTP/WS,
// real Match, an in-memory stand-in for the store shared by two server lifetimes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { MemoryValkey, memoryStore } from './helpers/memoryStore.js';
import { snapshotLobby, restoreLobby, LOBBY_DOC_VERSION } from '../server/persist/lobbyState.js';
import { LobbyPersister } from '../server/persist/persister.js';
import { SessionRegistry } from '../server/net.js';
import { Lobby } from '../server/lobby.js';
import { MATCHMAKING_VERSION } from '../shared/constants.js';
import { Match } from '../server/match/Match.js';

/** Real matches, quick: server-run battles at the engine's top speed, no bot rehearsal. */
class QuickMatch extends Match {
  constructor(opts) { super({ ...opts, clientCombat: false, botRehearsal: 0, combatSpeed: 200 }); }
}
const serverOpts = (client) => ({ host: '127.0.0.1', port: 0, quiet: true, combatWorkers: 0, trialWorkers: 0, studio: false, assetIndex: false,
  MatchClass: QuickMatch, persistStore: memoryStore(client), persistSaveMs: 60_000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Play a match's human seat (server side, like a browser would) until `round`'s prep. */
async function driveTo(match, pid, round) {
  for (let i = 0; i < 3000; i++) {
    if (match.phase === 'PREP' && match.round === round) return;
    const ps = match.players.get(pid);
    if (match.phase === 'INFO_CHECK' && !ps.infoReady) match.handle(pid, { t: 'g.infoReady' });
    if (match.phase === 'BAND_DRAFT' && match.draftTurn() === pid) match.handle(pid, { t: 'g.band', bandId: 'band_bldsk' });
    // 选择自编 (CUSTOM_CHECK): every version since 2026-11-21 — a lone human is untimed there: bring none
    if (match.phase === 'CUSTOM_CHECK' && ps.diyBring == null) match.handle(pid, { t: 'g.diyBring', slots: [] });
    if (match.phase === 'SP_DRAFT' && match.spTurn() === pid) {
      const idx = match.sp.cards.find((card) => match.spCardAvailable(card, ps))?.idx;
      if (idx != null) match.handle(pid, { t: 'g.choice', idx });
    }
    if (match.phase === 'PREP' && ps.alive && !ps.ready) {
      if (ps.personalChoice) match.handle(pid, { t: 'g.choice', idx: 0, choiceId: ps.personalChoice.id });
      if (!ps.tempEmpty) ps.resolveTemp();
      match.handle(pid, { t: 'g.ready', ready: true });
    }
    await sleep(10);
  }
  throw new Error(`prep of round ${round} not reached (${match.phase} R${match.round})`);
}

test('a solo run survives a server restart: same identity, same room, same round and economy, and it plays on', { timeout: 60_000 }, async (t) => {
  const store = new MemoryValkey();
  const a = await startServer(serverOpts(store));
  let c = await TestClient.connect(`ws://127.0.0.1:${a.port}/ws`);
  const welcome = await c.hello('Doctor', undefined, { matchmakingVersion: MATCHMAKING_VERSION });
  assert.equal((await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' })).t, 'ok');
  const room = await c.waitFor('room.state');
  assert.equal((await c.request({ t: 'room.start' })).t, 'ok');
  const match = a.lobby.rooms.get(room.code).match;
  await driveTo(match, welcome.playerId, 2);
  const funds = match.players.get(welcome.playerId).funds, lp = match.players.get(welcome.playerId).lp;
  await a.close();
  await c.closed;
  assert.ok(store.keys('sp:cp:L.').length === 1, 'one local checkpoint');
  assert.ok(store.data.has('sp:lobby'));

  const b = await startServer(serverOpts(store));
  t.after(() => b.close());
  assert.equal(b.persistence.restored.rooms, 1);
  assert.equal(b.persistence.restored.matches, 1);
  c = await TestClient.connect(`ws://127.0.0.1:${b.port}/ws`);
  const again = await c.hello('Doctor', welcome.token, { matchmakingVersion: MATCHMAKING_VERSION });
  assert.equal(again.playerId, welcome.playerId, 'the same identity');
  const state = await c.waitFor('room.state', (m) => m.inMatch);
  assert.equal(state.code, room.code);
  const pub = await c.waitFor('m.public', (m) => m.phase === 'PREP');
  assert.equal(pub.round, 2);
  assert.equal(pub.replayRound, undefined, 'stopped during the prep: the prep goes on, nothing is fought again');
  const restored = b.lobby.rooms.get(room.code).match.players.get(welcome.playerId);
  assert.equal(restored.funds, funds);
  assert.equal(restored.lp, lp);
  // it plays on: Ready → the round's battle
  c.send({ t: 'g.ready', ready: true });
  await c.waitFor('m.public', (m) => m.phase === 'COMBAT' || m.round > 2, 15000);
  await c.close();
  // a match that is gone: its checkpoint goes once the document no longer names it
  b.lobby.disposeRoom(b.lobby.rooms.get(room.code), 'empty');
  assert.equal(await b.persistence.persister.flush('tick'), true);
  assert.deepEqual(store.keys('sp:cp:'), []);
});

test('a run stopped during its battle comes back in that round\'s prep, which says the battle is fought again', { timeout: 60_000 }, async (t) => {
  const store = new MemoryValkey();
  // the round's checkpoint (written as its prep ended) is still on its way when the server stops: the shutdown waits for it
  store.checkpointWriteMs = 2000;
  const a = await startServer(serverOpts(store));
  let c = await TestClient.connect(`ws://127.0.0.1:${a.port}/ws`);
  const welcome = await c.hello('Doctor', undefined, { matchmakingVersion: MATCHMAKING_VERSION });
  assert.equal((await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' })).t, 'ok');
  const room = await c.waitFor('room.state');
  assert.equal((await c.request({ t: 'room.start' })).t, 'ok');
  const match = a.lobby.rooms.get(room.code).match;
  await driveTo(match, welcome.playerId, 2);
  match.handle(welcome.playerId, { t: 'g.ready', ready: true });
  for (let i = 0; i < 20000 && match.phase === 'PREP'; i++) await new Promise((r) => setImmediate(r));
  assert.equal(match.round, 2);
  assert.ok(!['PREP', 'ROUND_START', 'SP_DRAFT'].includes(match.phase), `past the prep (${match.phase})`);
  await a.close();
  await c.closed;
  store.checkpointWriteMs = 0;

  const b = await startServer(serverOpts(store));
  t.after(() => b.close());
  c = await TestClient.connect(`ws://127.0.0.1:${b.port}/ws`);
  await c.hello('Doctor', welcome.token, { matchmakingVersion: MATCHMAKING_VERSION });
  const pub = await c.waitFor('m.public', (m) => m.phase === 'PREP');
  assert.equal(pub.round, 2);
  assert.equal(pub.replayRound, 2);
  c.send({ t: 'g.ready', ready: true });
  const next = await c.waitFor('m.public', (m) => m.phase !== 'PREP', 15000);
  assert.equal(next.replayRound, undefined, 'only during that prep');
  await c.close();
});

test('a lobby room and its waiting players come back; a visitor outside any room gets a fresh identity', { timeout: 60_000 }, async (t) => {
  const store = new MemoryValkey();
  const a = await startServer(serverOpts(store));
  const host = await TestClient.connect(`ws://127.0.0.1:${a.port}/ws`);
  const hw = await host.hello('Host', undefined, { matchmakingVersion: MATCHMAKING_VERSION });
  assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
  const room = await host.waitFor('room.state');
  const guest = await TestClient.connect(`ws://127.0.0.1:${a.port}/ws`);
  const gw = await guest.hello('Guest', undefined, { matchmakingVersion: MATCHMAKING_VERSION });
  assert.equal((await guest.request({ t: 'room.join', code: room.code })).t, 'ok');
  // a fresh visitor outside any room is not kept
  const visitor = await TestClient.connect(`ws://127.0.0.1:${a.port}/ws`);
  const vw = await visitor.hello('Visitor');
  await a.close();
  const b = await startServer(serverOpts(store));
  t.after(() => b.close());
  assert.ok(b.registry.byId(hw.playerId) && b.registry.byId(gw.playerId));
  assert.equal(b.registry.byId(vw.playerId), null);
  const r = b.lobby.rooms.get(room.code);
  assert.ok(r && !r.match);
  assert.equal(r.hostId, hw.playerId);
  assert.equal(r.activeHumans().length, 2);
  const back = await TestClient.connect(`ws://127.0.0.1:${b.port}/ws`);
  await back.hello('Guest', gw.token, { matchmakingVersion: MATCHMAKING_VERSION });
  const st = await back.waitFor('room.state');
  assert.equal(st.code, room.code);
  assert.equal(st.seats.filter(Boolean).length, 2);
  await back.close();
});

test('a store that is down costs only the checkpoints: the server starts and plays', { timeout: 30_000 }, async (t) => {
  const store = new MemoryValkey();
  store.down = true;
  // (the startup read waits for it — RESTORE_WAIT_MS, test/persist-startup.test.js — here only 1 s)
  const t0 = Date.now();
  const a = await startServer({ ...serverOpts(store), persistRestoreWaitMs: 1000 });
  t.after(() => a.close());
  assert.deepEqual(a.persistence.restored, { ok: false, reason: 'unavailable' });
  assert.ok(Date.now() - t0 >= 500, 'read again after a pause');
  const c = await TestClient.connect(`ws://127.0.0.1:${a.port}/ws`);
  const w = await c.hello('Doctor');
  assert.equal((await c.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' })).t, 'ok');
  assert.equal((await c.request({ t: 'room.start' })).t, 'ok');
  await driveTo(a.lobby.rooms.get(a.registry.byId(w.playerId).roomCode).match, w.playerId, 1);
  assert.equal(await a.persistence.persister.flush('tick'), false);
  const stats = a.persistence.snapshot();
  assert.ok(stats.docFailures >= 1 && stats.store.writeFailures >= 1);
  const health = await (await fetch(`http://127.0.0.1:${a.port}/healthz`)).json();
  assert.equal(health.persistence.enabled, true);
  await c.close();
});

test('the lobby document: expired sessions and departed seats', () => {
  const registry = new SessionRegistry({ reconnectWindowMs: 60_000 });
  const lobby = new Lobby({ registry, getData: () => ({}) });
  const doc = {
    v: LOBBY_DOC_VERSION, kind: 'local', savedAt: 0,
    sessions: [
      { playerId: 'p_1', token: 'a'.repeat(32), name: 'A', roomCode: 'ABCD', connected: true, disconnectedAt: null },
      { playerId: 'p_2', token: 'b'.repeat(32), name: 'B', roomCode: 'ABCD', connected: false, disconnectedAt: 0 },
    ],
    rooms: [{ code: 'ABCD', mode: 'coop', difficulty: 'NORMAL', experimental: { revivalEnabled: false, disableSharedPool: false, playerCapacity: 4 },
      hostId: 'p_2', matchCount: 1, seats: [{ seat: 0, playerId: 'p_1', name: 'A', isBot: false }, { seat: 1, playerId: 'p_2', name: 'B', isBot: false },
        { seat: 2, playerId: 'ai_1', name: 'AI', isBot: true }, null], spectators: [], match: { kind: 'local', id: 'L.ABCD.1.1', seed: 1, matchNo: 1 } }],
  };
  const out = restoreLobby({ doc, registry, lobby, now: 120_000 });
  assert.equal(out.sessions, 1);
  assert.equal(out.expired, 1);
  const room = lobby.rooms.get('ABCD');
  assert.equal(room.hostId, 'p_1', 'the host moves to a player that is still there');
  assert.equal(room.seatOf('p_2').left, true);
  assert.deepEqual(out.matches[0].departed, ['p_2']);
  assert.equal(room.seatOf('p_1').left, false);
  assert.equal(registry.byId('p_1').connected, false);
  assert.equal(registry.byId('p_1').disconnectedAt, 120_000, 'cut off by the restart: its window starts now');
  const saved = snapshotLobby({ registry, lobby, matchRef: () => ({ kind: 'local', id: 'x', seed: 1, matchNo: 1 }), now: 1 });
  assert.equal(saved.rooms.length, 1);
  assert.equal(saved.sessions.length, 1);
  assert.equal(restoreLobby({ doc: { ...doc, v: 99 }, registry, lobby }).ok, false);
  lobby.shutdown();
});

test('the lobby is written record by record: an unchanged lobby writes nothing, a changed loadout one session record', async () => {
  const registry = new SessionRegistry();
  const lobby = new Lobby({ registry, getData: () => ({}) });
  const client = new MemoryValkey();
  const persister = new LobbyPersister({ store: memoryStore(client), registry, lobby });
  for (let i = 0; i < 3; i++) {
    const s = registry.create(`P${i}`);
    assert.equal(lobby.create(s, { mode: 'coop', difficulty: 'NORMAL' }).ok, true);
  }
  const outsider = registry.create('Visitor');
  assert.equal(await persister.flush('tick'), true);
  const hset = () => client.commands.filter((c) => c === 'HSET').length;
  const sessions = client.hashes.get('sp:lobby:sessions'), rooms = client.hashes.get('sp:lobby:rooms');
  assert.equal(sessions.size, 3);
  assert.equal(rooms.size, 3);
  assert.equal(sessions.has(outsider.playerId), false);
  const before = hset();
  assert.equal(await persister.flush('tick'), true);
  assert.equal(hset(), before, 'nothing changed: no record written');
  const s0 = [...registry.all()][0];
  s0.loadout = Object.freeze({});
  assert.equal(await persister.flush('tick'), true);
  assert.equal(hset(), before + 1);
  const seat = lobby.rooms.get(s0.roomCode).seatOf(s0.playerId);
  assert.ok(!JSON.parse(rooms.get(s0.roomCode).toString()).seats[0].$same?.includes('loadout'), 'the seat kept the old value: stored in full');
  lobby.disposeRoom(lobby.rooms.get(s0.roomCode), 'empty');
  assert.equal(await persister.flush('tick'), true);
  assert.equal(rooms.size, 2);
  assert.equal(sessions.has(s0.playerId), false);
  void seat;
  lobby.shutdown();
});
