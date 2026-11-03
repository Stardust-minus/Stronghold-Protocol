// Real-server browser E2E of the shared 动态立绘 renderer (rel27, ui/dynamicStage.js; the owner's decisions of 2026-11-03):
//   - 干员调配 with many operators in skins that have a 动态立绘: every such cell on screen draws its skin live — the list's
//     official avatar crop — and keeps moving; the static picture under each is hidden once its live frame shows; all of
//     it through ONE live WebGL context, and Chrome never warns of too many contexts / a lost one;
//   - the room's seat card: the owner of a seat frames its 名片干员's 动态立绘 (drag, zoom), the framing travels with
//     room.card, and another player in the room sees that same framing;
//   - official dynamic avatars (avatar_dyn_*): a skeleton one plays on the shared renderer, a frame-sequence one as its
//     animated WebP, each over the slot's static picture, which hides.
//
//   SP_E2E=1 node --test test/ui/dynamic-shared.e2e.test.js
//
// Screenshots: test/e2e/out/dynshared-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client, ROOT, sleep, hasChrome, startRealServer } from '../e2e/client.mjs';

const assets = JSON.parse(readFileSync(path.join(ROOT, 'data/assets.json'), 'utf8'));
const chess = JSON.parse(readFileSync(path.join(ROOT, 'data/chess.json'), 'utf8'));
const roster = new Set(Object.values(chess).filter((c) => c && c.charId && !c.isGolden && !c.isHidden && !c.isDiy).map((c) => c.charId));
/** one skin with a 动态立绘 and its crops per operator of the roster, installed here */
const PICKS = new Map();
for (const [id, s] of Object.entries(assets.skins)) {
  if (!s.dynamic?.frames || !roster.has(s.charId) || PICKS.has(s.charId)) continue;
  if (!existsSync(path.join(ROOT, 'public', s.dynamic.skel))) continue;
  PICKS.set(s.charId, id);
}
const SEAT_CHAR = 'char_1045_svash2', SEAT_SKIN = 'char_1045_svash2_sale_20';
const ENABLED = process.env.SP_E2E === '1' && hasChrome() && PICKS.size >= 12 && existsSync(path.join(ROOT, `public/assets/skins/${SEAT_SKIN}/dynamic`));

/** count every canvas that gets a WebGL context, and Chrome's context warnings, from the first script on */
async function watchGl(c) {
  await c.page.evaluateOnNewDocument(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    globalThis.__gl = [];
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      const ctx = orig.call(this, type, ...rest);
      if (ctx && /webgl/i.test(String(type)) && !globalThis.__gl.some((e) => e.canvas === this)) globalThis.__gl.push({ canvas: this, ctx });
      return ctx;
    };
  });
  c.glWarnings = [];
  c.page.on('console', (m) => { if (/webgl/i.test(m.text()) && /context|too many/i.test(m.text())) c.glWarnings.push(m.text()); });
  await c.page.reload({ waitUntil: 'domcontentloaded' });
  await c.page.waitForFunction(() => !!globalThis.__SP__ && !!document.querySelector('.screen'), { timeout: 30000 });
}
/** in page (window.__shown, installed once — the page's CSP forbids eval): whether an element shows, inside the viewport
 * and inside its scrolling ancestors (the list scrolls itself) */
const installShown = (c) => c.page.evaluate(() => {
  globalThis.__shown = (el) => { const r = el.getBoundingClientRect(); let top = Math.max(0, r.top), bot = Math.min(innerHeight, r.bottom);
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (/auto|scroll|hidden/.test(getComputedStyle(p).overflowY)) { const q = p.getBoundingClientRect(); top = Math.max(top, q.top); bot = Math.min(bot, q.bottom); } }
    return bot - top > 4; };
});
/** WebGL contexts alive: `drawing` the ones on a canvas with pixels (Pixi's own capability probes use 0 × 0 canvases, once
 * per page: compressed-format detection, its test context — they never draw and do not grow with the views) */
const liveContexts = (c) => c.page.evaluate(() => { const live = globalThis.__gl.filter((e) => !e.ctx.isContextLost());
  return { all: live.length, drawing: live.filter((e) => e.canvas.width * e.canvas.height > 0).length }; });
const stageContexts = (c) => c.page.evaluate(() => import('/js/ui/dynamicStage.js').then((m) => m.dynamicStage.contexts));
/** a cheap signature of each ready live canvas in `sel` */
const signatures = (c, sel) => c.page.$$eval(`${sel} .dyn-cover[data-state="ready"] canvas`, (list) => list.map((cv) => {
  const g = cv.getContext('2d'); const { width: w, height: h } = cv; if (!w || !h) return null;
  const d = g.getImageData(0, 0, w, h).data; let s = 0; for (let i = 0; i < d.length; i += 97) s = (s * 31 + d[i]) >>> 0;
  return `${w}x${h}:${s}`;
}));

describe('the shared 动态立绘 renderer (real server)', { skip: !ENABLED && 'set SP_E2E=1 (Chrome + installed dynamic illustrations)' }, () => {
  test('干员调配: every dynamic-skin cell on screen animates, its static picture hidden, through one WebGL context', { timeout: 6 * 60 * 1000 }, async () => {
    const srv = await startRealServer({});
    const P = (await import('puppeteer-core')).default;
    const choices = Object.fromEntries(PICKS);
    const c = new Client(P, srv.base, 'dynshared', { prefix: 'dynshared', w: 1600, h: 1000, prefs: { 'loadout.view': 'list', skins: { v: 1, choices } } });
    try {
      await c.open();
      await watchGl(c);
      await c.enter('共享渲染');
      await c.createCoop('标准模拟');
      await c.click('.rs-loadout');
      await c.page.waitForSelector('.lo .lo-card', { visible: true, timeout: 15000 });
      await installShown(c);
      // tier by tier (the tier filter), each list scrolled through: every row whose skin has a 动态立绘 is checked on screen
      let cells = 0, moving = 0, frozen = [], firstCount = null;
      const seen = new Set();
      for (const tier of [6, 5, 4, 3]) {
        await c.click(`.lo-chip--t${tier}`);
        await sleep(400);
        for (let page = 0; page < 8; page++) {
          await c.page.waitForFunction(() => {
            const covers = [...document.querySelectorAll('.lo-card__art .dyn-cover')].filter((el) => globalThis.__shown(el.parentElement));
            return covers.every((el) => el.dataset.state === 'ready' || el.dataset.state === 'fallback');
          }, { timeout: 60000 }).catch(() => {});
          const onScreen = await c.page.$$eval('.lo-card', (rows) => { const shown = globalThis.__shown; return rows.filter((r) => shown(r.querySelector('.lo-card__art') || r))
            .map((r) => ({ id: r.dataset.chess, live: r.querySelector('.lo-card__art .dyn-cover')?.dataset.state || null,
              hidden: (() => { const img = r.querySelector('.lo-card__art > img'); return !img || getComputedStyle(img).visibility === 'hidden'; })() })); });
          const a = await signatures(c, '.lo-card__art');
          await sleep(1200);
          const b = await signatures(c, '.lo-card__art');
          for (const row of onScreen) {
            if (!row.live || seen.has(row.id)) continue;
            seen.add(row.id); cells++;
            assert.equal(row.live, 'ready', `${row.id}: drawn live`);
            assert.ok(row.hidden, `${row.id}: its static picture hidden under the live one`);
          }
          moving += a.filter((x, i) => x && b[i] && x !== b[i]).length;
          frozen = frozen.concat(a.filter((x, i) => x && b[i] && x === b[i]));
          if (tier === 6 && page === 0) { await c.shot('list'); firstCount = await liveContexts(c); }
          const more = await c.page.evaluate(() => {
            const row = document.querySelector('.lo .lo-card'); let el = row?.parentElement;
            while (el && el !== document.body && !(el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
            if (!el || el === document.body) return false;
            const before = el.scrollTop; el.scrollBy(0, el.clientHeight * 0.85); return el.scrollTop > before;
          });
          if (!more) break;
          await sleep(400);
        }
      }
      assert.ok(cells >= 10, `dynamic-skin cells seen live: ${cells}`);
      assert.equal(frozen.length, 0, `every live cell moves between two looks 1.2 s apart (${moving} moved, ${frozen.length} still)`);
      const end = await liveContexts(c);
      assert.equal(end.drawing, 1, `one drawing WebGL context for all of them: ${JSON.stringify(end)}`);
      assert.equal(await stageContexts(c), 1, 'the stage made one renderer');
      assert.equal(end.all, firstCount.all, `no context per view: ${JSON.stringify(firstCount)} after the first page, ${JSON.stringify(end)} after ${cells} cells`);
      assert.deepEqual(c.glWarnings, [], 'no context warnings');
      assert.deepEqual(c.problems.filter((p) => p.startsWith('pageerror:')), []);
    } finally { await c.close(); await srv.stop(); }
  });

  test('the seat card: the owner frames the 动态立绘, the room sees the same framing', { timeout: 5 * 60 * 1000 }, async () => {
    const srv = await startRealServer({});
    const P = (await import('puppeteer-core')).default;
    const a = new Client(P, srv.base, 'seatA', { prefix: 'dynshared', w: 1400, h: 900, prefs: { 'room.card': SEAT_CHAR, 'room.card.look': SEAT_SKIN } });
    const b = new Client(P, srv.base, 'seatB', { prefix: 'dynshared', w: 1400, h: 900, prefs: {} });
    const MINE = '.rseat.is-me .rseat__art > .dyn-cover', THEIRS = '.rseat:not(.is-me) .rseat__art > .dyn-cover';
    const frameOf = (c, sel) => c.page.$eval(sel, (el) => ({ state: el.dataset.state, frame: el.dataset.frame }));
    try {
      await a.open(); await a.enter('取景甲');
      await a.createCoop('标准模拟');
      const code = (await a.st()).room.code;
      await b.open(); await b.enter('取景乙');
      await b.page.evaluate((code) => globalThis.__SP__.net.request('room.join', { code }), code);
      await b.waitFor((s) => s.room?.code === code, 'B in the room');
      await a.page.waitForSelector(`${MINE}[data-state="ready"]`, { timeout: 60000 });
      await b.page.waitForSelector(`${THEIRS}[data-state="ready"]`, { timeout: 60000 });
      const before = await frameOf(a, MINE);
      assert.ok(JSON.parse(before.frame).rect, 'the default: the portrait crop');
      assert.deepEqual(await frameOf(b, THEIRS), before, 'B sees A\'s seat in the same default framing');
      assert.equal(await a.page.$eval('.rseat.is-me .rseat__art > img', (i) => getComputedStyle(i).visibility), 'hidden', 'one framing at a time');
      // A frames it: drag, then zoom in twice
      await a.page.hover('.rseat.is-me .rseat__art');
      await a.click('[data-testid="seat-frame"]');
      const box = await a.page.$eval('[data-testid="seat-framer"]', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 3 }; });
      await a.page.mouse.move(box.x, box.y); await a.page.mouse.down();
      await a.page.mouse.move(box.x - 30, box.y + 40, { steps: 8 }); await a.page.mouse.up();
      await a.click('[data-testid="seat-frame-in"]'); await a.click('[data-testid="seat-frame-in"]');
      await sleep(900);
      await a.click('[data-testid="seat-frame-done"]');
      const mine = await a.page.waitForFunction((sel, was) => { const el = document.querySelector(sel); return el && el.dataset.frame !== was && JSON.parse(el.dataset.frame).art ? el.dataset.frame : null; },
        { timeout: 10000 }, MINE, before.frame).then((h) => h.jsonValue());
      const art = JSON.parse(mine).art;
      assert.ok(art.zoom > 100 && art.zoom <= 2500, `A's framing: ${mine}`);
      const theirs = await b.page.waitForFunction((sel, want) => document.querySelector(sel)?.dataset.frame === want, { timeout: 15000 }, THEIRS, mine).then(() => true).catch(() => false);
      assert.ok(theirs, `B sees A's framing: ${JSON.stringify(await frameOf(b, THEIRS))} vs ${mine}`);
      const seatCard = await b.page.evaluate((id) => globalThis.__SP__.store.get().room?.seats?.find((s) => s?.playerId === id)?.card, (await a.st()).me);
      assert.deepEqual([seatCard.artX, seatCard.artY, seatCard.artZoom], [art.x, art.y, art.zoom], 'room.state carries it');
      await a.shot('seat-a'); await b.shot('seat-b');
      // 重置: back to the crop for both
      await a.click('[data-testid="seat-frame"]'); await a.click('[data-testid="seat-frame-reset"]'); await a.click('[data-testid="seat-frame-done"]');
      await b.page.waitForFunction((sel) => { const f = document.querySelector(sel)?.dataset.frame; return f && JSON.parse(f).rect; }, { timeout: 15000 }, THEIRS);
      for (const c of [a, b]) assert.deepEqual(c.problems.filter((p) => p.startsWith('pageerror:')), []);
    } finally { await a.close(); await b.close(); await srv.stop(); }
  });

  test('official dynamic avatars: the lobby chip plays a skeleton avatar live and a sequence avatar, the static hidden', { timeout: 3 * 60 * 1000,
    skip: !existsSync(path.join(ROOT, 'public/assets/local/ui/avatar_dyn/avatar_dyn_01/avatar.json')) && 'the official dynamic avatars installed' }, async () => {
    const srv = await startRealServer({});
    const P = (await import('puppeteer-core')).default;
    const CHIP = '.me-chip .avatar__img';
    try {
      for (const [id, sel] of [['avatar_dyn_01', `${CHIP} > .dyn-cover[data-state="ready"]`], ['avatar_dyn_05', `${CHIP} > .dyn-seq[data-state="ready"]`]]) {
        const c = new Client(P, srv.base, `ava-${id}`, { prefix: 'dynshared', w: 1280, h: 800, prefs: { 'room.avatar': id } });
        try {
          await c.open(); await c.enter(`头像${id.slice(-2)}`);
          await c.page.waitForSelector(sel, { timeout: 60000 });
          assert.equal(await c.page.$eval(`${CHIP} > img:not(.dyn-seq)`, (i) => getComputedStyle(i).visibility), 'hidden', `${id}: the static picture hidden`);
          await sleep(800);
          await c.shot(`avatar-${id}`);
          assert.deepEqual(c.problems.filter((p) => p.startsWith('pageerror:')), []);
        } finally { await c.close(); }
      }
    } finally { await srv.stop(); }
  });
});
