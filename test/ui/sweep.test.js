// test/ui/sweep.test.js — S.W.E.E.P.报告 (screens/sweep.js): the enemy codex's list (one entry per 图鉴 number, no
// summon-only units), a leader's enemies (the leader, then its escorts) and the letter grades.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { enemyGrade, codexEnemies, bossEnemyKeys } from '../../public/js/screens/sweep.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

const ENEMIES = JSON.parse(readFileSync(new URL('../../data/enemies.json', import.meta.url), 'utf8'));
const BOSSES = JSON.parse(readFileSync(new URL('../../data/bosses.json', import.meta.url), 'utf8'));
// 装备报告 (upstream 0.4.0: 规程's fourth tab). screens/sweep.js is this fork's page; read through the module object so a
// page without these helpers fails only their own tests below, not the file
const { equipReportOn, equipReportGroups } = await import('../../public/js/screens/sweep.js');

test('the codex lists every enemy but the summon-only ones, once per 图鉴 number', () => {
  const list = codexEnemies(Object.values(ENEMIES));
  assert.ok(list.length > 200);
  assert.ok(list.every((e) => !e.tokenOnly));
  const ids = list.map((e) => `${e.handbookIndex}|${e.name}`);
  assert.equal(new Set(ids).size, ids.length);
  // the hidden variant of a leader shares its number: only one of them
  assert.equal(list.filter((e) => e.handbookIndex === 'SP08' && e.name === '假想敌：胄').length, 1);
  // ordered by id
  assert.equal(list[0].key, 'enemy_1000_gopro_2');
  assert.deepEqual(codexEnemies(null), []);
});

test('a leader brings its escorts, the leader first and no key twice', () => {
  const boss = BOSSES.boss_1;
  const keys = bossEnemyKeys(boss);
  assert.equal(keys[0], boss.enemyKey);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes('enemy_1427_lrnazg'));
  assert.ok(keys.every((k) => Object.hasOwn(ENEMIES, k)));
  assert.deepEqual(bossEnemyKeys({ enemyKey: 'x' }), ['x']);
});

test('grades rise with the stat (the attack interval the other way) and say — without a value', () => {
  assert.equal(enemyGrade('maxHp', 800), 'E');
  assert.equal(enemyGrade('maxHp', 22000), 'B+');
  assert.equal(enemyGrade('maxHp', 2500000), 'S');
  assert.equal(enemyGrade('atk', 1900), 'S');
  assert.equal(enemyGrade('def', 800), 'A');
  assert.equal(enemyGrade('res', 0), 'E');
  assert.equal(enemyGrade('interval', 6), 'E');
  assert.equal(enemyGrade('interval', 0.5), 'S');
  assert.equal(enemyGrade('interval', null), '—');
  assert.equal(enemyGrade('moveSpeed', undefined), '—');
  assert.equal(enemyGrade('nope', 5), '—');
});

const TIER4 = ['寻呼模块', '蜂鸣器', '伪装服', '卡西米尔竞技旗', '灼燃维式重锤', '护盾无人机', 'M3茧甲', '莱塔尼亚小鼓', '谢拉格不融冰', '可靠怀表', '一次性促销券', '驱逐者警棍', '动能单手弩', '汲取者之喙'];

test('equipReportOn: 装备报告 only when config.version.family is regulation', () => {
  const reg = JSON.parse(read('data/versions/act3autochess-v3_1/config.json'));
  const act1 = JSON.parse(read('data/versions/act1autochess/config.json'));
  const def = JSON.parse(read('data/config.json'));
  assert.equal(reg.version.family, 'regulation');
  assert.equal(equipReportOn(reg), true);
  assert.equal(act1.version.family, 'covenant');
  assert.equal(equipReportOn(act1), false);
  assert.equal(def.version, undefined);
  assert.equal(equipReportOn(def), false);
  assert.equal(equipReportOn(null), false);
  assert.equal(equipReportOn({}), false);
  assert.equal(equipReportOn({ version: { family: 'covenant' } }), false);
  assert.equal(equipReportOn({ version: { id: 'act3autochess@V3_1' } }), false, 'the id alone is not the gate');
  assert.equal(equipReportOn({ version: { family: 'regulation' } }), true);
});

test('equipReportGroups: 规程 base EQUIP, tiers 1–6, shopSortId, golden pairing; an absent golden record is null', () => {
  const items = JSON.parse(read('data/versions/act3autochess-v3_1/items.json'));
  const groups = equipReportGroups(items);
  assert.deepEqual(groups.map((g) => g.tier), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(groups.map((g) => g.items.length), [7, 10, 16, 14, 12, 6]);
  const names = (tier) => groups.find((g) => g.tier === tier).items.map((r) => r.item.name);
  assert.deepEqual(names(4), TIER4);
  for (const g of groups) {
    const sorts = g.items.map((r) => r.item.shopSortId);
    assert.deepEqual(sorts, [...sorts].sort((a, b) => a - b), `tier ${g.tier} shopSortId`);
    for (const { item, golden } of g.items) {
      assert.equal(item.itemType, 'EQUIP');
      assert.notEqual(item.isGolden, true);
      if (golden) {
        assert.equal(golden.id, item.goldenId);
        assert.notEqual(golden.id, item.id);
      } else {
        assert.equal(items[item.goldenId], undefined);
      }
    }
  }
  const buzz = groups.find((g) => g.tier === 4).items.find((r) => r.item.name === '蜂鸣器');
  assert.match(buzz.item.descRaw, /\+40%/);
  assert.match(buzz.golden.descRaw, /\+60%/);
  assert.equal(buzz.item.flavor, '“你们去救伤员，我来对付这些混蛋！”');
  const pager = groups.find((g) => g.tier === 4).items.find((r) => r.item.name === '寻呼模块');
  assert.equal(pager.golden, null);
  assert.equal(pager.item.goldenId, null);
  // the same rows from an array as from the file object
  const fromList = equipReportGroups(Object.values(items));
  assert.deepEqual(fromList.map((g) => g.items.map((r) => r.item.id)), groups.map((g) => g.items.map((r) => r.item.id)));
  // 盟约's table is a different list; the screen must not show it (the gate above)
  const defGroups = equipReportGroups(JSON.parse(read('data/items.json')));
  assert.notDeepEqual(defGroups.find((g) => g.tier === 4).items.map((r) => r.item.name), TIER4);
});

test('equipReportGroups: drops golden, non-EQUIP and tiers outside 1–6; missing goldenId is no pair; id breaks a shopSortId tie', () => {
  assert.deepEqual(equipReportGroups(null), []);
  assert.deepEqual(equipReportGroups(undefined), []);
  assert.deepEqual(equipReportGroups({}), []);
  const items = {
    a: { id: 'a', itemType: 'EQUIP', isGolden: false, tier: 2, shopSortId: 2, goldenId: 'aB', name: 'A' },
    aB: { id: 'aB', itemType: 'EQUIP', isGolden: true, tier: 2, shopSortId: 2, name: 'A+' },
    b: { id: 'b', itemType: 'EQUIP', isGolden: false, tier: 2, shopSortId: 1, goldenId: 'missing', name: 'B' },
    c: { id: 'c', itemType: 'EQUIP', isGolden: false, tier: 6, shopSortId: 1, goldenId: null, name: 'C' },
    mag: { id: 'mag', itemType: 'MAGIC', isGolden: false, tier: 1, shopSortId: 1, name: 'M' },
    goldOnly: { id: 'g', itemType: 'EQUIP', isGolden: true, tier: 1, shopSortId: 1, name: 'G' },
    t0: { id: 't0', itemType: 'EQUIP', isGolden: false, tier: 0, shopSortId: 1, name: 'Z' },
    t7: { id: 't7', itemType: 'EQUIP', isGolden: false, tier: 7, shopSortId: 1, name: 'Y' },
    self: { id: 'self', itemType: 'EQUIP', isGolden: false, tier: 1, shopSortId: 2, goldenId: 'self', name: 'S' },
    tieB: { id: 'tie-b', itemType: 'EQUIP', isGolden: false, tier: 1, shopSortId: 1, name: 'Tb' },
    tieA: { id: 'tie-a', itemType: 'EQUIP', isGolden: false, tier: 1, shopSortId: 1, name: 'Ta' },
  };
  const groups = equipReportGroups(items);
  assert.deepEqual(groups.map((g) => g.tier), [1, 2, 6]);
  assert.deepEqual(groups[0].items.map((r) => [r.item.id, r.golden]), [['tie-a', null], ['tie-b', null], ['self', null]]);
  assert.deepEqual(groups[1].items.map((r) => [r.item.id, r.golden && r.golden.id]), [['b', null], ['a', 'aB']]);
  assert.deepEqual(groups[2].items.map((r) => r.item.id), ['c']);
});

test('装备报告 is appended only for 规程; the three 盟约 tabs stay the base list (source contract)', () => {
  const src = read('public/js/screens/sweep.js');
  const base = src.slice(src.indexOf('const REPORT_TABS'), src.indexOf('const EQUIP_TAB'));
  assert.match(base, /盟约报告/);
  assert.match(base, /策略报告/);
  assert.match(base, /敌方资料/);
  assert.doesNotMatch(base, /装备报告/);
  assert.match(src, /const EQUIP_TAB = \{ id: 'equip', name: N_\('装备报告'\)/);
  assert.match(src, /name="shield"/);
  assert.match(src, /equipOn \? \[\.\.\.REPORT_TABS, EQUIP_TAB\] : REPORT_TABS/);
  assert.match(src, /t\('基础效果'\)/);
  assert.match(src, /t\('进阶效果'\)/);
  assert.match(src, /itemIconUrl\(m, item\)/);
  assert.match(src, /item\.descRaw \|\| item\.desc/);
  assert.match(src, /golden\.descRaw \|\| golden\.desc/);
  assert.match(src, /\$\{golden \? html/);
  assert.match(read('public/css/screens/sweep.css'), /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
});
