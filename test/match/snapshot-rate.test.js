import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CombatEngine } from '../../server/match/combat/engine.js';
import { CombatWorkerPool } from '../../server/match/combat/pool.js';
import { FieldRunner, parseSnapshotHz, emptyPerPlayer } from '../../server/match/fields.js';
import { WorkerFieldRunner, RemoteBattle } from '../../server/match/combat/runner.js';
import { startServer } from '../../server/index.js';
import { TICK } from '../../server/sim/constants.js';
import { Match } from '../../server/match/Match.js';
import { TestClient } from '../helpers/wsClient.js';
import { DATA, QUIET, phase } from './combat-fixtures.js';

class ProbeBattle {
  constructor(opts) {
    this.fieldId = opts.fieldId;
    this.time = 0;
    this.tickCount = 0;
    this.finished = false;
    this.errors = [];
    this.events = [];
    this.snapshots = 0;
    this.metas = 0;
  }
  step() {
    if (this.finished) return;
    this.time = ++this.tickCount * TICK;
    this.events.push(['probe', this.tickCount]);
  }
  snapshot() { this.snapshots++; return { t: Math.round(this.time * 1000) / 1000, units: [], killed: 0, total: 0 }; }
  fieldMeta() { this.metas++; return { fieldId: this.fieldId, units: [], tick: this.tickCount }; }
  drainEvents() { const events = this.events; this.events = []; return events; }
  forceEnd(reason) { this.finished = true; this.reason = reason; }
  result() { return { reason: this.reason, perPlayer: { p0: emptyPerPlayer() } }; }
}
const probe = { specs: [{ fieldId: 'f0', kind: 'normal', players: [{ playerId: 'p0' }], spawns: [] }] };
const eventsOf = (dto) => dto.frames.filter((f) => f.eventsWire).map((f) => f.eventsWire);
const snapshotsOf = (dto) => dto.frames.filter((f) => f.snapshotWire);

test('snapshot rate defaults to20; only explicit20/10/5 are accepted without reflecting invalid input', async () => {
  for (const value of [undefined, null, '', 20, '20']) assert.equal(parseSnapshotHz(value), 20);
  for (const value of [10, '10', 5, '5']) assert.equal(parseSnapshotHz(value), Number(value));
  for (const value of [true, false, {}, [], 0, 15, NaN, Infinity, '1e1', '0xA', ' 10', 'synthetic-invalid-marker']) {
    assert.throws(() => parseSnapshotHz(value), (e) => e instanceof RangeError && e.message === 'SP_SNAPSHOT_HZ must be 20, 10 or 5');
  }
  await assert.rejects(startServer({ host: '127.0.0.1', port: 0, snapshotHz: 15, combatWorkers: 0, trialWorkers: 0, quiet: true }), /SP_SNAPSHOT_HZ/);
});

test('startup option overrides an invalid environment; valid env reaches normalized lobby config', async () => {
  const previous = process.env.SP_SNAPSHOT_HZ;
  try {
    process.env.SP_SNAPSHOT_HZ = 'invalid';
    const explicit = await startServer({ host: '127.0.0.1', port: 0, snapshotHz: 10, combatWorkers: 0, trialWorkers: 0, quiet: true });
    try { assert.equal(explicit.lobby.opts.snapshotHz, 10); } finally { await explicit.close(); }
    await assert.rejects(startServer({ host: '127.0.0.1', port: 0, combatWorkers: 0, trialWorkers: 0, quiet: true }), /SP_SNAPSHOT_HZ/);
    process.env.SP_SNAPSHOT_HZ = '10';
    const fromEnv = await startServer({ host: '127.0.0.1', port: 0, combatWorkers: 0, trialWorkers: 0, quiet: true });
    try { assert.equal(fromEnv.lobby.opts.snapshotHz, 10); } finally { await fromEnv.close(); }
  } finally {
    if (previous == null) delete process.env.SP_SNAPSHOT_HZ;
    else process.env.SP_SNAPSHOT_HZ = previous;
  }
});

for (const hz of [20, 10, 5]) {
  test(`${hz}Hz: skip snapshot/meta construction, preserve every original event batch and gt`, () => {
    const e = new CombatEngine({ ...probe, snapshotHz: hz, wireFrames: true }, { BattleClass: ProbeBattle });
    try {
      assert.equal(snapshotsOf(e.state({ snapshotFields: ['f0'] })).length, 1, 'initial state bypasses cadence');
      const before = e.fields[0].battle.snapshots;
      const frames = [];
      for (let i = 0; i < 60; i++) frames.push(...e.advance(1, { snapshotFields: ['f0'] }).frames);
      assert.equal(e.runner.ticks, 60);
      assert.equal(frames.filter((f) => f.snapshotWire).length, hz);
      assert.equal(e.fields[0].battle.snapshots - before, hz, 'not built then discarded');
      assert.equal(e.fields[0].battle.metas - before, hz, 'UnitInfo encoding is also skipped');
      const batches = frames.filter((f) => f.eventsWire).map((f) => JSON.parse(f.eventsWire));
      assert.equal(batches.length, 20, 'event cadence remains20Hz');
      assert.deepEqual(batches.map((f) => f.gt), Array.from({ length: 20 }, (_, i) => (i + 1) / 10));
      assert.deepEqual(batches.flatMap((f) => f.ev).map((ev) => ev[1]), Array.from({ length: 60 }, (_, i) => i + 1));
      assert.equal(e.fields[0].battle.tickCount, 60);
    } finally { e.dispose(); }
  });
}

test('state/catch-up/force do not retime events or overwrite consistent metadata with event-only frames', () => {
  const e = new CombatEngine({ ...probe, snapshotHz: 10, wireFrames: true, coalesceFrames: true }, { BattleClass: ProbeBattle });
  try {
    const first = e.advance(3, { snapshotFields: ['f0'] });
    assert.equal(snapshotsOf(first).length, 1);
    assert.equal(snapshotsOf(e.advance(2, { snapshotFields: ['f0'] })).length, 0);
    const state = e.state({ snapshotFields: ['f0'] });
    assert.equal(state.frames[0].eventsWire, null);
    assert.equal(JSON.parse(state.frames[0].metaWire).tick, 5);
    const skipped = e.advance(1, { snapshotFields: ['f0'] });
    assert.equal(snapshotsOf(skipped).length, 0, 'resync did not consume/change periodic cadence');
    assert.equal(eventsOf(skipped).length, 1);
    const batch = e.advance(9, { snapshotFields: ['f0'] });
    assert.deepEqual(eventsOf(batch).map((wire) => JSON.parse(wire).gt), [0.3, 0.4, 0.5]);
    assert.equal(snapshotsOf(batch).length, 1);
    assert.equal(JSON.parse(snapshotsOf(batch)[0].metaWire).tick, 15);
    // End before the next ordinary emit. The terminal snapshot must still be fresh.
    e.advance(1, { snapshotFields: ['f0'] });
    const done = e.forceAll('forced');
    assert.equal(done.done, true);
    assert.equal(JSON.parse(snapshotsOf(done).at(-1).metaWire).live, false);
    assert.equal(JSON.parse(snapshotsOf(done).at(-1).metaWire).tick, 16);
    assert.deepEqual(eventsOf(done).flatMap((wire) => JSON.parse(wire).ev), [['probe', 16]]);
  } finally { e.dispose(); }
});

test('catch-up ending with an event-only frame retains the last full snapshot/meta pair', () => {
  const e = new CombatEngine({ ...probe, snapshotHz: 10, wireFrames: true, coalesceFrames: true }, { BattleClass: ProbeBattle });
  try {
    const out = e.advance(12, { snapshotFields: ['f0'] });
    assert.equal(snapshotsOf(out).length, 1);
    assert.equal(JSON.parse(snapshotsOf(out)[0].metaWire).tick, 9);
    assert.deepEqual(eventsOf(out).map((wire) => JSON.parse(wire).gt), [0.1, 0.2, 0.3, 0.4]);
  } finally { e.dispose(); }
});

for (const kind of ['normal', 'unite', 'boss', 'hidden']) {
  test(`${kind}:20/10/5Hz have identical complete results, ordered effects/events and damage rows`, () => {
    const input = phase(kind), ids = input.specs.map((s) => s.fieldId);
    let now = 0;
    const engines = [20, 10, 5].map((snapshotHz) => new CombatEngine({ ...input, snapshotHz, wireFrames: true, damageBoard: true }, { data: DATA, log: QUIET, now: () => now }));
    const traces = engines.map(() => ({ events: [], effects: [], snapshots: 0, damage: [] }));
    let outputs;
    try {
      do {
        now += 1000 / 30;
        outputs = engines.map((e) => e.advance(2, { snapshotFields: ids }));
        outputs.forEach((out, i) => {
          traces[i].events.push(...eventsOf(out));
          traces[i].effects.push(...out.effects);
          traces[i].snapshots += snapshotsOf(out).length;
          traces[i].damage.push(...out.damageFrames);
        });
        assert.ok(outputs.every((out) => out.ticks === outputs[0].ticks && out.done === outputs[0].done));
      } while (!outputs[0].done);
      for (const i of [1, 2]) {
        assert.deepEqual(outputs[i].fields, outputs[0].fields);
        assert.deepEqual(outputs[i].boss, outputs[0].boss);
        assert.deepEqual(traces[i].effects, traces[0].effects);
        assert.deepEqual(traces[i].events, traces[0].events);
        assert.deepEqual(traces[i].damage, traces[0].damage);
        assert.ok(traces[i].snapshots < traces[i - 1].snapshots);
      }
      assert.ok(traces[0].events.length > 0);
      assert.ok(outputs[0].fields.every((f) => f.result && !f.result.synthetic));
    } finally { engines.forEach((e) => e.dispose()); }
  });
}

for (const hz of [10, 5]) {
  test(`inline${hz}Hz has the same event boundaries and immediate terminal snapshot`, () => {
    const battle = new ProbeBattle({ fieldId: 'f0' }), sent = [];
    const field = { fieldId: 'f0', kind: 'normal', players: ['p0'], battle };
    const r = new FieldRunner({ snapshotHz: hz, gameSpeed: 2, watchersOf: () => ['p0'], sendTo: (_, msg) => sent.push(msg),
      markPublic() {}, reportError(label, e) { throw e; } }, [field], { onDone() {} });
    for (let i = 0; i < 60; i++) r._tick();
    assert.equal(sent.filter((m) => m.t === 'b.snap').length, hz);
    assert.equal(sent.filter((m) => m.t === 'b.ev').length, 20);
    battle.finished = true;
    r._tick();
    assert.equal(sent.at(-1).t, 'b.snap');
    assert.equal(sent.at(-1).gt, 2);
  });
}

test('lower-rate periodic snapshots respect nondefault speed without changing legacy20 pacing', () => {
  for (const [hz, speed, every] of [[10, 1, 3], [10, 4, 12], [5, 4, 24], [20, 200, 3]]) {
    const r = new FieldRunner({ snapshotHz: hz, gameSpeed: speed }, [], { onDone() {} });
    assert.equal(r.snapshotEvery, every);
  }
});

test('real worker10Hz: startup/resync/force wires are full; periodic event-only frames survive IPC', async (t) => {
  const pool = new CombatWorkerPool({ size: 1, data: DATA, log: QUIET });
  t.after(() => pool.close());
  await pool.start();
  const input = phase('normal'), snapshotFields = input.specs.map((s) => s.fieldId);
  const session = pool.create({ ...input, snapshotHz: 10, wireFrames: true, coalesceFrames: true });
  t.after(() => session.close());
  assert.equal(snapshotsOf(await session.ready).length, input.specs.length);
  await session.request('advance', { ticks: 3, snapshotFields });
  const out = await session.request('advance', { ticks: 3, snapshotFields });
  assert.equal(snapshotsOf(out).length, 0);
  assert.ok(out.frames.every((f) => f.eventsWire && !f.metaWire));
  const state = await session.request('state', { snapshotFields });
  assert.equal(snapshotsOf(state).length, input.specs.length);
  assert.ok(state.frames.every((f) => f.eventsWire === null));
  const final = await session.request('forceAll', {});
  assert.equal(final.done, true);
  assert.ok(final.fields.every((f) => f.result));
  assert.ok(snapshotsOf(final).every((f) => !JSON.parse(f.metaWire).live));
});

for (const wsCompression of ['off', 'on']) {
  test(`native WS10Hz: real Match forwarding, events, fresh metadata and reconnect work with compression ${wsCompression}`, { timeout: 15000 }, async (t) => {
    class StreamingMatch extends Match {
      constructor(opts) { super({ ...opts, clientCombat: false, verify: 'off', timerScale: 0.02, combatSpeed: 2, botRehearsal: 0 }); }
    }
    const server = await startServer({ host: '127.0.0.1', port: 0, quiet: true, combatWorkers: 1, trialWorkers: 0,
      snapshotHz: 10, wsCompression, MatchClass: StreamingMatch, seedFn: () => 731 });
    const clients = [];
    t.after(async () => { await Promise.all(clients.map((c) => c.terminate())); await server.close(); });
    const connect = async (token) => {
      const c = await TestClient.connect(`ws://127.0.0.1:${server.port}/ws`);
      clients.push(c);
      assert.equal(c.ws.extensions, wsCompression === 'on' ? 'permessage-deflate' : '');
      const welcome = await c.hello('Snapshot10', token);
      c.identity = welcome.playerId;
      c.credential = welcome.token; // Memory only; never asserted/printed as a raw credential.
      return c;
    };
    const ok = async (c, msg) => assert.equal((await c.request(msg)).t, 'ok', msg.t);
    const c = await connect();
    await ok(c, { t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    const room = await c.waitFor('room.state');
    await ok(c, { t: 'room.start' });
    await ok(c, { t: 'g.infoReady' });
    await c.waitFor('m.public', (m) => m.phase === 'BAND_DRAFT');
    await ok(c, { t: 'g.band', bandId: 'band_bldsk' });
    await c.waitFor('m.public', (m) => m.phase === 'PREP');
    const match = server.lobby.getRoom(room.code).match;
    assert.equal(match.snapshotHz, 10);
    match.wave = { ...match.wave, timeLimit: 90, spawns: [{ ...match.wave.spawns[0], time: 0.15, count: 2, interval: 1 }] };
    await ok(c, { t: 'g.ready', ready: true });
    const meta = await c.waitFor('m.field', (m) => !m.prep);
    assert.ok(match.runner instanceof WorkerFieldRunner);
    const times = [];
    for (let i = 0; i < 7; i++) times.push((await c.waitFor('b.snap', (m) => m.gt > 0)).gt);
    assert.ok(times.slice(1).every((gt, i) => Math.abs(gt - times[i] - 0.2) < 0.002));
    assert.ok(c.log.some((m) => m.t === 'b.ev'), 'actual event stream is still delivered');
    await c.terminate();
    const resumed = await connect(c.credential);
    assert.ok(resumed.identity === c.identity);
    const freshMeta = await resumed.waitFor('m.field', (m) => !m.prep);
    const freshSnap = await resumed.waitFor('b.snap');
    assert.equal(freshMeta.fieldId, meta.fieldId);
    assert.ok(freshSnap.gt >= times.at(-1));
    assert.equal(resumed.log.filter((m) => m.t === 'm.field' || m.t === 'b.snap')[0].t, 'm.field');
    assert.ok(freshMeta.units.length > meta.units.length, 'resync includes newly spawned UnitInfo, not stale sampled metadata');
  });
}

test('Main resync never consumes an event-only frame as the latest consistent view', () => {
  const spec = phase().specs[0];
  const field = { fieldId: spec.fieldId, spec, kind: 'normal', players: ['p0'], battle: new RemoteBattle(spec), live: true };
  const sent = [], people = new Map([['p0', { connected: true }], ['p1', { connected: true }]]);
  const m = { fields: [field], players: people, spectators: new Map(), watchers: new Map([['p0', field.fieldId], ['p1', field.fieldId]]),
    watchersOf: () => ['p0', 'p1'], sendEncoded: (pid, type, data) => sent.push([pid, type, data]),
    sendTo: (pid, msg) => sent.push([pid, msg.t, JSON.stringify(msg)]), markPublic() {} };
  const r = new WorkerFieldRunner(m, [field], { onDone() {} });
  r.resync.set('p0', field.fieldId);
  const snap = JSON.stringify({ t: 'b.snap', fieldId: field.fieldId, gt: 0.1, units: [] });
  const meta = JSON.stringify({ t: 'm.field', fieldId: field.fieldId, units: [] });
  const eventsWire = JSON.stringify({ t: 'b.ev', fieldId: field.fieldId, gt: 0.2, ev: [['probe', 6]] });
  r._apply({ ticks: 6, done: false, effects: [], fields: [{ fieldId: field.fieldId, live: true, time: 0.2, tickCount: 6 }],
    frames: [{ fieldId: field.fieldId, snapshotWire: snap, metaWire: meta, eventsWire: null }, { fieldId: field.fieldId, eventsWire }] });
  assert.deepEqual(sent.filter(([pid]) => pid === 'p0').map(([, type]) => type), ['m.field', 'b.snap', 'b.damage', 'b.ev']);
  assert.equal(r.resync.size, 0);
  assert.equal(field.battle._snapshotWire, snap);
  assert.ok(sent.some(([pid, type, data]) => pid === 'p1' && type === 'b.ev' && data === eventsWire));
});
