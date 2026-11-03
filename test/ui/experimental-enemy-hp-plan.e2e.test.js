// Real-server browser E2E of 敌人生命倍率 by round (feedback #118, rel27) under the production combat configuration
// (SP_COMBAT=server, a combat Worker, local display replicas; unit counterparts: test/match/experimental-enemy-hp-plan.test.js,
// test/ui/experimental-enemy-hp-plan.test.js). The host switches it on in 同盟设置 → 规则, edits the segments (moves one,
// adds one, removes it), the room shows the plan; the match starts at the boss round, whose battles and leader pool then
// take the last segment's multiplier — on the Worker and on the browser's replica.
//
//   SP_E2E=1 node --test test/ui/experimental-enemy-hp-plan.e2e.test.js
//
// Screenshots: test/e2e/out/exp-hpplan-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client, ROOT, sleep, hasChrome, startRealServer, problemsOf } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome() && existsSync(path.join(ROOT, 'public/assets'));
const YAN = ['chess_char_6_15_a', 'chess_char_5_12_a', 'chess_char_4_17_a', 'chess_char_3_03_a'];
const BOT_KIT = ['chess_char_4_01_a', 'chess_char_4_02_a', 'chess_char_3_01_a', 'chess_char_2_06_a'];

const plan = (c) => c.page.evaluate(() => JSON.stringify(globalThis.__SP__.store.get().room?.experimental?.enemyHpPlan ?? null));
const waitPlan = (c, want) => c.page.waitForFunction((w) => JSON.stringify(globalThis.__SP__.store.get().room?.experimental?.enemyHpPlan ?? null) === w,
  { timeout: 10000 }, JSON.stringify(want));
const replica = (c) => c.page.evaluate(() => {
  const e = [...(globalThis.__SP_RUNNER__?._entries?.values() || [])].find((x) => x.kind === 'boss');
  const store = globalThis.__SP__.store.get().match;
  const b = e?.battle;
  const foe = b?.enemies?.find((x) => !x.isBoss && x.mods?.hpMul > 0 && x.def?.maxHp > 0);
  return { phase: store.public?.phase ?? null, round: store.public?.round ?? null, flags: b ? { hp: b.flags.enemyHpMul ?? 1 } : null,
    foe: foe ? { hp: foe.base.maxHp / (foe.def.maxHp * foe.mods.hpMul) } : null, e: e ? { replica: !!e.replica, dropped: !!e.dropped, synced: e.synced ?? 0 } : null };
});

describe('enemy HP by round (server-run combat, real server + Worker)', { skip: !ENABLED && 'set SP_E2E=1 (Chrome + public/assets)' }, () => {
  test('the host edits the plan in 规则; the boss round fights under its last segment, on the Worker and the replica', { timeout: 6 * 60 * 1000 }, async () => {
    const srv = await startRealServer({ fast: { timerScale: 1, combatSpeed: 2, startRound: 'boss', autoPlace: true, kits: [YAN], botChess: BOT_KIT },
      env: { SP_COMBAT: 'server', SP_COMBAT_WORKERS: '1', SP_SNAPSHOT_HZ: '10' } });
    const P = (await import('puppeteer-core')).default;
    const host = new Client(P, srv.base, 'host', { prefix: 'exp-hpplan', w: 1280, h: 720 });
    try {
      await host.open();
      await host.enter('凯尔希');
      await host.createCoop('标准模拟');
      for (let i = 0; i < 3; i++) { await host.click('button', '添加 AI 队友'); await sleep(500); }
      await host.click('.rs-exp');
      await host.page.waitForSelector('.room-settings-modal', { visible: true, timeout: 10000 });
      assert.equal(await host.page.$('[data-testid="experimental-enemy-hp-plan"]'), null, 'no editor while off');
      await host.click('[data-testid="experimental-enemy-hp-plan-switch"]');
      await waitPlan(host, [[1, 1], [6, 1.5], [9, 2.5]]);
      await host.page.waitForSelector('[data-testid="experimental-enemy-hp-plan"]', { visible: true, timeout: 10000 });
      assert.equal(await host.page.$eval('#experimental-enemy-hp', (el) => el.disabled), true, 'the single list is the plan\'s');
      await host.shot('on');
      // move the second segment to round 5, add a fourth, then remove it
      await host.page.select('[data-testid="experimental-enemy-hp-from"]', '5');
      await waitPlan(host, [[1, 1], [5, 1.5], [9, 2.5]]);
      // the dialog's body scrolls: bring the button into view first (Client.click aims at what is on screen)
      await host.page.$eval('[data-testid="experimental-enemy-hp-add"]', (el) => el.scrollIntoView({ block: 'center' }));
      await host.click('[data-testid="experimental-enemy-hp-add"]');
      await waitPlan(host, [[1, 1], [5, 1.5], [9, 2.5], [10, 3]]);
      assert.equal((await host.page.$$('[data-testid="experimental-enemy-hp-seg"]')).length, 4);
      await host.page.$eval('[data-testid="experimental-enemy-hp-add"]', (el) => el.scrollIntoView({ block: 'end' }));
      await host.shot('four');
      await host.page.evaluate(() => [...document.querySelectorAll('[data-testid="experimental-enemy-hp-del"]')].at(-1).click());
      await waitPlan(host, [[1, 1], [5, 1.5], [9, 2.5]]);
      await host.click('.room-settings-modal .modal__actions button');
      await host.page.waitForSelector('.room-settings-modal', { hidden: true, timeout: 10000 });
      assert.match(await host.page.$eval('.rs-exp small', (el) => el.textContent), /敌人生命 1–4回合 ×1 \/ 5–8回合 ×1\.5 \/ 9回合起 ×2\.5/);
      await host.shot('room');
      assert.equal(await plan(host), JSON.stringify([[1, 1], [5, 1.5], [9, 2.5]]));
      await host.roomStart({ timeout: 20000 });
      await host.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 30000);
      await host.settled('.brief-go');
      await host.click('.brief__foot .btn--primary', '准备就绪');
      await host.waitFor((s) => s.phase !== 'INFO_CHECK', 'band draft', 40000);
      for (let i = 0; i < 120; i++) {
        const s = await host.st();
        if (s.phase !== 'BAND_DRAFT') break;
        if (s.draft?.turn === s.me) {
          await host.click('.dband:not(.is-taken)', null, { nth: 2 });
          await host.click('.draft-detail__btns .btn--primary', '确认选择');
        }
        await sleep(250);
      }
      await host.waitFor((s) => s.phase === 'PREP' && !s.ready, 'boss-round prep', 90000);
      assert.deepEqual(await host.page.evaluate(() => globalThis.__SP__.store.get().match.public?.experimental?.enemyHpPlan), [[1, 1], [5, 1.5], [9, 2.5]]);
      await host.click('.readybtn');
      await host.waitFor((s) => s.phase === 'FINAL_ASSAULT', 'Final Assault', 90000);
      await host.page.waitForFunction(() => [...(globalThis.__SP_RUNNER__?._entries?.values() || [])].some((e) => e.kind === 'boss' && e.replay && e.battle), { timeout: 30000 });
      let last = await replica(host);
      const start = Date.now();
      while (Date.now() - start < 40000) {
        const now = await replica(host);
        if (now.e) last = { ...now, foe: now.foe ?? last.foe };
        if (now.phase !== 'FINAL_ASSAULT' || last.e?.synced >= 4 && last.foe) break;
        await sleep(200);
      }
      await host.shot('fight');
      assert.ok(last.round >= 9, `the boss round is in the last segment: ${JSON.stringify(last)}`);
      assert.deepEqual(last.flags, { hp: 2.5 }, JSON.stringify(last));
      assert.ok(last.foe, `an enemy on the replica: ${JSON.stringify(last)}`);
      assert.equal(Math.round(last.foe.hp * 1000) / 1000, 2.5);
      assert.ok(last.e.synced > 0 && !last.e.dropped, `the Worker's digests matched: ${JSON.stringify(last)}`);
      assert.deepEqual(problemsOf([host]), []);
    } finally {
      await host.close?.().catch?.(() => {});
      await srv.stop();
    }
  });
});
