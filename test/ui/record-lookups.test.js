// Strategy / alliance names of every official version in the record views (ui/recordLookups.js; owner's report of
// 2026-11-16: 成就统计's 最常使用的策略 printed band_bldsk / band_narant for 华法琳 / 娜仁图亚 on a 规程 page) and the
// 成就统计 rules that follow the game (ui/achievements.js): the official strategy mark (victorCount clears, as the strategy
// draft's corner badge), the 评语 hexagon per 评语 table and its fill, the LV of the season as on the settlement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSIONS, DEFAULT_VERSION } from '../../shared/versions.js';
import { buildRecord, strategyBadgeIds } from '../../public/js/ui/stats.js';
import { versionsToLoad, withAllVersions, configVersion } from '../../public/js/ui/recordLookups.js';
import { achievementStats, titleKindsOf, titleFamilyOf, hexFill, markClears, seasonLevel } from '../../public/js/ui/achievements.js';
import { levelProgress } from '../../public/js/screens/settle.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (v, file) => JSON.parse(readFileSync(path.join(ROOT, 'data', v.dir, `${file}.json`), 'utf8'));
const records = (json) => (Array.isArray(json) ? json : Object.values(json));

/** A version's files as the lookups see them (data.js indexes by bandId / bondId). */
function storeOf(v) {
  const files = { bands: records(read(v, 'bands')), bonds: records(read(v, 'bonds')) };
  const key = { bands: 'bandId', bonds: 'bondId' };
  return { lookup: (f, id) => files[f].find((r) => r[key[f]] === id) || null, list: (f) => files[f] };
}
/** makeLookups over one version's files (the page's data when it shows that version). */
function shownGd(v) {
  const s = storeOf(v);
  return { ready: true, config: read(v, 'config'), band: (id) => s.lookup('bands', id), bond: (id) => s.lookup('bonds', id), list: (f) => s.list(f) };
}

function rec(seed, { version = null, bandId = 'band_amiya', victory = true, title = null, reward = 300, roomMode = 'coop' } = {}) {
  return buildRecord({ seed, victory, roundsPassed: 14, difficulty: 'HARD', modeId: 'mode_multi_hard', durationMs: 60000,
    players: [{ playerId: 'me', bandId, victory, alive: victory, roundsPassed: 14, reward, title: title ? { id: title } : null, stats: {} }],
  }, { myId: 'me', roomMode, version, now: 1_700_000_000_000 + seed });
}

test('every strategy and alliance of every version has a name whichever version the page shows (规程 renamed every strategy)', () => {
  const all = { bands: new Map(), bonds: new Map() };
  for (const v of VERSIONS) for (const f of ['bands', 'bonds']) for (const r of storeOf(v).list(f)) all[f].set(r.bandId || r.bondId, r.name);
  assert.ok(all.bands.size >= 85 && all.bonds.size >= 27, `${all.bands.size} strategies, ${all.bonds.size} alliances`);
  for (const shown of VERSIONS) {
    const others = new Map(VERSIONS.filter((v) => v.id !== shown.id).map((v) => [v.id, storeOf(v)]));
    const gd = withAllVersions(shownGd(shown), others);
    for (const [id, name] of all.bands) assert.equal(gd.band(id)?.name, name, `${id} on a ${shown.id} page`);
    for (const [id, name] of all.bonds) assert.equal(gd.bond(id)?.name, name, `${id} on a ${shown.id} page`);
  }
});

test('the owner\'s cases: 盟约\'s 华法琳 / 娜仁图亚 on a 规程 page, 规程\'s on a 盟约 page, 第一期\'s 森蚺; the version an id comes from', () => {
  const v = (id) => VERSIONS.find((x) => x.id === id);
  const reg = v('act3autochess@V3_1');
  const gd = withAllVersions(shownGd(reg), new Map([[DEFAULT_VERSION, storeOf(v(DEFAULT_VERSION))], ['act1autochess', storeOf(v('act1autochess'))]]),
    (zh) => ({ 华法琳: 'Warfarin' })[zh] || zh);
  assert.equal(gd.band('band_bldsk').name, 'Warfarin', 'another version\'s Chinese name through data.localeName');
  assert.equal(gd.band('band_narant').name, '娜仁图亚');
  assert.equal(gd.band('band_zumama').name, '森蚺');
  assert.equal(gd.band('band_takecare').name, '华法琳', 'the shown data\'s own record untouched');
  assert.equal(gd.foreign('bands', 'band_bldsk'), DEFAULT_VERSION);
  assert.equal(gd.foreign('bands', 'band_zumama'), 'act1autochess');
  assert.equal(gd.foreign('bands', 'band_takecare'), null);
  assert.equal(gd.band('band_nope'), null);
  const bands = gd.bands();
  assert.ok(bands.band_bldsk && bands.band_takecare && bands.band_zumama, 'every known strategy for the marks');
  const cov = withAllVersions(shownGd(v(DEFAULT_VERSION)), new Map([[reg.id, storeOf(reg)]]));
  assert.equal(cov.band('band_sargon').name, '娜仁图亚');
  assert.equal(cov.foreign('bands', 'band_sargon'), reg.id);
});

test('the versions a view loads: those its records played, not the shown one, in registry order', () => {
  const list = [rec(1, { version: 'act1autochess' }), rec(2), rec(3, { version: 'act3autochess@V3_1' }), rec(4, { version: 'act1autochess' })];
  assert.deepEqual(versionsToLoad(list, 'act3autochess@V3_1'), [DEFAULT_VERSION, 'act1autochess']);
  assert.deepEqual(versionsToLoad(list, DEFAULT_VERSION), ['act1autochess', 'act3autochess@V3_1']);
  assert.deepEqual(versionsToLoad([], DEFAULT_VERSION), []);
  assert.equal(configVersion({ version: { id: 'act3autochess@V3_1' } }), 'act3autochess@V3_1');
  assert.equal(configVersion({}), DEFAULT_VERSION);
});

test('成就统计\'s strategy mark is the official one: victorCount clears with the strategy, in any version, as the draft\'s corner badge', () => {
  const bands = { band_bldsk: { bandId: 'band_bldsk', victorCount: 3, sortId: 1 }, band_takecare: { bandId: 'band_takecare', victorCount: 3, sortId: 2 } };
  const list = [
    rec(1, { bandId: 'band_bldsk' }), rec(2, { bandId: 'band_bldsk' }),
    rec(3, { bandId: 'band_takecare', version: 'act3autochess@V3_1' }), rec(4, { bandId: 'band_takecare', version: 'act3autochess@V3_1' }),
    rec(5, { bandId: 'band_takecare', version: 'act3autochess@V3_1' }), rec(6, { bandId: 'band_bldsk', victory: false }),
  ];
  assert.deepEqual(achievementStats(list, { bands }).markedBands, ['band_takecare'], 'one hard clear no longer marks; three clears do');
  assert.deepEqual(achievementStats(list, { bands }).markedBands, strategyBadgeIds(list, bands), 'the same rule as the strategy draft');
  assert.deepEqual(achievementStats([...list, rec(7, { bandId: 'band_bldsk' })], { bands }).markedBands, ['band_bldsk', 'band_takecare']);
  assert.equal(markClears(bands), 3);
  assert.equal(markClears({}), 3);
});

test('the 评语 hexagon counts the records of the shown version\'s 评语 table; 评语收藏家 counts one table', () => {
  const list = [rec(1, { title: 'comment_3' }), rec(2, { title: 'comment_3', version: 'act1autochess' }),
    rec(3, { title: 'comment_3', version: 'act3autochess@V3_1' }), rec(4, { title: 'comment_1', version: 'act3autochess@V3_1' })];
  assert.equal(titleFamilyOf(list[0]), 'covenant');
  assert.equal(titleFamilyOf(list[2]), 'regulation');
  assert.deepEqual(achievementStats(list, { titleFamily: 'covenant' }).titles, { comment_3: 2 }, '坚若磐石 of both 盟约 periods, not 规程\'s 不朽盟约');
  assert.deepEqual(achievementStats(list, { titleFamily: 'regulation' }).titles, { comment_3: 1, comment_1: 1 });
  // 评语收藏家 (2026-11-16): 盟约's titles, 规程's kinds by a scoring 评语 (its table needed: rank 0 百花齐放 does not count)
  assert.equal(titleKindsOf(list), 1, '盟约: 坚若磐石; 规程 without its table collects nothing');
  const regTable = read(VERSIONS.find((v) => v.family === 'regulation'), 'config').titles;
  assert.equal(titleKindsOf(list, regTable), 1, '规程: one kind, BOND (不朽盟约)');
  assert.equal(hexFill(0), 0);
  assert.equal(hexFill(5), 0.25);
  assert.equal(hexFill(20), 1);
  assert.equal(hexFill(31), 1);
});

test('the card\'s LV is the settlement\'s: the experience of the season of the version shown', () => {
  const list = [rec(1, { reward: 900 }), rec(2, { reward: 900, version: 'act2autochess@V2_1' }), rec(3, { reward: 600, version: 'act3autochess@V3_1' })];
  assert.equal(seasonLevel(list, 'act2autochess').lv, 7, '第二期: both periods, 1800 exp');
  assert.equal(seasonLevel(list, 'act3autochess').lv, 3, '规程 alone, 600 exp');
  assert.equal(seasonLevel(list, 'act3autochess').lv, 1 + Math.floor(levelProgress(list, { season: 'act3autochess' }).before / 300));
});
