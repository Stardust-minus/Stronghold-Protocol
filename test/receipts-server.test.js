// Match receipts and the identity cookie on a real server (docs/history/0.4.0.md §37.276): the page load and the upgrade set
// and refresh the cookie, the socket gets its own token after welcome, a match end sends every human seat its receipt
// after m.result (and again in the result replay), rc.verify answers, room.elo with receipts, POST /api/identity switches
// the identity, /healthz counts without tokens. Throwaway key files; StubMatch (test/lobby-likes.test.js does the same).
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { PHASE } from '../shared/constants.js';
import { parseIdToken, parseReceipt } from '../shared/receipts.js';
import { eloKey } from '../shared/elo.js';

const quietLog = () => {
  const lines = [];
  return { lines, log: { info: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')), debug() {}, error: (...a) => lines.push(`ERROR ${a.join(' ')}`) } };
};
const ok = async (c, msg) => { const r = await c.request(msg); assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`); return r; };
const cookieOf = (setCookie) => [].concat(setCookie || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('sp_id=')) ?? null;

describe('receipts and the identity cookie (server)', () => {
  let srv, dir, url, base;
  const cap = quietLog();
  const open = new Set();
  const connect = async (cookie = null) => {
    const c = await TestClient.connect(url, { wsOptions: cookie ? { headers: { cookie } } : {} });
    open.add(c);
    return c;
  };
  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'rc-srv-'));
    const write = (name) => { const f = path.join(dir, name); writeFileSync(f, `g1 ${randomBytes(32).toString('base64')}\n`, { mode: 0o600 }); return f; };
    srv = await startServer({ port: 0, host: '127.0.0.1', log: cap.log, MatchClass: StubMatch, lobbyGraceMs: 60_000, resyncMinGapMs: 50,
      identityKeyFile: write('identity'), resultKeyFile: write('receipts') });
    url = `ws://127.0.0.1:${srv.port}/ws`;
    base = `http://127.0.0.1:${srv.port}`;
  });
  afterEach(async () => { await Promise.all([...open].map((c) => c.terminate().catch(() => {}))); open.clear(); });
  after(async () => {
    await srv?.close();
    rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(cap.lines.filter((l) => l.startsWith('ERROR')), [], 'no server errors');
    // never a token, a sub or a receipt in the log
    assert.equal(cap.lines.some((l) => /id1\.|rc1\./.test(l)), false);
  });

  test('the page sets the cookie (http: sp_id, HttpOnly, 400 days) and refreshes it with the same identity', async () => {
    const first = await fetch(`${base}/`);
    const set = first.headers.getSetCookie();
    const c1 = cookieOf(set);
    assert.ok(c1, JSON.stringify(set));
    assert.match(set.find((s) => s.startsWith('sp_id=')), /; Path=\/; Max-Age=34560000; HttpOnly; SameSite=Lax$/);
    const again = await fetch(`${base}/index.html`, { headers: { cookie: c1 } });
    const c2 = cookieOf(again.headers.getSetCookie());
    assert.notEqual(c2, c1, 're-signed');
    assert.equal(parseIdToken(c2.slice(6)).sub, parseIdToken(c1.slice(6)).sub, 'the same identity');
  });

  test('the upgrade reads it; the socket gets its own token after welcome; none or a bad one: a new identity, set on the 101', async () => {
    const page = cookieOf((await fetch(`${base}/`)).headers.getSetCookie());
    const sub = parseIdToken(page.slice(6)).sub;
    const c = await connect(page);
    await c.hello('Doc');
    const tok = await c.waitFor('id.token');
    assert.equal(parseIdToken(tok.token).sub, sub);
    assert.equal(tok.fresh, undefined);
    // the 101 of a socket without a cookie carries a new one
    const headers = await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once('upgrade', (res) => { resolve(res.headers); ws.terminate(); });
      ws.once('error', reject);
    });
    assert.ok(cookieOf(headers['set-cookie']));
    const bare = await connect('sp_id=id1.g1.forged');
    await bare.hello('Doc2');
    const fresh = await bare.waitFor('id.token');
    assert.equal(fresh.fresh, true);
    assert.notEqual(parseIdToken(fresh.token).sub, sub);
  });

  test('a match end: each human gets m.receipt after m.result (its own sub), again in the replay; rc.verify; room.elo takes them', async () => {
    const hostCookie = cookieOf((await fetch(`${base}/`)).headers.getSetCookie());
    const host = await connect(hostCookie);
    const w = await host.hello('Host');
    const hostSub = parseIdToken((await host.waitFor('id.token')).token).sub;
    const guest = await connect();
    await guest.hello('Guest');
    const guestSub = parseIdToken((await guest.waitFor('id.token')).token).sub;
    await ok(host, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const st = await host.waitFor('room.state');
    await ok(guest, { t: 'room.join', code: st.code });
    await ok(host, { t: 'room.addBot' });
    await ok(guest, { t: 'room.ready', ready: true });
    await ok(host, { t: 'room.start' });
    for (const c of [host, guest]) await c.waitFor('m.public', (p) => p.phase === PHASE.INFO_CHECK);
    for (const c of [host, guest]) await ok(c, { t: 'g.infoReady' });
    const got = [];
    for (const [c, sub] of [[host, hostSub], [guest, guestSub]]) {
      await c.waitFor('m.result');
      const m = await c.waitFor('m.receipt');
      const r = parseReceipt(m.rc);
      assert.equal(r.sub, sub);
      assert.deepEqual([r.mode, r.diff, r.ver, r.w, r.ai, r.mod, r.elo], ['coop', 'NORMAL', 'act2autochess', 0, 0, 0, 0]);
      const order = c.log.map((x) => x.t);
      assert.ok(order.lastIndexOf('m.result') < order.lastIndexOf('m.receipt'), 'after its result');
      got.push(m.rc);
    }
    assert.equal(parseReceipt(got[0]).rec, parseReceipt(got[1]).rec, 'one match, one id');
    // the replay: a reloaded page resumes and gets its result and its receipt again
    await host.terminate(); open.delete(host);
    const back = await connect(hostCookie);
    await back.hello('Host', w.token);
    await back.waitFor('m.result');
    assert.equal((await back.waitFor('m.receipt')).rc, got[0]);
    // rc.verify: mine and the guest's verify, a tampered one does not
    const bad = got[0].replace(/\.(\d+)\.([A-Za-z0-9_-]{43})$/, (_, at, mac) => `.${Number(at) + 1}.${mac}`);
    const v = await ok(back, { t: 'rc.verify', rc: [got[0], got[1], bad] });
    assert.deepEqual(v.valid, [1, 1, 0]);
    // room.elo with receipts: the session keeps its own receipts' list for the room's mode, difficulty and version
    const key = eloKey('coop', 'NORMAL', 'act2autochess');
    await ok(back, { t: 'room.elo', rec: { [key]: [[1, 14], [1, 14]] }, rc: [got[0], got[1]] });
    const session = srv.registry.byId(w.playerId);
    assert.deepEqual(session.elo[key], [[0, 0]], 'the guest\'s receipt is not mine; mine is a loss (the stub settles none)');
    assert.equal(session.sub, hostSub);
  });

  test('POST /api/identity: a token of this server switches the cookie; a forged one or another origin does not', async () => {
    const a = cookieOf((await fetch(`${base}/`)).headers.getSetCookie());
    const b = cookieOf((await fetch(`${base}/`)).headers.getSetCookie());
    const tokenB = b.slice(6);
    const res = await fetch(`${base}/api/identity`, { method: 'POST', headers: { cookie: a, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ token: tokenB }) });
    assert.equal(res.status, 204);
    const switched = cookieOf(res.headers.getSetCookie());
    assert.equal(parseIdToken(switched.slice(6)).sub, parseIdToken(tokenB).sub);
    const c = await connect(switched);
    await c.hello('Switched');
    assert.equal(parseIdToken((await c.waitFor('id.token')).token).sub, parseIdToken(tokenB).sub, 'the next socket is the new identity');
    const cross = await fetch(`${base}/api/identity`, { method: 'POST', headers: { origin: 'http://evil.test', 'content-type': 'application/json' }, body: JSON.stringify({ token: tokenB }) });
    assert.equal(cross.status, 403);
    const forged = await fetch(`${base}/api/identity`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ token: `${tokenB.slice(0, -2)}AA` }) });
    assert.equal(forged.status, 400);
    assert.equal((await fetch(`${base}/api/identity`)).status, 405);
  });

  test('/healthz counts identities and receipts, never a token', async () => {
    const h = await (await fetch(`${base}/healthz`)).json();
    assert.equal(h.receipts.identity.keys, 'file');
    assert.equal(h.receipts.receipts.keys, 'file');
    assert.ok(h.receipts.receipts.issued >= 2);
    assert.equal(/id1\.|rc1\./.test(JSON.stringify(h)), false);
  });
});
