// PR #828 review (must-fix F2): the strategy wall's orange corner badge follows the official bands victorCount — the
// stats page's own rule, ui/stats.js strategyBadgeIds (3 clears for all 40 strategies) — not a single local win; the
// detail pane's 已通过模拟 N 次 keeps counting every win. screens/bandDraft.js draftRecords, read after the screen is up.
// 2026-11-16 (the owner: 「右上角的金色角标在此版本新增了一个彩色的」): 规程's colourful badge (the client's _panelMasterMark)
// replaces the gold one at masterVictorCount clears (6 in 规程's activity_table; ui/stats.js strategyMasterIds); both are
// the client's sprites from the local art (data/local-assets.json ui/outer), placed as on its 140-px band item.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

const { buildRecord, strategyMasterIds, masterVictorCountOf, MASTER_VICTOR_COUNT } = await import('../../public/js/ui/stats.js');
const { draftRecords, badgeTier, BandBadge } = await import('../../public/js/screens/bandDraft.js');

const BANDS = JSON.parse(read('data/bands.json'));

function record(seed, { bandId = 'band_amiya', victory = true, difficulty = 'HARD', modeId = 'mode_multi_hard' } = {}) {
  return buildRecord({ seed, victory, roundsPassed: 14, difficulty, modeId, hiddenReached: false, hiddenCleared: false,
    players: [{ playerId: 'self', bandId, victory, alive: victory, roundsPassed: 14, stats: {} }],
  }, { myId: 'self', now: seed + 1 });
}

test('every official strategy needs 3 clears for its badge (data/bands.json victorCount, from activity_table)', () => {
  const list = Object.values(BANDS);
  assert.equal(list.length, 40);
  assert.ok(list.every((b) => b.victorCount === 3), 'victorCount 3 for all 40');
});

test('draftRecords: one win counts (已通过模拟 1 次) but gives no badge; the third clear does; training and quits never do', () => {
  const one = draftRecords([record(1)], BANDS);
  assert.deepEqual(one.won, { band_amiya: 1 });
  assert.deepEqual([...one.badges], [], 'a single local win is not the badge');
  const two = draftRecords([record(1), record(2), record(3, { difficulty: 'TRAINING', modeId: 'mode_training_1' }), { ...record(4), end: 'quit' }], BANDS);
  assert.deepEqual([...two.badges], [], 'training and a quit run are no clears');
  const three = draftRecords([record(1), record(2), record(5)], BANDS);
  assert.deepEqual(three.won, { band_amiya: 3 });
  assert.deepEqual([...three.badges], ['band_amiya']);
  const lost = draftRecords([record(1), record(2), record(6, { victory: false })], BANDS);
  assert.deepEqual([...lost.badges], [], 'a lost run is no clear');
  assert.deepEqual(draftRecords([], BANDS), { won: {}, badges: new Set(), masters: new Set(), trophies: 0 });
});

test('the colourful badge: masterVictorCount clears (6 when the data has no field), in place of the gold one', () => {
  assert.equal(MASTER_VICTOR_COUNT, 6);
  assert.equal(masterVictorCountOf({ victorCount: 3 }), 6, 'data/ carries no masterVictorCount: 规程\'s bar');
  assert.equal(masterVictorCountOf({ victorCount: 3, masterVictorCount: 4 }), 4, 'the field when a table has it');
  const runs = (n, bandId = 'band_amiya') => Array.from({ length: n }, (_, i) => record(100 + i, { bandId }));
  const five = draftRecords([...runs(5), record(200, { difficulty: 'TRAINING', modeId: 'mode_training_1' })], BANDS);
  assert.deepEqual([...five.badges], ['band_amiya']);
  assert.deepEqual([...five.masters], [], 'five clears (a training run is none)');
  assert.equal(badgeTier(five, 'band_amiya'), 'victor');
  const six = draftRecords(runs(6), BANDS);
  assert.deepEqual([...six.masters], ['band_amiya']);
  assert.equal(badgeTier(six, 'band_amiya'), 'master');
  assert.equal(badgeTier(six, 'band_bldsk'), null);
  assert.deepEqual(strategyMasterIds(runs(4), { a: { bandId: 'band_amiya', victorCount: 3, masterVictorCount: 4 } }), ['band_amiya']);
});

test('BandBadge: the client sprites — gold team_list_victor_team, colourful team_list_master_team_bg + team_list_master_team', () => {
  const sprites = (v) => {
    const out = [];
    const walk = (x) => { if (Array.isArray(x)) return x.forEach(walk); if (!x || typeof x !== 'object') return; if (x.props?.name) out.push(`${x.props.group}/${x.props.name}`); walk(x.props?.children); };
    walk(v);
    return out;
  };
  assert.equal(BandBadge({ tier: null }), null);
  const gold = BandBadge({ tier: 'victor' });
  assert.equal(gold.props['data-tier'], 'victor');
  assert.deepEqual(sprites(gold), ['ui/outer/team_list_victor_team']);
  const master = BandBadge({ tier: 'master' });
  assert.equal(master.props['data-tier'], 'master');
  assert.deepEqual(sprites(master), ['ui/outer/team_list_master_team_bg', 'ui/outer/team_list_master_team']);
});

test('the wall gates the badge on draftRecords() with the client sprites; the records are read after mount', () => {
  const src = read('public/js/screens/bandDraft.js');
  assert.match(src, /const tier = badgeTier\(local, b\.bandId\);/);
  assert.match(src, /<\$\{BandBadge\} tier=\$\{tier\} \/>/);
  assert.match(src, /<\$\{LocalSprite\} group="ui\/outer" name="team_list_victor_team" class="dband__badge-art"/);
  assert.match(src, /<\$\{Sprite\} k="statistics\/strategyBadge" class="dband__badge-web"/, 'the stats page\'s sprite without the local art');
  assert.doesNotMatch(src, /\$\{wins \? html`<span class="dband__medal"/, 'no badge after one win');
  // the detail pane's count stays every win, on the plate of the badge
  assert.match(src, /<\$\{BandMedal\} n=\$\{local\.won\[shownBand\.bandId\] \|\| 0\} tier=\$\{badgeTier\(local, shownBand\.bandId\)\} \/>/);
  assert.match(src, /\$\{t\('已通过模拟\{n\}次', \{ n \}\)\}/);
  // not parsed while the screen mounts (the stats store can be large): an idle callback after it is up
  assert.match(src, /const \[local, setLocal\] = useState\(NO_RECORDS\);/);
  assert.match(src, /setLocal\(draftRecords\(peekStatsRecords\(\), data\.get\('bands'\)\)\)/);
  assert.ok(JSON.parse(read('data/assets.json')).ui['statistics/strategyBadge'], 'the fallback sprite is in the asset list');
  const css = read('public/css/screens/draft.css');
  // the client's band item (140 px): team_list_victor_team 129×132 at (13.1, 11.5) from its centre, the master pair, the red mark
  assert.match(css, /\.dband__badge \{ position: absolute; left: 13\.3%; top: -5\.4%; width: 92\.1%; height: 94\.3%; z-index: 2; pointer-events: none; \}/);
  assert.match(css, /\.dband__master-bg \{ position: absolute; left: 8\.9%; top: 7\.9%; width: 82\.1%; height: 84\.3%;/);
  assert.match(css, /\.dband__master-icon \{ position: absolute; left: 60\.1%; top: -4\.9%; width: 45%; height: 45\.7%;/);
  assert.match(css, /\.dband__off \{ position: absolute; left: 8\.1%; top: 7\.1%; z-index: 3; width: max\(27\.1%, 14px\); aspect-ratio: 1;/);
  // the PR's dead rules are gone
  assert.doesNotMatch(css, /\.acct-tag|\.dorder__n \{|\.draft-order__info/);
});
