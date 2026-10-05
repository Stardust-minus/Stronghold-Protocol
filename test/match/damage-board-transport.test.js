import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CombatEngine, DAMAGE_INTERVAL_MS } from '../../server/match/combat/engine.js';
import { RemoteBattle, WorkerFieldRunner } from '../../server/match/combat/runner.js';
import { CombatWorkerPool } from '../../server/match/combat/pool.js';
import { DATA, QUIET, phase } from './combat-fixtures.js';

function longPhase() {
  const input = phase();
  for (const spec of input.specs) spec.timeLimit = 60;
  return input;
}
function adapter(input, onDamageRows = null) {
  const sent = [], captured = [];
  const fields = input.specs.map((spec) => ({ fieldId: spec.fieldId, kind: spec.kind, players: spec.players.map((p) => p.playerId),
    live: true, spec, battle: new RemoteBattle(spec) }));
  const m = {
    disposed: false, ended: false, paused: false, gameSpeed: 2,
    sched: { now: () => 0, clearInterval() {} },
    players: new Map([['watcher', { connected: true }]]), spectators: new Map(), watchers: new Map([['watcher', fields[0].fieldId]]),
    watchersOf(id) { return [...this.watchers].filter(([, fid]) => fid === id).map(([pid]) => pid); },
    sendEncoded(pid, type, wire) { sent.push([pid, type, wire]); },
    sendTo(pid, packet) { sent.push([pid, packet.t, JSON.stringify(packet)]); },
    markPublic() {}, guard(fn) { fn(); }, reportError(label, e) { throw new Error(`${label}: ${e}`); },
    ...(onDamageRows ? { _onDamageRows(f, rows) { captured.push([f.fieldId, structuredClone(rows)]); return onDamageRows(f, rows); } } : {}),
  };
  const runner = new WorkerFieldRunner(m, fields, { onDone() {} });
  m.runner = runner;
  return { m, runner, fields, sent, captured };
}

test('real worker damage is opt-in, independent of snapshots, ~1Hz real time and forced on state/final', () => {
  let now = 0;
  const input = longPhase();
  const engine = new CombatEngine({ ...input, wireFrames: true, damageBoard: true }, { data: DATA, log: QUIET, now: () => now });
  try {
    const initial = engine.state();
    assert.equal(initial.frames.length, 0, 'unwatched live snapshot is not generated');
    assert.equal(initial.damageFrames.length, 2, 'all owners, not only current field watchers');
    const saved = structuredClone(initial);
    for (const frame of initial.damageFrames) {
      assert.deepEqual(Object.keys(frame), ['fieldId', 'damageWire', 'gt']);
      const packet = JSON.parse(frame.damageWire);
      assert.equal(packet.t, 'b.damage');
      assert.equal(packet.round, input.specs[0].round);
      assert.equal(packet.owners[0].operators.length, 2);
    }
    now = DAMAGE_INTERVAL_MS / 2;
    assert.deepEqual(engine.advance(60).damageFrames, [], '2 game seconds do not cause a 2Hz score update');
    now = DAMAGE_INTERVAL_MS - 1;
    assert.deepEqual(engine.advance(30).damageFrames, []);
    now = DAMAGE_INTERVAL_MS;
    const update = engine.advance(1);
    assert.equal(update.damageFrames.length, 2);
    assert.ok(update.damageFrames.some((f) => JSON.parse(f.damageWire).owners[0].total > 0));
    assert.deepEqual(engine.advance(1).damageFrames, [], 'same real clock cannot emit a new sample');
    const state = engine.state({ snapshotFields: [input.specs[0].fieldId] });
    assert.equal(state.damageFrames.length, 2, 'watch/resync forces every owner current without advancing');
    assert.equal(state.ticks, update.ticks + 1);
    const ended = engine.forceAll();
    assert.equal(ended.damageFrames.length, 2);
    for (const view of ended.fields) {
      const packet = JSON.parse(ended.damageFrames.find((f) => f.fieldId === view.fieldId).damageWire);
      assert.deepEqual(view.damageRows, { owners: packet.owners });
      assert.equal(view.damageRows.owners[0].total, view.result.perPlayer[view.players[0]].damageDealt);
      assert.equal(Object.hasOwn(view.result, 'damageRows'), false);
    }
    assert.deepEqual(engine.advance(1).damageFrames, [], 'duplicate finals retain rows without rescanning/resending');
    assert.equal(engine.state().damageFrames.length, 2, 'terminal reconnect forces a complete score');
    assert.deepEqual(initial, saved, 'later work cannot mutate a returned wire DTO');
  } finally { engine.dispose(); }
});

test('score opt-out never calls damageRows and preserves full original results, including >160 unit stats', () => {
  const input = longPhase();
  input.specs.length = 1;
  const spec = input.specs[0];
  spec.players[0].units = Array.from({ length: 170 }, (_, i) => ({ ...spec.players[0].units[0], uid: i + 1 }));
  const plain = new CombatEngine(input, { data: DATA, log: QUIET });
  const scored = new CombatEngine({ ...input, damageBoard: true }, { data: DATA, log: QUIET });
  try {
    plain.fields[0].battle.damageRows = () => { throw new Error('must not compute trial/default score'); };
    assert.equal(Object.hasOwn(plain.state(), 'damageFrames'), false);
    const a = plain.forceAll(), b = scored.forceAll();
    assert.deepEqual(a.fields[0].result, b.fields[0].result);
    assert.equal(a.fields[0].result.perPlayer.p0.unitStats.length, 170);
    assert.equal(b.fields[0].damageRows.owners[0].operators.length, 170, 'no compactResult truncation');
  } finally { plain.dispose(); scored.dispose(); }
});

test('damage has its own RemoteBattle cache; snapshots cannot erase it; hook receives unseen field owners', () => {
  let now = 0;
  const input = longPhase();
  const engine = new CombatEngine({ ...input, wireFrames: true, coalesceFrames: true, damageBoard: true },
    { data: DATA, log: QUIET, now: () => now });
  const { runner, fields, sent, captured } = adapter(input, () => false);
  try {
    runner._apply(engine.state({ snapshotFields: input.specs.map((s) => s.fieldId) }));
    now = 1000;
    runner._apply(engine.advance(60, { snapshotFields: [fields[0].fieldId] }));
    assert.equal(captured.length, 4, 'all fields feed Match round ledger, including never-watched teammate');
    const saved = structuredClone(fields[0].battle.damageRows());
    const wire = fields[0].battle._damageWire;
    assert.ok(saved.owners[0].total > 0);
    runner._apply(engine.advance(3, { snapshotFields: [fields[0].fieldId] }));
    assert.equal(fields[0].battle._damageWire, wire);
    assert.deepEqual(fields[0].battle.damageRows(), saved);
    runner.resync.set('watcher', fields[0].fieldId);
    runner._apply(engine.state({ snapshotFields: [fields[0].fieldId] }));
    const replay = sent.filter(([, t]) => t === 'b.damage').at(-1);
    assert.ok(replay, 'cached reconnect includes the independent score');
    assert.deepEqual(JSON.parse(replay[2]).owners, fields[0].battle.damageRows().owners);
    assert.equal(runner.resync.size, 0);
    assert.deepEqual(fields[0].battle.result(), null, 'score transport does not manufacture a result');
  } finally { runner.stop(); engine.dispose(); }
});

test('pause preserves accepted score cache and held effects/result semantics; resume accepts final rows only once', () => {
  const input = longPhase();
  const engine = new CombatEngine({ ...input, wireFrames: true, damageBoard: true }, { data: DATA, log: QUIET });
  const { m, runner, fields, sent } = adapter(input);
  try {
    runner._apply(engine.state({ snapshotFields: [fields[0].fieldId] }));
    const accepted = structuredClone(fields[0].battle.damageRows());
    engine.advance(60);
    m.paused = true;
    const final = engine.forceAll();
    runner._receive(final);
    assert.equal(runner.held, final);
    assert.equal(runner.done, false);
    assert.deepEqual(fields[0].battle.damageRows(), accepted, 'a held pre-pause reply is not partly applied');
    runner.requestField('watcher', fields[0].fieldId);
    assert.deepEqual(JSON.parse(sent.filter(([, t]) => t === 'b.damage').at(-1)[2]).owners, accepted.owners);
    m.paused = false;
    runner.resume();
    assert.equal(runner.done, true);
    assert.ok(fields[0].battle.damageRows().owners[0].total > 0);
    const terminal = structuredClone(fields[0].battle.damageRows());
    runner.stop();
    runner._receive(final);
    assert.deepEqual(fields[0].battle.damageRows(), terminal, 'cancelled generations cannot apply stale results');
  } finally { runner.stop(); engine.dispose(); }
});

test('synthetic failed fields still carry zero owner/operator metadata and preserve synthetic settlement flag', () => {
  const input = longPhase();
  for (const spec of input.specs) spec.routes = {};
  const engine = new CombatEngine({ ...input, damageBoard: true, wireFrames: true }, { data: DATA, log: QUIET });
  try {
    const out = engine.state();
    assert.equal(out.done, true);
    for (const view of out.fields) {
      assert.equal(view.result.synthetic, true);
      assert.equal(view.damageRows.owners[0].total, 0);
      assert.equal(view.damageRows.owners[0].operators.length, 2);
      assert.ok(Array.isArray(view.result.perPlayer[view.players[0]].unitStats));
    }
  } finally { engine.dispose(); }
});

test('actual asynchronous worker returns preencoded public scores and unchanged complete internal results', async (t) => {
  const pool = new CombatWorkerPool({ size: 1, data: DATA, log: QUIET });
  t.after(() => pool.close());
  await pool.start();
  const input = phase('boss');
  const session = pool.create({ ...input, wireFrames: true, coalesceFrames: true, damageBoard: true });
  t.after(() => session.close());
  const initial = await session.ready;
  assert.equal(initial.damageFrames.length, input.specs.length);
  const reference = new CombatEngine(input, { data: DATA, log: QUIET });
  t.after(() => reference.dispose());
  let out;
  do {
    out = await session.request('advance', { ticks: 17 });
    reference.advance(17);
  } while (!out.done);
  assert.deepEqual(out.fields.map((f) => f.result), reference.state().fields.map((f) => f.result));
  const reconnect = await session.request('state', { snapshotFields: input.specs.map((s) => s.fieldId) });
  assert.equal(reconnect.damageFrames.length, input.specs.length);
  const damageTotal = reconnect.fields.reduce((n, f) => n + f.damageRows.owners.reduce((sum, owner) => sum + owner.total, 0), 0);
  assert.ok(damageTotal > 0);
  for (const f of reconnect.fields) {
    const wire = reconnect.damageFrames.find((frame) => frame.fieldId === f.fieldId).damageWire;
    assert.equal(typeof wire, 'string');
    assert.deepEqual(JSON.parse(wire).owners, f.damageRows.owners);
    assert.equal(f.result.synthetic, undefined);
  }
});
