// Real-server browser E2E of the room's enemy multipliers (feedback #47) under the production combat configuration
// (SP_COMBAT=server, a combat Worker, local display replicas; unit counterparts: test/match/experimental-enemy-rules.test.js).
// The host picks both in the room's 实验性选项; the browser's replica of the Final Assault then fights multiplied enemies on
// a multiplied pool, on the Worker's digests, and does not go back to the stream.
//
//   SP_E2E=1 node --test test/ui/experimental-enemy-mul.e2e.test.js
//
// Screenshots: test/e2e/out/exp-enemy-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client, ROOT, sleep, hasChrome, startRealServer, problemsOf } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome() && existsSync(path.join(ROOT, 'public/assets'));
const YAN = ['chess_char_6_15_a', 'chess_char_5_12_a', 'chess_char_4_17_a', 'chess_char_3_03_a'];
const BOT_KIT = ['chess_char_4_01_a', 'chess_char_4_02_a', 'chess_char_3_01_a', 'chess_char_2_06_a'];

const replica = (c) => c.page.evaluate(() => {
  const e = [...(globalThis.__SP_RUNNER__?._entries?.values() || [])].find((x) => x.kind === 'boss');
  const store = globalThis.__SP__.store.get().match;
  const b = e?.battle;
  const foe = b?.enemies?.find((x) => !x.isBoss && x.mods?.hpMul > 0 && x.def?.maxHp > 0);
  return { phase: store.public?.phase ?? null, local: !!store.field?.local, flags: b ? { hp: b.flags.enemyHpMul, atk: b.flags.enemyAtkMul } : null,
    foe: foe ? { hp: foe.base.maxHp / (foe.def.maxHp * foe.mods.hpMul), atk: foe.def.atk > 0 ? foe.base.atk / (foe.def.atk * (foe.mods.atkMul ?? 1)) : null } : null,
    e: e ? { replica: !!e.replica, dropped: !!e.dropped, replay: !!e.replay, synced: e.synced ?? 0 } : null };
});

describe('enemy multipliers (server-run combat, real server + Worker)', { skip: !ENABLED && 'set SP_E2E=1 (Chrome + public/assets)' }, () => {
  test('both lists reach the Worker and the replica: multiplied enemies, digests agree, no stream fallback', { timeout: 6 * 60 * 1000 }, async () => {
    const srv = await startRealServer({ fast: { timerScale: 1, combatSpeed: 2, startRound: 'boss', autoPlace: true, kits: [YAN], botChess: BOT_KIT },
      env: { SP_COMBAT: 'server', SP_COMBAT_WORKERS: '1', SP_SNAPSHOT_HZ: '10' } });
    const P = (await import('puppeteer-core')).default;
    const host = new Client(P, srv.base, 'host', { prefix: 'exp-enemy', w: 1280, h: 720 });
    try {
      await host.open();
      await host.enter('凯尔希');
      await host.createCoop('标准模拟');
      for (let i = 0; i < 3; i++) { await host.click('button', '添加 AI 队友'); await sleep(500); }
      await host.click('.rs-exp');
      await host.page.waitForSelector('.room-settings-modal', { visible: true, timeout: 10000 });
      await host.shot('options-off');
      await host.page.select('#experimental-enemy-hp', '2');
      await host.page.waitForFunction(() => globalThis.__SP__.store.get().room?.experimental?.enemyHpMul === 2, { timeout: 10000 });
      await host.page.select('#experimental-enemy-atk', '3');
      await host.page.waitForFunction(() => globalThis.__SP__.store.get().room?.experimental?.enemyAtkMul === 3, { timeout: 10000 });
      await host.shot('options-on');
      await host.click('.room-settings-modal .modal__actions button');
      await host.page.waitForSelector('.room-settings-modal', { hidden: true, timeout: 10000 });
      await host.shot('room');
      assert.match(await host.page.$eval('.rs-exp small', (el) => el.textContent), /敌人生命 ×2 · 敌人攻击 ×3/);
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
      await host.click('.readybtn');
      await host.waitFor((s) => s.phase === 'FINAL_ASSAULT', 'Final Assault', 90000);
      await host.page.waitForFunction(() => [...(globalThis.__SP_RUNNER__?._entries?.values() || [])].some((e) => e.kind === 'boss' && e.replay && e.battle), { timeout: 30000 });
      await host.shot('fight');
      let last = await replica(host);
      const start = Date.now();
      while (Date.now() - start < 40000) {
        const now = await replica(host);
        if (now.e) last = { ...now, foe: now.foe ?? last.foe };
        if (now.phase !== 'FINAL_ASSAULT' || last.e?.synced >= 4 && last.foe) break;
        await sleep(200);
      }
      assert.deepEqual(last.flags, { hp: 2, atk: 3 }, JSON.stringify(last));
      assert.ok(last.foe, `an enemy on the replica: ${JSON.stringify(last)}`);
      assert.equal(Math.round(last.foe.hp * 1000) / 1000, 2);
      if (last.foe.atk != null) assert.equal(Math.round(last.foe.atk * 1000) / 1000, 3);
      assert.deepEqual([last.e.replica, last.e.replay, last.e.dropped], [true, true, false], JSON.stringify(last));
      assert.ok(last.e.synced > 0, `the Worker's digests matched: ${JSON.stringify(last)}`);
      assert.ok(last.local, 'the field on screen was the local replica');
      assert.ok(!srv.logs.some((l) => /local replica → stream/.test(l)), srv.logs.filter((l) => /local replica/.test(l)).join('\n'));
      assert.deepEqual(problemsOf([host]), []);
    } finally {
      await host.close?.().catch?.(() => {});
      await srv.stop();
    }
  });
});
