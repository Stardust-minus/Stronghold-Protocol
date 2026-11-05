// Real server and normal UI operations only: create/join, ready, skip and confirm.
// No mocked draft, injected game state, direct network requests or fixed seed.
// SP_E2E=1 node --test test/ui/band-draft-skip.e2e.test.js
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settled } from '../e2e/client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'test/e2e/out/band-draft-skip');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
// 跳过选择 / 无法跳过 sits in the step header's turn line (PR #643), only while it is the player's turn: no button = no skip
const SKIP = '.dturn .draft-skip';

describe('strategy skip eligibility (real server, normal browser operations)', {
  skip: !ENABLED && 'set SP_E2E=1 and have Chrome to run',
}, () => {
  let srv;
  let browser;
  let base;
  const observations = [];

  before(async () => {
    mkdirSync(OUT, { recursive: true });
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
      args: ['--no-sandbox', '--no-first-run', '--mute-audio', '--disable-background-timer-throttling'] });
  });
  after(async () => {
    try {
      writeFileSync(path.join(OUT, 'observations.json'), JSON.stringify(observations, null, 2));
    } finally {
      const proc = browser?.process();
      try { await browser?.close(); } finally {
        for (const stream of [proc?.stdout, proc?.stderr]) stream?.destroy();
        await srv?.close();
      }
    }
  });

  async function state(page) {
    return page.evaluate(() => {
      const s = globalThis.__SP__.store.get();
      return { me: s.me.playerId, code: s.room?.code, phase: s.match.public?.phase,
        draft: s.match.public?.draft, bandId: s.match.private?.bandId };
    });
  }
  async function click(page, selector, text = '') {
    await page.waitForFunction((sel, txt) => [...document.querySelectorAll(sel)]
      .some((el) => !el.disabled && el.textContent.includes(txt)), { timeout: 10000 }, selector, text);
    const buttons = await page.$$(selector);
    for (const button of buttons) {
      const match = await button.evaluate((el, txt) => !el.disabled && el.textContent.includes(txt), text);
      if (match) { await button.click(); return; }
    }
    assert.fail(`no enabled ${selector} ${text}`);
  }
  async function player(name, suffix = '') {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    const errors = [];
    const frames = [];
    page.on('pageerror', (e) => errors.push(e.stack || e.message));
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    // Observe only: retain skip requests and replies, never handshake tokens or session data.
    cdp.on('Network.webSocketFrameSent', ({ response }) => {
      try { const m = JSON.parse(response.payloadData); if (m.t === 'g.bandSkip') frames.push({ direction: 'sent', message: m }); } catch { /* non-JSON */ }
    });
    cdp.on('Network.webSocketFrameReceived', ({ response }) => {
      try { const m = JSON.parse(response.payloadData); if (m.t === 'error') frames.push({ direction: 'received', message: m }); } catch { /* non-JSON */ }
    });
    // no title screen (2026-10-15): boot connects with the remembered callsign
    await page.evaluateOnNewDocument((n) => { try { localStorage.setItem('sp.name', n); } catch { /* none */ } }, name);
    await page.goto(base + '/' + suffix, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__SP__?.store.get().connection.status === 'online');
    return { context, page, errors, frames };
  }
  async function draft(humans, mode = 'coop') {
    const clients = [await player('轮选测试1')];
    const host = clients[0].page;
    // the lobby's 公告板 opens by itself on a fresh browser and covers the hub
    if (await host.waitForSelector('.announcement-board', { visible: true, timeout: 2500 }).catch(() => null)) await click(host, '.announcement-board .modal__actions button');
    await click(host, '.hub-entry', mode === 'solo' ? '独立模拟' : '同盟模拟');
    // 独立模拟 → 选择模拟协议 → 开始独立模拟; 创建同盟 creates the co-op room at once
    await click(host, ...(mode === 'solo' ? ['.proto-start', '开始模拟'] : ['[data-testid="alliance-create"]']));
    await host.waitForFunction(() => !!globalThis.__SP__.store.get().room?.code);
    const code = (await state(host)).code;
    for (let i = 1; i < humans; i++) {
      const c = await player(`轮选测试${i + 1}`, `?room=${code}`);
      clients.push(c);
      await c.page.waitForFunction((code) => globalThis.__SP__.store.get().room?.code === code, {}, code);
      await click(c.page, '.rs-go', '准备就绪');
    }
    if ((await state(host)).phase !== 'INFO_CHECK') await click(host, '.rs-go', '开始模拟');
    for (const c of clients) {
      await c.page.waitForSelector('.brief__foot .btn--primary');
      await settled(c.page, '.brief-go'); // (a click during its entrance falls through)
      await click(c.page, '.brief__foot .btn--primary', '准备就绪');
    }
    await host.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'BAND_DRAFT');
    return clients;
  }
  async function confirm(c) {
    await click(c.page, '.dband:not(.is-taken)');
    await click(c.page, '.draft-detail__btns .btn--primary', '确认选择');
    await c.page.waitForFunction(() => !!globalThis.__SP__.store.get().match.private?.bandId);
  }
  async function close(clients) {
    const runtimeErrors = clients.flatMap((c) => c.errors);
    try { assert.deepEqual(runtimeErrors, [], 'no page errors during normal operations'); } finally {
      for (const c of clients) await c.context.close();
      observations.push({ name: 'browser-cleanup', runtimeErrors,
        errorsAfterClose: clients.flatMap((c) => c.errors) });
    }
  }

  // several humans draft freely since 2026-11-05 (server/match/match/phases.js freeDraft; test/ui/band-draft-free.e2e.test.js):
  // nobody has a turn to pass — the skip stays with a single human's untimed draft and a checkpoint from before the update
  // (test/ui/bandDraft.test.js covers its rules on the server)
  async function lockIn(c) {
    await click(c.page, '.dband:not(.is-taken)');
    await click(c.page, '[data-testid="draft-hold"]', '选择');
    await click(c.page, '[data-testid="draft-lock"]', '锁定选择');
    await c.page.waitForFunction(() => !!globalThis.__SP__.store.get().match.private?.bandId);
  }
  for (const humans of [2, 3]) test(`${humans} humans: the free draft has no skip button for anybody`, { timeout: 120000 }, async () => {
    const clients = await draft(humans);
    try {
      for (const [i, c] of clients.entries()) {
        await c.page.waitForSelector('.screen.draft .stephead');
        const s = await state(c.page);
        assert.equal(s.draft.free, true, 'two or more humans: the free draft');
        assert.equal(s.draft.turn, null);
        assert.equal(await c.page.$('[data-testid="draft-skip"]'), null, 'no skip button');
        const file = `${humans}p-free-${i + 1}.png`;
        await c.page.screenshot({ path: path.join(OUT, file), fullPage: true });
        observations.push({ name: `${humans}p-free-${i + 1}`, ...s, file });
      }
      for (const c of clients) await lockIn(c);
      await clients[0].page.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase !== 'BAND_DRAFT');
    } finally { await close(clients); }
  });

  test('solo draft has no skip button', { timeout: 60000 }, async () => {
    const clients = await draft(1, 'solo');
    try {
      assert.equal(await clients[0].page.$(SKIP), null);
      await confirm(clients[0]);
    } finally { await close(clients); }
  });
});
