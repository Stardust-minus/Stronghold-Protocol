// Real-server browser E2E of the 预选盟约 rework (the owner's requests of 2026-11-05; ui/bondPlan.js, screens/bandDraft.js,
// ui/teamPanel.js, ui/shopBar.js, main.js m.notice bondPlan): two players in a 险境 同盟 room (the drawn set D: 3 core + 4
// add-on bonds). In the strategy draft the strategies whose home bond is in D read 本局禁用; A opens 预选盟约, the core
// bonds of D read 盟约禁用 there, A picks a main bond and two secondary ones (可多选 · 2/4) and confirms; B sees A's tags
// on A's order row. In round 1's prep A changes its plan from its own team-panel row to bonds of its shop's cards — B gets
// the toast 「A 更改了预选盟约：…」 — then B plans a bond of A's cards: A's shop lights its own plan's cards and shows B's
// avatar, and A gets B's toast. No console error. Screenshots: test/e2e/out/plan-*.png (PLAN_SHOTS=<dir> copies them).
//
//   SP_E2E=1 CHROME_PATH=… node --test test/ui/bond-plan.e2e.test.js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Client, OUT, ROOT, sleep, hasChrome, startRealServer, problemsOf } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome() && existsSync(path.join(ROOT, 'public/assets'));
const A = '凯尔希', B = '阿米娅';

/** The page's data lookups (public/js/data.js), for the test's choices only. */
const lookup = (c, kind, ids) => c.page.evaluate(async (kind, ids) => {
  const { data } = await import('/js/data.js');
  return ids.map((id) => { const r = data.lookup(kind, id); return r ? { id, name: r.name, bonds: r.bonds || null, isCore: r.isCore ?? null, bondIds: r.bondIds || null } : { id }; });
}, kind, ids);
const pubOf = (c) => c.page.evaluate(() => globalThis.__SP__.store.get().match.public);
const planOf = (c, name) => c.page.evaluate((name) => {
  const p = globalThis.__SP__.store.get().match.public?.players?.find((x) => x.name === name);
  return p ? { main: p.bondPlan, sub: p.bondPlanSub || [] } : null;
}, name);

describe('预选盟约: 本局禁用 marks, 主 + 副 multi-select, the in-match change, its notice and the shop', { skip: !ENABLED && 'needs SP_E2E=1, Chrome and public/assets' }, () => {
  test('draft marks and picker, in-match change from the team panel, notices both ways, shop highlight with a teammate avatar', { timeout: 8 * 60 * 1000 }, async () => {
    const srv = await startRealServer({ fast: { timerScale: 1, combatSpeed: 8 } });
    const P = (await import('puppeteer-core')).default;
    const a = new Client(P, srv.base, 'a', { prefix: 'plan-a', w: 1600, h: 900 });
    const b = new Client(P, srv.base, 'b', { prefix: 'plan-b', w: 1600, h: 900 });
    const all = [a, b];
    const req = (c, type, body) => c.page.evaluate(async (type, body) => (await import('/js/net.js')).net.request(type, body), type, body);
    const toastSeen = (c, text) => c.page.waitForFunction((text) => [...document.querySelectorAll('.toast')].some((x) => x.textContent.includes(text)), { timeout: 10000 }, text);
    try {
      await a.open();
      await a.enter(A);
      const room = await a.createCoop('险境');
      await b.open();
      await b.enter(B);
      await req(b, 'room.join', { code: room.code });
      for (const c of all) await c.page.waitForFunction(() => document.querySelectorAll('.rseat').length >= 2, { timeout: 20000 });
      await req(b, 'room.ready', { ready: true });
      await a.roomStart({ timeout: 20000 });
      for (const c of all) await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 40000);
      for (const c of all) {
        await c.page.waitForFunction(() => {
          const btn = [...document.querySelectorAll('.brief__foot .btn--primary')].find((x) => x.textContent.includes('准备就绪'));
          const r = btn?.getBoundingClientRect();
          return !!r && btn.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
        }, { timeout: 20000 });
        await c.click('.brief__foot .btn--primary', '准备就绪');
      }
      for (const c of all) await c.waitFor((s) => s.phase === 'BAND_DRAFT', 'the strategy draft', 40000);
      for (const c of all) await c.page.waitForFunction(() => !document.querySelector('[data-testid="turn-banner"]'), { timeout: 15000 });
      await sleep(600);

      // the strategies built around a bond of D read 「X盟约禁用」 — exactly those (bands.json bondIds ∩ D)
      const pub = await pubOf(a);
      const drawn = new Set(pub.drawnDisabledBonds);
      assert.equal(pub.difficulty, 'NORMAL');
      const tiles = await a.page.$$eval('.dband', (els) => els.map((e) => ({ id: e.dataset.band, off: e.classList.contains('is-off') })));
      const bands = await lookup(a, 'bands', tiles.map((x) => x.id));
      const want = bands.filter((x) => (x.bondIds || []).some((id) => drawn.has(id))).map((x) => x.id).sort();
      assert.ok(want.length > 0, 'a 险境 match draws three core bonds: some strategy is built around one');
      assert.deepEqual(tiles.filter((x) => x.off).map((x) => x.id).sort(), want);
      await a.shot('1-draft-d-strategies');

      // the picker: D's core bonds read 盟约禁用; a main bond and two secondary ones
      await a.click('[data-testid="bond-plan-open"]');
      await a.page.waitForSelector('.bplan-dlg', { visible: true, timeout: 10000 });
      await sleep(400);
      const cores = await a.page.$$eval('[data-testid="bond-plan-main"] .bplan-card', (els) => els.map((e) => ({ id: e.dataset.bond, off: e.classList.contains('is-off') })));
      assert.equal(cores.length, 8);
      assert.deepEqual(cores.filter((x) => x.off).map((x) => x.id).sort(), cores.map((x) => x.id).filter((id) => drawn.has(id)).sort());
      const subCards = await a.page.$$eval('[data-testid="bond-plan-sub"] .bplan-card', (els) => els.map((e) => ({ id: e.dataset.bond, off: e.classList.contains('is-off') })));
      assert.equal(subCards.length, 22);
      const main0 = cores.find((x) => !x.off).id;
      const sub0 = [subCards.find((x) => x.off && !cores.some((c) => c.id === x.id)).id, subCards.find((x) => !x.off && !cores.some((c) => c.id === x.id)).id];
      await a.click(`[data-testid="bond-plan-main"] .bplan-card[data-bond="${main0}"]`);
      for (const id of sub0) await a.click(`[data-testid="bond-plan-sub"] .bplan-card[data-bond="${id}"]`);
      await a.page.waitForFunction(() => [...document.querySelectorAll('.bplan-sec__h small')].some((x) => x.textContent.includes('2/4')), { timeout: 5000 });
      await a.shot('2-picker-marks-multi');
      const fit = await a.page.$eval('.bplan-dlg .modal__body', (el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
      assert.ok(fit.scroll <= fit.client + 1, `the picker fits 1600×900 without scrolling (${JSON.stringify(fit)})`);
      await a.click('[data-testid="bond-plan-ok"]');
      await a.page.waitForSelector('.bplan-dlg', { hidden: true, timeout: 10000 });
      assert.deepEqual(await planOf(b, A), { main: main0, sub: sub0 });
      // B: A's order row carries the main bond (name) and the two secondary glyphs
      await b.page.waitForFunction(() => document.querySelectorAll('.dorder__plan .bglyph').length >= 3, { timeout: 10000 });
      await sleep(300);
      await b.shot('3-draft-row-tags');
      assert.equal((await b.toasts()).some((x) => x.includes('预选盟约')), false, 'no notice during the draft');

      // finish the draft: each holds and locks a strategy
      for (const [c, id] of [[a, 'band_bldsk'], [b, 'band_amiya']]) {
        await c.click(`.dband[data-band="${id}"]`);
        await c.click('[data-testid="draft-hold"]', '选择');
        await c.click('[data-testid="draft-lock"]', '锁定选择');
      }
      for (const c of all) await c.waitFor((s) => s.phase === 'PREP' && s.round === 1, 'round 1 prep', 90000);
      await sleep(3500); // the round plate goes by

      // A: the shop's operators and their bonds; a new plan from A's own team-panel row (a core bond of one card + an
      // add-on of another)
      const slots = await a.page.evaluate(() => (globalThis.__SP__.store.get().match.private?.shop?.slots || []).filter((x) => x && !x.sold && x.kind !== 'item').map((x) => x.id));
      const chess = await lookup(a, 'chess', slots);
      const bondInfo = new Map((await lookup(a, 'bonds', [...new Set(chess.flatMap((c) => c.bonds || []))])).map((x) => [x.id, x]));
      const coreOf = (c) => (c.bonds || []).find((id) => bondInfo.get(id)?.isCore);
      const cardBonds = [...new Set(chess.flatMap((c) => c.bonds || []))];
      assert.ok(cardBonds.length >= 1, `the shop's operators have bonds (${slots.join(', ')})`);
      // A's plan: a core bond of a card as the main one when there is one (round 1's shop may hold only 1★ add-on
      // operators), and up to two other bonds of the cards as secondary ones
      const aMain = chess.map(coreOf).find(Boolean) || null;
      const aSub = cardBonds.filter((id) => id !== aMain).slice(0, aMain ? 1 : 2);
      await a.click('[data-testid="bond-plan-team"]');
      await a.page.waitForSelector('.bplan-dlg', { visible: true, timeout: 10000 });
      await a.click('[data-testid="bond-plan-clear"]');
      if (aMain) await a.click(`[data-testid="bond-plan-main"] .bplan-card[data-bond="${aMain}"]`);
      for (const id of aSub) await a.click(`[data-testid="bond-plan-sub"] .bplan-card[data-bond="${id}"]`);
      await a.click('[data-testid="bond-plan-ok"]');
      await a.page.waitForSelector('.bplan-dlg', { hidden: true, timeout: 10000 });
      assert.deepEqual(await planOf(b, A), { main: aMain, sub: aSub });
      await toastSeen(b, `${A} 更改了预选盟约`);
      await sleep(300);
      await b.shot('4-notice-from-a');

      // B plans a bond of A's cards (A's main one as its main bond when there is one) and, when the cards have one, a bond
      // outside A's plan as a secondary one: A sees the teammate mark on those chips (no player shown, #152), and B's notice
      const bMain = aMain;
      const bSub = cardBonds.filter((id) => id !== aMain && !aSub.includes(id)).slice(0, 1);
      if (!bMain && !bSub.length) bSub.push(cardBonds[0]);
      await b.click('[data-testid="bond-plan-team"]');
      await b.page.waitForSelector('.bplan-dlg', { visible: true, timeout: 10000 });
      await b.click('[data-testid="bond-plan-clear"]', null, { optional: true, timeout: 1500 }); // (disabled: nothing planned yet)
      if (bMain) await b.click(`[data-testid="bond-plan-main"] .bplan-card[data-bond="${bMain}"]`);
      for (const id of bSub) await b.click(`[data-testid="bond-plan-sub"] .bplan-card[data-bond="${id}"]`);
      await b.click('[data-testid="bond-plan-ok"]');
      await b.page.waitForSelector('.bplan-dlg', { hidden: true, timeout: 10000 });
      await toastSeen(a, `${B} 更改了预选盟约`);
      await a.page.waitForSelector(aMain ? '.scard[data-plan="main"]' : '.scard[data-plan="sub"]', { timeout: 10000 });
      await a.page.waitForSelector('[data-testid="shop-plan-mates"]', { timeout: 10000 });
      // #152: the marks are on the bond chips, never the frame; a teammate is not shown by its avatar
      const chips = await a.page.$$eval('.shopbar .scard__bond', (els) => els.map((e) => ({ plan: e.dataset.plan || null, mate: e.classList.contains('is-mate') })));
      if (aMain) assert.ok(chips.some((x) => x.plan === 'main'), JSON.stringify(chips));
      if (aSub.length) assert.ok(chips.some((x) => x.plan === 'sub'), JSON.stringify(chips));
      assert.ok(chips.some((x) => x.mate), JSON.stringify(chips));
      assert.equal(await a.page.$$eval('.shopbar .scard .pavatar, .scard__mates', (els) => els.length), 0);
      const ring = await a.page.$$eval('.shopbar .scard[data-plan]', (els) => els.map((e) => getComputedStyle(e, '::before').boxShadow));
      assert.ok(ring.every((x) => !x || x === 'none'), `no plan ring: ${ring}`);
      await sleep(300);
      await a.shot('5-shop-plan-mates-notice');
      // 设置: each switch hides its marks at once
      const flip = async (label) => {
        await a.page.evaluate((l) => [...document.querySelectorAll('.set-toggle')].find((x) => x.getAttribute('aria-label') === l)?.click(), label);
      };
      await a.click('.gm__gear');
      await a.page.waitForSelector('.set-toggle[aria-label="商店标出队友的预选盟约"]', { visible: true, timeout: 10000 });
      await a.page.evaluate(() => [...document.querySelectorAll('.set-toggle')].find((x) => x.getAttribute('aria-label') === '商店标出我的预选盟约')?.scrollIntoView({ block: 'center' }));
      await sleep(300);
      await a.shot('6-settings-switches');
      await flip('商店标出队友的预选盟约');
      await a.page.waitForFunction(() => !document.querySelector('[data-testid="shop-plan-mates"]'), { timeout: 5000 });
      assert.ok(await a.page.$('.shopbar .scard[data-plan]'), 'my plan stays marked');
      await flip('商店标出我的预选盟约');
      await a.page.waitForFunction(() => !document.querySelector('.shopbar .scard[data-plan], .shopbar .scard__bond[data-plan]'), { timeout: 5000 });
      await flip('商店标出队友的预选盟约');
      await a.page.waitForSelector('[data-testid="shop-plan-mates"]', { timeout: 5000 });
      assert.equal(await a.page.$('.shopbar .scard[data-plan]'), null, 'mine stays off');
      await flip('商店标出我的预选盟约');
      await a.page.waitForSelector('.shopbar .scard[data-plan]', { timeout: 5000 });
      await a.page.keyboard.press('Escape');
      await a.page.waitForFunction(() => !document.querySelector('.set-toggle'), { timeout: 5000 }).catch(() => {});
      assert.equal((await a.toasts()).some((x) => x.includes(`${A} 更改了预选盟约`)), false, 'no toast of one\'s own change');
      assert.deepEqual(await planOf(a, B), { main: bMain, sub: bSub });
      assert.deepEqual(problemsOf(all), []);
    } finally {
      const dest = process.env.PLAN_SHOTS;
      if (dest) {
        mkdirSync(dest, { recursive: true });
        for (const c of all) for (const f of c.shots) { try { copyFileSync(path.join(OUT, f), path.join(dest, f)); } catch { /* not taken */ } }
      }
      for (const c of all) await c.close();
      await srv.stop();
    }
  });
});
