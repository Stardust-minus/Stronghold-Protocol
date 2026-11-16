// Browser E2E of 实验性功能 by group (the owner, 2026-11-16; ui/experimental.js, ui/roomSettings.js, ui/matchmaking.js,
// ui/matchOffer.js), real server, headless Chrome:
//   room   — the badge says only how many are on; a hover lists them by group, a first tap does on a touch screen (with
//            查看全部设置); the dialog opens on the first group with something on, its rail counts each group;
//   match  — 选择模拟协议 of 多人匹配: 我的实验性 opens its options at once when none is set, 开始多人匹配 waits for one that
//            counts, queue.join carries them; the version chip opens the picker and a pick changes the pool;
//   offer  — two lone tickets of the page's options and two taking any changed rules: 确认入场 lists the options by group
//            (与你的设置相同); another doctor leaves before the page confirms: it waits again in its place (本次匹配未成立
//            and why) and meets the next one of its options; a page taking any sees 由其他博士或小队设置 and leaves with
//            退出本次匹配.
// The server's budget of resend-heavy intents per connection (server/net.js NET_DEFAULTS heavyBurst 6, refilled at
// heavyPerSec 2; HEAVY_TYPES) is shared by queue.join and the lobby settings a page sends on its hello and again as
// 多人匹配 opens (room.loadout, room.ownership, room.diy, room.skins, room.card): a 开始多人匹配 right after them is answered
// RATE「queue.join too often」. The page says so (its toast, 操作过于频繁, and it stays idle: checked once on purpose); each
// real start waits until the budget is whole again (HEAVY_REFILL_MS) — the test does not change the server's limits.
//
//   SP_E2E=1 node --test test/ui/experimental-groups.e2e.test.js
//
// Screenshots: test/e2e/out/expgroups-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Client, hasChrome, startRealServer, problemsOf, sleep } from '../e2e/client.mjs';
import { TestClient } from '../helpers/wsClient.js';
import { MATCHMAKING_VERSION } from '../../shared/constants.js';
import { PLAYER_CAPACITY_VERSION } from '../../shared/playerCapacity.js';
import { NET_DEFAULTS } from '../../server/net.js';

const ENABLED = process.env.SP_E2E === '1' && hasChrome();
// a whole heavy budget again after any use (6 / 2 per s = 3 s), with a margin for a slow machine
const HEAVY_REFILL_MS = Math.ceil((1000 * NET_DEFAULTS.heavyBurst) / NET_DEFAULTS.heavyPerSec) + 500;
const R = (o = {}) => ({ revivalEnabled: false, disableSharedPool: false, ...o });
const ROOM = R({ revivalEnabled: true, enemyHpMul: 2, enemyAtkMul: 1.5, disableSharedPool: true });
const MINE = R({ revivalEnabled: true, disableLayerCap: true });
const OTHERS = R({ enemyAtkMul: 2, disableHitLimit: true });

describe('实验性功能 by group, 多人匹配 with own options (real server)', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome)' }, () => {
  test('room badge, 浮窗, dialog; 我的实验性 in 多人匹配; the version chip; 确认入场 lists the options', { timeout: 5 * 60 * 1000 }, async () => {
    const srv = await startRealServer();
    const P = (await import('puppeteer-core')).default;
    const clients = [], bots = [];
    const open = async (label, opts) => { const c = new Client(P, srv.base, label, { prefix: 'expgroups', ...opts }); clients.push(c); await c.open(); return c; };
    const lone = async (name, fields) => {
      const b = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`, { timeout: 15000 });
      bots.push(b);
      await b.hello(name, undefined, { matchmakingVersion: MATCHMAKING_VERSION, playerCapacityVersion: PLAYER_CAPACITY_VERSION });
      assert.equal((await b.request({ t: 'queue.join', difficulty: 'FUNNY', capacities: [4], ...fields })).t, 'ok');
      return b;
    };
    const openMatch = async (c) => {
      await c.click('.hub-entry', '同盟模拟');
      await c.page.waitForSelector('.ally', { visible: true, timeout: 15000 });
      await sleep(600);
      await c.click('.ally-pill', '多人匹配');
      await c.page.waitForSelector('[data-testid="match-scope"]', { visible: true, timeout: 15000 });
      await sleep(800);
    };
    try {
      // ---- the room ----
      const host = await open('host', { w: 1600, h: 900 });
      await host.enter('凯尔希');
      await host.createCoop();
      assert.match(await host.page.$eval('[data-testid="room-experimental"]', (el) => el.textContent), /实验性功能未开启/);
      await host.page.evaluate((o) => globalThis.__SP__.net.request('room.setExperimental', { experimental: o }), ROOM);
      await host.page.waitForFunction(() => document.querySelector('[data-testid="room-experimental"]')?.dataset.count === '4', { timeout: 10000 });
      assert.equal(await host.page.$('[data-testid="room-experimental-pop"]'), null, 'no list until asked');
      const pt = await host.point('[data-testid="room-experimental"]');
      await host.page.mouse.move(pt.x, pt.y);
      await host.page.waitForSelector('[data-testid="room-experimental-pop"]', { visible: true, timeout: 5000 });
      const groups = await host.page.$$eval('[data-testid="room-experimental-pop"] [data-group]', (els) => els.map((el) => el.dataset.group));
      assert.deepEqual(groups, ['team', 'enemy', 'pools']);
      await host.shot('room-hover');
      await host.page.mouse.click(pt.x, pt.y);
      await host.page.waitForSelector('.room-settings-modal', { visible: true });
      assert.equal(await host.page.$eval('[data-testid="exp-group-team"]', (el) => el.getAttribute('aria-selected')), 'true', 'the first group with something on');
      assert.deepEqual(await host.page.$$eval('.expp__tab', (els) => els.map((el) => el.textContent.trim())), ['同盟人数', '队友协作1', '盟约与策略', '敌人2', '卡池1', '特殊功能']);
      await host.click('[data-testid="exp-group-enemy"]');
      await host.page.waitForSelector('#experimental-enemy-atk', { visible: true });
      await host.shot('room-dialog');
      await host.page.keyboard.press('Escape');
      await host.page.waitForSelector('.room-settings-modal', { hidden: true });
      // a touch screen: the first tap shows the list, its button opens the dialog
      await host.page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true });
      await sleep(600);
      const tp = await host.point('[data-testid="room-experimental"]');
      await host.page.touchscreen.tap(tp.x, tp.y);
      await host.page.waitForSelector('[data-testid="room-experimental-open"]', { visible: true, timeout: 5000 });
      assert.equal(await host.page.$('.room-settings-modal'), null);
      await host.shot('room-tap');
      const op = await host.point('[data-testid="room-experimental-open"]');
      await host.page.touchscreen.tap(op.x, op.y);
      await host.page.waitForSelector('.room-settings-modal', { visible: true, timeout: 5000 });
      await host.close();

      // ---- 多人匹配: own options, the version chip ----
      const me = await open('match', { w: 1600, h: 900, prefs: { 'loadout.view': 'list', 'lobby.difficulty': 'FUNNY', 'lobby.matchDifficulties': ['FUNNY'] } });
      await me.enter('临光');
      await openMatch(me);
      await me.click('[data-testid="match-scope-custom"]'); // nothing set: its options open at once
      await me.page.waitForSelector('.match-options-modal', { visible: true, timeout: 5000 });
      assert.deepEqual(await me.page.$$eval('.match-options-modal .expp__tab', (els) => els.map((el) => el.dataset.testid)),
        ['exp-group-team', 'exp-group-bonds', 'exp-group-enemy', 'exp-group-pools']);
      await me.click('[data-testid="match-options-done"]');
      await me.page.waitForSelector('.match-options-modal', { hidden: true });
      await me.click('[data-testid="match-scope-standard"]'); // off: 我的实验性 alone
      assert.equal(await me.page.$eval('.proto-start', (el) => el.disabled), true, 'nothing set yet');
      await me.click('[data-testid="match-own-options"]');
      await me.page.waitForSelector('.match-options-modal', { visible: true });
      await me.click('#experimental-revival');
      await me.click('[data-testid="exp-group-bonds"]');
      await me.click('#experimental-layer-cap');
      await me.click('[data-testid="match-options-done"]');
      await me.page.waitForSelector('.match-options-modal', { hidden: true });
      assert.deepEqual(await me.page.evaluate(() => JSON.parse(localStorage.getItem('sp.pref.lobby.matchExperimental'))), MINE);
      assert.match(await me.page.$eval('[data-testid="match-own-options"]', (el) => el.textContent), /已开启 2 项/);
      assert.equal(await me.page.$eval('.proto-start', (el) => el.disabled), false);
      assert.deepEqual(await me.page.$$eval('.proto-scope__opt[aria-pressed="true"]', (els) => els.map((el) => el.dataset.testid)), ['match-scope-four', 'match-scope-custom']);
      // the version chip: the picker, a pick changes the lobby's version (the pool)
      await me.click('[data-testid="match-version"]');
      await me.page.waitForSelector('[data-testid="version-picker"]', { visible: true, timeout: 5000 });
      await me.shot('match-version');
      await me.page.keyboard.press('Escape');
      await me.page.waitForSelector('[data-testid="version-picker"]', { hidden: true });

      // ---- a start the server refuses for rate: the page says so and stays idle ----
      // (the budget spent on purpose: heavyBurst room.list in the same task as the click, so queue.join comes right after)
      await me.page.evaluate((n) => {
        for (let i = 0; i < n; i++) globalThis.__SP__.net.request('room.list').catch(() => {});
        document.querySelector('.proto-start').click();
      }, NET_DEFAULTS.heavyBurst);
      await me.page.waitForFunction(() => [...document.querySelectorAll('.toast .toast__text')].some((el) => el.textContent === '操作过于频繁'), { timeout: 5000 });
      assert.equal(await me.page.evaluate(() => globalThis.__SP__.store.get().queue.state), 'idle');
      assert.equal(await me.page.$eval('.proto-start', (el) => el.disabled), false, 'the start is offered again');
      await me.shot('match-rate');

      // ---- 确认入场: my options ----
      await lone('BotSame', { rules: ['custom'], experimental: MINE });
      await lone('BotAny1', { rules: ['experimental'] });
      await lone('BotAny2', { rules: ['standard', 'experimental'] });
      await sleep(HEAVY_REFILL_MS);
      await me.click('.proto-start', '开始多人匹配');
      await me.page.waitForSelector('[data-testid="offer-rules"]', { visible: true, timeout: 20000 });
      const q = await me.page.evaluate(() => globalThis.__SP__.store.get().queue);
      assert.deepEqual(q.config, MINE);
      assert.deepEqual(q.experimental, MINE);
      assert.equal(await me.page.$eval('[data-testid="offer-rules"]', (el) => el.dataset.origin), 'own');
      assert.deepEqual(await me.page.$$eval('[data-testid="offer-rules-list"] [data-key]', (els) => els.map((el) => el.dataset.key)), ['revivalEnabled', 'disableLayerCap']);
      assert.match(await me.page.$eval('[data-testid="offer-rules-chip"]', (el) => el.textContent), /实验性功能 · 2 项/);
      await sleep(1500);
      await me.shot('offer-own');
      // another doctor leaves before I confirmed (the owner, 2026-11-16): I wait again in my place, with my options, and
      // 本次匹配未成立 says why; then the same three meet a newcomer of my options again
      const leaver = bots.at(-1), left = await leaver.waitFor('queue.state', (m) => m.state === 'offered');
      assert.equal((await leaver.request({ t: 'queue.cancel', ticketId: left.ticketId })).t, 'ok');
      await me.page.waitForSelector('.mo.is-broken', { timeout: 10000 });
      assert.match(await me.page.$eval('[data-testid="offer-reason"]', (el) => el.textContent), /有队友退出了本次匹配，已保留排队位置/);
      await sleep(450);
      await me.shot('offer-peer-left-unconfirmed');
      await me.page.waitForFunction((t) => { const s = globalThis.__SP__.store.get().queue; return s.state === 'queued' && s.joinedAt === t; }, { timeout: 10000 }, q.joinedAt);
      assert.deepEqual(await me.page.evaluate(() => globalThis.__SP__.store.get().queue.config), MINE);
      await lone('BotSame2', { rules: ['custom'], experimental: MINE });
      await me.page.waitForSelector('[data-testid="offer-rules"]', { visible: true, timeout: 20000 });
      assert.equal(await me.page.$eval('[data-testid="offer-rules"]', (el) => el.dataset.origin), 'own');
      await me.click('[data-testid="offer-cancel"]');
      await me.page.waitForFunction(() => globalThis.__SP__.store.get().queue.state === 'idle', { timeout: 10000 });
      for (const b of bots.splice(0)) b.ws.terminate();
      await sleep(400);

      // ---- 确认入场: someone else's options, then 退出本次匹配 ----
      await me.click('[data-testid="match-scope-experimental"]');
      await me.click('[data-testid="match-scope-custom"]');
      assert.deepEqual(await me.page.$$eval('.proto-scope__opt[aria-pressed="true"]', (els) => els.map((el) => el.dataset.testid)), ['match-scope-four', 'match-scope-experimental']);
      await lone('BotOther', { rules: ['custom'], experimental: OTHERS });
      await lone('BotAny3', { rules: ['experimental'] });
      await lone('BotAny4', { rules: ['experimental'] });
      await sleep(HEAVY_REFILL_MS);
      await me.click('.proto-start', '开始多人匹配');
      await me.page.waitForSelector('[data-testid="offer-rules"]', { visible: true, timeout: 20000 });
      assert.equal(await me.page.$eval('[data-testid="offer-rules"]', (el) => el.dataset.origin), 'others');
      assert.match(await me.page.$eval('[data-testid="offer-rules"]', (el) => el.textContent), /由其他博士或小队设置.*敌人攻击 ×2.*禁用单次伤害上限.*退出本次匹配/);
      await sleep(1500);
      await me.shot('offer-others');
      await me.click('[data-testid="offer-cancel"]');
      await me.page.waitForFunction(() => globalThis.__SP__.store.get().queue.state === 'idle', { timeout: 10000 });
      assert.deepEqual(problemsOf(clients).filter((p) => !/illustration\/char_\w+_2\.png/.test(p)), []);
    } finally {
      for (const b of bots) b.ws.terminate();
      for (const c of clients) await c.close().catch(() => {});
      await srv.stop();
    }
  });
});
