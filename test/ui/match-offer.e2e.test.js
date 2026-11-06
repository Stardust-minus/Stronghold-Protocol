// Browser E2E of 确认入场, the full-screen takeover (ui/matchOffer.js OfferTakeover, ui/offerCues.js, ui/offerSynth.js;
// 2026-11-05, the user: 「匹配到人之后需要添加动效和音效。重写现在的静态确认页面」; docs/history/0.3.3.md 「匹配成功确认页」) with
// real offers (real server, headless Chrome, a 14 s confirmation window):
//   desk   1920×1080 — the entrance frame by frame (every animation held at the same instants), a teammate's accept, the
//                      last five seconds (urgent, ticking), my accept (Enter on the focused button), everyone in → 搜寻成功
//                      kept over the room, the cues in order; behind another tab the audio stays awake for the offer;
//   desk20 1920×1080 — a 20-seat offer: two rows; leaving by choice cuts away;
//   room   1280×720  — a friend room's party queue: the takeover over the room, confirmed into the game;
//   phone  844×390   — it fits without scrolling; a teammate leaves after my accept and 本次匹配未成立 shows the reason before
//                      搜寻中; 390×844 portrait fits too.
//
//   SP_E2E=1 node --test test/ui/match-offer.e2e.test.js
//
// Screenshots: test/e2e/out/offer-*.png (SP_SHOTS=<dir> elsewhere).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MATCHMAKING_VERSION } from '../../shared/constants.js';
import { PLAYER_CAPACITY_VERSION } from '../../shared/playerCapacity.js';
import { TestClient } from '../helpers/wsClient.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.SP_SHOTS || path.join(ROOT, 'test/e2e/out');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const ACCEPT_MS = 14_000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const CUES = ['offer:arrive', 'offer:peer', 'offer:mine', 'offer:tick', 'offer:allReady', 'offer:broken'];

describe('确认入场 takeover with real offers (real server, headless Chrome)', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv, browser;
  const errors = [], clients = [];
  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, matchmaking: { acceptMs: ACCEPT_MS } });
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
    mkdirSync(OUT, { recursive: true });
  });
  after(async () => { for (const c of clients) c.ws.terminate(); await browser?.close(); await srv?.close(); });

  async function open(name, viewport) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport(viewport);
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    // a doctor with a picked avatar and 名片 (ui/playerCard.js): the takeover's own slot shows them
    await page.evaluateOnNewDocument((n) => {
      localStorage.setItem('sp.name', n); sessionStorage.setItem('sp.entered', '1');
      localStorage.setItem('sp.pref.room.avatar', JSON.stringify('char_003_kalts'));
      localStorage.setItem('sp.pref.room.namecard', JSON.stringify('camp:rhine'));
      localStorage.setItem('sp.pref.room.card', JSON.stringify('char_010_chen'));
    }, name);
    await page.goto(`http://127.0.0.1:${srv.port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__SP__?.store.get().connection.status === 'online' && !!document.querySelector('.lobby-screen .hub-entries'), { timeout: 60000 });
    const board = await page.waitForSelector('.announcement-board', { visible: true, timeout: 2500 }).catch(() => null);
    if (board) {
      await page.click('.announcement-board .modal__actions button');
      await page.waitForSelector('.announcement-board', { hidden: true, timeout: 10000 });
    }
    // every code-drawn cue the page plays, in order (ui/offerCues.js → audio.synth)
    await page.evaluate(() => {
      const a = globalThis.__SP__.audio, orig = a.synth.bind(a);
      globalThis.__cues = [];
      a.synth = (build, v, name) => { globalThis.__cues.push(name); return orig(build, v, name); };
    });
    return page;
  }
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, `offer-${name}.png`) });
  const settle = (page) => page.waitForFunction(() => !document.getAnimations()
    .some((a) => /^(tr|ps|mo)-/.test(String(a.animationName)) && a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity
      && a.animationName !== 'mo-drain'), { timeout: 15000 });
  const cues = (page) => page.evaluate((known) => globalThis.__cues.filter((n) => known.includes(n)), CUES);
  /** Every animation of the takeover held at `ms` after it began (the entrance frame by frame), or let go (null). */
  const hold = (page, ms) => page.evaluate((t) => {
    for (const a of document.getAnimations()) {
      const el = a.effect?.target;
      if (!el?.closest?.('.mo')) continue;
      if (t == null) { a.play(); continue; }
      a.pause();
      // (a kept moment's own fade-out stays at its start: the frame is of the moment, not of its exit)
      a.currentTime = a.animationName === 'mo-veil-out' ? 0 : t;
    }
  }, ms);
  const openMatch = async (page) => {
    await page.evaluate(() => [...document.querySelectorAll('.hub-entries button')].find((b) => b.textContent.startsWith('ALLIANCE')).click());
    await page.waitForSelector('[data-testid="room-list-open"]', { visible: true, timeout: 15000 });
    await settle(page);
    await page.evaluate(() => [...document.querySelectorAll('.ally-pill')].at(-1).click());
    await page.waitForSelector('[data-testid="match-scope"]', { visible: true, timeout: 15000 });
    await settle(page);
  };
  /** The earlier tests' lone tickets leave the queue (a failed test must not hand its leftovers to the next one). */
  const dropClients = async () => { for (const c of clients.splice(0)) c.ws.terminate(); await wait(300); };
  const lone = async (name, difficulty, capacities = [4]) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`, { timeout: 15000 });
    clients.push(c);
    await c.hello(name, undefined, { matchmakingVersion: MATCHMAKING_VERSION, playerCapacityVersion: PLAYER_CAPACITY_VERSION });
    assert.equal((await c.request({ t: 'queue.join', difficulty, capacities, rules: ['standard'] })).t, 'ok');
    return c;
  };
  const accept = async (c) => {
    const s = await c.waitFor('queue.state', (m) => m.state === 'offered');
    assert.equal((await c.request({ t: 'queue.accept', ticketId: s.ticketId, offerId: s.offerId })).t, 'ok');
  };
  const count = (page) => page.$eval('[data-testid="offer-count"]', (el) => el.textContent);
  /** Every part of the takeover inside the viewport; the stage no taller than the screen. */
  const fits = (page) => page.evaluate(() => {
    const mo = document.querySelector('[data-testid="match-offer"]');
    const out = [];
    const st = mo.querySelector('.mo__stage').getBoundingClientRect();
    if (st.height > innerHeight + 1 || st.width > innerWidth + 1) out.push(`stage ${Math.round(st.width)}×${Math.round(st.height)} > ${innerWidth}×${innerHeight}`);
    for (const el of mo.querySelectorAll('.mo__plate, .mo__title, .mo-seat, .mo__timer, .mo__act .btn, .mo__wait, .mo__chips')) {
      const r = el.getBoundingClientRect();
      if (!(r.top >= -1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.right <= innerWidth + 1 && r.width > 0)) out.push(`outside: ${el.className} ${Math.round(r.top)}..${Math.round(r.bottom)}`);
    }
    if (document.scrollingElement.scrollHeight > innerHeight + 1) out.push('the page scrolls');
    return out;
  });

  test('desk: the entrance frame by frame, a teammate, the last seconds, my accept, everyone in → 搜寻成功, with the cues', async () => {
    await dropClients();
    const me = await open('确认博士', { width: 1920, height: 1080, deviceScaleFactor: 1 });
    await openMatch(me);
    await me.click('.proto-start');
    await me.waitForFunction(() => globalThis.__SP__.store.get().queue?.state === 'queued', { timeout: 15000 });
    const q = await me.evaluate(() => globalThis.__SP__.store.get().queue);
    // behind another tab: the context suspends as it always did …
    await me.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await wait(300);
    const ctxBefore = await me.evaluate(() => globalThis.__SP__.audio.ctx?.state ?? 'none');
    const mates = [];
    for (let i = 0; i < 3; i++) mates.push(await lone(`队友${i}`, q.difficulty));
    await me.waitForSelector('[data-testid="match-offer"]', { timeout: 20000 });
    await hold(me, 0);
    await wait(200);
    // … and an offer keeps it awake there (the arrival is heard)
    const ctxHeld = await me.evaluate(() => globalThis.__SP__.audio.ctx?.state ?? 'none');
    if (ctxBefore !== 'none') {
      assert.equal(ctxBefore, 'suspended');
      assert.equal(ctxHeld, 'running');
    }
    await me.evaluate(() => { delete document.hidden; delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
    assert.deepEqual(await cues(me), ['offer:arrive']);
    // the entrance, frame by frame: the block opening, the glitch, the slam, the wave, the countdown, at rest
    for (const [ms, label] of [[90, 'a-block'], [200, 'b-glitch'], [360, 'c-slam'], [470, 'd-wave'], [640, 'e-rise'], [1100, 'f-rest']]) {
      await hold(me, ms);
      await wait(60);
      await shot(me, `desk-0${label}`);
    }
    await hold(me, null);
    await settle(me);
    await shot(me, 'desk-1-offer');
    assert.equal(await me.$eval('[data-testid="match-offer"]', (el) => el.dataset.playerCapacity), '4');
    assert.match(await count(me), /0 \/ 4/);
    assert.deepEqual(await fits(me), []);
    assert.equal(await me.evaluate(() => document.activeElement?.dataset?.testid), 'offer-accept', 'the hero button has the focus');
    // the cards take the screen, 1:2 like a 立绘; nobody confirmed: my 名片 and avatar, silhouettes, no picture
    const box = await me.$eval('[data-testid="offer-seat-me"]', (el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; });
    assert.ok(box.h >= 560 && Math.abs(box.h / box.w - 2) < 0.05, JSON.stringify(box));
    assert.equal(await me.$$eval('[data-testid="offer-seat-art"]', (els) => els.length), 0);
    assert.ok(await me.$('[data-testid="offer-seat-me"] .avatar'));
    assert.equal(await me.$$eval('.mo-seat__sil', (els) => els.length), 3);
    assert.equal((await mates[0].request({ t: 'room.card', charId: 'char_003_kalts', look: 'e1', artX: 500, artY: 300, artZoom: 180 })).t, 'ok');
    await accept(mates[0]);
    await me.waitForFunction(() => /1 \/ 4/.test(document.querySelector('[data-testid="offer-count"]')?.textContent || ''), { timeout: 10000 });
    await wait(120);
    await shot(me, 'desk-2-teammate-flash');
    await wait(900);
    await shot(me, 'desk-3-teammate');
    assert.equal(await me.$$eval('.mo-seat.is-lit', (els) => els.length), 1);
    assert.deepEqual(await cues(me), ['offer:arrive', 'offer:peer']);
    // the teammate who confirmed shows the picture it picked, framed as it framed it, on the first card after mine
    const lit = () => me.$$eval('.mo-seat', (els) => els.map((el) => {
      const img = el.querySelector('[data-testid="offer-seat-art"] img');
      return { lit: el.classList.contains('is-lit'), art: !!img, sil: !!el.querySelector('.mo-seat__sil'), src: img?.getAttribute('src') || '', framed: img?.dataset.framed || '' };
    }));
    let cards = await lit();
    assert.deepEqual(cards.map((c) => [c.lit, c.art, c.sil]), [[false, false, false], [true, true, false], [false, false, true], [false, false, true]]);
    assert.match(cards[1].src, /char_003_kalts/);
    assert.equal(cards[1].framed, 'art');
    // the last five seconds: urgent, ticking
    await me.waitForSelector('.mo.is-urgent', { timeout: ACCEPT_MS });
    await wait(1300);
    await shot(me, 'desk-4-urgent');
    // (the cue timer runs at 250 ms, the page's seconds at 250 ms too: the first tick may come just before the class)
    const ticks = (await cues(me)).filter((n) => n === 'offer:tick').length;
    assert.ok(ticks >= 1 && ticks <= 3, `ticks ${ticks}`);
    await me.keyboard.press('Enter');
    await me.waitForSelector('[data-testid="offer-done"]', { timeout: 5000 });
    await wait(900);
    await shot(me, 'desk-5-mine');
    cards = await lit();
    assert.deepEqual(cards.map((c) => [c.lit, c.art]), [[true, true], [true, true], [false, false], [false, false]], 'mine too, once confirmed');
    assert.match(cards[0].src, /char_010_chen/);
    assert.ok(!(await me.$('[data-testid="offer-seat-me"] .avatar')), 'the avatar gave way to the picture');
    assert.equal(await me.$eval('.mo', (el) => el.classList.contains('is-urgent')), false, 'confirmed: no hurry');
    assert.equal((await cues(me)).at(-1), 'offer:mine');
    assert.match(await me.$eval('[data-testid="offer-done"]', (el) => el.textContent), /等待其他博士/);
    await wait(1200);
    assert.equal((await cues(me)).filter((n) => n === 'offer:tick').length, ticks, 'no ticks once confirmed');
    // everyone in: 搜寻成功 — the count full, then kept OFFER_FOUND_MS over the room (an in-process allocation is at once;
    // a cluster's keeps it up while the node is prepared); its frames held at the flash and with the emblem drawn
    await accept(mates[1]);
    await accept(mates[2]);
    await me.waitForSelector('.mo.is-found', { timeout: 10000 });
    // (in-process the moment lasts OFFER_FOUND_MS: check it first, then its frames while it is still up)
    assert.equal(await me.$$eval('.mo-seat.is-lit', (els) => els.length), 4);
    assert.equal(await me.$$eval('[data-testid="offer-seat-art"]', (els) => els.length), 4, 'without a pick: the default portrait');
    assert.match(await me.$eval('.mo__wait', (el) => el.textContent), /正在连接游戏节点/);
    await hold(me, 1700);
    await shot(me, 'desk-7-found-connecting');
    if (await me.$('.mo.is-found')) { await hold(me, 160); await shot(me, 'desk-6-found-flash'); }
    await hold(me, null);
    await me.waitForFunction(() => !!globalThis.__SP__.store.get().room, { timeout: 30000 });
    // arrival once, the teammate, mine, the last two teammates (one update or two), everyone in
    const all = (await cues(me)).filter((n) => n !== 'offer:tick');
    assert.deepEqual(all.slice(0, 3), ['offer:arrive', 'offer:peer', 'offer:mine'], JSON.stringify(all));
    assert.equal(all.at(-1), 'offer:allReady', JSON.stringify(all));
    const middle = all.slice(3, -1);
    assert.ok(middle.length >= 1 && middle.length <= 2 && middle.every((n) => n === 'offer:peer'), JSON.stringify(all));
    await me.waitForFunction(() => !document.querySelector('[data-testid="match-offer"]'), { timeout: 5000 });
    await me.close();
  });

  test('desk20: a 20-seat offer is two rows of cards; leaving by choice cuts away', async () => {
    await dropClients();
    const me = await open('二十博士', { width: 1920, height: 1080, deviceScaleFactor: 1 });
    await openMatch(me);
    await me.evaluate(() => document.querySelector('[data-testid="match-scope-multi"]').click());
    await me.evaluate(() => document.querySelector('[data-testid="match-scope-four"]').click());
    await me.waitForFunction(() => document.querySelector('[data-testid="match-scope-four"]').getAttribute('aria-pressed') === 'false');
    await me.click('.proto-start');
    await me.waitForFunction(() => globalThis.__SP__.store.get().queue?.state === 'queued', { timeout: 15000 });
    const q = await me.evaluate(() => globalThis.__SP__.store.get().queue);
    const mates = [];
    for (let i = 0; i < 19; i++) mates.push(await lone(`二十队${i}`, q.difficulty, [20]));
    await me.waitForSelector('[data-testid="match-offer"]', { visible: true, timeout: 20000 });
    await settle(me);
    assert.equal(await me.$eval('[data-testid="match-offer"]', (el) => el.dataset.playerCapacity), '20');
    const rows = await me.$$eval('.mo-seat', (els) => new Set(els.map((el) => Math.round(el.getBoundingClientRect().top))).size);
    assert.equal(rows, 2, 'two rows');
    assert.deepEqual(await fits(me), []);
    await shot(me, 'desk20-1-offer');
    for (const c of mates.slice(0, 7)) await accept(c);
    await me.waitForFunction(() => /7 \/ 20/.test(document.querySelector('[data-testid="offer-count"]')?.textContent || ''), { timeout: 10000 });
    await wait(900);
    await shot(me, 'desk20-2-partial');
    assert.equal(await me.$$eval('[data-testid="offer-seat-art"]', (els) => els.length), 7);
    assert.deepEqual(await fits(me), []);
    // the 20 cards in every shape of screen: a small window, a phone on its side, a phone upright (no touch emulation: its
    // change reloads the page, and the offer with it)
    for (const [name, width, height] of [['small', 1024, 600], ['phone', 844, 390], ['portrait', 390, 844]]) {
      await me.setViewport({ width, height, deviceScaleFactor: 1 });
      await wait(400);
      await shot(me, `desk20-${name}`);
      assert.deepEqual(await fits(me), [], name);
    }
    await me.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await wait(300);
    await me.click('[data-testid="offer-cancel"]');
    await me.waitForSelector('.mo.is-leave', { timeout: 5000 });
    await wait(120);
    await shot(me, 'desk20-3-leave');
    await me.waitForFunction(() => !document.querySelector('[data-testid="match-offer"]'), { timeout: 5000 });
    await me.close();
  });

  test('room: a friend room\'s party queue shows the takeover over the room and confirms into the game', async () => {
    await dropClients();
    const me = await open('房间博士', { width: 1280, height: 720, deviceScaleFactor: 1 });
    // (险境: its own pools, whatever an earlier test left in the standard ones)
    await me.evaluate(() => globalThis.__SP__.net.request('room.create', { mode: 'coop', difficulty: 'NORMAL' }));
    await me.waitForSelector('.room-screen', { visible: true, timeout: 15000 });
    await me.evaluate(() => globalThis.__SP__.net.request('queue.join', { difficulty: 'NORMAL', party: true }));
    await me.waitForFunction(() => globalThis.__SP__.store.get().queue?.state === 'queued', { timeout: 15000 });
    const mates = [];
    for (let i = 0; i < 3; i++) mates.push(await lone(`房队${i}`, 'NORMAL'));
    await me.waitForSelector('[data-testid="match-offer"]', { visible: true, timeout: 20000 });
    assert.ok(await me.$('.room-screen'), 'over the room');
    await settle(me);
    await shot(me, 'room-1-offer');
    assert.deepEqual(await fits(me), []);
    await me.click('[data-testid="offer-accept"]');
    await me.waitForSelector('[data-testid="offer-done"]', { timeout: 5000 });
    await accept(mates[0]);
    await wait(500);
    await shot(me, 'room-2-mine');
    for (const c of mates.slice(1)) await accept(c);
    await me.waitForFunction(() => !!globalThis.__SP__.store.get().match || globalThis.__SP__.store.get().room?.source === 'matchmaking', { timeout: 30000 });
    await me.close();
  });

  test('phone: it fits; a teammate leaves after my accept and 本次匹配未成立 shows the reason before 搜寻中; portrait fits', async () => {
    await dropClients();
    const me = await open('手机博士', { width: 844, height: 390, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    await openMatch(me);
    await me.evaluate(() => document.querySelector('.proto-start').click());
    await me.waitForFunction(() => globalThis.__SP__.store.get().queue?.state === 'queued', { timeout: 15000 });
    const q = await me.evaluate(() => globalThis.__SP__.store.get().queue);
    const mates = [];
    for (let i = 0; i < 3; i++) mates.push(await lone(`手机队${i}`, q.difficulty));
    await me.waitForSelector('[data-testid="match-offer"]', { visible: true, timeout: 20000 });
    await settle(me);
    await shot(me, 'phone-1-offer');
    assert.deepEqual(await fits(me), []);
    await accept(mates[0]);
    await me.waitForFunction(() => /1 \/ 4/.test(document.querySelector('[data-testid="offer-count"]')?.textContent || ''), { timeout: 10000 });
    await me.evaluate(() => document.querySelector('[data-testid="offer-accept"]').click());
    await me.waitForSelector('[data-testid="offer-done"]', { timeout: 5000 });
    await wait(500);
    await shot(me, 'phone-2-mine');
    assert.deepEqual(await fits(me), []);
    // portrait: the same takeover, turned
    await me.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    await wait(400);
    await shot(me, 'portrait-1-mine');
    assert.deepEqual(await fits(me), []);
    await me.setViewport({ width: 844, height: 390, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    await wait(300);
    // a teammate leaves: the offer breaks; I had confirmed, so my ticket waits again
    const s = await mates[1].waitFor('queue.state', (m) => m.state === 'offered');
    assert.equal((await mates[1].request({ t: 'queue.cancel', ticketId: s.ticketId })).t, 'ok');
    await me.waitForSelector('.mo.is-broken', { timeout: 10000 });
    await wait(450);
    await shot(me, 'phone-3-broken');
    assert.ok((await me.$eval('[data-testid="offer-reason"]', (el) => el.textContent)).length > 0);
    assert.equal((await cues(me)).at(-1), 'offer:broken');
    await me.waitForFunction(() => !document.querySelector('[data-testid="match-offer"]'), { timeout: 5000 });
    await me.waitForSelector('.mf-search', { visible: true, timeout: 5000 });
    await shot(me, 'phone-4-searching-again');
    // a fresh offer in portrait, at rest
    await me.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    for (let i = 0; i < 2; i++) mates.push(await lone(`竖屏队${i}`, q.difficulty));
    await me.waitForSelector('[data-testid="match-offer"]', { visible: true, timeout: 20000 });
    await settle(me);
    await shot(me, 'portrait-2-offer');
    assert.deepEqual(await fits(me), []);
    await me.evaluate(() => document.querySelector('[data-testid="offer-cancel"]').click());
    await me.waitForFunction(() => globalThis.__SP__.store.get().queue?.state === 'idle', { timeout: 15000 });
    assert.deepEqual(errors, []);
    await me.close();
  });
});
