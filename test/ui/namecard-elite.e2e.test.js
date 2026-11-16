// Real-server browser E2E of 名片底图's operator pictures (the owner's decision of 2026-11-16: 「名片为啥没办法选塔露拉」): the
// picker groups every operator — 默认, 精二, its skins — and finds 塔露拉 by name; her 精二 card plays her 精二 动态立绘 on
// my seat plate and on a teammate's screen (room.card), framed at the 精二 default; a 默认 card is a still picture.
//
//   SP_E2E=1 node --test test/ui/namecard-elite.e2e.test.js
//
// Needs Chrome and 塔露拉's 精二 立绘 + 动态立绘 and 能天使's 默认 立绘 on disk (git-ignored art). Screenshots: test/e2e/out/ncelite-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client, ROOT, sleep, hasChrome, startRealServer } from '../e2e/client.mjs';
import { namecardArtGroups, charCardId, NAMECARD_DEFAULT_Y } from '../../public/js/ui/namecards.js';

const assets = JSON.parse(readFileSync(path.join(ROOT, 'data/assets.json'), 'utf8'));
const OXI = 'char_4247_oxi', ANGEL = 'char_103_angel';
const onDisk = (u) => typeof u === 'string' && existsSync(path.join(ROOT, 'public', u));
const ENABLED = process.env.SP_E2E === '1' && hasChrome() && onDisk(assets.chars[OXI]?.illustrationE2) && onDisk(assets.chars[OXI]?.dynamicE2?.skel)
  && onDisk(assets.chars[ANGEL]?.illustration);
const MY_PLATE = '.rseat.is-me .rseat__plate';
const LIVE = '.nc-layer [data-testid="dynamic-cover"][data-state="ready"]';
const plateOf = (c, sel) => c.page.$eval(sel, (el) => {
  const layer = el.querySelector('.nc-layer');
  return { nc: el.classList.contains('has-nc'), style: layer?.getAttribute('style') || '', live: !!el.querySelector('.nc-layer [data-testid="dynamic-cover"]') };
});

describe('名片底图: operators\' own 立绘 (real server)', { skip: !ENABLED && 'set SP_E2E=1 (Chrome + 塔露拉\'s 精二 立绘 / 动态立绘 and 能天使\'s 默认 立绘)' }, () => {
  test('pick 塔露拉 精二 by name: live on my plate and on a teammate\'s; a 默认 card is still', { timeout: 6 * 60 * 1000 }, async () => {
    const srv = await startRealServer({});
    const P = (await import('puppeteer-core')).default;
    const host = new Client(P, srv.base, 'host', { prefix: 'ncelite-host' });
    const guest = new Client(P, srv.base, 'guest', { prefix: 'ncelite-guest' });
    try {
      await host.open();
      await host.enter('名片博士');
      const room = await host.createCoop('标准模拟');

      // the picker: one group per operator with art (the same groups as the module computes from the served index)
      await host.click(`.rseat.is-me .rseat__bg`);
      await host.page.waitForSelector('.nc-pick__op', { visible: true, timeout: 15000 });
      const want = namecardArtGroups(assets);
      // the first groups at once, the rest a few frames later
      await host.page.waitForFunction((n) => document.querySelectorAll('.nc-pick__op').length === n, { timeout: 10000 }, want.length);
      assert.equal(await host.page.$$eval('.nc-pick__op [data-nc]', (els) => els.length), want.reduce((n, g) => n + g.tiles.length, 0), 'every tile');
      await host.shot('picker');

      // 塔露拉 by name: her group alone, 默认 and 精二 (the 精二 one marked 动态立绘), half-body art
      await host.page.type('.nc-pick__search', '塔露拉');
      await host.page.waitForFunction(() => document.querySelectorAll('.nc-pick__op').length === 1, { timeout: 5000 });
      const tiles = await host.page.$$eval('.nc-pick__op [data-nc]', (els) => els.map((e) => ({ id: e.dataset.nc, img: e.querySelector('img')?.getAttribute('src') || '',
        dyn: !!e.querySelector('.nc-pick__dyn') })));
      assert.deepEqual(tiles.map((x) => [x.id, x.dyn]), [[charCardId(OXI, false), false], [charCardId(OXI, true), true]]);
      assert.match(tiles[0].img, /char_4247_oxi_1\.png$/); assert.match(tiles[1].img, /char_4247_oxi_2\.png$/);
      await host.shot('picker-oxi');

      // pick her 精二: the framing view, live
      await host.page.$eval(`[data-nc="${charCardId(OXI, true)}"]`, (e) => { e.scrollIntoView({ block: 'center' }); e.click(); });
      await host.page.waitForSelector(`[data-testid="nc-adjust-plate"] ${LIVE}`, { timeout: 60000 });
      await sleep(1200);
      await host.shot('adjust-oxi');
      await host.click('[data-testid="nc-adjust-done"]');
      await host.page.waitForSelector('.nc-pick', { hidden: true, timeout: 5000 });
      assert.equal(await host.page.evaluate(() => import('/js/ui/playerCard.js').then((m) => m.cardStore.get().bg)), charCardId(OXI, true));

      // my seat plate: her 精二 立绘, at the 精二 default height, then live
      await host.page.waitForSelector(`${MY_PLATE} ${LIVE}`, { timeout: 60000 });
      const mine = await plateOf(host, MY_PLATE);
      assert.ok(mine.nc && /char_4247_oxi_2\.png/.test(mine.style) && new RegExp(`--nc-y:\\s*${NAMECARD_DEFAULT_Y.charE2}%`).test(mine.style), mine.style);
      await sleep(1500);
      await host.shot('seat-oxi');

      // a teammate sees it (room.card → room.state seats[].card), live too
      await guest.open(`?room=${room.code}`);
      await guest.enter('队友博士');
      await guest.waitFor((s) => s.room?.code === room.code, 'guest joined');
      const HOST_PLATE = '.rseat:not(.is-me):not(.is-bot):not(.rseat--empty) .rseat__plate.has-nc';
      await guest.page.waitForSelector(`${HOST_PLATE} ${LIVE}`, { timeout: 60000 });
      assert.match((await plateOf(guest, HOST_PLATE)).style, /char_4247_oxi_2\.png/);
      await sleep(1500);
      await guest.shot('teammate-oxi');

      // a 默认 card: 能天使's own 立绘, still, at the 默认 default height; the teammate follows
      await host.click(`.rseat.is-me .rseat__bg`);
      await host.page.waitForSelector('.nc-pick__search', { visible: true, timeout: 15000 });
      await host.page.type('.nc-pick__search', '能天使');
      await host.page.waitForFunction((id) => document.querySelectorAll('.nc-pick__op').length === 2 && !!document.querySelector(`[data-nc="${id}"]`),
        { timeout: 5000 }, charCardId(ANGEL, false));
      await host.shot('picker-angel');
      await host.page.$eval(`[data-nc="${charCardId(ANGEL, false)}"]`, (e) => { e.scrollIntoView({ block: 'center' }); e.click(); });
      await host.page.waitForSelector('[data-testid="nc-adjust-done"]', { visible: true, timeout: 10000 });
      await host.click('[data-testid="nc-adjust-done"]');
      await host.page.waitForFunction((sel) => /char_103_angel_1\.png/.test(document.querySelector(`${sel} .nc-layer`)?.getAttribute('style') || ''), { timeout: 10000 }, MY_PLATE);
      await sleep(800);
      const still = await plateOf(host, MY_PLATE);
      assert.equal(still.live, false, 'a 默认 card has no live layer');
      assert.ok(new RegExp(`--nc-y:\\s*${NAMECARD_DEFAULT_Y.char}%`).test(still.style), still.style);
      await guest.page.waitForFunction((sel) => /char_103_angel_1\.png/.test(document.querySelector(`${sel} .nc-layer`)?.getAttribute('style') || ''), { timeout: 15000 }, HOST_PLATE);
      await host.shot('seat-angel-default');
      await guest.shot('teammate-angel-default');

      for (const c of [host, guest]) assert.deepEqual(c.problems.filter((p) => p.startsWith('pageerror:') || /screen crashed/.test(p)), [], c.label);
    } finally {
      await host.close();
      await guest.close();
      await srv.stop();
    }
  });
});
