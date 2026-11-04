// Real-server browser E2E of rel30's static 调整立绘 (the owner, 2026-11-04; ui/seatLive.js SeatArt): on a seat whose
// 名片干员 wears a static look (精二 here), the owner frames the portrait (drag, zoom), the framing travels with room.card and a
// teammate's page places the picture the same way; 重置 brings both back to the CSS default; 精一 and a skin without a
// 动态立绘 offer the same control, and a look change starts at the default.
//
//   SP_E2E=1 node --test test/ui/seat-art-static.e2e.test.js
//
// Screenshots: test/e2e/out/seatstatic-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client, ROOT, sleep, hasChrome, startRealServer } from '../e2e/client.mjs';

// rel30 HD (hd30's manifest): almost every look draws its HD picture now (ui/seatLive.js); the 180×360 with these maths is
// left for a look without the HD fields (rel31: a scene 精二 draws its whole 立绘 too), e.g. 荆棘 / 雄狮 精二
const assets = JSON.parse(readFileSync(path.join(ROOT, 'data/assets.json'), 'utf8'));
const plainE2 = (c) => !!c?.portraitE2 && (!c.illustrationE2 || !Array.isArray(c.portraitBoxE2));
const CHAR = ['char_1039_thorn2', 'char_373_lionhd', 'char_4010_etlchi', 'char_4138_narant', 'char_103_angel'].find((id) => plainE2(assets.chars[id])) ?? null;
const ENABLED = process.env.SP_E2E === '1' && hasChrome() && !!CHAR && existsSync(path.join(ROOT, `public/assets/char/portrait/${CHAR}_2.png`));

describe('调整立绘 on a static portrait (real server)', { skip: !ENABLED && 'set SP_E2E=1 (Chrome + the portraits installed)' }, () => {
  test('the owner frames the 精二 portrait, the room sees it placed the same, 重置 returns to the default; every look has the control', { timeout: 4 * 60 * 1000 }, async () => {
    const srv = await startRealServer({});
    const P = (await import('puppeteer-core')).default;
    const a = new Client(P, srv.base, 'staticA', { prefix: 'seatstatic', w: 1280, h: 720, prefs: { 'room.card': CHAR, 'room.card.look': '' } });
    const b = new Client(P, srv.base, 'staticB', { prefix: 'seatstatic', w: 1280, h: 720, prefs: {} });
    const MINE = '.rseat.is-me .rseat__art', THEIRS = '.rseat:not(.is-me) .rseat__art';
    const pic = (c, sel) => c.page.$eval(`${sel} > img`, (i) => ({ framed: i.dataset.framed || '', style: i.getAttribute('style') || '', src: i.getAttribute('src') }));
    try {
      await a.open(); await a.enter('静态甲');
      await a.createCoop('标准模拟');
      const code = (await a.st()).room.code;
      await b.open(); await b.enter('静态乙');
      await b.page.evaluate((code) => globalThis.__SP__.net.request('room.join', { code }), code);
      await b.waitFor((s) => s.room?.code === code, 'B in the room');
      await a.page.waitForSelector(`${MINE} > img`, { visible: true, timeout: 15000 });
      await b.page.waitForSelector(`${THEIRS} > img`, { visible: true, timeout: 15000 });
      assert.deepEqual(await pic(a, MINE).then((p) => [p.framed, p.style]), ['', ''], 'the default: the CSS cover, no inline box');
      assert.equal(await a.page.$(`${MINE} > .dyn-cover`), null, 'a static look: no live layer');
      // A frames it: drag, then zoom in twice
      await a.page.hover(MINE);
      await a.page.waitForSelector(`${MINE} [data-testid="seat-frame"]`, { visible: true, timeout: 10000 });
      await a.click(`${MINE} [data-testid="seat-frame"]`);
      const box = await a.page.$eval('[data-testid="seat-framer"]', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 3 }; });
      await a.page.mouse.move(box.x, box.y); await a.page.mouse.down();
      await a.page.mouse.move(box.x - 30, box.y + 40, { steps: 8 }); await a.page.mouse.up();
      await a.click('[data-testid="seat-frame-in"]'); await a.click('[data-testid="seat-frame-in"]');
      await sleep(900);
      await a.click('[data-testid="seat-frame-done"]');
      await a.page.waitForFunction((sel) => document.querySelector(`${sel} > img`)?.dataset.framed === 'art', { timeout: 10000 }, MINE);
      const me = (await a.st()).me;
      const card = await b.page.waitForFunction((id) => { const c = globalThis.__SP__.store.get().room?.seats?.find((s) => s?.playerId === id)?.card; return c?.artZoom > 0 ? c : null; },
        { timeout: 15000 }, me).then((h) => h.jsonValue());
      assert.ok(card.artZoom > 100 && card.artZoom <= 800, `A's framing reached the room: ${JSON.stringify(card)}`);
      assert.equal(card.look, undefined, '精二');
      await b.page.waitForFunction((sel) => document.querySelector(`${sel} > img`)?.dataset.framed === 'art', { timeout: 15000 }, THEIRS);
      const [pa, pb] = [await pic(a, MINE), await pic(b, THEIRS)];
      assert.equal(pb.style, pa.style, 'B places A\'s picture exactly as A does (the same box size)');
      // drawn at the size its style says (the theme's img { max-width: 100% } once squashed a framed picture)
      const drawn = await a.page.$eval(`${MINE} > img`, (i) => [i.getBoundingClientRect().width, parseFloat(i.style.width), i.getBoundingClientRect().height, parseFloat(i.style.height)]);
      assert.ok(Math.abs(drawn[0] - drawn[1]) <= 1 && Math.abs(drawn[2] - drawn[3]) <= 1, `drawn ${drawn}`);
      await a.shot('framed-a'); await b.shot('framed-b');
      // 重置: back to the CSS default for both
      await a.page.hover(MINE);
      await a.click(`${MINE} [data-testid="seat-frame"]`); await a.click('[data-testid="seat-frame-reset"]'); await a.click('[data-testid="seat-frame-done"]');
      await b.page.waitForFunction((sel) => { const i = document.querySelector(`${sel} > img`); return i && !i.dataset.framed && !i.getAttribute('style'); }, { timeout: 15000 }, THEIRS);
      // 精一: the same control; a new look starts at its default
      for (const look of ['e1']) {
        await a.page.evaluate((look) => import('/js/ui/playerCard.js').then((m) => m.setCardLook(look)), look);
        await a.page.waitForFunction((sel) => /_1\.png/.test(document.querySelector(`${sel} > img`)?.getAttribute('src') || ''), { timeout: 10000 }, MINE);
        await a.page.hover(MINE);
        await a.page.waitForSelector(`${MINE} [data-testid="seat-frame"]`, { visible: true, timeout: 10000 });
        assert.equal((await pic(a, MINE)).framed, '', `${look}: the default`);
      }
      for (const c of [a, b]) assert.deepEqual(c.problems.filter((p) => p.startsWith('pageerror:')), []);
    } finally { await a.close(); await b.close(); await srv.stop(); }
  });
});
