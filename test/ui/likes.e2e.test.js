// Real-server browser E2E of 点赞 on the settlement's 同盟 page (the owner's request of 2026-11-05; ui/likes.js,
// screens/settle.js TeamPage, server/lobby.js like): two players with an AI teammate and a spectator play one round
// (SP_FINISH_AFTER=1) to the settlement. On the 同盟 page each player has a like button on the other player's card only
// — none on its own nor on the AI's; the spectator none. A presses it: B gets the toast 「A 赞了你」, every page shows
// B's card with 1, A's button stays pressed; B likes back. No console error. Screenshots: test/e2e/out/like-*.png
// (LIKE_SHOTS=<dir> copies them there).
//
//   SP_E2E=1 CHROME_PATH=… node --test test/ui/likes.e2e.test.js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Client, OUT, ROOT, sleep, hasChrome, startRealServer, problemsOf } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome() && existsSync(path.join(ROOT, 'public/assets'));
const A = '凯尔希', B = '阿米娅';

/** The 同盟 cards of one page: name, the like chip (`can` / `done` / `count` / none) and its number. */
const cards = (c) => c.page.evaluate(() => [...document.querySelectorAll('.steam .tcard')].map((el) => {
  const chip = el.querySelector('.tchip--like');
  return { name: (el.querySelector('.tcard__name')?.textContent || '').trim(), bot: !!el.querySelector('.tcard__ai'),
    like: chip?.dataset.like ?? null, n: Number(chip?.querySelector('.tchip__n')?.textContent || 0) };
}));
const card = (list, name) => list.find((x) => x.name.includes(name) && !x.bot);

describe('点赞 on the settlement: two players, an AI teammate and a spectator', { skip: !ENABLED && 'needs SP_E2E=1, Chrome and public/assets' }, () => {
  test('one like each way; buttons on the other player only; everybody sees the counts', { timeout: 8 * 60 * 1000 }, async () => {
    const srv = await startRealServer({ fast: { timerScale: 0.25, combatSpeed: 8, finishAfter: 1, autoPlace: true } });
    const P = (await import('puppeteer-core')).default;
    const a = new Client(P, srv.base, 'a', { prefix: 'like-a', w: 1600, h: 900 });
    const b = new Client(P, srv.base, 'b', { prefix: 'like-b', w: 1600, h: 900 });
    const spec = new Client(P, srv.base, 'spec', { prefix: 'like-spec', w: 1600, h: 900 });
    const all = [a, b, spec];
    const req = (c, type, body) => c.page.evaluate(async (type, body) => (await import('/js/net.js')).net.request(type, body), type, body);
    try {
      await a.open();
      await a.enter(A);
      const room = await a.createCoop();
      await a.click('button', '添加 AI 队友');
      await b.open();
      await b.enter(B);
      await req(b, 'room.join', { code: room.code });
      await spec.open();
      await spec.enter('观战者');
      await req(spec, 'room.spectate', { code: room.code });
      for (const c of all) await c.page.waitForFunction(() => document.querySelectorAll('.rseat').length >= 3, { timeout: 20000 });
      await req(b, 'room.ready', { ready: true });
      await a.roomStart({ timeout: 20000 });
      for (const c of [a, b]) await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 40000);
      for (const c of [a, b]) {
        await c.page.waitForFunction(() => {
          const btn = [...document.querySelectorAll('.brief__foot .btn--primary')].find((x) => x.textContent.includes('准备就绪'));
          const r = btn?.getBoundingClientRect();
          return !!r && btn.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
        }, { timeout: 20000 });
        await c.click('.brief__foot .btn--primary', '准备就绪');
      }
      const t0 = Date.now();
      while (Date.now() - t0 < 120000) {
        const s = await a.st();
        if (s.phase === 'PREP') break;
        for (const c of [a, b]) {
          const cs = await c.st();
          if (cs.phase === 'BAND_DRAFT' && cs.draft?.turn === cs.me) {
            await c.click('.dband:not(.is-taken)', null, { nth: 1, optional: true });
            await c.click('.draft-detail__btns .btn--primary', '确认选择', { optional: true });
          }
        }
        await sleep(300);
      }
      await a.waitFor((s) => s.phase === 'PREP' || s.result, 'prep', 60000);
      for (const c of [a, b]) await c.click('.readybtn', null, { optional: true });
      for (const c of [a, b]) await c.waitFor((s) => s.result, 'the result', 180000);

      // the settlement: 个人战报 → 下一步 → 同盟 (the spectator opens on it)
      for (const c of [a, b]) {
        await c.page.waitForSelector('.settle__next', { visible: true, timeout: 30000 });
        await c.settled('.settle__next');
        await c.click('.settle__next', '下一步');
      }
      for (const c of all) {
        await c.page.waitForSelector('.settle--team .steam__detail', { visible: true, timeout: 30000 });
        await c.settled('.steam__detail');
      }
      await sleep(900);
      for (const [c, me, other] of [[a, A, B], [b, B, A]]) {
        const list = await cards(c);
        assert.ok(list.length >= 3, `${c.label}: the team cards`);
        assert.equal(card(list, other).like, 'can', `${c.label}: a like button on ${other}'s card`);
        assert.equal(card(list, me).like, null, `${c.label}: none on its own card (no likes yet)`);
        assert.ok(list.filter((x) => x.bot).every((x) => x.like === null), `${c.label}: none on the AI card`);
      }
      assert.ok((await cards(spec)).every((x) => x.like === null), 'the spectator: no button, no count yet');
      await a.shot('team-before');

      // A likes B
      await a.click('.tcard button.tchip--like');
      await b.page.waitForFunction((name) => [...document.querySelectorAll('.toast')].some((x) => x.textContent.includes(`${name} 赞了你`)), { timeout: 10000 }, A);
      for (const c of all) {
        await c.page.waitForFunction((name) => [...document.querySelectorAll('.steam .tcard')].some((el) =>
          (el.querySelector('.tcard__name')?.textContent || '').includes(name) && el.querySelector('.tchip--like .tchip__n')?.textContent === '1'), { timeout: 10000 }, B);
      }
      await sleep(500);
      const afterA = await cards(a);
      assert.deepEqual([card(afterA, B).like, card(afterA, B).n], ['done', 1], 'A: pressed, 1');
      const afterB = await cards(b);
      assert.deepEqual([card(afterB, B).like, card(afterB, B).n], ['count', 1], 'B: its own card counts 1');
      assert.equal(card(afterB, A).like, 'can', 'B can still like A');
      const afterSpec = await cards(spec);
      assert.deepEqual([card(afterSpec, B).like, card(afterSpec, B).n], ['count', 1], 'the spectator sees the count');
      await a.shot('team-after');
      await b.shot('team-liked');
      await spec.shot('team-spectator');
      // the server says no to a second one
      const bId = await b.page.evaluate(() => globalThis.__SP__.store.get().me.playerId);
      const again = await a.page.evaluate(async (id) => (await import('/js/net.js')).net.request('room.like', { playerId: id }).then(() => 'ok', (e) => e?.code ?? String(e)), bId);
      assert.equal(again, 'ALREADY');

      // B likes back
      await b.click('.tcard button.tchip--like');
      await a.page.waitForFunction((name) => [...document.querySelectorAll('.toast')].some((x) => x.textContent.includes(`${name} 赞了你`)), { timeout: 10000 }, B);
      await sleep(500);
      const both = await cards(spec);
      assert.deepEqual([card(both, A).n, card(both, B).n], [1, 1]);
      await a.shot('team-liked-back');
      await b.shot('team-both');
      assert.deepEqual(problemsOf(all), []);
    } finally {
      const dest = process.env.LIKE_SHOTS;
      if (dest) {
        mkdirSync(dest, { recursive: true });
        for (const c of all) for (const f of c.shots) { try { copyFileSync(path.join(OUT, f), path.join(dest, f)); } catch { /* not taken */ } }
      }
      for (const c of all) await c.close();
      await srv.stop();
    }
  });
});
