// No scrolling on the pre-game screens (the owner, 2026-11-05: 「另外需要优化进入阶段，选择策略阶段的UI大小，尽量不用滚动」):
// ui/fitGrid.js sizes the strategy wall's portraits and the draft order's rows to the space they have (screens/bandDraft.js,
// css/screens/draft.css --dcols / --dtile / --drh), and the briefing lays its sections out in two columns between the header
// and the foot, the dock (重刷本局 / 自选上场) in the foot's own row (screens/briefing.js, css/screens/briefing.css).
// The browser measurements: /root/projects/rel34-20261105/fit-measure.mjs (stardust), screenshots fit-shots/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitTiles, fitRowHeight } from '../../public/js/ui/fitGrid.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const { DRAFT_TILE_REM, DRAFT_ROW_REM } = await import('../../public/js/screens/bandDraft.js');

// a fit is valid when every tile is in the box
function inBox({ cols, tile }, count, w, h, gx, gy) {
  const rows = Math.ceil(count / cols);
  return cols * tile + (cols - 1) * gx <= w + 0.01 && rows * tile + (rows - 1) * gy <= h + 0.01;
}

test('fitTiles: the 40 strategies of a co-op wall all in view at 1080p (16:9 and with browser chrome) and on a phone', () => {
  const rem = (r, px) => r * px;
  // 1920×937 (1rem 86.8 px): the wall's inner box about 12.45 × 8.5 rem, gaps .18 / .24 rem
  for (const [r, w, h] of [[86.8, 12.45, 8.5], [100, 9.5, 8.5], [40, 12.4, 7.4]]) {
    const W = rem(r, w), H = rem(r, h), gx = rem(r, 0.18), gy = rem(r, 0.24);
    const fit = fitTiles(40, W, H, gx, gy, rem(r, DRAFT_TILE_REM.min), rem(r, DRAFT_TILE_REM.max));
    assert.equal(fit.fits, true, `${w}×${h} rem`);
    assert.ok(inBox(fit, 40, W, H, gx, gy), JSON.stringify(fit));
    assert.ok(fit.tile > rem(r, 1), `a portrait over 1rem: ${fit.tile / r}`);
    // no other column count gives a larger tile
    for (let cols = 1; cols <= 40; cols++) {
      const rows = Math.ceil(40 / cols);
      const t = Math.min((W - (cols - 1) * gx) / cols, (H - (rows - 1) * gy) / rows);
      assert.ok(t <= fit.tile + 0.6, `${cols} columns: ${t} > ${fit.tile}`);
    }
  }
});

test('fitTiles: the design size caps a wall with room to spare; below the floor it keeps the floor and scrolls', () => {
  const big = fitTiles(6, 2000, 2000, 10, 10, 50, 190);
  assert.deepEqual([big.tile, big.fits], [190, true]);
  assert.ok(inBox(big, 6, 2000, 2000, 10, 10));
  const tiny = fitTiles(40, 300, 200, 10, 10, 90, 190);
  assert.deepEqual([tiny.tile, tiny.fits, tiny.cols], [90, false, 3]);
  assert.deepEqual(fitTiles(0, 300, 200, 10, 10, 90, 190), { cols: 4, tile: 190, fits: true }, 'nothing to place: the design');
  assert.equal(fitTiles(5, 0, 0, 10, 10, 90, 190).tile, 190, 'no box yet: the design');
});

test('fitRowHeight: rows share what the pool heads and gaps leave, within the design height and the three-line floor', () => {
  // four rows of 109 px with 42 px of gaps and paddings in a 470 px column → 107 px each
  assert.equal(fitRowHeight(4, 470, 4 * 109 + 42, 109, 83, 109), 107);
  assert.equal(fitRowHeight(2, 900, 2 * 109 + 20, 109, 83, 109), 109, 'never above the design');
  assert.equal(fitRowHeight(20, 470, 20 * 109 + 300, 109, 83, 109), 83, 'twenty seats: the floor (the list scrolls)');
  assert.equal(fitRowHeight(0, 470, 0, 109, 83, 109), 109);
  assert.deepEqual([DRAFT_ROW_REM.min, DRAFT_ROW_REM.max, DRAFT_TILE_REM.max], [0.96, 1.26, 1.9]);
});

test('the wiring: the wall and the rows read the fitted sizes, the design sizes as their fallbacks', () => {
  const css = read('public/css/screens/draft.css');
  assert.match(css, /\n\.draft-grid \{[^}]*grid-template-columns: repeat\(var\(--dcols, 4\), minmax\(0, var\(--dtile, 1\.9rem\)\)\);/);
  assert.match(css, /\.draft-grid\[data-fit="all"\] \{ align-content: center; \}/);
  assert.match(css, /\n\.dorder \{[^}]*height: var\(--drh, 1\.26rem\);/);
  assert.match(css, /\n\.draft-order__rows \{[^}]*overflow-y: auto/, 'past the floor the list scrolls');
  const js = read('public/js/screens/bandDraft.js');
  assert.match(js, /<section class="draft-grid" ref=\$\{gridRef\}/);
  assert.match(js, /<div class="draft-order__rows" ref=\$\{rowsRef\}>/);
  assert.match(js, /useFitBox\(gridRef, \(el\) => fitTileBox\(el, DRAFT_TILE_REM\)/);
});

test('the briefing: two columns that scroll on their own, never the page; the dock in the foot\'s row', () => {
  const css = read('public/css/screens/briefing.css');
  assert.match(css, /\n\.brief__main \{[^}]*display: grid; grid-template-columns: minmax\(7\.6rem, 8fr\) minmax\(0, 11fr\);/);
  assert.doesNotMatch(css.match(/\n\.brief__main \{[^}]*\}/)[0], /overflow/, 'the main area itself does not scroll');
  assert.match(css, /\n\.brief__col \{[^}]*overflow-y: auto;/);
  const js = read('public/js/screens/briefing.js');
  const enemy = js.indexOf('brief__col--enemy'), bonds = js.indexOf('brief__col--bonds');
  assert.ok(enemy > 0 && bonds > enemy);
  assert.ok(js.indexOf('brief-sec--core') > enemy && js.indexOf('brief-sec--core') < bonds, '核心盟约 under the enemies');
  assert.ok(js.indexOf('brief-sec--addon') > bonds && js.indexOf('brief-sec--banned') > bonds, '附加盟约 and 本局禁用干员 on the right');
  assert.ok(js.indexOf('<div class="brief__dock">') > js.indexOf('<footer class="brief__foot">'), 'the dock inside the foot');
});
