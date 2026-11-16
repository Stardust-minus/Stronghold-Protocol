// The strategy draft's search box (the owner, 2026-11-16: 「再加一个搜索框，可以输入搜索对应策略」): ui/bandSearch.js matches
// names, effect names and bonds — in Chinese also their pinyin initials —, every term; the descriptions only when no
// strategy matched by name. screens/bandDraft.js hides what a search does not find, keeping the wall's size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinyinInitial, pinyinInitials, foldSearch, bandSearchIndex, searchBands } from '../../public/js/ui/bandSearch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const REG = 'data/versions/act3autochess-v3_1/';
const BANDS = Object.values(JSON.parse(read(`${REG}bands.json`)));
const BONDS = JSON.parse(read(`${REG}bonds.json`));
const INDEX = bandSearchIndex(BANDS, (id) => BONDS[id]?.name);
const names = (q) => { const r = searchBands(INDEX, q); return r && { names: [...r.ids].map((id) => BANDS.find((b) => b.bandId === id).name), byDesc: r.byDesc }; };

test('pinyin initials from the zh collation: every strategy and bond name of 规程 as players type them', () => {
  assert.equal(pinyinInitial('阿'), 'a');
  assert.equal(pinyinInitial('帀'), 'z');
  assert.equal(pinyinInitial('A'), '', 'only CJK');
  assert.equal(pinyinInitials('阿米娅'), 'amy');
  assert.equal(pinyinInitials('伊奥莱塔·罗素'), 'yaltls');
  assert.equal(pinyinInitials('“变形者集群”'), 'bxzjq');
  assert.equal(pinyinInitials('铃兰'), 'll', 'the collation\'s M boundary is 妈 (痳 reads lín)');
  assert.equal(pinyinInitials('Touch'), 'touch');
  assert.equal(pinyinInitials('卡西米尔'), 'kxme');
  assert.equal(foldSearch(' 伊奥莱塔·罗素 '), '伊奥莱塔罗素');
  assert.equal(foldSearch('ＡＭＹ'), 'amy', 'full-width folded');
});

test('searchBands: names, effects, bonds and initials, every term; descriptions only when no name matches', () => {
  assert.equal(searchBands(INDEX, ''), null);
  assert.equal(searchBands(INDEX, '   '), null);
  assert.deepEqual(names('阿米'), { names: ['阿米娅'], byDesc: false });
  assert.deepEqual(names('amy'), { names: ['阿米娅'], byDesc: false });
  assert.deepEqual(names('klms'), { names: ['克莱门莎'], byDesc: false });
  assert.deepEqual(names('卡西米尔'), { names: ['焰尾', '玛恩纳'], byDesc: false }, 'the bond the strategy is built around');
  assert.deepEqual(names('kxme'), { names: ['焰尾', '玛恩纳'], byDesc: false });
  assert.deepEqual(names('重点监护'), { names: ['华法琳'], byDesc: false }, 'the effect\'s name');
  assert.deepEqual(names('hfl zdjh'), { names: ['华法琳'], byDesc: false }, 'every term');
  assert.deepEqual(names('伊奥莱塔罗素'), { names: ['伊奥莱塔·罗素'], byDesc: false }, 'punctuation folded away');
  assert.deepEqual(names('TOUCH'), { names: ['Touch'], byDesc: false });
  const equip = names('装备');
  assert.equal(equip.byDesc, true);
  assert.ok(equip.names.length >= 5 && equip.names.includes('Mechanist'), JSON.stringify(equip));
  assert.deepEqual(names('xyzq'), { names: [], byDesc: false });
});

test('the draft: the box in the header, hidden tiles and headers, Enter / Esc, a stable wall size', () => {
  const src = read('public/js/screens/bandDraft.js');
  assert.match(src, /<input type="search" class="draft-search__input" data-testid="band-search"/);
  assert.match(src, /hidden=\$\{found && !found\.ids\.has\(b\.bandId\) \? true : undefined\}/);
  assert.match(src, /if \(found && found\.ids\.size === 1\) pickTile\(\[\.\.\.found\.ids\]\[0\]\);/);
  assert.match(src, /bandSearchIndex\(bands, \(id\) => gd\.bond\(id\)\?\.name \|\| null, \{ pinyin: \/\^zh\/i\.test\(data\.locale\(\) \|\| 'zh'\) \}\)/);
  // in the step header's status, not a row of the wall; gone with the wall
  assert.match(src, /status=\$\{searchBox \? html`<div class="draft-headbar">\$\{searchBox\}\$\{head\}<\/div>` : head\}/);
  assert.match(src, /const searchBox = view === 'done' \|\| held \? null :/);
  // the fit counts the hidden tiles too: its deps do not change with the query
  assert.match(src, /useFitBox\(gridRef, \(el\) => fitTileBox\(el, shortScreen\(\) \? DRAFT_TILE_REM_SHORT : DRAFT_TILE_REM\), \[view === 'done', bands\.length\]\);/);
  const css = read('public/css/screens/draft.css');
  assert.match(css, /\.dband\[hidden\], \.draft-grid__sec\[hidden\] \{ display: none; \}/);
  assert.match(css, /:is\(\.sp-touch, \.sp-coarse\) \.draft-search__input \{ font-size: 16px; \}/, 'no iOS zoom on focus');
});
