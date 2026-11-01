// Real-server browser E2E in the production combat configuration (SP_COMBAT=server, a combat Worker, 10 Hz snapshots) —
// 战斗 2 倍速 (server/match/match/speedVote.js): two humans press the top bar's switch in prep, both see the count, the next
// battle runs at twice the normal speed: 4 game seconds per real second on the local replicas (no divergence), on a
// spectator's stream, on the countdown and in the renderer's animation clock; withdrawing during the battle changes
// nothing until the next one. The Final Assault's shared pool at the same speed is the second test.
//
//   SP_E2E=1 CHROME_PATH=… node --test test/ui/speed-vote.e2e.test.js
//
// Screenshots: test/e2e/out/speed-vote-*.png.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client, ROOT, sleep, hasChrome, startRealServer, problemsOf } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome() && existsSync(path.join(ROOT, 'public/assets'));
const HOST_KIT = ['chess_char_4_23_a', 'chess_char_4_24_a', 'chess_char_3_06_a', 'chess_char_3_13_a'];
const GUEST_KIT = ['chess_char_1_03_a', 'chess_char_1_09_a', 'chess_char_2_01_a', 'chess_char_3_21_a'];
const BOT_KIT = ['chess_char_4_01_a', 'chess_char_4_02_a', 'chess_char_3_01_a', 'chess_char_2_06_a'];
const SERVER_ENV = { SP_COMBAT: 'server', SP_COMBAT_WORKERS: '1', SP_SNAPSHOT_HZ: '10' };
const LOG = process.env.SPEED_E2E_LOG ? (await import('node:fs')).createWriteStream(process.env.SPEED_E2E_LOG) : null;
const note = (k, v) => LOG?.write(`${k} ${JSON.stringify(v)}\n`);

async function serverRun(fast) {
  const saved = Object.fromEntries(Object.keys(SERVER_ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, SERVER_ENV);
  try { return await startRealServer({ fast }); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** What this page knows of the battle speed. */
const probe = (c) => c.page.evaluate(() => {
  const s = globalThis.__SP__.store.get();
  const pub = s.match.public;
  const f = s.match.field;
  const view = globalThis.__SP_VIEW__?.raw?.stats?.();
  const el = document.querySelector('[data-testid="speed-vote"]');
  return {
    at: performance.now(), phase: pub?.phase, round: pub?.round, vote: pub?.speedVote ?? null, remain: pub?.deadline ? pub.deadline - pub.serverNow : 0,
    field: f ? { id: f.fieldId, local: !!f.local, speed: f.speed ?? null, live: f.live !== false } : null,
    entries: [...(globalThis.__SP_RUNNER__?._entries?.values() || [])].filter((e) => e.fieldId === f?.fieldId).map((e) => ({ speed: e.speed, replica: !!e.replica,
      dropped: !!e.dropped, tick: e.battle?.tickCount ?? null, synced: e.synced, finished: !!e.battle?.finished })),
    rate: view?.rate ?? null, renderT: view?.renderT ?? null,
    button: el ? { status: el.dataset.status, text: el.textContent.trim(), pressed: el.getAttribute('aria-pressed'), disabled: el.disabled, cls: el.className } : null,
  };
});

async function coop(P, base, prefix, { spectator = false } = {}) {
  const host = new Client(P, base, 'host', { prefix: `${prefix}-host`, w: 1280, h: 720 });
  const guest = new Client(P, base, 'guest', { prefix: `${prefix}-guest`, w: 1280, h: 720 });
  const spec = spectator ? new Client(P, base, 'spec', { prefix: `${prefix}-spec`, w: 1280, h: 720 }) : null;
  await host.open();
  await host.enter('凯尔希');
  await host.createCoop('标准模拟');
  const room = (await host.waitFor((s) => !!s.room?.code, 'room created')).room;
  for (let i = 0; i < 2; i++) { await host.click('button', '添加 AI 队友'); await sleep(600); }
  await guest.open(`?room=${room.code}`);
  await guest.enter('阿米娅');
  await guest.waitFor((s) => s.room?.code === room.code, 'guest joined');
  if (spec) {
    await spec.open();
    await spec.enter('观战者');
    await spec.click('.hub-tile', '密钥加入');
    await spec.click('.hub-dialog .join-row input');
    await spec.page.keyboard.type(room.code);
    await spec.click('.hub-dialog .join-spectate', '观战');
    await spec.page.waitForSelector('.room-screen .specbar__who.is-me', { timeout: 15000 });
  }
  for (let i = 0; i < 6; i++) { await guest.roomReady({ optional: true, timeout: 3000 }); await sleep(500); }
  await host.roomStart({ timeout: 20000 });
  for (const c of [host, guest]) await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 30000);
  for (const c of [host, guest]) { await c.settled('.brief-go'); await c.click('.brief__foot .btn--primary', '准备就绪'); }
  for (const c of [host, guest]) await c.waitFor((s) => s.phase !== 'INFO_CHECK', 'band draft', 40000);
  const picked = new Set();
  const t0 = Date.now();
  while (picked.size < 2 && Date.now() - t0 < 120000) {
    for (const c of [host, guest]) {
      const s = await c.st();
      if (s.phase !== 'BAND_DRAFT') { picked.add(c.label); continue; }
      if (picked.has(c.label) || s.draft?.turn !== s.me) continue;
      await c.click('.dband:not(.is-taken)', null, { nth: c === host ? 2 : 5 });
      await c.click('.draft-detail__btns .btn--primary', '确认选择');
      picked.add(c.label);
    }
    await sleep(250);
  }
  return { host, guest, spec };
}

/** Both humans agree in prep through the real switch; both see the count move. */
async function voteUp(host, guest) {
  for (const c of [host, guest]) await c.page.waitForSelector('[data-testid="speed-vote"]', { timeout: 30000 });
  await host.shot('0-idle');
  const idle = await probe(guest);
  note('idle', idle);
  assert.equal(idle.button.status, 'idle');
  assert.match(idle.button.text, /0\/2/);
  await host.click('[data-testid="speed-vote"]');
  await guest.page.waitForFunction(() => /1\/2/.test(document.querySelector('[data-testid="speed-vote"]')?.textContent || ''), { timeout: 5000 });
  await guest.shot('1-called');
  await host.shot('1-mine');
  const called = await probe(guest);
  note('called', called);
  assert.equal(called.button.pressed, 'false');
  assert.match(called.button.cls, /is-called/);
  await guest.click('[data-testid="speed-vote"]');
  for (const c of [host, guest]) await c.page.waitForFunction(() => document.querySelector('[data-testid="speed-vote"]')?.dataset.status === 'next', { timeout: 5000 });
  await host.shot('2-next');
  const next = await probe(host);
  note('next', next);
  assert.match(next.button.text, /下一场起 2 倍速/);
  assert.equal(next.vote.next, true);
  assert.equal(next.vote.on, false);
}

describe('战斗 2 倍速 (server-run combat, real server + Worker)', { skip: !ENABLED && 'set SP_E2E=1 (Chrome + public/assets)' }, () => {
  test('a normal battle: the vote, the replicas, the stream, the countdown; withdrawing waits for the next battle', { timeout: 8 * 60 * 1000 }, async () => {
    const srv = await serverRun({ timerScale: 1, combatSpeed: 2, startRound: 6, autoPlace: true, kits: [HOST_KIT, GUEST_KIT], botChess: BOT_KIT });
    const P = (await import('puppeteer-core')).default;
    let host = null, guest = null, spec = null;
    try {
      ({ host, guest, spec } = await coop(P, srv.base, 'speed-vote', { spectator: true }));
      await host.waitFor((s) => s.phase === 'PREP' && !s.ready, 'prep', 90000);
      const startRound = (await host.st()).round;
      await voteUp(host, guest);
      assert.equal(await spec.page.evaluate(() => !!document.querySelector('[data-testid="speed-vote"]')), false, 'a spectator seat has no vote');

      await host.click('.readybtn');
      await guest.click('.readybtn');
      for (const c of [host, guest, spec]) await c.waitFor((s) => s.phase === 'COMBAT', 'battle', 90000);
      for (const c of [host, guest]) await c.page.waitForFunction(() => [...(globalThis.__SP_RUNNER__?._entries?.values() || [])].some((e) => e.battle && e.replica && e.own), { timeout: 30000 });
      const a = await probe(host), s0 = await probe(spec);
      note('battle+0', a); note('spec+0', s0);
      await sleep(2000);
      const b = await probe(host), g = await probe(guest), s1 = await probe(spec);
      note('battle+2', b); note('guest+2', g); note('spec+2', s1);
      await host.shot('3-battle');
      await spec.shot('3-spectator');
      await guest.page.setViewport({ width: 844, height: 390, deviceScaleFactor: 1 });
      await sleep(400);
      await guest.page.screenshot({ path: path.join(ROOT, 'test/e2e/out/speed-vote-guest-3-phone.png') });
      await guest.page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });

      assert.equal(b.vote.on, true);
      assert.equal(b.vote.speed, 4);
      for (const [who, p] of [['host', b], ['guest', g]]) {
        assert.deepEqual([p.field.local, p.field.speed], [true, 4], `${who}: ${JSON.stringify(p.field)}`);
        assert.equal(p.entries.length, 1, who);
        assert.deepEqual([p.entries[0].replica, p.entries[0].dropped, p.entries[0].speed], [true, false, 4], `${who}: ${JSON.stringify(p.entries)}`);
        assert.match(p.button.text, /本场 2 倍速/, who);
        assert.equal(p.button.status, 'on', who);
      }
      // ticks are 1/30 game s: 120 ticks per real second on the local replica
      const ticks = (b.entries[0].tick - a.entries[0].tick) / ((b.at - a.at) / 1000);
      note('ticksPerSec', ticks);
      assert.ok(ticks > 100 && ticks < 140, `the replica runs at 120 ticks/s: ${ticks}`);
      // the renderer's clock, which paces every animation and effect, follows
      assert.ok(b.rate > 3.4 && b.rate < 4.6, `renderer rate ${b.rate}`);
      assert.deepEqual([s1.field.local], [false], 'a spectator seat is streamed');
      const specRate = (s1.renderT - s0.renderT) / ((s1.at - s0.at) / 1000);
      note('specRate', { rate: s1.rate, measured: specRate });
      assert.ok(s1.rate > 3 && s1.rate < 5, `stream rate ${s1.rate}`);
      assert.ok(specRate > 3 && specRate < 5, `stream clock ${specRate}`);
      assert.equal(s1.button?.status, 'on', 'a spectator sees that the battle is sped up');
      assert.equal(s1.button?.disabled, true);

      const limit = await host.page.evaluate(() => {
        const s = globalThis.__SP__.store.get(); const pub = s.match.public;
        return globalThis.__SP__.data.get('config').modes[pub.modeId].rounds[pub.round].combatTimeLimit;
      });
      note('limit', { limit, remainAtStart: a.remain });
      assert.ok(a.remain <= (limit / 2) * 1000 + 200, `the countdown is half the nominal ${limit} s: ${a.remain} ms`);
      assert.ok(a.remain > (limit / 2) * 1000 - 8000, `…not less: ${a.remain} ms`);

      // withdrawing: this battle stays at it
      await host.click('[data-testid="speed-vote"]');
      await host.page.waitForFunction(() => document.querySelector('[data-testid="speed-vote"]')?.dataset.status === 'ending', { timeout: 5000 });
      await host.shot('4-ending');
      const ending = await probe(host);
      note('ending', ending);
      assert.equal(ending.vote.speed, 4);

      const synced = await probe(host);
      note('synced', synced.entries);
      await host.waitFor((s) => s.phase === 'PREP' && s.round > startRound, 'the next prep', 120000);
      const prep = await probe(host);
      note('next-prep', prep);
      assert.equal(prep.button.status, 'idle');
      assert.ok((synced.entries[0]?.synced ?? 0) >= 1 || synced.entries[0]?.finished, 'Worker digests compared and equal');
      await host.click('.readybtn');
      await guest.click('.readybtn');
      for (const c of [host, guest]) await c.waitFor((s) => s.phase === 'COMBAT' || s.result, 'the next battle', 90000);
      const c2 = await probe(host);
      note('battle2', c2);
      assert.equal(c2.vote.speed, 2);
      assert.equal(c2.vote.on, false);
      assert.deepEqual(problemsOf([host, guest, spec]), []);
    } finally {
      for (const c of [host, guest, spec]) await c?.close();
      await srv.stop();
    }
  });

  test('the Final Assault: the replicas on the Worker\'s pool record at 4 game s per real s, the 60 s countdown', { timeout: 8 * 60 * 1000 }, async () => {
    const srv = await serverRun({ timerScale: 1, combatSpeed: 2, startRound: 'boss', autoPlace: true, kits: [HOST_KIT, GUEST_KIT], botChess: BOT_KIT });
    const P = (await import('puppeteer-core')).default;
    let host = null, guest = null;
    try {
      ({ host, guest } = await coop(P, srv.base, 'speed-vote-boss'));
      await host.waitFor((s) => s.phase === 'PREP' && !s.ready, 'boss-round prep', 90000);
      await voteUp(host, guest);
      await host.click('.readybtn');
      await guest.click('.readybtn');
      for (const c of [host, guest]) await c.waitFor((s) => s.phase === 'FINAL_ASSAULT', 'Final Assault', 90000);
      try {
        for (const c of [host, guest]) await c.page.waitForFunction(() => [...(globalThis.__SP_RUNNER__?._entries?.values() || [])].some((e) => e.kind === 'boss' && e.replay && e.battle), { timeout: 30000 });
      } catch (e) {
        note('boss-no-replica', { host: await probe(host), guest: await probe(guest), logs: srv.logs.filter((l) => /replica|stream/.test(l)).slice(-10) });
        throw e;
      }
      const a = await probe(host);
      await sleep(8000);
      const b = await probe(host), g = await probe(guest);
      note('boss+0', a); note('boss+8', b); note('boss-guest', g);
      await host.shot('5-boss');
      assert.equal(b.vote.speed, 4);
      for (const [who, p] of [['host', b], ['guest', g]]) {
        assert.equal(p.field.local, true, who);
        assert.deepEqual([p.entries[0].replica, p.entries[0].dropped, p.entries[0].speed], [true, false, 4], `${who}: ${JSON.stringify(p.entries)}`);
        assert.ok(p.entries[0].finished || p.entries[0].synced >= 3, `${who}: Worker digests compared and equal (${p.entries[0].synced})`);
      }
      assert.ok(a.remain <= 60_500 && a.remain > 40_000, `the level countdown: ${a.remain} ms`);
      assert.deepEqual(problemsOf([host, guest]), []);
    } finally {
      for (const c of [host, guest]) await c?.close();
      await srv.stop();
    }
  });
});
