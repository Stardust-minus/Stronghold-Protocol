// Actual worker-thread transport: display metadata changes, numerical simulation and original identity do not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CombatWorkerPool } from '../server/match/combat/pool.js';
import { DATA, QUIET, phase } from './match/combat-fixtures.js';
import { OPERATOR_SKINS } from '../shared/skins.js';

test('real combat Worker retains separate skin IDs in cached field metadata and spawn events without changing snapshots', { timeout: 20000 }, async t => {
  const pool = new CombatWorkerPool({ size: 1, data: DATA, log: QUIET }); t.after(() => pool.close()); await pool.start();
  const plain = phase('normal'), chosen = structuredClone(plain);
  chosen.specs[0].players[0].units[0].skinId = OPERATOR_SKINS[0].id;
  chosen.specs[1].players[0].units[0].skinId = OPERATOR_SKINS[1].id;
  const base = pool.create(plain), skin = pool.create(chosen);
  await Promise.all([base.ready, skin.ready]);
  const snapshotFields = plain.specs.map(s => s.fieldId);
  const results = await Promise.all([base.request('advance', { ticks: 3, snapshotFields }), skin.request('advance', { ticks: 3, snapshotFields })]);
  const openings = results[1].frames.filter(frame => frame.startMeta);
  assert.equal(openings.length, snapshotFields.length, 'one immutable first-tick cache per real field');
  assert.equal(new Set(openings.map(frame => frame.fieldId)).size, snapshotFields.length);
  const snapshots = results[1].frames.filter(frame => frame.snapshot);
  assert.equal(snapshots.length, snapshotFields.length, 'opening metadata does not replace the periodic snapshots');
  const spawns = [];
  for (const frame of results[1].frames) {
    const expected = chosen.specs.find(s => s.fieldId === frame.fieldId).players[0].units[0].skinId;
    const meta = frame.startMeta || frame.meta;
    assert.ok(meta, 'both opening and periodic metadata retain the displayed unit identity');
    const unit = meta.units.find(u => u.defId === 'chess_char_3_01_b');
    assert.ok(unit); assert.equal(unit.skinId, expected); assert.equal(unit.spine, 'char_103_angel');
    assert(meta.units.every(u => !Object.hasOwn(u, 'skins')));
    const unskinned = results[0].frames.find(f => f.fieldId === frame.fieldId && !!f.startMeta === !!frame.startMeta);
    assert.ok(unskinned);
    if (frame.startMeta) assert.deepEqual(frame.startMeta.unitStats, unskinned.startMeta.unitStats, 'skin metadata changes no numerical panel DTO');
    if (frame.snapshot) {
      assert.equal(Object.hasOwn(frame.snapshot, 'unitStats'), false, 'periodic tuples remain compact');
      assert.deepEqual(frame.snapshot, unskinned.snapshot);
    }
    for (const event of frame.events || []) if (event[0] === 'spawn' && event[1].defId === 'chess_char_3_01_b') {
      assert.equal(event[1].skinId, expected); assert.equal(event[1].spine, 'char_103_angel'); spawns.push(frame.fieldId);
    }
  }
  assert.deepEqual(spawns.sort(), snapshotFields.slice().sort(), 'real spawn events also carry each field owner skin');
  const [state, baseState] = await Promise.all([skin.request('state', { snapshotFields }), base.request('state', { snapshotFields })]);
  assert.equal(state.frames.filter(frame => frame.startMeta).length, 0, 'state resync does not replay the first-tick cache');
  for (const frame of state.frames) {
    const expected = chosen.specs.find(s => s.fieldId === frame.fieldId).players[0].units[0].skinId;
    assert.equal(frame.meta.units.find(u => u.defId === 'chess_char_3_01_b').skinId, expected);
    assert(frame.meta.units.every(u => !Object.hasOwn(u, 'skins')));
    const unskinned = baseState.frames.find(f => f.fieldId === frame.fieldId);
    assert.ok(unskinned); assert.deepEqual(frame.snapshot, unskinned.snapshot, 'resync also preserves numerical simulation');
  }
  base.close(); skin.close();
});
