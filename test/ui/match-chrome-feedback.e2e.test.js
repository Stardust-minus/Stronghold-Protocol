// SP_E2E=1 CHROME_PATH=/usr/bin/google-chrome node --test test/ui/match-chrome-feedback.e2e.test.js
// The real Game screen on the mock server: feedback #60 (本局信息 closes on an outside press), #100 (a picked 头像 stays on
// the team panel in the match, the strategy moves to the row's tooltip), #65 (the draft shows this match's battlefield) and
// #66 (an experimental room's draft groups the doctors by chess pool); #90 (the shop card's portrait carries the card).
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

  const load = async (query) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(`${base}/dev/game-mock.html?${query}&render=fallback&shot=1`, { waitUntil: 'networkidle2' });
    return page;
  };
  const open = async () => {
    const page = await load('phase=PREP');
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

  test('#60 the bond popup (预计叠层) closes on an outside press too (#792)', async () => {
    const page = await open();
    try {
      await page.click('.bslot');
      await page.waitForSelector('.bpop');
      await page.mouse.click(1000, 300);
      await page.waitForFunction(() => !document.querySelector('.bpop'));
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

  test('#90 a shop card shows the portrait zoomed and keeps the text to the lower part', async () => {
    const page = await open();
    try {
      await page.waitForSelector('.scard__art');
      const cards = await page.$$eval('.scard:not(.scard--sold):not(.scard--item)', (els) => els.map((el) => {
        const box = el.getBoundingClientRect(), art = el.querySelector('.scard__art').getBoundingClientRect(), body = el.querySelector('.scard__body').getBoundingClientRect();
        return { zoom: art.height / box.height, text: (box.bottom - body.top) / box.height };
      }));
      assert.ok(cards.length >= 3);
      for (const c of cards) {
        assert.ok(c.zoom > 1.2, `zoom ${c.zoom}`);
        assert.ok(c.text < 0.6, `text band ${c.text}`);
      }
    } finally { await page.close(); }
  });

  test('#65 the strategy draft shows this match\'s battlefield: its name, the mode\'s pool and the tile map', async () => {
    const page = await load('phase=BAND_DRAFT');
    try {
      await page.waitForSelector('[data-testid="draft-map"]');
      const info = await page.$eval('[data-testid="draft-map"]', (el) => ({ name: el.querySelector('b').textContent, pool: el.querySelector('small')?.textContent || '',
        gates: el.querySelectorAll('.stagemap__t--gate').length, goals: el.querySelectorAll('.stagemap__t--goal').length, w: el.querySelector('svg').getBoundingClientRect().width }));
      assert.match(info.name, /战场#05/);
      assert.match(info.pool, /战场随机/);
      assert.ok(info.gates >= 1 && info.goals >= 1, JSON.stringify(info));
      assert.ok(info.w > 60 && info.w < 400, JSON.stringify(info));
    } finally { await page.close(); }
  });

  test('#66 an experimental room\'s draft groups the doctors by pool and marks the own one; a standard room has no pools', async () => {
    const page = await load('phase=BAND_DRAFT&variant=players20');
    try {
      await page.waitForSelector('[data-testid="draft-pool"]');
      const pools = await page.$$eval('[data-testid="draft-pool"]', (els) => els.map((el) => ({ head: el.querySelector('.draft-pool__head').textContent,
        rows: el.querySelectorAll('.dorder').length, mine: el.classList.contains('is-mine') })));
      assert.equal(pools.length, 5, JSON.stringify(pools));
      assert.equal(pools.reduce((n, p) => n + p.rows, 0), 20);
      assert.equal(pools.filter((p) => p.mine).length, 1);
      assert.match(pools.find((p) => p.mine).head, /你的卡池/);
      const overflow = await page.$eval('.draft-order__rows', (el) => el.scrollWidth - el.clientWidth);
      assert.ok(overflow <= 1, `no sideways scroll: ${overflow}`);
    } finally { await page.close(); }
    const std = await load('phase=BAND_DRAFT');
    try {
      await std.waitForSelector('.dorder');
      assert.equal(await std.$('[data-testid="draft-pool"]'), null);
    } finally { await std.close(); }
  });
});
