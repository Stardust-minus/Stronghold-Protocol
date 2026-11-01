// Local display replicas under server-run combat (DESIGN §14 "Local display replicas"; server/match/match/localReplica.js,
// server/sim/syncHash.js, public/js/battle/runner.js): a Worker-run normal field is sent to its own player's browser as a
// b.start { local: true } instead of being streamed; the Worker digests the field after every SYNC_TICKS step (b.sync);
// a replica whose digest or end tick differs, or that is too slow, goes back to the stream. The Worker battle stays the
// only authority.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Match } from '../../server/match/Match.js';
import { buildNormalWave } from '../../server/match/waves.js';
import { CombatWorkerPool } from '../../server/match/combat/pool.js';
import { CombatEngine } from '../../server/match/combat/engine.js';
import { SYNC_TICKS, isSyncTick, stateHash } from '../../server/sim/syncHash.js';
import * as specMod from '../../server/sim/spec.js';
import * as syncMod from '../../server/sim/syncHash.js';
import { DataSource } from '../../server/sim/simdata.js';
import { createBattleRunner, SLOW_TICK_MS } from '../../public/js/battle/runner.js';
import { createStore, initialState } from '../../public/js/store.js';
import { validateC2S, S2C } from '../../shared/protocol.js';
import { isCompressibleType } from '../../server/wsCompression.js';
import { DATA, give, legalTileFor } from './harness.js';

const DS = new DataSource(DATA, null);
const QUIET = { info() {}, warn() {}, debug() {}, error() {} };
const clone = (x) => structuredClone(x);

async function until(predicate, label, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await delay(5);
  }
}

/** The digests a battle gives after every sync step, stepped to its end (the browser side of the comparison). */
function localDigests(spec, { observe = false } = {}) {
  const b = specMod.createBattleFromSpec(clone(spec), DS, { logger: QUIET });
  const out = [];
  let i = 0;
  while (!b.finished && i++ < 200000) {
    b.step();
    if (isSyncTick(b)) out.push([b.tickCount, stateHash(b), b.finished ? 1 : 0]);
    // a browser renders between its steps: snapshots / meta must not change what the next digest sees
    if (observe && i % 3 === 0) { b.snapshot(); b.drainEvents(); if (i % 50 === 0) b.fieldMeta(); }
  }
  return out;
}

/** The server side: the spec in a CombatEngine (as in a combat Worker) with its field synced. */
function engineDigests(spec, { watched = () => false, chunk = () => 32 } = {}) {
  const eng = new CombatEngine({ specs: [spec], wireFrames: true, coalesceFrames: true, damageBoard: true, snapshotHz: 10, metaOnDemand: true, terminalOnce: true },
    { data: DATA, cloneOutput: false });
  const out = [];
  for (let i = 0; i < 20000; i++) {
    const o = eng.advance(chunk(i), { snapshotFields: watched(i) ? [spec.fieldId] : [], syncFields: [spec.fieldId] });
    for (const s of o.syncs || []) out.push([s.tick, s.h, s.done ? 1 : 0]);
    if (o.done) break;
  }
  eng.dispose();
  return out;
}

/** A real normal-round spec: round 3 of a co-op wave with a board of operators. */
function normalSpec(seed = 9101) {
  const m = new Match({
    roomCode: 'SPEC', mode: 'coop', difficulty: 'NORMAL', seed, data: DATA,
    seats: [0, 1].map((seat) => ({ seat, playerId: `p_${seat}`, name: `P${seat}`, isBot: false, connected: true })),
    send: () => true, broadcast: () => {}, onEnd: () => {}, log: QUIET, clientCombat: false, botRehearsal: 0,
  });
  m.phase = 'PREP';
  m.round = 3;
  m.stageId = 'act2autochess_m04';
  m.stage = m.gd.stage(m.stageId);
  m.wave = buildNormalWave(m.gd, m.rngWaves, m.factions, 3);
  const ps = m.order[0];
  ps.bandId = 'band_bldsk';
  ps.invalidateDeployMap();
  for (const id of ['chess_char_1_10_a', 'chess_char_3_01_a', 'chess_char_2_02_a']) give(m, ps, id, 'board', legalTileFor(m, ps, id));
  ps.recompute();
  const spec = specMod.buildBattleSpec({ ...m._normalOpts(ps), content: m.battleContent, boss: null });
  m.dispose();
  return spec;
}

test('syncHash: a uint32 of the state after a step; sync steps every SYNC_TICKS and the finishing one; −0 / NaN normalized', () => {
  const spec = normalSpec();
  const b = specMod.createBattleFromSpec(clone(spec), DS, { logger: QUIET });
  const h0 = stateHash(b);
  assert.ok(Number.isInteger(h0) && h0 >= 0 && h0 < 2 ** 32);
  assert.equal(stateHash(b), h0, 'reading it changes nothing');
  assert.equal(isSyncTick(b), false, 'not before the first step');
  for (let i = 0; i < SYNC_TICKS - 1; i++) { b.step(); assert.equal(isSyncTick(b), false); }
  b.step();
  assert.equal(b.tickCount, SYNC_TICKS);
  assert.equal(isSyncTick(b), true);
  const u = b.units.find((x) => x.alive && x.deployed) || b.units[0];
  const before = stateHash(b);
  const hp = u.hp;
  u.hp = hp + 1e-9;
  assert.notEqual(stateHash(b), before, 'a last-bit HP difference changes the digest');
  u.hp = hp;
  const x = u.x;
  u.x = 0; const pos = stateHash(b); u.x = -0;
  assert.equal(stateHash(b), pos, '−0 digests as +0');
  u.x = x;
  assert.equal(stateHash(b), before);
  const done = localDigests(spec);
  assert.equal(done[done.length - 1][2], 1, 'the finishing step is a sync step');
  assert.ok(done.slice(0, -1).every(([t, , d]) => t % SYNC_TICKS === 0 && d === 0));
});

test('CombatEngine: synced fields digest after their steps — the same with or without watchers, chunking or browser-side snapshots', () => {
  const spec = normalSpec(9102);
  const plain = engineDigests(spec);
  assert.ok(plain.length > 5, `digests (${plain.length})`);
  assert.deepEqual(engineDigests(spec, { watched: () => true, chunk: (i) => 1 + (i * 7) % 31 }), plain, 'snapshots for watchers change nothing');
  assert.deepEqual(engineDigests(spec, { watched: (i) => i % 2 === 0, chunk: (i) => 1 + (i % 5) }), plain);
  assert.deepEqual(localDigests(spec), plain, 'a spec battle stepped alone gives the Worker digests');
  assert.deepEqual(localDigests(spec, { observe: true }), plain, 'and still with snapshots between its steps');
  // no digests unless asked for
  const eng = new CombatEngine({ specs: [spec], wireFrames: true }, { data: DATA, cloneOutput: false });
  const o = eng.advance(SYNC_TICKS * 2, { snapshotFields: [] });
  assert.equal(o.syncs, undefined);
  eng.dispose();
});

test('protocol: g.sim and b.sync; b.start is compressed', () => {
  assert.equal(validateC2S({ t: 'g.sim', local: true }), null);
  assert.equal(validateC2S({ t: 'g.sim', battleId: 'a.1.2.n:p_0', stream: true, tick: 120 }), null);
  assert.equal(validateC2S({ t: 'g.sim', battleId: 'a.1.2.n:p_0', stream: true }), null);
  assert.notEqual(validateC2S({ t: 'g.sim', stream: 'yes' }), null);
  assert.notEqual(validateC2S({ t: 'g.sim', tick: -1 }), null);
  assert.ok(S2C.includes('b.sync') && S2C.includes('b.ext'));
  assert.equal(isCompressibleType('b.start'), true);
  assert.equal(isCompressibleType('b.sync'), false);
});

// ---- the Match with a real combat Worker pool ------------------------------------------------------------------------

async function realPool(t) {
  const pool = new CombatWorkerPool({ size: 1, data: DATA, log: QUIET });
  t.after(() => pool.close());
  await pool.start();
  return pool;
}

function fixture(t, pool, { speed = 20, localReplica, timeLimit = 40 } = {}) {
  const sent = [];
  const m = new Match({
    roomCode: 'LOCL', mode: 'coop', difficulty: 'NORMAL', seed: 733, data: DATA,
    seats: [0, 1].map((seat) => ({ seat, playerId: `p_${seat}`, name: `P${seat}`, isBot: false, connected: true })),
    send: (pid, msg) => { sent.push([pid, clone(msg)]); return true; },
    broadcast: () => {}, onEnd: () => {}, log: QUIET, timerScale: 0.02, combatSpeed: speed, botRehearsal: 0,
    clientCombat: false, verify: 'off', combatPool: pool, afkRemoveRounds: 0,
    ...(localReplica != null ? { localReplica } : {}),
  });
  t.after(() => m.dispose());
  m.phase = 'PREP';
  m.round = 1;
  m.stageId = 'act2autochess_m04';
  m.stage = m.gd.stage(m.stageId);
  m.wave = { ...buildNormalWave(m.gd, m.rngWaves, m.factions, 1), timeLimit };
  for (const ps of m.order) {
    ps.lp = 40;
    ps.bandId = 'band_bldsk';
    ps.invalidateDeployMap();
    for (const id of ['chess_char_1_10_a', 'chess_char_3_01_a']) give(m, ps, id, 'board', legalTileFor(m, ps, id));
    ps.recompute();
  }
  const to = (pid, type) => sent.filter(([p, msg]) => p === pid && msg.t === type).map(([, msg]) => msg);
  const fieldFrames = (pid, fieldId) => sent.filter(([p, msg]) => p === pid && (msg.t === 'b.snap' || msg.t === 'b.ev' || msg.t === 'm.field') && msg.fieldId === fieldId);
  return { m, sent, to, fieldFrames };
}

test('workers: a declared player gets its own field as b.start { local } (no stream), b.sync digests equal its own replica; the rest is streamed; the Worker stays the authority', { timeout: 60_000 }, async (t) => {
  const pool = await realPool(t);
  const { m, to, fieldFrames } = fixture(t, pool);
  assert.equal(m.publicView().localReplica, true, 'm.public.localReplica');
  assert.deepEqual(m.handle('p_0', { t: 'g.sim', local: true }), { ok: true });
  m.startCombat();
  const starts = to('p_0', 'b.start');
  assert.equal(starts.length, 1);
  const st = starts[0];
  const own = m.fields.find((f) => f.fieldId === 'n:p_0');
  assert.equal(st.fieldId, 'n:p_0');
  assert.equal(st.local, true);
  assert.equal(st.authoritative, false);
  assert.equal(st.battleId, own.battleId);
  assert.deepEqual(st.spec, own.spec, 'the very spec the Worker runs');
  assert.equal(to('p_1', 'b.start').length, 0, 'an undeclared browser is streamed');
  await until(() => m.phase !== 'COMBAT', 'combat ended');
  assert.deepEqual(fieldFrames('p_0', 'n:p_0'), [], 'its own field is never streamed to it');
  assert.ok(fieldFrames('p_1', 'n:p_1').some(([, x]) => x.t === 'b.snap'), 'the other player is streamed as before');
  const syncs = to('p_0', 'b.sync');
  assert.ok(syncs.length > 3 && syncs.every((s) => s.battleId === own.battleId), `b.sync (${syncs.length})`);
  assert.equal(to('p_1', 'b.sync').length, 0);
  assert.equal(syncs[syncs.length - 1].done, true, 'the finishing step');
  assert.deepEqual(syncs.map((s) => [s.tick, s.h, s.done ? 1 : 0]), localDigests(st.spec, { observe: true }),
    'the browser replica of the received spec gives every Worker digest');
  assert.ok(m.lastResults.get('p_0') && !m.lastResults.get('p_0').synthetic, 'the result is the Worker battle');
});

test('workers: g.sim stream / a reconnect / watching a teammate and back / local off / an eliminated follower / the kill switch', { timeout: 60_000 }, async (t) => {
  const pool = await realPool(t);
  {
    const { m, to, fieldFrames } = fixture(t, pool, { speed: 2, timeLimit: 120 });
    m.handle('p_0', { t: 'g.sim', local: true });
    m.handle('p_1', { t: 'g.sim', local: true });
    m.startCombat();
    const st0 = to('p_0', 'b.start')[0];
    await until(() => to('p_0', 'b.sync').length >= 1, 'a first b.sync');
    // a reconnect re-sends the b.start (the browser keeps or rebuilds its replica), never the stream
    m.onDisconnect('p_0');
    m.onReconnect('p_0');
    const again = to('p_0', 'b.start');
    assert.equal(again.length, 2);
    assert.equal(again[1].battleId, st0.battleId);
    assert.ok(again[1].elapsed > 0, 'from the field clock');
    // watching the teammate: a local replica of its field too (b.start watch: true, then its digests, never its
    // stream); 返回战场 re-shows the own replica
    assert.deepEqual(m.handle('p_0', { t: 'g.watch', fieldId: 'n:p_1' }), { ok: true });
    const mate = to('p_0', 'b.start')[2];
    assert.deepEqual([mate.fieldId, mate.local, mate.watch], ['n:p_1', true, true]);
    assert.deepEqual(mate.spec, m.fields.find((f) => f.fieldId === 'n:p_1').spec);
    await until(() => to('p_0', 'b.sync').some((x) => x.battleId === mate.battleId), 'the teammate field\'s digests');
    assert.deepEqual(fieldFrames('p_0', 'n:p_1'), [], 'the watched field is not streamed');
    m.handle('p_0', { t: 'g.watch', fieldId: 'n:p_0' });
    assert.equal(to('p_0', 'b.start').length, 4);
    assert.deepEqual(fieldFrames('p_0', 'n:p_0'), []);
    // the replica diverged: b.end stream, then the field is streamed from its current state on
    assert.deepEqual(m.handle('p_0', { t: 'g.sim', battleId: st0.battleId, stream: true, tick: 120 }), { ok: true });
    const end = to('p_0', 'b.end');
    assert.deepEqual(end.map((x) => [x.battleId, x.reason]), [[st0.battleId, 'stream']]);
    await until(() => fieldFrames('p_0', 'n:p_0').some(([, x]) => x.t === 'b.snap'), 'own field streamed');
    assert.ok(fieldFrames('p_0', 'n:p_0').some(([, x]) => x.t === 'm.field'), 'with its meta first');
    assert.equal(m.localStats.diverged, 1);
    const syncsAt = to('p_0', 'b.sync').length;
    // never offered again for this field
    m.handle('p_0', { t: 'g.watch', fieldId: 'n:p_0' });
    assert.equal(to('p_0', 'b.start').length, 4);
    await delay(1200);
    assert.equal(to('p_0', 'b.sync').length, syncsAt, 'no digests for a streamed field');
    // g.sim { local: false } (a slow device): the other player's replica goes back to the stream too
    m.handle('p_1', { t: 'g.sim', local: false });
    assert.deepEqual(to('p_1', 'b.end').map((x) => x.reason), ['stream']);
    assert.equal(m.localStats.off, 1);
    await until(() => fieldFrames('p_1', 'n:p_1').some(([, x]) => x.t === 'b.snap'), 'p_1 streamed');
    m.runner.forceAll('forced');
  }
  {
    // an eliminated player follows a field as a local replica; a spectator seat is always streamed
    const { m, to, fieldFrames } = fixture(t, pool, { speed: 2, timeLimit: 120 });
    m.order[1].alive = false;
    m.handle('p_1', { t: 'g.sim', local: true });
    m.addSpectator('watcher_0');
    m.startCombat();
    const follow = to('p_1', 'b.start');
    assert.deepEqual(follow.map((x) => [x.fieldId, x.local, x.watch]), [['n:p_0', true, true]]);
    assert.equal(to('watcher_0', 'b.start').length, 0);
    await until(() => fieldFrames('watcher_0', 'n:p_0').some(([, x]) => x.t === 'b.snap'), 'the spectator seat is streamed');
    await until(() => to('p_1', 'b.sync').length >= 1, 'the follower\'s digests');
    assert.deepEqual(fieldFrames('p_1', 'n:p_0'), []);
    m.runner.forceAll('forced');
  }
  {
    const { m, to } = fixture(t, pool, { localReplica: false });
    assert.equal(m.publicView().localReplica, false);
    m.handle('p_0', { t: 'g.sim', local: true });
    m.startCombat();
    assert.equal(to('p_0', 'b.start').length, 0, 'SP_LOCAL_REPLICA=0 streams everything');
    m.runner.forceAll('forced');
  }
});

// ---- the browser runner ----------------------------------------------------------------------------------------------

function fakeNet() {
  const handlers = new Map();
  const n = {
    sent: [],
    on(t, fn) { if (!handlers.has(t)) handlers.set(t, new Set()); handlers.get(t).add(fn); return () => handlers.get(t).delete(fn); },
    emit(t, msg) { for (const fn of handlers.get(t) || []) fn({ t, ...msg }); },
    send(t, fields) { const msg = { ...fields, t }; assert.equal(validateC2S(msg), null, `invalid ${t}`); n.sent.push(msg); return true; },
    request(t, fields) { const msg = { ...fields, t, rid: 1 }; assert.equal(validateC2S(msg), null, `invalid ${t}`); n.sent.push(msg); return Promise.resolve({ t: 'ok' }); },
  };
  return n;
}

function rig({ stepCostMs = 0, loads = null, ...deps } = {}) {
  const clock = { t: 1000 };
  const frames = [];
  const net = fakeNet();
  const store = createStore(initialState);
  // a slow device: every step costs `stepCostMs` of the (manual) clock
  const spec = stepCostMs ? { ...specMod, createBattleFromSpec: (...a) => {
    const b = specMod.createBattleFromSpec(...a);
    const step = b.step.bind(b);
    b.step = () => { clock.t += stepCostMs; step(); };
    return b;
  } } : specMod;
  const runner = createBattleRunner({
    net, store, doc: null, now: () => clock.t,
    raf: (fn) => { frames.push(fn); return frames.length; }, caf() {}, setInterval: () => 1, clearInterval() {},
    loadSim: async (content) => { loads?.push(content?.cs ?? null); return { spec, ds: DS, sync: syncMod }; },
    logger: QUIET,
    ...deps,
  });
  return {
    runner, net, store, clock,
    advance(ms, step = 1000 / 60) {
      const end = clock.t + ms;
      while (clock.t < end) { clock.t = Math.min(end, clock.t + step); for (const fn of frames.splice(0)) fn(clock.t); }
    },
    async settle() { for (let i = 0; i < 50; i++) { await new Promise((res) => setImmediate(res)); for (const fn of frames.splice(0)) fn(clock.t); } },
  };
}

const startOf = (spec, extra = {}) => ({ battleId: 'x.1.1.n:p_0', fieldId: spec.fieldId, kind: 'normal', spec, authoritative: false,
  startAt: 0, serverNow: 0, elapsed: 0, speed: 2, watch: false, done: false, local: true, ...extra });

test('runner: b.sync digests that match keep the replica; a different digest or end tick sends g.sim stream and drops it; b.end stream drops it', async () => {
  const spec = normalSpec(9103);
  const server = engineDigests(spec);
  // matching digests, delivered before and after the replica reaches them
  {
    const r = rig();
    r.net.emit('b.start', startOf(spec));
    await r.settle();
    const e = r.runner._entries.get('x.1.1.n:p_0');
    assert.ok(e && e.replica && r.store.get().match.field.local === true);
    server.forEach(([tick, h, done], i) => { if (i % 2) r.net.emit('b.sync', { battleId: e.battleId, tick, h, ...(done ? { done } : {}) }); });
    for (let i = 0; i < 400 && !e.battle.finished; i++) r.advance(1000, 25);
    server.forEach(([tick, h, done], i) => { if (!(i % 2)) r.net.emit('b.sync', { battleId: e.battleId, tick, h, ...(done ? { done } : {}) }); });
    assert.equal(e.synced, server.length, 'every digest compared and equal');
    assert.equal(r.net.sent.filter((x) => x.t === 'g.sim').length, 0);
    assert.ok(r.runner._entries.has(e.battleId));
    r.runner.dispose();
  }
  // a different digest
  {
    const r = rig();
    r.net.emit('b.start', startOf(spec));
    await r.settle();
    const e = r.runner._entries.get('x.1.1.n:p_0');
    const [tick, h] = server[1];
    r.net.emit('b.sync', { battleId: e.battleId, tick, h: (h ^ 4) >>> 0 });
    r.advance(4000);
    assert.deepEqual(r.net.sent.filter((x) => x.t === 'g.sim').map((x) => [x.battleId, x.stream, x.tick]), [[e.battleId, true, tick]]);
    assert.equal(r.runner._entries.has(e.battleId), false, 'dropped');
    assert.equal(r.runner.state(), null);
    // a late b.start of it is not run again
    r.net.emit('b.start', startOf(spec, { elapsed: 10 }));
    await r.settle();
    assert.equal(r.runner._entries.has(e.battleId), false);
    assert.equal(r.net.sent.filter((x) => x.t === 'g.sim').length, 2, 'asked for the stream again');
    r.runner.dispose();
  }
  // the server's battle ended earlier
  {
    const r = rig();
    r.net.emit('b.start', startOf(spec));
    await r.settle();
    const e = r.runner._entries.get('x.1.1.n:p_0');
    r.net.emit('b.sync', { battleId: e.battleId, tick: 90, h: 1, done: true });
    r.advance(3000);
    assert.deepEqual(r.net.sent.filter((x) => x.t === 'g.sim').map((x) => x.tick), [90]);
    assert.equal(r.runner._entries.has(e.battleId), false);
    r.runner.dispose();
  }
  // b.end stream (the server switched it): dropped, nothing sent
  {
    const r = rig();
    r.net.emit('b.start', startOf(spec));
    await r.settle();
    r.net.emit('b.end', { battleId: 'x.1.1.n:p_0', fieldId: spec.fieldId, reason: 'stream' });
    assert.equal(r.runner._entries.has('x.1.1.n:p_0'), false);
    assert.equal(r.net.sent.length, 0);
    r.runner.dispose();
  }
});

test('runner: a room of another official version declares on that version\'s sim, never the original content\'s', async () => {
  const cs = 'ab'.repeat(32);
  const loads = [];
  const r = rig({ loads, vanillaCs: () => 'cd'.repeat(32), simContent: () => ({ cs }), contentFor: async (x) => ({ cs: x, version: 'act1autochess' }) });
  r.store.patch('me', { playerId: 'p_0' });
  r.store.patch('room', { version: 'act1autochess', content: { cs, vanilla: true, version: 'act1autochess' } });
  r.store.patch('match', { public: { matchId: 'm1', phase: 'PREP', localReplica: true, players: [{ playerId: 'p_0' }] } });
  await r.settle();
  assert.equal(r.net.sent.filter((x) => x.t === 'g.sim' && x.local === true).length, 1);
  assert.ok(loads.length >= 1 && loads.every((x) => x === cs), JSON.stringify(loads));
  r.runner.dispose();
});

test('runner: a replica too slow for its battle asks for g.sim { local: false } once and stops declaring', async () => {
  const spec = normalSpec(9104);
  const r = rig({ stepCostMs: SLOW_TICK_MS * 2 });
  r.net.emit('b.start', startOf(spec));
  await r.settle();
  for (let i = 0; i < 200 && r.runner._entries.size; i++) r.advance(100, 1000 / 60);
  assert.equal(r.runner._entries.size, 0, 'dropped');
  assert.deepEqual(r.net.sent.filter((x) => x.t === 'g.sim').map((x) => x.local), [false]);
  r.store.patch('me', { playerId: 'p_0' });
  r.store.patch('match', { public: { matchId: 'mm', phase: 'PREP', localReplica: true, players: [{ playerId: 'p_0' }] } });
  await r.settle();
  assert.equal(r.net.sent.filter((x) => x.t === 'g.sim').length, 1, 'no new declaration');
  r.runner.dispose();
});

test('runner: declares g.sim { local: true } once per match and connection when m.public.localReplica, the seat plays and the sim loaded', async () => {
  const r = rig();
  const decl = () => r.net.sent.filter((x) => x.t === 'g.sim' && x.local === true).length;
  r.store.patch('me', { playerId: 'p_0' });
  r.store.patch('match', { public: { matchId: 'm1', phase: 'PREP', localReplica: false, players: [{ playerId: 'p_0' }] } });
  await r.settle();
  assert.equal(decl(), 0, 'not offered by the server');
  r.store.patch('match', { public: { matchId: 'm1', phase: 'PREP', localReplica: true, players: [{ playerId: 'p_1' }] } });
  await r.settle();
  assert.equal(decl(), 0, 'a spectator seat never declares');
  r.store.patch('match', { public: { matchId: 'm1', phase: 'PREP', localReplica: true, players: [{ playerId: 'p_0' }] } });
  await r.settle();
  assert.equal(decl(), 1);
  r.store.patch('match', { public: { matchId: 'm1', phase: 'COMBAT', localReplica: true, players: [{ playerId: 'p_0' }] } });
  await r.settle();
  assert.equal(decl(), 1, 'once per match');
  r.net.emit('status', { status: 'online' });
  await r.settle();
  assert.equal(decl(), 2, 'again on a (re)connection');
  r.net.emit('status', { status: 'online', ping: 30 });
  await r.settle();
  assert.equal(decl(), 2, 'not on every ping');
  r.net.emit('status', { status: 'reconnecting' });
  r.net.emit('status', { status: 'online' });
  await r.settle();
  assert.equal(decl(), 3, 'again after a reconnect');
  r.store.patch('match', { public: { matchId: 'm2', phase: 'INFO_CHECK', localReplica: true, players: [{ playerId: 'p_0' }] } });
  await r.settle();
  assert.equal(decl(), 4, 'a new match');
  r.runner.dispose();
});
