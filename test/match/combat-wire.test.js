import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CombatEngine } from '../../server/match/combat/engine.js';
import { CombatWorkerPool } from '../../server/match/combat/pool.js';
import { snapFrame } from '../../server/match/fields.js';
import { DATA, QUIET, phase } from './combat-fixtures.js';

function plainReference(input) {
  const engine = new CombatEngine(input, { data: DATA, log: QUIET });
  // A frame's live flag belongs to its own tick boundary, not the end of the advance batch.
  const frame = engine._frame.bind(engine);
  engine._frame = (f, events) => {
    frame(f, events);
    engine.frames.at(-1).wireLive = !!f.live;
  };
  return engine;
}

function protocolFrames(dto) {
  return dto.frames.map((frame) => ({
    fieldId: frame.fieldId,
    snapshotWire: JSON.stringify(snapFrame(frame.fieldId, frame.snapshot)),
    eventsWire: frame.events.length ? JSON.stringify({ t: 'b.ev', fieldId: frame.fieldId, gt: frame.snapshot.t, ev: frame.events }) : null,
    metaWire: JSON.stringify({ t: 'm.field', ...frame.meta, fieldId: frame.fieldId,
      kind: dto.fields.find((f) => f.fieldId === frame.fieldId).kind, live: frame.wireLive }),
  }));
}

function assertEquivalent(wire, plain, { diagnostics = false } = {}) {
  assert.deepEqual(wire.frames, protocolFrames(plain), 'encoded frames match original protocol JSON byte for byte');
  const withoutFrames = ({ frames, ...dto }) => {
    void frames;
    if (diagnostics) dto.fields = dto.fields.map((f) => ({ ...f, errors: f.errors.map(({ stack, ...error }) => {
      assert.ok(stack, 'diagnostic stack is retained; caller locations differ between engines/threads');
      return error;
    }) }));
    return dto;
  };
  assert.deepEqual(withoutFrames(wire), withoutFrames(plain), 'full results, fields and ordered effects are unchanged');
  for (const frame of wire.frames) {
    assert.deepEqual(Object.keys(frame), ['fieldId', 'snapshotWire', 'eventsWire', 'metaWire']);
    assert.equal(JSON.parse(frame.snapshotWire).t, 'b.snap');
    assert.equal(JSON.parse(frame.metaWire).t, 'm.field');
    if (frame.eventsWire) assert.equal(JSON.parse(frame.eventsWire).gt, JSON.parse(frame.snapshotWire).gt);
  }
}

for (const kind of ['normal', 'unite', 'boss', 'hidden']) {
  test(`wire ${kind}: initial/state/cadence/final frames preserve exact protocol and full results`, () => {
    const input = phase(kind);
    const plain = plainReference(input);
    const wire = new CombatEngine({ ...input, wireFrames: true }, { data: DATA, log: QUIET });
    try {
      const snapshotFields = input.specs.map((s) => s.fieldId);
      const initial = wire.state({ snapshotFields });
      assertEquivalent(initial, plain.state({ snapshotFields }));
      assert.ok(initial.frames.every((f) => f.eventsWire === null));
      const savedInitial = structuredClone(initial);
      let out;
      do {
        const selected = plain.runner.ticks % 2 ? [] : snapshotFields;
        out = wire.advance(17, { snapshotFields: selected });
        assertEquivalent(out, plain.advance(17, { snapshotFields: selected }));
        const state = wire.state({ snapshotFields });
        assertEquivalent(state, plain.state({ snapshotFields }));
        assert.ok(state.frames.every((f) => f.eventsWire === null), 'resync never replays prior events');
        assert.deepEqual(state.effects, [], 'resync never replays prior effects');
      } while (!out.done);
      for (const f of out.fields) {
        const last = out.frames.filter((frame) => frame.fieldId === f.fieldId).at(-1);
        assert.ok(last, 'unwatched terminal fields have final wires');
        assert.equal(JSON.parse(last.metaWire).live, false);
        assert.equal(JSON.parse(last.snapshotWire).gt, Math.round(f.time * 1000) / 1000);
      }
      assert.deepEqual(initial, savedInitial, 'later simulation cannot mutate previously encoded frames');
    } finally { plain.dispose(); wire.dispose(); }
  });
}

test('wire forceField/forceAll return current terminal meta and full results, including unspawned', () => {
  const input = phase('unite');
  const plain = plainReference(input);
  const wire = new CombatEngine({ ...input, wireFrames: true }, { data: DATA, log: QUIET });
  try {
    assertEquivalent(wire.advance(3, { snapshotFields: ['u'] }), plain.advance(3, { snapshotFields: ['u'] }));
    const out = wire.forceField('u', 'timeout');
    assertEquivalent(out, plain.forceField('u', 'timeout'));
    assert.ok(out.fields[0].result.unspawned.length > 0);
    assert.ok(Object.values(out.fields[0].result.perPlayer).every((p) => Array.isArray(p.unitStats)));
    assert.equal(JSON.parse(out.frames.at(-1).metaWire).live, false);
    assertEquivalent(wire.forceAll(), plain.forceAll());
    assertEquivalent(wire.state(), plain.state());
  } finally { plain.dispose(); wire.dispose(); }
});

test('wire synthetic constructor failures retain diagnostics, full clean results and terminal reconnect frames', () => {
  const input = phase();
  for (const spec of input.specs) spec.routes = {}; // real Battle constructor fails, producing DeadBattle
  const plain = plainReference(input);
  const wire = new CombatEngine({ ...input, wireFrames: true }, { data: DATA, log: QUIET });
  try {
    const out = wire.state();
    assertEquivalent(out, plain.state(), { diagnostics: true });
    assert.equal(out.done, true);
    for (const f of out.fields) {
      assert.equal(f.result.synthetic, true);
      assert.ok(f.errors.length > 0);
      assert.ok(Object.values(f.result.perPlayer).every((p) => Array.isArray(p.unitStats)));
    }
    assertEquivalent(wire.advance(1), plain.advance(1), { diagnostics: true });
  } finally { plain.dispose(); wire.dispose(); }
});

test('wire opt-in passes unchanged through the real pool/worker and preserves other plain sessions', async (t) => {
  const pool = new CombatWorkerPool({ size: 2, data: DATA, log: QUIET });
  t.after(() => pool.close());
  await pool.start();
  const input = phase('boss');
  const plain = plainReference(input);
  t.after(() => plain.dispose());
  const wire = pool.create({ ...input, wireFrames: true });
  const legacy = pool.create(input);
  const snapshotFields = input.specs.map((s) => s.fieldId);
  assertEquivalent(await wire.ready, plain.state({ snapshotFields }));
  const legacyInitial = await legacy.ready;
  assert.ok(legacyInitial.frames.every((f) => f.snapshot && f.meta && !('snapshotWire' in f)));
  let out;
  do {
    out = await wire.request('advance', { ticks: 29, snapshotFields });
    assertEquivalent(out, plain.advance(29, { snapshotFields }));
    assertEquivalent(await wire.request('state', { snapshotFields }), plain.state({ snapshotFields }));
  } while (!out.done);
  assert.ok(out.fields.every((f) => f.result));
  wire.close();
  legacy.close();
});
