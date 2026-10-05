// Actual Match prep driver + six combat Workers and separate 1/2-Worker trial pools.
// Controlled delivery is used ONLY for deterministic failure/late-reply races.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Match } from '../../server/match/Match.js';
import { VirtualScheduler } from '../../server/match/scheduler.js';
import { CombatWorkerPool } from '../../server/match/combat/pool.js';
import { Battle } from '../../server/sim/Battle.js';
import { buildNormalWave } from '../../server/match/waves.js';
import { createRehearsal, planLayout, REHEARSAL_VARIANTS, LAYOUT_PARAMS } from '../../server/match/bot.js';
import { DATA, QUIET, phase, until } from './combat-fixtures.js';
import { give, giveItem, checkInvariants } from './harness.js';
import { FakeBattle } from './fakeBattle.js';
import { startServer } from '../../server/index.js';
import { TestClient } from '../helpers/wsClient.js';

const clone = (x) => structuredClone(x);
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
async function pool(t, options = {}) {
  const p = new CombatWorkerPool({ role: 'trial', size: 1, data: DATA, log: QUIET, ...options });
  t.after(() => p.close()); await p.start();
  return p;
}
function fixture(t, { combatPool = null, trialPool = null, seed = 4, scheduler, BattleClass, clientCombat = false, botSliceMs = 2 } = {}) {
  const warnings = [], errors = [], sent = [];
  const m = new Match({ roomCode: 'TRIAL', mode: 'coop', difficulty: 'NORMAL', seed, data: DATA,
    seats: [0, 1].map((seat) => ({ seat, playerId: `p${seat}`, name: `P${seat}`, isBot: false, connected: true })),
    send: (pid, msg) => { sent.push([pid, clone(msg)]); return true; }, broadcast() {}, onEnd() {},
    log: { ...QUIET, warn: (s) => warnings.push(s), error: (s) => errors.push(s) },
    clientCombat, verify: 'off', combatPool, trialPool, scheduler, BattleClass, timerScale: 0.001, botSliceMs, botRehearsal: 3,
  });
  t.after(() => m.dispose());
  m.phase = 'PREP'; m.round = 3; m.stageId = 'act2autochess_m04'; m.stage = m.gd.stage(m.stageId);
  m.wave = buildNormalWave(m.gd, m.rngWaves, m.factions, 3);
  const ps = m.order[0];
  for (const p of m.order) { p.lp = 40; p.bandId = 'band_bldsk'; p.recompute(); }
  ps.autoplay = true; ps.funds = 12; ps.shop.level = 3; ps.shop.upgradePrice = m.gd.upgradeBase(3);
  ps.rollShop();
  for (const id of ['chess_char_1_10_a', 'chess_char_3_01_a', 'chess_char_4_22_b', 'chess_char_6_11_a']) give(m, ps, id);
  const h = { m, ps, warnings, errors, sent, completed: null, inlineTicks: 0 };
  const construct = m.newBattle.bind(m);
  m.newBattle = (opts) => {
    const b = construct(opts);
    if (String(opts.fieldId).startsWith('r:')) {
      const step = b.step.bind(b);
      b.step = () => { h.inlineTicks++; step(); };
    }
    return b;
  };
  const cancel = m._cancelBotPrep.bind(m);
  m._cancelBotPrep = (p) => {
    if (p._botPrepWork?.job?.done) {
      const job = p._botPrepWork.job;
      h.completed = { remote: job.remote === true, inline: job.inline === true, progress: clone(job.progress),
        plans: job.plans.map((plan) => [...plan]), best: [...job.best] };
    }
    cancel(p);
  };
  return h;
}
function state(m) {
  return clone({ phase: m.phase, round: m.round, uid: m.uidSeq, pool: m.pool.snapshot(),
    rng: ['rngSetup', 'rngShop', 'rngWaves', 'rngDraft', 'rngBots', 'rngMeta'].map((key) => m[key].state()),
    players: m.order.map((p) => ({ board: [...p.board], hand: p.hand, temp: p.temp, funds: p.funds, pendingFunds: p.pendingFunds,
      lp: p.lp, layers: p.layers, stats: p.stats, round: p.round, shop: p.shop, bonds: p.bonds,
      seen: [...(p._botSeenUids || [])], ready: p.ready, effects: p.effects, bounties: p.bounties })),
  });
}
async function prep(h) {
  h.m.scheduleBotPrep(h.ps);
  await until(() => h.ps.ready, 20_000);
  assert.deepEqual(h.errors, []); assert.equal(h.m.ended, false);
  checkInvariants(h.m);
  return state(h.m);
}
function adapter(real, options = {}) {
  const calls = { creates: 0, closes: 0, closed: new Map(), inputs: [], final: [], progress: 0 };
  const gates = [];
  return { calls, gates,
    runTrial(input, callbacks) {
      calls.creates++; calls.inputs.push(clone(input));
      if (options.admissionFailure) throw Object.assign(new Error('test queue full'), { code: 'QUEUE_FULL' });
      let failed = false;
      const failAfterProgress = () => {
        if (!options.failureAfterProgress || failed) return;
        failed = true; callbacks.onFailure(new Error('trial transport failed after progress'));
      };
      const handle = real.runTrial(input, { ...callbacks, onProgress(out) {
        calls.progress++; callbacks.onProgress(out); failAfterProgress();
      } });
      const gate = deferred(); gate.generation = handle.generation; gates.push(gate);
      let ready = handle.ready;
      if (options.holdReady) ready = ready.then((out) => { gate.raw = out; return gate.promise; });
      if (options.malformed) ready = ready.then((out) => ({ ...out, ticks: -1 }));
      const done = handle.done.then((out) => {
        calls.final.push(out);
        if (options.failureAfterProgress && !failed) { callbacks.onProgress(out); failAfterProgress(); }
        if (options.holdDone) { gate.final = out; return gate.promise; }
        return out;
      });
      done.catch(() => {});
      return { generation: handle.generation, ready, done,
        close() { calls.closes++; calls.closed.set(handle.generation, (calls.closed.get(handle.generation) || 0) + 1); return handle.close(); },
      };
    },
  };
}

for (const trialWorkers of [1, 2]) test(`actual six-combat + ${trialWorkers}-trial-worker Match prep equals inline layout/economy/resources/RNG; snapshots differ and main never constructs rehearsal Battle`, { timeout: 30_000 }, async (t) => {
  const combat = await pool(t, { role: 'combat', size: 6 });
  const real = await pool(t, { size: trialWorkers });
  const inline = fixture(t);
  const expected = await prep(inline);
  assert.ok(inline.completed && inline.inlineTicks > 100);
  const trace = adapter(real);
  const remote = fixture(t, { combatPool: combat, trialPool: trace });
  const actual = await prep(remote);
  assert.deepEqual(actual, expected);
  assert.deepEqual(remote.completed.best, inline.completed.best);
  assert.deepEqual(remote.completed.plans, inline.completed.plans);
  assert.equal(remote.inlineTicks, 0, 'healthy actual schedule makes no main-thread rehearsal Battle');
  assert.equal(remote.completed.remote, true); assert.equal(remote.completed.inline, false);
  assert.equal(remote.completed.progress.ticks, inline.inlineTicks, 'same number of simulated ticks, not a cheaper trial search');
  assert.ok(remote.completed.progress.candidates.every((c) => c.score !== null || c.beaten));
  assert.equal(trace.calls.creates, 1); assert.equal(trace.calls.closes, 1);
  const candidates = trace.calls.inputs[0].candidates;
  assert.equal(candidates.length, inline.completed.plans.length);
  assert.ok(new Set(candidates.map((c) => JSON.stringify(c.players[0].units.map((u) => [u.uid, u.row, u.col, u.dir])))).size > 1);
  const before = clone(candidates);
  remote.ps.effects.push({ id: 'late', data: { changed: true }, battle: false });
  assert.deepEqual(candidates, before, 'transferred snapshots do not alias live effects/boards');
  assert.deepEqual(remote.warnings, []);
  assert.ok(remote.completed.progress.sliceCount > 0);
  assert.ok(remote.completed.progress.candidates.every((c) => c.result === null && (c.synthetic === null || typeof c.synthetic === 'boolean')));
  assert.equal(real.stats().sessions, 0);
  assert.equal(combat.stats().trials, 0, 'dedicated rehearsal never borrows a formal combat worker');
  assert.equal(combat.stats().ready, 6);
  remote.m.dispose();
  assert.equal(real.status, 'ready', 'Match disposal must not close a process-shared trial pool');
});

for (const failure of ['admissionFailure', 'malformed', 'failureAfterProgress']) {
  test(`actual Match ${failure}: ALL original frozen candidates restart in bounded inline fallback, without economic/RNG replay`, { timeout: 30_000 }, async (t) => {
    const real = await pool(t);
    const inline = fixture(t); const expected = await prep(inline);
    const trace = adapter(real, { [failure]: true });
    const remote = fixture(t, { trialPool: trace });
    const actual = await prep(remote);
    assert.deepEqual(actual, expected);
    assert.deepEqual(remote.completed.best, inline.completed.best);
    assert.equal(remote.completed.inline, true);
    assert.equal(remote.completed.progress.ticks, inline.inlineTicks);
    assert.equal(remote.completed.progress.candidates.length, inline.completed.plans.length);
    assert.ok(remote.warnings.some((s) => s.includes('restarting all frozen candidates inline')));
    assert.equal(remote.m.errorCount, 0);
    await until(() => real.stats().sessions === 0);
    assert.equal(trace.calls.creates, 1);
    assert.equal(trace.calls.closes, failure === 'admissionFailure' ? 0 : 1);
  });
}

test('unserializable option is refused on the wire, but all candidates still use original bounded inline scoring without lost flags', { timeout: 30_000 }, async (t) => {
  const real = await pool(t), trace = adapter(real);
  const inline = fixture(t); const expected = await prep(inline);
  const remote = fixture(t, { trialPool: trace });
  const dp = remote.m.gd.dp;
  Object.defineProperty(remote.m.gd, 'dp', { get: () => ({ ...dp, localOnly() { return true; } }) });
  assert.deepEqual(await prep(remote), expected);
  assert.deepEqual(remote.completed.best, inline.completed.best);
  assert.equal(remote.inlineTicks, inline.inlineTicks);
  assert.equal(remote.completed.remote, false);
  assert.equal(remote.completed.plans.length, inline.completed.plans.length);
  assert.equal(trace.calls.creates, 0);
  assert.ok(remote.warnings.some((s) => s.includes('snapshot rejected; continuing all candidates inline')));
});

test('actual maxTrials pressure does not reduce candidate search or change strategy', { timeout: 30_000 }, async (t) => {
  const real = await pool(t, { maxTrials: 1 });
  const inline = fixture(t); const expected = await prep(inline);
  const heldInput = { ...phase().specs[0], timeLimit: 100_000,
    spawns: [{ ...phase().specs[0].spawns[0], time: 100_000 }] };
  const held = real.runTrial({ playerId: 'p0', candidates: [heldInput], cap: 3_000_000 });
  held.done.catch(() => {}); await held.ready;
  const remote = fixture(t, { trialPool: real });
  assert.deepEqual(await prep(remote), expected);
  assert.equal(remote.completed.inline, true);
  assert.equal(remote.completed.progress.ticks, inline.inlineTicks);
  assert.ok(remote.warnings.some((s) => s.includes('trial session limit')));
  await held.close(); assert.equal(real.stats().sessions, 0);
});

for (const action of ['reschedule', 'ready', 'autoplay-off', 'autoplay-return', 'endPrep', 'finish', 'dispose', 'quit']) {
  test(`actual Match ${action} cancels old ready reply exactly once and cannot publish/apply a late proposal`, { timeout: 20_000 }, async (t) => {
    const real = await pool(t);
    const trace = adapter(real, { holdReady: true });
    const h = fixture(t, { trialPool: trace });
    h.m.scheduleBotPrep(h.ps);
    await until(() => trace.gates[0]?.raw);
    const oldWork = h.ps._botPrepWork;
    const oldToken = h.ps._botPrepToken;
    if (action === 'reschedule') h.m.scheduleBotPrep(h.ps);
    else if (action === 'ready') { h.ps.resolveTemp(); assert.equal(h.ps.setReady(true).ok, true); }
    else if (action === 'autoplay-off') h.m.setAutoplay(h.ps, false);
    else if (action === 'autoplay-return') { h.m.setAutoplay(h.ps, false); h.m.setAutoplay(h.ps, true); }
    else if (action === 'endPrep') h.m.endPrep();
    else if (action === 'finish') h.m.finish({ victory: false, reason: 'test' });
    else if (action === 'dispose') h.m.dispose();
    else h.m.onLeave(h.ps.playerId);
    assert.equal(oldWork.cancelled, true);
    assert.ok(h.ps._botPrepToken > oldToken);
    const snapshot = state(h.m);
    trace.gates[0].resolve(trace.gates[0].raw);
    await delay(5);
    // A replacement can legitimately continue planning; stop it before comparing authoritative holdings.
    if (action === 'reschedule' || action === 'autoplay-return') h.m.setAutoplay(h.ps, false);
    else assert.deepEqual(state(h.m), snapshot, 'late reply has no ownership/settlement effect');
    assert.equal(h.completed, null);
    assert.equal(trace.calls.closed.get(trace.gates[0].generation), 1, 'old reservation closed exactly once');
    assert.ok([...trace.calls.closed.values()].every((n) => n === 1));
    assert.equal(h.m.errorCount, 0);
    await until(() => real.stats().trials === 0);
  });
}

test('stale own gift/dir/equip input is discarded rather than re-signed at first RPC reply; unrelated private/timer/teammate dirtiness is ignored', { timeout: 30_000 }, async (t) => {
  const real = await pool(t);
  for (const mutation of ['gift', 'move', 'dir', 'equip', 'loadout', 'effects', 'unrelated']) {
    const trace = adapter(real, { holdReady: true });
    const h = fixture(t, { trialPool: trace }); h.m.scheduleBotPrep(h.ps);
    try { await until(() => trace.gates[0]?.raw); }
    catch (e) { throw new Error(`${mutation}: ${e.message}; ${JSON.stringify({ creates: trace.calls.creates, closes: trace.calls.closes, warnings: h.warnings, errors: h.errors, stats: real.stats() })}`); }
    let piece;
    if (mutation === 'gift') piece = h.ps.acquireChess('chess_char_2_02_a', { source: 'gift' });
    else if (mutation === 'move') {
      piece = [...h.ps.board.values()].find((p) => p.kind === 'chess');
      const key = [...h.ps.deployMap().keys()].find((key) => !h.ps.board.has(key) && h.ps._legal(piece, ...key.split(',').map(Number)));
      assert.ok(key, 'fixture has a legal spare tile');
      const [row, col] = key.split(',').map(Number);
      assert.equal(h.m.handle(h.ps.playerId, { t: 'g.move', uid: piece.uid, to: { area: 'board', row, col }, dir: piece.dir }).ok, true);
    } else if (mutation === 'dir') {
      const [key, p] = [...h.ps.board].find(([, p]) => p.kind === 'chess'); piece = p;
      const [row, col] = key.split(',').map(Number);
      assert.equal(h.m.handle(h.ps.playerId, { t: 'g.move', uid: p.uid, to: { area: 'board', row, col }, dir: p.dir === 'LEFT' ? 'RIGHT' : 'LEFT' }).ok, true);
    } else if (mutation === 'equip') {
      piece = [...h.ps.board.values()].find((p) => p.kind === 'chess');
      const item = giveItem(h.m, h.ps, 'chess_item_1_01_e_a');
      assert.equal(h.m.handle(h.ps.playerId, { t: 'g.equip', itemUid: item.uid, targetUid: piece.uid }).ok, true);
    } else if (mutation === 'loadout') {
      // Explicit fixture setter: the public protocol correctly locks loadouts before PREP, but late input
      // protection must also cover an internal replacement instead of blessing its former candidates.
      assert.equal(h.ps.setLoadout({ chess_char_4_22_a: { module: 'none' } }), true);
    } else if (mutation === 'effects') h.ps.effects.push({ id: 'late', data: { changed: true }, battle: true });
    else { h.ps._lastPriv = 'different'; h.m.markPublic(); give(h.m, h.m.order[1], 'chess_char_2_02_a'); }
    const ownerBoard = clone([...h.ps.board]);
    trace.gates[0].resolve(trace.gates[0].raw);
    await until(() => h.ps.ready);
    if (mutation === 'unrelated') {
      assert.equal(h.completed.remote, true); assert.ok(h.completed.progress.ticks > 0);
      assert.deepEqual(h.warnings, []);
    } else {
      assert.equal(h.completed, null, 'no stale trial winner was published');
      assert.ok(h.warnings.some((s) => s.includes('own inputs changed')));
      assert.deepEqual([...h.ps.board], ownerBoard, 'discard does not overwrite current layout/items');
      if (mutation === 'gift') assert.ok(h.ps.find(piece.uid), 'gift survives stale proposal cancellation');
      assert.equal(trace.calls.creates, 1, 'discard never creates a replacement search or repeats economy');
    }
    assert.equal(trace.calls.closes, 1); h.m.dispose();
  }
});

test('candidate collection -> default-layout yield -> first RPC boundary does not blindly bless a gifted/new owner input', async (t) => {
  const real = await pool(t);
  const sched = new VirtualScheduler({ instantCombat: false });
  // Deterministic injected non-virtual driver clock, with REAL Battle and REAL Workers; one .next() per callback.
  sched.virtual = false;
  const trace = adapter(real);
  const h = fixture(t, { trialPool: trace, scheduler: sched, botSliceMs: 1e-6 });
  t.after(() => sched.dispose());
  let captured = 0;
  const input = h.ps.battleInput.bind(h.ps);
  h.ps.battleInput = (...a) => { if (h.m._workerBotPrepOwner === h.ps) captured++; return input(...a); };
  h.m.scheduleBotPrep(h.ps);
  for (let i = 0; captured < 3 && i < 5000; i++) assert.equal(sched.runNext(), true);
  assert.equal(captured, 3);
  assert.equal(trace.calls.creates, 0, 'lazy admission has not hidden a session inside arrangeSteps');
  const gift = h.ps.acquireChess('chess_char_2_02_a', { source: 'gift' });
  assert.ok(gift);
  for (let i = 0; !h.ps.ready && i < 1000; i++) assert.equal(sched.runNext(), true);
  assert.equal(h.ps.ready, true); assert.ok(h.ps.find(gift.uid));
  assert.equal(trace.calls.creates, 0);
  assert.equal(h.completed, null);
  assert.ok(h.warnings.some((s) => s.includes('own inputs changed')));
});

test('explicit legacy retains deferred planning fingerprint cost before job admission; streaming avoids only the adjacent duplicate', (t) => {
  for (const legacy of [true, false]) {
    const sched = new VirtualScheduler({ instantCombat: false }); sched.virtual = false;
    t.after(() => sched.dispose());
    const rejectAdmission = () => assert.fail('this planning-only fixture must never admit a trial');
    const trialPool = legacy ? { createTrial: rejectAdmission } : { runTrial: rejectAdmission, createTrial: rejectAdmission };
    const h = fixture(t, { trialPool, scheduler: sched, botSliceMs: 1e-6 });
    let fingerprints = 0, bounties = h.ps.bounties;
    Object.defineProperty(h.ps, 'bounties', { configurable: true, enumerable: true,
      get() {
        // Count this function without adding an instrumentation hook to production code. Other game reads do not count.
        if (new Error().stack.includes('rehearsalFingerprint')) fingerprints++;
        return bounties;
      }, set(value) { bounties = value; },
    });
    const callback = () => {
      const before = fingerprints;
      for (let i = 0; fingerprints === before && i < 1000; i++) assert.equal(sched.runNext(), true);
      assert.ok(fingerprints > before);
      return fingerprints - before;
    };
    h.m.scheduleBotPrep(h.ps);
    assert.equal(callback(), 1, 'first atomic planning slice only captures its initial owner signature');
    assert.equal(h.ps._botPrepWork.legacy, legacy); assert.equal(h.ps._botPrepWork.job, null);
    assert.equal(callback(), legacy ? 3 : 2, 'legacy keeps defer fresh + drive fresh + capture; stream keeps drive fresh + capture');
    assert.equal(h.ps._botPrepWork.job, null, 'comparison mode is already active before the rehearsal job is returned');
    const gift = h.ps.acquireChess('chess_char_2_02_a', { source: 'gift' }); assert.ok(gift);
    assert.equal(callback(), 1, 'either path rejects the next stale owner boundary rather than re-signing it');
    assert.equal(h.ps.ready, true); assert.ok(h.ps.find(gift.uid)); assert.equal(h.completed, null);
    assert.ok(h.warnings.some((s) => s.includes('own inputs changed'))); assert.deepEqual(h.errors, []);
  }
});

test('virtual/custom-Battle/trial0/ineligible pool retain original synchronous rehearsal strategy', async (t) => {
  const trap = { runTrial() { assert.fail('ineligible fixture must stay inline'); }, createTrial() { assert.fail('ineligible fixture must stay inline'); } };
  const normal = fixture(t); const expected = await prep(normal);
  for (const opts of [
    { scheduler: new VirtualScheduler(), combatPool: trap, trialPool: trap },
    { trialPool: { create() {} } },
    { clientCombat: true, combatPool: trap, trialPool: trap },
    { combatPool: trap, trialPool: null },
    { combatPool: null, trialPool: null },
  ]) {
    const h = fixture(t, opts);
    if (opts.scheduler) { h.m.scheduleBotPrep(h.ps); opts.scheduler.runUntil(() => h.ps.ready); opts.scheduler.dispose(); }
    else await prep(h);
    assert.deepEqual(state(h.m), expected);
    assert.ok(h.inlineTicks > 0);
  }
  FakeBattle.reset();
  const custom = fixture(t, { combatPool: trap, trialPool: trap, BattleClass: FakeBattle });
  await prep(custom); assert.equal(custom.completed.remote, false);
  // Even a real Match with a worker pool keeps its public one-shot rehearsal helper synchronous.
  const real = await pool(t); const h = fixture(t, { trialPool: real });
  const chosen = h.ps.allChess().slice(0, h.ps.deployCap);
  const plans = REHEARSAL_VARIANTS.map((v) => planLayout(h.m, h.ps, chosen, { ...LAYOUT_PARAMS, ...v }));
  const job = createRehearsal(h.m, h.ps, chosen, plans);
  assert.ok(job); assert.equal(typeof job.run, 'function'); assert.equal(job.remote, undefined);
  job.run(); assert.equal(real.stats().trials, 0);
});

test('explicit legacy shared adapter retains per-slice scheduling while a combatPool alone never offloads rehearsal', { timeout: 30_000 }, async (t) => {
  const combat = await pool(t, { role: 'combat', size: 6 });
  const inline = fixture(t); const expected = await prep(inline);
  const noTrial = fixture(t, { combatPool: combat });
  assert.deepEqual(await prep(noTrial), expected); assert.ok(noTrial.inlineTicks > 0);
  let advances = 0, callbackFingerprints = 0, bounties;
  const fingerprintsPerAdvance = [];
  const trialPool = { createTrial(input) {
    const handle = combat.createTrial(input);
    return { ...handle, advance() {
      advances++; fingerprintsPerAdvance.push(callbackFingerprints); return handle.advance();
    } };
  } };
  const legacy = fixture(t, { combatPool: combat, trialPool });
  bounties = legacy.ps.bounties;
  Object.defineProperty(legacy.ps, 'bounties', { configurable: true, enumerable: true,
    get() { if (new Error().stack.includes('rehearsalFingerprint')) callbackFingerprints++; return bounties; },
    set(value) { bounties = value; },
  });
  const later = legacy.m.later.bind(legacy.m);
  legacy.m.later = (ms, fn) => later(ms, () => { callbackFingerprints = 0; fn(); });
  assert.deepEqual(await prep(legacy), expected);
  assert.equal(legacy.inlineTicks, 0); assert.ok(advances > 10, 'benchmark baseline still has one RPC per bounded slice');
  assert.ok(fingerprintsPerAdvance.every((count) => count === 2), 'every legacy RPC retains both deferred and slice-entry owner checks');
  assert.equal(legacy.completed.remote, true); assert.equal(legacy.completed.progress.sliceCount, undefined);
  assert.equal(combat.stats().ready, 6); assert.equal(combat.stats().trials, 0);
});

for (const trialWorkers of [1, 2]) test(`queued Match job cancels without running/fallback or closing the shared ${trialWorkers}-trial + six-combat pools`, { timeout: 20_000 }, async (t) => {
  const combat = await pool(t, { role: 'combat', size: 6 });
  const real = await pool(t, { size: trialWorkers });
  const spec = { ...phase().specs[0], timeLimit: 100_000,
    spawns: [{ ...phase().specs[0].spawns[0], time: 100_000 }] };
  const held = Array.from({ length: trialWorkers }, () => real.runTrial({ playerId: 'p0', candidates: [spec], cap: 3_000_000 }));
  for (const job of held) job.done.catch(() => {});
  await Promise.all(held.map((job) => job.ready));
  const trace = adapter(real), h = fixture(t, { combatPool: combat, trialPool: trace });
  h.m.scheduleBotPrep(h.ps);
  await until(() => trace.calls.creates === 1 && real.stats().queued > 0);
  const oldWork = h.ps._botPrepWork, generation = trace.gates[0].generation;
  h.m.setAutoplay(h.ps, false);
  const holdings = state(h.m);
  await until(() => real.stats().trials === trialWorkers);
  assert.equal(oldWork.cancelled, true); assert.equal(trace.calls.closed.get(generation), 1);
  await Promise.all(held.map((job) => job.close()));
  await delay(10);
  assert.deepEqual(state(h.m), holdings); assert.equal(h.completed, null); assert.equal(h.inlineTicks, 0);
  assert.equal(trace.calls.final.length, 0); assert.deepEqual(h.warnings, []); assert.equal(h.m.errorCount, 0);
  assert.equal(combat.stats().ready, 6); assert.equal(combat.stats().trials, 0);
  h.m.dispose(); assert.equal(real.status, 'ready'); assert.equal(combat.status, 'ready');
  assert.equal(real.stats().trials, 0);
});

for (const action of ['ready', 'autoplay-off', 'endPrep', 'finish', 'dispose', 'quit', 'round', 'deadline', 'owner']) {
  test(`fully computed late winner after ${action} is rejected at the final asynchronous boundary`, { timeout: 20_000 }, async (t) => {
    const real = await pool(t), trace = adapter(real, { holdDone: true });
    const h = fixture(t, { trialPool: trace }); h.m.scheduleBotPrep(h.ps);
    await until(() => trace.gates[0]?.final);
    const oldWork = h.ps._botPrepWork, generation = trace.gates[0].generation;
    let gift;
    if (action === 'ready') { h.ps.resolveTemp(); assert.equal(h.ps.setReady(true).ok, true); }
    else if (action === 'autoplay-off') h.m.setAutoplay(h.ps, false);
    else if (action === 'endPrep') h.m.endPrep();
    else if (action === 'finish') h.m.finish({ victory: false, reason: 'test' });
    else if (action === 'dispose') h.m.dispose();
    else if (action === 'quit') h.m.onLeave(h.ps.playerId);
    else if (action === 'round') h.m.round++;
    else if (action === 'deadline') h.m.deadline = h.m.sched.now() - 1;
    else gift = h.ps.acquireChess('chess_char_2_02_a', { source: 'gift' });
    const holdings = state(h.m), board = clone([...h.ps.board]);
    trace.gates[0].resolve(trace.gates[0].final);
    await until(() => oldWork.cancelled);
    if (action === 'owner') {
      assert.equal(h.ps.ready, true); assert.ok(h.ps.find(gift.uid));
      assert.deepEqual([...h.ps.board], board); assert.ok(h.warnings.some((s) => s.includes('own inputs changed')));
    } else { assert.deepEqual(state(h.m), holdings); assert.deepEqual(h.warnings, []); }
    assert.equal(h.completed, null); assert.equal(h.inlineTicks, 0); assert.equal(trace.calls.creates, 1);
    assert.equal(trace.calls.closed.get(generation), 1); assert.equal(h.m.errorCount, 0);
    assert.equal(real.stats().trials, 0);
  });
}

function normalize(value, ids) {
  if (typeof value === 'string') return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((x) => normalize(x, ids));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [ids.get(k) ?? k, normalize(v, ids)]));
  return value;
}
test('actual WS autoplay -> dedicated rehearsal -> six-worker combat/settlement matches worker0 for trial1/2 results/resources/RNG', { timeout: 45_000 }, async (t) => {
  const run = async (workers, trialWorkers = 0) => {
    class RehearsingMatch extends Match { constructor(o) { super({ ...o, clientCombat: false, verify: 'off', timerScale: 0.02, combatSpeed: 200, botRehearsal: 3 }); } }
    const srv = await startServer({ host: '127.0.0.1', port: 0, combatWorkers: workers, trialWorkers, MatchClass: RehearsingMatch, seedFn: () => 4, log: QUIET });
    const clients = [];
    t.after(async () => { for (const c of clients) await c.terminate(); await srv.close(); });
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`); clients.push(c);
    const welcome = await c.hello('Trial WS');
    const ok = async (msg) => assert.equal((await c.request(msg)).t, 'ok');
    await ok({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const room = await c.waitFor('room.state');
    await ok({ t: 'room.start' }); await ok({ t: 'g.infoReady' });
    await c.waitFor('m.public', (p) => p.phase === 'BAND_DRAFT');
    await ok({ t: 'g.band', bandId: 'band_bldsk' });
    await c.waitFor('m.public', (p) => p.phase === 'PREP');
    const m = srv.lobby.getRoom(room.code).match, ps = m.order[0];
    m.stageId = 'act2autochess_m04'; m.stage = m.gd.stage(m.stageId); ps.invalidateDeployMap();
    m.wave = { ...m.wave, timeLimit: 4 };
    for (const id of ['chess_char_1_10_a', 'chess_char_3_01_a', 'chess_char_4_22_b', 'chess_char_6_11_a']) give(m, ps, id);
    const settled = deferred();
    let trialTicks = 0, creates = 0, mainTicks = 0;
    const construct = m.newBattle.bind(m);
    m.newBattle = (opts) => {
      const b = construct(opts);
      if (String(opts.fieldId).startsWith('r:')) { const step = b.step.bind(b); b.step = () => { mainTicks++; step(); }; }
      return b;
    };
    const cancel = m._cancelBotPrep.bind(m);
    m._cancelBotPrep = (p) => { if (p._botPrepWork?.job?.done) trialTicks = p._botPrepWork.job.progress?.ticks ?? mainTicks; cancel(p); };
    if (workers) {
      const original = srv.trialPool.runTrial.bind(srv.trialPool);
      srv.trialPool.runTrial = (...a) => { creates++; return original(...a); };
    }
    const settle = m.settle.bind(m);
    m.settle = (...a) => {
      const results = clone(m.lastResults);
      settle(...a);
      settled.resolve({ results: [...results], state: state(m), errorCount: m.errorCount });
    };
    await ok({ t: 'g.autoplay', on: true });
    const result = await settled.promise;
    const ids = new Map([[welcome.playerId, 'p0']]);
    const canonical = normalize(result, ids);
    assert.ok(trialTicks > 0, 'actual asynchronous progress is nonzero');
    if (workers) {
      assert.equal(creates, 1); assert.equal(mainTicks, 0); assert.equal(srv.combatPool.size, 6);
      assert.equal(srv.trialPool.size, trialWorkers); assert.equal(srv.combatPool.stats().trials, 0);
    }
    else assert.ok(mainTicks > 0);
    assert.equal(result.errorCount, 0);
    await c.terminate(); await srv.close();
    return { canonical, trialTicks };
  };
  const before = await run(0);
  for (const trialWorkers of [1, 2]) {
    const after = await run(6, trialWorkers);
    assert.deepEqual(after, before, 'full normal result, ticks, settlement resources and all six match RNG streams agree');
  }
});
