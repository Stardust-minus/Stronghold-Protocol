import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CombatWorkerPool } from '../../server/match/combat/pool.js';
import { TrialEngine, MAX_TRIAL_TICKS } from '../../server/match/combat/trial.js';
import { DATA, QUIET, phase, until } from './combat-fixtures.js';

function input(cap = 270) {
  const candidate = { ...phase().specs[0], sharedBoss: null };
  candidate.flags.layerGainsEnabled = false;
  return { playerId: 'p0', candidates: [structuredClone(candidate), structuredClone(candidate)], cap };
}
function longInput(cap = 10_000_000) {
  const data = input(cap);
  for (const c of data.candidates) {
    c.timeLimit = Infinity;
    c.autoFinish = false;
    // Explicit artificial busy fixture: the simulator's global hard timeout means a giant cap
    // alone is not sufficient to guarantee even one 50ms report on an otherwise empty field.
    const unit = c.players[0].units[0];
    c.players[0].units = Array.from({ length: 18 }, (_, i) => ({ ...unit, uid: i + 1, row: 9 + (i % 3), col: 5 + Math.floor(i / 3) }));
    c.flags.dpInit = 9999; c.flags.dpMax = 9999;
    c.spawns = [{ time: 0, enemyKey: 'enemy_1007_slime', routeIndex: 0, count: 24, interval: 1, mods: { hpMul: 1e6 } }];
  }
  return data;
}
async function realPool(t, opts = {}) {
  const pool = new CombatWorkerPool({ size: 1, role: 'trial', data: DATA, log: QUIET, ...opts });
  t.after(() => pool.close());
  await pool.start();
  return pool;
}
function inline(data, summary = true) {
  const engine = new TrialEngine(data, { data: DATA, summary });
  while (!engine.advanceSlice()) {}
  const out = engine.state({ stream: true });
  engine.dispose();
  return out;
}
function comparable({ sliceCount, ...dto }) { return dto; }
async function drained(pool) {
  await until(() => {
    const s = pool.stats();
    return s.sessions === 0 && s.pending === 0 && s.cleanup === 0 && s.activeTrials === 0 && s.queued === 0 && s.active === 0;
  });
}

test('dedicated role validation and gates leave formal/legacy API unchanged', async (t) => {
  for (const opts of [{ role: 'unknown', size: 1 }, { role: 'trial', size: 3 }, { role: 'trial', size: 0 }, { role: 'trial', size: 1, trialStallTimeoutMs: 0 }]) {
    assert.throws(() => new CombatWorkerPool({ data: DATA, ...opts }), RangeError);
  }
  const pool = await realPool(t);
  assert.equal(pool.role, 'trial');
  assert.throws(() => pool.create(phase()), { code: 'BAD_POOL_ROLE' });
  const formal = await realPool(t, { role: 'combat' });
  assert.throws(() => formal.runTrial(input()), { code: 'BAD_POOL_ROLE' });
  const legacy = pool.createTrial(input());
  let out = await legacy.ready;
  while (!out.done) out = await legacy.advance();
  assert.ok(out.candidates[0].result.perPlayer.p0.unitStats.length);
  assert.equal(Object.hasOwn(out, 'sliceCount'), false);
  await legacy.close();
  await drained(pool);
});

test('one and two dedicated workers match inline scores/ticks/winner with no advance RPCs', async (t) => {
  for (const size of [1, 2]) await t.test(`size ${size}`, async (t) => {
    const pool = await realPool(t, { size });
    const posts = [];
    for (const slot of pool.slots) {
      const post = slot.worker.postMessage.bind(slot.worker);
      slot.worker.postMessage = (m) => { posts.push([m.type, m.op]); post(m); };
    }
    const data = input();
    const expected = inline(data);
    const jobs = Array.from({ length: 4 }, () => pool.runTrial(data));
    for (const job of jobs) {
      const ready = await job.ready;
      assert.equal(ready.ticks, 0); assert.equal(ready.sliceCount, 0); assert.equal(ready.candidateIndex, 0);
      assert.equal(ready.summary, true); assert.deepEqual(ready.candidates, []);
      const out = await job.done;
      assert.deepEqual(comparable(out), comparable(expected));
      assert.ok(out.sliceCount >= Math.ceil(out.ticks / MAX_TRIAL_TICKS));
      assert.ok(out.candidates.every((c) => c.result === null));
      await job.close();
    }
    assert.equal(posts.filter(([type, op]) => type === 'request' && op === 'run').length, 4);
    assert.equal(posts.filter(([, op]) => op === 'advance').length, 0);
    await drained(pool);
  });
});

test('dedicated full diagnostics retain all result/settlement/synthetic fields', async (t) => {
  const pool = await realPool(t);
  const data = input(); data.candidates[0].routes = {};
  const job = pool.runTrial(data, { summary: false });
  await job.ready;
  const out = await job.done;
  assert.deepEqual(comparable(out), comparable(inline(data, false)));
  assert.equal(out.summary, false);
  assert.equal(out.candidates[0].result.synthetic, true);
  assert.equal(out.candidates[0].synthetic, true);
  assert.equal(out.candidates[0].score, null);
  assert.equal(out.bestIndex, 1);
  assert.ok(out.candidates[1].result.perPlayer.p0.unitStats.length);
  await job.close();
  await drained(pool);
});

test('actual dedicated pruning stays at tick64 while progress is aggregated, not per slice', async (t) => {
  const pool = await realPool(t);
  const data = input(300);
  for (const c of data.candidates) {
    c.timeLimit = 10; c.players[0].units = [];
    c.routes = [{ motion: 'WALK', start: [9, 3], end: [9, 2], checkpoints: [] }];
  }
  data.candidates[0].spawns = [];
  data.candidates[1].spawns = [{ time: 0, enemyKey: 'enemy_1007_slime', routeIndex: 0 }, { time: 8, enemyKey: 'enemy_1007_slime', routeIndex: 0 }];
  const job = pool.runTrial(data);
  await job.ready;
  const out = await job.done;
  assert.deepEqual(comparable(out), comparable(inline(data)));
  assert.equal(out.candidates[1].beaten, true);
  assert.equal(out.candidates[1].ticks, 64);
  await job.close();
});

test('stream capacity/FIFO occupies one engine per worker until actual cancel ACK', async (t) => {
  const pool = await realPool(t, { maxTrials: 2, maxTrialPending: 2 });
  const a = pool.runTrial(longInput());
  await a.ready;
  const b = pool.runTrial(input());
  assert.throws(() => pool.runTrial(input()), { code: 'TRIAL_LIMIT' });
  assert.equal(pool.stats().trials, 2);
  assert.equal(pool.stats().activeTrials, 1);
  assert.equal(pool.stats().queued, 1);
  assert.equal(pool.stats().trialPending, 1);
  const closing = a.close();
  await assert.rejects(a.done, { code: 'SESSION_CLOSED' });
  assert.equal(pool.stats().activeTrials, 1, 'reservation is not freed before worker confirmation');
  await closing;
  assert.equal((await b.ready).ticks, 0);
  assert.equal((await b.done).done, true);
  await b.close();
  await drained(pool);
});

test('queued admission deadline and pending cap do not terminate a healthy trial worker', async (t) => {
  const pool = await realPool(t, { maxTrialPending: 1 });
  const a = pool.runTrial(longInput()); await a.ready;
  let failed = 0;
  const b = pool.runTrial(input(), { timeoutMs: 25, onFailure: (e) => { assert.equal(e.code, 'TRIAL_TIMEOUT'); failed++; } });
  assert.throws(() => pool.runTrial(input()), { code: 'QUEUE_FULL' });
  await assert.rejects(b.ready, { code: 'TRIAL_TIMEOUT' });
  await assert.rejects(b.done, { code: 'TRIAL_TIMEOUT' });
  await b.close();
  assert.equal(failed, 1); assert.equal(pool.stats().ready, 1); assert.equal(pool.stats().replacements, 0);
  await a.close(); await drained(pool);
});

test('cancel before run ACK, queued cancel and repeated close release exactly once', async (t) => {
  const pool = await realPool(t);
  let failed = 0;
  const a = pool.runTrial(longInput(), { onFailure: () => failed++ });
  const queued = pool.runTrial(input(), { onFailure: () => failed++ });
  await queued.close(); await assert.rejects(queued.ready, { code: 'SESSION_CLOSED' });
  await assert.rejects(queued.done, { code: 'SESSION_CLOSED' });
  const close = a.close();
  assert.equal(a.close(), close);
  await assert.rejects(a.ready, { code: 'SESSION_CLOSED' });
  await assert.rejects(a.done, { code: 'SESSION_CLOSED' });
  await close; await drained(pool);
  const b = pool.runTrial(input()); await b.ready; await b.done; await b.close();
  assert.equal(failed, 0); await drained(pool);
});

test('single-credit progress is low frequency/aggregated and an async consumer cannot block done', async (t) => {
  const pool = await realPool(t);
  const observed = [];
  const incoming = [];
  const slot = pool.slots[0];
  slot.worker.prependListener('message', (m) => { if (m.type === 'trialEvent' && m.event === 'progress') incoming.push(m); });
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const job = pool.runTrial(longInput(400_000), { onProgress: (p) => { observed.push(p); return hold; } });
  await job.ready;
  const out = await job.done;
  assert.equal(out.done, true);
  assert.ok(incoming.length >= 1, 'real worker produced at least one aggregate event');
  assert.equal(observed.length, 1, 'only one user callback is in flight');
  let ticks = 0, slices = 0;
  for (const { dto } of incoming) {
    assert.ok(dto.ticks - ticks <= MAX_TRIAL_TICKS * (dto.sliceCount - slices));
    assert.ok(dto.ticks >= ticks); assert.ok(dto.sliceCount >= slices);
    assert.equal(dto.summary, true);
    ticks = dto.ticks; slices = dto.sliceCount;
  }
  assert.ok(incoming[0].dto.ticks > MAX_TRIAL_TICKS);
  release(); await job.close(); await drained(pool);
});

test('terminal event bypasses exhausted worker progress credit and duplicate events do not mint credit', async (t) => {
  const pool = await realPool(t);
  const control = pool._trialControl.bind(pool);
  // Hold one real worker credit forever, without advancing its control sequence.
  pool._trialControl = (session, op, payload) => op === 'progressAck' ? session.controlSeq : control(session, op, payload);
  const reports = [];
  const slot = pool.slots[0];
  slot.worker.on('message', (m) => {
    if (m.type === 'trialEvent' && m.event === 'progress') {
      reports.push(m);
      pool._trialEvent(slot, m); // The real event was already handled by the pool listener.
    }
  });
  const job = pool.runTrial(longInput(400_000));
  await job.ready;
  assert.equal((await job.done).done, true);
  assert.equal(reports.length, 1, 'worker sends no second progress without credit');
  await job.close(); await drained(pool);
});

test('real progress cannot extend the overall execution deadline', async (t) => {
  const pool = await realPool(t);
  let failed = 0, reports = 0;
  const job = pool.runTrial(longInput(), { timeoutMs: 180,
    onProgress: () => reports++, onFailure: (e) => { assert.equal(e.code, 'TRIAL_TIMEOUT'); failed++; } });
  await job.ready;
  await assert.rejects(job.done, { code: 'TRIAL_TIMEOUT' });
  await job.close(); await drained(pool);
  assert.ok(reports > 0); assert.equal(failed, 1); assert.equal(pool.stats().replacements, 0);
});

test('consumer failure cancels the real stream and notifies once without replacement', async (t) => {
  const pool = await realPool(t);
  const consumerError = new Error('progress consumer rejected');
  let failed = 0;
  const job = pool.runTrial(longInput(), { onProgress: () => { throw consumerError; }, onFailure: (e) => { assert.equal(e, consumerError); failed++; } });
  await job.ready;
  await assert.rejects(job.done, /progress consumer rejected/);
  await job.close();
  assert.equal(failed, 1); assert.equal(pool.stats().replacements, 0);
  await drained(pool);
});

test('old epoch/generation events are ignored while malformed sequence zero fails only its generation', async (t) => {
  const pool = await realPool(t);
  const job = pool.runTrial(input());
  const ready = await job.ready;
  const slot = pool.slots[0];
  for (const patch of [{ epoch: slot.epoch - 1 }, { generation: 'old' }, { eventSeq: 0 }]) {
    slot.worker.emit('message', { type: 'trialEvent', epoch: slot.epoch, kind: 'trial', generation: job.generation,
      eventSeq: 1, event: 'done', dto: ready, ...patch });
  }
  // eventSeq 0 is malformed, rather than a valid duplicate; use this generation separately below.
  await assert.rejects(job.done, { code: 'BAD_TRIAL_EVENT' });
  await job.close(); await drained(pool);
  const next = pool.runTrial(input()); await next.ready;
  slot.worker.emit('message', { type: 'trialEvent', epoch: slot.epoch, kind: 'trial', generation: job.generation,
    eventSeq: 999, event: 'done', dto: ready });
  assert.equal((await next.done).done, true);
  await next.close();
});

test('event gaps and over-budget aggregate DTOs fail only their generation', async (t) => {
  const pool = await realPool(t);
  for (const patch of [{ eventSeq: 2 }, { dto: { ticks: 33, sliceCount: 1 } }, { dto: { ticks: 0, sliceCount: -1 } }]) {
    let failed = 0;
    const job = pool.runTrial(longInput(), { onFailure: () => failed++ });
    const ready = await job.ready;
    const slot = pool.slots[0];
    slot.worker.emit('message', { type: 'trialEvent', epoch: slot.epoch, kind: 'trial', generation: job.generation,
      event: 'progress', eventSeq: patch.eventSeq ?? 1, dto: { ...ready, ...(patch.dto || {}) } });
    await assert.rejects(job.done, { code: 'BAD_TRIAL_EVENT' });
    await job.close();
    assert.equal(failed, 1); assert.equal(pool.stats().replacements, 0);
    await drained(pool);
  }
});

test('empty heartbeat slice counts cannot extend the no-progress watchdog; cancel ACK still converges', async (t) => {
  const pool = await realPool(t, { trialStallTimeoutMs: 90 });
  const handleEvent = pool._trialEvent.bind(pool);
  pool._trialEvent = (slot, m) => { if (m.event === 'closed') handleEvent(slot, m); };
  const control = pool._trialControl.bind(pool);
  pool._trialControl = (session, op, payload) => op === 'progressAck' ? session.controlSeq : control(session, op, payload);
  const job = pool.runTrial(longInput()); const ready = await job.ready;
  const slot = pool.slots[0];
  let seq = 0;
  const timer = setInterval(() => {
    handleEvent(slot, { epoch: slot.epoch, kind: 'trial', generation: job.generation, event: 'progress', eventSeq: ++seq,
      dto: { ...ready, sliceCount: seq } });
  }, 10);
  try { await assert.rejects(job.done, { code: 'TRIAL_STALLED' }); }
  finally { clearInterval(timer); }
  await job.close(); await drained(pool);
  assert.equal(pool.stats().replacements, 0, 'responsive worker cancels without termination');
});

test('missing run ACK is bounded, terminates only the dedicated slot, and close waits for termination', async (t) => {
  const pool = await realPool(t, { trialAckTimeoutMs: 30 });
  const slot = pool.slots[0], worker = slot.worker;
  const post = worker.postMessage.bind(worker);
  worker.postMessage = (m) => { if (m.type !== 'request' || m.op !== 'run') post(m); };
  const job = pool.runTrial(input());
  await assert.rejects(job.ready, { code: 'REQUEST_TIMEOUT' });
  await assert.rejects(job.done, { code: 'REQUEST_TIMEOUT' });
  await job.close();
  assert.equal(worker.threadId, -1);
  await until(() => slot.ready && slot.worker !== worker);
  const next = pool.runTrial(input()); await next.ready; assert.equal((await next.done).done, true); await next.close();
});

test('lost cancel ACK forces only its dedicated worker; an independent formal boss keeps authority', async (t) => {
  const pool = await realPool(t, { trialAckTimeoutMs: 35 });
  const formal = await realPool(t, { role: 'combat' });
  const battle = formal.create(phase('boss')); const before = await battle.ready;
  const job = pool.runTrial(longInput()); await job.ready;
  const slot = pool.slots[0], worker = slot.worker, formalWorker = formal.slots[0].worker;
  const post = worker.postMessage.bind(worker);
  worker.postMessage = (m) => { if (m.type !== 'trialControl' || m.op !== 'cancel') post(m); };
  const closing = job.close();
  await assert.rejects(job.done, { code: 'SESSION_CLOSED' });
  await closing;
  assert.equal(worker.threadId, -1);
  assert.equal(formal.slots[0].worker, formalWorker);
  const after = await battle.request('state');
  assert.deepEqual(after.boss, before.boss); assert.deepEqual(after.fields, before.fields);
  assert.equal(formal.stats().replacements, 0);
  battle.close();
});

test('worker exit and lifetime replacement exhaustion remain bounded for streams', async (t) => {
  const pool = await realPool(t);
  const slot = pool.slots[0];
  for (let i = 0; i < 4; i++) {
    const job = pool.runTrial(longInput()); await job.ready;
    const worker = slot.worker;
    await worker.terminate();
    await assert.rejects(job.done, { code: 'WORKER_EXIT' });
    await job.close(); assert.equal(worker.threadId, -1);
    if (i < 3) await until(() => slot.ready && slot.worker !== worker);
  }
  assert.equal(pool.stats().replacements, 3);
  assert.equal(pool.stats().ready, 0); assert.equal(pool.stats().workers, 0);
  assert.throws(() => pool.runTrial(input()), { code: 'POOL_UNAVAILABLE' });
  await drained(pool);
});

test('shutdown/ready and final/cancel races reject or finish once and clear all stream state', async (t) => {
  const pool = await realPool(t);
  for (let i = 0; i < 6; i++) {
    const job = pool.runTrial(input(1));
    await job.ready;
    const outcome = job.done.then((dto) => dto.done, (e) => { assert.equal(e.code, 'SESSION_CLOSED'); return false; });
    const closing = job.close();
    await closing; await outcome; await drained(pool);
  }
  let failed = 0;
  const jobs = [pool.runTrial(longInput(), { onFailure: () => failed++ }), pool.runTrial(input(), { onFailure: () => failed++ })];
  const workers = pool.slots.map((s) => s.worker);
  const closing = pool.close();
  await Promise.all(jobs.map((job) => assert.rejects(job.done, { code: 'POOL_CLOSED' })));
  await Promise.all(jobs.map((job) => job.close())); await closing; await pool.close();
  assert.equal(failed, 0); assert.equal(pool.terminating.size, 0);
  assert.ok(workers.every((w) => w.threadId === -1));
  await drained(pool);
});
