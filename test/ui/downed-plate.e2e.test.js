// Browser check of 「协议已失效」 (opt-in, needs Chrome, ~40 s):
//   SP_E2E=1 CHROME_PATH=… node --test test/ui/downed-plate.e2e.test.js
//
// Through the dev mock: my LP runs out while teammates play on — the dialog, focus on 继续观战, Esc closes it; 离开模拟
// opens the exit dialog, or with the server's 个人战报 (m.private out) 前往结算 opens it (feedback #111); nothing when the
// whole team falls or without the art pack. Static counterpart:
// test/ui/downed-plate.test.js.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('协议已失效 (headless Chrome)', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv;
  let browser;
  let base;

  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--force-device-scale-factor=1'] });
  });

  after(async () => {
    await browser?.close();
    await srv?.close();
  });

  /** The mock at SETTLE in a fresh context, past the service worker; `noart` fails /assets/ui/ (the CI view). */
  async function open({ noart = false } = {}) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setBypassServiceWorker(true);
    await page.setViewport({ width: 1920, height: 1080 });
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error' && !(noart && /Failed to load resource/.test(m.text()))) problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.evaluateOnNewDocument(() => performance.setResourceTimingBufferSize(5000));
    if (noart) {
      await page.setRequestInterception(true);
      page.on('request', (r) => (/\/assets\/ui\//.test(r.url()) ? r.abort() : r.continue()));
    }
    await page.goto(`${base}/dev/game-mock.html?shot=1&render=fallback&phase=SETTLE`, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForSelector('.gm__hud', { timeout: 30000 });
    if (!noart) await page.waitForFunction(() => performance.getEntriesByType('resource').some((e) => /settlemen_personal_fail/.test(e.name)), { timeout: 15000 });
    await sleep(300);
    return { page, problems, context };
  }

  /** My LP runs out (m.private and my m.public row); `all`: every teammate's too. */
  const knockOut = (page, all = false) => page.evaluate((all) => {
    const M = globalThis.__MOCK__;
    M.mutate((s) => {
      s.priv.alive = false; s.priv.lp = 0;
      s.pub.players.forEach((p, i) => { if (i === 0 || all) { p.alive = false; p.lp = 0; } });
    });
    M.pushPublic();
  }, all);

  // first: a later page of the same browser was seen getting the sprites past the interception (headless Chrome on
  // Windows), so the CI view is checked before any other page
  test('without the art pack: no dialog (0.3.0\'s toast and pill stay)', async () => {
    const { page, problems, context } = await open({ noart: true });
    await knockOut(page);
    await sleep(800);
    assert.equal(await page.$('[data-testid="downed-plate"]'), null);
    assert.deepEqual(problems, []);
    await context.close();
  });

  test('my LP runs out while the team plays on: the dialog, focus on 继续观战, Esc closes it', async () => {
    const { page, problems, context } = await open();
    await knockOut(page);
    await page.waitForSelector('[data-testid="downed-plate"]', { timeout: 3000 });
    await sleep(700);
    const s = await page.evaluate(() => ({
      title: document.querySelector('.downm__title').textContent,
      focus: document.activeElement?.textContent?.trim(),
      out: !!document.querySelector('.downm__face.is-out'),
      map: document.querySelector('.downm__map')?.naturalWidth > 0,
    }));
    assert.deepEqual(s, { title: '协议已失效', focus: '继续观战', out: true, map: true });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-testid="downed-plate"]'), { timeout: 2000 });
    assert.deepEqual(problems, []);
    await context.close();
  });

  test('离开模拟 opens the exit dialog', async () => {
    const { page, problems, context } = await open();
    await knockOut(page);
    await page.waitForSelector('.downm__btn--leave', { timeout: 3000 });
    await page.click('.downm__btn--leave');
    await page.waitForFunction(() => !document.querySelector('[data-testid="downed-plate"]')
      && [...document.querySelectorAll('.modal__title')].some((h) => h.textContent === '离开模拟'), { timeout: 2000 });
    assert.deepEqual(problems, []);
    await context.close();
  });

  // feedback #111: the server's 个人战报 of the elimination (m.private `out`) turns the second button into the official
  // 前往结算: the report over the game (模拟中断, 继续观战), then a 前往结算 button to open it again
  test('with the 个人战报 (m.private out): 前往结算 opens it, 继续观战 closes it, the HUD button reopens it', async () => {
    const { page, problems, context } = await open();
    await page.evaluate(() => {
      const M = globalThis.__MOCK__;
      M.mutate((s) => {
        const me = s.pub.players[0];
        s.priv.alive = false; s.priv.lp = 0; me.alive = false; me.lp = 0;
        s.priv.out = { provisional: true, victory: false, roundsPassed: 2, hiddenReached: false, hiddenCleared: false, reason: 'eliminated',
          modeId: s.pub.modeId, difficulty: s.pub.difficulty, seed: 1, durationMs: 600000,
          players: [{ playerId: me.playerId, seat: 0, name: me.name, isBot: false, left: false, alive: false, victory: false, roundsPassed: 2,
            eliminatedRound: 3, lp: 0, bandId: me.bandId ?? null, lineup: [], bonds: [], title: null, trophies: 1, reward: 120,
            stats: { dmgDealt: 0, kills: 0, leaks: 0, gold: 0, refreshes: 0, merges: 0, itemsEquipped: 0, bossDamage: 0, activatedLayers: 0, lpLost: 0, perfectRounds: 0 } }] };
      });
      M.pushPublic();
    });
    await page.waitForSelector('[data-testid="downed-settle"]', { timeout: 3000 });
    assert.equal(await page.$('.downm__btn--leave'), null, '前往结算 in place of 离开模拟');
    await page.click('[data-testid="downed-settle"]');
    await page.waitForSelector('[data-testid="settle-out"]', { timeout: 3000 });
    await page.waitForSelector('[data-testid="settle-out"] .settle__next', { timeout: 6000 });
    const title = await page.evaluate(() => document.querySelector('[data-testid="settle-out"] .sself__title')?.textContent?.trim());
    assert.equal(title, '模拟中断');
    assert.equal(await page.evaluate(() => document.querySelector('[data-testid="settle-out"] .settle__nextlabel')?.textContent), '继续观战');
    await page.click('[data-testid="settle-out"] .settle__next');
    await page.waitForFunction(() => !document.querySelector('[data-testid="settle-out"]'), { timeout: 3000 });
    await page.waitForSelector('[data-testid="out-report"]', { timeout: 2000 });
    await page.click('[data-testid="out-report"]');
    await page.waitForSelector('[data-testid="settle-out"]', { timeout: 3000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-testid="settle-out"]'), { timeout: 3000 });
    assert.deepEqual(problems, []);
    await context.close();
  });

  test('the whole team falls: no dialog (the match ends)', async () => {
    const { page, problems, context } = await open();
    await knockOut(page, true);
    await sleep(800);
    assert.equal(await page.$('[data-testid="downed-plate"]'), null);
    assert.deepEqual(problems, []);
    await context.close();
  });
});
