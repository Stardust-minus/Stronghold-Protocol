// Real-server browser E2E — rel25's 自选 operators in another official version (the owner, 2026-11-02: before, only
// 第二期下半 offered them): with the lobby on 第一期下半, 干员调配 → 自选编队's picker offers 塔露拉, 冻河 and 国度 (and no
// collab 6★: no room with 联动干员 on) and slots 塔露拉 with her S3; in a co-op room of 第一期下半 the pick is sent and
// kept (已同步).
//
//   SP_E2E=1 node --test test/ui/versions-rel25.e2e.test.js
//
// Screenshots: test/e2e/out/versions-rel25-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Client, hasChrome, sleep, startRealServer } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome();
const SLOT = 'chess_char_5_diy1_a';
const PICKER = '[data-testid="diy-picker"]';
const NEW = ['char_4247_oxi', 'char_4244_tocka', 'char_4246_dminon'];
const COLLAB = ['char_456_ash', 'char_1029_yato2', 'char_1048_orchd2', 'char_4123_ela', 'char_4141_marcil', 'char_4182_oblvns', 'char_4217_makoto'];

const settle = (c) => c.page.waitForFunction(() => !document.getAnimations()
  .some((a) => /^(tr|ps|rs|rseat)-/.test(String(a.animationName)) && a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity), { timeout: 10000 });
const openWith = async (c, sel, waitSel) => {
  for (let i = 0; i < 4; i++) {
    await c.click(sel);
    try { await c.page.waitForSelector(waitSel, { visible: true, timeout: 2500 }); return; } catch { /* again */ }
  }
  throw new Error(`${c.label}: ${waitSel} never showed`);
};

describe('rel25 自选 operators in 第一期下半 (real server, SP_VERSIONS=all)', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome)' }, () => {
  test('the picker offers 塔露拉 冻河 国度, no collab pick; 塔露拉 S3 is kept', { timeout: 4 * 60 * 1000 }, async () => {
    const srv = await startRealServer({ env: { SP_VERSIONS: 'all' } });
    const P = (await import('puppeteer-core')).default;
    const c = new Client(P, srv.base, 'v1', { prefix: 'versions-rel25' });
    try {
      await c.open();
      await c.enter('塔露拉');
      await openWith(c, '[data-testid="version-switch"]', '[data-testid="version-picker"]');
      await settle(c);
      await c.click('.verpick__pick[data-version="act1autochess"]');
      await c.page.waitForFunction(() => {
        const k = globalThis.__SP_CONTENT__?.state() || {};
        return k.kind === 'version' && k.version === 'act1autochess' && k.status === 'ready' && globalThis.__SP__.data.get('config')?.version?.id === 'act1autochess';
      }, { timeout: 30000 });
      await openWith(c, '.lobby-screen [data-testid="loadout-open"]', '.lo .lo-tab[data-tab="diy"]');
      await c.click('.lo .lo-tab[data-tab="diy"]');
      await c.page.waitForSelector(`.diy-slot[data-slot="${SLOT}"] .diy-slot__fill`, { visible: true, timeout: 15000 });
      await c.click(`.diy-slot[data-slot="${SLOT}"] .diy-slot__fill`);
      await c.page.waitForSelector(`${PICKER} .diy-opt[data-char="${NEW[0]}"]`, { timeout: 8000 });
      const offered = await c.page.$$eval(`${PICKER} .diy-opt[data-char]`, (els) => els.map((e) => e.dataset.char));
      for (const id of NEW) assert.ok(offered.includes(id), `${id} offered in 第一期下半`);
      for (const id of COLLAB) assert.ok(!offered.includes(id), `${id} not offered without 联动干员`);
      await c.page.$eval(`${PICKER} .diy-opt[data-char="${NEW[0]}"]`, (e) => { e.scrollIntoView({ block: 'center' }); (e.querySelector('.diy-opt__pick') ?? e).click(); });
      await c.page.waitForSelector(`${PICKER} .lo-skill[data-skill="2"]`, { visible: true, timeout: 5000 });
      await c.page.click(`${PICKER} .lo-skill[data-skill="2"]`);
      await sleep(300);
      await c.shot('picker');
      await c.click('[data-testid="diy-confirm"]');
      await c.page.waitForFunction((slot, id) => document.querySelector(`.diy-slot[data-slot="${slot}"]`)?.dataset.char === id, { timeout: 4000 }, SLOT, NEW[0]);
      await c.shot('slotted');
      // outside a room the page keeps another version's picks (loadoutSync.js: sent only against the server's default
      // version); a room of 第一期下半 sends them once its content is on the page, and the server keeps 塔露拉
      await c.page.keyboard.press('Escape');
      await c.page.waitForFunction(() => !document.querySelector('.lo .lo-tab'), { timeout: 10000 });
      await c.createCoop();
      await c.page.waitForFunction(() => (globalThis.__SP__.store.get().room?.version ?? 'act2autochess') === 'act1autochess', { timeout: 20000 });
      await openWith(c, '.room-screen [data-testid="loadout-open"]', '.lo .lo-tab[data-tab="diy"]');
      await c.click('.lo .lo-tab[data-tab="diy"]');
      await c.page.waitForFunction((slot, id) => document.querySelector(`.diy-slot[data-slot="${slot}"]`)?.dataset.char === id, { timeout: 15000 }, SLOT, NEW[0]);
      await c.page.waitForFunction(() => /已同步/.test(document.querySelector('[data-testid="diy-sync"]')?.textContent || ''), { timeout: 15000 });
      await c.shot('room');
    } finally {
      await c.close();
      await srv.stop();
    }
  });
});
