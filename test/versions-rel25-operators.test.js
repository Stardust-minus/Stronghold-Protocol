// test/versions-rel25-operators.test.js — rel25's 自选 operators in every official version (the owner, 2026-11-02: before,
// only 第二期下半 offered them): 塔露拉, 冻河 and 国度 are owned picks, the 7 collab 6★ are offered with 联动干员 on, in
// 第二期上半, 第一期下半 and 第一期上半 alike (tools/versions/<slug>.mjs lateOperators; 第一期's diyBonds). The picker
// (diyPool) and the roster check (validateDiyPicks) read the room's version data, as the lobby (Lobby.dataFor) does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { diyPool, validateDiyPicks, isCollabPick } from '../shared/diy.js';
import { KITTED_CHARS } from '../server/sim/content/kits/index.js';
import { VERSIONS, versionSlug } from '../shared/versions.js';

const OWNED = ['char_4244_tocka', 'char_4246_dminon', 'char_4247_oxi'];
const COLLAB = ['char_456_ash', 'char_1029_yato2', 'char_1048_orchd2', 'char_4123_ela', 'char_4141_marcil', 'char_4182_oblvns', 'char_4217_makoto'];
const readDir = (rel) => {
  const dir = new URL(`../data/${rel}`, import.meta.url);
  return Object.fromEntries(['backups', 'bonds', 'chess'].map((n) => [n, JSON.parse(readFileSync(new URL(`${n}.json`, dir), 'utf8'))]));
};
const SETS = VERSIONS.map((v) => ({ id: v.id, slug: versionSlug(v), data: readDir(v.dir) }));

test('every version: 塔露拉 冻河 国度 owned in both tiers, the 7 collab picks only with 联动干员 on, all kitted', () => {
  assert.equal(SETS.length, 4);
  for (const { id, data } of SETS) {
    for (const c of [...OWNED, ...COLLAB]) assert.ok(KITTED_CHARS.includes(c), `${c} has a kit`);
    for (const tier of [5, 6]) {
      const off = diyPool(tier, { data, kitted: KITTED_CHARS }), on = diyPool(tier, { data, kitted: KITTED_CHARS, collab: true });
      for (const c of OWNED) assert.ok(off.includes(c), `${id} tier ${tier}: ${c}`);
      for (const c of COLLAB) {
        assert.ok(!off.includes(c) && on.includes(c), `${id} tier ${tier}: ${c} only with 联动干员 on`);
        assert.equal(isCollabPick(data, c), true);
      }
    }
  }
});

test('every version: a collab pick passes the roster check only with collab, an owned new pick always; every bond named exists', () => {
  for (const { id, data } of SETS) {
    const slots = Object.keys(data.backups.diy.slots).filter((s) => data.backups.diy.slots[s].tier === 6);
    const pick = (charId) => ({ [slots[0]]: { charId, skillIndex: 0 } });
    for (const c of OWNED) assert.ok('ok' in validateDiyPicks(pick(c), { data, kitted: KITTED_CHARS }), `${id}: ${c}`);
    for (const c of COLLAB) {
      assert.equal(validateDiyPicks(pick(c), { data, kitted: KITTED_CHARS }).error, 'BAD_TARGET', `${id}: ${c} off`);
      assert.ok('ok' in validateDiyPicks(pick(c), { data, kitted: KITTED_CHARS, collab: true }), `${id}: ${c} on`);
    }
    const bonds = new Set(Object.keys(data.bonds));
    for (const c of [...OWNED, ...COLLAB]) {
      const op = data.backups.diy.operators[c];
      assert.ok(op && op.bonds.length > 0, `${id}: ${c} has 自选 bonds`);
      for (const b of op.bonds) assert.ok(bonds.has(b), `${id}: ${c}'s bond ${b} is one of the version's`);
      assert.ok(data.backups.units[c], `${id}: ${c} has its unit record`);
    }
  }
});

test('第一期 (no 奥术 / 独行): 国度 协防 + 迅捷, 塔露拉 协防 + 不屈, 玛露西尔 协防; 第二期 keeps the default bonds', () => {
  const ops = (id) => SETS.find((s) => s.id === id).data.backups.diy.operators;
  for (const id of ['act1autochess', 'act1autochess@V1_1']) {
    const o = ops(id);
    assert.deepEqual([o.char_4246_dminon.bonds, o.char_4247_oxi.bonds, o.char_4141_marcil.bonds],
      [['emptyShip', 'swiftShip'], ['emptyShip', 'indomShip'], ['emptyShip']], id);
  }
  const today = ops('act2autochess');
  for (const c of [...OWNED, ...COLLAB]) assert.deepEqual(ops('act2autochess@V2_1')[c].bonds, today[c].bonds, c);
});
