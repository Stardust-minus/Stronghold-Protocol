// Browser E2E of 公开同盟 (feedback #30) and of several difficulties in 多人匹配 (feedback #87), real server, headless Chrome.
// A host of an eight-seat room lists it from 同盟设置, a second room of an older version is listed too; another doctor sees both
// under 选择同盟方式 → 公开同盟 (also on a phone, in Japanese) and joins by pressing the row. In 选择模拟协议 of 多人匹配 two
// difficulties are picked; the queue shows both with their counts, three doctors of one difficulty fill it, the offer stands
// at that difficulty and the room starts there.
//
//   SP_E2E=1 node --test test/ui/room-list.e2e.test.js
//
// Screenshots: test/e2e/out/room-list-*.png (SP_SHOTS=<dir> elsewhere).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.SP_SHOTS || path.join(ROOT, 'test/e2e/out');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const EIGHT = { revivalEnabled: false, disableSharedPool: false, playerCapacity: 8 };

describe('公开同盟 and several difficulties (real server, headless Chrome)', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv, browser, base;
  const errors = [];
  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    mkdirSync(OUT, { recursive: true });
  });
  after(async () => { await browser?.close(); await srv?.close(); });

  async function open(name, { w = 1920, h = 1080, touch = false, lang = null } = {}) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport({ width: w, height: h, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    await page.evaluateOnNewDocument((n, l) => {
      localStorage.setItem('sp.name', n);
      sessionStorage.setItem('sp.entered', '1');
      if (l) localStorage.setItem('sp.pref.lang', JSON.stringify(l));
    }, name, lang);
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__SP__?.store.get().connection.status === 'online' && !!document.querySelector('.lobby-screen .hub-entries'), { timeout: 60000 });
    // the 公告板 opens by itself on unread notices
    const board = await page.waitForSelector('.announcement-board', { visible: true, timeout: 2500 }).catch(() => null);
    if (board) {
      await page.click('.announcement-board .modal__actions button');
      await page.waitForSelector('.announcement-board', { hidden: true, timeout: 10000 });
    }
    return page;
  }
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, `room-list-${name}.png`) });
  const net = (page, t, fields) => page.evaluate((a, b) => globalThis.__SP__.net.request(a, b).then((r) => ({ t: r.t, rooms: r.rooms })), t, fields);
  const settle = (page) => page.waitForFunction(() => !document.getAnimations()
    .some((a) => /^(tr|ps)-/.test(String(a.animationName)) && a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity), { timeout: 15000 });
  const openAlliance = async (page) => {
    await page.evaluate(() => [...document.querySelectorAll('.hub-entries button')].find((b) => b.textContent.startsWith('ALLIANCE')).click());
    await page.waitForSelector('[data-testid="room-list-open"]', { visible: true, timeout: 15000 });
    await settle(page);
  };
  const inView = (page, sel) => page.$$eval(sel, (els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    return r.left >= -1 && r.right <= innerWidth + 1 && r.width > 0 && el.scrollWidth <= el.clientWidth + 1;
  }));

  test('a listed room is found and joined by pressing its row', async () => {
    const seeker = await open('寻找同盟');
    await openAlliance(seeker);
    await seeker.click('[data-testid="room-list-open"]');
    await seeker.waitForSelector('[data-testid="room-list-empty"]', { visible: true, timeout: 15000 });
    await shot(seeker, 'empty');
    await seeker.keyboard.press('Escape');

    const host = await open('公开房主');
    await net(host, 'room.create', { mode: 'coop', difficulty: 'HARD', experimental: EIGHT });
    await host.waitForSelector('.rs-pill__gear', { visible: true, timeout: 30000 });
    await settle(host);
    await host.click('.rs-pill__gear');
    await host.waitForSelector('[data-testid="room-opt-listed"]', { visible: true });
    await shot(host, 'option');
    assert.equal(await host.$eval('[data-testid="room-opt-listed"]', (b) => b.checked), false, 'off by default');
    await host.click('[data-testid="room-opt-listed"]');
    await host.waitForFunction(() => globalThis.__SP__.store.get().room?.listed === true, { timeout: 10000 });
    await host.waitForSelector('[data-testid="room-opt-listed"]:checked', { visible: true, timeout: 5000 });
    await new Promise((r) => setTimeout(r, 400));
    await shot(host, 'option-on');
    const code = await host.evaluate(() => globalThis.__SP__.store.get().room.code);

    const older = await open('旧版本房主');
    await net(older, 'room.create', { mode: 'coop', difficulty: 'NORMAL', version: 'act1autochess', experimental: { ...EIGHT, revivalEnabled: true } });
    await older.waitForFunction(() => !!globalThis.__SP__.store.get().room, { timeout: 30000 });
    await net(older, 'room.setListed', { listed: true });

    await seeker.waitForSelector('.ally-pill', { visible: true });
    await seeker.click('[data-testid="room-list-open"]');
    await seeker.waitForFunction(() => document.querySelectorAll('[data-testid="room-row"]').length === 2, { timeout: 20000 });
    await settle(seeker);
    await new Promise((r) => setTimeout(r, 500));
    await shot(seeker, 'desktop');
    const veil = await seeker.$eval('.rlist-dialog', (el) => { const v = el.closest('.modal').getBoundingClientRect(); return [v.top, v.bottom === innerHeight]; });
    assert.deepEqual(veil, [0, true], 'the dialog lies over the whole screen');
    assert.ok((await inView(seeker, '.rlist__row')).every(Boolean), 'the rows stay inside the dialog');
    const text = await seeker.$eval('[data-testid="room-list"]', (el) => el.textContent);
    assert.match(text, /公开房主/);
    assert.match(text, /旧版本房主/);

    const phone = await open('手机寻找', { w: 844, h: 390, touch: true, lang: 'ja' });
    await openAlliance(phone);
    await phone.tap('[data-testid="room-list-open"]');
    await phone.waitForSelector('[data-testid="room-row"]', { visible: true, timeout: 20000 });
    await settle(phone);
    await new Promise((r) => setTimeout(r, 500));
    await shot(phone, 'phone-ja');
    const narrow = await open('窄手机', { w: 390, h: 844, touch: true });
    await openAlliance(narrow);
    await narrow.tap('[data-testid="room-list-open"]');
    await narrow.waitForSelector('[data-testid="room-row"]', { visible: true, timeout: 20000 });
    await settle(narrow);
    await new Promise((r) => setTimeout(r, 500));
    await shot(narrow, 'phone-portrait');
    assert.ok((await inView(narrow, '.rlist__row')).every(Boolean), 'the rows stay inside a narrow screen');

    await seeker.click(`[data-testid="room-row"][data-code="${code}"] button`);
    await seeker.waitForFunction((c) => globalThis.__SP__.store.get().room?.code === c, { timeout: 20000 }, code);
    await host.waitForFunction(() => globalThis.__SP__.store.get().room.seats.filter(Boolean).length === 2, { timeout: 10000 });
    assert.deepEqual(errors, []);
  });

  test('two difficulties in 多人匹配: the first to fill takes the ticket', async () => {
    const me = await open('多选博士');
    await openAlliance(me);
    await me.evaluate(() => [...document.querySelectorAll('.ally-pill')].at(-1).click());
    await me.waitForSelector('.pcard', { visible: true, timeout: 15000 });
    await settle(me);
    const cards = await me.$$('.pcard');
    assert.equal(await me.$$eval('.pcard[aria-pressed="true"]', (els) => els.length), 1);
    const first = await me.$eval('.pcard[aria-pressed="true"]', (el) => [...el.parentNode.children].filter((c) => c.classList.contains('pcard')).indexOf(el));
    const otherIndex = first === 0 ? 1 : 0;
    await cards[otherIndex].click();
    await me.waitForFunction(() => document.querySelectorAll('.pcard[aria-pressed="true"]').length === 2);
    await settle(me);
    await shot(me, 'picks');
    await cards[otherIndex].click();
    await me.waitForFunction(() => document.querySelectorAll('.pcard[aria-pressed="true"]').length === 1);
    await cards[otherIndex].click();
    await me.waitForFunction(() => document.querySelectorAll('.pcard[aria-pressed="true"]').length === 2);
    await me.click('.proto-start');
    await me.waitForFunction(() => globalThis.__SP__.store.get().queue?.state === 'queued', { timeout: 15000 });
    const q = await me.evaluate(() => globalThis.__SP__.store.get().queue);
    assert.equal(q.difficulties.length, 2);
    await me.waitForSelector('.mf-search', { visible: true, timeout: 15000 });
    await settle(me);
    assert.equal(await me.$$eval('.mf-tag', (els) => els.length), 5, 'mode, both difficulties, capacity, rules');
    await shot(me, 'queued');
    const target = q.difficulties[1];

    const others = [];
    for (const name of ['同难度一', '同难度二', '同难度三']) others.push(await open(name, { w: 800, h: 600 }));
    for (const page of others) await net(page, 'queue.join', { difficulty: target });
    await me.waitForFunction(() => globalThis.__SP__.store.get().queue?.state === 'offered', { timeout: 20000 });
    assert.equal(await me.evaluate(() => globalThis.__SP__.store.get().queue.difficulty), target);
    await settle(me);
    await shot(me, 'offered');
    await Promise.all([me, ...others].map((page) => page.waitForFunction(() => globalThis.__SP__.store.get().queue?.state === 'offered', { timeout: 20000 })));
    for (const page of [me, ...others]) {
      await page.evaluate(() => {
        const { ticketId, offerId } = globalThis.__SP__.store.get().queue;
        return globalThis.__SP__.net.request('queue.accept', { ticketId, offerId }).then((r) => r.t);
      });
    }
    await me.waitForFunction(() => !!globalThis.__SP__.store.get().room, { timeout: 30000 });
    assert.equal(await me.evaluate(() => globalThis.__SP__.store.get().room.difficulty), target);
    assert.deepEqual(errors, []);
  });
});
