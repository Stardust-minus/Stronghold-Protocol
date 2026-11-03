// Real-server browser E2E of 塔露拉 (char_4247_oxi, op-oxi.js): 干员调配 → 自选编队 fills a tier-5 slot with her S3; the shop
// sells her with 「自选」 and her bonds 协防 + 奥术 + 不屈; deployed, the card shows the talent note of this game's rule; in the
// browser's own battle the local sim fields her kit, and S3's 簇火 fly the official projectile (oxi_skill_03_trail_01 through
// SkillFx.kitFlights) instead of a procedural fx.
//
//   SP_E2E=1 node --test test/ui/oxi.e2e.test.js
//
// Screenshots: test/e2e/out/oxi-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client, ROOT, sleep, hasChrome, startRealServer } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome() && existsSync(path.join(ROOT, 'public/assets'));
const SLOT = 'chess_char_5_diy1_a';
const OXI = 'char_4247_oxi';
const PICKER = '[data-testid="diy-picker"]';

describe('塔露拉 in 自选编队 (real server)', { skip: !ENABLED && 'set SP_E2E=1 (Chrome + public/assets)' }, () => {
  test('slot her → level-5 shop card → deploy → her S3 flies the official 簇火', { timeout: 6 * 60 * 1000 }, async () => {
    const srv = await startRealServer({ fast: { timerScale: 0.5, combatSpeed: 0.2, startRound: 1, kit: 0, level: 5, shop: [SLOT] } });
    const P = (await import('puppeteer-core')).default;
    const c = new Client(P, srv.base, 'oxi', { prefix: 'oxi' });
    try {
      await c.open();
      await c.enter('塔露拉');
      await c.click('.lobby-screen [data-testid="loadout-open"]');
      await c.page.waitForSelector('.lo .lo-tab[data-tab="diy"]', { visible: true, timeout: 15000 });
      await c.click('.lo .lo-tab[data-tab="diy"]');
      await c.page.waitForSelector(`.diy-slot[data-slot="${SLOT}"] .diy-slot__fill`, { visible: true, timeout: 15000 });
      await c.click(`.diy-slot[data-slot="${SLOT}"] .diy-slot__fill`);
      await c.page.waitForSelector(`${PICKER} .diy-opt[data-char="${OXI}"]`, { timeout: 8000 });
      await c.page.$eval(`${PICKER} .diy-opt[data-char="${OXI}"]`, (e) => { e.scrollIntoView({ block: 'center' }); (e.querySelector('.diy-opt__pick') ?? e).click(); });
      await c.page.waitForSelector(`${PICKER} .lo-skill[data-skill="2"]`, { visible: true, timeout: 5000 });
      await c.page.click(`${PICKER} .lo-skill[data-skill="2"]`);
      await c.shot('picker');
      await c.click('[data-testid="diy-confirm"]');
      await c.page.waitForFunction((slot, id) => document.querySelector(`.diy-slot[data-slot="${slot}"]`)?.dataset.char === id, { timeout: 4000 }, SLOT, OXI);
      await c.page.waitForFunction(() => /已同步/.test(document.querySelector('[data-testid="diy-sync"]')?.textContent || ''), { timeout: 8000 });
      await c.shot('slotted');
      await c.page.keyboard.press('Escape');
      await c.page.waitForFunction(() => !document.querySelector('.lo'), { timeout: 3000 });

      await c.createSolo('标准模拟');
      await c.waitFor((s) => !!s.room, 'solo room');
      if (!(await c.st()).phase) await c.roomStart({ timeout: 20000 });
      await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 30000);
      await c.settled('.brief-go');
      await c.click('.brief__foot .btn--primary', '准备就绪');
      await c.waitFor((s) => s.phase === 'BAND_DRAFT', 'band draft', 30000);
      await c.click('.dband', null, { nth: 1 });
      await c.click('.draft-detail__btns .btn--primary', '确认选择');
      await c.waitFor((s) => s.phase === 'PREP' && !s.ready && s.funds >= 4 && s.level >= 5, 'prep', 60000);
      await sleep(1800);

      await c.page.waitForSelector('.scard .scard__diy', { visible: true, timeout: 10000 });
      const shopCard = await c.page.evaluate(() => {
        const el = document.querySelector('.scard .scard__diy')?.closest('.scard');
        return el ? { name: el.querySelector('.scard__name')?.textContent, text: el.textContent } : null;
      });
      assert.equal(shopCard?.name, '塔露拉');
      for (const b of ['协防', '奥术', '不屈']) assert.ok(shopCard.text.includes(b), `shop card bond ${b}: ${shopCard.text}`);
      await c.shot('shop');
      await c.click('.scard', '塔露拉');
      await sleep(300);
      await c.click('.scard', '塔露拉');
      await c.waitFor((s) => s.hand > 0, 'bought', 8000);
      await sleep(900);
      const [piece] = (await c.handPieces('chess')).filter((p) => p.id === SLOT);
      assert.ok(piece, 'in the hand');

      const tile = await c.freeTileFor(piece.uid);
      assert.ok(tile, 'a legal tile');
      await c.drag(await c.piecePoint(piece.uid), await c.tilePoint(tile.row, tile.col));
      await c.page.waitForSelector('.fwheel__dia', { timeout: 4000 });
      await c.swipe('RIGHT');
      await c.waitFor((s) => s.board > 0, 'placed', 8000);
      await sleep(600);
      let card = null;
      for (const at of [0.72, 0.4, 0.88]) {
        const p = await c.piecePoint(piece.uid, at);
        if (!p) continue;
        await c.page.mouse.click(p.x, p.y, { button: 'right' });
        card = await c.page.waitForSelector('.dpanel .dtag-diy', { timeout: 2500 }).then(() => c.page.evaluate(() => document.querySelector('.dpanel')?.textContent || ''), () => null);
        if (card) break;
      }
      assert.ok(card?.includes('塔露拉'), 'the detail card opens');
      assert.ok(card.includes('三技能持续期间，我方其他干员阵亡时'), 'this game\'s rule is on her card');
      await c.shot('card');
      await c.page.keyboard.press('Escape');

      await c.click('.readybtn');
      await c.waitFor((s) => s.phase === 'COMBAT', 'combat', 60000);
      const fired = await c.page.waitForFunction((uid) => {
        const r = globalThis.__SP_RUNNER__;
        const e = r && [...r._entries.values()].find((x) => x.own && x.battle);
        const u = e?.battle.allyUnits.find((x) => x.uid === uid);
        if (!u?.skill || !u.deployed) return false;
        // the battle's own trigger needs an enemy in reach, which the tile may not give: open her S3 for the drawing
        if (!u.skill.active && !u.mem.oxiForced) { u.mem.oxiForced = true; u.skill.sp = u.skill.spCost; u.skill.charges = 1; u.skill.activate('manual'); }
        const flames = e.battle.projectiles.list.filter((p) => p.data?.oxiFlame === u);
        return flames.length ? { n: flames.length, kit: u.kit?.generic === true ? 'generic' : u.def.charId, skill: u.skill.id, bonds: u.def.bonds, dmgType: u.dmgType } : false;
      }, { timeout: 45000, polling: 100 }, piece.uid).then((h) => h.jsonValue());
      assert.deepEqual([fired.kit, fired.skill, fired.bonds, fired.dmgType], [OXI, 'skchr_oxi_3', ['emptyShip', 'arcaneShip', 'indomShip'], 'arts']);
      const flameAt = () => c.page.evaluate(() => {
        const w = globalThis.__SP_VIEW__?.raw?.debug?.wiring, out = [];
        for (const h of w?.skills?.kitFlights?.values() ?? []) {
          const fx = h.effect;
          const a = fx?.anchor;
          if (a) out.push({ a: [...a], time: fx.time });
        }
        return out;
      });
      // (the prefab loads on its first use: wait for a shot crossing the board)
      let mid = null;
      // software GL, ~3 frames/s: wait for the prefab's textures (hence combatSpeed 0.2, the skill outlasts the load)
      await c.page.evaluate(async () => {
        const lib = globalThis.__SP_VIEW__.raw.debug.wiring.ofx.lib;
        await Promise.race([lib.preload(['oxi_skill_03_trail_01', 'oxi_skill_03_hit_01'], { half: false }), new Promise((r) => setTimeout(r, 90000))]);
      });
      await sleep(3000);
      for (let i = 0; i < 60 && !mid; i++) {
        await sleep(200);
        mid = (await flameAt()).find((x) => x.a[0] > -7 && x.a[0] < 2 && x.time > 0.2) ?? null;
      }
      assert.ok(mid, 'a 簇火 crosses the board');
      await c.shot('flight');
      const drawn = await c.page.evaluate(async () => {
        const w = globalThis.__SP_VIEW__.raw.debug.wiring, o = w.ofx;
        let draws = 0;
        const reset = o.frameStats.bind(o);
        o.frameStats = () => { draws = Math.max(draws, o.glr?.stats?.draws ?? 0); reset(); };
        await new Promise((r) => setTimeout(r, 2500));
        o.frameStats = reset;
        return { active: o.active, flights: w.skills.kitFlights.size, installed: !!w.idx?.projectiles?.projectile_chr_oxi_s_3_heatwave, draws };
      });
      assert.deepEqual([drawn.active, drawn.installed], [true, true], 'official effects on, her projectile installed');
      assert.ok(drawn.flights > 0 && drawn.draws > 0, `the 簇火 fly and draw the official effect: ${JSON.stringify(drawn)}`);
      assert.deepEqual(c.problems.filter((p) => p.startsWith('pageerror:')), []);
    } finally {
      await c.close();
      await srv.stop();
    }
  });
});
