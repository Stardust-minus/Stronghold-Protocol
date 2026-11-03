// test/ui/damage-board-diy.test.js — rel27 (the owner's report of 11-03: 「DPS面板无法正常显示甄选干员的名称，只会显示
// 甄选干员」): a 自选 piece's damage row names its DIY slot (defId), whose own record is the bodiless 「甄选干员」; the live
// board (ui/damageBoard.js damageAppearance) draws the picked operator from the row's pick (the ledger's, server/sim/
// damageBoard.js) or, without one, from the unit's b.snap `diy`; a skin still applies on top. Non-自选 rows are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
globalThis.fetch = async (url) => {
  const name = String(url).split('/').pop();
  try { const body = readFileSync(path.join(ROOT, 'data', name), 'utf8'); return { ok: true, status: 200, json: async () => JSON.parse(body) }; } catch { return { ok: false, status: 404, json: async () => ({}) }; }
};
const { data, getChess } = await import('../../public/js/data.js');
const { damageAppearance, damageRows } = await import('../../public/js/ui/damageBoard.js');
await data.loadAll('chess', 'assets', 'backups');

const SLOT = 'chess_char_6_diy1_a';
const MGLLAN = 'char_248_mgllan';
const pick = { charId: MGLLAN, skillIndex: 2, uniEquipId: null };
const operatorName = (charId) => Object.values(data.get('backups')?.diy?.operators || {}).length
  && (data.list('chess').find((c) => c.charId === charId)?.name || null);

test('the DIY slot alone is 甄选干员; with the row\'s pick the board draws the picked operator', () => {
  const slot = getChess(SLOT);
  assert.ok(slot?.isDiy, 'fixture: a DIY slot');
  assert.equal(slot.name, '甄选干员');
  const rec = damageAppearance(slot, { defId: SLOT, uid: 7, diy: pick }, 'p1', []);
  assert.notEqual(rec.name, '甄选干员');
  assert.equal(rec.charId, MGLLAN);
  const named = operatorName(MGLLAN);
  if (named) assert.equal(rec.name, named);
});

test('without the row\'s pick the unit\'s b.snap diy names it; neither leaves the slot (no worse than before)', () => {
  const slot = getChess(SLOT);
  const units = [{ ownerId: 'p1', defId: SLOT, uid: 7, kind: 'op', diy: pick }];
  assert.equal(damageAppearance(slot, { defId: SLOT, uid: 7 }, 'p1', units).charId, MGLLAN);
  assert.equal(damageAppearance(slot, { defId: SLOT, uid: 7 }, 'p2', units), slot, 'another owner\'s unit is not used');
});

test('a non-自选 row is untouched; damageRows hands a well-formed pick through and drops a malformed one', () => {
  const c = getChess('chess_char_1_01_a');
  assert.equal(damageAppearance(c, { defId: c.chessId, uid: 1 }, 'p1', []), c);
  const snap = { owners: [{ playerId: 'p1', operators: [
    { key: 'a', uid: 1, defId: SLOT, damage: 5, diy: pick }, { key: 'b', uid: 2, defId: SLOT, damage: 3, diy: { charId: '' } }] }] };
  const rows = damageRows(snap, 'p1').rows;
  assert.deepEqual(rows.find((r) => r.key === 'a').diy, pick);
  assert.equal(rows.find((r) => r.key === 'b').diy, undefined);
});
