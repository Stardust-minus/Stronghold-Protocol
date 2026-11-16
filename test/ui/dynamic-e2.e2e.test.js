// Real-server browser E2E of the operators' own 精二 动态立绘 (2026-11-16, the owner: 「有一部分干员精英II立绘也是动态的，
// 现在没有显示动态，例如塔露拉」; ui/dynamicFraming.js e2Dynamic): with no skin worn, 干员调配's detail (the 精锐 record) plays
// 缪尔赛思's 精二 one in its official portrait crop while the list's 精一 avatar stays static; 「查看立绘」 opens on the default
// look too (精二, live, a static switch); a seat whose 名片干员 is 塔露拉 in 精二 plays hers, framed like the static 精二, and the
// 精二 头像 animates in its avatar crop; 精一 stays static.
//
//   SP_E2E=1 node --test test/ui/dynamic-e2.e2e.test.js
//
// Screenshots: test/e2e/out/dyne2-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client, ROOT, sleep, hasChrome, startRealServer } from '../e2e/client.mjs';

const assets = JSON.parse(readFileSync(path.join(ROOT, 'data/assets.json'), 'utf8'));
const OP = 'chess_char_6_11_a', OP_CHAR = 'char_249_mlyss', CARD = 'char_4247_oxi';
const installed = (id) => !!assets.chars[id]?.dynamicE2 && existsSync(path.join(ROOT, 'public', assets.chars[id].dynamicE2.skel));
const ENABLED = process.env.SP_E2E === '1' && hasChrome() && installed(OP_CHAR) && installed(CARD);
const ART = '.lo-detail .lo-dhead__art [data-testid="dynamic-cover"]';
const SEAT = '.rseat.is-me .rseat__art [data-testid="dynamic-cover"]';
const AVATAR = '.rseat.is-me .avatar [data-testid="dynamic-cover"]';
const frameOf = (c, sel) => c.page.$eval(sel, (el) => JSON.parse(el.dataset.frame));
const near = (a, b) => ['x', 'y', 'width', 'height'].every((k) => Math.abs(a[k] - b[k]) < 1e-6);

describe('精二 动态立绘 (real server)', { skip: !ENABLED && 'set SP_E2E=1 (Chrome + the 精二 动态立绘 installed)' }, () => {
  test('干员调配 detail, 查看立绘 on the default look, the seat card and the 头像 play the 精二 one; 精一 stays static', { timeout: 5 * 60 * 1000 }, async () => {
    const srv = await startRealServer({});
    const P = (await import('puppeteer-core')).default;
    const c = new Client(P, srv.base, 'dyne2', { prefix: 'dyne2', prefs: { 'loadout.view': 'list', 'room.card': CARD, 'room.card.look': '',
      'room.avatar': CARD, 'room.avatar.look': '' } });
    try {
      await c.open();
      await c.enter('精二动态');
      await c.createCoop('标准模拟');
      // the seat card: 塔露拉 精二, live in the official portrait crop (no framing saved)
      await c.page.waitForSelector(`${SEAT}[data-state="ready"]`, { timeout: 60000 });
      assert.ok(near((await frameOf(c, SEAT)).rect, assets.chars[CARD].dynamicE2.frames.portrait), 'the seat: the 精二 portrait crop');
      // the 头像: live in the avatar crop
      await c.page.waitForSelector(`${AVATAR}[data-state="ready"]`, { timeout: 60000 });
      assert.ok(near((await frameOf(c, AVATAR)).rect, assets.chars[CARD].dynamicE2.frames.avatar), 'the 头像: the 精二 avatar crop');
      await sleep(1500);
      await c.shot('seat');
      // 精一: static (no live layer)
      await c.page.evaluate(() => import('/js/ui/playerCard.js').then((m) => m.setCardLook('e1')));
      await c.page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 10000 }, SEAT);

      await c.click('.rs-loadout');
      await c.page.waitForSelector('.lo .lo-card', { visible: true, timeout: 15000 });
      await c.page.$eval(`.lo-card[data-chess="${OP}"]`, (e) => { e.scrollIntoView({ block: 'center' }); e.click(); });
      await c.page.waitForFunction((id) => document.querySelector('.lo-card.is-sel')?.dataset.chess === id, { timeout: 5000 }, OP);
      await c.page.waitForSelector(`${ART}[data-state="ready"]`, { timeout: 60000 });
      assert.ok(near((await frameOf(c, ART)).rect, assets.chars[OP_CHAR].dynamicE2.frames.portrait), 'the detail: the 精二 portrait crop');
      assert.equal(await c.page.$(`.lo-card[data-chess="${OP}"] .lo-card__art [data-testid="dynamic-cover"]`), null, 'the list\'s 精一 avatar: static');
      await sleep(1500);
      await c.shot('operator');

      // 查看立绘 on the default look: the 精二 one, live; the static switch shows the 精二 立绘
      await c.page.$eval('[data-skin="default"] .lo-skin__dynamic', (e) => e.scrollIntoView({ block: 'center' }));
      await c.page.$eval('[data-testid="skins-preview"]', (e) => { e.scrollIntoView({ block: 'center' }); e.click(); });
      const FULL = '.modal [data-testid="dynamic-illustration"]';
      await c.page.waitForSelector(`${FULL}[data-state="ready"]`, { timeout: 60000 });
      await sleep(1200);
      await c.shot('preview');
      await c.page.click('[data-testid="dynamic-toggle"]');
      await c.page.waitForFunction(() => /_2\.png/.test(document.querySelector('.modal .lo-skin-preview img')?.getAttribute('src') || ''), { timeout: 10000 });
      assert.ok(await c.page.$('.lo .lo-card'), '干员调配 still up');
      assert.deepEqual(c.problems.filter((p) => p.startsWith('pageerror:') || /screen crashed/.test(p)), []);
    } finally {
      await c.close();
      await srv.stop();
    }
  });
});
