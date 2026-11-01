// Real-server browser E2E in the production combat configuration (SP_COMBAT=server, a combat Worker, 10 Hz snapshots) —
// feedback #105: when a battle ends the renderer leaves the battle clock (a local replica's frames, the stream's snapshots
// stop) for its presentation tail, so a skill effect plays out and goes instead of standing on its last frame. Checked on a
// local replica and on a spectator's stream, through the settlement.
//
//   SP_E2E=1 CHROME_PATH=… node --test test/ui/battle-finish-live.e2e.test.js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client, ROOT, sleep, hasChrome, startRealServer, problemsOf } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome() && existsSync(path.join(ROOT, 'public/assets'));
const HOST_KIT = ['chess_char_4_23_a', 'chess_char_4_24_a', 'chess_char_3_06_a', 'chess_char_3_13_a'];
const SPEC_KIT = ['chess_char_1_03_a', 'chess_char_1_09_a', 'chess_char_2_01_a', 'chess_char_3_21_a'];
const SERVER_ENV = { SP_COMBAT: 'server', SP_COMBAT_WORKERS: '1', SP_SNAPSHOT_HZ: '10' };
const LOG = process.env.FINISH_E2E_LOG ? (await import('node:fs')).createWriteStream(process.env.FINISH_E2E_LOG) : null;

/** The renderer's end-of-battle state on this page. */
const probe = (c) => c.page.evaluate(() => {
  const s = globalThis.__SP__.store.get();
  const v = globalThis.__SP_VIEW__?.raw;
  const d = v?.debug;
  const f = s.match.field;
  const pf = s.match.public?.fields?.find((x) => x.fieldId === f?.fieldId);
  return { phase: s.match.public?.phase, mode: v?.mode, fieldId: f?.fieldId ?? null, local: !!f?.local, fieldLive: f?.live ?? null, pfLive: pf?.live ?? null,
    done: s.match.battle?.done ?? null, battleField: s.match.battle?.fieldId ?? null,
    requested: !!d?.presentation?.requested, ended: !!d?.presentation?.ended, tail: Math.round((d?.presentation?.tail ?? 0) * 100) / 100,
    renderT: d?.interp?.renderT ?? null, newestT: d?.interp?.newestT ?? null, delay: d?.interp?.delay ?? null, rate: d?.interp?.rate ?? null };
});
const sig = (p) => [p.phase, p.mode, p.fieldId, p.local, p.fieldLive, p.pfLive, p.done, p.requested, p.ended].join('|');

describe('battle end: the renderer leaves the battle clock', { skip: !ENABLED && 'needs SP_E2E=1, Chrome and public/assets' }, () => {
  test('a local replica and a stream reach the presentation tail, before the settlement goes', { timeout: 8 * 60 * 1000 }, async () => {
    const saved = Object.fromEntries(Object.keys(SERVER_ENV).map((k) => [k, process.env[k]]));
    Object.assign(process.env, SERVER_ENV);
    const srv = await startRealServer({ fast: { timerScale: 1, combatSpeed: 2, startRound: 6, autoPlace: true, kits: [HOST_KIT], botChess: SPEC_KIT } });
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    const P = (await import('puppeteer-core')).default;
    let host = null, spec = null;
    try {
      host = new Client(P, srv.base, 'host', { prefix: 'finish-host', w: 1280, h: 720 });
      spec = new Client(P, srv.base, 'spec', { prefix: 'finish-spec', w: 1280, h: 720 });
      await host.open();
      await host.enter('凯尔希');
      await host.createCoop('标准模拟');
      const room = (await host.waitFor((s) => !!s.room?.code, 'room created')).room;
      for (let i = 0; i < 3; i++) { await host.click('button', '添加 AI 队友'); await sleep(600); }
      await spec.open();
      await spec.enter('观战者');
      await spec.click('.hub-tile', '密钥加入');
      await spec.click('.hub-dialog .join-row input');
      await spec.page.keyboard.type(room.code);
      await spec.click('.hub-dialog .join-spectate', '观战');
      await spec.page.waitForSelector('.room-screen .specbar__who.is-me', { timeout: 15000 });
      await host.roomStart({ timeout: 20000 });
      await host.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 30000);
      await host.settled('.brief-go');
      await host.click('.brief__foot .btn--primary', '准备就绪');
      await host.waitFor((s) => s.phase !== 'INFO_CHECK', 'band draft', 40000);
      const t0 = Date.now();
      while (Date.now() - t0 < 120000) {
        const s = await host.st();
        if (s.phase !== 'BAND_DRAFT') break;
        if (s.draft?.turn === s.me) { await host.click('.dband:not(.is-taken)', null, { nth: 2 }); await host.click('.draft-detail__btns .btn--primary', '确认选择'); }
        await sleep(250);
      }
      await host.waitFor((s) => s.phase === 'PREP' && !s.ready, 'prep', 90000);
      const startRound = (await host.st()).round;
      await host.click('.readybtn');
      await host.waitFor((s) => s.phase === 'COMBAT', 'battle', 90000);

      const seen = { host: null, spec: null }, ended = { host: false, spec: false }, sawLocal = { host: false, spec: false };
      const T = Date.now();
      while (Date.now() - T < 180000) {
        const stop = await host.st();
        for (const [who, c] of [['host', host], ['spec', spec]]) {
          const p = await probe(c);
          if (p.local) sawLocal[who] = true;
          if (p.ended) ended[who] = true;
          const k = sig(p);
          if (k !== seen[who]) { seen[who] = k; LOG?.write(`${Date.now() - T} ${who} ${JSON.stringify(p)}\n`); }
        }
        if (stop.phase === 'PREP' && stop.round > startRound) break;
        if (stop.result) break;
        await sleep(120);
      }
      LOG?.write(`final ${JSON.stringify({ ended, sawLocal })}\n`);
      assert.equal(sawLocal.host, true, 'the seat ran a local replica');
      assert.equal(sawLocal.spec, false, 'the spectator seat is streamed');
      assert.equal(ended.host, true, 'the local replica reached the tail');
      assert.equal(ended.spec, true, 'the stream reached the tail');
      assert.deepEqual(problemsOf([host, spec]), []);
    } finally {
      for (const c of [host, spec]) await c?.close();
      await srv.stop();
    }
  });
});
