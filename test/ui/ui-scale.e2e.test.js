// Browser check of 设置 →「界面大小」 (opt-in, needs Chrome, ~40 s):
//   SP_E2E=1 CHROME_PATH=… node --test test/ui/ui-scale.e2e.test.js
//
// A 844×390 landscape phone in the dev mock's 休整期 (public/dev/game-mock.html): the layout root is clamped at 40 px and
// the shop cards sit on their pixel floors (80 × 112 px), so the shop bar's band leaves the board ~170 px. 界面大小 scales
// both (css/theme.css --ui): at the phone's default 80 % and at 70 % the bar is lower, the prep camera frames a larger
// board, and the bench still clears the bar (ui/fieldHost.js hudBands). A step picked in the match's settings re-frames
// the open board at once (the resize applyUiScale sends). The lobby and a desktop window keep their sizes. Static
// counterpart: test/ui/ui-scale.test.js. Screenshots: test/e2e/out/ui-scale-*.png.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'test/e2e/out');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const PHONE = { width: 844, height: 390, isMobile: true, hasTouch: true, isLandscape: true, deviceScaleFactor: 1 };
const DESKTOP = { width: 1366, height: 768, deviceScaleFactor: 1 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('界面大小 (headless Chrome)', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv;
  let browser;
  let base;

  before(async () => {
    mkdirSync(OUT, { recursive: true });
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--force-device-scale-factor=1', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  });

  after(async () => {
    await browser?.close();
    await srv?.close();
  });

  /** The mock's prep screen with `sp.pref.settings` seeded (uiScale null: a profile without the setting). */
  async function prep(viewport, uiScale, query = 'phase=PREP') {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.evaluateOnNewDocument((ui) => {
      try { localStorage.setItem('sp.pref.settings', JSON.stringify(ui ? { uiScale: ui } : {})); } catch { /* ignore */ }
    }, uiScale);
    await page.goto(`${base}/dev/game-mock.html?shot=1&${query}`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => !!document.querySelector('.screen:not(.gload)') && !!globalThis.__SP_VIEW__, { timeout: 20000 });
    await page.waitForFunction(() => {
      const bar = document.querySelector('.shopbar');
      return bar && getComputedStyle(bar).transform === 'none';
    }, { timeout: 10000 });
    await sleep(1200);
    return { page, problems };
  }

  /** Root, shop row and card, and the board as the prep camera frames it: bench (row 7) and back row (12) tiles. */
  const measure = (page) => page.evaluate(() => {
    const view = globalThis.__SP_VIEW__.raw;
    const rect = (sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom, width: r.width, height: r.height } : null; };
    const ys = (r, cols) => cols.map((c) => view.tileScreen(r, c)).filter(Boolean).flatMap((t) => t.poly.map((p) => p[1]));
    const bench = ys(7, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const back = ys(12, [4, 5, 6, 7, 8, 9, 10]);
    return {
      ui: getComputedStyle(document.documentElement).getPropertyValue('--ui').trim(),
      root: parseFloat(getComputedStyle(document.documentElement).fontSize),
      row: rect('.gm__hud .shopbar .shopbar__row'),
      card: rect('.gm__hud .shopbar .scard'),
      tile: view.tileScreen(7, 4)?.s ?? null,
      benchBottom: Math.max(...bench),
      boardTop: Math.min(...back),
      boardHeight: Math.max(...bench) - Math.min(...back),
    };
  });

  test('phone prep: 100 % / auto (80 %) / 70 % shrink the bar and grow the board; the bench stays clear of the bar', async () => {
    const shots = {};
    for (const [name, ui] of [['100', '100'], ['auto', null], ['70', '70']]) {
      const { page, problems } = await prep(PHONE, ui);
      shots[name] = { ...(await measure(page)), dataUi: await page.evaluate(() => document.documentElement.dataset.ui) };
      await page.screenshot({ path: path.join(OUT, `ui-scale-phone-${name}.png`) });
      assert.deepEqual(problems, [], name);
      await page.close();
    }
    const [full, auto, small] = [shots['100'], shots.auto, shots['70']];
    assert.equal(auto.dataUi, 'auto', 'a profile without the setting gets auto');
    assert.equal(full.root, 40, '100 %: the clamped 40 px root, as before');
    assert.equal(auto.root, 32, 'auto on a phone: 80 %');
    assert.equal(small.root, 28);
    assert.ok(Math.abs(full.card.width - 80) < 1 && Math.abs(full.card.height - 112) < 1, `100 %: the 80 × 112 px card floor (${full.card.width} × ${full.card.height})`);
    assert.ok(Math.abs(auto.card.width - 64) < 1 && Math.abs(auto.card.height - 89.6) < 1, `80 %: the floor scales (${auto.card.width} × ${auto.card.height})`);
    assert.ok(auto.row.top > full.row.top + 15 && small.row.top > auto.row.top + 5, `the bar's top moves down (${full.row.top} → ${auto.row.top} → ${small.row.top})`);
    assert.ok(auto.boardHeight > full.boardHeight * 1.15, `80 %: a taller board (${full.boardHeight.toFixed(0)} → ${auto.boardHeight.toFixed(0)} px)`);
    assert.ok(small.boardHeight > auto.boardHeight, `70 %: taller still (${small.boardHeight.toFixed(0)} px)`);
    for (const [name, m] of Object.entries(shots)) {
      assert.ok(m.benchBottom <= m.row.top + 1, `${name}: the bench (${m.benchBottom.toFixed(1)}) ends above the bar (${m.row.top.toFixed(1)})`);
    }
  });

  test('a step picked in the match settings re-frames the open board at once', async () => {
    const { page, problems } = await prep(PHONE, '100', 'phase=PREP&variant=settings');
    await page.waitForSelector('[data-testid="set-tab-display"]', { timeout: 5000 }); // 界面大小 is on the 画面 page (the paged 设置, 2026-11-16)
    await page.click('[data-testid="set-tab-display"]');
    await page.waitForSelector('[data-testid="ui-scale"]', { timeout: 5000 });
    const before = await measure(page);
    assert.equal(await page.$eval('[data-testid="ui-scale"] button.is-on', (b) => b.textContent.trim()), '100%');
    await page.screenshot({ path: path.join(OUT, 'ui-scale-settings-100.png') });
    await page.evaluate(() => [...document.querySelectorAll('[data-testid="ui-scale"] button')].find((b) => b.textContent.trim() === '70%').click());
    await sleep(800);
    const after = await measure(page);
    assert.equal(await page.$eval('[data-testid="ui-scale"] button.is-on', (b) => b.textContent.trim()), '70%');
    assert.equal(after.root, 28);
    assert.ok(after.tile > before.tile * 1.1, `the board grows without a reload (${before.tile} → ${after.tile} px per tile)`);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sp.pref.settings')).uiScale), '70', 'saved');
    // the modal's rows fit at the smallest step
    const overflow = await page.evaluate(() => { const b = document.querySelector('.modal__body'); return b.scrollWidth - b.clientWidth; });
    assert.ok(overflow <= 1, `no sideways overflow in the settings (${overflow} px)`);
    await page.screenshot({ path: path.join(OUT, 'ui-scale-settings-70.png') });
    assert.deepEqual(problems, []);
    await page.close();
  });

  test('outside a match and on a desktop window nothing moves', async () => {
    const desk = await prep(DESKTOP, null);
    const m = await measure(desk.page);
    assert.equal(m.ui, '1', 'auto is 100 % on a desktop window');
    assert.ok(Math.abs(m.root - 768 / 10.8) < 0.1, `the desktop root (${m.root})`);
    await desk.page.screenshot({ path: path.join(OUT, 'ui-scale-desktop-auto.png') });
    assert.deepEqual(desk.problems, []);
    await desk.page.close();
    const page = await browser.newPage();
    await page.setViewport(PHONE);
    await page.evaluateOnNewDocument(() => { try { localStorage.setItem('sp.pref.settings', JSON.stringify({ uiScale: '70' })); } catch { /* ignore */ } });
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !!document.querySelector('.screen'), { timeout: 30000 });
    await sleep(500);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.ui), '70');
    assert.equal(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize)), 40, 'the title / lobby keep the 40 px root');
    await page.close();
  });
});
