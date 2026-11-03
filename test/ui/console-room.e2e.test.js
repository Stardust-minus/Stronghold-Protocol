// Real-server browser E2E of the 调控台 (feedback #125; shared/experimental.js isConsoleRoom, ui/consoleRoom.js,
// ui/testConsole.js): the host turns it on from the room settings — the warning's confirm stays disabled for its 5 s hold
// —, every member sees the room's notice; in the match every seated player gets the 调控台 panel for their own seat. In
// co-op with another human the match-wide controls are gone (a note says why) and a guest's grant changes the guest only;
// solo keeps them, and 悬赏目标 takes a count.
//
//   SP_E2E=1 node --test test/ui/console-room.e2e.test.js
//
// Screenshots: test/e2e/out/console-*.png (SP_CON_SHOTS=<dir>: there instead, animations off — the room switch, the
// warning and the notice, then v3-*: the guest's panel, 盟约 layers, 加入敌人, a long log, 667×375).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client, ROOT, sleep, hasChrome, startRealServer } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome() && existsSync(path.join(ROOT, 'public/assets'));
const SHOTS = process.env.SP_CON_SHOTS || null;
const HOLD = '[data-testid="dialog-hold-ok"]';
const NO_ANIM = '*,*::before,*::after{animation:none!important;transition:none!important}';
const consoleOn = (c) => c.page.evaluate(() => globalThis.__SP__.store.get().room?.experimental?.console === true);
async function shot(c, name) {
  // the phase banner of a new phase (a timed overlay) is not part of the picture
  await c.page.waitForFunction(() => !document.querySelector('.pbanner--overlay'), { timeout: 10000 }).catch(() => {});
  if (!SHOTS) return c.shot(name);
  await c.page.addStyleTag({ content: NO_ANIM });
  await sleep(300);
  await c.page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  return name;
}
/** 执行 (scrolled into the panel's view first: a long body scrolls). */
async function run(c) {
  await c.page.$eval('[data-testid="console-run"]', (b) => b.scrollIntoView({ block: 'nearest' }));
  await c.click('[data-testid="console-run"]');
}

/** Host: 实验性选项 → 调控台 → wait out the 5 s hold → 开启 (`snap`: screenshots of the switch and the warning). */
async function turnOn(host, snap = null) {
  await host.click('.rs-exp');
  await host.page.waitForSelector('#experimental-console', { visible: true, timeout: 10000 });
  if (snap) {
    await host.page.$eval('#experimental-console', (e) => e.scrollIntoView({ block: 'center' }));
    await shot(host, `${snap}-settings-switch`);
  }
  await host.page.click('#experimental-console');
  await host.page.waitForSelector('[data-testid="console-warning"]', { visible: true, timeout: 5000 });
  assert.deepEqual(await host.page.$eval(HOLD, (b) => ({ disabled: b.disabled, left: Number(b.dataset.left) })), { disabled: true, left: 5 });
  assert.equal(await host.page.$eval('#experimental-console', (e) => e.checked), false, 'the switch stays off behind the warning');
  await sleep(800);
  if (snap) await shot(host, `${snap}-confirm-hold`);
  await host.page.$eval(HOLD, (b) => b.click());
  await sleep(300);
  assert.equal(await consoleOn(host), false, 'held: nothing sent');
  await host.page.waitForFunction((sel) => document.querySelector(sel)?.disabled === false, { timeout: 8000 }, HOLD);
  await host.click(HOLD);
  await host.page.waitForFunction(() => globalThis.__SP__.store.get().room?.experimental?.console === true, { timeout: 8000 });
  assert.equal(await host.page.$eval('#experimental-console', (e) => e.checked), true);
  await host.click('.room-settings-modal .modal__actions button', '完成');
  await host.page.waitForSelector('.room-settings-modal', { hidden: true, timeout: 10000 });
}

/** Every client: 准备就绪 in the briefing, its strategy on its turn, until PREP. */
async function toPrep(clients) {
  for (const c of clients) await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 40000);
  for (const c of clients) { await c.settled('.brief-go'); await c.click('.brief__foot .btn--primary', '准备就绪'); }
  for (let i = 0; i < 240; i++) {
    const states = await Promise.all(clients.map((c) => c.st()));
    if (states.every((s) => s.phase === 'PREP')) return;
    for (let k = 0; k < clients.length; k++) {
      const s = states[k];
      if (s.phase === 'BAND_DRAFT' && s.draft?.turn === s.me) {
        await clients[k].click('.dband:not(.is-taken)', null, { nth: 0 });
        await clients[k].click('.draft-detail__btns .btn--primary', '确认选择');
      }
    }
    await sleep(250);
  }
  throw new Error('no PREP');
}

/** Open the panel. */
async function openPanel(c) {
  await c.page.waitForSelector('[data-testid="test-console"] .testconsole__tab', { visible: true, timeout: 15000 });
  const label = await c.page.$eval('[data-testid="test-console"] .testconsole__tab', (b) => b.textContent.trim());
  if (label !== '收起') await c.click('[data-testid="test-console"] .testconsole__tab');
  await c.page.waitForSelector('[data-testid="console-body"]', { visible: true, timeout: 5000 });
}
/** Pick a command; `fields`: data-testid → text typed over the field's value. */
async function setCmd(c, cmd, fields = {}) {
  await c.page.select('[data-testid="console-cmd"]', cmd);
  await sleep(150);
  for (const [id, text] of Object.entries(fields)) {
    const el = await c.page.waitForSelector(`[data-testid="${id}"]`, { visible: true, timeout: 5000 });
    await el.click();
    await el.evaluate((e) => e.select()); // the whole value: typing replaces it
    await c.page.keyboard.press('Backspace');
    await c.page.keyboard.type(String(text));
  }
  await sleep(150);
}
/** Whether the open dock's header is inside the viewport and whether its form area needs a scroll bar. */
const layout = (c) => c.page.evaluate(() => {
  const head = document.querySelector('.testconsole__head').getBoundingClientRect(), mid = document.querySelector('.testconsole__mid');
  const box = document.querySelector('[data-testid="test-console"]').getBoundingClientRect();
  return { headInView: head.top >= Math.max(0, box.top) && head.bottom <= innerHeight, midScrolls: mid.scrollHeight > mid.clientHeight + 1 };
});
const testLog = (c) => c.page.evaluate(() => globalThis.__SP__.store.get().match.public?.testLog || []);
const logLines = (c) => c.page.$$eval('[data-testid="console-log"] li', (list) => list.map((li) => li.textContent.trim()));

describe('调控台 (real server)', { skip: !ENABLED && 'set SP_E2E=1 (Chrome + public/assets)' }, () => {
  test('co-op: 5 s warning → notices → every player has the panel for their own seat, no match-wide controls', { timeout: 6 * 60 * 1000 }, async () => {
    const srv = await startRealServer({ fast: { timerScale: 1, combatSpeed: 2 } });
    const P = (await import('puppeteer-core')).default;
    const host = new Client(P, srv.base, 'host', { prefix: 'console', w: 1280, h: 720 });
    const guest = new Client(P, srv.base, 'guest', { prefix: 'console', w: 1280, h: 720 });
    try {
      await host.open();
      await host.enter('调控台房主');
      const { code } = await host.createCoop();
      await guest.open();
      await guest.enter('调控台队友');
      await guest.click('.hub-tile', '密钥加入');
      await guest.click('.hub-dialog .join-row input');
      await guest.page.keyboard.type(code);
      await guest.click('.join-row button', '加入同盟');
      await guest.waitFor((s) => s.room?.code === code, 'guest in the room', 20000);

      await turnOn(host, 'coop');
      for (const c of [host, guest]) await c.page.waitForSelector('.rs-collab [data-testid="console-notice"]', { visible: true, timeout: 8000 });
      const summary = await host.page.$eval('.rs-exp small', (el) => el.textContent);
      assert.match(summary, /调控台/);
      await shot(guest, 'coop-room-notice');

      await guest.roomReady({ timeout: 20000 });
      await host.roomStart({ timeout: 20000 });
      await toPrep([host, guest]);
      await guest.page.waitForFunction(() => !document.querySelector('.pbanner--overlay'), { timeout: 10000 }).catch(() => {});

      // the guest: the panel for its own seat; the match-wide controls are replaced by a note
      await openPanel(guest);
      assert.equal(await guest.page.$eval('.testconsole__head .testmark', (b) => b.textContent.trim()), '调控台');
      assert.equal(await guest.page.$eval('.testconsole__head b', (b) => b.textContent.trim()), '指令');
      assert.ok(await guest.exists('[data-testid="test-console-shared-off"]'), 'the note');
      const options = await guest.page.$$eval('[data-testid="console-cmd"] option', (list) => list.map((o) => o.value));
      for (const cmd of ['round', 'hp', 'teamLp', 'shop', 'choice']) assert.equal(options.includes(cmd), false, cmd);
      const hostFunds = (await host.st()).funds;
      await setCmd(guest, 'funds', { 'console-amount': 777 });
      await run(guest);
      await guest.waitFor((s) => s.funds === 777, 'the guest\'s funds', 8000);
      assert.equal((await host.st()).funds, hostFunds, 'the host is untouched');
      await guest.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="console-log"] li')].some((li) => li.textContent.includes('资金 → 777')), { timeout: 5000 });
      await shot(guest, 'v3-coop-guest');
      await openPanel(host);
      assert.ok(await host.exists('[data-testid="test-console-shared-off"]'), 'the host has another human too');
      assert.equal(await host.page.evaluate(() => globalThis.__SP__.store.get().match.public?.test), true);
    } finally {
      await host.close(); await guest.close();
      await srv.stop();
    }
  });

  test('solo: the only human keeps the match-wide controls; 悬赏目标 takes a count', { timeout: 5 * 60 * 1000 }, async () => {
    const srv = await startRealServer({ fast: { timerScale: 1, combatSpeed: 2 } });
    const P = (await import('puppeteer-core')).default;
    const c = new Client(P, srv.base, 'solo', { prefix: 'console-solo', w: 1280, h: 720 });
    try {
      await c.open();
      await c.enter('调控台单人');
      await c.createSolo('标准模拟');
      await c.waitFor((s) => !!s.room, 'solo room');
      await turnOn(c, 'solo');
      await c.page.waitForSelector('[data-testid="console-notice"]', { visible: true, timeout: 8000 });
      await c.roomStart({ timeout: 20000 });
      await toPrep([c]);
      await c.page.waitForFunction(() => !document.querySelector('.pbanner--overlay'), { timeout: 10000 }).catch(() => {});
      await openPanel(c);
      assert.equal(await c.exists('[data-testid="test-console-shared-off"]'), false);
      const options = await c.page.$$eval('[data-testid="console-cmd"] option', (list) => list.map((o) => o.value));
      for (const cmd of ['round', 'hp', 'teamLp']) assert.ok(options.includes(cmd), cmd);
      await c.page.$$eval('.testconsole__row button', (list) => list.find((b) => b.textContent.includes('关闭计时'))?.scrollIntoView({ block: 'nearest' }));
      await c.click('.testconsole__row button', '关闭计时');
      await c.page.waitForFunction(() => globalThis.__SP__.store.get().match.public?.testTimers === false, { timeout: 8000 });
      const pick = await c.page.evaluate(async () => {
        const get = async (f) => (await fetch(`/data/${f}.json`, { credentials: 'same-origin' })).json();
        const [chess, enemies, bosses] = await Promise.all([get('chess'), get('enemies'), get('bosses')]);
        const leaders = new Set(Object.values(bosses).map((b) => b.enemyKey));
        const op = Object.entries(chess).find(([, r]) => r.tier === 6 && !r.isGolden && !r.isDiy && r.isHidden !== true);
        const foe = Object.entries(enemies).find(([k, r]) => !leaders.has(k) && r.rank === 'NORMAL' && !r.tokenOnly);
        return { chessId: op[0], chessName: op[1].name, enemyKey: foe[0], enemyName: foe[1].name };
      });
      // 干员: the 搜索 field filters the tiered list by name; the select holds the match
      await setCmd(c, 'chess', { 'console-chess-search': pick.chessName });
      assert.equal(await c.page.$eval('[data-testid="console-chess"]', (s) => s.value), pick.chessId);
      assert.ok(await c.page.$$eval('[data-testid="console-chess"] optgroup', (g) => g.length) >= 1, 'grouped by tier');
      await run(c);
      await c.page.waitForFunction((id) => { const p = globalThis.__SP__.store.get().match.private; return [...(p?.hand || []), ...(p?.temp || [])].some((x) => x?.id === id); }, { timeout: 8000 }, pick.chessId);
      // 盟约: the layers start at the own count; lower is refused inline
      await setCmd(c, 'bond');
      const bondId = await c.page.$eval('[data-testid="console-bond"]', (s) => s.value);
      const cur = await c.page.evaluate((id) => globalThis.__SP__.store.get().match.private?.bonds?.find((b) => b.bondId === id)?.layers ?? 0, bondId);
      assert.equal(await c.page.$eval('[data-testid="console-layers"]', (e) => e.value), String(cur));
      await setCmd(c, 'bond', { 'console-layers': cur + 10 });
      await run(c);
      await c.page.waitForFunction((id, n) => globalThis.__SP__.store.get().match.private?.bonds?.find((b) => b.bondId === id)?.layers === n, { timeout: 8000 }, bondId, cur + 10);
      await setCmd(c, 'bond', { 'console-layers': cur + 3 });
      assert.equal(await c.page.$eval('[data-testid="console-layers"]', (e) => e.value), String(cur + 3));
      await c.page.waitForSelector('[data-testid="console-layers-low"]', { visible: true, timeout: 3000 });
      assert.match(await c.page.$eval('[data-testid="console-layers-low"]', (e) => e.textContent), new RegExp(`不能低于当前层数 ${cur + 10}`));
      await shot(c, 'v3-solo-bond');
      // 加入敌人 ×13 with its hint
      await setCmd(c, 'bounty', { 'console-bounty-search': pick.enemyName, 'test-console-bounty-count': 13 });
      assert.equal(await c.page.$eval('[data-testid="console-bounty"]', (s) => s.value), pick.enemyKey);
      assert.match(await c.page.$eval('[data-testid="console-body"]', (e) => e.textContent), /加入你的下一场战斗；每场最多 20 个，不含领袖/);
      await run(c);
      await c.page.waitForFunction(() => (globalThis.__SP__.store.get().match.public?.testLog || []).some((e) => e.cmd === 'bounty' && e.ok && e.args?.count === 13), { timeout: 8000 });
      // 1280×720: the bounty form and the match-wide buttons fit without scrolling; the header is in view
      assert.deepEqual(await layout(c), { headInView: true, midScrolls: false }, 'the form fits the tall dock');
      await shot(c, 'v3-solo-bounty');
      const lines = await logLines(c);
      assert.ok(lines.some((l) => l.includes(`加入敌人 ${pick.enemyName} ×13`)), lines.join(' | '));
      assert.ok(lines.some((l) => l.includes(`干员 ${pick.chessName}`)), lines.join(' | '));
      assert.ok(lines.every((l) => !/funds|bounty|chess_|enemy_/.test(l)), 'no raw ids or command names');
      assert.ok((await testLog(c)).length >= 4);
      // a long log scrolls in its own box; the header and the 指令 select stay
      await setCmd(c, 'funds');
      for (let i = 0; i < 7; i++) { await setCmd(c, 'funds', { 'console-amount': 100 + i }); await run(c); await sleep(120); }
      for (let i = 0; i < 4; i++) { await setCmd(c, 'lp', { 'console-amount': 28 + i }); await run(c); await sleep(120); }
      await c.page.waitForFunction(() => (globalThis.__SP__.store.get().match.public?.testLog || []).length >= 12 && (globalThis.__SP__.store.get().match.public?.testActions | 0) >= 14, { timeout: 8000 }); // m.public keeps the newest 12
      assert.deepEqual(await layout(c), { headInView: true, midScrolls: false });
      assert.ok(await c.page.$eval('[data-testid="console-log"]', (e) => e.scrollHeight > e.clientHeight + 2), 'the log scrolls in its box');
      await shot(c, 'v3-solo-log');
      // 667×375: the phone sheet — compact, 收起 and the header in view, the log at its newest two rows until opened
      await c.page.setViewport({ width: 667, height: 375 });
      await sleep(600);
      await openPanel(c);
      await setCmd(c, 'bounty');
      const phone = await c.page.evaluate(() => {
        const r = (sel) => document.querySelector(sel)?.getBoundingClientRect();
        const tab = r('.testconsole__tab'), head = r('.testconsole__head'), log = document.querySelector('[data-testid="console-log"]');
        return { tab: tab.top >= 0 && tab.bottom <= innerHeight, head: head.top >= 0 && head.bottom <= innerHeight, logRows: Math.round(log.clientHeight / parseFloat(getComputedStyle(log).lineHeight)) };
      });
      assert.deepEqual(phone, { tab: true, head: true, logRows: 2 });
      await shot(c, 'v3-solo-667x375-bounty');
      await c.click('[data-testid="console-log-toggle"]');
      await sleep(200);
      assert.ok(await c.page.$eval('[data-testid="console-log"]', (e) => e.clientHeight > 2.5 * parseFloat(getComputedStyle(e).lineHeight)), 'opened');
      await shot(c, 'v3-solo-667x375-log');
      assert.equal(await c.page.evaluate(() => globalThis.__SP__.store.get().match.public?.test), true);
    } finally {
      await c.close();
      await srv.stop();
    }
  });
});
