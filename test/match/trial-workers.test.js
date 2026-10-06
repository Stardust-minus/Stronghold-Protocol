import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { CombatWorkerPool } from '../../server/match/combat/pool.js';
import { TrialEngine, snapshotTrialInput, assembleTrialInput, receiveTrialInput, MAX_TRIAL_TICKS } from '../../server/match/combat/trial.js';
import { Battle } from '../../server/sim/Battle.js';
import { DeadBattle } from '../../server/match/fields.js';
import { combatData } from '../../server/match/combat/data.js';
import { createRehearsal, planLayout, REHEARSAL_VARIANTS, LAYOUT_PARAMS } from '../../server/match/bot.js';
import { makeMatch, give, legalTileFor } from './harness.js';
import { DATA, QUIET, phase, until } from './combat-fixtures.js';
import { GEO } from '../../shared/constants.js';

const GLADIIA_HOK_Y = 'uniequip_003_glady';

const clone = (x) => structuredClone(x);
async function realPool(t, opts = {}) {
  const pool = new CombatWorkerPool({ size: 1, data: DATA, log: QUIET, ...opts });
  t.after(() => pool.close());
  await pool.start();
  return pool;
}
function input() {
  const candidate = { ...phase().specs[0], sharedBoss: null };
  candidate.flags.layerGainsEnabled = false;
  return { playerId: 'p0', candidates: [clone(candidate), clone(candidate)], cap: 270 };
}

// Independent copy of ORIGINAL bot.run semantics: one-shot real Battles, cap and pruning every 64 ticks.
// Compare full internal results, not a digest or merely winner-vs-winner with the same new TrialEngine.
function original(input, { onBattle = null } = {}) {
  const battles = input.candidates.map((c) => {
    try { return new Battle({ ...clone(c), data: combatData(DATA), logger: QUIET }); }
    catch { return new DeadBattle(c); }
  });
  let bestIndex = 0, bestScore = -Infinity, bestLeaks = Infinity, totalTicks = 0;
  const candidates = [];
  for (let index = 0; index < battles.length; index++) {
    const battle = battles[index];
    onBattle?.(battle, index);
    let ticks = 0, beaten = false;
    while (ticks < input.cap && !battle.finished) {
      battle.step(); ticks++; totalTicks++;
      if ((ticks & 63) === 0 && bestLeaks < Infinity) {
        const pp = battle.result()?.perPlayer?.[input.playerId];
        const leaks = pp ? (pp.leaked || []).filter((l) => l && l.counted !== false).length : 0;
        if (leaks > bestLeaks) { beaten = true; break; }
      }
    }
    const record = { index, ticks, duration: battle.time, beaten, leaks: null, score: null, result: null, error: null };
    if (!beaten) {
      if (!battle.finished) battle.forceEnd('timeout');
      record.result = clone(battle.result());
      record.duration = battle.time;
      const pp = !record.result.synthetic && record.result.perPlayer?.[input.playerId];
      if (pp) {
        record.leaks = (pp.leaked || []).filter((l) => l && l.counted !== false).length;
        record.score = -record.leaks * 1000 + (pp.killed || 0) - index * 0.01;
        if (record.score > bestScore) { bestIndex = index; bestScore = record.score; bestLeaks = record.leaks; }
      }
    }
    candidates.push(record);
  }
  return { done: true, candidateIndex: battles.length, ticks: totalTicks, bestIndex, bestScore, bestLeaks, candidates };
}
async function evaluate(t, data) {
  const pool = await realPool(t);
  let previous = 0, slices = 0;
  const out = await pool.evaluateTrial(data, { onProgress(progress) {
    assert.ok(progress.ticks - previous <= MAX_TRIAL_TICKS, 'every actual wire turn bounds simulation work');
    assert.ok(progress.ticks >= previous);
    if (!progress.done) assert.ok(progress.candidates.every((c) => !Object.hasOwn(c, 'result')), 'no full results on intermediate replies');
    previous = progress.ticks; slices++;
  } });
  assert.ok(slices > 1);
  assert.equal(pool.stats().trials, 0);
  assert.equal(pool.stats().activeTrials, 0);
  assert.equal(pool.stats().pending, 0);
  return out;
}

test('trial serializer preserves raw undefined/Infinity/flags/loadouts and rejects executable or shared references', () => {
  const source = input();
  source.candidates[0].flags.testUndefined = undefined;
  source.candidates[0].flags.testInfinity = Infinity;
  source.candidates[0].flags.zero = 0;
  const snapshot = snapshotTrialInput(source);
  assert.ok(Object.hasOwn(snapshot.candidates[0].flags, 'testUndefined'));
  assert.equal(snapshot.candidates[0].flags.testUndefined, undefined);
  assert.equal(snapshot.candidates[0].flags.testInfinity, Infinity);
  assert.equal(snapshot.candidates[0].flags.zero, 0);
  assert.ok(Object.isFrozen(snapshot.candidates[0].players[0].units));
  source.candidates[0].players[0].units[0].dir = 'LEFT';
  assert.equal(snapshot.candidates[0].players[0].units[0].dir, 'RIGHT');
  for (const patch of [
    { flags: { range() {} } }, { data: combatData(DATA) }, { sharedBoss: { hp: 5 } }, { kind: 'boss' },
    { content() {} }, { logger: QUIET }, { stage: DATA.stages?.act2autochess_m01 || {} },
  ]) {
    const invalid = input(); Object.assign(invalid.candidates[0], patch);
    assert.throws(() => snapshotTrialInput(invalid), { code: 'BAD_TRIAL_INPUT' });
  }
  const symbols = input(); symbols.candidates[0].flags[Symbol('lost')] = true;
  assert.throws(() => snapshotTrialInput(symbols), { code: 'BAD_TRIAL_INPUT' });
  const hidden = input(); Object.defineProperty(hidden.candidates[0].flags, 'lost', { value: true });
  assert.throws(() => snapshotTrialInput(hidden), { code: 'BAD_TRIAL_INPUT' });
  const accessor = input(); Object.defineProperty(accessor.candidates[0].flags, 'lost', { get() { assert.fail('must not execute getter'); }, enumerable: true });
  assert.throws(() => snapshotTrialInput(accessor), { code: 'BAD_TRIAL_INPUT' });
});

test('trusted snapshot assembly avoids recopying captured candidates, but frozen lookalikes cannot forge trust', () => {
  const source = input();
  const captured = snapshotTrialInput(source);
  const assembled = assembleTrialInput({ ...captured, candidates: captured.candidates.slice() });
  assert.equal(assembled.candidates[0], captured.candidates[0]);
  assert.equal(snapshotTrialInput(assembled), assembled);
  const engine = new TrialEngine(assembled, { data: DATA });
  assert.equal(engine.input, assembled);
  engine.dispose();
  const lookalike = input();
  Object.freeze(lookalike.candidates[0]);
  const isolated = assembleTrialInput(lookalike);
  assert.notEqual(isolated.candidates[0], lookalike.candidates[0]);
  lookalike.candidates[0].flags.dpInit = 4;
  assert.equal(isolated.candidates[0].flags.dpInit, 99);
  const forged = input(); forged.candidates[0].flags = { execute() {} };
  Object.freeze(forged.candidates[0]);
  assert.throws(() => assembleTrialInput(forged), { code: 'BAD_TRIAL_INPUT' });
  const received = structuredClone(captured);
  assert.equal(receiveTrialInput(received), received, 'isolated transport ownership needs no second clone');
  assert.ok(Object.isFrozen(received.candidates[0].players[0].units));
  const executable = input(); executable.candidates[0].logger = QUIET;
  assert.throws(() => receiveTrialInput(executable), { code: 'BAD_TRIAL_INPUT' });
});

test('summary trial advanceSlice emits no DTO and retains exact original scoring without storing full results', () => {
  const data = input(); data.candidates[0].routes = {};
  const full = new TrialEngine(data, { data: DATA });
  while (!full.advance().done) {}
  const expected = full.state();
  const summary = new TrialEngine(data, { data: DATA, summary: true });
  const state = summary.state;
  summary.state = () => assert.fail('advanceSlice must not generate DTO');
  let slices = 0;
  while (!summary.advanceSlice()) slices++;
  slices++;
  summary.state = state;
  const out = summary.state();
  assert.equal(out.sliceCount, slices);
  assert.equal(out.summary, true);
  assert.deepEqual(out.candidates, expected.candidates.map((c) => ({ ...c, result: null, synthetic: c.result ? !!c.result.synthetic : null })));
  for (const key of ['bestIndex', 'bestScore', 'bestLeaks', 'ticks', 'candidateIndex', 'done']) assert.equal(out[key], expected[key]);
  assert.ok(summary.completed.every((c) => c.result === null));
  assert.equal(out.candidates[0].synthetic, true);
  assert.equal(out.candidates[0].score, null);
  assert.equal(out.bestIndex, 1);
  full.dispose(); summary.dispose();
});

test('trial real normal combat: all scores, leaks, duration, end state and tie-break exactly match original inline loop', async (t) => {
  const data = input();
  const expected = original(data);
  const out = await evaluate(t, data);
  assert.deepEqual(out, expected);
  assert.equal(out.bestIndex, 0);
  assert.equal(out.candidates[1].score, out.candidates[0].score - 0.01);
  assert.ok(out.candidates[0].result.perPlayer.p0.unitStats.length);
});

test('trial cap and explicit infinite timeLimit are not silently normalized through BattleSpec', async (t) => {
  const data = input(); data.cap = 41;
  for (const c of data.candidates) { c.timeLimit = Infinity; c.autoFinish = false; c.flags.dpInit = undefined; }
  const out = await evaluate(t, data);
  assert.deepEqual(out, original(data));
  assert.ok(out.candidates.every((c) => c.ticks === 41 && c.result.reason === 'timeout'));
});

test('trial early pruning remains exactly at tick64, not the 32-tick transport boundary', async (t) => {
  const data = input(); data.cap = 300;
  for (const c of data.candidates) {
    c.timeLimit = 10;
    c.players[0].units = [];
    c.routes = [{ motion: 'WALK', start: [9, 3], end: [9, 2], checkpoints: [] }];
  }
  data.candidates[0].spawns = [];
  data.candidates[1].spawns = [
    { time: 0, enemyKey: 'enemy_1007_slime', routeIndex: 0 },
    { time: 8, enemyKey: 'enemy_1007_slime', routeIndex: 0 },
  ];
  const out = await evaluate(t, data);
  assert.deepEqual(out, original(data));
  assert.equal(out.candidates[1].beaten, true);
  assert.equal(out.candidates[1].ticks, 64);
  assert.equal(out.candidates[1].result, null);
});

test('trial natural fixture: actual R3 bot economy/layout inputs and original Generator job winner agree without match mutations', async (t) => {
  const h = makeMatch({ mode: 'solo', seats: [{ seat: 0, playerId: 'ai_0', name: 'AI', isBot: true, connected: true }], seed: 4, botRehearsal: 0 }).start();
  t.after(() => h.m.dispose());
  h.run(() => h.m.phase === 'PREP' && h.m.round === 3);
  const m = h.m, ps = m.order[0];
  const chosen = ps.allChess().slice(0, ps.deployCap);
  assert.ok(chosen.length >= 3);
  const plans = REHEARSAL_VARIANTS.map((v) => planLayout(m, ps, chosen, { ...LAYOUT_PARAMS, ...v }));
  m.botRehearsal = 5;
  const candidates = [];
  const newBattle = m.newBattle.bind(m);
  m.newBattle = (opts) => { candidates.push(clone({ ...opts, content: m.battleContent })); return newBattle(opts); };
  const before = clone({ board: [...ps.board], rng: ['rngSetup', 'rngShop', 'rngWaves', 'rngDraft', 'rngBots', 'rngMeta'].map((key) => m[key].state()), uid: m.uidSeq, funds: ps.funds, lp: ps.lp, pool: m.pool.snapshot() });
  const job = createRehearsal(m, ps, chosen, plans);
  assert.ok(job && candidates.length >= 2);
  job.run();
  const data = { playerId: ps.playerId, candidates, cap: Math.ceil(((m.wave.timeLimit || 60) + 5) * 30) };
  const out = await evaluate(t, data);
  assert.deepEqual(out, original(data));
  assert.equal(job.plans[out.bestIndex], job.best, 'actual original bot Generator decision agrees');
  assert.deepEqual({ board: [...ps.board], rng: ['rngSetup', 'rngShop', 'rngWaves', 'rngDraft', 'rngBots', 'rngMeta'].map((key) => m[key].state()), uid: m.uidSeq, funds: ps.funds, lp: ps.lp, pool: m.pool.snapshot() }, before);
});

test('trial artificial LEGAL state: real skill effects, 流形 carried SP and Gladia HOK-Y on high ground survive full-result parity', async (t) => {
  const h = makeMatch().start().toPrep(1);
  t.after(() => h.m.dispose());
  h.setStage('act2autochess_m01');
  const m = h.m, ps = m.order[0];
  assert.equal(ps.setLoadout({ chess_char_4_12_a: { module: GLADIIA_HOK_Y } }), true);
  const glad = give(m, ps, 'chess_char_4_12_b', 'board', [10, 4]);
  assert.ok(ps._legal(glad, 10, 4));
  const tile = legalTileFor(m, ps, 'chess_char_6_11_a');
  assert.ok(tile);
  const owner = give(m, ps, 'chess_char_6_11_a', 'board', tile);
  const token = ps.newPiece('token', 'token_10030_mlyss_wtrman', { ownerUid: owner.uid });
  const key = [...ps.summonRange(token)].find((k) => !ps.board.has(k) && ps._legal(token, ...k.split(',').map(Number)));
  assert.ok(key, '流形 has a free legal tile in owner range');
  ps.board.set(key, token); ps.recompute();
  const players = [ps.battleInput()];
  const gu = players[0].units.find((u) => u.uid === glad.uid);
  assert.equal(gu.moduleId, GLADIIA_HOK_Y);
  // Explicit legal carried-state fixture, not claimed to have arisen naturally in this normal round.
  gu.carryState = { hpPct: 0.8, sp: 99 };
  players[0].units.find((u) => u.uid === token.uid).carryState = { sp: 40 };
  const base = { seed: 441, kind: 'normal', stageId: m.stageId, rect: { ...GEO.NORMAL_RECT }, timeLimit: 18,
    players, content: 'full', sharedBoss: null, flags: { layerGainsEnabled: false, dpInit: 99, dpMax: 99, startOpCooldown: 0 },
    routes: [{ motion: 'WALK', start: [9, 10], end: [9, 2], checkpoints: [] }],
    spawns: [{ time: 0, enemyKey: 'enemy_1007_slime', routeIndex: 0, count: 8, interval: 1, mods: { hpMul: 20 } }] };
  const data = { playerId: ps.playerId, candidates: [clone(base), clone(base)], cap: 690 };
  let skillStarts = 0, highGround = false, highBlocked = false, tokenSP = false;
  const expected = original(data, { onBattle(battle) {
    battle.on('skillStart', () => skillStarts++);
    const step = battle.step.bind(battle);
    battle.step = () => {
      step();
      const g = battle.allyUnits.find((u) => u.uid === glad.uid);
      const tok = battle.allyUnits.find((u) => u.uid === token.uid);
      highGround ||= g?.deployed && g.ground === false;
      highBlocked ||= !!g?.blocking.length;
      tokenSP ||= tok?.deployed && tok.skill.sp >= 40 && tok.skill.sp < 41;
    };
  } });
  assert.ok(highGround, 'Gladia is actually deployed on high ground');
  assert.equal(highBlocked, false, 'Gladia never blocks on high ground');
  assert.ok(tokenSP, 'real 流形 started with carried SP40 rather than default95');
  assert.ok(skillStarts > 0, 'real skill hooks fired');
  const out = await evaluate(t, data);
  assert.deepEqual(out, expected);
  const pp = out.candidates[0].result.perPlayer[ps.playerId];
  assert.ok(pp.unitsEnd.some((u) => u.defId === 'token_10030_mlyss_wtrman'));
  assert.ok(pp.unitStats.some((u) => u.dmg > 0), 'real attacks/skills changed results');
  assert.equal(out.candidates[0].result.errors, 0);
});

test('trial bad construction is visibly synthetic and unscored; remaining candidates and real combat still run', async (t) => {
  const pool = await realPool(t);
  const combat = pool.create(phase()); await combat.ready;
  const data = input(); data.candidates[0].routes = {};
  const out = await pool.evaluateTrial(data);
  assert.equal(out.candidates[0].score, null);
  assert.equal(out.candidates[0].result.synthetic, true);
  assert.ok(out.candidates[0].error);
  assert.equal(out.bestIndex, 1);
  assert.equal(out.candidates[1].result.errors, 0);
  assert.equal((await combat.request('advance', { ticks: 3 })).ticks, 3);
  combat.close();
});

test('trial budget and dispose: every slice is bounded and disposed data cannot be resumed', () => {
  const engine = new TrialEngine(input(), { data: DATA });
  for (const ticks of [0, 33, Infinity]) assert.throws(() => engine.advance(ticks), RangeError);
  let before = 0;
  while (!engine.done) { const out = engine.advance(7); assert.ok(out.ticks - before <= 7); before = out.ticks; }
  engine.dispose(); engine.dispose();
  assert.equal(engine.battle, null); assert.equal(engine.data, null); assert.equal(engine.input, null);
  assert.throws(() => engine.advance(), /disposed/);
  class BrokenStepBattle extends Battle {
    step() { if (this.seed === 123) throw new Error('candidate step failed'); super.step(); }
  }
  const broken = input(); broken.candidates[0].seed = 123;
  const resilient = new TrialEngine(broken, { data: DATA, BattleClass: BrokenStepBattle });
  let result;
  do { result = resilient.advance(); } while (!result.done);
  assert.equal(result.candidates[0].error, 'candidate step failed');
  assert.equal(result.candidates[0].score, null);
  assert.equal(result.bestIndex, 1, 'like original bot.run, failed candidate cannot win but later candidate still runs');
  resilient.dispose();
});

test('actual worker replies: combat init/advance/state/force/cleanup always preempt queued trials and do not starve', async (t) => {
  const pool = await realPool(t);
  const a = pool.createTrial(input()); await a.ready;
  const b = pool.createTrial(input());
  const turns = [];
  const post = pool.slots[0].worker.postMessage.bind(pool.slots[0].worker);
  pool.slots[0].worker.postMessage = (request) => { turns.push([request.kind, request.op]); post(request); };
  const advancing = a.advance();
  const combat = pool.create(phase());
  const advance = combat.request('advance', { ticks: 3 });
  const state = combat.request('state');
  const force = combat.request('forceAll');
  const trialAdvance = advancing.then(() => a.advance());
  const initialized = await combat.ready;
  assert.equal(initialized.ticks, 0);
  assert.equal((await advance).ticks, 3);
  assert.equal((await state).ticks, 3);
  assert.equal((await force).done, true);
  await trialAdvance;
  assert.deepEqual(turns.slice(0, 6), [['trial', 'advance'], ['combat', 'init'], ['combat', 'advance'], ['combat', 'state'], ['combat', 'forceAll'], ['trial', 'advance']]);
  assert.equal(pool.stats().activeTrials, 1, 'second trial has not initialized on the occupied worker');
  combat.close();
  await a.close(); await b.ready;
  assert.equal(turns.findIndex(([kind, op]) => kind === 'combat' && op === 'close') < turns.findLastIndex(([kind, op]) => kind === 'trial' && op === 'init'), true);
  await b.close();
});

test('actual trial cancellation cleanup stays below formal combat advance/state/force', async (t) => {
  const pool = await realPool(t);
  const trial = pool.createTrial(input()); await trial.ready;
  const combat = pool.create(phase()); await combat.ready;
  const turns = [], slot = pool.slots[0];
  const post = slot.worker.postMessage.bind(slot.worker);
  slot.worker.postMessage = (request) => { turns.push([request.kind, request.op]); post(request); };
  const advancing = trial.advance();
  const closing = trial.close();
  const advance = combat.request('advance', { ticks: 2 });
  const state = combat.request('state');
  const force = combat.request('forceField', { fieldId: 'n:p0' });
  await assert.rejects(advancing, { code: 'SESSION_CLOSED' });
  assert.equal((await advance).ticks, 2);
  assert.equal((await state).ticks, 2);
  assert.equal((await force).fields[0].live, false);
  await closing;
  assert.deepEqual(turns, [['trial', 'advance'], ['combat', 'advance'], ['combat', 'state'], ['combat', 'forceField'], ['trial', 'close']]);
  combat.close();
});

test('continuous actual combat progression is not starved by trial slices; only one wire request is in flight', async (t) => {
  const pool = await realPool(t);
  const combat = pool.create(phase()); await combat.ready;
  const data = input();
  for (const c of data.candidates) { c.timeLimit = 12; c.spawns[1].time = 20; }
  let wire = 0, maxWire = 0;
  const slot = pool.slots[0], post = slot.worker.postMessage.bind(slot.worker);
  slot.worker.prependListener('message', (m) => { if (m.type === 'reply') wire--; });
  slot.worker.postMessage = (request) => { wire++; maxWire = Math.max(maxWire, wire); post(request); };
  const trial = pool.evaluateTrial(data);
  for (let i = 1; i <= 48; i++) assert.equal((await combat.request('advance', { ticks: 1 })).ticks, i);
  const out = await trial;
  assert.deepEqual(out, original(data));
  assert.equal(maxWire, 1);
  assert.equal(wire, 0);
  combat.close();
});

test('actual trial Battles cannot change same-worker SharedBoss HP/LP/ending authority', async (t) => {
  const pool = await realPool(t);
  const combat = pool.create(phase('boss')); const before = await combat.ready;
  const data = input();
  const out = await pool.evaluateTrial(data);
  assert.deepEqual(out, original(data));
  const after = await combat.request('state');
  assert.deepEqual(after.boss, before.boss);
  assert.equal(after.done, before.done);
  assert.deepEqual(after.fields, before.fields);
  combat.close();
});

test('unlimited combat admission does not relax the independent per-worker trial serial guard', async (t) => {
  const pool = await realPool(t, { maxSessions: 0 });
  const trial = pool.createTrial(input()); await trial.ready;
  const combat = pool.create(phase()); await combat.ready;
  const slot = pool.slots[0], generation = 'test:extra-trial';
  // Directly probe the duplicate Worker guard; the pool normally serializes these trial initializations.
  const received = once(slot.worker, 'message');
  slot.worker.postMessage({ type: 'request', epoch: slot.epoch, kind: 'trial', generation, seq: 1, op: 'init', payload: input() });
  const [reply] = await received;
  assert.equal(reply.generation, generation);
  assert.equal(reply.error?.message, 'worker session limit reached');
  assert.equal((await combat.request('state')).ticks, 0);
  assert.equal((await trial.advance(1)).ticks, 1);
  await trial.close(); combat.close();
});

test('bounded trial session/request admission reserves all combat capacity and rejects overlapping trial turns', async (t) => {
  const pool = await realPool(t, { maxTrials: 2, maxTrialPending: 1, maxPending: 1, maxSessions: 1 });
  const a = pool.createTrial(input());
  assert.throws(() => pool.createTrial(input()), { code: 'QUEUE_FULL' });
  await assert.rejects(a.advance(), { code: 'TRIAL_BUSY' });
  const combat = pool.create(phase()); // trial in-flight does NOT consume maxPending or maxSessions
  await Promise.all([a.ready, combat.ready]);
  const b = pool.createTrial(input());
  assert.throws(() => pool.createTrial(input()), { code: 'TRIAL_LIMIT' });
  await assert.rejects(a.advance(), { code: 'QUEUE_FULL' });
  await b.close(); await assert.rejects(b.ready, { code: 'SESSION_CLOSED' });
  assert.equal(pool.stats().trialPending, 0);
  await a.close(); combat.close();
  await until(() => pool.stats().cleanup === 0 && pool.stats().active === 0);
  assert.equal(pool.stats().sessions, 0); assert.equal(pool.stats().pending, 0);
});

test('trial cancellation before init/in-flight, late kind/generation/seq/epoch replies and replacement epochs are contained', async (t) => {
  const pool = await realPool(t);
  const a = pool.createTrial(input()); await a.ready;
  const b = pool.createTrial(input());
  await b.close(); await assert.rejects(b.ready, { code: 'SESSION_CLOSED' });
  const advancing = a.advance();
  const slot = pool.slots[0], task = slot.active;
  for (const override of [{ kind: 'combat' }, { generation: 'old' }, { seq: task.seq - 1 }, { epoch: slot.epoch - 1 }]) {
    slot.worker.emit('message', { type: 'reply', epoch: slot.epoch, kind: 'trial', generation: task.generation, seq: task.seq, dto: { done: true }, ...override });
    assert.equal(slot.active, task);
  }
  const closing = a.close();
  assert.equal(pool.stats().pending, 0);
  await assert.rejects(advancing, { code: 'SESSION_CLOSED' });
  await closing; await a.close();
  const oldEpoch = slot.epoch, oldWorker = slot.worker;
  await oldWorker.terminate();
  await until(() => slot.ready && slot.worker !== oldWorker);
  assert.equal(slot.epoch, oldEpoch + 1);
  const c = pool.createTrial(input());
  assert.notEqual(c.generation, a.generation);
  assert.equal((await c.ready).ticks, 0);
  await c.close();
  assert.equal(oldWorker.listenerCount('message'), 0);
});

test('trial invalid command fails once without ending same-worker combat; actual worker failure affects only its slots', async (t) => {
  const pool = await realPool(t, { size: 2 });
  let failures = 0;
  const a = pool.createTrial(input(), { onFailure: () => failures++ }); await a.ready;
  const combat = pool.create(phase()); await combat.ready;
  await assert.rejects(a.advance(33), { code: 'WORKER_COMMAND' });
  assert.equal(failures, 1);
  assert.equal((await combat.request('advance', { ticks: 2 })).ticks, 2);
  await a.close();
  const live = pool.createTrial(input(), { onFailure: () => failures++ }); await live.ready;
  const other = pool.createTrial(input()); await other.ready;
  const slot = pool.sessions.get(live.generation).slot;
  assert.notEqual(slot, pool.sessions.get(other.generation).slot);
  const dying = slot.worker.terminate();
  const request = live.advance();
  await dying; await assert.rejects(request);
  assert.equal(failures, 2);
  await live.close();
  assert.ok((await other.advance()).ticks <= 32);
  await other.close(); combat.close();
});

test('queued trial timeout cancels only trial, not worker or same-slot authoritative boss HP/LP', async (t) => {
  const pool = await realPool(t);
  const combat = pool.create(phase('boss')); const before = await combat.ready;
  const a = pool.createTrial(input()); await a.ready;
  pool.requestTimeoutMs = 25;
  let failure;
  const b = pool.createTrial(input(), { onFailure: (e) => { failure = e; } });
  await assert.rejects(b.ready, { code: 'REQUEST_TIMEOUT' });
  assert.equal(failure.code, 'REQUEST_TIMEOUT');
  assert.equal(pool.stats().ready, 1);
  const after = await combat.request('state');
  assert.deepEqual(after.boss, before.boss);
  assert.equal(after.done, false);
  await b.close(); await a.close(); combat.close();
});

test('evaluateTrial abort/consumer error and pool shutdown cancel once and release all resources', async (t) => {
  const pool = await realPool(t);
  const signal = new AbortController();
  const evaluating = pool.evaluateTrial(input(), { signal: signal.signal, onProgress: () => signal.abort() });
  await assert.rejects(evaluating, { code: 'SESSION_CLOSED' });
  assert.equal(pool.stats().sessions, 0);
  await assert.rejects(pool.evaluateTrial(input(), { onProgress: () => { throw new Error('consumer failed'); } }), /consumer failed/);
  assert.equal(pool.stats().sessions, 0);
  const handles = [pool.createTrial(input()), pool.createTrial(input())];
  let failures = 0;
  const combat = pool.create(phase(), { onFailure: () => failures++ });
  const workers = pool.slots.map((s) => s.worker);
  const closing = pool.close();
  await Promise.all([...handles, combat].map((h) => assert.rejects(h.ready, { code: 'POOL_CLOSED' })));
  await Promise.all(handles.map((h) => h.close())); await closing; await pool.close();
  assert.equal(failures, 0);
  assert.equal(pool.stats().sessions, 0); assert.equal(pool.stats().pending, 0);
  assert.equal(pool.stats().trials, 0); assert.equal(pool.stats().activeTrials, 0);
  assert.equal(pool.terminating.size, 0);
  assert.ok(pool.slots.every((s) => !s.active && !s.trial && !s.queue.length && !s.cleanup.size));
  assert.ok(workers.every((w) => w.threadId === -1 && !w.listenerCount('message') && !w.listenerCount('error')));
});
