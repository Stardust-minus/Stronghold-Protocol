// Real-server browser E2E of 自选候补 (feedback #114; the owner's decision of 2026-11-02: four equal candidates, any two
// play): a 自选 preset with four tier-5 operators (stored in the browser, synced by room.diy; the tab draws four equal
// cards) reaches a solo match; the briefing shows 自选上场 with the four (the default two marked 上场); taking one out
// and tapping another sends g.diyChoose, the server fields it (m.private.diy) and the section shows it; after 准备就绪 the
// strategy draft keeps it and the choice is gone.
//
//   SP_E2E=1 node --test test/ui/diy-bench.e2e.test.js
//
// Screenshots: test/e2e/out/diy-bench-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Client, hasChrome, startRealServer, problemsOf } from '../e2e/client.mjs';

const UI_ENABLED = process.env.SP_E2E === '1' && hasChrome();
const T5A = 'chess_char_5_diy1_a', T5B = 'chess_char_5_diy2_a';
const own = (charId) => ({ charId, skillIndex: 2, uniEquipId: null });
const KALTS = 'char_003_kalts', SHINING = 'char_147_shining', IFRIT = 'char_134_ifrit', MGLLAN = 'char_248_mgllan';
const PRESET = { [T5A]: own(KALTS), [T5B]: own(SHINING), diyBench_5_1: own(IFRIT), diyBench_5_2: own(MGLLAN) };

describe('自选候补: choose in the briefing (real server, no art needed)', { skip: !UI_ENABLED && 'set SP_E2E=1 (and have Chrome)' }, () => {
  test('the briefing lists the preset\'s four tier-5 candidates; two taps field a 候补; the draft keeps it', { timeout: 120000 }, async () => {
    const srv = await startRealServer();
    const P = (await import('puppeteer-core')).default;
    const c = new Client(P, srv.base, 'diy-bench', { prefix: 'diy-bench', w: 1280, h: 720, prefs: { 'loadout.view': 'list', diy: { v: 1, picks: PRESET } } });
    const sel = '[data-testid="diy-choice"]';
    const pressed = () => c.page.evaluate((s) => Object.fromEntries([...document.querySelectorAll(`${s} .diychoice__c`)].map((el) => [el.dataset.char, el.getAttribute('aria-pressed')])), sel);
    const fielded = () => c.page.evaluate(() => {
      const d = globalThis.__SP__.store.get().match.private?.diy || {};
      return Object.fromEntries(Object.entries(d).map(([k, p]) => [k, p.charId]));
    });
    try {
      await c.open();
      await c.enter('自选候补');
      // the 自选编队 tab draws four equal cards per tier; the preset reaches the server (room.diy keeps positions 3–4)
      await c.click('.lobby-screen [data-testid="loadout-open"]');
      await c.page.waitForSelector('.lo .lo-tab[data-tab="diy"]', { visible: true, timeout: 15000 });
      await c.click('.lo .lo-tab[data-tab="diy"]');
      await c.page.waitForSelector('.diy-slot[data-slot="diyBench_5_2"]', { visible: true, timeout: 15000 });
      assert.equal(await c.page.$eval('.diy-slot[data-slot="diyBench_5_2"]', (e) => e.dataset.char), MGLLAN);
      assert.deepEqual(await c.page.$$eval('.diy-tier[data-tier="5"] .diy-slot', (els) => els.map((e) => e.dataset.char || null)), [KALTS, SHINING, IFRIT, MGLLAN]);
      assert.equal(await c.page.$('.diy-ban'), null, 'outside a match the bans are not known');
      await c.page.waitForFunction(() => /已同步/.test(document.querySelector('[data-testid="diy-sync"]')?.textContent || ''), { timeout: 8000 });
      await c.page.$eval('.diy-tier[data-tier="5"]', (e) => e.scrollIntoView({ block: 'center' }));
      await c.shot('tab');
      await c.page.keyboard.press('Escape');
      await c.page.waitForFunction(() => !document.querySelector('.lo'), { timeout: 5000 });
      await c.createSolo('标准模拟');
      await c.waitFor((s) => !!s.room, 'solo room');
      if (!(await c.st()).phase) await c.roomStart({ timeout: 20000 });
      await c.waitFor((s) => s.phase === 'INFO_CHECK', 'the briefing', 30000);
      const seen = await c.page.evaluate(() => {
        const p = globalThis.__SP__.store.get().match.private;
        return { keys: Object.keys(p || {}).filter((k) => k.startsWith('diy')), diy: p?.diy, choice: p?.diyChoice ?? null };
      });
      console.log(JSON.stringify({ briefing: seen }));
      await c.page.waitForSelector(sel, { visible: true, timeout: 30000 });
      await c.page.$eval(sel, (e) => e.scrollIntoView({ block: 'center' }));
      assert.deepEqual(await pressed(), { [KALTS]: 'true', [SHINING]: 'true', [IFRIT]: 'false', [MGLLAN]: 'false' });
      assert.deepEqual(await fielded(), { [T5A]: KALTS, [T5B]: SHINING });
      await c.shot('briefing');
      // 闪灵 out (a draft of one: nothing sent yet), 麦哲伦 in (complete: g.diyChoose)
      await c.click(`${sel} .diychoice__c[data-char="${SHINING}"]`);
      await c.page.waitForFunction((s) => /再选 1 名后生效/.test(document.querySelector(s)?.textContent || ''), { timeout: 4000 }, sel);
      assert.deepEqual(await fielded(), { [T5A]: KALTS, [T5B]: SHINING }, 'an unfinished draft changes nothing');
      await c.shot('draft');
      await c.click(`${sel} .diychoice__c[data-char="${MGLLAN}"]`);
      await c.page.waitForFunction((slot, id) => globalThis.__SP__.store.get().match.private?.diy?.[slot]?.charId === id, { timeout: 8000 }, T5B, MGLLAN);
      assert.deepEqual(await pressed(), { [KALTS]: 'true', [SHINING]: 'false', [IFRIT]: 'false', [MGLLAN]: 'true' });
      assert.ok(!/未选择：默认上场/.test(await c.page.$eval(sel, (e) => e.textContent)), 'the tier now reads as chosen');
      await c.shot('chosen');
      await c.settled('.brief-go'); // (a click during its entrance falls through)
      await c.click('.brief__foot .btn--primary', '准备就绪');
      await c.waitFor((s) => s.phase === 'BAND_DRAFT', 'the strategy draft', 30000);
      assert.deepEqual(await fielded(), { [T5A]: KALTS, [T5B]: MGLLAN });
      assert.equal(await c.page.evaluate(() => globalThis.__SP__.store.get().match.private?.diyChoice ?? null), null);
      await c.shot('draft-phase');
      assert.deepEqual(c.problems.filter((p) => p.startsWith('pageerror:')), []);
    } finally {
      console.log(JSON.stringify({ problems: problemsOf([c]) }));
      await c.close();
      await srv.stop();
    }
  });
});
