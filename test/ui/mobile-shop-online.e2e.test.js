// Local HTTP/WS, one combat Worker and real touch taps. The isolated prep fixture grants funds for level-six coverage.
// Phone emulation / software WebGL / one short combat are not physical-device or full-match coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { WebSocket } from 'ws';
import { startServer } from '../../server/index.js';
import { Match } from '../../server/match/Match.js';
import { PROTOCOL_VERSION, MATCHMAKING_VERSION } from '../../shared/constants.js';
import { PLAYER_CAPACITY_VERSION } from '../../shared/playerCapacity.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const enabled = process.env.SP_E2E === '1';

test('phone online count and full-size shops stay visible, touchable and reconnectable', { skip: !enabled, timeout: 180000 }, async () => {
  const out = process.env.SP_MOBILE_SHOP_EVIDENCE || mkdtempSync(new URL('../../.cache/stardust/mobile-shop-024-', import.meta.url).pathname);
  const report = { ok: false, productionAccessed: false, physicalDevice: false, softwareWebGL: true, fixtureFunds: 100, pageErrors: [], externalRequests: 0, screens: [], lobby: [], shops: [] };
  let srv, browser, peer, page;
  try {
    class PhoneMatch extends Match {
      constructor(opts) { super({ ...opts, clientCombat: false, botRehearsal: 0 }); }
      enterPrep() {
        super.enterPrep();
        if (this.round === 1 && !this.phoneFunded) {
          this.phoneFunded = true;
          for (const ps of this.players.values()) { ps.addFunds(100, { reason: 'income' }); ps.dirty(); }
        }
      }
    }
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: PhoneMatch, seedFn: () => 173,
      combatWorkers: 1, trialWorkers: 0, snapshotHz: 10, wsCompression: 'off' });
    assert.equal((await fetch(srv.url + '/healthz')).status, 200);
    browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true,
      args: ['--no-sandbox', '--mute-audio', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(error.message));
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
      await page.waitForFunction((selector, text) => [...document.querySelectorAll(selector)].some(el => {
        if (el.disabled || text && !el.textContent.includes(text)) return false;
        const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
        return r.width > 0 && r.height > 0 && x > 0 && y > 0 && x < innerWidth && y < innerHeight && el.contains(document.elementFromPoint(x, y));
      }), { timeout: 10000 }, selector, text);
      const point = await page.evaluate((selector, text) => {
        for (const el of document.querySelectorAll(selector)) {
          if (el.disabled || text && !el.textContent.includes(text)) continue;
          const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
          if (r.width > 0 && r.height > 0 && el.contains(document.elementFromPoint(x, y))) return { x, y };
        }
      }, selector, text);
      assert.ok(point, 'touch control reachable: ' + selector);
      await page.touchscreen.tap(point.x, point.y); await pause(180);
    };
    const shot = async name => { const path = out + '/' + name + '.png'; await page.screenshot({ path }); report.screens.push(path); };
    const dismissNotice = async () => {
      await pause(400);
      if (await page.$('.announcement-board')) await tap('.announcement-board .modal__actions button', '关闭公告');
    };
    await viewport(844, 390);
    await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.title-login input'); await page.type('.title-login input', 'Phone024'); await tap('.title-login button');
    await page.waitForSelector('.lobby-screen'); await dismissNotice();
    await page.waitForFunction(() => globalThis.__SP__.store.get().presence?.online === 1);
    peer = new WebSocket(srv.url.replace(/^http/, 'ws') + '/ws');
    await new Promise((resolve, reject) => { peer.once('open', resolve); peer.once('error', reject); });
    const welcomed = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('local peer welcome deadline')), 5000);
      peer.on('message', bytes => {
        const frame = JSON.parse(bytes.toString());
        if (frame.t === 'welcome') { clearTimeout(timeout); resolve(); }
        else if (frame.t === 'error') { clearTimeout(timeout); reject(new Error('local peer refused: ' + frame.code)); }
      });
    });
    peer.send(JSON.stringify({ t: 'hello', name: 'Peer024', version: PROTOCOL_VERSION, matchmakingVersion: MATCHMAKING_VERSION, playerCapacityVersion: PLAYER_CAPACITY_VERSION }));
    await welcomed;
    await page.waitForFunction(() => globalThis.__SP__.store.get().presence?.online === 2);
    for (const [width, height] of [[844, 390], [640, 360], [360, 640]]) {
      await viewport(width, height); await page.waitForSelector('.lobby-screen');
      const metrics = await page.$eval('.online-players', el => {
        const r = el.getBoundingClientRect();
        return { text: el.textContent.trim(), width: r.width, height: r.height, right: r.right, top: r.top, display: getComputedStyle(el).display,
          overflow: document.documentElement.scrollWidth - innerWidth, bodyOverflow: document.querySelector('.lobby-body').scrollHeight - document.querySelector('.lobby-body').clientHeight };
      });
      assert.match(metrics.text, /2 人在线/); assert.ok(metrics.width > 0 && metrics.height >= 14 && metrics.right <= width && metrics.top >= 0);
      assert.equal(metrics.overflow, 0); if (width > height) assert.ok(metrics.bodyOverflow <= 1, 'landscape lobby stays scroll-free');
      assert.ok(await page.$eval('.online-players', el => {
        const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }), 'online text is not covered by another header control');
      report.lobby.push({ width, height, ...metrics }); await shot('lobby-' + width);
    }
    peer.terminate(); peer = null;
    await page.waitForFunction(() => globalThis.__SP__.store.get().presence?.online === 1);
    await viewport(844, 390); await tap('.mode-card', '独立模拟'); await tap('.create-box button', '开始独立模拟');
    await page.waitForSelector('.room-screen'); await tap('.room-screen button', '开始模拟');
    await page.waitForSelector('.brief'); await tap('.brief__foot button', '准备就绪');
    await page.waitForSelector('.dband'); await tap('.dband'); await tap('.draft-detail__btns button', '确认选择');
    await page.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'PREP');
    await page.waitForFunction(() => globalThis.__SP_VIEW__?.kind === 'engine'); await pause(500);
    const measureShop = () => page.evaluate(() => {
      const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      const cards = [...document.querySelectorAll('.shopbar__cards .scard')];
      return { viewport: [innerWidth, innerHeight], cards: cards.map(box), row: box(document.querySelector('.shopbar__row')),
        names: cards.map(el => el.querySelector('.scard__name') ? parseFloat(getComputedStyle(el.querySelector('.scard__name')).fontSize) : null),
        scrollWidth: document.querySelector('.shopbar__cards').scrollWidth, clientWidth: document.querySelector('.shopbar__cards').clientWidth,
        level: globalThis.__SP__.store.get().match.private.shop.level, overflow: document.documentElement.scrollWidth - innerWidth };
    });
    const checkShop = metrics => {
      assert.equal(metrics.overflow, 0); assert.ok(metrics.row.x >= 108 && metrics.row.right <= metrics.viewport[0] && metrics.row.bottom <= metrics.viewport[1], JSON.stringify(metrics));
      assert.ok(metrics.cards.every(card => card.width >= 79.9 && card.height >= 111.9), 'cards never shrink below the mobile floor');
      assert.ok(metrics.names.filter(x => x != null).every(x => x >= 13), 'operator names are legible');
    };
    report.shops.push(await measureShop()); checkShop(report.shops.at(-1)); await shot('phone-shop-level1');
    const before = await page.evaluate(() => globalThis.__SP__.store.get().match.private.funds);
    await tap('.shopbar__cards .scard:not(.is-disabled):not(.scard--sold)');
    assert.equal(await page.evaluate(() => globalThis.__SP__.store.get().match.private.funds), before, 'first tap only arms');
    assert.ok(await page.$('.scard.is-armed .scard__confirm')); await shot('phone-shop-confirm');
    await tap('.shopbar__cards .scard.is-armed');
    await page.waitForFunction(funds => globalThis.__SP__.store.get().match.private.funds < funds, {}, before);
    report.twoTapBuy = true;
    for (let level = 2; level <= 6; level++) {
      await tap('.lvcard'); await tap('.lvcard.is-armed');
      await page.waitForFunction(level => globalThis.__SP__.store.get().match.private.shop.level === level, {}, level);
    }
    await tap('.toolbtn--amber'); await pause(300);
    for (const [width, height] of [[844, 390], [640, 360]]) {
      await viewport(width, height); await page.waitForSelector('.shopbar__cards'); await pause(400);
      const metrics = await measureShop(); report.shops.push(metrics); await shot('phone-shop-level6-' + width);
      checkShop(metrics); assert.equal(metrics.cards.length, 5);
      const cdp = await page.createCDPSession();
      const r = await page.$eval('.shopbar__cards', el => { const r = el.getBoundingClientRect(); return { x: r.right - 10, end: r.left + 10, y: r.top + r.height / 2 }; });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] });
      for (let step = 1; step <= 12; step++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: r.x + (r.end - r.x) * step / 12, y: r.y }] }); await pause(20); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach(); await pause(250);
      const last = await page.$eval('.shopbar__cards .scard:last-child', el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, hit: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }; });
      assert.ok(last.hit, 'the last offer is touch-reachable after a real swipe'); await shot('phone-shop-last-offer-' + width);
    }
    await tap('.funds__collapse'); await page.waitForSelector('.shopbar-tab'); await tap('.shopbar-tab__btn'); await page.waitForSelector('.shopbar');
    await tap('.readybtn'); if (await page.$('.modal')) await tap('.modal button', '准备');
    await page.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'COMBAT');
    await page.waitForFunction(() => globalThis.__SP_VIEW__?.raw?.stats?.()?.mode === 'battle');
    const code = await page.evaluate(() => globalThis.__SP__.store.get().room.code);
    const match = srv.lobby.getRoom(code).match;
    assert.equal(match.clientCombat, false); assert.equal(srv.combatPool.stats().sessions, 1); assert.equal(match.errorCount, 0);
    report.actualWorkerLease = true; await shot('phone-combat');
    const playerId = await page.evaluate(() => globalThis.__SP__.store.get().me.playerId);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__SP__?.store.get().connection.status === 'online' && !!document.querySelector('.gm'), { timeout: 30000 });
    const resumed = await page.evaluate(() => ({ playerId: globalThis.__SP__.store.get().me.playerId, code: globalThis.__SP__.store.get().room.code }));
    assert.equal(resumed.playerId, playerId, 'reload keeps the same player'); assert.equal(resumed.code, code, 'reload keeps the same room');
    await page.waitForFunction(() => globalThis.__SP_VIEW__?.kind === 'engine'); report.sameBrowserReconnect = true; await shot('phone-reconnect');
    const desktopContext = await browser.createBrowserContext();
    const desktop = await desktopContext.newPage();
    desktop.on('pageerror', error => report.pageErrors.push(error.message));
    await desktop.setViewport({ width: 1920, height: 1080 });
    await desktop.goto(srv.url, { waitUntil: 'domcontentloaded' });
    await desktop.waitForSelector('.title-login input'); await desktop.type('.title-login input', 'Desktop024'); await desktop.click('.title-login button');
    await desktop.waitForSelector('.lobby-screen'); await pause(500);
    if (await desktop.$('.announcement-board')) await desktop.click('.announcement-board .modal__actions button');
    assert.ok(await desktop.$eval('.online-players', el => {
      const r = el.getBoundingClientRect(); return r.width > 0 && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }));
    await desktop.screenshot({ path: out + '/desktop-lobby.png' }); report.screens.push(out + '/desktop-lobby.png');
    await desktop.click('.mode-card'); await desktop.click('.create-box button');
    await desktop.waitForSelector('.room-screen');
    const clickText = async (selector, text) => {
      const handles = await desktop.$$(selector);
      for (const handle of handles) if (await handle.evaluate((el, text) => !el.disabled && el.textContent.includes(text), text)) { await handle.click(); return; }
      assert.fail('desktop control missing: ' + text);
    };
    await clickText('.room-screen button', '开始模拟'); await desktop.waitForSelector('.brief'); await clickText('.brief__foot button', '准备就绪');
    await desktop.waitForSelector('.dband'); await desktop.click('.dband'); await clickText('.draft-detail__btns button', '确认选择');
    await desktop.waitForSelector('.shopbar__cards .scard');
    report.desktopShop = await desktop.$eval('.shopbar__cards .scard', el => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height, overflow: document.documentElement.scrollWidth - innerWidth }; });
    assert.equal(report.desktopShop.width, 156); assert.equal(report.desktopShop.height, 224); assert.equal(report.desktopShop.overflow, 0);
    await desktop.screenshot({ path: out + '/desktop-shop.png' }); report.screens.push(out + '/desktop-shop.png');
    await desktopContext.close();
    assert.deepEqual(report.pageErrors, []); assert.equal(report.externalRequests, 0); report.ok = true;
  } catch (error) {
    report.failureType = error.name;
    if (page && !page.isClosed()) {
      report.failureState = await page.evaluate(() => {
        const s = globalThis.__SP__?.store.get();
        return { connection: s?.connection.status, entered: s?.session.entered, phase: s?.match.public?.phase,
          hasRoom: !!s?.room, screen: document.querySelector('.screen')?.className, modal: document.querySelector('.modal__title')?.textContent,
          banner: document.querySelector('.conn-banner')?.textContent, crashed: !!document.querySelector('.crash') };
      });
      await page.screenshot({ path: out + '/failure.png' });
    }
    throw error;
  } finally {
    peer?.terminate(); await browser?.close(); await srv?.close(); report.closed = true;
    writeFileSync(out + '/browser.json', JSON.stringify(report, null, 2) + '\n');
    console.log('Mobile shop / online evidence: ' + out);
  }
});
