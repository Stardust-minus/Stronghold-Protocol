// SP_E2E=1 CHROME_PATH=/usr/bin/google-chrome node --test test/ui/match-chrome-feedback.e2e.test.js
// The real Game screen on the mock server: feedback #60 (本局信息 closes on an outside press) and #100 (a picked 头像 stays
// on the team panel in the match, the strategy moves to the row's tooltip).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);

describe('match chrome feedback', { skip: !ENABLED && 'set SP_E2E=1 with Chrome' }, () => {
  let srv, browser, base;
  before(async () => {
    const { startServer } = await import('../../server/index.js');
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${srv.port}`;
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--force-device-scale-factor=1'] });
  });
  after(async () => { await browser?.close(); await srv?.close(); });

  const open = async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(`${base}/dev/game-mock.html?phase=PREP&render=fallback&shot=1`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('[data-testid="check-player"]');
    return page;
  };
  const drawer = (page) => page.$('.edrawer');

  test('#60 本局信息 closes on a press outside it, stays on one inside it, and its 🔍 still toggles it', async () => {
    const page = await open();
    try {
      await page.click('[data-testid="check-player"]');
      await page.waitForSelector('.edrawer');
      await page.click('.edrawer .ihead');
      assert.ok(await drawer(page), 'a press inside keeps it');
      await page.mouse.click(1000, 300); // the field, right of the dialog
      await page.waitForFunction(() => !document.querySelector('.edrawer'));

      await page.click('[data-testid="check-player"]');
      await page.waitForSelector('.edrawer');
      await page.click('[data-testid="check-player"]');
      await page.waitForFunction(() => !document.querySelector('.edrawer'));
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(await drawer(page), null, 'the 🔍 closes it without reopening it');
    } finally { await page.close(); }
  });

  test('#100 a player with a picked 头像 keeps it on the team panel; one without shows the strategy; the tooltip names the strategy', async () => {
    const page = await open();
    try {
      await page.waitForSelector('.team__row');
      const rows = await page.$$eval('.team__row', (els) => els.map((el) => ({
        src: el.querySelector('.pavatar__img img')?.getAttribute('src') || '',
        title: el.querySelector('.team__btn')?.getAttribute('title') || '' })));
      assert.ok(rows.some((r) => /\/band\//.test(r.src) || /band/.test(r.src)), 'no picked 头像: the strategy icon');
      assert.ok(rows.some((r) => r.src && !/band/.test(r.src)), 'a picked 头像 stays on');
      assert.ok(rows.every((r) => r.title.includes(' · ')), `the strategy in the tooltip: ${rows.map((r) => r.title)}`);
    } finally { await page.close(); }
  });
});
