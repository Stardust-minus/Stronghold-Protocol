// Real-server browser E2E of the skins released on 2026-10-31 (test/operator-skins-1031.test.js): with the choices stored
// in the browser, 凛御银灰「雪覆伦城」, 号角「锋光初现」 and 凯瑟琳「暖冬教室」 (shop chess, a starter kit placed at the first
// prep) stand on the board in their skins' own models; 薇薇安娜「还愿礼」 (a 自选 pick) is offered in the 自选 外观 picker,
// with its 动态立绘 (rel26, from the client).
//
//   SP_E2E=1 node --test test/ui/skins-1031.e2e.test.js
//
// Screenshots: test/e2e/out/skins1031-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client, ROOT, sleep, hasChrome, startRealServer } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome() && existsSync(path.join(ROOT, 'public/assets/skins/char_1045_svash2_sale_20'));
const BOARD = Object.freeze({ char_1045_svash2: 'char_1045_svash2_sale_20', char_4039_horn: 'char_4039_horn_epoque_59', char_4162_cathy: 'char_4162_cathy_kitchen_5' });
const KIT = ['chess_char_5_14_a', 'chess_char_5_08_a', 'chess_char_4_11_a'];
const VVANA = 'char_4098_vvana', VVANA_SKIN = 'char_4098_vvana_epoque_59';
const SLOT = 'chess_char_5_diy1_a';
const PICKER = '[data-testid="diy-picker"]';

describe('2026-10-31 skins (real server)', { skip: !ENABLED && 'set SP_E2E=1 (Chrome + the new skins installed)' }, () => {
  test('三 shop operators on the board in their new skins; 薇薇安娜「还愿礼」 in the 自选 picker', { timeout: 6 * 60 * 1000 }, async () => {
    const srv = await startRealServer({ fast: { timerScale: 0.5, combatSpeed: 0.2, startRound: 1, kits: [KIT], autoPlace: true } });
    const P = (await import('puppeteer-core')).default;
    const c = new Client(P, srv.base, 'skins', { prefix: 'skins1031', prefs: { 'loadout.view': 'list', skins: { v: 1, choices: { ...BOARD } } } });
    try {
      await c.open();
      await c.enter('新皮肤');

      // 自选: 薇薇安娜's 外观 offers 还愿礼 (installed, its half-body art)
      await c.click('.lobby-screen [data-testid="loadout-open"]');
      await c.page.waitForSelector('.lo .lo-tab[data-tab="diy"]', { visible: true, timeout: 15000 });
      await c.click('.lo .lo-tab[data-tab="diy"]');
      await c.page.waitForSelector(`.diy-slot[data-slot="${SLOT}"] .diy-slot__fill`, { visible: true, timeout: 15000 });
      await c.click(`.diy-slot[data-slot="${SLOT}"] .diy-slot__fill`);
      await c.page.waitForSelector(`${PICKER} .diy-opt[data-char="${VVANA}"]`, { timeout: 8000 });
      await c.page.$eval(`${PICKER} .diy-opt[data-char="${VVANA}"]`, (e) => { e.scrollIntoView({ block: 'center' }); (e.querySelector('.diy-opt__pick') ?? e).click(); });
      const btn = `${PICKER} [data-testid="skin-picker"] [data-skin="${VVANA_SKIN}"]`;
      await c.page.waitForSelector(btn, { timeout: 8000 });
      const offered = await c.page.$eval(btn, (b) => { b.scrollIntoView({ block: 'center' }); return { disabled: b.disabled, text: b.textContent, art: b.querySelector('img')?.getAttribute('src') || '' }; });
      assert.equal(offered.disabled, false, offered.text);
      assert.ok(offered.text.includes('还愿礼') && offered.text.includes('动态立绘') && !offered.text.includes('待补'), offered.text);
      assert.match(offered.art, /\/assets\/(~[0-9a-f]+\/)?skins\/char_4098_vvana_epoque_59\/portrait\.png$/);
      await sleep(1200);
      await c.shot('vvana-picker');
      await c.page.keyboard.press('Escape');
      await sleep(300);
      await c.page.keyboard.press('Escape');
      await c.page.waitForFunction(() => !document.querySelector('.lo'), { timeout: 5000 });

      await c.createSolo('标准模拟');
      await c.waitFor((s) => !!s.room, 'solo room');
      if (!(await c.st()).phase) await c.roomStart({ timeout: 20000 });
      await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 30000);
      await c.settled('.brief-go');
      await c.click('.brief__foot .btn--primary', '准备就绪');
      await c.waitFor((s) => s.phase === 'BAND_DRAFT', 'band draft', 30000);
      await c.click('.dband', null, { nth: 1 });
      await c.click('.draft-detail__btns .btn--primary', '确认选择');
      await c.waitFor((s) => s.phase === 'PREP' && s.board >= 3, 'the kit placed', 60000);

      const drawn = await c.page.waitForFunction((want) => {
        const views = globalThis.__SP_VIEW__?.raw?.debug?.views;
        if (!views) return false;
        const out = {};
        for (const v of views.values()) {
          const skin = v?.info?.skinId;
          if (!skin || !Object.values(want).includes(skin) || !v.actor || !v.entry?.skel) continue;
          out[skin] = { skel: v.entry.skel, fallback: !!v.fallback?.visible };
        }
        return Object.keys(out).length === Object.keys(want).length ? out : false;
      }, { timeout: 60000, polling: 300 }, BOARD).then((h) => h.jsonValue());
      for (const skin of Object.values(BOARD)) {
        assert.match(drawn[skin].skel, new RegExp(`/skins/${skin}/(front|back)/${skin}\\.(display\\.)?skel$`), `${skin}: its own model (${drawn[skin].skel})`);
        assert.equal(drawn[skin].fallback, false, `${skin}: the model shows`);
      }
      await sleep(2000);
      await c.shot('board');
      assert.deepEqual(c.problems.filter((p) => p.startsWith('pageerror:')), []);
    } finally {
      await c.close();
      await srv.stop();
    }
  });
});
