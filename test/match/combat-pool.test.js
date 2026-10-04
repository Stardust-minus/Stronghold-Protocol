import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CombatWorkerPool } from '../../server/match/combat/pool.js';
import { CombatEngine } from '../../server/match/combat/engine.js';
import { DATA, QUIET, phase, until } from './combat-fixtures.js';
import { chessRec } from '../helpers/battleHarness.js';

for (const size of [1, 2]) {
  test(`workers=${size}: normal/unite/boss/hidden full DTO equivalence, shared phase state and results`, async (t) => {
    const pool = new CombatWorkerPool({ size, data: DATA, log: QUIET });
    t.after(() => pool.close());
    await pool.start();
    const inputs = ['normal', 'unite', 'boss', 'hidden'].map(phase);
    const handles = inputs.map((input) => pool.create(input));
    const engines = inputs.map((input) => new CombatEngine(input, { data: DATA, log: QUIET }));
    t.after(() => engines.forEach((e) => e.dispose()));
    assert.equal(pool.stats().workers, size);
    if (size === 2) assert.deepEqual(pool.slots.map((s) => s.sessions.size), [2, 2]);
    for (let i = 0; i < handles.length; i++) {
      assert.deepEqual(await handles[i].ready, engines[i].state({ snapshotFields: inputs[i].specs.map((s) => s.fieldId) }));
    }
    await Promise.all(handles.map(async (handle, i) => {
      let out;
      do {
        // Change watchers between batches; all terminal fields still need their snapshots.
        const snapshotFields = engines[i].runner.ticks % 2 ? [] : [inputs[i].specs[0].fieldId];
        out = await handle.request('advance', { ticks: 17, snapshotFields });
        assert.deepEqual(out, engines[i].advance(17, { snapshotFields }), inputs[i].specs[0].kind);
        assert.deepEqual(await handle.request('state', { snapshotFields }), engines[i].state({ snapshotFields }));
      } while (!out.done);
      for (const field of out.fields) {
        assert.ok(field.result.perPlayer);
        assert.ok(Object.values(field.result.perPlayer).every((p) => Array.isArray(p.unitStats)));
        assert.ok(out.frames.some((f) => f.fieldId === field.fieldId && f.meta && f.snapshot));
      }
      handle.close();
    }));
    await until(() => pool.stats().active === 0 && pool.stats().cleanup === 0);
    assert.equal(pool.stats().sessions, 0);
    assert.equal(pool.stats().pending, 0);
  });
}

test('one-time transferred full dataset drives BOTH DataSource and content support across sessions', async (t) => {
  const data = {
    ...DATA,
    chess: { ...DATA.chess, worker_test_a: chessRec({ id: 'worker_test_a', stats: { maxHp: 1234 } }) },
    bands: { ...DATA.bands, band_worker_test: { buffs: [{
      key: 'band_test', bbStr: { key: 'act1autochess_band2_buff' }, bb: { value_1: 0, max_hp_1: 1 },
    }] } },
  };
  const pool = new CombatWorkerPool({ size: 2, data, log: QUIET });
  t.after(() => pool.close());
  await pool.start();
  for (let i = 0; i < 6; i++) {
    const input = phase();
    for (const s of input.specs) for (const p of s.players) {
      p.bandId = 'band_worker_test';
      p.units = [{ ...p.units[0], chessId: 'worker_test_a', row: 10, col: 8 }];
    }
    const h = pool.create(input);
    await h.ready;
    await h.request('advance', { ticks: 1 }); // real Battle installs content/deploys on its first step
    const out = await h.request('state', { snapshotFields: ['n:p0'] });
    const unit = out.frames[0].meta.units.find((u) => u.defId === 'worker_test_a');
    assert.equal(unit.maxHp, 2468, '1234 HP from injected sim data multiplied by injected band content');
    assert.equal(out.frames[0].snapshot.units.find((u) => u[0] === unit.id)[4], 2468);
    h.close();
  }
  assert.ok(Object.isFrozen(data.bands.band_worker_test.buffs[0].bb));
});

test('bounded admission, cancel-before-init, immediate promise cleanup, and unique session generations', async (t) => {
  const pool = new CombatWorkerPool({ size: 1, maxSessions: 2, maxPending: 2, log: QUIET });
  t.after(() => pool.close());
  assert.throws(() => pool.create(phase()), /not ready/);
  await pool.start();
  const a = pool.create(phase());
  const b = pool.create(phase());
  assert.throws(() => pool.create(phase()), { code: 'SESSION_LIMIT' });
  await assert.rejects(a.request('state'), { code: 'QUEUE_FULL' });
  b.close();
  assert.equal(pool.stats().pending, 1, 'queued initialization is removed immediately');
  await assert.rejects(b.ready, { code: 'SESSION_CLOSED' });
  a.close();
  assert.equal(pool.stats().sessions, 0);
  assert.equal(pool.stats().pending, 0, 'in-flight callbacks/promises removed immediately');
  await assert.rejects(a.ready, { code: 'SESSION_CLOSED' });
  await assert.rejects(a.request('state'), { code: 'SESSION_CLOSED' });
  const c = pool.create(phase());
  assert.notEqual(c.generation, a.generation);
  await c.ready;
  assert.equal((await c.request('state')).ticks, 0, 'old in-flight initialization cannot resurrect a cancelled generation');
  c.close();
  await until(() => pool.stats().active === 0 && pool.stats().cleanup === 0);
});

test('queue bound includes in-flight work, requests are ordered, force is idempotent', async (t) => {
  const pool = new CombatWorkerPool({ size: 1, maxPending: 2, log: QUIET });
  t.after(() => pool.close());
  await pool.start();
  const h = pool.create(phase());
  await h.ready;
  const a = h.request('advance', { ticks: 3, snapshotFields: [] });
  const b = h.request('state', { snapshotFields: ['n:p0'] });
  await assert.rejects(h.request('state'), { code: 'QUEUE_FULL' });
  assert.equal((await a).ticks, 3);
  assert.equal((await b).ticks, 3);
  const field = await h.request('forceField', { fieldId: 'n:p0', reason: 'forced' });
  assert.equal(field.fields[0].live, false);
  assert.equal(field.fields[1].live, true);
  assert.equal(field.frames.at(-1).fieldId, 'n:p0');
  assert.equal((await h.request('forceAll', { reason: 'forced' })).done, true);
  assert.equal((await h.request('forceAll', { reason: 'forced' })).done, true);
  h.close();
});

test('stale generation/sequence/epoch replies never resolve the current request', async (t) => {
  const pool = new CombatWorkerPool({ size: 1, log: QUIET });
  t.after(() => pool.close());
  await pool.start();
  const h = pool.create(phase());
  await h.ready;
  const request = h.request('advance', { ticks: 3 });
  const slot = pool.slots[0];
  const current = slot.active;
  for (const override of [{ generation: 'old' }, { seq: current.seq - 1 }, { epoch: slot.epoch - 1 }]) {
    slot.worker.emit('message', { type: 'reply', epoch: slot.epoch, generation: current.generation, seq: current.seq, dto: { ticks: -999 }, ...override });
    assert.equal(slot.active, current);
  }
  assert.equal((await request).ticks, 3);
  h.close();
});

test('runtime crash fails idle AND active sessions once; unrelated worker survives; replacements bounded', async (t) => {
  const pool = new CombatWorkerPool({ size: 2, log: QUIET });
  t.after(() => pool.close());
  await pool.start();
  const failures = [];
  const a = pool.create(phase(), { onFailure: (e) => { failures.push(['a', e]); throw new Error('callback failure'); } });
  const other = pool.create(phase(), { onFailure: () => failures.push(['other']) });
  const idle = pool.create(phase(), { onFailure: async (e) => { failures.push(['idle', e]); throw new Error('async callback failure'); } });
  await Promise.all([a.ready, other.ready, idle.ready]);
  const old = pool.slots[0].worker;
  const oldExit = old.terminate();
  const pending = a.request('advance', { ticks: 1024 });
  await oldExit;
  await assert.rejects(pending);
  assert.deepEqual(failures.map(([id]) => id).sort(), ['a', 'idle']);
  await assert.rejects(idle.request('state'), { code: 'SESSION_CLOSED' });
  assert.equal((await other.request('state')).ticks, 0);
  await until(() => pool.slots[0].ready);
  assert.notEqual(pool.slots[0].worker, old);
  assert.equal(old.listenerCount('message'), 0);
  assert.equal(old.listenerCount('error'), 0);
  for (let i = 0; i < 3; i++) {
    const worker = pool.slots[0].worker;
    await worker.terminate();
    if (i < 2) await until(() => pool.slots[0].ready);
  }
  assert.equal(pool.slots[0].replacements, 3);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(pool.slots[0].worker, null, 'replacement budget exhausted, not an infinite crash loop');
  assert.equal(pool.stats().ready, 1);
  assert.equal(pool.stats().sessions, 1, 'surviving worker did not restart its phase');
  other.close();
});

test('synthetic full results survive worker transport and retain diagnostic records separately', async (t) => {
  const pool = new CombatWorkerPool({ size: 1, log: QUIET });
  t.after(() => pool.close());
  await pool.start();
  const input = phase();
  input.specs[0].routes = {}; // deterministically fail construction, not a content handler
  const inline = new CombatEngine(input, { data: DATA, log: QUIET });
  t.after(() => inline.dispose());
  const h = pool.create(input);
  const out = await h.ready;
  const expected = inline.state();
  assert.deepEqual(out.fields[0].result, expected.fields[0].result);
  assert.equal(out.fields[0].result.synthetic, true);
  assert.ok(Array.isArray(out.fields[0].result.perPlayer.p0.unitStats));
  assert.equal(out.fields[0].errors[0].label, expected.fields[0].errors[0].label);
  assert.equal(out.fields[0].errors[0].message, expected.fields[0].errors[0].message);
  assert.ok(out.fields[0].errors[0].stack);
  assert.ok(out.frames.some((f) => f.fieldId === input.specs[0].fieldId && f.snapshot && f.meta));
  h.close();
});

test('worker command failure fails the session once without reanimating a display snapshot', async (t) => {
  const pool = new CombatWorkerPool({ size: 1, log: QUIET });
  t.after(() => pool.close());
  await pool.start();
  const failures = [];
  const h = pool.create(phase(), { onFailure: (e) => failures.push(e) });
  await h.ready;
  await assert.rejects(h.request('advance', { ticks: Infinity }), { code: 'WORKER_COMMAND' });
  assert.equal(failures.length, 1);
  assert.equal(pool.stats().sessions, 0);
  assert.equal(pool.stats().ready, 1, 'bad command does not crash a healthy worker');
  await assert.rejects(h.request('state'), { code: 'SESSION_CLOSED' });
});

test('request timeout and cancellation watchdog terminate stalled workers, including idle handles', async (t) => {
  const pool = new CombatWorkerPool({ size: 1, log: QUIET });
  t.after(() => pool.close());
  await pool.start();
  const failures = [];
  const h = pool.create(phase(), { onFailure: (e) => failures.push(e) });
  const idle = pool.create(phase(), { onFailure: (e) => failures.push(e) });
  await Promise.all([h.ready, idle.ready]);
  pool.requestTimeoutMs = 30;
  const old = pool.slots[0].worker;
  old.postMessage = () => {}; // hold transport permanently; watchdog must cover cancelled in-flight work too
  const pending = h.request('advance', { ticks: 1 });
  h.close();
  await assert.rejects(pending, { code: 'SESSION_CLOSED' });
  await until(() => failures.length === 1);
  assert.equal(failures[0].code, 'REQUEST_TIMEOUT');
  assert.equal(pool.stats().sessions, 0);
  await pool.close();
  assert.equal(old.listenerCount('error'), 0);
});

test('request deadline rejects active and queued work; onFailure may close the pool reentrantly', async () => {
  const pool = new CombatWorkerPool({ size: 1, log: QUIET });
  await pool.start();
  let closing = null;
  const h = pool.create(phase(), { onFailure: () => { closing = pool.close(); } });
  await h.ready;
  pool.requestTimeoutMs = 20;
  const old = pool.slots[0].worker;
  old.postMessage = () => {};
  const active = h.request('advance', { ticks: 1 });
  const queued = h.request('state');
  await assert.rejects(active, { code: 'REQUEST_TIMEOUT' });
  await assert.rejects(queued, { code: 'REQUEST_TIMEOUT' });
  assert.ok(closing);
  await closing;
  assert.equal(pool.stats().status, 'closed');
  assert.equal(pool.stats().pending, 0);
  assert.equal(pool.terminating.size, 0, 'reentrant close waits for the failed worker too');
  assert.equal(old.listenerCount('error'), 0);
  assert.equal(pool.slots[0].retry, null);
});

test('startup clone failure / timeout reject explicitly, and close during startup cleans all workers', async () => {
  const broken = new CombatWorkerPool({ size: 2, data: { functionCannotClone() {} }, log: QUIET });
  await assert.rejects(broken.start());
  assert.equal(broken.stats().workers, 0);
  assert.equal(broken.stats().status, 'closed');
  const slow = new CombatWorkerPool({ size: 1, startupTimeoutMs: 1, log: QUIET });
  await assert.rejects(slow.start(), { code: 'WORKER_STARTUP_TIMEOUT' });
  assert.equal(slow.stats().workers, 0);
  const closing = new CombatWorkerPool({ size: 2, log: QUIET });
  const starting = closing.start();
  await closing.close();
  await assert.rejects(starting, { code: 'POOL_CLOSED' });
  assert.equal(closing.stats().workers, 0);
  await closing.close();
});

test('shutdown rejects queued and active work, clears timers/listeners and does not call failure callbacks or log errors', async () => {
  const errors = [];
  const pool = new CombatWorkerPool({ size: 2, log: { error: (e) => errors.push(e) } });
  await pool.start();
  const workers = pool.slots.map((s) => s.worker);
  let failed = 0;
  const handles = Array.from({ length: 5 }, () => pool.create(phase(), { onFailure: () => failed++ }));
  const commands = handles.map((h) => h.request('state'));
  const closed = pool.close();
  await Promise.all([...handles.map((h) => assert.rejects(h.ready, { code: 'POOL_CLOSED' })), ...commands.map((p) => assert.rejects(p, { code: 'POOL_CLOSED' }))]);
  await closed;
  assert.equal(failed, 0);
  assert.deepEqual(errors, []);
  assert.equal(pool.stats().pending, 0);
  assert.equal(pool.stats().sessions, 0);
  assert.equal(pool.stats().workers, 0);
  assert.ok(pool.slots.every((s) => !s.retry && !s.startupTimer && !s.active && !s.queue.length));
  assert.ok(workers.every((w) => w.listenerCount('message') === 0 && w.listenerCount('error') === 0));
  assert.throws(() => pool.create(phase()), { code: 'POOL_UNAVAILABLE' });
});
