// Real-server browser E2E of the 服主 mark (rel32, the owner's request of 2026-11-04 「服主特效做进对局内也显示，并且更显眼高级
// 一点」; ui/ownerName.js): a server with an owner file (SP_OWNER_FILE), the owner's browser keeping the key (sp.ownerKey),
// a teammate's browser and a spectator's. Asserted on all three pages: the room seat (the gold header strip with OWNER,
// the gold name and tag), and in the match the roster row (the gold avatar line, the gold name), the battle and the result
// screen — always on the owner's seat only, never on the teammate's nor an AI seat. No console error. Screenshots go to
// test/e2e/out/owner-*.png (OWNER_SHOTS=<dir> copies them there).
//
//   SP_E2E=1 CHROME_PATH=… node --test test/ui/owner-mark.e2e.test.js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync, copyFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, OUT, ROOT, sleep, hasChrome, startRealServer, problemsOf } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome() && existsSync(path.join(ROOT, 'public/assets'));
const KEY = 'e2e-owner-key-0123456789abcdef';
const OWNER = 'Stardust';

/** What one page shows of the mark: the room seats, the roster rows, the result cards. */
const marks = (c) => c.page.evaluate(() => {
  const text = (el) => (el?.textContent || '').trim();
  const seats = [...document.querySelectorAll('.rseat')].map((el) => ({
    name: text(el.querySelector('.rseat__name')), owner: el.classList.contains('is-owner'), tag: !!el.querySelector('.rseat__strip [data-owner-tag]'),
    gold: !!el.querySelector('.rseat__name.sp-owner-name'), badge: !!el.querySelector('[data-owner-badge]'), bot: el.classList.contains('is-bot'),
  }));
  const rows = [...document.querySelectorAll('.team__row')].map((el) => ({
    name: text(el.querySelector('.team__name')), fx: !!el.querySelector('[data-owner-fx]'), gold: !!el.querySelector('.team__name.sp-owner-name'),
    bot: !!el.querySelector('.team__ai'),
  }));
  const cards = [...document.querySelectorAll('.tcard, .rcard')].map((el) => ({
    name: text(el.querySelector('[data-owner]') || el.querySelector('.tcard__name, .rcard__name')), fx: !!el.querySelector('[data-owner-fx]'), gold: !!el.querySelector('.sp-owner-name'),
  }));
  return { seats, rows, cards, me: globalThis.__SP__.store.get().me.owner === true };
});
const onlyOwner = (list, key) => list.filter((x) => x[key]).map((x) => x.name);

describe('the 服主 mark: room, roster, battle, result — for the owner, a teammate and a spectator', { skip: !ENABLED && 'needs SP_E2E=1, Chrome and public/assets' }, () => {
  test('server-verified, on the owner\'s seat only, in the room and through the match', { timeout: 8 * 60 * 1000 }, async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sp-owner-e2e-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const ownerFile = path.join(dir, 'owner.json');
    writeFileSync(ownerFile, JSON.stringify({ names: [OWNER], keySha256: createHash('sha256').update(KEY).digest('hex') }));
    const srv = await startRealServer({ fast: { timerScale: 0.25, combatSpeed: 8, finishAfter: 1, autoPlace: true }, env: { SP_OWNER_FILE: ownerFile } });
    const P = (await import('puppeteer-core')).default;
    const owner = new Client(P, srv.base, 'owner', { prefix: 'owner-owner', w: 1600, h: 900 });
    const mate = new Client(P, srv.base, 'mate', { prefix: 'owner-mate', w: 1600, h: 900 });
    const spec = new Client(P, srv.base, 'spec', { prefix: 'owner-spec', w: 1600, h: 900 });
    const all = [owner, mate, spec];
    const req = (c, type, body) => c.page.evaluate(async (type, body) => (await import('/js/net.js')).net.request(type, body), type, body);
    try {
      await owner.open();
      await owner.page.evaluate((k) => localStorage.setItem('sp.ownerKey', k), KEY);
      await owner.page.reload({ waitUntil: 'domcontentloaded' });
      await owner.page.waitForFunction(() => !!globalThis.__SP__ && !!document.querySelector('.screen'), { timeout: 30000 });
      await owner.enter(OWNER);
      await owner.page.waitForFunction(() => globalThis.__SP__.store.get().me.owner === true, { timeout: 15000 });
      const room = await owner.createCoop();
      await owner.click('button', '添加 AI 队友');
      await mate.open();
      await mate.enter('阿米娅');
      await req(mate, 'room.join', { code: room.code });
      await spec.open();
      await spec.enter('观战者');
      await req(spec, 'room.spectate', { code: room.code });
      for (const c of all) await c.page.waitForFunction(() => document.querySelectorAll('.rseat').length >= 3 && !!document.querySelector('.rseat.is-owner'), { timeout: 20000 });
      await sleep(900);
      for (const c of all) {
        const m = await marks(c);
        assert.deepEqual(onlyOwner(m.seats, 'owner'), [OWNER], `${c.label}: the owner's room seat only`);
        const seat = m.seats.find((s) => s.owner);
        assert.ok(seat.tag && seat.gold && seat.badge, `${c.label}: the OWNER strip tag, gold name, badge`);
        assert.ok(m.seats.some((s) => s.bot && !s.owner), `${c.label}: the AI seat is not marked`);
        assert.equal(m.me, c === owner, `${c.label}: welcome.owner only for the key`);
      }
      await owner.shot('room');
      await mate.shot('room');
      await spec.shot('room');

      // the match: both players through the briefing and the band draft
      await req(mate, 'room.ready', { ready: true });
      await owner.roomStart({ timeout: 20000 });
      for (const c of [owner, mate]) await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 40000);
      for (const c of [owner, mate]) {
        await c.page.waitForFunction(() => {
          const b = [...document.querySelectorAll('.brief__foot .btn--primary')].find((x) => x.textContent.includes('准备就绪'));
          const r = b?.getBoundingClientRect();
          return !!r && b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
        }, { timeout: 20000 });
        await c.click('.brief__foot .btn--primary', '准备就绪');
      }
      const t0 = Date.now();
      while (Date.now() - t0 < 120000) {
        const s = await owner.st();
        if (s.phase === 'PREP') break;
        for (const c of [owner, mate]) {
          const cs = await c.st();
          if (cs.phase === 'BAND_DRAFT' && cs.draft?.turn === cs.me) {
            await c.click('.dband:not(.is-taken)', null, { nth: 1, optional: true });
            await c.click('.draft-detail__btns .btn--primary', '确认选择', { optional: true });
          }
        }
        await sleep(300);
      }
      for (const c of all) await c.page.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'PREP' && document.querySelectorAll('.team__row').length >= 3, { timeout: 60000 });
      await sleep(1500);
      for (const c of all) {
        const m = await marks(c);
        assert.deepEqual(onlyOwner(m.rows, 'fx'), [OWNER], `${c.label}: the owner's roster row has the gold avatar line`);
        assert.deepEqual(onlyOwner(m.rows, 'gold'), [OWNER], `${c.label}: the gold name`);
        assert.ok(m.rows.some((r) => r.bot && !r.fx), `${c.label}: the AI row is not marked`);
      }
      await owner.shot('prep');
      await mate.shot('prep');
      await spec.shot('prep-spectator');

      // the battle
      for (const c of [owner, mate]) await c.click('.readybtn', null, { optional: true });
      await owner.waitFor((s) => s.phase === 'COMBAT' || s.result, 'battle', 90000);
      await sleep(2500);
      for (const c of [mate, spec]) {
        const m = await marks(c);
        if (m.rows.length) assert.deepEqual(onlyOwner(m.rows, 'fx'), [OWNER], `${c.label}: the roster in the battle`);
      }
      await mate.shot('battle');
      await spec.shot('battle-spectator');

      // the result (SP_FINISH_AFTER=1: the match ends once round 1 has settled): screens/settle.js — radar intro →
      // 个人战报 → 下一步 → 同盟 (the team cards) → 数据详情 (ResultView, one .rcard a seat)
      for (const c of [owner, mate]) await c.waitFor((s) => s.result, 'the result', 180000);
      for (const c of [owner, mate]) {
        await c.page.waitForSelector('.settle__next', { visible: true, timeout: 30000 });
        await c.settled('.settle__next');
        await c.click('.settle__next', '下一步');
        await c.page.waitForSelector('.settle--team .steam__detail', { visible: true, timeout: 15000 });
        await c.settled('.steam__detail');
        await sleep(800);
        const team = await marks(c);
        assert.ok(team.cards.length >= 3, `${c.label}: the team cards`);
        assert.deepEqual(onlyOwner(team.cards, 'gold'), [OWNER], `${c.label}: the owner's team card only`);
        assert.deepEqual(onlyOwner(team.cards, 'fx'), [OWNER], `${c.label}: the gold avatar line on the owner's team card`);
        await c.shot('result-team');
        await c.click('.steam__detail', '数据详情');
        await c.page.waitForSelector('.settle__detail .rcard', { visible: true, timeout: 15000 });
        await sleep(800);
        const detail = await c.page.evaluate(() => [...document.querySelectorAll('.settle__detail .rcard')].map((el) => ({
          name: (el.querySelector('.rcard__name .sp-owner-name, .rcard__name')?.textContent || '').trim(), gold: !!el.querySelector('.rcard__name .sp-owner-name'),
          edge: el.classList.contains('is-sp-owner') })));
        assert.ok(detail.length >= 3, `${c.label}: the report cards`);
        assert.equal(detail.filter((d) => d.gold).length, 1, `${c.label}: one gold name in the report`);
        assert.equal(detail.filter((d) => d.edge).length, 1, `${c.label}: one gold-edged report card`);
        assert.match(detail.find((d) => d.gold).name, new RegExp(OWNER));
        await c.shot('result-detail');
      }
      assert.deepEqual(problemsOf(all), []);
    } finally {
      const dest = process.env.OWNER_SHOTS;
      if (dest) {
        mkdirSync(dest, { recursive: true });
        for (const c of all) for (const f of c.shots) { try { copyFileSync(path.join(OUT, f), path.join(dest, f)); } catch { /* not taken */ } }
      }
      for (const c of all) await c.close();
      await srv.stop();
    }
  });
});
