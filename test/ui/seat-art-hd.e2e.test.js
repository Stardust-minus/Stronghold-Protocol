// Real-server browser E2E of rel30's HD portraits (the owner's 「来点高清立绘」; ui/seatLive.js SeatArt, ui/assetUrls.js
// portraitChain), for an operator whose manifest entry has the HD fields (illustrationE2 / portraitBoxE2 / portraitHDE2)
// with the files installed — skipped otherwise:
//   - the seat card draws the illustration placed so that its portrait box sits exactly where the 180×360 sits (cover at
//     50% 12%), the 180×360 hidden once it has loaded; a framing pans it and a teammate places it the same;
//   - a page whose illustration request fails shows the 180×360 on the same box (the framing's meaning kept);
//   - 干员调配's card view draws the HD crop (lazy, decoded async).
//
//   SP_E2E=1 node --test test/ui/seat-art-hd.e2e.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client, ROOT, sleep, hasChrome, startRealServer } from '../e2e/client.mjs';

const assets = JSON.parse(readFileSync(path.join(ROOT, 'data/assets.json'), 'utf8'));
const onDisk = (u) => typeof u === 'string' && existsSync(path.join(ROOT, 'public', u));
const CHAR = Object.entries(assets.chars).find(([, c]) => Array.isArray(c.portraitBoxE2) && !c.portraitSceneE2 && onDisk(c.illustrationE2) && onDisk(c.portraitHDE2) && onDisk(c.portraitE2))?.[0];
/** a scene 精二 and a static scene skin with their 立绘 installed (rel31: the seat draws the whole 立绘, scene included) */
const SCENE_E2 = Object.entries(assets.chars).find(([, c]) => c.portraitSceneE2 === true && Array.isArray(c.portraitBoxE2) && onDisk(c.portraitE2) && onDisk(c.illustrationE2))?.[0];
const SCENE_SKIN = Object.entries(assets.skins).find(([, s]) => s.portraitScene === true && !s.dynamic && Array.isArray(s.portraitBox) && onDisk(s.portrait) && onDisk(s.illustration))?.[0];
const ENABLED = process.env.SP_E2E === '1' && hasChrome() && !!CHAR;

describe('HD portraits (real server)', { skip: !ENABLED && 'set SP_E2E=1 (Chrome + an operator with the HD fields installed)' }, () => {
  test('the seat card: the illustration lands on the 180×360\'s place, frames, syncs; a failed illustration falls back in place', { timeout: 4 * 60 * 1000 }, async () => {
    const srv = await startRealServer({});
    const P = (await import('puppeteer-core')).default;
    const c = assets.chars[CHAR];
    const a = new Client(P, srv.base, 'hdA', { prefix: 'seathd', w: 1280, h: 720, prefs: { 'room.card': CHAR, 'room.card.look': '', 'loadout.view': 'deck' } });
    const b = new Client(P, srv.base, 'hdB', { prefix: 'seathd', w: 1280, h: 720, prefs: {} });
    const d = new Client(P, srv.base, 'hdC', { prefix: 'seathd', w: 1280, h: 720, prefs: {} });
    const MINE = '.rseat.is-me .rseat__art', THEIRS = '.rseat:not(.is-me) .rseat__art';
    // the illustration's portrait box in box px and where the 180×360's CSS cover puts the portrait — layout offsets (a
    // page that just opened still runs the seats' entrance animation, a transform that client rects include)
    const geometry = (cl, sel, box) => cl.page.$eval(sel, (art, box) => {
      const hd = art.querySelector(':scope > img.rseat__hd'), sd = art.querySelector(':scope > img:not(.rseat__hd)');
      const bw = art.clientWidth, bh = art.clientHeight;
      const rect = (i) => ({ x: i.offsetLeft, y: i.offsetTop, width: i.offsetWidth, height: i.offsetHeight });
      const r = { x: 0, y: 0 }, hr = hd ? rect(hd) : null, sr = rect(sd);
      const s = Math.max(bw / 180, bh / 360);
      return { hd: hd ? { state: hd.dataset.state, vis: getComputedStyle(hd).visibility, style: hd.getAttribute('style'),
        box: [hr.x - r.x + box[0] * hr.width, hr.y - r.y + box[1] * hr.height, box[2] * hr.width, box[3] * hr.height] } : null,
        sd: { vis: getComputedStyle(sd).visibility, style: sd.getAttribute('style') || '', box: [sr.x - r.x, sr.y - r.y, sr.width, sr.height] },
        cover: [(bw - 180 * s) * 0.5, (bh - 360 * s) * 0.12, 180 * s, 360 * s], size: [bw, bh] };
    }, box);
    try {
      await a.open(); await a.enter('高清甲');
      await a.createCoop('标准模拟');
      const code = (await a.st()).room.code;
      await a.page.waitForSelector(`${MINE} > img.rseat__hd[data-state="ready"]`, { timeout: 30000 });
      await sleep(400);
      const g = await geometry(a, MINE, c.portraitBoxE2);
      assert.equal(g.sd.vis, 'hidden', 'the 180×360 hides once the illustration is in');
      g.hd.box.forEach((v, i) => assert.ok(Math.abs(v - g.cover[i]) <= 1, `the box lands on the 180×360's place: ${g.hd.box} vs ${g.cover}`));
      // frame it: drag, zoom in twice
      await a.page.hover(MINE);
      await a.click(`${MINE} [data-testid="seat-frame"]`);
      const pt = await a.page.$eval('[data-testid="seat-framer"]', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 3 }; });
      await a.page.mouse.move(pt.x, pt.y); await a.page.mouse.down(); await a.page.mouse.move(pt.x + 60, pt.y + 30, { steps: 8 }); await a.page.mouse.up();
      await a.click('[data-testid="seat-frame-in"]'); await a.click('[data-testid="seat-frame-in"]');
      await sleep(900);
      await a.click('[data-testid="seat-frame-done"]');
      await a.page.waitForFunction((sel) => document.querySelector(`${sel} > img.rseat__hd`)?.dataset.framed === 'art', { timeout: 10000 }, MINE);
      const mine = (await geometry(a, MINE, c.portraitBoxE2)).hd.style;
      // a teammate places it the same
      await b.open(); await b.enter('高清乙');
      await b.page.evaluate((code) => globalThis.__SP__.net.request('room.join', { code }), code);
      await b.page.waitForFunction((sel, want) => document.querySelector(`${sel} > img.rseat__hd[data-state="ready"]`)?.getAttribute('style') === want, { timeout: 30000 }, THEIRS, mine);
      // a page whose illustration fails: the 180×360 alone, on the box it has in the illustration
      await d.open();
      // the 立绘 only (the 180×360 and the HD crop share its file name), past the service worker
      const blocked = c.illustrationE2.split('/').slice(-2).join('/');
      await d.page.setBypassServiceWorker(true);
      await d.page.setRequestInterception(true);
      d.page.on('request', (r) => (r.url().endsWith(blocked) ? r.abort() : r.continue()));
      await d.page.reload({ waitUntil: 'domcontentloaded' });
      await d.page.waitForFunction(() => !!globalThis.__SP__ && !!document.querySelector('.screen'), { timeout: 30000 });
      await d.enter('高清丙');
      await d.page.evaluate((code) => globalThis.__SP__.net.request('room.join', { code }), code);
      await d.page.waitForFunction((sel) => { const art = document.querySelector(sel); return art && !art.querySelector(':scope > img.rseat__hd') && art.querySelector(':scope > img')?.dataset.framed === 'art'; },
        { timeout: 30000 }, THEIRS);
      const gd = await geometry(d, THEIRS, c.portraitBoxE2), gb = await geometry(b, THEIRS, c.portraitBoxE2);
      assert.equal(gd.sd.vis, 'visible');
      // the same seat seen from two pages with the same seat size: where B's 立绘 puts the box, D's 180×360 is
      assert.deepEqual(gd.size, gb.size, 'the same seat size');
      const cardOf = (cl) => cl.page.evaluate(() => { const s = globalThis.__SP__.store.get(); const x = s.room.seats.find((q) => q && q.playerId !== s.me.playerId && q.card?.charId); return x && [x.name, x.card.artX, x.card.artY, x.card.artZoom]; });
      const why = JSON.stringify({ b: await cardOf(b), d: await cardOf(d), bStyle: gb.hd.style, dStyle: gd.sd.style });
      gd.sd.box.forEach((v, i) => assert.ok(Math.abs(v - gb.hd.box[i]) <= 1, `fallback on the same box: ${gd.sd.box} vs ${gb.hd.box} ${why}`));
      await a.shot('framed-a'); await d.shot('fallback-c');
      // 干员调配: the card view draws the HD crop
      await a.click('.rs-loadout');
      await a.page.waitForSelector('.lo .lo-op', { visible: true, timeout: 15000 });
      // any operator of the deck with an HD crop (the seat's operator may not be in this pool)
      const tails = Object.values(assets.chars).flatMap((x) => [x.portraitHD, x.portraitHDE2]).filter(onDisk).map((u) => u.split('/').slice(-2).join('/'));
      const card = await a.page.waitForFunction((tails) => [...document.querySelectorAll('.lo .lo-op__art img')].find((i) => tails.some((t) => (i.getAttribute('src') || '').endsWith(t))) ? true : null,
        { timeout: 15000 }, tails).then(() => true).catch(() => false);
      assert.ok(card, 'a card shows the HD crop');
      const attrs = await a.page.$eval('.lo .lo-op__art img', (i) => [i.getAttribute('loading'), i.getAttribute('decoding')]);
      assert.deepEqual(attrs, ['lazy', 'async']);
      // rel31 (the owner of 11-04: 「一直用整张原画」): a scene look draws its whole 立绘 too, its box on the 180×360's place,
      // and frames in it (zooming out below its default); a frame saved before rel31 is dropped once on a static scene
      // look and kept on a look without a scene
      await a.page.keyboard.press('Escape');
      await a.page.waitForFunction(() => !document.querySelector('.lo'), { timeout: 5000 });
      const LEGACY = { x: 480, y: 300, zoom: 260 };
      const myArt = () => a.page.evaluate(() => import('/js/ui/playerCard.js').then((m) => { const s = m.cardStore.get(); return [s.art, s.artSpace]; }));
      const injectLegacy = (art) => a.page.evaluate((art) => import('/js/ui/playerCard.js').then((m) => { m.cardStore.set({ art, artSpace: 0 }); }), art);
      await injectLegacy(LEGACY);
      await sleep(1500);
      assert.deepEqual((await myArt())[0], LEGACY, 'a pre-rel31 frame on a look without a scene: kept');
      const scenes = [SCENE_E2 && [SCENE_E2, '', assets.chars[SCENE_E2].illustrationE2, assets.chars[SCENE_E2].portraitBoxE2],
        SCENE_SKIN && [assets.skins[SCENE_SKIN].charId, SCENE_SKIN, assets.skins[SCENE_SKIN].illustration, assets.skins[SCENE_SKIN].portraitBox]].filter(Boolean);
      assert.ok(scenes.length, 'a scene 精二 or a scene skin with its 立绘 installed');
      for (const [ch, look, ill, box] of scenes) {
        await a.page.evaluate((ch, look) => import('/js/ui/playerCard.js').then((m) => { m.setCardOperator(ch); m.setCardLook(look); }), ch, look);
        const tail = ill.split('/').slice(-2).join('/');
        await a.page.waitForFunction((sel, tail) => { const i = document.querySelector(`${sel} > img.rseat__hd`); return i && i.dataset.state === 'ready' && (i.getAttribute('src') || '').endsWith(tail); },
          { timeout: 30000 }, MINE, tail);
        await sleep(400);
        const gs = await geometry(a, MINE, box);
        gs.hd.box.forEach((v, i) => assert.ok(Math.abs(v - gs.cover[i]) <= 1, `${ch} '${look}': the box lands on the 180×360's place: ${gs.hd.box} vs ${gs.cover}`));
        await injectLegacy(LEGACY);
        const t0 = Date.now();
        while ((await myArt())[0] && Date.now() - t0 < 8000) await sleep(200);
        assert.deepEqual(await myArt(), [null, 0], `${ch} '${look}': a pre-rel31 frame on a scene look is dropped`);
        // zoom out below the default
        await a.page.hover(MINE);
        await a.click(`${MINE} [data-testid="seat-frame"]`);
        const zoomText = () => a.page.$eval('[data-testid="seat-frame-zoom"]', (el) => parseInt(el.textContent, 10));
        assert.equal(await zoomText(), 100);
        assert.equal(await a.page.$eval('[data-testid="seat-frame-out"]', (el) => el.disabled), false, 'zoom out is enabled at the default');
        await a.click('[data-testid="seat-frame-out"]'); await a.click('[data-testid="seat-frame-out"]');
        await sleep(900);
        assert.ok((await zoomText()) < 100, `${ch} '${look}': zoomed out below the default (${await zoomText()}%)`);
        const [saved, space] = await myArt();
        assert.ok(saved && space === 31, `saved with the rel31 space mark: ${JSON.stringify([saved, space])}`);
        await a.click('[data-testid="seat-frame-done"]');
        await a.shot(`scene-${look || 'e2'}-zoomed-out`);
      }
      for (const cl of [a, b, d]) assert.deepEqual(cl.problems.filter((p) => p.startsWith('pageerror:')), []);
    } finally { await a.close(); await b.close(); await d.close(); await srv.stop(); }
  });
});
