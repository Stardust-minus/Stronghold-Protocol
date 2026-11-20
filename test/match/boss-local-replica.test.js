// Boss / hidden local display replicas under server-run combat (DESIGN §14 "Local display replicas"; server/match/combat/
// engine.js _beforeStep, server/match/combat/runner.js extFor / b.ext, server/sim/spec.js ReplayBossPool,
// public/js/battle/runner.js): every boss field of a phase steps in one Worker against one shared pool, so a browser's
// replica of one field also replays the Worker's record of that pool — the values other fields left it at before each
// step and the end the Worker forced — and then gives every Worker digest. Without the record it does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Match } from '../../server/match/Match.js';
import { seedSecret } from '../../server/match/secret.js';
import { CombatWorkerPool } from '../../server/match/combat/pool.js';
import { CombatEngine } from '../../server/match/combat/engine.js';
import { EXT_MIN_GAP_MS } from '../../server/match/combat/runner.js';
import { TICK } from '../../server/sim/constants.js';
import { isSyncTick, stateHash } from '../../server/sim/syncHash.js';
import * as specMod from '../../server/sim/spec.js';
import * as syncMod from '../../server/sim/syncHash.js';
import { DataSource } from '../../server/sim/simdata.js';
import { createBattleRunner, EXT_LAG_MIN_MS } from '../../public/js/battle/runner.js';
import { createStore, initialState } from '../../public/js/store.js';
import { validateC2S, S2C } from '../../shared/protocol.js';
import { isCompressibleType } from '../../server/wsCompression.js';
import { DATA, give, legalTileFor } from './harness.js';

const DS = new DataSource(DATA, null);
const QUIET = { info() {}, warn() {}, debug() {}, error() {} };
const clone = (x) => structuredClone(x);
const STRONG = ['chess_char_4_17_b', 'chess_char_6_18_b', 'chess_char_6_20_b'];

async function until(predicate, label, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await delay(5);
  }
}

/** A Match at the boss round's PREP: `count` human seats, boards of STRONG operators unless `empty`. */
function bossMatch({ count = 4, hidden = false, empty = false, lp = 40, smallPool = true, seed = 731, pool = null, send = () => true, speed = 2 } = {}) {
  const m = new Match({
    roomCode: 'BREP', mode: 'coop', difficulty: 'NORMAL', seed, matchSecret: seedSecret(seed), data: DATA,
    seats: Array.from({ length: count }, (_, seat) => ({ seat, playerId: `p_${seat}`, name: `P${seat}`, isBot: false, connected: true })),
    send, broadcast: () => {}, onEnd: () => {}, log: QUIET, timerScale: 0.02, combatSpeed: speed, botRehearsal: 0,
    clientCombat: false, verify: 'off', combatPool: pool, afkRemoveRounds: 0,
  });
  m.phase = 'PREP'; m.round = hidden ? m.gd.hiddenRound : m.gd.bossRound;
  m.stageId = 'act2autochess_m04'; m.stage = m.gd.stage(m.stageId);
  m.bossId = 'boss_3'; m.hiddenBossId = 'boss_8'; m.hiddenLayerSum = 0;
  const id = hidden ? m.hiddenBossId : m.bossId;
  if (smallPool) m.gd.raw = { ...m.gd.raw, bosses: { ...m.gd.raw.bosses, [id]: { ...m.gd.boss(id), bloodPoint: { NORMAL: 10000 } } } };
  for (const ps of m.order) {
    ps.lp = lp; ps.bandId = 'band_bldsk'; ps.round = m.round;
    ps.invalidateDeployMap();
    if (!empty) for (const cid of STRONG) give(m, ps, cid, 'board', legalTileFor(m, ps, cid));
    ps.recompute();
    if (hidden) ps.lpAtFinal = ps.lp;
  }
  if (hidden) { m.hiddenReached = true; m.teamLp = count * lp; }
  return m;
}

/** The specs and the shared boss config one boss phase hands its Worker (captured from WorkerFieldRunner.start). */
function bossPhase(opts = {}) {
  let cfg = null;
  const pool = { create(c) { cfg = c; return { ready: new Promise(() => {}), request: () => new Promise(() => {}), close() {} }; } };
  const m = bossMatch({ ...opts, pool });
  m.startFinalAssault(!!opts.hidden);
  m.dispose();
  assert.ok(cfg && cfg.specs.length >= 1 && cfg.boss);
  return { specs: cfg.specs, boss: cfg.boss };
}

/**
 * The Worker side: one CombatEngine over every boss field, all synced. Returns the digests per field, the replies' pool
 * records (`{ to, ext }` per reply, as the main thread forwards them) and the results. `force`: (i) → a field to force.
 */
function runWorker({ specs, boss }, { chunk = () => 32, force = () => null } = {}) {
  const eng = new CombatEngine({ specs, boss, wireFrames: true, coalesceFrames: true, damageBoard: true, snapshotHz: 10, metaOnDemand: true, terminalOnce: true },
    { data: DATA, cloneOutput: false });
  const syncs = new Map(specs.map((s) => [s.fieldId, []]));
  const replies = [];
  const results = new Map();
  const take = (o) => {
    for (const s of o.syncs || []) syncs.get(s.fieldId).push([s.tick, s.h, s.done ? 1 : 0]);
    replies.push({ to: o.ticks, ext: clone(o.ext || []) });
    for (const f of o.fields) if (f.result) results.set(f.fieldId, f.result);
  };
  for (let i = 0; i < 40000; i++) {
    const fid = force(i);
    if (fid) take(eng.forceField(fid, 'left'));
    const o = eng.advance(chunk(i), { snapshotFields: [], syncFields: specs.map((s) => s.fieldId) });
    take(o);
    if (o.done) break;
  }
  eng.dispose();
  return { syncs, replies, results };
}

/** The browser side of one field: its spec with a ReplayBossPool fed reply by reply (or no record: a LocalBossPool). */
function replay(spec, replies, { record = true } = {}) {
  const pool = record ? new specMod.ReplayBossPool(spec.boss.poolMax, spec.boss.poolHp) : null;
  const b = specMod.createBattleFromSpec(clone(spec), DS, record ? { logger: QUIET, sharedBoss: pool } : { logger: QUIET });
  const out = [];
  let n = 0;
  const run = (limit) => {
    while (!b.finished && b.tickCount < limit && (!pool || pool.ready(b.tickCount + 1))) {
      if (pool) pool.enter(b.tickCount + 1);
      b.step();
      if (isSyncTick(b)) out.push([b.tickCount, stateHash(b), b.finished ? 1 : 0]);
      const end = pool && pool.endAfter(b.tickCount);
      if (end && !b.finished) b.forceEnd(end.reason);
      // a browser renders between its steps
      if (b.tickCount % 3 === 0) { b.snapshot(); b.drainEvents(); }
    }
  };
  for (const r of replies) {
    if (pool) {
      const x = r.ext.find((e) => e.fieldId === spec.fieldId);
      assert.equal(pool.feed(n, r.to, x ? x.hp : [], x && x.end), true);
      n += x ? x.hp.length : 0;
      // an end forced between two replies, after the step the replica already took (runner.js feedExt)
      if (pool.end && !b.finished && b.tickCount === pool.end.tick) b.forceEnd(pool.end.reason);
    }
    run(r.to);
  }
  if (!pool) run(Infinity);
  return { digests: out, battle: b, pool };
}

test('protocol: b.ext is an S→C frame, compressed; ping may ask for the whole cluster summary', () => {
  assert.ok(S2C.includes('b.ext'));
  assert.equal(isCompressibleType('b.ext'), true);
  assert.equal(validateC2S({ t: 'ping', c: 1, full: true }), null);
  assert.notEqual(validateC2S({ t: 'ping', c: 1, full: 'yes' }), null);
});

test('ReplayBossPool: SharedBossPool arithmetic on the fed values; the record must be gapless and well-formed', () => {
  const p = new specMod.ReplayBossPool(100, 100);
  assert.equal(p.ready(1), false, 'nothing covered yet');
  assert.equal(p.feed(0, 3, [[2, 90]]), true);
  assert.equal(p.ready(3), true);
  assert.equal(p.ready(4), false);
  p.enter(1);
  assert.equal(p.hp, 100);
  assert.equal(p.damage('a', 5), 5);
  p.enter(2);
  assert.equal(p.hp, 90, 'the Worker value before step 2');
  assert.equal(p.damage('a', 80), 80);
  assert.equal(p.damage('b', 9.5), 10, 'a hit that would leave less than 1 takes the rest');
  assert.equal(p.hp, 0);
  assert.equal(p.damage('b', 3), 0, 'an empty pool takes nothing');
  assert.deepEqual([...p.byPlayer], [['a', 85], ['b', 10]]);
  // a resend from index 0 skips what is held; a later batch must start where the last one ended
  assert.equal(p.feed(0, 5, [[2, 90], [5, 40]]), true);
  assert.equal(p.count, 2);
  assert.equal(p.feed(3, 6, [[7, 1]]), false, 'a gap');
  assert.equal(new specMod.ReplayBossPool(10).feed(0, 2, [[1, null]]), false, 'a non-finite value');
  const e = new specMod.ReplayBossPool(10);
  assert.equal(e.feed(0, 9, [], { tick: 7, reason: 'forced' }), true);
  assert.equal(e.ready(8), false, 'nothing after the forced end');
  assert.deepEqual(e.endAfter(7), { tick: 7, reason: 'forced' });
});

for (const hidden of [false, true]) {
  test(`${hidden ? 'hidden' : 'boss'} fields: each replica fed the Worker's pool record gives every Worker digest and result, whatever the reply sizes; without it they differ`, { timeout: 120_000 }, () => {
    const phase = bossPhase({ count: 4, hidden });
    assert.equal(phase.specs.length, 2, 'two pair fields on one pool');
    const a = runWorker(phase, { chunk: () => 32 });
    const b = runWorker(phase, { chunk: (i) => 1 + (i * 7) % 31 });
    for (const spec of phase.specs) {
      assert.deepEqual(b.syncs.get(spec.fieldId), a.syncs.get(spec.fieldId), 'the Worker battle does not depend on its reply sizes');
      const r = replay(spec, a.replies);
      assert.ok(a.syncs.get(spec.fieldId).length > 3);
      assert.deepEqual(r.digests, a.syncs.get(spec.fieldId), `${spec.fieldId}: every digest`);
      assert.equal(specMod.resultDigest(r.battle.result()).hash, specMod.resultDigest(a.results.get(spec.fieldId)).hash, `${spec.fieldId}: the result`);
      assert.deepEqual(replay(spec, b.replies).digests, r.digests, 'the record of other reply sizes replays the same');
    }
    assert.ok(a.replies.some((x) => x.ext.some((e) => e.hp.length)), 'the other field changed the pool between steps');
    const bare = phase.specs.map((spec) => replay(spec, a.replies, { record: false }).digests);
    assert.ok(phase.specs.some((spec, i) => JSON.stringify(bare[i]) !== JSON.stringify(a.syncs.get(spec.fieldId))),
      'a replica that only sees its own hits drifts from the Worker');
  });
}

test('forced ends: team LP 0 (onTick forceAll) and a forced field between replies end the replica after the same step', { timeout: 120_000 }, () => {
  // empty boards and little LP: the leaks end the phase on the team LP
  const lpOut = bossPhase({ count: 4, empty: true, lp: 2, smallPool: false });
  const w = runWorker(lpOut);
  for (const spec of lpOut.specs) {
    const ends = w.replies.flatMap((x) => x.ext.filter((e) => e.fieldId === spec.fieldId && e.end)).map((e) => e.end);
    assert.equal(ends.length, 1, 'one end in the record');
    assert.equal(ends[0].reason, 'forced');
    const r = replay(spec, w.replies);
    assert.equal(r.battle.finished, true);
    assert.equal(r.battle.tickCount, ends[0].tick);
    assert.deepEqual(r.digests, w.syncs.get(spec.fieldId));
    assert.equal(specMod.resultDigest(r.battle.result()).hash, specMod.resultDigest(w.results.get(spec.fieldId)).hash);
  }
  // a field forced while the other one fights on (a forceField command between two replies)
  const both = bossPhase({ count: 4 });
  const first = both.specs[0].fieldId;
  const f = runWorker(both, { chunk: () => 7, force: (i) => (i === 40 ? first : null) });
  const end = f.replies.flatMap((x) => x.ext.filter((e) => e.fieldId === first && e.end)).map((e) => e.end)[0];
  assert.deepEqual(end, { tick: 40 * 7, reason: 'left' });
  for (const spec of both.specs) {
    const r = replay(spec, f.replies);
    assert.deepEqual(r.digests, f.syncs.get(spec.fieldId), spec.fieldId);
    assert.equal(specMod.resultDigest(r.battle.result()).json, specMod.resultDigest(f.results.get(spec.fieldId)).json, spec.fieldId);
  }
});

// ---- the Match with a real combat Worker pool ------------------------------------------------------------------------

test('workers: a declared player\'s boss field arrives as b.start { local, ext } then b.ext; replaying them gives every b.sync; it is never streamed', { timeout: 120_000 }, async (t) => {
  const pool = new CombatWorkerPool({ size: 1, data: DATA, log: QUIET });
  t.after(() => pool.close());
  await pool.start();
  const sent = [];
  const m = bossMatch({ count: 4, pool, speed: 50, send: (pid, msg) => { sent.push([pid, clone(msg)]); return true; } });
  t.after(() => m.dispose());
  const to = (pid, type) => sent.filter(([p, msg]) => p === pid && msg.t === type).map(([, msg]) => msg);
  m.handle('p_0', { t: 'g.sim', local: true });
  m.startFinalAssault(false);
  const own = m.fields.find((f) => f.players.includes('p_0'));
  const other = m.fields.find((f) => !f.players.includes('p_0'));
  const st = to('p_0', 'b.start');
  assert.equal(st.length, 1);
  assert.equal(st[0].local, true);
  assert.equal(st[0].kind, 'boss');
  assert.equal(st[0].fieldId, own.fieldId);
  assert.deepEqual(st[0].ext, { i: 0, to: 0, hp: [] }, 'the record so far: nothing yet');
  assert.equal(to('p_1', 'b.start').length, 0, 'an undeclared browser is streamed');
  await until(() => m.ended || m.phase !== 'FINAL_ASSAULT', 'the boss phase ended', 90_000);
  const exts = to('p_0', 'b.ext');
  assert.ok(exts.length > 3, `b.ext (${exts.length})`);
  let n = 0, last = 0;
  for (const x of exts) {
    assert.equal(x.battleId, own.battleId);
    assert.equal(x.i, n, 'gapless');
    assert.ok(x.to >= last, 'watermark never goes back');
    n += x.hp.length; last = x.to;
  }
  assert.equal(sent.filter(([p, msg]) => p === 'p_0' && (msg.t === 'b.snap' || msg.t === 'b.ev') && msg.fieldId === own.fieldId).length, 0, 'never streamed');
  assert.ok(sent.some(([p, msg]) => p === 'p_1' && msg.t === 'b.snap'), 'the undeclared one is');
  // the browser's replica of what it received
  const replies = [{ to: st[0].ext.to, ext: [{ fieldId: own.fieldId, hp: st[0].ext.hp }] },
    ...exts.map((x) => ({ to: x.to, ext: [{ fieldId: own.fieldId, hp: x.hp, ...(x.end ? { end: x.end } : {}) }] }))];
  const r = replay(own.spec, replies);
  const syncs = to('p_0', 'b.sync').filter((s) => s.battleId === own.battleId).map((s) => [s.tick, s.h, s.done ? 1 : 0]);
  assert.ok(syncs.length > 2, `b.sync (${syncs.length})`);
  assert.deepEqual(r.digests.filter(([tick]) => syncs.some(([s]) => s === tick)), syncs, 'every Worker digest');
  assert.ok(other.battle.result(), 'the Worker ran the other field too');
});

test('workers: a reconnect re-sends the whole record from index 0 in the b.start; b.ext then continues right after it', { timeout: 120_000 }, async (t) => {
  const pool = new CombatWorkerPool({ size: 1, data: DATA, log: QUIET });
  t.after(() => pool.close());
  await pool.start();
  const sent = [];
  const m = bossMatch({ count: 4, pool, speed: 1, smallPool: false, seed: 701, send: (pid, msg) => { sent.push([pid, clone(msg)]); return true; } });
  t.after(() => m.dispose());
  const to = (pid, type) => sent.filter(([p, msg]) => p === pid && msg.t === type).map(([, msg]) => msg);
  m.handle('p_0', { t: 'g.sim', local: true });
  m.startFinalAssault(false);
  await until(() => to('p_0', 'b.ext').some((x) => x.hp.length), 'a first record entry');
  const before = to('p_0', 'b.ext').reduce((sum, x) => sum + x.hp.length, 0);
  m.onDisconnect('p_0');
  m.onReconnect('p_0');
  const again = to('p_0', 'b.start').at(-1);
  assert.equal(again.local, true);
  assert.equal(again.ext.i, 0);
  assert.ok(again.ext.hp.length >= before, 'the whole record so far');
  assert.ok(again.ext.to > 0);
  const at = sent.findIndex(([p, msg]) => p === 'p_0' && msg === again);
  const later = () => sent.slice(at + 1).filter(([p, msg]) => p === 'p_0' && msg.t === 'b.ext').map(([, msg]) => msg);
  await until(() => later().length >= 2, 'b.ext after the resend');
  assert.equal(later()[0].i, again.ext.hp.length, 'continues right after the resent record');
  assert.ok(EXT_MIN_GAP_MS >= 50);
  m.runner.forceAll('forced');
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

function rig() {
  const clock = { t: 1000 };
  const frames = [];
  const net = fakeNet();
  const store = createStore(initialState);
  const runner = createBattleRunner({
    net, store, doc: null, now: () => clock.t,
    raf: (fn) => { frames.push(fn); return frames.length; }, caf() {}, setInterval: () => 1, clearInterval() {},
    loadSim: async () => ({ spec: specMod, ds: DS, sync: syncMod }), logger: QUIET,
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

/**
 * Play a Worker run to a runner: b.start, then each reply's record as b.ext and its digests as b.sync, arriving `lateMs`
 * (a function of the reply index) after the reply's tick on the field clock. Checks after every frame that the replica
 * never steps past what the record covers.
 */
async function playToRunner(spec, w, { lateMs = () => 80, gap = -1 } = {}) {
  const r = rig();
  const battleId = 'x.10.1.b1';
  r.net.emit('b.start', { battleId, fieldId: spec.fieldId, kind: spec.kind, spec, authoritative: false, startAt: 0, serverNow: 0,
    elapsed: 0, speed: 2, watch: false, done: false, local: true, ext: { i: 0, to: 0, hp: [] } });
  await r.settle();
  const e = r.runner._entries.get(battleId);
  assert.ok(e && e.replica && e.replay, 'a boss replica with its ReplayBossPool');
  const t0 = r.clock.t;
  let n = 0, sentSyncs = 0, past = 0;
  const syncs = w.syncs.get(spec.fieldId);
  for (let k = 0; k < w.replies.length && r.runner._entries.has(battleId); k++) {
    const rep = w.replies[k];
    const at = t0 + (rep.to * TICK / 2) * 1000 + lateMs(k);
    while (r.clock.t < at) { r.advance(Math.min(16, at - r.clock.t)); if (e.battle.tickCount > e.replay.to) past++; }
    const x = rep.ext.find((y) => y.fieldId === spec.fieldId);
    r.net.emit('b.ext', { battleId, i: k === gap ? n + 1 : n, to: rep.to, hp: x ? x.hp : [], ...(x && x.end ? { end: x.end } : {}) });
    n += x ? x.hp.length : 0;
    while (sentSyncs < syncs.length && syncs[sentSyncs][0] <= rep.to) {
      const [tick, h, done] = syncs[sentSyncs++];
      r.net.emit('b.sync', { battleId, tick, h, ...(done ? { done: true } : {}) });
    }
  }
  for (let i = 0; i < 200 && r.runner._entries.has(battleId) && !e.battle.finished; i++) r.advance(100);
  return { r, e, past, syncs };
}

test('runner: a boss replica steps only through the record it has, trails it by an adaptive lag, and matches every digest', { timeout: 120_000 }, async () => {
  const phase = bossPhase({ count: 4 });
  const w = runWorker(phase, { chunk: () => 3 });
  const spec = phase.specs[1];
  const { r, e, past, syncs } = await playToRunner(spec, w, { lateMs: (k) => 60 + (k % 9 === 4 ? 240 : 0) });
  assert.equal(past, 0, 'never past the record');
  assert.equal(r.net.sent.filter((x) => x.t === 'g.sim').length, 0, 'never asked for the stream');
  assert.equal(e.battle.finished, true);
  assert.equal(e.synced, syncs.length, 'every digest compared and equal');
  const minTicks = (EXT_LAG_MIN_MS / 1000) * 2 / TICK;
  assert.ok(e.lag > minTicks + 10, `the 300 ms late records raised the lag (${e.lag} ticks)`);
  r.runner.dispose();
});

test('runner: a forced end in the record ends the replica after that step; a gap or an end it stepped past sends it to the stream', { timeout: 120_000 }, async () => {
  const lpOut = bossPhase({ count: 4, empty: true, lp: 2, smallPool: false });
  const w = runWorker(lpOut, { chunk: () => 3 });
  const spec = lpOut.specs[0];
  {
    const { r, e } = await playToRunner(spec, w);
    const end = w.replies.flatMap((x) => x.ext.filter((y) => y.fieldId === spec.fieldId && y.end)).map((y) => y.end)[0];
    assert.equal(e.battle.finished, true);
    assert.equal(e.battle.tickCount, end.tick);
    assert.equal(e.battle.result().reason, 'forced');
    assert.equal(r.net.sent.filter((x) => x.t === 'g.sim').length, 0);
    r.runner.dispose();
  }
  {
    const { r } = await playToRunner(spec, w, { gap: 5 });
    assert.deepEqual(r.net.sent.filter((x) => x.t === 'g.sim').map((x) => [x.battleId, x.stream]), [['x.10.1.b1', true]]);
    assert.equal(r.runner._entries.size, 0, 'dropped');
    r.runner.dispose();
  }
  {
    // an end at a tick the replica already stepped past cannot be followed
    const r = rig();
    const base = { battleId: 'x.10.2.b1', fieldId: spec.fieldId, kind: spec.kind, spec, authoritative: false, startAt: 0, serverNow: 0, speed: 2, watch: false, done: false, local: true };
    r.net.emit('b.start', { ...base, elapsed: 0, ext: { i: 0, to: 200, hp: [] } });
    await r.settle();
    r.advance(4000);
    const e = r.runner._entries.get('x.10.2.b1');
    assert.ok(e.battle.tickCount > 50);
    r.net.emit('b.ext', { battleId: 'x.10.2.b1', i: 0, to: 200, hp: [], end: { tick: 10, reason: 'forced' } });
    assert.deepEqual(r.net.sent.filter((x) => x.t === 'g.sim').map((x) => x.tick), [10]);
    assert.equal(r.runner._entries.size, 0);
    r.runner.dispose();
  }
});
