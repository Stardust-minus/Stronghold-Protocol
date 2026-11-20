// Real-server browser E2E of ELO (docs/history/0.4.0.md §37.275; shared/experimental.js isEloRoom, ui/eloPanel.js): the
// host turns it on from the room settings — first the reminder, 此功能仅为娱乐, with the host's own panel —; every other
// seated player meets it once in a dialog with their own panel; the room's notice and the rule list's 浮窗 show each
// reader's own level only. Three browsers with seeded local records: a strong host (压), a weak guest (帮) and a guest
// with too few records (不调). Each page sends its own matches (room.elo), and nobody's page holds another's.
//
//   SP_E2E=1 node --test test/ui/elo-room.e2e.test.js
//
// Screenshots: test/e2e/out/elo-*.png (SP_ELO_SHOTS=<dir>: there instead, animations off; SP_ELO_FONT=<dir of the
// noto-sans-sc woff2 files>: that face for the Chinese text on a host without a CJK font).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client, ROOT, sleep, hasChrome, startRealServer } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome() && existsSync(path.join(ROOT, 'public/assets'));
const SHOTS = process.env.SP_ELO_SHOTS || null;
const FONT = process.env.SP_ELO_FONT || null;
const NO_ANIM = '*,*::before,*::after{animation:none!important;transition:none!important}';
const fontCss = FONT ? [400, 500, 700].map((w) => {
  const b64 = readFileSync(path.join(FONT, `noto-sans-sc-chinese-simplified-${w}-normal.woff2`)).toString('base64');
  return `@font-face{font-family:'Noto Sans SC';font-style:normal;font-weight:${w};font-display:block;src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
}).join('\n') : '';

/** A local stats envelope (ui/stats.js, sp.pref.stats): `wins` of `games` settled records per mode of 终极模拟, every loss after 9 rounds. */
function stats(wins, games) {
  const records = [];
  for (const roomMode of ['coop', 'solo']) {
    for (let i = 0; i < games; i++) {
      const won = i < wins;
      records.push({ v: 3, t: 1_700_000_000_000 - i * 3_600_000, id: `seed-${roomMode}-${i}`, end: 'settled', victory: won, roundsPassed: won ? 14 : 9,
        modeId: roomMode === 'coop' ? 'mode_multi_abyss' : 'mode_single_abyss', difficulty: 'ABYSS', roomMode, selfId: 'me',
        players: [{ playerId: 'me', seat: 0, alive: won, victory: won, roundsPassed: won ? 14 : 9, stats: {} }] });
    }
  }
  return { v: 3, records };
}
const prefs = (wins, games) => ({ 'loadout.view': 'list', stats: stats(wins, games) });

async function shot(c, name, { hover = false } = {}) {
  await c.page.waitForFunction(() => !document.querySelector('.pbanner--overlay'), { timeout: 10000 }).catch(() => {});
  if (!hover) await c.page.mouse.move(2, 2); // the page's own cursor sprite stays off the text
  if (!SHOTS) return c.shot(name);
  await c.page.addStyleTag({ content: NO_ANIM });
  await sleep(300);
  await c.page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  return name;
}
/** What this page asks the server for room.elo (its net.request, wrapped: the sync engine looks it up at every send). */
const spy = (c) => c.page.evaluate(() => {
  const net = globalThis.__SP__.net, request = net.request.bind(net);
  window.__ELO_SENT__ = [];
  net.request = (t, fields, opts) => { if (t === 'room.elo') window.__ELO_SENT__.push(fields.rec); return request(t, fields, opts); };
});
const sentElo = (c) => c.page.evaluate(() => window.__ELO_SENT__ || []);
async function open(c, name) {
  await c.open();
  if (fontCss) {
    // the page's font-src policy refuses a data: face: bypassed for this browser, the face in every document from now on
    await c.page.setBypassCSP(true);
    await c.page.evaluateOnNewDocument((css) => {
      const add = () => { const st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st); };
      if (document.documentElement) add(); else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); add(); } }).observe(document, { childList: true });
    }, fontCss);
    await c.page.reload({ waitUntil: 'domcontentloaded' });
    await c.page.waitForFunction(() => !!globalThis.__SP__ && !!document.querySelector('.screen'), { timeout: 30000 });
  }
  await c.enter(name);
  await spy(c);
  if (fontCss) await c.page.evaluate(() => document.fonts.load("16px 'Noto Sans SC'", '盟约'));
}
const eloOn = (c) => c.page.evaluate(() => globalThis.__SP__.store.get().room?.experimental?.elo === true);
const group = (c, id) => c.click(`[data-testid="exp-group-${id}"]`);
const panelText = (c) => c.page.$eval('[data-testid="elo-panel"]', (e) => ({ text: e.textContent, dir: e.dataset.dir, level: Number(e.dataset.level) }));
async function badge(c) {
  await c.page.mouse.move(2, 2);
  const pt = await c.point('[data-testid="room-experimental"]');
  await c.page.mouse.move(pt.x, pt.y);
  await c.page.waitForSelector('[data-testid="room-experimental-pop"]', { visible: true, timeout: 5000 });
  return c.page.$eval('[data-testid="room-experimental-pop"]', (e) => e.textContent);
}

describe('ELO (real server)', { skip: !ENABLED && 'set SP_E2E=1 (Chrome + public/assets)' }, () => {
  test('the host\'s reminder with the own panel; every guest\'s own panel on meeting it; the notice and the rule list are each reader\'s', { timeout: 6 * 60 * 1000 }, async () => {
    const srv = await startRealServer();
    const P = (await import('puppeteer-core')).default;
    const host = new Client(P, srv.base, 'host', { prefix: 'elo', w: 1280, h: 720, prefs: prefs(30, 30) });
    const weak = new Client(P, srv.base, 'weak', { prefix: 'elo', w: 1280, h: 720, prefs: prefs(2, 30) });
    const fresh = new Client(P, srv.base, 'fresh', { prefix: 'elo', w: 1280, h: 720, prefs: prefs(2, 3) });
    try {
      await open(host, '强手房主');
      await host.createCoop('终极模拟');
      const code = await host.page.evaluate(() => globalThis.__SP__.store.get().room.code);
      await sleep(800);
      assert.deepEqual(await sentElo(host), [], 'nothing leaves the page before the room has the option');

      // the host: 同盟设置 → 特殊功能 → ELO → the reminder with the own panel (30 of 30: 压 · 4 级) → 开启
      await host.click('.rs-exp');
      await host.page.waitForSelector('.room-settings-modal', { visible: true, timeout: 10000 });
      await group(host, 'special');
      await host.page.waitForSelector('#experimental-elo', { visible: true, timeout: 10000 });
      await host.page.$eval('#experimental-elo', (e) => e.scrollIntoView({ block: 'center' }));
      await shot(host, 'elo-1-host-switch');
      await host.page.click('#experimental-elo');
      await host.page.waitForSelector('[data-testid="elo-reminder"] [data-testid="elo-panel"]', { visible: true, timeout: 5000 });
      assert.equal(await host.page.$eval('#experimental-elo', (e) => e.checked), false, 'off behind the reminder');
      const mine = await panelText(host);
      assert.equal(mine.dir, 'hinder');
      assert.equal(mine.level, 4);
      assert.match(mine.text, /此功能仅为娱乐/);
      assert.match(mine.text, /最近 30 局同盟·终极模拟：30 胜 0 负，胜率 100%/);
      assert.match(mine.text, /几乎刷不到/);
      assert.match(mine.text, /计入成就/);
      await shot(host, 'elo-2-host-reminder-hindered');
      await host.click('.modal__actions .btn--primary', '开启');
      await host.page.waitForFunction(() => globalThis.__SP__.store.get().room?.experimental?.elo === true, { timeout: 8000 });
      await host.click('.room-settings-modal .modal__actions button', '完成');
      await host.page.waitForSelector('.room-settings-modal', { hidden: true, timeout: 10000 });
      await host.page.waitForSelector('[data-testid="elo-notice"]', { visible: true, timeout: 8000 });
      assert.equal(await host.exists('[data-testid="elo-panel"]'), false, 'the host saw it in the reminder: no second dialog');
      await host.page.waitForFunction(() => (window.__ELO_SENT__ || []).length > 0, { timeout: 8000 });
      assert.deepEqual((await sentElo(host)).at(-1)['coop:ABYSS'], Array.from({ length: 30 }, () => [1, 14]), 'the host\'s own matches went to the server');
      await host.page.waitForFunction(async () => (await import('/js/ui/loadoutSync.js')).eloStore.get().eloSync === 'synced', { timeout: 8000 });
      assert.match(await host.page.$eval('[data-testid="elo-notice-brief"]', (e) => e.textContent), /压 · 4 级/);
      await shot(host, 'elo-3-host-room-notice');

      // the guests: each meets it in a dialog with the own panel, the notice and the rule list say their own level
      for (const [c, name, dir, re, file] of [[weak, '新手队友', 'help', /按 27.2 局计.*帮 · 3 级/, 'elo-4-guest-helped'], [fresh, '新来的队友', 'none', /按 2.9 局计.*折算后不足 5 局，暂不调整/, 'elo-5-guest-neutral']]) {
        await open(c, name);
        await c.click('.hub-tile', '密钥加入');
        await c.click('.hub-dialog .join-row input');
        await c.page.keyboard.type(code);
        await c.click('.join-row button', '加入同盟');
        await c.waitFor((s) => s.room?.code === code, `${name} in the room`, 20000);
        await c.page.waitForSelector('[data-testid="elo-panel"]', { visible: true, timeout: 8000 });
        const p = await panelText(c);
        assert.equal(p.dir, dir, name);
        assert.match(p.text, re);
        assert.match(p.text, /此功能仅为娱乐/);
        assert.doesNotMatch(p.text, /30 胜 0 负/, 'never the host\'s numbers');
        await shot(c, file);
        await c.click('.modal__actions .btn--primary', '知道了');
        await c.page.waitForSelector('[data-testid="elo-panel"]', { hidden: true, timeout: 5000 });
        await c.page.waitForFunction(() => (window.__ELO_SENT__ || []).length > 0, { timeout: 8000 });
      }
      assert.deepEqual((await sentElo(weak)).at(-1)['coop:ABYSS'], [[1, 14], [1, 14], ...Array.from({ length: 28 }, () => [0, 9])]);
      assert.deepEqual((await sentElo(fresh)).at(-1)['coop:ABYSS'], [[1, 14], [1, 14], [0, 9]]);
      const pop = await badge(weak);
      assert.match(pop, /特殊功能.*ELO/);
      assert.match(pop, /帮 · 3 级/);
      assert.doesNotMatch(pop, /压 · 4 级/);
      await shot(weak, 'elo-6-guest-rule-list', { hover: true });
      await weak.page.mouse.move(2, 2);
      await shot(fresh, 'elo-7-guest-room-notice-neutral');
      // 详情 opens the own panel again
      await weak.click('[data-testid="elo-notice-more"]');
      await weak.page.waitForSelector('[data-testid="elo-panel"]', { visible: true, timeout: 5000 });
      assert.equal((await panelText(weak)).dir, 'help');
      await weak.click('.modal__actions .btn--primary', '知道了');
      assert.equal(await eloOn(fresh), true);
      // (a checkout's art may lack an illustration a seat card asks for: material, not this page)
      for (const c of [host, weak, fresh]) assert.deepEqual(c.problems.filter((x) => !/favicon|ERR_ABORTED|\/assets\/char\/illustration\//.test(x)), [], c.label);
    } finally {
      for (const c of [host, weak, fresh]) await c.close().catch(() => {});
      await srv.stop();
    }
  });
});
