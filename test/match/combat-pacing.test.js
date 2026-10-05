// Server-worker pacing regressions: real simulation/DTOs, controlled wall time and real FIFO worker turns.
// A work budget is not permission to discard active elapsed time. Inline/virtual pacing is deliberately unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { TICK } from '../../server/sim/constants.js';
import { HARD_CAP_SECONDS, INTERVAL_MS } from '../../server/match/fields.js';
import { RemoteBattle, WorkerFieldRunner, MAX_WORKER_ADVANCE_TICKS } from '../../server/match/combat/runner.js';
import { CombatEngine } from '../../server/match/combat/engine.js';
import { CombatWorkerPool } from '../../server/match/combat/pool.js';
import { DATA, QUIET, phase } from './combat-fixtures.js';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
async function until(predicate, label, ms = 10_000) {
  const deadline = performance.now() + ms;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, `timed out: ${label}`);
    await delay(2);
  }
}
function longPhase() {
  const input = phase('normal');
  for (const spec of input.specs) {
    spec.timeLimit = 1000;
    spec.spawns.at(-1).time = 999; // Actual battles remain live through the measurement, not stand-in victories.
  }
  return input;
}
function remote(pool, clock, realTimers = false) {
  const frames = [], failures = [], commands = [];
  let completions = 0, readyAt = null;
  const m = {
    combatPool: pool, gameSpeed: 2, paused: false, disposed: false, ended: false,
    players: new Map([['p0', { connected: true }]]), watchers: new Map(),
    sched: {
      now: clock,
      setInterval: (fn, ms) => realTimers ? setInterval(fn, ms) : { fn },
      clearInterval: (h) => { if (realTimers) clearInterval(h); },
    },
    guard: (fn) => fn(), markPublic() {}, watchersOf: () => ['p0'],
    sendEncoded: (pid, type, wire) => frames.push([pid, type, wire]),
    sendTo: (pid, msg) => frames.push([pid, msg.t, JSON.stringify(msg)]),
    reportError: (label, e) => failures.push([label, e.message]), tickerText() {},
    finish() { this.ended = true; },
  };
  const fields = longPhase().specs.map((spec) => ({
    fieldId: spec.fieldId, kind: spec.kind, spec, live: true,
    players: spec.players.map((p) => p.playerId), battle: new RemoteBattle(spec),
  }));
  const runner = new WorkerFieldRunner(m, fields, { onDone: () => completions++ });
  m.runner = runner;
  const request = runner._request.bind(runner);
  runner._request = (op, payload) => {
    commands.push([op, payload]);
    if (op === 'advance') assert.ok(payload.ticks > 0 && payload.ticks <= MAX_WORKER_ADVANCE_TICKS, 'bounded FIFO turn');
    request(op, payload);
  };
  const receive = runner._receive.bind(runner);
  runner._receive = (out, initial = false) => {
    receive(out, initial);
    if (initial) readyAt = runner.last - (runner.acc / m.gameSpeed) * 1000;
  };
  runner.start();
  return { m, runner, frames, failures, commands, fields, get readyAt() { return readyAt; }, get completions() { return completions; } };
}
class DelayedPool {
  constructor(clock, latency) { this.clock = clock; this.latency = latency; this.queue = []; this.maxInflight = 0; }
  create(input) {
    this.engine = new CombatEngine(input, { data: DATA, log: QUIET });
    const request = (op, payload = {}) => {
      const dto = op === 'init' ? this.engine.state({ snapshotFields: input.specs.map((s) => s.fieldId) })
        : op === 'advance' ? this.engine.advance(payload.ticks, payload)
          : op === 'state' ? this.engine.state(payload)
            : op === 'forceAll' ? this.engine.forceAll(payload.reason)
              : this.engine.forceField(payload.fieldId, payload.reason);
      return new Promise((resolve) => {
        this.queue.push({ at: this.clock() + (op === 'init' ? 0 : this.latency), dto, resolve });
        this.maxInflight = Math.max(this.maxInflight, this.queue.length);
      });
    };
    return { ready: request('init'), request, close: () => this.engine.dispose() };
  }
  async deliver() {
    const reply = this.queue.shift();
    assert.ok(reply);
    reply.resolve(reply.dto);
    await flush();
  }
}
function assertMonotonic(frames) {
  const latest = new Map();
  for (const [, type, wire] of frames) {
    if (type !== 'b.snap' && type !== 'b.ev') continue;
    const f = JSON.parse(wire);
    const key = `${type}:${f.fieldId}`;
    assert.ok(f.gt >= (latest.get(key) ?? 0), 'original event/snapshot game timestamps never move backwards');
    latest.set(key, f.gt);
  }
}

for (const latency of [50, 100, 150, 300]) {
  test(`workers: ${latency}ms command latency retains all 20s of active game time`, async (t) => {
    let now = 1000;
    const pool = new DelayedPool(() => now, latency);
    const h = remote(pool, () => now);
    t.after(() => h.runner.stop());
    await pool.deliver();
    const start = now, end = start + 20_000;
    let interval = 1;
    while (true) {
      const pumpAt = start + interval * INTERVAL_MS;
      const replyAt = pool.queue[0]?.at ?? Infinity;
      const at = Math.min(pumpAt, replyAt);
      if (at > end + 1e-7) break;
      now = at;
      if (pumpAt <= replyAt + 1e-7) { h.runner._pump(); interval++; }
      if (pool.queue[0]?.at <= now + 1e-7) await pool.deliver();
    }
    now = end;
    h.runner._pump();
    const expected = 1200; // 30 ticks/game-second * 2 game-seconds/wall-second * 20 wall-seconds.
    assert.ok(h.runner.ticks >= expected - latency / 1000 * 120 - 2, 'only bounded delivery lag, not cumulative slow motion');
    // Freeze active time and deliver the already owed work. Missing time cannot be hidden as an in-flight tail.
    while (pool.queue.length) await pool.deliver();
    assert.equal(h.runner.ticks, expected);
    assert.ok(h.runner.acc < TICK);
    assert.equal(pool.maxInflight, 1);
    assert.equal(h.completions, 0, 'measurement never invents a victory');
    assert.equal(h.runner.done, false);
    assert.deepEqual(h.failures, []);
    assertMonotonic(h.frames);
  });
}

for (const speed of [2, 120, 200]) {
  test(`workers: ${speed}x tool/normal speed retains numeric tick budget across bounded turns`, async (t) => {
    let now = 1000;
    const pool = new DelayedPool(() => now, 0);
    const h = remote(pool, () => now);
    t.after(() => h.runner.stop());
    await pool.deliver();
    h.m.gameSpeed = speed;
    now += 100;
    h.runner._pump();
    while (pool.queue.length) await pool.deliver();
    assert.equal(h.runner.ticks, speed * 3);
    assert.equal(h.runner.time, speed / 10);
    assert.ok(h.runner.acc < TICK);
    assert.equal(pool.maxInflight, 1);
    assert.equal(h.runner.done, false);
    assert.deepEqual(h.failures, []);
  });
}

test('workers: a 3s parent stall leaves bounded measurable debt and recovers all owed ticks in fair turns', async (t) => {
  let now = 1000;
  const pool = new DelayedPool(() => now, 300);
  const h = remote(pool, () => now);
  t.after(() => h.runner.stop());
  await pool.deliver();
  now += INTERVAL_MS;
  h.runner._pump(); // two ticks already in flight when the parent stops handling timers/messages
  now += 3000;
  h.runner._pump();
  assert.equal(pool.queue.length, 1);
  assert.ok(Math.abs(h.runner.acc - 6) < 1e-9);
  const peakDebtSeconds = h.runner.acc; // Existing scalar is the diagnostic; no new public telemetry/API.
  assert.ok(Math.abs(peakDebtSeconds - 6) < 1e-9, 'observed lag excludes the already dispatched turn');
  while (pool.queue.length) await pool.deliver();
  assert.equal(h.runner.ticks, 182);
  assert.ok(h.runner.acc < TICK, 'remaining lag after recovery is below one simulation tick');
  assert.equal(pool.maxInflight, 1);
  assert.ok(h.commands.filter(([op]) => op === 'advance').every(([, p]) => p.ticks <= MAX_WORKER_ADVANCE_TICKS));
  assert.equal(h.runner.done, false);
  assert.deepEqual(h.failures, []);
});

test('workers: long debt is scalar/hard-cap bounded; force controls precede further catch-up and finish once', async (t) => {
  let now = 1000;
  const pool = new DelayedPool(() => now, 300);
  const h = remote(pool, () => now);
  t.after(() => h.runner.stop());
  await pool.deliver();
  now += 3_600_000;
  h.runner._pump();
  assert.equal(pool.queue.length, 1);
  assert.equal(h.commands.at(-1)[1].ticks, MAX_WORKER_ADVANCE_TICKS);
  assert.equal(h.runner.acc + MAX_WORKER_ADVANCE_TICKS * TICK, HARD_CAP_SECONDS, 'one-hour elapsed debt saturates only at natural phase hard cap');
  h.runner.forceAll('forced');
  await pool.deliver();
  assert.equal(h.commands.at(-1)[0], 'forceAll');
  assert.equal(pool.queue.length, 1);
  await pool.deliver();
  assert.equal(h.completions, 1);
  assert.equal(h.runner.done, true);
  assert.equal(pool.queue.length, 0);
  for (const f of h.fields) {
    assert.equal(f.battle.result().reason, 'forced');
    assert.equal(f.battle.result().synthetic, undefined);
    assert.ok(f.battle.result().perPlayer);
  }
  h.runner.forceAll();
  h.runner._pump();
  assert.equal(h.completions, 1);
  assert.deepEqual(h.failures, []);
});

test('workers: coalesced in-flight resync sends only newest matching metadata/snapshot, not stale spawn events', async (t) => {
  let now = 1000;
  const pool = new DelayedPool(() => now, 300);
  const h = remote(pool, () => now);
  t.after(() => h.runner.stop());
  await pool.deliver();
  now += 500;
  h.runner._pump();
  const latest = pool.queue[0].dto.frames.findLast((f) => f.fieldId === 'n:p0' && f.snapshotWire);
  assert.ok(pool.queue[0].dto.frames.some((f) => f.eventsWire && !f.snapshotWire));
  h.m.watchers.set('p0', 'n:p0');
  h.runner.requestField('p0', 'n:p0');
  const before = h.frames.length;
  await pool.deliver();
  const received = h.frames.slice(before).filter(([, , wire]) => JSON.parse(wire).fieldId === 'n:p0');
  assert.deepEqual(received.filter(([, type]) => type !== 'b.damage'),
    [['p0', 'm.field', latest.metaWire], ['p0', 'b.snap', latest.snapshotWire]]);
  assert.equal(h.runner.resync.size, 0);
  assert.equal(h.fields[0].battle.snapshot().t, JSON.parse(latest.snapshotWire).gt);
  assert.equal(h.commands.at(-1)[0], 'state', 'a coalesced advance cannot satisfy fresh damage resync with an old 1Hz sample');
  await pool.deliver();
  const score = JSON.parse(h.frames.filter(([, type, wire]) => type === 'b.damage' && JSON.parse(wire).fieldId === 'n:p0').at(-1)[2]);
  assert.equal(score.gt, h.fields[0].battle.time);
  assert.equal(score.owners[0].total, pool.engine.fields[0].battle.damageRows().owners[0].total);
  assert.deepEqual(h.failures, []);
});

test('workers: a coalesced in-flight reply remains held through pause and is applied once on reset/resume', async (t) => {
  let now = 1000;
  const pool = new DelayedPool(() => now, 300);
  const h = remote(pool, () => now);
  t.after(() => h.runner.stop());
  await pool.deliver();
  now += 500;
  h.runner._pump();
  const before = h.frames.length;
  h.m.paused = true;
  now += 60_000;
  h.runner._pump();
  await pool.deliver();
  assert.ok(h.runner.held);
  assert.equal(h.runner.ticks, 0);
  assert.equal(h.frames.length, before);
  assert.equal(pool.queue.length, 0);
  h.m.paused = false;
  h.runner.resume();
  assert.equal(h.runner.ticks, 30);
  assert.equal(h.runner.held, null);
  assert.equal(h.runner.acc, 0);
  assert.equal(pool.queue.length, 0);
  const received = h.frames.length;
  h.runner.resume();
  assert.equal(h.frames.length, received, 'held ordered events and snapshots are never replayed twice');
  assert.deepEqual(h.failures, []);
});

for (const kind of ['normal', 'unite', 'boss', 'hidden']) {
  test(`catch-up ${kind}: latest snapshot/meta only, every original event/spawn and complete numeric result retained`, () => {
    const input = phase(kind);
    const full = new CombatEngine({ ...input, wireFrames: true }, { data: DATA, log: QUIET });
    const compact = new CombatEngine({ ...input, wireFrames: true, coalesceFrames: true }, { data: DATA, log: QUIET });
    try {
      const snapshotFields = input.specs.map((s) => s.fieldId);
      assert.deepEqual(compact.state({ snapshotFields }), full.state({ snapshotFields }), 'initial metadata remains complete');
      assert.deepEqual(compact.advance(2, { snapshotFields }), full.advance(2, { snapshotFields }), 'ordinary cadence unchanged');
      let out, sawSpawn = false, removedSnapshots = false;
      do {
        const reference = full.advance(32, { snapshotFields });
        out = compact.advance(32, { snapshotFields });
        const noFrames = ({ frames, ...rest }) => { void frames; return rest; };
        assert.deepEqual(noFrames(out), noFrames(reference), 'all fields/effects/HP/LP/overtime/errors/full results unchanged');
        assert.deepEqual(out.frames.filter((f) => f.eventsWire).map((f) => f.eventsWire), reference.frames.filter((f) => f.eventsWire).map((f) => f.eventsWire), 'ordered event wires and original gt unchanged');
        const latest = new Map(reference.frames.map((f) => [f.fieldId, f]));
        const snapshots = out.frames.filter((f) => f.snapshotWire);
        assert.equal(snapshots.length, latest.size, 'at most one latest snapshot/meta pair per emitted field');
        for (const f of snapshots) {
          assert.equal(f.snapshotWire, latest.get(f.fieldId).snapshotWire);
          assert.equal(f.metaWire, latest.get(f.fieldId).metaWire);
          assert.equal(f.eventsWire, null, 'last events were already retained once in the ordered stream');
        }
        removedSnapshots ||= reference.frames.length > snapshots.length;
        for (const f of out.frames.filter((f) => f.eventsWire)) for (const ev of JSON.parse(f.eventsWire).ev) {
          if (ev[0] === 'spawn') { sawSpawn = true; assert.ok(ev[1]?.id && ev[1]?.defId, 'spawn UnitInfo never depends on a removed snapshot'); }
        }
      } while (!out.done);
      assert.ok(removedSnapshots);
      assert.ok(sawSpawn);
      assert.deepEqual(compact.state({ snapshotFields }), full.state({ snapshotFields }), 'terminal reconnect metadata/current snapshot unchanged');
      for (const f of out.fields) { assert.equal(f.result.synthetic, undefined); assert.ok(Object.values(f.result.perPlayer).every((p) => Array.isArray(p.unitStats))); }
    } finally { full.dispose(); compact.dispose(); }
  });
}

test('workers: real single-worker FIFO gives all 24 phases a bounded first turn before their second catch-up turn', { timeout: 20_000 }, async (t) => {
  const pool = new CombatWorkerPool({ size: 1, data: DATA, log: QUIET });
  t.after(() => pool.close());
  await pool.start();
  let now = 1000;
  const hs = Array.from({ length: 24 }, () => remote(pool, () => now));
  t.after(() => hs.forEach((h) => h.runner.stop()));
  await until(() => hs.every((h) => h.runner.ready), 'all phases initialized');
  const turns = [];
  const reply = pool._reply.bind(pool);
  pool._reply = (slot, message) => {
    if (slot.active?.op === 'advance') turns.push(message.dto.ticks);
    reply(slot, message);
  };
  now += 1000;
  hs.forEach((h) => h.runner._pump());
  await until(() => hs.every((h) => h.runner.ticks === 60) && pool.stats().pending === 0, 'all active debt actually simulated');
  assert.deepEqual(turns.slice(0, 24), Array(24).fill(32));
  assert.deepEqual(turns.slice(24), Array(24).fill(60));
  for (const h of hs) { assert.deepEqual(h.failures, []); assert.ok(h.runner.acc < TICK); assertMonotonic(h.frames); }
});

for (const busyMs of [150, 300]) {
  test(`workers: real six-worker/12-phase pool catches up after repeated ${busyMs}ms busy-parent stalls`, { timeout: 20_000 }, async (t) => {
    const pool = new CombatWorkerPool({ size: 6, data: DATA, log: QUIET });
    t.after(() => pool.close());
    await pool.start();
    let frozen = null;
    const clock = () => frozen ?? performance.now();
    const hs = Array.from({ length: 12 }, () => remote(pool, clock, true));
    t.after(() => hs.forEach((h) => h.runner.stop()));
    await until(() => hs.every((h) => h.runner.ready), 'real workers initialized');
    const busy = setInterval(() => { const start = performance.now(); while (performance.now() - start < busyMs) {} }, busyMs + 33);
    t.after(() => clearInterval(busy));
    await delay(1400);
    clearInterval(busy);
    frozen = performance.now();
    const targets = hs.map((h) => Math.floor((frozen - h.readyAt) / 1000 * 2 / TICK + 1e-9));
    for (const h of hs) {
      clearInterval(h.runner.interval);
      h.runner.interval = null;
      h.runner._pump();
    }
    await until(() => hs.every((h, i) => h.runner.ticks === targets[i]) && pool.stats().pending === 0, 'no active time lost after parent resumes');
    for (const h of hs) { assert.deepEqual(h.failures, []); assert.ok(h.runner.acc < TICK); assertMonotonic(h.frames); }
    assert.equal(pool.stats().queued, 0);
    assert.equal(pool.stats().replacements, 0);
  });
}
