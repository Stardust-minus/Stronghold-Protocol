// A doctor's name in the strategy draft's order, whole (the owner, 2026-11-16: 「不要出现省略号」 — 「Doctor…」 once a strategy's
// detail narrowed the list): the client's best fit (prefab_auto_chess_band_choose_player_card_item text_name: BestFit from 18
// down, one line) to a readable floor, then wrapped (ui/fitGrid.js fitNameScale / fitNameBox, screens/bandDraft.js OrderRow,
// css/screens/draft.css). The browser measurements: $W/UI2/HUD/bin-band/shot.mjs (stardust), every row's name uncut at
// 1920 / 1366 / 2560 / 2560×1080 / 800×360 / 844×390 in Chinese, English, Japanese and Korean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitNameScale, fitBandNameScale, NAME_FIT } from '../../public/js/ui/fitGrid.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} ≠ ${b}`);

test('fitNameScale: a name that fits keeps its size; one a little too long shrinks on its line, a pixel to spare', () => {
  assert.deepEqual(fitNameScale({ room: 128, need: 92, base: 21 }), { scale: 1, wrap: false });
  assert.deepEqual(fitNameScale({ room: 128, need: 128, base: 21 }), { scale: 1, wrap: false });
  // the widths are rounded: half a pixel over is no overflow (a short name kept its size, not 98 % of it)
  assert.deepEqual(fitNameScale({ room: 72, need: 72.4, base: 24 }), { scale: 1, wrap: false });
  // 「Doctor·B」 in the detail-narrowed list at 1920×1080: 21 px in 92 px of room, about 100 px wide
  const s = fitNameScale({ room: 92, need: 100, base: 21 });
  near(s.scale, 91 / 100, 'scale');
  assert.equal(s.wrap, false);
});

test('fitNameScale: the readable floor — 72 % or 11 px, never above the size; past it the name wraps at the floor', () => {
  assert.equal(NAME_FIT.k, 0.72);
  assert.equal(NAME_FIT.floorPx, 11);
  // a phone's short row: the whole column into the card with the name up to 15 % under its floor, never under 8 px
  assert.equal(NAME_FIT.squeeze, 0.85);
  assert.equal(NAME_FIT.minPx, 8);
  // 1920: 21 px → 15.12 px at most smaller
  near(fitNameScale({ room: 92, need: 125, base: 21 }).scale, 91 / 125, '1920 at 73 %');
  assert.deepEqual(fitNameScale({ room: 92, need: 300, base: 21 }), { scale: 0.72, wrap: true });
  // 1366: 14.93 px → 11 px (72 % would be 10.75)
  const r = fitNameScale({ room: 65, need: 200, base: 14.93 });
  assert.equal(r.wrap, true);
  near(r.scale * 14.93, 11, '1366 floor');
  // a phone at 文字大小 小: 8.4 px is its own size — no smaller on one line, it wraps
  assert.deepEqual(fitNameScale({ room: 55, need: 70, base: 8.4 }), { scale: 1, wrap: true });
});

test('fitNameScale: the 服主 tag beside the owner\'s name keeps its size; only the name shrinks', () => {
  // the name 80 px and its tag 30 px in 100 px: the name gets 69
  const s = fitNameScale({ room: 100, need: 110, own: 80, base: 20 });
  near(s.scale, 69 / 80, 'owner');
  assert.equal(s.wrap, false);
});

test('the order row measures its name and the stylesheet never cuts it', () => {
  const draft = read('public/js/screens/bandDraft.js');
  assert.match(draft, /useFitBox\(textRef, fitNameBox, \[shown, /);
  assert.match(draft, /<div class="dorder__text" ref=\$\{textRef\}>/);
  // the column is as wide as the card leaves it: the room of the fit, not the name's own width
  assert.match(read('public/css/screens/draft.css'), /\n\.dorder__text \{ position: relative; flex: 1 1 auto;/);
  assert.match(draft, /<span class="dorder__nm"><\$\{MatchName\} player=\$\{p\} name=\$\{p\.name \|\| t\('博士'\)\} \/><\/span>/);
  const css = read('public/css/screens/draft.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = css.match(/[^{}]*\.dorder__(?:name|nm)[^{}]*\{[^}]*\}/g) || [];
  assert.ok(rules.length >= 6, 'the name rules');
  for (const rule of rules) assert.doesNotMatch(rule, /ellipsis|line-clamp|overflow: hidden/, `no cut on a doctor's name: ${rule.trim().slice(0, 70)}`);
  // unmeasured it wraps at its size; measured on one line it shrinks by --nk; the owner's line gives up its ellipsis
  assert.match(css, /\n\.dorder__name \{ display: block;[^}]*overflow-wrap: anywhere; text-wrap: balance; \}/);
  assert.match(css, /\.dorder__nm \{ font-size: calc\(1em \* var\(--nk, 1\)\); \}/);
  // wrapped, the trophy shrinks with the name (at 特大 its 1.35em line alone took a phone row's third)
  assert.match(css, /\.dorder__name\[data-fit="wrap"\] > \.tbadge--inline \{ width: calc\(1\.35em \* var\(--nk, 1\)\);/);
  assert.match(css, /\.dorder__name:is\(\[data-fit="one"\], \[data-fit="measure"\]\) \{ display: flex;[^}]*white-space: nowrap; \}/);
  assert.match(css, /\.dorder__name\[data-fit="one"\] > \.dorder__nm \{ flex: 0 1 auto; min-width: 0; \}/);
  assert.match(css, /\.dorder__nm \.sp-owner-name \{ overflow: visible; text-overflow: clip; white-space: inherit; \}/);
  // a column too tall for its card even at 8 px (特大 on a phone) sits at the card's top: the card cuts the lines under the name
  assert.match(css, /\.dorder__text\[data-over\] \{ align-self: flex-start;/);
  assert.match(read('public/js/ui/fitGrid.js'), /el\.dataset\.over = '1';/);
  assert.match(css, /\.dorder__name:lang\(ja\) \{ line-break: strict; \}/);
  assert.match(css, /\.dorder__name:lang\(ko\) \{ word-break: keep-all; \}/);
});

// A strategy's name on its tile (the owner, 2026-11-16: Korean names broke inside a word on a phone, 「에르망가|르드」; the
// whole name, no ellipsis): the same best fit — one line shrunk to the floor —, past it wrapped at the floor between words;
// a word breaks inside only when it alone is wider than the tile at the floor. The browser check: mock.e2e 「选择策略 on
// 640×360 / 667×375 phones」 (test/e2e/text-fit.mjs wordWider).
test('fitBandNameScale: one line shrunk to the floor, then wrapped between words; a word too wide goes a little under it, then breaks', () => {
  // 1920 (a 122 px name box, 21.2 px, .06em paddings): a name that fits keeps its size on one line
  assert.deepEqual(fitBandNameScale({ box: 122, pad: 2.5, line: 100, word: 100, base: 21.2 }), { scale: 1, mode: 'one' });
  // a little too long: shrunk on its line, a pixel to spare (its paddings shrink with it)
  const s = fitBandNameScale({ box: 122, pad: 2.5, line: 140, word: 70, base: 21.2 });
  near(s.scale, 121 / 142.5, 'one line');
  assert.equal(s.mode, 'one');
  // past the floor (72 % of 21.2 px): wrapped at the floor, words whole
  assert.deepEqual(fitBandNameScale({ box: 122, pad: 2.5, line: 200, word: 90, base: 21.2 }), { scale: 0.72, mode: 'wrap' });
  // 1366 (15.1 px): the floor is 11 px (72 % would be 10.9); a word wider than the box even there breaks
  const r = fitBandNameScale({ box: 87, pad: 1.8, line: 200, word: 60, base: 15.1 });
  near(r.scale * 15.1, 11, '1366 floor');
  assert.equal(r.mode, 'wrap');
  // a word wider than the box there goes on under the floor, whole (to 85 % of it, 9.4 px), as a doctor's wrapped name does;
  // wider even then, it breaks, at the floor
  const q = fitBandNameScale({ box: 87, pad: 1.8, line: 200, word: 130, base: 15.1 });
  near(q.scale, 88 / 131.8, 'under the floor');
  assert.equal(q.mode, 'wrap');
  const b = fitBandNameScale({ box: 87, pad: 1.8, line: 200, word: 150, base: 15.1 });
  near(b.scale * 15.1, 11, 'a break at the floor');
  assert.equal(b.mode, 'break');
  // a phone's 9 px tile (39 px box): 11 px is above its size, so it keeps 9 px — two short words wrap between them; a word a
  // pixel too wide runs into its padding rather than break; 「클레멘티아」 (41 px) goes under it, not under 8 px (8.56 px),
  // 「에르망가르드」 (50 px, 7 px would do) breaks at 9 px
  assert.deepEqual(fitBandNameScale({ box: 39, pad: 1.08, line: 60, word: 30, base: 9 }), { scale: 1, mode: 'wrap' });
  assert.deepEqual(fitBandNameScale({ box: 39, pad: 1.08, line: 60, word: 38.9, base: 9 }), { scale: 1, mode: 'wrap' });
  const k = fitBandNameScale({ box: 39, pad: 1.08, line: 41, word: 41, base: 9 });
  near(k.scale, 40 / 42.08, '클레멘티아');
  assert.equal(k.mode, 'wrap');
  near(fitBandNameScale({ box: 39, pad: 1.08, line: 60, word: 39, base: 9 }).scale, 40 / 40.08, 'a hair too wide');
  assert.deepEqual(fitBandNameScale({ box: 39, pad: 1.08, line: 50, word: 50, base: 9 }), { scale: 1, mode: 'break' });
  assert.deepEqual(fitBandNameScale({ box: 39, pad: 1.08, line: 44.5, word: 44.5, base: 9 }), { scale: 1, mode: 'break' }, 'under 8 px');
  // half a pixel into the padding is no overflow
  assert.deepEqual(fitBandNameScale({ box: 39, pad: 1.08, line: 38.4, base: 9 }), { scale: 1, mode: 'one' });
});

test('the wall fits its names after its tiles, again on a language, search, 已被选择, 文字大小 or font change; the stylesheet never cuts them', () => {
  const draft = read('public/js/screens/bandDraft.js');
  const tiles = draft.indexOf('useFitBox(gridRef, (el) => fitTileBox(');
  const names = draft.indexOf("useFitBox(gridRef, fitBandNames, [view === 'done', bands.length, nameKey, lang, query, takenKey, textSize], { fonts: true });");
  assert.ok(tiles > 0 && names > tiles, 'the names observed after the tiles');
  assert.match(draft, /<span class="dband__name">\$\{b\.name\}<\/span>/);
  const css = read('public/css/screens/draft.css').replace(/\/\*[\s\S]*?\*\//g, '');
  // measured: the tile-sized font times --bk; one line, or wrapped with words whole; unmeasured it wraps as before
  assert.match(css, /\n\.dband__name\[data-fit\] \{ font-size: calc\(var\(--bk, 1\) \* max\(9px, calc\(var\(--dname-k, 1\) \* var\(--dtile, 1\.9rem\) \* \.145\)\)\); \}/);
  assert.match(css, /\.dband__name:is\(\[data-fit="one"\], \[data-fit="measure"\], \[data-fit="measure-line"\]\) \{ white-space: nowrap; \}/);
  assert.match(css, /\.dband__name:is\(\[data-fit="wrap"\], \[data-fit="measure-word"\]\) \{ overflow-wrap: normal; \}/);
  assert.match(css, /\.dband__name:lang\(ko\) \{ word-break: keep-all; \}/);
  // Japanese wrapped at the floor: between its words (at ・), kana breaks only for a word wider than the tile
  assert.match(css, /\.dband__name:lang\(ja\):is\(\[data-fit="wrap"\], \[data-fit="measure-word"\]\) \{ word-break: keep-all; \}/);
  const rules = css.match(/[^{}]*\.dband__name[^{}]*\{[^}]*\}/g) || [];
  for (const rule of rules) assert.doesNotMatch(rule, /ellipsis|line-clamp|overflow: hidden/, `no cut on a strategy's name: ${rule.trim().slice(0, 70)}`);
  assert.match(read('public/js/ui/fitGrid.js'), /fontSet\?\.addEventListener\?\.\('loadingdone', later\);/);
});

