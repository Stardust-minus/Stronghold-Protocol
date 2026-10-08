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
  for (const [index, frame] of results[1].frames.entries()) {
    const expected = chosen.specs.find(s => s.fieldId === frame.fieldId).players[0].units[0].skinId;
    const unit = frame.meta?.units.find(u => u.defId === 'chess_char_3_01_b');
    assert.equal(unit.skinId, expected); assert.equal(unit.spine, 'char_103_angel');
    const unskinned = results[0].frames[index]; assert.deepEqual(frame.snapshot, unskinned.snapshot);
  }
  const state = await skin.request('state', { snapshotFields });
  for (const frame of state.frames) {
    const expected = chosen.specs.find(s => s.fieldId === frame.fieldId).players[0].units[0].skinId;
    assert.equal(frame.meta.units.find(u => u.defId === 'chess_char_3_01_b').skinId, expected);
    assert(frame.meta.units.every(u => !Object.hasOwn(u, 'skins')));
  }
  base.close(); skin.close();
});
