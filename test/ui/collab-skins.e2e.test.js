// Real-server browser E2E of a collab operator's skin (test/collab-skins.test.js; docs/ASSETS.md "The collab pack"): before
// 联动干员 is on, no page asks for the pack's skin art; with it on, the 自选 picker's 外观 offers 灰烬「游侠」 from the pack,
// the choice syncs, and 灰烬 bought from the shop and placed stands on the board in the skin's own model (its Spine files
// under /assets/collab/skins/).
//
//   SP_E2E=1 node --test test/ui/collab-skins.e2e.test.js
//
// Screenshots: test/e2e/out/collab-skin-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client, ROOT, sleep, hasChrome, startRealServer } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome() && existsSync(path.join(ROOT, 'public/assets/collab/skins'));
const ASH = 'char_456_ash';
const SKIN = 'char_456_ash_rainbow6_1';
const SLOT = 'chess_char_5_diy1_a';
const PICKER = '[data-testid="diy-picker"]';
const HOLD = '[data-testid="dialog-hold-ok"]';

describe('联动干员 skin on the board (real server)', { skip: !ENABLED && 'set SP_E2E=1 (Chrome + the collab pack\'s skins)' }, () => {
  test('pack off: no skin art asked for; on: 灰烬「游侠」 in 自选 → shop → board, drawn in the skin\'s model', { timeout: 6 * 60 * 1000 }, async () => {
    const srv = await startRealServer({ fast: { timerScale: 0.5, combatSpeed: 0.2, startRound: 1, kit: 0, level: 5, shop: [SLOT] } });
    const P = (await import('puppeteer-core')).default;
    const c = new Client(P, srv.base, 'host', { prefix: 'collab-skin' });
    const skinArt = [];
    try {
      await c.open();
      c.page.on('request', (r) => { if (r.url().includes('/collab/skins/')) skinArt.push(r.url()); });
      await c.enter('联动皮肤');
      await c.createCoop('标准模拟');
      await c.click('button', '添加 AI 队友');
      await sleep(600);
      assert.deepEqual(skinArt, [], 'no collab skin art without 联动干员');

      await c.click('.rs-exp');
      await c.page.waitForSelector('#experimental-collab', { visible: true, timeout: 10000 });
      await c.page.click('#experimental-collab');
      await c.page.waitForSelector(HOLD, { visible: true, timeout: 5000 });
      await c.page.waitForFunction((sel) => document.querySelector(sel)?.disabled === false, { timeout: 9000 }, HOLD);
      await c.click(HOLD);
      await c.page.waitForFunction(() => globalThis.__SP__.store.get().room?.experimental?.collabOps === true, { timeout: 8000 });
      await c.click('.room-settings-modal .modal__actions button', '完成');
      await c.page.waitForFunction(() => import('/js/cosmetics.js').then((m) => !!m.cosmetics.collab?.skins), { timeout: 10000 });

      // 自选: 灰烬 with S3, 外观 「游侠」 from the pack
      await c.click('.rs-loadout');
      await c.page.waitForSelector('.lo .lo-tab[data-tab="diy"]', { visible: true, timeout: 15000 });
      await c.click('.lo .lo-tab[data-tab="diy"]');
      await c.page.waitForSelector(`.diy-slot[data-slot="${SLOT}"] .diy-slot__fill`, { visible: true, timeout: 15000 });
      await c.click(`.diy-slot[data-slot="${SLOT}"] .diy-slot__fill`);
      await c.page.waitForSelector(`${PICKER} .diy-opt[data-char="${ASH}"]`, { timeout: 8000 });
      await c.page.$eval(`${PICKER} .diy-opt[data-char="${ASH}"]`, (e) => { e.scrollIntoView({ block: 'center' }); (e.querySelector('.diy-opt__pick') ?? e).click(); });
      await c.page.waitForSelector(`${PICKER} .lo-skill[data-skill="2"]`, { visible: true, timeout: 5000 });
      await c.page.click(`${PICKER} .lo-skill[data-skill="2"]`);
      const btn = `${PICKER} [data-testid="skin-picker"] [data-skin="${SKIN}"]`;
      await c.page.waitForSelector(btn, { timeout: 8000 });
      const offered = await c.page.$eval(btn, (b) => { b.scrollIntoView({ block: 'center' }); return { disabled: b.disabled, text: b.textContent, art: b.querySelector('img')?.getAttribute('src') || '' }; });
      assert.equal(offered.disabled, false, `offered as installed: ${offered.text}`);
      assert.ok(offered.text.includes('游侠') && offered.text.includes('彩虹六号：围攻'), offered.text);
      assert.match(offered.art, /\/collab\/skins\/char_456_ash_rainbow6_1\/portrait\.png$/, 'its half-body art comes from the pack');
      await c.page.click(btn);
      await c.page.waitForFunction((s) => document.querySelector(s)?.getAttribute('aria-checked') === 'true', { timeout: 4000 }, btn);
      await c.page.waitForFunction(() => /外观已同步/.test(document.querySelector('[data-testid="diy-picker"] [data-testid="skin-sync"]')?.textContent || ''), { timeout: 8000 });
      await sleep(800);
      await c.shot('picker');
      await c.click('[data-testid="diy-confirm"]');
      await c.page.waitForFunction((slot, id) => document.querySelector(`.diy-slot[data-slot="${slot}"]`)?.dataset.char === id, { timeout: 4000 }, SLOT, ASH);
      await c.page.waitForFunction(() => /已同步/.test(document.querySelector('[data-testid="diy-sync"]')?.textContent || ''), { timeout: 8000 });
      await c.page.keyboard.press('Escape');
      await c.page.waitForFunction(() => !document.querySelector('.lo'), { timeout: 3000 });

      await c.roomStart({ timeout: 20000 });
      await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 30000);
      await c.settled('.brief-go');
      await c.click('.brief__foot .btn--primary', '准备就绪');
      await c.waitFor((s) => s.phase === 'BAND_DRAFT', 'band draft', 30000);
      await c.click('.dband', null, { nth: 1 });
      await c.click('.draft-detail__btns .btn--primary', '确认选择');
      await c.waitFor((s) => s.phase === 'PREP' && !s.ready && s.funds >= 4 && s.level >= 5, 'prep', 60000);
      await sleep(1800);

      await c.page.waitForSelector('.scard .scard__diy', { visible: true, timeout: 10000 });
      assert.equal(await c.page.evaluate(() => document.querySelector('.scard .scard__diy')?.closest('.scard')?.querySelector('.scard__name')?.textContent), '灰烬');
      await c.click('.scard', '灰烬');
      await sleep(300);
      await c.click('.scard', '灰烬');
      await c.waitFor((s) => s.hand > 0, 'bought', 8000);
      await sleep(900);
      const [piece] = (await c.handPieces('chess')).filter((p) => p.id === SLOT);
      assert.ok(piece, 'in the hand');
      const tile = await c.freeTileFor(piece.uid);
      assert.ok(tile, 'a legal tile');
      await c.drag(await c.piecePoint(piece.uid), await c.tilePoint(tile.row, tile.col));
      await c.page.waitForSelector('.fwheel__dia', { timeout: 4000 });
      await c.swipe('RIGHT');
      await c.waitFor((s) => s.board > 0, 'placed', 8000);

      // her view on the board: the skin's model, loaded from the pack
      const drawn = await c.page.waitForFunction((skin) => {
        const views = globalThis.__SP_VIEW__?.raw?.debug?.views;
        const v = views && [...views.values()].find((x) => x?.info?.skinId === skin);
        const skel = v?.entry?.skel || '';
        return v && v.actor && skel ? { skinId: v.info.skinId, defId: v.info.defId, skel, fallback: !!v.fallback?.visible } : false;
      }, { timeout: 45000, polling: 250 }, SKIN).then((h) => h.jsonValue());
      assert.equal(drawn.skinId, SKIN);
      assert.match(drawn.skel, /\/collab\/skins\/char_456_ash_rainbow6_1\/(front|back)\/char_456_ash_rainbow6_1\.display\.skel$/, `the skin's own model: ${drawn.skel}`);
      assert.equal(drawn.fallback, false, 'the model shows, not the placeholder diamond');
      assert.ok(skinArt.some((u) => u.includes('/collab/skins/char_456_ash_rainbow6_1/')), 'its files came from the pack');
      await sleep(1500);
      await c.shot('board');
      assert.deepEqual(c.problems.filter((p) => p.startsWith('pageerror:')), []);
    } finally {
      await c.close();
      await srv.stop();
    }
  });
});
