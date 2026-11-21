// Real-server browser E2E of an old 自选候补 preset (feedback #114: four tier-5 candidates — two slots + two `diyBench_` keys,
// stored in the browser) since the 盟约 versions took 规程's twelve slots and 选择自编 (2026-11-21, tools/versions/forkDiy.mjs;
// the owner: 「都走这个，盟约也换成6-6 选2+2这样」): the 自选编队 tab shows the four in slots 1–4 (the bench keys moved,
// shared/diy.js promoteDiyBench), the server fields all four, the briefing has no 自选上场 any more, and after the strategy
// draft 确定自选编队 lists them with the first two preselected; taking those out and the other two in brings slots 3 and 4.
//
//   SP_E2E=1 node --test test/ui/diy-bench.e2e.test.js
//
// Screenshots: test/e2e/out/diy-bench-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Client, hasChrome, startRealServer, problemsOf } from '../e2e/client.mjs';

const UI_ENABLED = process.env.SP_E2E === '1' && hasChrome();
const S5 = (n) => `chess_char_5_diy${n}_a`;
const own = (charId) => ({ charId, skillIndex: 2, uniEquipId: null });
const KALTS = 'char_003_kalts', SHINING = 'char_147_shining', IFRIT = 'char_134_ifrit', MGLLAN = 'char_248_mgllan';
const PRESET = { [S5(1)]: own(KALTS), [S5(2)]: own(SHINING), diyBench_5_1: own(IFRIT), diyBench_5_2: own(MGLLAN) };

describe('an old 自选候补 preset under 选择自编 (real server, no art needed)', { skip: !UI_ENABLED && 'set SP_E2E=1 (and have Chrome)' }, () => {
  test('the four candidates are slots 1–4; no 自选上场 in the briefing; 确定自选编队 brings the chosen two', { timeout: 180000 }, async () => {
    const srv = await startRealServer();
    const P = (await import('puppeteer-core')).default;
    const c = new Client(P, srv.base, 'diy-bench', { prefix: 'diy-bench', w: 1280, h: 720, autoDiyBring: false,
      prefs: { 'loadout.view': 'list', diy: { v: 1, picks: PRESET } } });
    const fielded = () => c.page.evaluate(() => {
      const d = globalThis.__SP__.store.get().match.private?.diy || {};
      return Object.fromEntries(Object.entries(d).map(([k, p]) => [k, p.charId]));
    });
    const pressed = () => c.page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid="diy-check-card"]')]
      .map((el) => [el.dataset.slot, el.getAttribute('aria-pressed')])));
    try {
      await c.open();
      await c.enter('自选候补');
      await c.click('.lobby-screen [data-testid="loadout-open"]');
      await c.page.waitForSelector('.lo .lo-tab[data-tab="diy"]', { visible: true, timeout: 15000 });
      await c.click('.lo .lo-tab[data-tab="diy"]');
      await c.page.waitForSelector(`.diy-slot[data-slot="${S5(4)}"]`, { visible: true, timeout: 15000 });
      assert.deepEqual(await c.page.$$eval('.diy-tier[data-tier="5"] .diy-slot', (els) => els.map((e) => e.dataset.char || null)),
        [KALTS, SHINING, IFRIT, MGLLAN, null, null], 'six positions; the 候补 in slots 3 and 4');
      assert.equal(await c.page.$('.diy-slot[data-slot^="diyBench_"]'), null, 'no 候补 position');
      await c.page.waitForFunction(() => /已同步/.test(document.querySelector('[data-testid="diy-sync"]')?.textContent || ''), { timeout: 8000 });
      await c.shot('tab');
      await c.page.keyboard.press('Escape');
      await c.page.waitForFunction(() => !document.querySelector('.lo'), { timeout: 5000 });
      await c.createSolo('标准模拟');
      await c.waitFor((s) => !!s.room, 'solo room');
      if (!(await c.st()).phase) await c.roomStart({ timeout: 20000 });
      await c.waitFor((s) => s.phase === 'INFO_CHECK', 'the briefing', 30000);
      assert.deepEqual(await fielded(), { [S5(1)]: KALTS, [S5(2)]: SHINING, [S5(3)]: IFRIT, [S5(4)]: MGLLAN });
      assert.equal(await c.page.evaluate(() => globalThis.__SP__.store.get().match.private?.diyChoice ?? null), null);
      assert.equal(await c.page.$('[data-testid="diy-choice"]'), null, 'no 自选上场 strip');
      await c.shot('briefing');
      await c.settled('.brief-go'); // (a click during its entrance falls through)
      await c.click('.brief__foot .btn--primary', '准备就绪');
      await c.waitFor((s) => s.phase === 'BAND_DRAFT', 'the strategy draft', 30000);
      await c.page.evaluate(() => globalThis.__SP__.net.request('g.band', { bandId: 'band_bldsk' }));
      await c.waitFor((s) => s.phase === 'CUSTOM_CHECK', '确定自选编队', 30000);
      await c.page.waitForSelector(`[data-testid="diy-check-card"][data-slot="${S5(4)}"]`, { visible: true, timeout: 15000 });
      assert.deepEqual(await pressed(), { [S5(1)]: 'true', [S5(2)]: 'true', [S5(3)]: 'false', [S5(4)]: 'false' }, 'the first two preselected');
      await c.shot('check');
      for (const n of [1, 2, 3, 4]) await c.click(`[data-testid="diy-check-card"][data-slot="${S5(n)}"]`);
      assert.deepEqual(await pressed(), { [S5(1)]: 'false', [S5(2)]: 'false', [S5(3)]: 'true', [S5(4)]: 'true' });
      await c.click('[data-testid="diy-check-confirm"]');
      await c.page.waitForFunction(() => Array.isArray(globalThis.__SP__.store.get().match.private?.diyBring), { timeout: 10000 });
      assert.deepEqual(await c.page.evaluate(() => globalThis.__SP__.store.get().match.private.diyBring), [S5(3), S5(4)]);
      await c.waitFor((s) => s.phase === 'BATTLE_CHECK' || s.phase === 'ROUND_START' || s.phase === 'PREP', 'past 选择自编', 30000);
      await c.shot('brought');
      assert.deepEqual(c.problems.filter((p) => p.startsWith('pageerror:')), []);
    } finally {
      console.log(JSON.stringify({ problems: problemsOf([c]) }));
      await c.close();
      await srv.stop();
    }
  });
});
