// The entry film by default and the lobby's only automatic popup, in a real browser (the owner, 2026-11-15, at the
// 0.4.0 merge; public/js/main.js wantsEntryFilm, ui/entryFilm.js, screens/lobby.js useEntryFilmOver):
//   * a page under automation (navigator.webdriver) gets no film unless it asks with ?film=on, and the 公告板 opens by
//     itself as before — no upstream 更新说明 popup (#603), no 更新说明 in the footer;
//   * a player's page (navigator.webdriver false) shows the black 点击进入 card first on every load; ?film=off and
//     localStorage sp.entryFilm=off opt out;
//   * with the film up, the 公告板 waits: it opens only once the overlay is gone. A 规程 start without 规程's extracted
//     opening plays 盟约's film (this checkout's art has no local-client season entry).
// The film needs the art pack (public/assets): without it no sprite loads and no film plays, so those steps skip.
// SP_E2E=1 CHROME_PATH=… node --test test/ui/entry-film-default.e2e.test.js
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { passEntryFilm } from '../e2e/client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const ART = existsSync(path.join(ROOT, 'public/assets/ui'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('entry film by default, the 公告板 after it (real server, headless Chrome)', { skip: !ENABLED && 'set SP_E2E=1 and have Chrome to run' }, () => {
  let srv, browser, base;
  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
      args: ['--no-sandbox', '--no-first-run', '--mute-audio', '--disable-background-timer-throttling'] });
  });
  after(async () => {
    const proc = browser?.process();
    try { await browser?.close(); } finally {
      for (const stream of [proc?.stdout, proc?.stderr]) stream?.destroy();
      await srv?.close();
    }
  });

  /** A fresh profile (an unread notice on the board); `player`: navigator.webdriver false, as a player's browser. */
  async function open({ query = '', player = false, stored = null } = {}) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.evaluateOnNewDocument((player, stored) => {
      if (player) Object.defineProperty(Navigator.prototype, 'webdriver', { configurable: true, get: () => false });
      if (window.top !== window || !/^https?:$/.test(location.protocol)) return;
      localStorage.setItem('sp.name', '入场测试');
      if (stored) localStorage.setItem('sp.entryFilm', stored);
    }, player, stored);
    await page.goto(`${base}/${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!globalThis.__SP__ && !!document.querySelector('.screen'), { timeout: 30000 });
    return { ctx, page, errors };
  }
  /** Whether a film came up this load (`__SP__.entryFilm` settles once it has decided). */
  const filmUp = (page) => page.evaluate(async () => {
    await Promise.race([globalThis.__SP__?.entryFilm, new Promise((r) => setTimeout(r, 15000))]);
    return !!document.querySelector('.spa-entry');
  });
  const hasNotice = (page) => page.evaluate(async () => {
    const { data } = globalThis.__SP__;
    try { await data.load('announcements'); } catch { return false; }
    const list = data.get('announcements');
    return Array.isArray(list) ? list.length > 0 : !!list;
  });

  test('automation: no film unless ?film=on; the 公告板 opens by itself, no 更新说明 anywhere', { timeout: 90000 }, async () => {
    const { ctx, page, errors } = await open();
    try {
      assert.equal(await filmUp(page), false, 'navigator.webdriver: no film by default');
      await page.waitForSelector('.lobby-hub .hub-foot', { timeout: 30000 });
      if (await hasNotice(page)) await page.waitForSelector('.announcement-board', { visible: true, timeout: 15000 });
      await sleep(1500);
      assert.equal(await page.$('.release-notes'), null, 'no release-notes popup');
      assert.equal(await page.$('.release-notes-entry'), null, 'no 更新说明 in the footer');
      assert.doesNotMatch(await page.$eval('.hub-foot', (el) => el.textContent), /更新说明/);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  test('a player\'s page: the 点击进入 card by default; ?film=off and sp.entryFilm=off opt out', { timeout: 120000, skip: !ART && 'needs the art pack (public/assets)' }, async () => {
    // the film's short look (1.2 s for its sprites) may let a cold first load pass: the next load has them cached
    let shown = false;
    for (let i = 0; i < 3 && !shown; i++) {
      const { ctx, page } = await open({ player: true });
      shown = await filmUp(page) && !!(await page.$('.spa-entry__gate'));
      if (shown) assert.match(await page.$eval('.spa-entry__gate', (el) => el.textContent), /点击进入/);
      await ctx.close();
    }
    assert.ok(shown, 'the black 点击进入 card on a player\'s page load');
    for (const o of [{ player: true, query: '?film=off' }, { player: true, stored: 'off' }]) {
      const { ctx, page } = await open(o);
      assert.equal(await filmUp(page), false, `no film with ${JSON.stringify(o)}`);
      await ctx.close();
    }
  });

  test('?film=on under automation: the card, then 盟约\'s film (no 规程 opening here); the 公告板 only after it', { timeout: 120000, skip: !ART && 'needs the art pack (public/assets)' }, async () => {
    let run = null;
    for (let i = 0; i < 3 && !run; i++) {
      const o = await open({ query: '?film=on' });
      if (await filmUp(o.page)) run = o; else await o.ctx.close();
    }
    assert.ok(run, 'the film comes up with ?film=on');
    const { ctx, page, errors } = run;
    try {
      // a 规程 start (the stock server's default) without 规程's extracted opening plays 盟约's film
      assert.equal(await page.$eval('.spa-entry', (el) => el.getAttribute('aria-label')), '卫戍协议 · 盟约');
      const notice = await hasNotice(page);
      await sleep(2500);
      assert.equal(await page.$('.announcement-board'), null, 'the 公告板 waits while the card is up');
      assert.equal(await passEntryFilm(page), true, 'tapped through and skipped');
      if (notice) await page.waitForSelector('.announcement-board', { visible: true, timeout: 15000 });
      assert.equal(await page.$('.spa-entry'), null);
      assert.equal(await page.$('.release-notes'), null);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });
});
