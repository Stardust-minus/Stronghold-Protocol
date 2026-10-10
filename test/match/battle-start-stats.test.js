import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CombatEngine } from '../../server/match/combat/engine.js';
import { DATA, phase } from './combat-fixtures.js';

for (const wireFrames of [false, true]) {
  test(`opening panels: one first-tick cache per field, even unwatched/coalesced (${wireFrames ? 'wire' : 'DTO'})`, () => {
    const input = phase('normal');
    const engine = new CombatEngine({ ...input, wireFrames, coalesceFrames: true, snapshotHz: 10 }, { data: DATA });
    try {
      let captures = 0;
      for (const f of engine.fields) {
        const capture = f.battle.captureStartUnitStats;
        f.battle.captureStartUnitStats = function () { captures++; return capture.call(this); };
      }
      const initial = engine.state();
      assert.equal(captures, 0, 'state/readiness cannot start the simulation');
      assert.equal(initial.frames.length, 0);
      const first = engine.advance(32);
      const opening = first.frames.filter(f => f.startMetaWire || f.startMeta);
      assert.equal(opening.length, input.specs.length, 'unwatched fields still cache the opening panel for later entry');
      assert.equal(captures, input.specs.length);
      for (const frame of opening) {
        const meta = wireFrames ? JSON.parse(frame.startMetaWire) : frame.startMeta;
        assert.ok(meta.unitStats.length > 0);
        assert.ok(meta.unitStats.every(u => meta.units.some(info => info.id === u.id)));
        if (wireFrames) assert.match(frame.startMetaWire, /^\{"t":"m\.field"/, 'reliable ingress compression classification');
      }
      const caches = engine.fields.map(f => f.battle._startUnitStats);
      const values = structuredClone(caches);
      for (let i = 0; i < 3; i++) {
        const out = engine.advance(12, { snapshotFields: input.specs.map(s => s.fieldId) });
        assert.ok(out.frames.every(f => !f.startMetaWire && !f.startMeta), 'no repeated opening metadata');
        for (const frame of out.frames) {
          if (frame.snapshotWire) assert.equal(Object.hasOwn(JSON.parse(frame.snapshotWire), 'unitStats'), false);
          if (frame.metaWire) assert.equal(Object.hasOwn(JSON.parse(frame.metaWire), 'unitStats'), false, 'no repeated panel IPC either');
          if (frame.snapshot) assert.equal(Object.hasOwn(frame.snapshot, 'unitStats'), false);
          if (frame.meta) assert.equal(Object.hasOwn(frame.meta, 'unitStats'), false);
        }
      }
      assert.equal(captures, input.specs.length);
      for (let i = 0; i < caches.length; i++) {
        assert.equal(engine.fields[i].battle._startUnitStats, caches[i]);
        assert.deepEqual(caches[i], values[i]);
      }
    } finally { engine.dispose(); }
  });
}

test('opening metadata and resync read cached stats without lazy recomputation, and filter hidden/removed units', () => {
  const engine = new CombatEngine(phase('normal'), { data: DATA });
  try {
    engine.advance(1);
    const battle = engine.fields[0].battle;
    const original = structuredClone(battle._startUnitStats);
    const unit = battle.units.find(u => original.some(e => e.id === u.id));
    assert.ok(unit);
    Object.defineProperty(unit, 's', { configurable: true, get() { throw new Error('opening/resync metadata must not recompute stats'); } });
    try {
      const meta = battle.fieldMeta({ includeUnitStats: true });
      assert.deepEqual(meta.unitStats.find(u => u.id === unit.id), original.find(u => u.id === unit.id));
      unit.hidden = true;
      assert.ok(!battle.fieldMeta({ includeUnitStats: true }).unitStats.some(u => u.id === unit.id));
      unit.hidden = false;
      unit.deployed = false;
      assert.ok(!battle.fieldMeta({ includeUnitStats: true }).unitStats.some(u => u.id === unit.id));
      assert.deepEqual(battle._startUnitStats, original, 'view filtering cannot mutate the opening cache');
    } finally { delete unit.s; }
  } finally { engine.dispose(); }
});
