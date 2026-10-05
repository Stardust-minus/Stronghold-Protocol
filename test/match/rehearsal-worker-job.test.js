import test from 'node:test';
import assert from 'node:assert/strict';
import { Battle } from '../../server/sim/Battle.js';
import { canUseWorkerRehearsal, createWorkerRehearsal } from '../../server/match/combat/rehearsal.js';
import { TrialEngine } from '../../server/match/combat/trial.js';
import { DATA, phase } from './combat-fixtures.js';

const progress = (bestIndex = 0, done = false) => ({ bestIndex, done, ticks: done ? 32 : 0,
  candidateIndex: done ? 2 : 0, bestScore: done ? 1 : -Infinity, bestLeaks: done ? 0 : Infinity,
  candidates: done ? [0, 1].map((index) => ({ index, ticks: 16, duration: 16 / 30, beaten: false, score: index,
    leaks: 0, result: {}, error: null })) : [] });
function fixture(ready = Promise.resolve(progress()), advance = async () => progress(1, true)) {
  const calls = { creates: 0, advances: 0, closes: 0 };
  const pool = { createTrial(input) {
    calls.creates++; calls.input = input;
    return { ready, advance: () => { calls.advances++; return advance(); }, close: () => { calls.closes++; return Promise.resolve(); } };
  } };
  const plans = [new Map([[1, 'a']]), new Map([[1, 'b']])], chosen = [{ uid: 1 }];
  const job = createWorkerRehearsal(pool, { playerId: 'p1', chosen, plans, candidates: [{ seed: 1 }, { seed: 1 }], cap: 100 });
  return { job, calls, chosen, plans };
}

test('only real default-Battle matches with a trial-capable pool can offload', () => {
  const m = { sched: { virtual: false }, BattleClass: Battle, trialPool: { runTrial() {} }, combatPool: { createTrial() {} } };
  assert.equal(canUseWorkerRehearsal(m), true);
  assert.equal(canUseWorkerRehearsal({ ...m, sched: { virtual: true } }), false);
  assert.equal(canUseWorkerRehearsal({ ...m, BattleClass: class CustomBattle {} }), false);
  assert.equal(canUseWorkerRehearsal({ ...m, clientCombat: true }), false);
  assert.equal(canUseWorkerRehearsal({ ...m, trialPool: null }), false, 'combatPool is never an implicit rehearsal pool');
  assert.equal(canUseWorkerRehearsal({ ...m, trialPool: { create() {} } }), false);
  assert.equal(canUseWorkerRehearsal({ ...m, trialPool: { createTrial() {} } }), true, 'explicit legacy adapter is supported');
});

test('remote job waits for actual ready/advance replies, chooses only original plans and closes once', async () => {
  const f = fixture();
  assert.strictEqual(f.job.chosen, f.chosen); assert.strictEqual(f.job.best, f.plans[0]);
  assert.equal(await f.job.advance(), false); assert.equal(f.calls.advances, 0);
  assert.equal(await f.job.advance(), true); assert.strictEqual(f.job.best, f.plans[1]);
  assert.equal(f.job.done, true); assert.equal(f.calls.closes, 1);
  await f.job.close(); assert.equal(f.calls.closes, 1);
});

test('cancelled in-flight ready cannot publish a late winner', async () => {
  let reply;
  const f = fixture(new Promise(resolve => { reply = resolve; }));
  const running = f.job.advance();
  await f.job.close(); reply(progress(1, true));
  await assert.rejects(running, /cancelled/);
  assert.strictEqual(f.job.best, f.plans[0]); assert.equal(f.job.done, false); assert.equal(f.calls.closes, 1);
});

test('concurrent advances are rejected and malformed/failing replies release the reservation', async () => {
  let reply;
  const f = fixture(new Promise(resolve => { reply = resolve; }));
  const running = f.job.advance();
  await assert.rejects(f.job.advance(), /already advancing/);
  reply(progress(2)); await assert.rejects(running, /invalid rehearsal winner/);
  assert.equal(f.calls.closes, 1); assert.strictEqual(f.job.best, f.plans[0]);
  const broken = fixture(Promise.reject(new Error('worker failed')));
  await assert.rejects(broken.job.advance(), /worker failed/); assert.equal(broken.calls.closes, 1);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const streamedProgress = (ticks = 0, sliceCount = 0, records = []) => {
  let bestIndex = 0, bestScore = -Infinity, bestLeaks = Infinity;
  for (const c of records) if (c.score !== null && c.score > bestScore) {
    bestIndex = c.index; bestScore = c.score; bestLeaks = c.leaks;
  }
  return { summary: true, ticks, sliceCount, candidateIndex: records.length, done: records.length === 2,
    bestIndex, bestScore, bestLeaks, candidates: records };
};
const record = (index, ticks = 80) => ({ index, ticks, duration: ticks / 30, beaten: false, leaks: 0,
  score: index, error: null, result: null, synthetic: false });
function streamedFixture({ close, input } = {}) {
  const ready = deferred(), done = deferred();
  const calls = { runs: 0, closes: 0 };
  const pool = { runTrial(input, options) {
    calls.runs++; calls.input = input; calls.options = options;
    return { ready: ready.promise, done: done.promise, close() { calls.closes++; return close?.(); } };
  } };
  const plans = [new Map([[1, 'a']]), new Map([[1, 'b']])];
  input ??= { playerId: 'p0', candidates: [phase().specs[0], phase().specs[0]], cap: 100 };
  const job = createWorkerRehearsal(pool, { ...input, chosen: [{ uid: 1 }], plans });
  return { job, calls, ready, done, plans, input };
}

test('dedicated job admits lazily once, accepts aggregate slices >32 ticks, validates every completed record and publishes only after cleanup', async () => {
  const cleaned = deferred(), f = streamedFixture({ close: () => cleaned.promise });
  assert.equal(f.calls.runs, 0);
  const seen = [];
  const running = f.job.start({ onProgress: (p) => seen.push(p.ticks), timeoutMs: 1234 });
  assert.equal(f.calls.runs, 1); assert.equal(f.calls.options.summary, true); assert.equal(f.calls.options.timeoutMs, 1234);
  await assert.rejects(f.job.start(), /already started/);
  f.ready.resolve(streamedProgress());
  await Promise.resolve();
  f.calls.options.onProgress(streamedProgress(64, 2));
  f.done.resolve(streamedProgress(160, 5, [record(0), record(1)]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [64]); assert.equal(f.calls.closes, 1);
  assert.equal(f.job.done, false); assert.strictEqual(f.job.best, f.plans[0]);
  cleaned.resolve(); assert.equal(await running, true);
  assert.strictEqual(f.job.best, f.plans[1]); assert.equal(f.job.progress.ticks, 160);
  await f.job.close(); assert.equal(f.calls.closes, 1);
});

test('cancelled dedicated ready/final replies cannot publish winners and closing before start cannot admit', async () => {
  for (const at of ['ready', 'done']) {
    const f = streamedFixture(), running = f.job.start();
    if (at === 'done') { f.ready.resolve(streamedProgress()); await Promise.resolve(); }
    await f.job.close();
    f.ready.resolve(streamedProgress()); f.done.resolve(streamedProgress(160, 5, [record(0), record(1)]));
    await assert.rejects(running, /cancelled/);
    assert.equal(f.job.done, false); assert.strictEqual(f.job.best, f.plans[0]); assert.equal(f.calls.closes, 1);
    assert.throws(() => f.job.fallback(DATA), /cannot restart/);
  }
  const f = streamedFixture(); await f.job.close();
  await assert.rejects(f.job.start(), /cancelled/); assert.equal(f.calls.runs, 0);
});

for (const [name, mutate] of [
  ['ticks without slices', (p) => { p.sliceCount = 4; }],
  ['negative slices', (p) => { p.sliceCount = -1; }],
  ['candidate cap', (p) => { p.candidates[0].ticks = 101; }],
  ['final tick sum', (p) => { p.ticks = 159; }],
  ['incomplete final', (p) => { p.done = false; }],
  ['winner index', (p) => { p.bestIndex = 0; }],
  ['winner score', (p) => { p.bestScore = 9; }],
  ['synthetic score', (p) => { p.candidates[0].synthetic = true; }],
  ['missing synthetic flag', (p) => { delete p.candidates[0].synthetic; }],
  ['beaten score', (p) => { p.candidates[0].beaten = true; }],
  ['unexpected full result', (p) => { p.candidates[0].result = {}; }],
]) test(`dedicated malformed ${name} is rejected and released instead of applying a proposal`, async () => {
  const f = streamedFixture(), running = f.job.start();
  f.ready.resolve(streamedProgress());
  const p = streamedProgress(160, 5, [record(0), record(1)]); mutate(p); f.done.resolve(p);
  await assert.rejects(running, /invalid rehearsal winner/);
  assert.equal(f.calls.closes, 1); assert.equal(f.job.done, false); assert.strictEqual(f.job.best, f.plans[0]);
});

test('dedicated completed-prefix/candidate/slice/tick regressions fail even when the final max-score winner is plausible', async () => {
  for (const change of ['prefix', 'candidate', 'slice', 'tick']) {
    const f = streamedFixture(), running = f.job.start(); f.ready.resolve(streamedProgress());
    f.calls.options.onProgress(streamedProgress(80, 3, [record(0, 16)]));
    const p = streamedProgress(100, 4, [record(0, 16), record(1, 84)]);
    if (change === 'prefix') p.candidates[0].duration = 1;
    else if (change === 'candidate') Object.assign(p, { candidateIndex: 0, done: false, candidates: [] });
    else if (change === 'slice') p.sliceCount = 2;
    else p.ticks = 79;
    f.done.resolve(p); await assert.rejects(running, /invalid rehearsal winner/);
    assert.equal(f.calls.closes, 1);
  }
});

test('dedicated progress faults cannot restart inline until remote cleanup acknowledges, then ALL frozen candidates recompute unchanged', async () => {
  const cleaned = deferred(), f = streamedFixture({ close: () => cleaned.promise });
  const expected = new TrialEngine(f.input, { data: DATA, summary: true });
  while (!expected.advanceSlice()) { /* bounded engine slices, no external scheduling needed in this unit fixture */ }
  const final = expected.state(); expected.dispose();
  const running = f.job.start();
  f.ready.resolve(streamedProgress());
  f.calls.options.onProgress(streamedProgress(64, 1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.closes, 1); assert.throws(() => f.job.fallback(DATA), /cannot restart/);
  let rejected = false; running.catch(() => { rejected = true; });
  await Promise.resolve(); assert.equal(rejected, false, 'failure is not exposed before remote release');
  cleaned.resolve(); await assert.rejects(running, /invalid rehearsal winner/);
  f.job.fallback(DATA);
  while (!f.job.run(0.001)) { /* each call stays bounded */ }
  assert.deepEqual({ ...f.job.progress, sliceCount: 0 }, { ...final, sliceCount: 0 });
  assert.ok(f.job.progress.sliceCount > 0); assert.equal(f.job.progress.candidates.length, 2);
  assert.equal(f.calls.runs, 1); assert.equal(f.calls.closes, 1);
  assert.ok(Object.isFrozen(f.calls.input.candidates[0]));
  assert.deepEqual(f.calls.input.candidates, f.input.candidates);
  await f.job.close();
});
