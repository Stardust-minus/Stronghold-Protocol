// Opt-in localhost app with real server combat, one Worker and touch-emulated Chrome.
// Checks readable/reachable rosters, queue feedback and lobby controls; not physical devices or a full match.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { WebSocket } from 'ws';
import { startServer } from '../../server/index.js';
import { Match } from '../../server/match/Match.js';
import { PROTOCOL_VERSION, MATCHMAKING_VERSION } from '../../shared/constants.js';
import { PLAYER_CAPACITY_VERSION } from '../../shared/playerCapacity.js';

const enabled = process.env.SP_E2E === '1';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('mobile lobby, same-pool count and every expanded roster seat remain operable', { skip: !enabled, timeout: 120000 }, async () => {
  const out = process.env.SP_MOBILE_EVIDENCE || mkdtempSync(fileURLToPath(new URL('../../.cache/stardust/oct11-mobile-validation-', import.meta.url)));
  const report = { ok: false, productionAccessed: false, scope: 'localhost HTTP/WS, server Match/one Worker, Chrome touch emulation, twenty seats', errors: [], externalRequests: 0 };
  let srv, browser, guest;
  const pending = new Map();
  try {
    class MobileMatch extends Match { constructor(opts) { super({ ...opts, clientCombat: false, botRehearsal: 0 }); } }
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: MobileMatch, seedFn: () => 173,
      combatWorkers: 1, trialWorkers: 0, snapshotHz: 10, wsCompression: 'on' });
    browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true,
      args: ['--no-sandbox', '--mute-audio', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage();
    page.on('pageerror', e => report.errors.push(e.message));
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (/^(data:|blob:|about:)/.test(req.url()) || new URL(req.url()).hostname === '127.0.0.1') void req.continue();
      else { report.externalRequests++; void req.abort(); }
    });
    const viewport = async (width, height, touch = true) => {
      await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: touch, hasTouch: touch, isLandscape: width > height });
      await pause(300);
    };
    const tap = async (selector, text = null) => {
      const pt = await page.evaluate((selector, text) => {
        for (const el of document.querySelectorAll(selector)) {
          if (el.disabled || text && !el.textContent.includes(text)) continue;
          const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
          const target = document.elementFromPoint(x, y);
          if (r.width > 0 && r.height > 0 && target && el.contains(target)) return { x, y };
        }
        return null;
      }, selector, text);
      assert.ok(pt, 'touch control is reachable: ' + selector);
      await page.touchscreen.tap(pt.x, pt.y); await pause(100);
    };
    const request = (type, fields = {}) => page.evaluate((type, fields) => globalThis.__SP__.net.request(type, fields).then(() => true), type, fields);
    const shot = name => page.screenshot({ path: out + '/' + name + '.png' });
    await viewport(640, 360);
    await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.title-login input'); await page.type('.title-login input', 'MobileProof'); await tap('.title-login button');
    await page.waitForSelector('.lobby-screen'); await pause(500);
    if (await page.$('.announcement-board')) await tap('.announcement-board button', '关闭公告');
    assert.equal(await page.$('.lobby-language'), null);
    assert.ok(await page.$eval('.lobby-body', el => el.scrollHeight <= el.clientHeight + 1));
    await tap('.lobby-tools summary'); await tap('.lobby-announcements');
    await page.waitForSelector('.announcement-board'); await tap('.announcement-board button', '关闭公告');
    await tap('.lobby-tools summary');
    await tap('[data-testid="settings-btn"]'); await page.waitForSelector('.modal [data-testid="lang-toggle"]');
    await page.select('[data-testid="lang-toggle"] select', 'en'); await page.waitForFunction(() => document.documentElement.lang === 'en');
    await page.select('[data-testid="lang-toggle"] select', 'zh'); await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    await tap('.modal__actions button', '完成');
    await viewport(360, 640);
    await page.$eval('.lobby-body', el => { el.scrollTop = el.scrollHeight; });
    await shot('portrait-lobby-last-action');
    assert.ok(await page.$eval('.create-box button', el => { const r = el.getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; }));
    await viewport(844, 390);
    await tap('.mode-card--match'); await tap('.matchmaking__actions button', '开始多人匹配');
    await page.waitForFunction(() => globalThis.__SP__.store.get().queue.waitingCount === 1);
    guest = new WebSocket(srv.url.replace(/^http/, 'ws') + '/ws');
    let rid = 0;
    guest.on('message', bytes => {
      const frame = JSON.parse(bytes.toString()), work = pending.get(frame.rid);
      if (work) { pending.delete(frame.rid); clearTimeout(work.timer); work.resolve(frame); }
    });
    guest.on('close', () => { for (const work of pending.values()) { clearTimeout(work.timer); work.reject(new Error('local guest closed')); } pending.clear(); });
    await new Promise((resolve, reject) => { guest.once('open', resolve); guest.once('error', reject); });
    const guestRequest = (type, fields) => new Promise((resolve, reject) => {
      const id = ++rid, timer = setTimeout(() => { pending.delete(id); reject(new Error('local guest request deadline')); }, 5000);
      pending.set(id, { resolve, reject, timer }); guest.send(JSON.stringify({ t: type, ...fields, rid: id }));
    });
    assert.equal((await guestRequest('hello', { name: 'QueuePeer', version: PROTOCOL_VERSION, matchmakingVersion: MATCHMAKING_VERSION, playerCapacityVersion: PLAYER_CAPACITY_VERSION })).t, 'welcome');
    assert.equal((await guestRequest('queue.join', { difficulty: 'FUNNY' })).t, 'ok');
    await page.waitForFunction(() => globalThis.__SP__.store.get().queue.waitingCount === 2);
    assert.equal(await page.$eval('[data-testid="queue-population"] strong', el => el.textContent), '2');
    await shot('queue-two-identities');
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    assert.equal(await page.$eval('.matchmaking__motion i', el => getComputedStyle(el).animationName), 'none');
    await page.emulateMediaFeatures([]);
    await tap('.matchmaking__actions button', '取消匹配');
    await page.waitForFunction(() => globalThis.__SP__.store.get().queue.state === 'idle');
    guest.terminate(); guest = null; await pause(1200);
    assert.equal(await page.evaluate(() => globalThis.__SP__.store.get().queue.state), 'idle');
    await request('room.create', { mode: 'coop', difficulty: 'NORMAL', experimental: { revivalEnabled: false, disableSharedPool: false, playerCapacity: 20 } });
    for (let i = 0; i < 19; i++) await request('room.addBot');
    await tap('.room-screen button', '开始模拟'); await page.waitForSelector('.brief');
    await tap('.brief__foot button', '准备就绪'); await page.waitForSelector('.dband');
    await page.waitForFunction(() => globalThis.__SP__.store.get().match.public.draft?.turn === globalThis.__SP__.store.get().me.playerId);
    await tap('.dband'); await tap('.draft-detail__btns button', '确认选择');
    await page.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'PREP');
    await page.waitForFunction(() => globalThis.__SP_VIEW__?.kind === 'engine'); await pause(1000);
    await viewport(1366, 768, false); await page.waitForSelector('.team__toggle');
    if (await page.$eval('.team__toggle', el => el.getAttribute('aria-expanded') !== 'true')) await page.click('.team__toggle');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.team')).getPropertyValue('--team-columns').trim() === '2');
    await shot('desktop-readable-roster');
    await viewport(640, 360); await page.waitForSelector('.team__toggle');
    if (await page.$eval('.team__toggle', el => el.getAttribute('aria-expanded') !== 'true')) await tap('.team__toggle');
    assert.equal(await page.$$eval('.team__row', nodes => nodes.length), 20);
    assert.ok(await page.$eval('.team__name', el => parseFloat(getComputedStyle(el).fontSize)) >= 14);
    const cdp = await page.createCDPSession();
    for (let swipe = 0; swipe < 20; swipe++) {
      const r = await page.$eval('.team__players', el => { const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y0: b.bottom - 10, y1: b.top + 10, done: el.scrollTop >= el.scrollHeight - el.clientHeight - 1 }; });
      if (r.done) break;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y0 }] });
      for (let step = 1; step <= 8; step++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: r.x, y: r.y0 + (r.y1 - r.y0) * step / 8 }] }); await pause(18); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await pause(120);
    }
    await shot('touch-roster-last-seat');
    const last = await page.$eval('[data-seat="19"] .team__btn', el => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, hit: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }; });
    assert.ok(last.w >= 44 && last.h >= 44 && last.hit);
    await tap('[data-seat="19"] .team__btn');
    await page.waitForFunction(() => globalThis.__SP__.store.get().match.field?.fieldId === 'n:' + globalThis.__SP__.store.get().match.public.players.find(p => p.seat === 19).playerId);
    await tap('.team__toggle'); await tap('.gm__watching button', '返回自己');
    await page.waitForFunction(() => globalThis.__SP__.store.get().match.field?.fieldId === 'n:' + globalThis.__SP__.store.get().me.playerId);
    await tap('.readybtn');
    if (await page.$('.modal')) await tap('.modal button', '准备');
    await page.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'COMBAT');
    await page.waitForFunction(() => globalThis.__SP_VIEW__?.raw?.stats?.()?.mode === 'battle');
    const code = await page.evaluate(() => globalThis.__SP__.store.get().room.code), match = srv.lobby.getRoom(code).match;
    assert.equal(match.clientCombat, false); assert.equal(match.errorCount, 0);
    assert.equal(srv.combatPool.stats().sessions, 1);
    await shot('touch-server-combat');
    assert.deepEqual(report.errors, []); assert.equal(report.externalRequests, 0);
    report.ok = true; report.players = match.players.size; report.actualWorkerLease = true;
  } finally {
    for (const work of pending.values()) { clearTimeout(work.timer); work.reject(new Error('local fixture closed')); } pending.clear();
    guest?.terminate(); await browser?.close(); await srv?.close();
    report.allLocalProcessesClosed = true;
    writeFileSync(out + '/browser.json', JSON.stringify(report, null, 2) + '\n');
    console.log('Multiplayer mobile evidence: ' + out);
  }
});
