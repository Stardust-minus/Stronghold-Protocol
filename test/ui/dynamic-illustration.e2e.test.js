// Real-server browser E2E of 动态立绘 where the art shows (ui/dynamicIllustration.js cover mode; the owner's decision of
// 2026-11-02): the player's own 名片 plate in a room animates its skin's dynamic illustration (耀骑士临光「复现荣光」, its
// background and foreground layers too); 干员调配's art box animates the chosen appearance's (凛御银灰「雪覆伦城」, extracted
// from the client in rel26); never more live renderers than the cap; under prefers-reduced-motion both stay static.
//
//   SP_E2E=1 node --test test/ui/dynamic-illustration.e2e.test.js
//
// Screenshots: test/e2e/out/dynillust-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client, ROOT, sleep, hasChrome, startRealServer } from '../e2e/client.mjs';

const PLATE_SKIN = 'char_1014_nearl2_epoque_17';
const OP = 'chess_char_5_14_a', OP_CHAR = 'char_1045_svash2', OP_SKIN = 'char_1045_svash2_sale_20';
const ENABLED = process.env.SP_E2E === '1' && hasChrome() && existsSync(path.join(ROOT, `public/assets/skins/${PLATE_SKIN}/dynamic`))
  && existsSync(path.join(ROOT, `public/assets/skins/${OP_SKIN}/dynamic`));
const PLATE = '.rseat__plate.has-nc [data-testid="dynamic-cover"]';
const ART = '.lo-detail .lo-dhead__art [data-testid="dynamic-cover"]';
const liveCount = (c) => c.page.evaluate(() => import('/js/ui/dynamicIllustration.js').then((m) => m.dynamicSlots.live));
const drawn = (c, sel) => c.page.$eval(sel, (el) => {
  const cv = el.querySelector('canvas');
  return { state: el.dataset.state, canvas: !!cv && cv.width > 0 && cv.height > 0 && !el.querySelector('.dyn-cover__canvas').hidden };
});

describe('动态立绘 on 名片 and the operator page (real server)', { skip: !ENABLED && 'set SP_E2E=1 (Chrome + installed dynamic illustrations)' }, () => {
  test('a room seat plate and 干员调配\'s art box animate; within the cap; static under reduced motion', { timeout: 5 * 60 * 1000 }, async () => {
    const srv = await startRealServer({});
    const P = (await import('puppeteer-core')).default;
    const c = new Client(P, srv.base, 'dyn', { prefix: 'dynillust', prefs: { 'loadout.view': 'list', 'room.namecard': `skin:${PLATE_SKIN}`, skins: { v: 1, choices: { [OP_CHAR]: OP_SKIN } } } });
    try {
      await c.open();
      await c.enter('动态名片');
      await c.createCoop('标准模拟');
      await c.page.waitForSelector(`${PLATE}[data-state="ready"]`, { timeout: 60000 });
      assert.deepEqual(await drawn(c, PLATE), { state: 'ready', canvas: true }, 'the plate animates');
      await sleep(1500);
      await c.shot('namecard');

      await c.click('.rs-loadout');
      await c.page.waitForSelector('.lo .lo-card', { visible: true, timeout: 15000 });
      await c.page.$eval(`.lo-card[data-chess="${OP}"]`, (e) => { e.scrollIntoView({ block: 'center' }); e.click(); });
      await c.page.waitForFunction((id) => document.querySelector('.lo-card.is-sel')?.dataset.chess === id, { timeout: 5000 }, OP);
      await c.page.waitForSelector(`${ART}[data-state="ready"]`, { timeout: 60000 });
      assert.deepEqual(await drawn(c, ART), { state: 'ready', canvas: true }, 'the art box animates');
      const n = await liveCount(c);
      assert.ok(n >= 1 && n <= 4, `live renderers within the cap: ${n}`);
      await sleep(1500);
      await c.shot('operator');

      // prefers-reduced-motion: the art box stays the static picture (no renderer)
      await c.page.keyboard.press('Escape');
      await c.page.waitForFunction(() => !document.querySelector('.lo'), { timeout: 5000 });
      await c.page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await c.click('.rs-loadout');
      await c.page.waitForSelector('.lo .lo-card', { visible: true, timeout: 15000 });
      await c.page.$eval(`.lo-card[data-chess="${OP}"]`, (e) => { e.scrollIntoView({ block: 'center' }); e.click(); });
      await c.page.waitForSelector(ART, { timeout: 8000 });
      await sleep(2000);
      assert.deepEqual(await drawn(c, ART), { state: 'idle', canvas: false }, 'reduced motion: static');
      assert.deepEqual(c.problems.filter((p) => p.startsWith('pageerror:')), []);
    } finally {
      await c.close();
      await srv.stop();
    }
  });
});
