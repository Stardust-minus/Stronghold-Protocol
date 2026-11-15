// Feedback #162 (收起 / 展开 of a pending choice) and #160 (卡池剩余) in headless Chrome through the mock harness
// (public/dev/game-mock.html). Opt-in: SP_E2E=1.
//
//   SP_E2E=1 node --test test/ui/fb-peek-pool.e2e.test.js
//
// #162 at 800×360 touch (the reporter's 360×800 phone, landscape) and 1600×900: a selected 机变 card, 收起 → the screen
// is the prep screen again (top bar, bond strip, shop; no veil), the 展开 button keeps the countdown and says a card is
// still selected, nothing was sent; 展开 → the same card still selected, a second tap picks it. Both buttons have a
// 44 px touch area on the phone (the --tap-min hit area). 规程's 更换指令 hides and comes back the same way. #160: the
// shop's cards (盟约 and 规程 looks) carry 「余 n」 under the price with m.private poolLeft's numbers, red at 0, inside
// the card and clear of the tier chip; the bond card's members too; 设置 off hides them all. Screenshots:
// test/e2e/out/fb-peek-*.png, fb-pool-*.png.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'test/e2e/out');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWS = [['phone', 800, 360, true], ['desk', 1600, 900, false]];

describe('#162 收起 / 展开 and #160 卡池剩余 (mock harness, headless Chrome)', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv;
  let browser;
  let base;

  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
    mkdirSync(OUT, { recursive: true });
  });

  after(async () => {
    await browser?.close();
    await srv?.close();
  });

  async function open(query, [w, h, touch], settings = {}) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: touch, hasTouch: touch });
    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    await page.evaluateOnNewDocument((s) => { localStorage.setItem('sp.pref.settings', JSON.stringify(s)); }, settings);
    await page.goto(`${base}/dev/game-mock.html?shot=1&render=fallback&${query}`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!document.querySelector('.screen:not(.gload)'), { timeout: 20000 });
    await sleep(900);
    return { page, problems };
  }
  const tap = async (page, sel, touch) => { const el = await page.waitForSelector(sel, { timeout: 8000 }); if (touch) await el.tap(); else await el.click(); await sleep(300); };
  const box = (page, sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  /** The touch area: the button, or its invisible --tap-min ::before on a touch screen (css/devices.css .tapx). */
  const hit = (page, sel) => page.$eval(sel, (el) => {
    const r = el.getBoundingClientRect(), b = getComputedStyle(el, '::before');
    const bw = b.content !== 'none' ? parseFloat(b.width) || 0 : 0, bh = b.content !== 'none' ? parseFloat(b.height) || 0 : 0;
    return { w: Math.max(r.width, bw), h: Math.max(r.height, bh), visible: [r.width, r.height] };
  });

  for (const [name, w, h, touch] of VIEWS) {
    test(`#162 ${name}: 收起 keeps the countdown and the selected card, gives back the top bar, bonds and shop; 展开 picks the same card`, { timeout: 120000 }, async () => {
      const { page, problems } = await open('phase=SP_DRAFT&variant=bounty', [w, h, touch]);
      await page.waitForSelector('.spov__grid .spcard.is-pickable', { timeout: 20000 });
      // the mock's draft is timed: give it a long clock so it does not resolve while we look
      await page.evaluate(() => { const S = globalThis.__MOCK__.S(); S.pub.deadline = Date.now() + 120000; globalThis.__MOCK__.pushPublic(); });
      const collapse = await hit(page, '[data-testid="sp-collapse"]');
      if (touch) assert.ok(collapse.w >= 44 && collapse.h >= 44, `收起 is a touch target (${JSON.stringify(collapse)})`);
      const idx = await page.$eval('.spov__grid .spcard.is-pickable', (el) => Number(el.dataset.cardIdx));
      await tap(page, `.spov__grid .spcard[data-card-idx="${idx}"]`, touch);
      assert.ok(await page.$(`.spcard.is-armed[data-card-idx="${idx}"]`), 'first tap selects');
      await tap(page, '[data-testid="sp-collapse"]', touch);
      await page.waitForFunction(() => !document.querySelector('.spov'));
      const state = await page.evaluate(() => {
        const gm = document.querySelector('.gm');
        const vis = (sel) => { const el = document.querySelector(sel); if (!el) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0; };
        return { cls: gm.className, top: vis('.gtop'), bonds: vis('.gm__bonds'), shop: vis('.shopbar'), pill: vis('[data-testid="sp-expand"]'),
          clock: !!document.querySelector('[data-testid="sp-expand"] .countdown'), kept: !!document.querySelector('[data-testid="sp-armed-kept"]'),
          picks: { ...globalThis.__MOCK__.S().pub.sp.picks } };
      });
      assert.doesNotMatch(state.cls, /\bhas-sp\b|\bhas-spdraft\b/, 'the veil classes are off while hidden');
      assert.match(state.cls, /\bis-peek\b/);
      assert.ok(state.top && state.bonds && state.shop, `the prep screen is back: ${JSON.stringify(state)}`);
      assert.ok(state.pill && state.clock && state.kept, 'the 展开 button: countdown and the kept selection');
      assert.equal(state.picks.p1, undefined, 'nothing was sent by hiding');
      const pill = await box(page, '[data-testid="sp-expand"]');
      const pillHit = await hit(page, '[data-testid="sp-expand"]');
      if (touch) assert.ok(pillHit.w >= 44 && pillHit.h >= 44, `展开 is a touch target (${JSON.stringify(pillHit)})`);
      assert.ok(pill.x + pill.w <= w && pill.y >= 0 && pill.y + pill.h <= h, 'inside the screen');
      await page.screenshot({ path: path.join(OUT, `fb-peek-collapsed-${name}.png`) });
      await tap(page, '[data-testid="sp-expand"]', touch);
      await page.waitForSelector('.spov__grid .spcard');
      assert.ok(await page.$(`.spcard.is-armed[data-card-idx="${idx}"]`), 'the same card is still selected');
      await tap(page, `.spov__grid .spcard[data-card-idx="${idx}"]`, touch);
      await page.waitForFunction((i) => globalThis.__MOCK__.S().pub.sp.picks?.p1 === i, { timeout: 5000, polling: 100 }, idx);
      assert.deepEqual(problems, []);
      await page.close();
    });

    test(`#162 ${name}: 规程 更换指令 hides to look at the board and comes back`, { timeout: 120000 }, async () => {
      const { page, problems } = await open('version=regulation&phase=PREP', [w, h, touch]);
      await page.evaluate(() => globalThis.__MOCK__.mutate((S) => {
        S.priv.commandDraft = { id: 'command.9001', choiceId: 'skill_change_1', cards: [
          { effectId: 'aceffect_band_101', cost: 0, desc: '【意志鼓舞】', descRaw: '【意志鼓舞】\n拖拽使用：选择一名我方干员' },
          { effectId: 'aceffect_band_73', cost: 0, desc: '【内部货源】', descRaw: '【内部货源】\n点击使用：下一件购买的装备价格-1' },
        ] };
      }));
      await page.waitForSelector('[data-testid="command-collapse"]');
      await tap(page, '[data-testid="command-collapse"]', touch);
      await page.waitForFunction(() => !document.querySelector('.command-draft'));
      assert.ok(await page.$('[data-testid="command-expand"] .countdown'), 'the prep clock in the 展开 button');
      assert.match(await page.$eval('.gm', (el) => el.className), /\bis-peek\b/);
      await page.screenshot({ path: path.join(OUT, `fb-peek-command-${name}.png`) });
      await tap(page, '[data-testid="command-expand"]', touch);
      await page.waitForSelector('.command-draft');
      assert.deepEqual(problems, []);
      await page.close();
    });

    for (const version of ['', 'version=regulation&']) {
      const look = version ? 'reg' : 'cov';
      test(`#160 ${name} ${look}: 「余 n」 under every card's price with poolLeft's numbers; 设置 off hides them`, { timeout: 120000 }, async () => {
        const { page, problems } = await open(`${version}phase=PREP&variant=pool`, [w, h, touch]);
        await page.waitForSelector('.shopbar .pooltag');
        const cards = await page.evaluate(() => {
          const priv = globalThis.__MOCK__.S().priv;
          return [...document.querySelectorAll('.shopbar .scard[data-shop-slot]')].map((el) => {
            const slot = priv.shop.slots[Number(el.dataset.shopSlot)];
            const tag = el.querySelector('.pooltag');
            const want = priv.poolLeft[slot.kind === 'item' ? 'items' : 'chess'][slot.id];
            const r = el.getBoundingClientRect(), t = tag?.getBoundingClientRect(), tier = el.querySelector('.tier')?.getBoundingClientRect();
            const overlap = (a, b) => !!(a && b) && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
            return { id: slot.id, want, got: tag ? Number(tag.dataset.poolLeft) : null, empty: !!tag?.classList.contains('is-empty'),
              inside: !!t && t.left >= r.left - 1 && t.right <= r.right + 1 && t.top >= r.top - 1 && t.bottom <= r.bottom + 1,
              clearTier: !overlap(t, tier), fontPx: tag ? parseFloat(getComputedStyle(tag).fontSize) : 0 };
          });
        });
        assert.ok(cards.length >= 3, JSON.stringify(cards));
        for (const c of cards) {
          assert.equal(c.got, c.want ?? null, `${c.id}: the count`);
          if (c.got == null) continue;
          assert.equal(c.empty, c.got === 0, `${c.id}: red only at 0`);
          assert.ok(c.inside && c.clearTier, `${c.id}: on the card, clear of the tier chip ${JSON.stringify(c)}`);
          assert.ok(c.fontPx >= 9, `${c.id}: legible (${c.fontPx}px)`);
        }
        assert.ok(cards.some((c) => c.got === 0), 'the red 0');
        await page.screenshot({ path: path.join(OUT, `fb-pool-${look}-${name}.png`) });
        assert.deepEqual(problems, []);
        await page.close();
        const off = await open(`${version}phase=PREP&variant=pool`, [w, h, touch], { poolCount: false });
        await off.page.waitForSelector('.shopbar .scard[data-shop-slot]');
        assert.equal(await off.page.$('.pooltag'), null, '设置「显示卡池剩余张数」 off');
        await off.page.close();
      });
    }

    test(`#160 ${name}: the bond card's members carry their counts`, { timeout: 120000 }, async () => {
      const { page, problems } = await open('phase=PREP&variant=pool,bond', [w, h, touch]);
      await page.waitForSelector('.bpop .bpop__member');
      const n = await page.$$eval('.bpop .bpop__member .pooltag--member', (els) => els.length);
      assert.ok(n > 0, 'members with a count');
      await page.screenshot({ path: path.join(OUT, `fb-pool-bond-${name}.png`) });
      assert.deepEqual(problems, []);
      await page.close();
    });
  }
});
