// Feedback #162 (收起 / 展开 of a pending choice) and #160 (卡池剩余) in headless Chrome through the mock harness
// (public/dev/game-mock.html). Opt-in: SP_E2E=1.
//
//   SP_E2E=1 node --test test/ui/fb-peek-pool.e2e.test.js
//
// #162 at 800×360 touch (the reporter's 360×800 phone, landscape) and 1600×900: a selected 机变 card, 收起 → the screen
// is the prep screen again (top bar, bond strip, shop; no veil), the 展开 button keeps the countdown and says a card is
// still selected, nothing was sent; 展开 → the same card still selected, a second tap picks it. Both buttons have a
// 44 px touch area on the phone (the --tap-min hit area). 规程's 更换指令 hides and comes back the same way. #160: the
// shop's and the reward row's cards (盟约 and 规程 looks) carry 「余 n」 right of the price and level with it, with
// m.private poolLeft's numbers, red at 0, inside the card and clear of the tier chip, the owned-copies pips and 可晋升 —
// also with a two-digit price, a discount and 「余 24」, and in 乌萨斯齐心团 / 可露希尔 (FREE at root_cost on the card's right,
// when the local theme packs are there); the bond card's members too; 设置 off hides them all. Screenshots:
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
const PACKS = ['ac_n_iron', 'ac_s_closur'].filter((id) => existsSync(path.join(ROOT, `public/assets/local/themes/${id}/prefabs.json`)));
// a two-digit premium price, a discount and a two-digit price on the shop's operators; 24 / 10 / 0 … on every visible card
const EDGE = () => {
  const M = globalThis.__MOCK__;
  M.mutate((S) => {
    const ch = S.priv.shop.slots.filter((x) => x && x.kind === 'chess' && !x.sold);
    if (ch[0]) Object.assign(ch[0], { price: 12, basePrice: 10 });
    if (ch[1]) Object.assign(ch[1], { price: 1, basePrice: 3 });
    if (ch[2]) Object.assign(ch[2], { price: 10, basePrice: 10 });
  });
  const m = M.store.get().match;
  const pl = JSON.parse(JSON.stringify(m.private.poolLeft));
  const vals = [24, 10, 0, 17, 36, 9, 1];
  [...m.private.shop.slots, ...(m.private.shop.rewardOffer?.slots || [])].filter((x) => x && !x.sold)
    .forEach((x, i) => { (x.kind === 'item' ? pl.items : pl.chess)[x.id] = vals[i % vals.length]; });
  M.store.patch('match', { private: { ...m.private, poolLeft: pl } });
};
/** Every shop / reward card's tab against the card's other marks (a 1 px tolerance; the price's box is the tab's anchor). */
const CARD_TABS = () => {
  const priv = globalThis.__MOCK__.store.get().match.private;
  const R = (el) => el?.getBoundingClientRect() || null;
  const overlap = (a, b) => !!(a && b) && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  return [...document.querySelectorAll('.shopbar .scard:not(.scard--vacant)')].map((el) => {
    const shopIdx = el.dataset.shopSlot;
    const tag = el.querySelector('.pooltag');
    // the card's padding box: a theme's 9-slice frame (官方贴图's 盟约 card) is a border, and the 盟约 card clips its content to it
    // (client* are before the shop's scale transform, the rect after it)
    const b = R(el), sx = b.width / el.offsetWidth || 1, sy = b.height / el.offsetHeight || 1;
    const r = { left: b.left + el.clientLeft * sx, right: b.left + (el.clientLeft + el.clientWidth) * sx, top: b.top + el.clientTop * sy, bottom: b.top + (el.clientTop + el.clientHeight) * sy };
    const t = R(tag), p = R(el.querySelector('.scard__price, .scard__cost, .scard__free'));
    const name = el.querySelector('.scard__name')?.textContent.trim();
    const slot = shopIdx != null ? priv.shop.slots[Number(shopIdx)] : null;
    const want = slot ? priv.poolLeft[slot.kind === 'item' ? 'items' : 'chess'][slot.id] : undefined;
    return { name, shop: shopIdx != null, want, got: tag ? Number(tag.dataset.poolLeft) : null, empty: !!tag?.classList.contains('is-empty'),
      inside: !!t && t.left >= r.left - 1 && t.right <= r.right + 1 && t.top >= r.top - 1 && t.bottom <= r.bottom + 1,
      right: !!t && !!p && t.left >= p.right - 1, level: !!t && !!p && t.top < p.bottom && p.top < t.bottom,
      clear: ['.tier', '.scard__pips', '.scard__mergetag', '.scard__standin', '.scard__diy', '.scard__skill'].filter((sel) => overlap(t, R(el.querySelector(sel)))),
      fontPx: tag ? parseFloat(getComputedStyle(tag).fontSize) : 0 };
  });
};
const checkTabs = (cards, label) => {
  for (const c of cards) {
    if (c.shop) assert.equal(c.got, c.want ?? null, `${label} ${c.name}: the count`);
    if (c.got == null) continue;
    assert.equal(c.empty, c.got === 0, `${label} ${c.name}: red only at 0`);
    assert.ok(c.inside && c.right && c.level, `${label} ${c.name}: right of the price, level with it, on the card ${JSON.stringify(c)}`);
    assert.deepEqual(c.clear, [], `${label} ${c.name}: clear of the card's other marks`);
    assert.ok(c.fontPx >= 7.5, `${label} ${c.name}: legible (${c.fontPx}px)`);
  }
};

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
      test(`#160 ${name} ${look}: 「余 n」 right of every card's price with poolLeft's numbers; 设置 off hides them`, { timeout: 120000 }, async () => {
        const { page, problems } = await open(`${version}phase=PREP&variant=pool`, [w, h, touch]);
        await page.waitForSelector('.shopbar .pooltag');
        const cards = await page.evaluate(CARD_TABS);
        assert.ok(cards.filter((c) => c.got != null).length >= 3, JSON.stringify(cards));
        checkTabs(cards, look);
        assert.ok(cards.some((c) => c.got === 0), 'the red 0');
        await page.screenshot({ path: path.join(OUT, `fb-pool-${look}-${name}.png`) });
        // a two-digit premium price, a discount, 「余 24」 / 「余 10」
        await page.evaluate(EDGE);
        await page.waitForFunction(() => [...document.querySelectorAll('.shopbar .pooltag')].some((el) => el.dataset.poolLeft === '24'));
        await sleep(300);
        const edge = await page.evaluate(CARD_TABS);
        checkTabs(edge, `${look} edge`);
        assert.ok(edge.some((c) => c.got >= 10), 'two digits');
        await page.screenshot({ path: path.join(OUT, `fb-pool-${look}-edge-${name}.png`) });
        assert.deepEqual(problems, []);
        await page.close();
        const off = await open(`${version}phase=PREP&variant=pool`, [w, h, touch], { poolCount: false });
        await off.page.waitForSelector('.shopbar .scard[data-shop-slot]');
        assert.equal(await off.page.$('.pooltag'), null, '设置「显示卡池剩余张数」 off');
        assert.equal(await off.page.$('.scard__pricebox'), null, 'no count: the price as before');
        await off.page.close();
      });

      test(`#160 ${name} ${look}: the reward row's FREE cards carry it right of FREE`, { timeout: 120000 }, async () => {
        const { page, problems } = await open(`${version}phase=PREP&variant=pool,reward`, [w, h, touch]);
        await page.waitForSelector('.shopbar__reward .pooltag');
        const cards = await page.evaluate(CARD_TABS);
        assert.ok(cards.filter((c) => c.got != null).length >= 3, JSON.stringify(cards));
        checkTabs(cards, `${look} reward`);
        assert.deepEqual(problems, []);
        await page.close();
      });
    }

    test(`#160 ${name}: 乌萨斯齐心团 / 可露希尔 card faces (FREE at root_cost on the card's right)`, { timeout: 180000, skip: !PACKS.length && 'no local theme packs' }, async () => {
      for (const theme of PACKS) {
        for (const variant of ['pool', 'pool,reward']) {
          const { page, problems } = await open(`version=regulation&phase=PREP&variant=${variant}`, [w, h, touch], { uiTheme: theme });
          await page.waitForSelector('.shopbar .pooltag');
          await sleep(600);
          if (variant === 'pool') await page.evaluate(EDGE);
          await sleep(400);
          checkTabs(await page.evaluate(CARD_TABS), `${theme} ${variant}`);
          if (variant !== 'pool') assert.ok(await page.$('.scard__pricebox.is-edge'), `${theme}: FREE in the card's right part is right-aligned with its tab`);
          await page.screenshot({ path: path.join(OUT, `fb-pool-${theme}-${variant.replace(',', '-')}-${name}.png`) });
          assert.deepEqual(problems, []);
          await page.close();
        }
      }
    });

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
