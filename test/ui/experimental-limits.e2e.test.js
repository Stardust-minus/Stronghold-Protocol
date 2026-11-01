// Real-server browser E2E of the room's disableLayerCap / disableHitLimit under the production combat configuration
// (SP_COMBAT=server, a combat Worker, local display replicas; unit counterparts: test/match/experimental-limits.test.js).
// The host sets both in the room's 实验性选项; a 炎 board with 300000 layers then shows them shortened on the bond disc,
// exact in the match state, runs the Final Assault in its browser on the Worker's pool record without going back to the
// stream, and its hits past 300000 clear the leaders long before the level's countdown.
//
//   SP_E2E=1 node --test test/ui/experimental-limits.e2e.test.js
//
// Screenshots: test/e2e/out/exp-limits-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client, ROOT, sleep, hasChrome, startRealServer, problemsOf } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome() && existsSync(path.join(ROOT, 'public/assets'));
const YAN = ['chess_char_6_15_a', 'chess_char_5_12_a', 'chess_char_4_17_a', 'chess_char_3_03_a'];
const BOT_KIT = ['chess_char_4_01_a', 'chess_char_4_02_a', 'chess_char_3_01_a', 'chess_char_2_06_a'];
const LAYERS = 300000;

const replica = (c) => c.page.evaluate(() => {
  const r = globalThis.__SP_RUNNER__;
  const e = [...(r?._entries?.values() || [])].find((x) => x.kind === 'boss');
  const store = globalThis.__SP__.store.get().match;
  return { phase: store.public?.phase ?? null, local: !!store.field?.local, pool: store.public?.bossHp ?? null,
    e: e ? { replica: !!e.replica, dropped: !!e.dropped, replay: !!e.replay, synced: e.synced, tick: e.battle?.tickCount ?? null, finished: !!e.battle?.finished } : null };
});

describe('room rules past the official limits (server-run combat, real server + Worker)', { skip: !ENABLED && 'set SP_E2E=1 (Chrome + public/assets)' }, () => {
  test('both switches reach the Worker and the replica: layers past 999, leaders cleared by hits past 300000, no stream fallback', { timeout: 6 * 60 * 1000 }, async () => {
    const srv = await startRealServer({ fast: { timerScale: 1, combatSpeed: 2, startRound: 'boss', autoPlace: true, kits: [YAN], botChess: BOT_KIT },
      env: { SP_COMBAT: 'server', SP_COMBAT_WORKERS: '1', SP_SNAPSHOT_HZ: '10', SP_START_LAYERS: `yanShip:${LAYERS}` } });
    const P = (await import('puppeteer-core')).default;
    const host = new Client(P, srv.base, 'host', { prefix: 'exp-limits', w: 1280, h: 720 });
    try {
      await host.open();
      await host.enter('凯尔希');
      await host.createCoop('标准模拟');
      for (let i = 0; i < 3; i++) { await host.click('button', '添加 AI 队友'); await sleep(500); }
      await host.click('.rs-exp');
      await host.page.waitForSelector('.experimental-modal', { visible: true, timeout: 10000 });
      await host.shot('options-off');
      await host.click('#experimental-layer-cap');
      await host.page.waitForFunction(() => globalThis.__SP__.store.get().room?.experimental?.disableLayerCap === true, { timeout: 10000 });
      await host.click('#experimental-hit-limit');
      await host.page.waitForFunction(() => globalThis.__SP__.store.get().room?.experimental?.disableHitLimit === true, { timeout: 10000 });
      await host.shot('options-on');
      await host.click('.experimental-modal .modal__actions button');
      await host.page.waitForSelector('.experimental-modal', { hidden: true, timeout: 10000 });
      await host.shot('room');
      const summary = await host.page.$eval('.rs-exp small', (el) => el.textContent);
      assert.match(summary, /禁用层数上限 · 禁用单次伤害上限/);
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
      const held = await host.page.evaluate(() => globalThis.__SP__.store.get().match.private?.bonds?.find((b) => b.bondId === 'yanShip')?.layers);
      assert.equal(held, LAYERS, 'the count passed 999');
      const discs = await host.page.$$eval('.bond__count', (list) => list.map((el) => el.textContent));
      assert.ok(discs.includes('300k'), `the disc shortens it: ${discs}`);
      await host.shot('prep');
      await host.click('.readybtn');
      await host.waitFor((s) => s.phase === 'FINAL_ASSAULT', 'Final Assault', 90000);
      await host.page.waitForFunction(() => [...(globalThis.__SP_RUNNER__?._entries?.values() || [])].some((e) => e.kind === 'boss' && e.replay && e.battle), { timeout: 30000 });
      const start = Date.now();
      let last = await replica(host);
      await host.shot('fight');
      while (Date.now() - start < 100000) {
        const now = await replica(host);
        if (now.e) last = now;
        if (now.phase !== 'FINAL_ASSAULT') break;
        await sleep(100);
      }
      const after = await host.st();
      assert.notEqual(after.phase, 'FINAL_ASSAULT', `the leaders fell before the level's 120 s (${JSON.stringify(last)})`);
      assert.deepEqual([last.e.replica, last.e.replay, last.e.dropped], [true, true, false], JSON.stringify(last));
      assert.ok(last.local, 'the field on screen was the local replica');
      assert.ok(!srv.logs.some((l) => /local replica → stream/.test(l)), srv.logs.filter((l) => /local replica/.test(l)).join('\n'));
      await host.shot('after');
      assert.deepEqual(problemsOf([host]), []);
    } finally {
      await host.close?.().catch?.(() => {});
      await srv.stop();
    }
  });
});
