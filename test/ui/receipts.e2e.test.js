// Real-server browser E2E of the match receipts and the identity cookie (docs/history/0.4.0.md §37.276): a page load sets
// the cookie (HttpOnly, 400 days) and the next one refreshes it with the same identity; a solo match played to its
// settlement brings the page its receipt, stored on the record; the history marks verified records 「已核验」; the export
// warns that the file carries the identity; a fresh profile imports the file, is asked, switches to its identity and
// then counts the file's receipts for ELO (before switching: none); a 规程 room shows the trophies the server counted from
// receipts to a teammate (never the page's own number); 设置 › 其他 says what the cookie is. Throwaway key files.
//
//   SP_E2E=1 node --test test/ui/receipts.e2e.test.js
//
// Screenshots: test/e2e/out/rc-*.png (SP_RC_SHOTS=<dir>: there instead, animations off; SP_RC_FONT=<dir of the
// noto-sans-sc woff2 files>: that face for the Chinese text on a host without a CJK font).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client, ROOT, sleep, hasChrome, startRealServer } from '../e2e/client.mjs';
import { parseKeyring } from '../../server/identity.js';
import { createReceipts } from '../../server/resultReceipts.js';
import { parseIdToken, parseReceipt } from '../../shared/receipts.js';

const ENABLED = process.env.SP_E2E === '1' && hasChrome() && existsSync(path.join(ROOT, 'public/assets'));
const SHOTS = process.env.SP_RC_SHOTS || null;
const NO_ANIM = '*,*::before,*::after{animation:none!important;transition:none!important}';
const FONT = process.env.SP_RC_FONT || null;
const fontCss = FONT ? [400, 500, 700].map((w) => {
  const b64 = readFileSync(path.join(FONT, `noto-sans-sc-chinese-simplified-${w}-normal.woff2`)).toString('base64');
  return `@font-face{font-family:'Noto Sans SC';font-style:normal;font-weight:${w};font-display:block;src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
}).join('\n') : '';
/** Client.open, then (SP_RC_FONT) the face in every document — the page's font-src refuses a data: face: bypassed here. */
async function open(c) {
  await c.open();
  if (!fontCss) return;
  await c.page.setBypassCSP(true);
  await c.page.evaluateOnNewDocument((css) => {
    const add = () => { const st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st); };
    if (document.documentElement) add(); else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); add(); } }).observe(document, { childList: true });
  }, fontCss);
  await c.page.reload({ waitUntil: 'domcontentloaded' });
  await c.page.waitForFunction(() => !!globalThis.__SP__ && !!document.querySelector('.screen'), { timeout: 30000 });
}
const V3 = 'act3autochess@V3_1';
const DAY = 86400000;

async function shot(c, name) {
  await c.page.mouse.move(2, 2);
  if (fontCss) await c.page.evaluate(() => document.fonts.load("16px 'Noto Sans SC'", '凭证')).catch(() => {});
  if (!SHOTS) return c.shot(name);
  await c.page.addStyleTag({ content: NO_ANIM });
  await sleep(300);
  await c.page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  return name;
}
const cookie = async (c) => (await c.page.cookies()).find((x) => x.name === 'sp_id') || null;
const sub = (k) => parseIdToken(k?.value)?.sub ?? null;
const idSub = (c) => c.page.evaluate(async () => (await import('/js/ui/receipts.js')).idStore.get().sub);
const stored = (c) => c.page.evaluate(() => JSON.parse(localStorage.getItem('sp.pref.stats') || '{"records":[]}'));
const mine = (c, mode, difficulty, version = 'act2autochess') => c.page.evaluate(async (m, d, v) => {
  const x = (await import('/js/ui/eloPanel.js')).eloMine(m, d, undefined, undefined, v);
  return { dir: x.dir, source: x.source, verified: x.verified, n: x.n, ownN: x.ownN };
}, mode, difficulty, version);
const req = (c, type, body) => c.page.evaluate(async (t, b) => (await import('/js/net.js')).net.request(t, b), type, body);

/** A settled record of mine with a receipt the server's own key signed (a history the test hands the page). */
function signedRecord(rc, { sub: s, i, mode, diff, ver, won = false, rounds = 12, trophies = 0, withReceipt = true }) {
  const r = rc.issue({ sub: s, rec: `e2e${String(i).padStart(13, '0')}`, mode, diff, ver, w: won, rp: won ? 14 : rounds, tr: trophies, ai: false, mod: false, elo: false });
  return { v: 3, t: Date.now() - (i + 1) * DAY, id: `seed-rc-${i}`, end: 'settled', victory: won, roundsPassed: won ? 14 : rounds,
    modeId: `mode_${mode === 'solo' ? 'single' : 'multi'}_${diff.toLowerCase()}`, difficulty: diff, roomMode: mode, selfId: 'me',
    ...(ver !== 'act2autochess' ? { version: ver } : {}), ...(withReceipt ? { rc: r } : {}),
    players: [{ playerId: 'me', seat: 0, alive: won, victory: won, roundsPassed: won ? 14 : rounds, trophies, stats: {} }] };
}

async function playSolo(c) {
  await c.createSolo('标准模拟');
  await c.waitFor((s) => !!s.room, 'solo room');
  if (!(await c.st()).phase) await c.roomStart({ timeout: 20000 });
  await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 30000);
  await c.page.waitForFunction(() => {
    const b = [...document.querySelectorAll('.brief__foot .btn--primary')].find((x) => x.textContent.includes('准备就绪'));
    const r = b?.getBoundingClientRect();
    return !!r && b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  }, { timeout: 15000 });
  await c.click('.brief__foot .btn--primary', '准备就绪');
  await c.waitFor((s) => s.phase === 'BAND_DRAFT', 'band draft', 30000);
  await c.click('.dband', null, { nth: 1 });
  await c.click('.draft-detail__btns .btn--primary', '确认选择');
  await c.waitFor((s) => s.phase === 'PREP' && s.round === 1, 'prep round 1', 60000);
  await sleep(1000);
  await c.click('.readybtn');
  await c.waitFor((s) => s.result, 'the settlement', 120000);
}
async function toLobby(c) {
  await req(c, 'room.leave', {}).catch(() => {});
  await c.page.reload({ waitUntil: 'domcontentloaded' });
  await c.page.waitForFunction(() => globalThis.__SP__?.store.get().connection.status === 'online' && !globalThis.__SP__.store.get().room
    && !!document.querySelector('.lobby-screen'), { timeout: 30000 });
  await c.dismissBoard();
}
async function openHistory(c) {
  await c.click('.lobby-screen .stats-entry');
  await c.page.waitForSelector('.st .st-tab', { visible: true, timeout: 15000 });
  await c.click('.st-tab[data-tab="history"]');
  await c.page.waitForSelector('.st-table--history', { visible: true, timeout: 15000 });
}
const marks = (c) => c.page.$$eval('[data-testid="rc-verified"]', (l) => l.length);

describe('match receipts and the identity cookie (real server)', { skip: !ENABLED && 'set SP_E2E=1 (Chrome + public/assets)' }, () => {
  test('cookie, receipt, 已核验, export warning, import with a switch, ELO from receipts, 规程 card trophies, the settings line', { timeout: 10 * 60 * 1000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rc-e2e-'));
    const keys = { identity: `g1 ${randomBytes(32).toString('base64')}\n`, receipts: `r1 ${randomBytes(32).toString('base64')}\n` };
    for (const [k, v] of Object.entries(keys)) writeFileSync(path.join(dir, k), v, { mode: 0o600 });
    const rc = createReceipts({ keys: parseKeyring(keys.receipts) });
    const srv = await startRealServer({ fast: { timerScale: 0.25, combatSpeed: 8, finishAfter: 1, autoPlace: true },
      env: { SP_IDENTITY_KEY_FILE: path.join(dir, 'identity'), SP_RESULT_KEY_FILE: path.join(dir, 'receipts') } });
    const P = (await import('puppeteer-core')).default;
    const a = new Client(P, srv.base, 'a', { prefix: 'rc-a', w: 1280, h: 720 });
    const b = new Client(P, srv.base, 'b', { prefix: 'rc-b', w: 1280, h: 720 });
    const d = new Client(P, srv.base, 'd', { prefix: 'rc-d', w: 1280, h: 720 });
    try {
      // 1) the cookie: set by the page, HttpOnly, 400 days; refreshed by the next load with the same identity
      await open(a);
      const c1 = await cookie(a);
      assert.ok(c1, 'the page set it');
      assert.equal(c1.httpOnly, true);
      assert.equal(c1.sameSite, 'Lax');
      assert.ok(Math.abs(c1.expires * 1000 - (Date.now() + 400 * DAY)) < DAY, '400 days');
      assert.equal(await a.page.evaluate(() => document.cookie.includes('sp_id')), false, 'no script can read it');
      await a.page.evaluate(() => fetch('/', { credentials: 'same-origin' }).then((r) => r.status));
      const c2 = await cookie(a);
      assert.notEqual(c2.value, c1.value, 're-signed');
      assert.equal(sub(c2), sub(c1), 'the same identity');
      await a.enter('凭证博士');
      await a.page.waitForFunction(async () => !!(await import('/js/ui/receipts.js')).idStore.get().sub, { timeout: 15000 });
      const subA = await idSub(a);
      assert.equal(subA, sub(c2), 'the socket\'s token is the cookie\'s identity');

      // 2) a match played to its settlement: its receipt arrives and is stored on its record
      await playSolo(a);
      await a.page.waitForFunction(() => JSON.parse(localStorage.getItem('sp.pref.stats') || '{"records":[]}').records.some((r) => r.rc), { timeout: 20000 });
      const played = (await stored(a)).records.find((r) => r.rc);
      const f = parseReceipt(played.rc);
      assert.deepEqual([f.sub, f.mode, f.diff, f.ver], [subA, 'solo', 'FUNNY', 'act2autochess']);

      // 3) more signed history of this identity (8 losses of 标准 (FUNNY) solo, two 规程 co-op matches with trophies, one 规程 record
      //    without a receipt that claims 50), then the history: 已核验 on every signed record
      await toLobby(a);
      const extra = [
        ...Array.from({ length: 8 }, (_, i) => signedRecord(rc, { sub: subA, i, mode: 'solo', diff: 'FUNNY', ver: 'act2autochess' })),
        signedRecord(rc, { sub: subA, i: 20, mode: 'coop', diff: 'ABYSS', ver: V3, won: true, trophies: 6 }),
        signedRecord(rc, { sub: subA, i: 21, mode: 'coop', diff: 'ABYSS', ver: V3, rounds: 13, trophies: 4 }),
        signedRecord(rc, { sub: subA, i: 22, mode: 'coop', diff: 'ABYSS', ver: V3, won: true, trophies: 50, withReceipt: false }),
      ];
      await a.page.evaluate(async (list) => {
        const s = await import('/js/ui/stats.js');
        s.saveStats(s.mergeStats(s.loadStats(), { records: list }));
      }, extra);
      const helpedA = await mine(a, 'solo', 'FUNNY');
      assert.equal(helpedA.dir, 'help', JSON.stringify(helpedA));
      assert.equal(helpedA.verified, 9);
      await openHistory(a);
      // (the history lists the version shown — 第二期下半 —: the played match and the eight signed ones)
      await a.page.waitForFunction(() => document.querySelectorAll('[data-testid="rc-verified"]').length >= 9, { timeout: 15000 });
      assert.equal(await marks(a), 9);
      await shot(a, 'rc-1-verified-history');

      // 4) the export warns first; the file carries the identity
      await a.click('[data-testid="stats-export"]');
      await a.page.waitForSelector('[data-testid="rc-export-warning"]', { visible: true, timeout: 8000 });
      const warning = await a.page.$eval('.modal', (e) => e.textContent);
      assert.match(warning, /文件里带着你的身份/);
      assert.match(warning, /不要把文件给别人/);
      await shot(a, 'rc-2-export-warning');
      await a.click('.modal__actions .btn--primary', '导出');
      const file = await a.page.evaluate(async () => {
        const s = await import('/js/ui/stats.js'), r = await import('/js/ui/receipts.js');
        return s.exportStats(s.loadStats(), r.idStore.get().token); // the very payload the button downloads
      });
      assert.equal(parseIdToken(file.identity).sub, subA);
      const filePath = path.join(dir, 'export.json');
      writeFileSync(filePath, JSON.stringify(file));

      // 5) 设置 › 其他: the identity line
      await a.click('.st-back');
      await a.page.waitForSelector('.st', { hidden: true, timeout: 10000 });
      await a.click('.lobby-screen [data-testid="settings-btn"]');
      await a.page.waitForSelector('.modal .set-list', { timeout: 8000 });
      await a.click('[data-testid="set-tab-other"]');
      await a.page.waitForSelector('[data-testid="identity-notice"]', { visible: true, timeout: 8000 });
      await a.page.$eval('[data-testid="identity-notice"]', (e) => e.scrollIntoView({ block: 'center' }));
      assert.match(await a.page.$eval('[data-testid="identity-notice"]', (e) => e.textContent), /服务器签发的随机编号（cookie）.*不收集设备信息，服务器不保存你的战绩/s);
      await shot(a, 'rc-5-settings-notice');

      // 6) a fresh profile: its own identity; the file's receipts verify (已核验) but count for nothing in ELO until it switches
      await open(b);
      await b.enter('导入博士');
      // what this page sends of room.trophies (its net.request, wrapped)
      await b.page.evaluate(() => {
        const net = globalThis.__SP__.net, request = net.request.bind(net);
        window.__RC_SENT__ = [];
        net.request = (t, fields, opts) => { if (t === 'room.trophies') window.__RC_SENT__.push(fields.rc.length); return request(t, fields, opts); };
      });
      await b.page.waitForFunction(async () => !!(await import('/js/ui/receipts.js')).idStore.get().sub, { timeout: 15000 });
      const subB = await idSub(b);
      assert.notEqual(subB, subA);
      await b.click('.lobby-screen .stats-entry');
      await b.page.waitForSelector('.st .st-tab', { visible: true, timeout: 15000 });
      const input = await b.page.$('.st input[type="file"]');
      await input.uploadFile(filePath);
      await b.page.waitForSelector('[data-testid="rc-switch-confirm"]', { visible: true, timeout: 10000 });
      const before = await mine(b, 'solo', 'FUNNY');
      assert.equal(before.dir, 'none', 'another identity\'s receipts: no help');
      assert.equal(before.verified, 0);
      assert.equal(before.ownN, 9, 'the records are there');
      await shot(b, 'rc-3-import-confirm');
      await b.click('.modal__actions .btn--primary', '换成文件里的身份');
      await b.page.waitForFunction(async (s) => (await import('/js/ui/receipts.js')).idStore.get().sub === s, { timeout: 20000 }, subA);
      assert.equal(sub(await cookie(b)), subA, 'the cookie is the file\'s identity now');
      const after = await mine(b, 'solo', 'FUNNY');
      assert.equal(after.dir, 'help');
      assert.equal(after.verified, 9);
      await b.click('.st-tab[data-tab="history"]');
      await b.page.waitForFunction(() => document.querySelectorAll('[data-testid="rc-verified"]').length >= 9, { timeout: 15000 });
      assert.equal(await marks(b), 9, 'imported receipts verify whatever the identity');
      await b.click('.st-back');
      await b.page.waitForSelector('.st', { hidden: true, timeout: 10000 });

      // 7) a 规程 co-op room: the teammate sees the trophies the server counted from receipts (6 + 4), not the page's 60
      const created = await req(b, 'room.create', { mode: 'coop', difficulty: 'ABYSS', version: V3 });
      await b.page.waitForFunction((v) => globalThis.__SP__.store.get().room?.version === v, { timeout: 30000 }, V3).catch(async (e) => {
        const r = await b.page.evaluate(() => { const x = globalThis.__SP__.store.get().room; return x && { code: x.code, version: x.version, mode: x.mode }; });
        throw new Error(`no 规程 room: ${JSON.stringify(created)} ${JSON.stringify(r)} ${e.message}`);
      });
      const room = await b.page.evaluate(() => globalThis.__SP__.store.get().room);
      await open(d);
      await d.enter('队友博士');
      await req(d, 'room.join', { code: room.code });
      await d.page.waitForFunction((host) => globalThis.__SP__.store.get().room?.seats?.some((x) => x?.playerId === host && x.card?.trophies === 10),
        { timeout: 30000 }, room.hostId).catch(async (e) => {
        const seats = await d.page.evaluate(() => (globalThis.__SP__.store.get().room?.seats || []).map((x) => x && { id: x.playerId, card: x.card ?? null }));
        const sent = await b.page.evaluate(() => window.__RC_SENT__ || []);
        throw new Error(`no counted trophies: host ${room.hostId} seats ${JSON.stringify(seats)} sent ${JSON.stringify(sent)} ${e.message}`);
      });
      const own = await b.page.evaluate(async () => (await import('/js/ui/playerCard.js')).cardStore.get().trophies);
      assert.equal(own, 10, 'the page\'s own 规程 card counts the receipts the same way (the unsigned 50 left out)');
      await d.page.waitForSelector('.rseat', { visible: true, timeout: 15000 });
      await sleep(1500);
      await shot(d, 'rc-4-card-trophies');
      if (SHOTS) {
        // the two seats' name plates, three times as large: the host's medal is trophy level 2 (10), the teammate's level 1 (0)
        const clip = await d.page.evaluate(() => {
          const r = [...document.querySelectorAll('.rseat__plate')].slice(0, 2).map((e) => e.getBoundingClientRect());
          const x = Math.min(...r.map((q) => q.left)), y = Math.min(...r.map((q) => q.top));
          return { x, y, width: Math.max(...r.map((q) => q.right)) - x, height: Math.max(...r.map((q) => q.bottom)) - y };
        });
        await d.page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 3 });
        await sleep(500);
        await d.page.screenshot({ path: path.join(SHOTS, 'rc-4b-card-trophies-zoom.png'), clip });
      }
      for (const c of [a, b, d]) assert.deepEqual(c.problems.filter((x) => !/favicon|ERR_ABORTED|\/assets\//.test(x)), [], c.label);
      // nothing secret in the server's log
      assert.equal(srv.logs.some((l) => /id1\.|rc1\./.test(l)), false);
    } finally {
      for (const c of [a, b, d]) await c.close().catch(() => {});
      await srv.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
