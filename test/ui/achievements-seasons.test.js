// 成就统计 / 统计数据 after the owner's decisions of 2026-11-16: the panel by season (its title follows the season, the 成就
// list keeps counting every season), the trophies of the season shown on 名片 and the lobby card (as on the settlement),
// 规程's 评语 hexagon by kind (the official point), 评语收藏家's six kinds per table, 已获赞, the trophy achievements of
// 规程's levels 6–8, and the strategy marks (gold at victorCount, 规程's colourful one at masterVictorCount, every season).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRecord, strategyMasterIds, strategyBadgeIds, MASTER_VICTOR_COUNT } from '../../public/js/ui/stats.js';
import { hexWedges, titleTableFamily, REGULATION_KINDS, TITLE_HEX_SECTORS } from '../../public/js/ui/titleHexagon.js';
import { ACHIEVEMENTS, achievementsOf, achievementStats, panelSeasons, seasonTitle, titleKindsOf, progressOf } from '../../public/js/ui/achievements.js';
import { trophyTotal } from '../../public/js/ui/playerCard.js';
import { seasonVersion } from '../../public/js/ui/recordLookups.js';
import { levelProgress } from '../../public/js/screens/settle.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = (dir) => JSON.parse(readFileSync(path.join(ROOT, 'data', dir, 'config.json'), 'utf8'));
const COV = config('').titles;
const REG = config('versions/act3autochess-v3_1').titles;

function rec(seed, { version = null, bandId = 'band_amiya', victory = true, title = null, trophies = 0, likes = 0, roomMode = 'coop' } = {}) {
  return buildRecord({ seed, victory, roundsPassed: 14, difficulty: 'HARD', modeId: 'mode_multi_hard', durationMs: 60000,
    players: [{ playerId: 'me', bandId, victory, alive: victory, roundsPassed: 14, reward: 100, trophies, title: title ? { id: title } : null, stats: {}, ...(likes ? { likes } : {}) }],
  }, { myId: 'me', roomMode, version, now: 1_700_000_000_000 + seed });
}

test('the hexagon: 盟约 by title (the template order), 规程 by kind with the official point (rank 0 scores nothing)', () => {
  assert.equal(titleTableFamily(COV), 'covenant');
  assert.equal(titleTableFamily(REG), 'regulation');
  const cov = hexWedges(COV, { comment_1: 3, comment_4: 21 });
  assert.deepEqual(cov.map((w) => [w.key, w.angle, w.count]), TITLE_HEX_SECTORS.map(([id, angle]) => [id, angle, { comment_1: 3, comment_4: 21 }[id] || 0]));
  assert.equal(cov[0].name, '精英云集');
  // 规程: comment_1–3 BOND ranks 0–2, comment_16–18 DAMAGE
  const reg = hexWedges(REG, { comment_1: 5, comment_2: 2, comment_3: 4, comment_16: 9, comment_18: 1 });
  assert.deepEqual(reg.map((w) => w.key), [...REGULATION_KINDS]);
  assert.deepEqual(reg.map((w) => w.angle), TITLE_HEX_SECTORS.map(([, a]) => a));
  assert.equal(reg[0].count, 6, 'BOND: 坚实盟约 ×2 + 不朽盟约 ×4, not 百花齐放');
  assert.equal(reg[5].count, 1, 'DAMAGE: 绝对核心 ×1, not 幕后领袖');
  assert.deepEqual(reg[0].titles.map((x) => [x.name, x.awards]), [['百花齐放', 5], ['坚实盟约', 2], ['不朽盟约', 4]]);
  assert.equal(reg[0].kind, '盟约层数');
});

test('评语收藏家: 盟约 counts its six titles, 规程 its six kinds by a 评语 that scores', () => {
  const cov = ['comment_1', 'comment_2', 'comment_3', 'comment_4', 'comment_5'].map((id, i) => rec(i, { title: id }));
  assert.equal(titleKindsOf(cov), 5);
  // 规程: 18 titles; rank 0 (comment_1, comment_4) does not count, two of one kind count once
  const reg = ['comment_1', 'comment_4', 'comment_2', 'comment_3', 'comment_8', 'comment_12', 'comment_15', 'comment_18'].map((id, i) => rec(100 + i, { title: id, version: 'act3autochess@V3_1' }));
  assert.equal(titleKindsOf(reg, REG), 5, 'BOND, EQUIP, COIN, CHAR, DAMAGE');
  assert.equal(titleKindsOf(reg), 0, 'without the table 规程 collects nothing');
  assert.equal(titleKindsOf([...cov, ...reg], REG), 5, 'the best table');
  assert.equal(progressOf(reg, { regulationTitles: REG }).titleKinds, 5);
});

test('the panel by season: the shown season and every one with records, oldest first; the title follows the family', () => {
  const records = [rec(1), rec(2, { version: 'act1autochess@V1_1' }), rec(3, { version: 'act3autochess@V3_1' })];
  assert.deepEqual(panelSeasons(records, 'act3autochess'), ['act1autochess', 'act2autochess', 'act3autochess']);
  assert.deepEqual(panelSeasons([], 'act3autochess'), ['act3autochess']);
  assert.deepEqual(seasonTitle('act3autochess'), { en: 'REGULATION', name: '卫戍协议：规程', regulation: true });
  assert.deepEqual(seasonTitle('act1autochess'), { en: 'ALLIANCE', name: '卫戍协议：盟约', regulation: false });
  assert.deepEqual(seasonTitle('act2autochess'), seasonTitle('act1autochess'));
  assert.equal(seasonVersion('act2autochess'), 'act2autochess');
  assert.equal(seasonVersion('act3autochess'), 'act3autochess@V3_1');
});

test('名片 / the lobby card: the trophies of the season shown, the count of the settlement', () => {
  const records = [rec(1, { trophies: 6 }), rec(2, { trophies: 5, version: 'act2autochess@V2_1' }), rec(3, { trophies: 8, version: 'act3autochess@V3_1' })];
  assert.equal(trophyTotal(records), 19, 'every season without one');
  assert.equal(trophyTotal(records, 'act2autochess'), 11, 'both halves of 第二期');
  assert.equal(trophyTotal(records, 'act3autochess'), 8);
  for (const season of ['act2autochess', 'act3autochess']) {
    assert.equal(trophyTotal(records, season), levelProgress(records, { season, at: Infinity }).trophies, season);
  }
});

test('已获赞, the trophy achievements of levels 6–8, and the strategy marks (gold, then colourful at masterVictorCount)', () => {
  const ids = ACHIEVEMENTS.map((a) => a.id);
  for (const [id, goal] of [['trophy_150', 150], ['trophy_200', 200], ['trophy_300', 300]]) {
    const a = ACHIEVEMENTS.find((x) => x.id === id);
    assert.ok(a && a.goal === goal && a.group === 'trophy', id);
  }
  assert.equal(new Set(ids).size, ids.length);
  const done = (n) => achievementsOf({ ...progressOf([]), trophies: n }).filter((a) => a.group === 'trophy' && a.done).map((a) => a.goal);
  assert.deepEqual(done(210), [10, 30, 60, 100, 150, 200]);
  const bands = { band_amiya: { bandId: 'band_amiya', victorCount: 3, sortId: 1 }, band_fang: { bandId: 'band_fang', victorCount: 3, sortId: 2 } };
  const records = [
    ...Array.from({ length: MASTER_VICTOR_COUNT }, (_, i) => rec(10 + i, { likes: i === 0 ? 2 : 0 })),
    ...Array.from({ length: 3 }, (_, i) => rec(30 + i, { bandId: 'band_fang', likes: 1 })),
  ];
  assert.equal(MASTER_VICTOR_COUNT, 6);
  assert.deepEqual(strategyBadgeIds(records, bands), ['band_amiya', 'band_fang']);
  assert.deepEqual(strategyMasterIds(records, bands), ['band_amiya']);
  const s = achievementStats(records, { bands });
  assert.deepEqual(s.markedBands, ['band_amiya', 'band_fang']);
  assert.deepEqual(s.masterBands, ['band_amiya']);
  assert.equal(s.likes, 5);
});
