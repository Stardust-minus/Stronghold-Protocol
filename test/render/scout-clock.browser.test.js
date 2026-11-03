// test/render/scout-clock.browser.test.js — a scouted prep board runs on the prep's clock (the owner's report of
// 2026-11-02: 「在备战阶段观战队友，队友场上的动画会以二倍速播放」). A teammate's lineup during prep is entered as a battle field
// (enterBattle { prep: true }), so its models and effects took the battle clock: the stream's 2 game s per real second,
// 4 once 战斗 2 倍速 had passed (m.public speedVote.on stays set through the next prep) — render/app.js battleClock.
//
// Opt-in (starts Chrome): RENDER_E2E=1 node --test test/render/scout-clock.browser.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const enabled = process.env.RENDER_E2E === '1' && existsSync(CHROME) && existsSync(path.join(ROOT, 'public/assets'));
const skip = enabled ? false : 'set RENDER_E2E=1 (needs Chrome and downloaded assets)';

describe('scouted prep board clock in headless Chrome', { skip }, () => {
  let srv, browser;
  before(async () => {
    const puppeteer = (await import('puppeteer-core')).default;
    const { startServer } = await import('../../server/index.js');
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--no-first-run'] });
  });
  after(async () => {
    await browser?.close();
    await srv?.close();
  });

  test('a scouted board idles at the prep pace under 2 倍速; a battle keeps the stream clock', async () => {
    const page = await browser.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(`http://127.0.0.1:${srv.port}/dev/render-demo.html?scene=prep&panel=0`);
    await page.waitForFunction('window.__demo && (window.__demo.ready || window.__demo.error)', { timeout: 40000 });
    assert.equal(await page.evaluate(() => window.__demo.error || null), null, 'demo boot');
    const r = await page.evaluate(() => {
      const v = window.__demo.view;
      const ctx = v.debug.ctx;
      const read = () => ({ mode: v.mode, anim: ctx.animRate(), ts: ctx.timeScale() });
      const out = { prep: read() };
      const rect = { r0: 9, r1: 12, c0: 0, c1: 10 };
      const unit = { id: 1, uid: 7, kind: 'op', side: 'ally', ownerId: 'mate', defId: 'chess_char_1_10_a', x: 3, y: 10, maxHp: 1000 };
      v.setStreamSpeed(4);   // 战斗 2 倍速 passed: m.public speedVote { on: true, speed: 4 } through the next prep
      v.enterBattle({ fieldId: 'n:mate', kind: 'normal', rect, stageId: 'act2autochess_m01', prep: true, units: [unit] });
      out.scout = read();
      v.enterBattle({ fieldId: 'n', kind: 'normal', rect, stageId: 'act2autochess_m01', units: [unit] });
      out.battle = read();
      v.setStreamSpeed(0);
      out.battleNormal = read();
      return out;
    });
    await page.close();
    assert.deepEqual(problems, []);
    assert.equal(r.prep.anim, 1, `own prep: ${JSON.stringify(r.prep)}`);
    assert.deepEqual([r.scout.mode, r.scout.anim, r.scout.ts], ['battle', 1, 1], `scouted board: the prep pace (${JSON.stringify(r.scout)})`);
    assert.deepEqual([r.battle.anim, r.battle.ts], [4, 4], `a battle under 2 倍速 (${JSON.stringify(r.battle)})`);
    assert.deepEqual([r.battleNormal.anim, r.battleNormal.ts], [2, 2], `a battle at the normal speed (${JSON.stringify(r.battleNormal)})`);
  });
});
