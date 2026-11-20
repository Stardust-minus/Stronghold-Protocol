// Browser E2E of 卡池静态初始化 (the owner, 2026-11-20, docs/history/0.4.0.md §37.272; ui/experimental.js poolRows,
// ui/roomSettings.js, ui/matchOffer.js), real server, headless Chrome:
//   room  — the 卡池 group has the switch between 禁用共享卡池 and 手动指定卡池编组; turning it on counts in the room's
//           badge and its 浮窗 names it; 禁用共享卡池 greys it and the server drops it (nothing to deal);
//   offer — 我的实验性 with it on meets three lone tickets of the same options, and 确认入场 lists it (与你的设置相同).
//
//   SP_E2E=1 node --test test/ui/static-pool-split.e2e.test.js
//
// Screenshots: test/e2e/out/poolsplit-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Client, hasChrome, startRealServer, problemsOf, sleep } from '../e2e/client.mjs';
import { TestClient } from '../helpers/wsClient.js';
import { MATCHMAKING_VERSION } from '../../shared/constants.js';
import { PLAYER_CAPACITY_VERSION } from '../../shared/playerCapacity.js';
import { NET_DEFAULTS } from '../../server/net.js';
import { getData } from '../../server/data.js';
import { GameData } from '../../server/match/gamedata.js';

const ENABLED = process.env.SP_E2E === '1' && hasChrome();
// a whole heavy budget again after any use (experimental-groups.e2e.test.js: queue.join shares it with the page's hello)
const HEAVY_REFILL_MS = Math.ceil((1000 * NET_DEFAULTS.heavyBurst) / NET_DEFAULTS.heavyPerSec) + 500;
const SPLIT = { revivalEnabled: false, disableSharedPool: false, staticPoolSplit: true };

describe('卡池静态初始化 in the room and in 确认入场 (real server)', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome)' }, () => {
  test('the switch, its badge and 浮窗, greyed by 禁用共享卡池; a ticket of it meets the same and 确认入场 lists it', { timeout: 4 * 60 * 1000 }, async () => {
    const srv = await startRealServer();
    const P = (await import('puppeteer-core')).default;
    const clients = [], bots = [];
    const open = async (label, opts) => { const c = new Client(P, srv.base, label, { prefix: 'poolsplit', ...opts }); clients.push(c); await c.open(); return c; };
    const lone = async (name, fields) => {
      const b = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`, { timeout: 15000 });
      bots.push(b);
      await b.hello(name, undefined, { matchmakingVersion: MATCHMAKING_VERSION, playerCapacityVersion: PLAYER_CAPACITY_VERSION });
      assert.equal((await b.request({ t: 'queue.join', difficulty: 'FUNNY', capacities: [4], ...fields })).t, 'ok');
      return b;
    };
    const roomOptions = (c) => c.page.evaluate(() => globalThis.__SP__.store.get().room?.experimental);
    try {
      // ---- the room ----
      const host = await open('host', { w: 1600, h: 900 });
      await host.enter('凯尔希');
      await host.createCoop();
      await host.click('[data-testid="room-experimental"]');
      await host.page.waitForSelector('.room-settings-modal', { visible: true, timeout: 10000 });
      await host.click('[data-testid="exp-group-pools"]');
      await host.page.waitForSelector('#experimental-pool-split', { visible: true, timeout: 5000 });
      assert.deepEqual(await host.page.$$eval('#expp-rows input[role="switch"]', (els) => els.map((el) => el.id)),
        ['experimental-pool', 'experimental-pool-split', 'experimental-pools-manual']);
      assert.match(await host.page.$eval('label[for="experimental-pool-split"]', (el) => el.textContent), /卡池静态初始化.*按阶级/);
      await host.click('#experimental-pool-split');
      await host.page.waitForFunction(() => document.querySelector('[data-testid="room-experimental"]')?.dataset.count === '1', { timeout: 10000 });
      assert.deepEqual(await roomOptions(host), SPLIT);
      assert.equal(await host.page.$eval('#experimental-pool-split', (el) => el.checked), true);
      await sleep(400);
      await host.shot('room-dialog');
      // 禁用共享卡池: every seat has a whole pool — the switch waits, the server keeps nothing of it
      await host.click('#experimental-pool');
      await host.page.waitForFunction(() => { const el = document.querySelector('#experimental-pool-split'); return !!el && el.disabled && !el.checked; }, { timeout: 10000 });
      assert.deepEqual(await roomOptions(host), { revivalEnabled: false, disableSharedPool: true });
      assert.match(await host.page.$eval('label[for="experimental-pool-split"]', (el) => el.textContent), /此项不生效/);
      await sleep(400);
      await host.shot('room-independent');
      await host.click('#experimental-pool');
      await host.page.waitForFunction(() => { const el = document.querySelector('#experimental-pool-split'); return !!el && !el.disabled; }, { timeout: 10000 });
      await host.click('#experimental-pool-split');
      await host.page.waitForFunction(() => document.querySelector('[data-testid="room-experimental"]')?.dataset.count === '1', { timeout: 10000 });
      await host.page.keyboard.press('Escape');
      await host.page.waitForSelector('.room-settings-modal', { hidden: true, timeout: 5000 });
      const pt = await host.point('[data-testid="room-experimental"]');
      await host.page.mouse.move(pt.x, pt.y);
      await host.page.waitForSelector('[data-testid="room-experimental-pop"]', { visible: true, timeout: 5000 });
      assert.deepEqual(await host.page.$$eval('[data-testid="room-experimental-pop"] [data-key]', (els) => els.map((el) => [el.closest('[data-group]')?.dataset.group, el.dataset.key, el.textContent])),
        [['pools', 'staticPoolSplit', '卡池静态初始化']]);
      await sleep(400);
      await host.shot('room-hover');
      await host.close();

      // ---- 确认入场 ----
      const me = await open('match', { w: 1600, h: 900, prefs: { 'loadout.view': 'list', 'lobby.difficulty': 'FUNNY', 'lobby.matchDifficulties': ['FUNNY'] } });
      await me.enter('临光');
      await me.click('.hub-entry', '同盟模拟');
      await me.page.waitForSelector('.ally', { visible: true, timeout: 15000 });
      await sleep(600);
      await me.click('.ally-pill', '多人匹配');
      await me.page.waitForSelector('[data-testid="match-scope"]', { visible: true, timeout: 15000 });
      await sleep(800);
      await me.click('[data-testid="match-scope-custom"]'); // nothing set: its options open at once
      await me.page.waitForSelector('.match-options-modal', { visible: true, timeout: 5000 });
      await me.click('[data-testid="exp-group-pools"]');
      await me.page.waitForSelector('#experimental-pool-split', { visible: true, timeout: 5000 });
      await me.click('#experimental-pool-split');
      await me.click('[data-testid="match-options-done"]');
      await me.page.waitForSelector('.match-options-modal', { hidden: true });
      await me.click('[data-testid="match-scope-standard"]'); // 我的实验性 alone
      assert.deepEqual(await me.page.evaluate(() => JSON.parse(localStorage.getItem('sp.pref.lobby.matchExperimental'))), SPLIT);
      for (const name of ['BotSplit1', 'BotSplit2', 'BotSplit3']) await lone(name, { rules: ['custom'], experimental: SPLIT });
      await sleep(HEAVY_REFILL_MS);
      await me.click('.proto-start', '开始多人匹配');
      await me.page.waitForSelector('[data-testid="offer-rules"]', { visible: true, timeout: 20000 });
      const q = await me.page.evaluate(() => globalThis.__SP__.store.get().queue);
      assert.deepEqual(q.experimental, SPLIT);
      assert.equal(await me.page.$eval('[data-testid="offer-rules"]', (el) => el.dataset.origin), 'own');
      assert.deepEqual(await me.page.$$eval('[data-testid="offer-rules-list"] [data-key]', (els) => els.map((el) => el.dataset.key)), ['staticPoolSplit']);
      assert.match(await me.page.$eval('[data-testid="offer-rules-chip"]', (el) => el.textContent), /实验性功能 · 1 项/);
      await sleep(1500);
      await me.shot('offer-own');
      await me.click('[data-testid="offer-cancel"]');
      await me.page.waitForFunction(() => globalThis.__SP__.store.get().queue.state === 'idle', { timeout: 10000 });
      assert.deepEqual(problemsOf(clients).filter((p) => !/illustration\/char_\w+_2\.png/.test(p)), []);
    } finally {
      for (const b of bots) b.ws.terminate();
      for (const c of clients) await c.close().catch(() => {});
      await srv.stop();
    }
  });

  test('a match of it: the shop\'s 「余 n」 is the seat\'s own share — about a quarter of the pool, per tier', { timeout: 4 * 60 * 1000 }, async () => {
    const srv = await startRealServer();
    const P = (await import('puppeteer-core')).default;
    const c = new Client(P, srv.base, 'shop', { prefix: 'poolsplit', w: 1600, h: 900 });
    try {
      await c.open();
      await c.enter('凯尔希');
      await c.createCoop();
      await c.page.evaluate((o) => globalThis.__SP__.net.request('room.setExperimental', { experimental: o }), SPLIT);
      for (let i = 0; i < 3; i++) await c.page.evaluate(() => globalThis.__SP__.net.request('room.addBot', {}));
      await c.page.waitForFunction(() => globalThis.__SP__.store.get().room?.seats?.filter(Boolean).length === 4, { timeout: 10000 });
      await c.roomStart({ timeout: 20000 });
      await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 40000);
      await c.settled('.brief-go');
      await c.click('.brief__foot .btn--primary', '准备就绪');
      for (let i = 0; i < 240; i++) {
        const st = await c.st();
        if (st.phase === 'PREP') break;
        if (st.phase === 'BAND_DRAFT' && st.draft?.turn === st.me) {
          await c.click('.dband:not(.is-taken)', null, { nth: 0 });
          await c.click('.draft-detail__btns .btn--primary', '确认选择');
        }
        await sleep(250);
      }
      await c.page.waitForSelector('.shopbar .pooltag', { visible: true, timeout: 30000 });
      const { pub, priv } = await c.page.evaluate(() => { const m = globalThis.__SP__.store.get().match; return { pub: m.public, priv: m.private }; });
      assert.equal(pub.experimental.staticPoolSplit, true);
      assert.ok(priv.poolLeft?.chess, 'four seats share the group: counts are sent');
      // the whole group pool of this match, per tier (the server's data and bans): one seat holds a quarter of each, ±1
      const gd = new GameData(getData({ log: { warn() {}, info() {}, error() {} } }), pub.modeId || 'mode_multi_normal');
      const banned = new Set(pub.bannedChess || []);
      const whole = {}, mine = {};
      for (const id of gd.visibleChess) if (!banned.has(id) && gd.poolCopies(id) > 0) whole[gd.tierOf(id)] = (whole[gd.tierOf(id)] || 0) + gd.poolCopies(id);
      for (const [id, n] of Object.entries(priv.poolLeft.chess)) mine[gd.tierOf(id)] = (mine[gd.tierOf(id)] || 0) + n;
      for (const tier of Object.keys(whole)) assert.ok(mine[tier] <= Math.ceil(whole[tier] / 4), `tier ${tier}: ${mine[tier]} of ${whole[tier]}`);
      // the tags read those counts
      const tags = await c.page.$$eval('.shopbar .scard', (els) => els.map((el) => el.querySelector('.pooltag')?.dataset.poolLeft ?? null));
      assert.ok(tags.some((n) => n != null));
      const want = (priv.shop?.slots || []).filter((s) => s && s.kind === 'chess' && Number.isInteger(priv.poolLeft.chess[s.id])).map((s) => String(priv.poolLeft.chess[s.id]));
      for (const n of want) assert.ok(tags.includes(n), `a shop card shows 余 ${n}`);
      await sleep(800);
      await c.shot('shop');
      assert.deepEqual(problemsOf([c]).filter((p) => !/illustration\/char_\w+_2\.png/.test(p)), []);
    } finally {
      await c.close().catch(() => {});
      await srv.stop();
    }
  });
});
