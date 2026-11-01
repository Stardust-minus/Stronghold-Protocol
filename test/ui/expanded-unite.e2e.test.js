// Real-server browser E2E of an expanded room's 联防 under the production combat configuration: an eight-seat room whose
// host has no board leaks, the AI helpers fight on the round's own limit, and the screen and m.public carry no budget.
//
//   SP_E2E=1 node --test test/ui/expanded-unite.e2e.test.js
//
// Screenshots: test/e2e/out/expanded-unite-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client, ROOT, sleep, hasChrome, startRealServer, problemsOf } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome() && existsSync(path.join(ROOT, 'public/assets'));
const BOT_KIT = ['chess_char_4_01_a', 'chess_char_4_02_a', 'chess_char_3_01_a', 'chess_char_2_06_a'];

describe('expanded 联防 (server-run combat, real server + Worker)', { skip: !ENABLED && 'set SP_E2E=1 (Chrome + public/assets)' }, () => {
  test('eight seats: the round\'s limit, no budget on screen or in m.public', { timeout: 6 * 60 * 1000 }, async () => {
    const srv = await startRealServer({ fast: { timerScale: 1, combatSpeed: 2, startRound: 2, autoPlace: true, kits: [[]], botChess: BOT_KIT },
      env: { SP_COMBAT: 'server', SP_COMBAT_WORKERS: '1', SP_SNAPSHOT_HZ: '10' } });
    const P = (await import('puppeteer-core')).default;
    const host = new Client(P, srv.base, 'host', { prefix: 'expanded-unite', w: 1280, h: 720 });
    const request = (type, fields = {}) => host.page.evaluate((a, b) => globalThis.__SP__.net.request(a, b).then(() => true), type, fields);
    const pub = () => host.page.evaluate(() => {
      const s = globalThis.__SP__.store.get().match;
      return { phase: s.public?.phase, unite: s.public?.unite ?? null, uniteRound: s.public?.uniteRound ?? null, uniteRounds: s.public?.uniteRounds ?? null,
        deadline: s.public?.deadline ?? 0, now: Date.now(), budget: document.querySelectorAll('.gtop__budget, .gm--unite-budget').length, gm: document.querySelectorAll('.gm--expanded').length };
    });
    try {
      await host.open();
      await host.enter('凯尔希');
      await request('room.create', { mode: 'coop', difficulty: 'NORMAL', experimental: { revivalEnabled: false, disableSharedPool: false, playerCapacity: 8 } });
      await host.page.waitForSelector('.rs', { visible: true, timeout: 15000 });
      for (let i = 0; i < 7; i++) await request('room.addBot');
      await host.roomStart({ timeout: 20000 });
      await host.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 30000);
      await host.settled('.brief-go');
      await host.click('.brief__foot .btn--primary', '准备就绪');
      await host.waitFor((s) => s.phase !== 'INFO_CHECK', 'band draft', 40000);
      const bandId = await host.page.evaluate(() => globalThis.__SP__.store.get().match.public?.draft?.bands?.[0]?.bandId ?? null);
      await request('g.band', { bandId: bandId ?? 'band_bldsk' }).catch(() => {});
      await host.waitFor((s) => s.phase === 'PREP' && !s.ready, 'prep', 90000);
      await host.click('.readybtn');
      await host.waitFor((s) => s.phase === 'UNITE', '联防', 90000);
      const first = await pub();
      await host.shot('unite');
      assert.equal(first.gm, 1, 'the expanded screen');
      assert.equal(first.budget, 0, 'no budget note or class');
      for (const key of ['timeLimit', 'totalBudget', 'remainingBudget', 'gameSpeed']) assert.equal(Object.hasOwn(first.unite, key), false, key);
      assert.ok(first.deadline > first.now && first.deadline - first.now < 91000, `the round's limit, not 150 real s: ${first.deadline - first.now} ms`);
      assert.ok(first.uniteRounds === 1 || first.uniteRounds === 2, JSON.stringify(first));
      await host.waitFor((s) => s.phase === 'SETTLE' || s.phase === 'PREP', 'the 联防 ended', 200000);
      await host.shot('after');
      assert.ok(!srv.logs.some((l) => /local replica → stream/.test(l)), srv.logs.filter((l) => /local replica/.test(l)).join('\n'));
      assert.deepEqual(problemsOf([host]), []);
      await sleep(100);
    } finally {
      await host.close?.().catch?.(() => {});
      await srv.stop();
    }
  });
});
