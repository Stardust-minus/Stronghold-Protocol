// Browser check of the settings entry of the lobby and the room (GitHub #238 — 设置 was reachable only from the title
// screen and a running match; opt-in, ~15 s):
//   SP_E2E=1 CHROME_PATH=… node --test test/ui/settings-entry.e2e.test.js
//
// The lobby's top bar carries a 设置 button left of 玩法说明 (ui/settings.js SettingsButton), and so does the
// room's after 创建同盟; each opens the very same settings modal (language, sound, 快捷键 …) and closes
// with Esc or 完成, leaving the screen as it was. No console / page errors. The modal itself and its contents are covered
// by test/ui/modal.e2e.test.js and test/ui/i18n.e2e.test.js; this file is about the entry. Not in the modal, deliberately: background music in a
// hidden tab and the board style (the owner's decision of 2026-10-07 on #238).

import { skipEntryFilm } from '../helpers/entryFilm.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('the settings entry of the lobby and the room', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
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

  /** Is the 设置 button the sibling right before the 玩法说明 button of `screen`'s top bar? */
  const settingsBeforeGuide = (page, screen, guideClass) => page.evaluate((s, g) => {
    const btn = document.querySelector(`${s} [data-testid="settings-btn"]`);
    const guide = document.querySelector(`${s} .${g}`);
    return !!btn && !!guide && btn.nextElementSibling === guide && /设置/.test(btn.getAttribute('aria-label') || btn.textContent) && btn.querySelector('svg.btn__icon') != null;
  }, screen, guideClass);
  const modalText = (page) => page.evaluate(() => document.querySelector('.modal')?.textContent.replace(/\s+/g, ' ').trim() ?? null);

  test('the lobby: 设置 left of 玩法说明 opens the settings modal; Esc closes it; the room has the same entry', async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900 });
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await skipEntryFilm(page); // no entry film over the lobby
    await page.goto(`${base}/`, { waitUntil: 'load', timeout: 60000 });
    // no title screen to type a callsign into since 2026-10-15: the page opens on the lobby
    await page.waitForSelector('.lobby-screen', { timeout: 15000 });
    await sleep(500);

    const announcement = await page.$('.announcement-board .modal__actions button');
    if (announcement) { await announcement.click(); await page.waitForSelector('.announcement-board', { hidden: true }); }
    assert.equal(await page.$('.lobby-language'), null, 'language has no duplicate lobby entry');
    assert.ok(await settingsBeforeGuide(page, '.lobby-screen .topbar__tools', 'lobby-guide'), '设置 sits right before 玩法说明 in the lobby\'s top bar');
    assert.equal(await modalText(page), null, 'closed until asked');
    await page.click('.lobby-screen [data-testid="settings-btn"]');
    await page.waitForSelector('.modal', { timeout: 5000 });
    const text = await modalText(page);
    assert.match(text, /设置/);
    assert.match(text, /背景音乐/);
    assert.match(text, /快捷键/);
    // The text-size hint mentions the unchanged board scale; the declined options concern controls, not help copy.
    const optionLabels = await page.$$eval('.modal .set-row__label', (nodes) => nodes.map((n) => n.textContent).join(' '));
    assert.doesNotMatch(optionLabels, /棋盘/, 'no board-style option (declined)');
    assert.doesNotMatch(optionLabels, /后台/, 'no background-music option (declined)');
    await page.keyboard.press('Escape');
    await sleep(300);
    assert.equal(await modalText(page), null, 'Esc closes it');
    assert.ok(await page.$('.lobby-screen'), 'the lobby is still there');

    // the room: 同盟模拟 → 创建同盟 → the same button, closed with 完成
    await page.evaluate(() => [...document.querySelectorAll('.hub-entry')].find((b) => /同盟模拟/.test(b.textContent))?.click());
    await page.waitForSelector('.ally-card--create', { visible: true, timeout: 10000 });
    await sleep(500);
    await page.click('.ally-card--create');
    await page.waitForSelector('.room-screen', { timeout: 15000 });
    await sleep(500);
    // #888 below needs a seat control: an AI teammate (this fork's 添加 AI 队友 is .rseat__addbot, its ✕ .rseat__kick--bot)
    await page.click('.rseat__addbot');
    await page.waitForSelector('.rseat__kick');
    await sleep(1200); // let the card's entry/flash stacking contexts end
    assert.ok(await settingsBeforeGuide(page, '.room-screen .rs-tools', 'room-guide'), '设置 sits right before 玩法说明 in the room\'s top bar');
    await page.click('.room-screen [data-testid="settings-btn"]');
    await page.waitForSelector('.modal', { timeout: 5000 });
    assert.match(await modalText(page), /背景音乐/);
    // #888: seat controls must stay below both the settings box and its backdrop.
    for (const [width, height] of [[1600, 900], [1280, 720]]) {
      await page.setViewport({ width, height });
      await sleep(200);
      const hits = await page.$$eval('.rseat__kick', (buttons) => buttons.map((button) => {
        const r = button.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { covered: !!hit?.closest('.modal'), hit: hit?.outerHTML.slice(0, 200),
          parents: [hit?.parentElement?.className, hit?.parentElement?.parentElement?.className] };
      }));
      assert.ok(hits.length && hits.every((h) => h.covered), `${width}: ${JSON.stringify(hits)}`);
    }
    // #888 follow-up: shrinking to a phone's short screen hides the room's tool buttons, not the open settings window
    await page.setViewport({ width: 844, height: 390 });
    await sleep(300);
    const shortScreen = await page.evaluate(() => ({
      modal: (() => { const m = document.querySelector('.modal .modal__box'); const r = m?.getBoundingClientRect(); return !!r && r.width > 0 && r.height > 0; })(),
      button: (() => { const b = document.querySelector('.room-screen [data-testid="settings-btn"]'); return !!b && b.getClientRects().length > 0; })(),
    }));
    assert.deepEqual(shortScreen, { modal: true, button: false }, 'the open window stays, the toolbar button gives way');
    await page.setViewport({ width: 1280, height: 720 });
    await sleep(300);
    await page.evaluate(() => [...document.querySelectorAll('.modal button')].find((b) => /完成/.test(b.textContent))?.click());
    await sleep(300);
    assert.equal(await modalText(page), null, '完成 closes it');
    assert.ok(await page.$('.room-screen'), 'the room is still there');
    assert.deepEqual(problems, []);
    await page.close();
  });
});
