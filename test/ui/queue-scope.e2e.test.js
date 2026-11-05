// Browser E2E of 多人匹配's scope (real server, headless Chrome): 选择模拟协议 offers 人数 and 规则 under the difficulties at
// three screen sizes, a ticket for 多人同盟 alone waits and says so, and seven more lone tickets make an eight-seat game of
// standard rules that the browser enters.
//
//   SP_E2E=1 node --test test/ui/queue-scope.e2e.test.js
//
// Screenshots: test/e2e/out/queue-*.png (SP_SHOTS=<dir> elsewhere).
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
const MULTI = [8, 12, 16, 20];

describe('多人匹配 scope (real server, headless Chrome)', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv, browser, base;
  const errors = [], clients = [];
  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    mkdirSync(OUT, { recursive: true });
  });
  after(async () => { for (const c of clients) c.ws.terminate(); await browser?.close(); await srv?.close(); });

  async function open(name, viewport) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport(viewport);
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    await page.evaluateOnNewDocument((n) => { localStorage.setItem('sp.name', n); sessionStorage.setItem('sp.entered', '1'); }, name);
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__SP__?.store.get().connection.status === 'online' && !!document.querySelector('.lobby-screen .hub-entries'), { timeout: 60000 });
    const board = await page.waitForSelector('.announcement-board', { visible: true, timeout: 2500 }).catch(() => null);
    if (board) {
      await page.click('.announcement-board .modal__actions button');
      await page.waitForSelector('.announcement-board', { hidden: true, timeout: 10000 });
    }
    return page;
  }
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, `queue-${name}.png`) });
  const settle = (page) => page.waitForFunction(() => !document.getAnimations()
    .some((a) => /^(tr|ps)-/.test(String(a.animationName)) && a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity), { timeout: 15000 });
  const openMatch = async (page) => {
    await page.evaluate(() => [...document.querySelectorAll('.hub-entries button')].find((b) => b.textContent.startsWith('ALLIANCE')).click());
    await page.waitForSelector('[data-testid="room-list-open"]', { visible: true, timeout: 15000 });
    await settle(page);
    await page.evaluate(() => [...document.querySelectorAll('.ally-pill')].at(-1).click());
    await page.waitForSelector('[data-testid="match-scope"]', { visible: true, timeout: 15000 });
    await settle(page);
  };
  const press = (page, id) => page.evaluate((x) => document.querySelector(`[data-testid="match-scope-${x}"]`).click(), id);
  const pressed = (page) => page.$$eval('.proto-scope__opt[aria-pressed="true"]', (els) => els.map((el) => el.dataset.testid.replace('match-scope-', '')));
  const inView = (page) => page.$$eval('.proto-scope__opt, .proto-start', (els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    return { in: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1 && r.width > 0, text: el.textContent.trim(), clipped: el.scrollWidth > el.clientWidth + 1 };
  }));

  for (const [label, viewport] of [['1080p', { width: 1920, height: 1080 }], ['720p', { width: 1280, height: 720 }],
    ['phone', { width: 844, height: 390, hasTouch: true, isMobile: true }]]) {
    test(`the scope fits at ${label}`, async () => {
      const page = await open(`范围${label}`, { deviceScaleFactor: 1, ...viewport });
      await openMatch(page);
      assert.deepEqual(await pressed(page), ['four', 'standard']);
      await press(page, 'multi');
      await press(page, 'experimental');
      await page.waitForFunction(() => document.querySelectorAll('.proto-scope__opt[aria-pressed="true"]').length === 4);
      await settle(page);
      await shot(page, `scope-${label}`);
      if (label !== 'phone') assert.match(await page.$$eval('.proto-hint', (els) => els.map((el) => el.textContent).join()), /4–20 名真人/);
      const boxes = await inView(page);
      assert.ok(boxes.every((b) => b.in), JSON.stringify(boxes));
      await page.close();
    });
  }

  test('a ticket for 多人同盟 alone: the choices stick, the search says so, eight lone tickets make the room', async () => {
    const me = await open('多人博士', { width: 1920, height: 1080, deviceScaleFactor: 1 });
    await openMatch(me);
    await press(me, 'four'); // the last of its axis stays
    assert.deepEqual(await pressed(me), ['four', 'standard']);
    await press(me, 'multi');
    await press(me, 'four');
    await me.waitForFunction(() => document.querySelector('[data-testid="match-scope-four"]').getAttribute('aria-pressed') === 'false');
    assert.deepEqual(await pressed(me), ['multi', 'standard']);
    assert.deepEqual(await me.evaluate(() => JSON.parse(localStorage.getItem('sp.pref.lobby.matchScope'))), { seats: ['multi'], rules: ['standard'] });
    await me.click('.proto-start');
    await me.waitForFunction(() => globalThis.__SP__.store.get().queue?.state === 'queued', { timeout: 15000 });
    const q = await me.evaluate(() => globalThis.__SP__.store.get().queue);
    assert.deepEqual(q.capacities, MULTI);
    assert.deepEqual(q.rules, ['standard']);
    assert.equal(q.required, 8);
    await me.waitForSelector('.mf-search', { visible: true, timeout: 15000 });
    await settle(me);
    const tags = await me.$$eval('.mf-tag', (els) => els.map((el) => el.textContent.trim()));
    assert.ok(tags.includes('多人同盟') && tags.includes('标准规则'), JSON.stringify(tags));
    assert.equal(tags.some((x) => /4 人/.test(x)), false, JSON.stringify(tags));
    await shot(me, 'searching');
    await me.evaluate(() => document.querySelector('.proto-back').click());
    await me.waitForSelector('.hub-searching', { visible: true, timeout: 15000 });
    await settle(me);
    const hud = await me.$eval('.matchmaking-hud__text', (el) => el.textContent);
    assert.ok(/多人同盟/.test(hud) && /标准规则/.test(hud), hud);
    await shot(me, 'hud');
    for (let i = 0; i < 7; i++) {
      const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`, { timeout: 15000 });
      clients.push(c);
      await c.hello(`单人${i}`, undefined, { matchmakingVersion: MATCHMAKING_VERSION, playerCapacityVersion: PLAYER_CAPACITY_VERSION });
      assert.equal((await c.request({ t: 'queue.join', difficulty: q.difficulty, capacities: MULTI, rules: ['standard'] })).t, 'ok');
    }
    await me.waitForFunction(() => globalThis.__SP__.store.get().queue?.state === 'offered', { timeout: 20000 });
    const offer = await me.evaluate(() => globalThis.__SP__.store.get().queue);
    assert.equal(offer.required, 8);
    assert.deepEqual(offer.experimental, { revivalEnabled: false, disableSharedPool: false, playerCapacity: 8 });
    await me.waitForSelector('.matchmaking__options', { visible: true, timeout: 15000 });
    await settle(me);
    assert.equal(await me.$eval('[data-testid="match-offer"]', (el) => el.dataset.playerCapacity), '8'); // 确认入场 (ui/matchOffer.js)
    await shot(me, 'offered');
    for (const c of clients) {
      const state = await c.waitFor('queue.state', (m) => m.state === 'offered');
      assert.equal((await c.request({ t: 'queue.accept', ticketId: state.ticketId, offerId: state.offerId })).t, 'ok');
    }
    await me.evaluate(() => {
      const { ticketId, offerId } = globalThis.__SP__.store.get().queue;
      return globalThis.__SP__.net.request('queue.accept', { ticketId, offerId }).then((r) => r.t);
    });
    await me.waitForFunction(() => !!globalThis.__SP__.store.get().room, { timeout: 30000 });
    const room = await me.evaluate(() => { const r = globalThis.__SP__.store.get().room; return { seats: r.seats.filter(Boolean).length, experimental: r.experimental, source: r.source }; });
    assert.equal(room.seats, 8);
    assert.equal(room.experimental.playerCapacity, 8);
    assert.equal(room.source, 'matchmaking');
    assert.deepEqual(errors, []);
  });
});
