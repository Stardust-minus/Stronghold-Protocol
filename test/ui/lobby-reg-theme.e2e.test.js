// The 规程 theme of the 大厅背景 dialog in a real browser (the owner, 2026-11-15, at the 0.4.0 merge; ui/hubBackdrop.js
// REGULATION_THEME, css/screens/lobby.css `[data-look="regulation"]`): the default stays this fork's green look; picking
// 规程 turns the lobby, 选择模拟协议 and the room red (upstream's season ground, its tokens, the cream start plate) in
// every version, the choice survives a reload, a 盟约 lobby keeps its own words in the red brackets, and the dialog,
// the hub and 选择模拟协议 stay inside a phone's 844×390.
// SP_E2E=1 CHROME_PATH=… node --test test/ui/lobby-reg-theme.e2e.test.js
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { skipEntryFilm } from '../helpers/entryFilm.js';
import { DEFAULT_VERSION } from '../../shared/versions.js';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('大厅背景 → 规程 (real server, headless Chrome)', { skip: !ENABLED && 'set SP_E2E=1 and have Chrome to run' }, () => {
  let srv, browser, base;
  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    // a stock server: the lobby opens on 规程 (upstream 0.4.0's default, kept)
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--no-first-run', '--mute-audio'] });
  });
  after(async () => {
    const proc = browser?.process();
    try { await browser?.close(); } finally {
      for (const stream of [proc?.stdout, proc?.stderr]) stream?.destroy();
      await srv?.close();
    }
  });

  async function lobby({ w = 1600, h = 900, touch = false, prefs = {} } = {}) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: w, height: h, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await skipEntryFilm(page);
    await page.evaluateOnNewDocument((p) => {
      if (window.top !== window || !/^https?:$/.test(location.protocol)) return;
      localStorage.setItem('sp.name', '主题测试');
      for (const [k, v] of Object.entries(p)) if (localStorage.getItem(`sp.pref.${k}`) == null) localStorage.setItem(`sp.pref.${k}`, JSON.stringify(v));
    }, prefs);
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await ready(page);
    return { ctx, page, errors };
  }
  async function ready(page) {
    await page.waitForFunction(() => globalThis.__SP__?.store.get().connection.status === 'online' && !!document.querySelector('.lobby-hub .hub-entries'), { timeout: 30000 });
    // the 公告板 opens by itself on a fresh profile while a notice is unread
    if (await page.waitForSelector('.announcement-board', { visible: true, timeout: 3000 }).catch(() => null)) {
      await page.click('.announcement-board .modal__actions button');
      await page.waitForSelector('.announcement-board', { hidden: true, timeout: 5000 });
    }
  }
  const look = (page) => page.evaluate(() => {
    const hub = document.querySelector('.lobby-hub');
    const cs = getComputedStyle(hub);
    return {
      look: hub.getAttribute('data-look'), theme: hub.getAttribute('data-hub-theme'), season: hub.getAttribute('data-season'),
      mint: cs.getPropertyValue('--mint-500').trim(), ground: !!document.querySelector('.hub-bg .hub-reg'),
      title: document.querySelector('.hub-center h1')?.textContent.trim() || '',
      word: document.querySelector('.hub-reg__word, .hub-reg__wordtext')?.textContent || (document.querySelector('.hub-reg__word') ? 'img' : ''),
      en: document.querySelector('.hub-center__en')?.textContent.trim() || '',
    };
  });
  const inView = (page, sel) => page.$$eval(sel, (els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    return { sel: el.className, ok: r.width > 0 && r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 };
  }));

  test('default green; 规程 turns the lobby, 选择模拟协议 and the room red and is remembered', { timeout: 120000 }, async () => {
    const { ctx, page, errors } = await lobby();
    try {
      const before = await look(page);
      assert.equal(before.look, null, 'no 规程 look by default');
      assert.equal(before.theme, 'night');
      assert.equal(before.ground, false);
      assert.equal(before.season, 'act3autochess', 'the lobby version is 规程 (stock server)');
      // the dialog: the five old choices, 规程 between 静默 and 自定义背景
      await page.click('.hub-bg-btn');
      await page.waitForSelector('.hub-dialog [data-testid="bg-theme-regulation"]', { visible: true, timeout: 5000 });
      const names = await page.$$eval('.hub-dialog .bgset__theme .bgset__name', (els) => els.map((e) => e.textContent));
      assert.deepEqual(names, ['夜巡', '霜原', '烬野', '静默', '规程', '自定义背景']);
      await page.click('[data-testid="bg-theme-regulation"]');
      await page.waitForSelector('.lobby-hub[data-look="regulation"]', { timeout: 5000 });
      assert.equal(await page.$eval('[data-testid="bg-theme-regulation"]', (el) => el.getAttribute('aria-checked')), 'true');
      assert.match(await page.$eval('[data-testid="bg-reg-note"]', (el) => el.textContent), /所有版本都生效/);
      const on = await look(page);
      assert.equal(on.theme, 'regulation');
      assert.equal(on.ground, true, 'upstream\'s season ground (ui/regulationBackdrop.js)');
      assert.equal(on.mint.toLowerCase(), '#e2412c', 'the mint tokens turn the season\'s red');
      assert.match(on.title, /卫戍协议·规程/);
      assert.ok(on.word, 'the РЕГЛАМЕНТ wordmark (art or text)');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.hub-dialog', { hidden: true, timeout: 5000 });
      // remembered like the other choices (hub.backdrop)
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sp.pref.hub.backdrop')).theme), 'regulation');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await ready(page);
      assert.equal((await look(page)).look, 'regulation', 'kept after a reload');
      // 选择模拟协议: the red ground and the cream start plate of the season's banners
      await page.click('.hub-entry[data-mode="solo"]');
      await page.waitForSelector('.lobby-hub[data-look="regulation"] .proto .proto-start', { visible: true, timeout: 10000 });
      const proto = await page.evaluate(() => ({
        start: getComputedStyle(document.querySelector('.proto .proto-start')).backgroundImage,
        bg: getComputedStyle(document.querySelector('.proto .proto__bg')).backgroundImage,
      }));
      assert.match(proto.start, /rgb\(239, 230, 204\)/, 'the cream plate');
      assert.match(proto.bg, /rgb\(42, 15, 11\)/, 'the season\'s red ground');
      // the room: data-look, the cream go plate
      await sleep(600); // the dialog's entrance
      await page.click('.proto .proto-start');
      await page.waitForSelector('.rs[data-look="regulation"] .rs-go', { visible: true, timeout: 20000 });
      const room = await page.evaluate(() => ({
        go: getComputedStyle(document.querySelector('.rs .rs-go')).backgroundImage,
        bg: getComputedStyle(document.querySelector('.rs .rs__bg')).backgroundImage,
        mint: getComputedStyle(document.querySelector('.rs')).getPropertyValue('--mint-500').trim(),
      }));
      assert.match(room.go, /rgb\(239, 230, 204\)|rgb\(255, 138, 109\)/, 'the cream plate (red once ready)');
      assert.match(room.bg, /rgb\(44, 15, 11\)/, 'the season\'s dark red ground');
      assert.equal(room.mint.toLowerCase(), '#e2412c');
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('a 盟约 lobby with the theme: the red look, its own words in the brackets; the default room stays green', { timeout: 90000 }, async () => {
    const { ctx, page, errors } = await lobby({ prefs: { 'lobby.version': DEFAULT_VERSION, 'hub.backdrop': { theme: 'regulation' } } });
    try {
      const l = await look(page);
      assert.equal(l.look, 'regulation', 'in every version');
      assert.notEqual(l.season, 'act3autochess');
      assert.match(l.title, /^\[\s*卫戍协议：盟约\s*\]$/);
      assert.match(l.en, /ALLIANCE/);
      assert.equal(await page.$('.hub-reg__word, .hub-reg__wordtext'), null, 'no РЕГЛАМЕНТ outside 规程');
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
    const plain = await lobby();
    try {
      await plain.page.click('.hub-entry[data-mode="solo"]');
      await plain.page.waitForSelector('.proto .proto-start', { visible: true, timeout: 10000 });
      await sleep(600);
      await plain.page.click('.proto .proto-start');
      await plain.page.waitForSelector('.rs .rs-go', { visible: true, timeout: 20000 });
      assert.equal(await plain.page.$('.rs[data-look]'), null, 'the default room keeps the green look');
    } finally { await plain.ctx.close(); }
  });

  test('phone 844×390: the dialog, the red hub and 选择模拟协议 stay inside the screen', { timeout: 90000 }, async () => {
    const { ctx, page, errors } = await lobby({ w: 844, h: 390, touch: true, prefs: { 'hub.backdrop': { theme: 'regulation' } } });
    try {
      assert.equal((await look(page)).look, 'regulation');
      for (const r of await inView(page, '.hub-center h1, .hub-entry, .hub-bg-btn')) assert.ok(r.ok, `${r.sel} inside 844×390`);
      await page.tap('.hub-bg-btn');
      await page.waitForSelector('.hub-dialog [data-testid="bg-theme-regulation"]', { visible: true, timeout: 5000 });
      for (const r of await inView(page, '.hub-dialog__box')) assert.ok(r.ok, 'the dialog inside the screen');
      // the body scrolls when it must: the 规程 choice can be brought into view and is tappable
      await page.$eval('[data-testid="bg-theme-regulation"]', (el) => el.scrollIntoView({ block: 'nearest' }));
      for (const r of await inView(page, '[data-testid="bg-theme-regulation"]')) assert.ok(r.ok, 'the 规程 swatch in view');
      await page.tap('.hub-dialog .mm-modal__close');
      await page.waitForSelector('.hub-dialog', { hidden: true, timeout: 5000 });
      await page.tap('.hub-entry[data-mode="solo"]');
      await page.waitForSelector('.proto .proto-start', { visible: true, timeout: 10000 });
      await sleep(600);
      for (const r of await inView(page, '.proto .proto-start')) assert.ok(r.ok, 'the start plate inside 844×390');
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });
});
