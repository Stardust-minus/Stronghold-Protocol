// Real-server browser E2E of the official 动态立绘 scenes played live (ui/dynFx.js, 2026-11-17; the owner: the scene of
// every 动态立绘 plays like the client's, highest quality): a 名片 plate whose skin has a checked scene shows the baked
// backdrop first and then the live scene on the shared renderer ([data-scene="live"]); 干员调配's art box (a crop) never
// plays one; 「查看立绘」 plays it on its own renderer; closing a view gives its scene's textures back (nothing of it left on
// the GPU — the trial leaked them).
//
//   SP_E2E=1 node --test test/ui/dyn-fx.e2e.test.js
//
// Needs the scene files (public/assets/local/dynfx/, tools/local-extract/dyn-scenes-pack.mjs) and the two skins'
// 动态立绘. Screenshots: test/e2e/out/dynfx-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client, ROOT, sleep, hasChrome, startRealServer } from '../e2e/client.mjs';

const PLATE_SKIN = 'char_4064_mlynar_epoque_28';
const OP = 'chess_char_4_16_a', OP_CHAR = 'char_1028_texas2', OP_SKIN = 'char_1028_texas2_iteration_1';
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'data/assets.json'), 'utf8'));
const sceneOf = (id) => manifest.skins?.[id]?.dynamic?.scene;
const onDisk = (u) => !!u && existsSync(path.join(ROOT, 'public', u));
const ENABLED = process.env.SP_E2E === '1' && hasChrome() && [PLATE_SKIN, OP_SKIN].every((id) => onDisk(sceneOf(id)) && existsSync(path.join(ROOT, `public/assets/skins/${id}/dynamic`)));
const PLATE = '.rseat__plate.has-nc [data-testid="dynamic-cover"]';
const ART = '.lo-detail .lo-dhead__art [data-testid="dynamic-cover"]';
const FULL = '.modal [data-testid="dynamic-illustration"]';
const gpu = (c) => c.page.evaluate(() => import('/js/ui/dynFx.js').then((m) => ({ scenes: m.dynFxGpu.scenes, textures: m.dynFxGpu.textures, meshes: m.dynFxGpu.meshes, renderers: m.dynFxGpu.renderers })));
const stage = (c) => c.page.evaluate(() => import('/js/ui/dynamicStage.js').then((m) => ({ scenes: m.dynamicStage.scenes, backdrops: m.dynamicStage.backdrops, contexts: m.dynamicStage.contexts })));

describe('动态立绘 scenes, live (real server)', { skip: !ENABLED && 'set SP_E2E=1 (Chrome, the scene files and both skins\' 动态立绘 installed, the scenes enabled)' }, () => {
  test('名片: the baked backdrop, then the scene on the shared renderer; 干员调配\'s crop plays none; 「查看立绘」 plays it and gives it back', { timeout: 6 * 60 * 1000 }, async () => {
    const srv = await startRealServer({});
    const P = (await import('puppeteer-core')).default;
    const c = new Client(P, srv.base, 'dynfx', { prefix: 'dynfx', prefs: { 'loadout.view': 'list', 'room.namecard': `skin:${PLATE_SKIN}`, skins: { v: 1, choices: { [OP_CHAR]: OP_SKIN } } } });
    try {
      await c.open();
      await c.enter('场景特效');
      await c.createCoop('标准模拟');
      await c.page.waitForSelector(`${PLATE}[data-state="ready"]`, { timeout: 60000 });
      await c.page.waitForSelector(`${PLATE}[data-scene="live"]`, { timeout: 60000 });
      const s1 = await stage(c), g1 = await gpu(c);
      assert.equal(s1.contexts, 1, 'one shared renderer');
      assert.ok(s1.scenes >= 1, 'the plate draws the scene');
      assert.equal(s1.backdrops, 0, 'the baked pictures gave way to it');
      assert.ok(g1.scenes >= 1 && g1.textures > 0, `its textures on the GPU (${JSON.stringify(g1)})`);
      await sleep(2500);
      await c.shot('namecard');

      await c.click('.rs-loadout');
      await c.page.waitForSelector('.lo .lo-card', { visible: true, timeout: 15000 });
      await c.page.$eval(`.lo-card[data-chess="${OP}"]`, (e) => { e.scrollIntoView({ block: 'center' }); e.click(); });
      await c.page.waitForFunction((id) => document.querySelector('.lo-card.is-sel')?.dataset.chess === id, { timeout: 5000 }, OP);
      await c.page.waitForSelector(`${ART}[data-state="ready"]`, { timeout: 60000 });
      await sleep(1500);
      assert.equal(await c.page.$eval(ART, (el) => el.dataset.scene ?? null), null, 'a 干员调配 crop: the character only');
      assert.equal(await c.page.$eval(ART, (el) => el.dataset.backdrop ?? null), null);
      await c.shot('operator');

      await c.page.$eval('[data-testid="skins-preview"]', (e) => { e.scrollIntoView({ block: 'center' }); e.click(); });
      await c.page.waitForSelector(`${FULL}[data-state="ready"]`, { timeout: 60000 });
      await c.page.waitForSelector(`${FULL}[data-scene="live"]`, { timeout: 60000 });
      const g2 = await gpu(c);
      assert.equal(g2.renderers, 2, 'the preview\'s own renderer and the shared one');
      await sleep(2500);
      await c.shot('preview');
      await c.page.keyboard.press('Escape');
      await c.page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 10000 }, FULL);
      await sleep(500);
      const g3 = await gpu(c);
      assert.equal(g3.renderers, 1, 'the preview\'s renderer released with everything of the scene on it');
      assert.deepEqual([g3.scenes, g3.textures], [g1.scenes, g1.textures], 'back to the plate\'s alone');

      // the room left: no view, nothing of any scene on the GPU
      await c.page.keyboard.press('Escape');
      await c.page.waitForFunction(() => !document.querySelector('.lo'), { timeout: 5000 });
      await c.click('.rs-exit');
      // a host with company confirms; alone, the room just closes
      await c.page.waitForFunction(() => !document.querySelector('.rseat__plate') || document.querySelector('.modal button[data-autofocus]'), { timeout: 10000 });
      if (await c.page.$('.modal button[data-autofocus]')) await c.page.click('.modal button[data-autofocus]');
      await c.page.waitForFunction(() => !document.querySelector('.rseat__plate'), { timeout: 15000 });
      await sleep(500);
      const g4 = await gpu(c);
      assert.deepEqual([g4.scenes, g4.textures, g4.meshes], [0, 0, 0], 'a closed view keeps nothing on the GPU');
      assert.deepEqual(c.problems.filter((p) => p.startsWith('pageerror:') || /screen crashed|\[dynfx\]/.test(p)), []);
    } finally {
      await c.close();
      await srv.stop();
    }
  });
});
