// Real-server browser E2E of the 2026-11-01 乌萨斯 自选 operators 冻河 (char_4244_tocka, op-tocka.js) and 国度
// (char_4246_dminon, op-dminon.js): 干员调配 → 自选编队 fills a tier-5 slot with her S3; the shop sells her with 「自选」
// and her bonds; deployed, the browser's own battle fields her kit and her S3 spawns official effects of her own prefabs
// (public/assets/local/fx, extracted with --fx-collab exclude).
//
//   SP_E2E=1 [SP_E2E_GPU=1] node --test test/ui/new-ops.e2e.test.js
//
// Screenshots: test/e2e/out/newops-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client, ROOT, sleep, hasChrome, startRealServer } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome() && existsSync(path.join(ROOT, 'public/assets'));
const SLOT = 'chess_char_5_diy1_a';
const PICKER = '[data-testid="diy-picker"]';
const OPS = [
  { charId: 'char_4244_tocka', name: '冻河', code: 'tocka', bonds: ['协防', '灵巧', '迅捷'] },
  { charId: 'char_4246_dminon', name: '国度', code: 'dminon', bonds: ['协防', '独行'] },
];

describe('冻河 and 国度 in 自选编队 (real server)', { skip: !ENABLED && 'set SP_E2E=1 (Chrome + public/assets)' }, () => {
  for (const op of OPS) {
    test(`${op.name}: slot her S3 → level-5 shop card → deploy → her S3 spawns her official effects`, { timeout: 6 * 60 * 1000 }, async () => {
      const srv = await startRealServer({ fast: { timerScale: 0.5, combatSpeed: 0.3, startRound: 1, kit: 0, level: 5, shop: [SLOT] } });
      const P = (await import('puppeteer-core')).default;
      const c = new Client(P, srv.base, `newops-${op.code}`, { prefix: `newops-${op.code}` });
      try {
        await c.open();
        await c.enter(op.name);
        await c.click('.lobby-screen [data-testid="loadout-open"]');
        await c.page.waitForSelector('.lo .lo-tab[data-tab="diy"]', { visible: true, timeout: 15000 });
        await c.click('.lo .lo-tab[data-tab="diy"]');
        await c.page.waitForSelector(`.diy-slot[data-slot="${SLOT}"] .diy-slot__fill`, { visible: true, timeout: 15000 });
        await c.click(`.diy-slot[data-slot="${SLOT}"] .diy-slot__fill`);
        await c.page.waitForSelector(`${PICKER} .diy-opt[data-char="${op.charId}"]`, { timeout: 8000 });
        await c.page.$eval(`${PICKER} .diy-opt[data-char="${op.charId}"]`, (e) => { e.scrollIntoView({ block: 'center' }); (e.querySelector('.diy-opt__pick') ?? e).click(); });
        await c.page.waitForSelector(`${PICKER} .lo-skill[data-skill="2"]`, { visible: true, timeout: 5000 });
        await c.page.click(`${PICKER} .lo-skill[data-skill="2"]`);
        await c.click('[data-testid="diy-confirm"]');
        await c.page.waitForFunction((slot, id) => document.querySelector(`.diy-slot[data-slot="${slot}"]`)?.dataset.char === id, { timeout: 4000 }, SLOT, op.charId);
        await c.page.waitForFunction(() => /已同步/.test(document.querySelector('[data-testid="diy-sync"]')?.textContent || ''), { timeout: 8000 });
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
        assert.equal(shopCard?.name, op.name);
        for (const b of op.bonds) assert.ok(shopCard.text.includes(b), `shop card bond ${b}: ${shopCard.text}`);
        await c.shot('shop');
        await c.click('.scard', op.name);
        await sleep(300);
        await c.click('.scard', op.name);
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

        // record the official effects spawned from here on
        await c.page.evaluate(() => {
          const o = globalThis.__SP_VIEW__?.raw?.debug?.wiring?.ofx;
          globalThis.__spawned = [];
          if (!o) return;
          const orig = o.spawn.bind(o);
          o.spawn = (k, p, opt) => { const h = orig(k, p, opt); globalThis.__spawned.push([String(k), !!h]); return h; };
        });
        await c.click('.readybtn');
        await c.waitFor((s) => s.phase === 'COMBAT', 'combat', 60000);
        const fired = await c.page.waitForFunction((uid) => {
          const r = globalThis.__SP_RUNNER__;
          const e = r && [...r._entries.values()].find((x) => x.own && x.battle);
          const u = e?.battle.allyUnits.find((x) => x.uid === uid);
          if (!u?.skill || !u.deployed) return false;
          // the battle's own trigger needs an enemy in reach or a full SP bar: open her S3 for the drawing
          if (!u.skill.active && !u.mem.e2eForced) { u.mem.e2eForced = true; u.skill.sp = u.skill.spCost; u.skill.charges = Math.max(1, u.skill.charges || 0); u.skill.activate('manual'); }
          return u.skill.active ? { kit: u.kit?.generic === true ? 'generic' : u.def.charId, skill: u.skill.id, bonds: u.def.bonds } : false;
        }, { timeout: 45000, polling: 100 }, piece.uid).then((h) => h.jsonValue());
        assert.deepEqual([fired.kit, fired.skill], [op.charId, `skchr_${op.code}_3`]);
        let own = [];
        for (let i = 0; i < 150 && !own.length; i++) {
          await sleep(200);
          own = await c.page.evaluate((code) => (globalThis.__spawned || []).filter(([k, ok]) => ok && k.includes(code)), op.code);
        }
        await c.shot('skill');
        const spawned = await c.page.evaluate(() => (globalThis.__spawned || []).map(([k, ok]) => `${k}${ok ? '' : '(-)'}`));
        assert.ok(own.length > 0, `her S3 spawns an official effect of her own: ${JSON.stringify(spawned.slice(0, 40))}`);
        await sleep(2500);
        await c.shot('skill-late');
        assert.deepEqual(c.problems.filter((p) => p.startsWith('pageerror:')), []);
      } finally {
        await c.close();
        await srv.stop();
      }
    });
  }
});
