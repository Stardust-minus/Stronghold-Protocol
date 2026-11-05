// The free strategy draft in real browsers (the owner, 2026-11-05; server/match/match/phases.js freeDraft,
// public/js/screens/bandDraft.js): three doctors on a real server, normal UI operations only — 选择 holds a strategy, a
// teammate sees it greyed (已被选择) and cannot take it, 改选此策略 moves the hold (the old one is free again), 取消选择 drops
// it, 锁定选择 (the header's button) makes it final; one countdown in the step header; every doctor locked ends the step
// before the countdown. Screenshots in test/e2e/out/band-draft-free.
// SP_E2E=1 CHROME_PATH=… node --test test/ui/band-draft-free.e2e.test.js
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settled } from '../e2e/client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'test/e2e/out/band-draft-free');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);

describe('the free strategy draft (real server, normal browser operations)', { skip: !ENABLED && 'set SP_E2E=1 and have Chrome to run' }, () => {
  let srv, browser, base;
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
    const proc = browser?.process();
    try { await browser?.close(); } finally {
      for (const stream of [proc?.stdout, proc?.stderr]) stream?.destroy();
      await srv?.close();
    }
  });

  const store = (page, fn, arg) => page.evaluate(fn, arg);
  const draftOf = (page) => store(page, () => {
    const s = globalThis.__SP__.store.get();
    return { me: s.me.playerId, phase: s.match.public?.phase, draft: s.match.public?.draft, deadline: s.match.public?.deadline, now: Date.now() };
  });
  async function click(page, selector, text = '') {
    await page.waitForFunction((sel, txt) => [...document.querySelectorAll(sel)].some((el) => !el.disabled && el.textContent.includes(txt)), { timeout: 10000 }, selector, text);
    for (const el of await page.$$(selector)) {
      if (await el.evaluate((e, txt) => !e.disabled && e.textContent.includes(txt), text)) { await el.click(); return; }
    }
    assert.fail(`no enabled ${selector} ${text}`);
  }
  async function player(name, suffix = '') {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.stack || e.message));
    await page.evaluateOnNewDocument((n) => { try { localStorage.setItem('sp.name', n); } catch { /* none */ } }, name);
    await page.goto(base + '/' + suffix, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__SP__?.store.get().connection.status === 'online');
    return { context, page, errors, name };
  }
  async function toDraft(n) {
    const clients = [await player('自由选择1')];
    const host = clients[0].page;
    if (await host.waitForSelector('.announcement-board', { visible: true, timeout: 2500 }).catch(() => null)) await click(host, '.announcement-board .modal__actions button');
    await click(host, '.hub-entry', '同盟模拟');
    await click(host, '[data-testid="alliance-create"]');
    await host.waitForFunction(() => !!globalThis.__SP__.store.get().room?.code);
    const code = await store(host, () => globalThis.__SP__.store.get().room.code);
    for (let i = 1; i < n; i++) {
      const c = await player(`自由选择${i + 1}`, `?room=${code}`);
      clients.push(c);
      await c.page.waitForFunction((code) => globalThis.__SP__.store.get().room?.code === code, {}, code);
      await click(c.page, '.rs-go', '准备就绪');
    }
    if ((await draftOf(host)).phase !== 'INFO_CHECK') await click(host, '.rs-go', '开始模拟');
    for (const c of clients) {
      await c.page.waitForSelector('.brief__foot .btn--primary');
      await settled(c.page, '.brief-go');
      await click(c.page, '.brief__foot .btn--primary', '准备就绪');
    }
    for (const c of clients) await c.page.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'BAND_DRAFT');
    return clients;
  }
  /** a screenshot once the 请选择策略 band (ui/turnBanner.js, at the draft's start) has swept by and the screen has settled */
  const shot = async (c, name) => {
    await c.page.waitForFunction(() => !document.querySelector('[data-testid="turn-banner"]'), { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 450));
    await c.page.screenshot({ path: path.join(OUT, `${name}.png`) });
  };
  const tile = (id) => `.dband[data-band="${id}"]`;
  /** open a strategy's detail pane and press its main button (选择 / 改选此策略) */
  async function holdBand(c, id, label) {
    await c.page.click(tile(id));
    await c.page.waitForSelector('[data-testid="draft-hold"]');
    await click(c.page, '[data-testid="draft-hold"]', label);
    await c.page.waitForFunction((id) => { const s = globalThis.__SP__.store.get(); return s.match.public?.draft?.holds?.[s.me.playerId] === id; }, {}, id);
  }

  test('hold, a teammate sees it taken, switch, cancel, lock; one countdown; everybody locked ends it early', { timeout: 180000 }, async () => {
    const clients = await toDraft(3);
    const [a, b, c] = clients;
    try {
      const d0 = await draftOf(a.page);
      assert.equal(d0.draft.free, true, 'two or more humans: the free draft');
      assert.equal(d0.draft.turn, null);
      assert.ok(d0.deadline - d0.now > 40_000 && d0.deadline - d0.now <= 50_500, `one 50 s countdown (${d0.deadline - d0.now} ms)`);
      for (const x of clients) assert.equal(await x.page.$('[data-testid="draft-skip"]'), null, 'no skip');
      // A holds 阿米娅
      await holdBand(a, 'band_amiya', '选择');
      await a.page.waitForSelector('[data-testid="draft-cancel"]');
      await a.page.waitForSelector('[data-testid="draft-head-held"] [data-testid="draft-lock-head"]');
      await shot(a, 'a-1-my-hold');
      // B sees it taken (A's avatar on it) and cannot hold it
      await b.page.waitForFunction((sel) => document.querySelector(sel)?.classList.contains('is-taken'), {}, tile('band_amiya'));
      await b.page.waitForSelector('[data-testid="draft-held"]'); // A's row: the held strategy, 未锁定
      await b.page.click(tile('band_amiya'));
      await b.page.waitForSelector('[data-testid="draft-hold"]');
      assert.equal(await b.page.$eval('[data-testid="draft-hold"]', (el) => el.disabled), true, '队友已选: 已被选择');
      assert.match(await b.page.$eval('.draft-detail__status--taken', (el) => el.textContent), /队友已选/);
      await shot(b, 'b-1-teammate-hold-greyed');
      // A switches to 歌利亚: 阿米娅 is free again for B at once
      await holdBand(a, 'band_sarkazb', '改选此策略');
      await b.page.waitForFunction((sel) => !document.querySelector(sel)?.classList.contains('is-taken'), {}, tile('band_amiya'));
      await holdBand(b, 'band_amiya', '选择');
      // A cancels, then holds 华法琳 and locks it from the header
      await click(a.page, '[data-testid="draft-cancel"]', '取消选择');
      await a.page.waitForFunction(() => { const s = globalThis.__SP__.store.get(); return !s.match.public?.draft?.holds?.[s.me.playerId]; });
      await holdBand(a, 'band_bldsk', '选择');
      await click(a.page, '[data-testid="draft-lock-head"]', '锁定选择');
      await a.page.waitForFunction(() => { const s = globalThis.__SP__.store.get(); return s.match.public?.draft?.picks?.[s.me.playerId] === 'band_bldsk'; });
      await a.page.waitForSelector('.draft-done');
      await shot(a, 'a-2-locked');
      await b.page.waitForFunction(() => document.querySelectorAll('.dorder.is-done').length === 1);
      await shot(b, 'b-2-holding-teammate-locked');
      // C sees both: A locked (✓), B holding (未锁定); the header counts the step down
      await c.page.waitForSelector('[data-testid="draft-held"]');
      assert.match(await c.page.$eval('.stephead', (el) => el.textContent), /\d/);
      await shot(c, 'c-1-countdown-hold-and-lock');
      // B locks in the detail pane, C holds and locks: the step ends before the countdown
      await click(b.page, '[data-testid="draft-lock"]', '锁定选择');
      await holdBand(c, 'band_lisa', '选择');
      await click(c.page, '[data-testid="draft-lock-head"]', '锁定选择');
      await a.page.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase !== 'BAND_DRAFT', { timeout: 15000 });
      assert.ok(Date.now() < d0.deadline, 'ended before the countdown');
      const bands = await Promise.all(clients.map((x) => store(x.page, () => globalThis.__SP__.store.get().match.private?.bandId)));
      assert.deepEqual(bands, ['band_bldsk', 'band_amiya', 'band_lisa']);
      assert.deepEqual(clients.flatMap((x) => x.errors), [], 'no page errors');
    } finally {
      for (const x of clients) await x.context.close();
    }
  });
});
