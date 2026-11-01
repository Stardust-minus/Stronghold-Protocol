// Browser E2E of 同盟设置 and 手动指定卡池编组 (feedback #49), real server, headless Chrome. The host sets twelve seats on 同盟,
// opens 卡池, turns the groups on, changes the number of pools and moves seats by pressing, by keyboard and by dragging; a
// second doctor reads the same cards and sees where they sit; a match started from the room uses those pools. The dialog
// fits 1920×1080, 1280×720 and a phone on its side, twelve seats without scrolling at 720p.
//
//   SP_E2E=1 node --test test/ui/pool-editor.e2e.test.js
//
// Screenshots: test/e2e/out/pool-editor-*.png (SP_SHOTS=<dir> elsewhere).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.SP_SHOTS || path.join(ROOT, 'test/e2e/out');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const rules = (o = {}) => ({ revivalEnabled: false, disableSharedPool: false, ...o });

describe('手动指定卡池编组 (real server, headless Chrome)', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv, browser, base;
  const errors = [];
  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    mkdirSync(OUT, { recursive: true });
  });
  after(async () => { await browser?.close(); await srv?.close(); });

  async function open(name, { w = 1280, h = 720, touch = false, query = '', lang = null } = {}) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: w, height: h, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    await page.evaluateOnNewDocument((n, l) => {
      localStorage.setItem('sp.name', n);
      sessionStorage.setItem('sp.entered', '1');
      if (l) localStorage.setItem('sp.pref.lang', JSON.stringify(l));
    }, name, lang);
    await page.goto(`${base}/${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__SP__?.store.get().connection.status === 'online' && !!document.querySelector('.screen'), { timeout: 60000 });
    const board = await page.waitForSelector('.announcement-board', { visible: true, timeout: 2500 }).catch(() => null);
    if (board) {
      await page.click('.announcement-board .modal__actions button');
      await page.waitForSelector('.announcement-board', { hidden: true, timeout: 10000 });
    }
    return page;
  }
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, `pool-editor-${name}.png`) });
  const net = (page, t, fields) => page.evaluate((a, b) => globalThis.__SP__.net.request(a, b).then((r) => ({ t: r.t })), t, fields);
  const plan = (page) => page.evaluate(() => globalThis.__SP__.store.get().room?.experimental?.poolPlan ?? null);
  const planIs = (page, want) => page.waitForFunction((w) => JSON.stringify(globalThis.__SP__.store.get().room?.experimental?.poolPlan ?? null) === w, { timeout: 10000 }, JSON.stringify(want));
  const cards = (page) => page.$$eval('.pooled__card', (els) => els.length);
  const dialog = async (page, tab) => {
    await page.waitForSelector('.rs-pill__gear', { visible: true, timeout: 30000 });
    await page.$eval('.rs-pill__gear', (b) => b.click());
    await page.waitForSelector('.room-settings-modal', { visible: true });
    if (tab) await page.$eval(`[data-testid="room-settings-${tab}"]`, (b) => b.click());
    await new Promise((r) => setTimeout(r, 450)); // the dialog's entrance
  };
  /** The frame on screen, nothing wider than its box. */
  const fits = (page) => page.evaluate(() => {
    const box = document.querySelector('.room-settings-modal').getBoundingClientRect();
    const grid = document.querySelector('.pooled__grid'), body = document.querySelector('.rset__page');
    return { onScreen: box.top >= -1 && box.left >= -1 && box.bottom <= innerHeight + 1 && box.right <= innerWidth + 1,
      wide: [...document.querySelectorAll('.rset__page, .pooled__grid, .pooled__card')].filter((el) => el.scrollWidth > el.clientWidth + 1).length,
      pageScrolls: body.scrollHeight > body.clientHeight + 1, gridScrolls: !!grid && grid.scrollHeight > grid.clientHeight + 1 };
  });

  test('the host builds the pools, a guest reads them, the match uses them', async () => {
    const host = await open('编组房主');
    await net(host, 'room.create', { mode: 'coop', difficulty: 'NORMAL' });
    await dialog(host);
    await shot(host, 'alliance-1280');

    // 同盟: twelve seats, by hand
    await host.click('#experimental-multiplayer');
    await host.waitForSelector('#experimental-capacity', { visible: true, timeout: 5000 });
    await host.select('#experimental-capacity', '12');
    await host.waitForFunction(() => globalThis.__SP__.store.get().room?.experimental?.playerCapacity === 12, { timeout: 10000 });

    // the listed switch of a twelve-seat room (the owner's report: 无效的目标)
    await host.click('[data-testid="room-opt-listed"]');
    await host.waitForFunction(() => globalThis.__SP__.store.get().room?.listed === true, { timeout: 10000 });

    // 卡池: on, from the automatic rule
    await host.$eval('[data-testid="room-settings-pools"]', (b) => b.click());
    await host.waitForSelector('#experimental-pools-manual', { visible: true });
    assert.equal(await host.$('.pooled'), null, 'off: no editor');
    await host.click('#experimental-pools-manual');
    await host.waitForSelector('.pooled', { visible: true, timeout: 5000 });
    await planIs(host, [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2]);
    assert.equal(await cards(host), 3);
    assert.equal(await host.$eval('#experimental-pool', (el) => el.disabled), true, '禁用共享卡池 waits');
    await new Promise((r) => setTimeout(r, 200));
    await shot(host, 'pools-1280');
    let fit = await fits(host);
    assert.deepEqual(fit, { onScreen: true, wide: 0, pageScrolls: false, gridScrolls: false }, 'twelve seats at 720p');

    // ＋ / － / 均分
    await host.click('[data-testid="pool-more"]');
    await planIs(host, [0, 0, 3, 3, 1, 1, 1, 1, 2, 2, 2, 2].map((p, i, a) => [...new Set(a)].indexOf(p)));
    assert.equal(await cards(host), 4);
    await host.waitForFunction(() => !document.querySelector('[data-testid="pool-fewer"]')?.disabled, { timeout: 5000 });
    await host.click('[data-testid="pool-fewer"]');
    await host.waitForFunction(() => document.querySelectorAll('.pooled__card').length === 3, { timeout: 5000 });
    await host.waitForFunction(() => !document.querySelector('[data-testid="pool-even"]')?.disabled, { timeout: 5000 });
    await host.click('[data-testid="pool-even"]');
    await planIs(host, [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2]);

    // press a seat, then 移到此处
    await host.waitForFunction(() => !document.querySelector('[data-testid="pool-even"]')?.disabled, { timeout: 5000 });
    await host.click('[data-testid="pool-seat-3"]');
    await host.waitForSelector('[data-testid="pool-here-2"]', { visible: true });
    assert.equal(await host.$('[data-testid="pool-here-0"]'), null, 'its own pool is no target');
    assert.equal(await host.$eval('[data-testid="pool-seat-3"]', (el) => el.getAttribute('aria-pressed')), 'true');
    await shot(host, 'picked-1280');
    await host.click('[data-testid="pool-here-2"]');
    await planIs(host, [0, 0, 0, 2, 1, 1, 1, 1, 2, 2, 2, 2].map((p, i, a) => [...new Set(a)].indexOf(p)));

    // the keyboard: Enter picks, Esc lets go without closing the dialog
    await host.waitForFunction(() => document.querySelector('[data-testid="pool-seat-1"]')?.getAttribute('tabindex') === '0', { timeout: 5000 });
    await host.focus('[data-testid="pool-seat-1"]');
    await host.keyboard.press('Enter');
    await host.waitForSelector('[data-testid="pool-seat-1"][aria-pressed="true"]');
    await host.keyboard.press('Escape');
    await host.waitForSelector('[data-testid="pool-seat-1"][aria-pressed="false"]');
    assert.notEqual(await host.$('.room-settings-modal'), null, 'Esc let go of the seat, the dialog stays');

    // pressing a card moves the picked seat; another seat in that card is the card too
    await host.click('[data-testid="pool-seat-1"]');
    await host.click('[data-testid="pool-seat-4"]');
    await host.waitForFunction(() => { const p = globalThis.__SP__.store.get().room.experimental.poolPlan; return p[1] === p[4]; }, { timeout: 5000 });
    const moved = await plan(host);

    // a desktop drags: the handlers a browser's drag runs, the same move
    await host.waitForFunction(() => document.querySelector('[data-testid="pool-seat-2"]')?.draggable === true, { timeout: 5000 });
    await host.evaluate(() => {
      const from = document.querySelector('[data-testid="pool-seat-2"]'), to = document.querySelector('[data-testid="pool-card-2"]');
      const dataTransfer = new DataTransfer();
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
      return new Promise((resolve) => setTimeout(() => {
        to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
        to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
        from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
        resolve();
      }, 100));
    });
    await host.waitForFunction((seat, was) => globalThis.__SP__.store.get().room.experimental.poolPlan[seat] !== was, { timeout: 5000 }, 2, moved[2]);
    const dragged = await plan(host);
    assert.equal(dragged[2], dragged[8], 'P3 dropped on the third pool');

    // a guest reads the same cards, knows where they sit, and changes nothing
    const code = await host.evaluate(() => globalThis.__SP__.store.get().room.code);
    const guest = await open('编组队友', { query: `?room=${code}` });
    await guest.waitForFunction(() => !!globalThis.__SP__.store.get().room, { timeout: 30000 });
    await dialog(guest, 'pools');
    await guest.waitForSelector('.pooled', { visible: true, timeout: 5000 });
    assert.deepEqual(await plan(guest), dragged);
    assert.equal(await guest.$('[data-testid="pool-more"]'), null, 'no controls');
    assert.equal(await guest.$eval('[data-testid="pool-seat-1"]', (el) => el.getAttribute('aria-disabled')), 'true');
    await guest.click('[data-testid="pool-seat-1"]');
    assert.equal(await guest.$eval('[data-testid="pool-seat-1"]', (el) => el.getAttribute('aria-pressed')), 'false');
    const mine = await guest.$eval('.pooled__card.is-mine .pooled__seat.is-me', (el) => el.textContent);
    assert.match(mine, /编组队友/);
    await shot(guest, 'guest-1280');
    await guest.keyboard.press('Escape');
    await guest.waitForSelector('.room-settings-modal', { hidden: true });
    assert.match(await guest.$eval('[data-testid="seat-pool-0"]', (el) => el.textContent), /卡池 1/);
    await shot(guest, 'seats-1280');

    // the match: the seats taken, in the pools of the plan
    await guest.$eval('.rs-go', (b) => b.click());
    await guest.waitForFunction(() => globalThis.__SP__.store.get().room?.seats?.find((s) => s && s.name === '编组队友')?.ready === true, { timeout: 15000 });
    await host.keyboard.press('Escape');
    await host.waitForSelector('.room-settings-modal', { hidden: true });
    await host.waitForFunction(() => !document.querySelector('.rs-go')?.disabled, { timeout: 15000 });
    await host.$eval('.rs-go', (b) => b.click());
    await host.waitForFunction(() => !!globalThis.__SP__.store.get().match?.public?.poolGroups, { timeout: 30000 });
    const groups = await host.evaluate(() => globalThis.__SP__.store.get().match.public.poolGroups.map((g) => g.playerIds.length));
    // the host in seat 0, the guest in seat 1: the plan parted or joined them
    assert.deepEqual(groups, dragged[0] === dragged[1] ? [2] : [1, 1]);
    assert.deepEqual(errors, []);
  });

  for (const [name, w, h, touch] of [['1920', 1920, 1080, false], ['1280', 1280, 720, false], ['844', 844, 390, true], ['390', 390, 844, true]]) {
    test(`the dialog fits ${w}×${h}: twenty seats scroll inside it`, async () => {
      const page = await open(`适配${name}`, { w, h, touch });
      await net(page, 'room.create', { mode: 'coop', difficulty: 'NORMAL', experimental: rules({ playerCapacity: 12, poolPlan: [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2] }) });
      for (let i = 0; i < 5; i++) await net(page, 'room.addBot', {});
      await dialog(page, 'pools');
      await page.waitForSelector('.pooled', { visible: true, timeout: 5000 });
      await shot(page, `twelve-${name}`);
      let fit = await fits(page);
      assert.equal(fit.onScreen, true, `12: ${JSON.stringify(fit)}`);
      assert.equal(fit.wide, 0, `12: ${JSON.stringify(fit)}`);
      await net(page, 'room.setExperimental', { experimental: rules({ playerCapacity: 20, poolPlan: Array.from({ length: 20 }, (_, i) => Math.floor(i / 3)) }) });
      await page.waitForFunction(() => document.querySelectorAll('.pooled__card').length === 7, { timeout: 10000 });
      await new Promise((r) => setTimeout(r, 200));
      await shot(page, `twenty-${name}`);
      fit = await fits(page);
      assert.equal(fit.onScreen, true, `20: ${JSON.stringify(fit)}`);
      assert.equal(fit.wide, 0, `20: ${JSON.stringify(fit)}`);
      await page.$eval('[data-testid="room-settings-rules"]', (b) => b.click());
      await new Promise((r) => setTimeout(r, 150));
      await shot(page, `rules-${name}`);
      await page.$eval('[data-testid="room-settings-alliance"]', (b) => b.click());
      await new Promise((r) => setTimeout(r, 150));
      await shot(page, `alliance-${name}`);
      assert.equal((await fits(page)).onScreen, true);
    });
  }

  for (const lang of ['en', 'ja', 'ko', 'zh-TW']) for (const [w, h, touch] of [[1280, 720, false], [844, 390, true]]) {
    test(`every page holds its text in ${lang} at ${w}×${h}`, async () => {
      const page = await open(`文本${lang}${w}`, { w, h, touch, lang });
      await net(page, 'room.create', { mode: 'coop', difficulty: 'NORMAL', experimental: rules({ playerCapacity: 12, poolPlan: [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2] }) });
      await dialog(page, 'pools');
      await page.waitForSelector('.pooled', { visible: true, timeout: 5000 });
      await shot(page, `pools-${lang}-${w}`);
      for (const tab of ['pools', 'rules', 'alliance']) {
        await page.$eval(`[data-testid="room-settings-${tab}"]`, (b) => b.click());
        await new Promise((r) => setTimeout(r, 120));
        const fit = await page.evaluate(() => ({
          box: (() => { const r = document.querySelector('.room-settings-modal').getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1; })(),
          cut: [...document.querySelectorAll('.rset__tab, .rset__page strong, .rset__page small, .pooled__total, .btn__label, .pooled__head b')]
            .filter((el) => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent.slice(0, 40)),
          wide: document.querySelector('.rset__page').scrollWidth > document.querySelector('.rset__page').clientWidth + 1,
        }));
        assert.deepEqual(fit, { box: true, cut: [], wide: false }, tab);
      }
    });
  }

  test('a solo room has its one page, opened from both buttons', async () => {
    const page = await open('单人设置');
    await net(page, 'room.create', { mode: 'solo', difficulty: 'NORMAL' });
    await page.waitForSelector('.rs-exp', { visible: true, timeout: 30000 });
    await page.$eval('.rs-exp', (b) => b.click());
    await page.waitForSelector('.room-settings-modal', { visible: true });
    assert.equal(await page.$('.rset__tabs'), null);
    assert.notEqual(await page.$('#experimental-layer-cap'), null);
    assert.equal(await page.$('#experimental-revival'), null, 'no teammate to rescue');
    await new Promise((r) => setTimeout(r, 450));
    await shot(page, 'solo-1280');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.room-settings-modal', { hidden: true });
    assert.deepEqual(errors, []);
  });
});
