// Match receipts and the identity cookie (docs/history/0.4.0.md §37.276): the formats (shared/receipts.js), the key
// files (server/identity.js loadKeyring: two generations), identity tokens (issue, verify, re-sign, rotation keeps the
// pseudonym), receipts (forgery, tampering, replay into another identity, rotation), what ELO takes of them (help only
// from receipts of the own identity, the page's own list only lowers, each version its own) and the 规程 trophy count.
// Throwaway keys only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ID_COOKIE, RECEIPT_LIMITS, eloReceiptEntries, parseIdToken, parseReceipt, receiptTrophies } from '../shared/receipts.js';
import { eloEntriesOf, eloKey, eloSummary, eloTrusted, isEloRecords } from '../shared/elo.js';
import { validateC2S } from '../shared/protocol.js';
import { createIdentity, ephemeralKeyring, identityCookieOf, loadKeyring, parseKeyring, requestSecure } from '../server/identity.js';
import { createReceipts, eloTrustedRec, matchReceipts } from '../server/resultReceipts.js';
import { encodeOpen, decodeFrame } from '../server/cluster/link.js';

const V2 = 'act2autochess', V3 = 'act3autochess@V3_1';
const key = () => randomBytes(32).toString('base64');
const ring = (...gens) => parseKeyring(gens.map(([k, v]) => `${k} ${v}`).join('\n'));
const fields = (o = {}) => ({ sub: 'A'.repeat(21) + 'A', rec: 'B'.repeat(16), mode: 'coop', diff: 'ABYSS', ver: V3, w: true, rp: 14, tr: 6, ai: false, mod: false, elo: false, ...o });

test('key files: "<label> <key>" lines, the first signs, at most two generations, an owner-only file', async (t) => {
  const r = ring(['g2', key()], ['g1', key()]);
  assert.equal(r.k, 'g2');
  assert.deepEqual([...r.keys.keys()], ['g2', 'g1']);
  assert.equal(r.ephemeral, false);
  for (const bad of ['', '# only a comment', 'g1', `g1 ${randomBytes(16).toString('base64')}`, `g1 ${key()}\ng1 ${key()}`,
    `g1 ${key()}\ng2 ${key()}\ng3 ${key()}`, `bad label! ${key()}`, 'g1 not*base64']) {
    assert.throws(() => parseKeyring(bad), TypeError, JSON.stringify(bad));
  }
  const e = ephemeralKeyring();
  assert.equal(e.ephemeral, true);
  assert.equal(e.keys.get(e.k).length, 32);
  // a real file: owner-only, absolute; the message never carries the key
  const dir = mkdtempSync(path.join(tmpdir(), 'rc-keys-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'k');
  const secret = key();
  writeFileSync(file, `# receipts\ng1 ${secret}\n`);
  chmodSync(file, 0o644);
  await assert.rejects(loadKeyring(file, { what: 'receipts' }), (err) => err instanceof TypeError && !String(err.message).includes(secret));
  chmodSync(file, 0o600);
  const loaded = await loadKeyring(file, { what: 'receipts' });
  assert.equal(loaded.k, 'g1');
  await assert.rejects(loadKeyring('relative/k', { what: 'receipts' }), TypeError);
  await assert.rejects(loadKeyring(path.join(dir, 'missing'), { what: 'receipts' }), TypeError);
  assert.equal((await loadKeyring(null, { what: 'receipts' })).ephemeral, true, 'unset: ephemeral');
});

test('identity tokens: issued with a random id and its pseudonym; re-signed on a visit; the MAC holds, a forgery does not', () => {
  let now = 1_000;
  const id = createIdentity({ keys: ring(['g1', key()]), now: () => now });
  const a = id.issue();
  const f = parseIdToken(a.token);
  assert.ok(f && f.k === 'g1' && f.id === a.id && f.sub === a.sub && f.iat === 1000);
  assert.notEqual(a.sub, a.id);
  assert.deepEqual(id.verify(a.token)?.sub, a.sub);
  now = 5_000;
  const b = id.issue(id.verify(a.token));
  assert.equal(b.id, a.id); assert.equal(b.sub, a.sub); assert.equal(b.iat, 5000);
  assert.notEqual(b.token, a.token, 'a fresh signature');
  // forgery: another key, a changed id or sub, a changed MAC
  const other = createIdentity({ keys: ring(['g1', key()]) });
  assert.equal(id.verify(other.issue().token), null, 'another key');
  const p = a.token.split('.');
  assert.equal(id.verify([...p.slice(0, 2), other.issue().id, ...p.slice(3)].join('.')), null, 'another id');
  assert.equal(id.verify([...p.slice(0, 3), other.issue().sub, ...p.slice(4)].join('.')), null, 'another sub');
  assert.equal(id.verify(`${a.token.slice(0, -2)}${a.token.endsWith('AA') ? 'EA' : 'AA'}`), null, 'another MAC');
  assert.equal(id.verify('id1.g1.x.y.1.z'), null);
  assert.equal(id.verify(null), null);
  assert.equal(id.stats().invalid >= 5, true);
  assert.equal(JSON.stringify(id.stats()).includes(a.sub), false, 'counts only');
});

test('identity key rotation: the old generation still verifies, a visit re-signs with the new one, the sub never changes', () => {
  const k1 = key(), k2 = key();
  const before = createIdentity({ keys: ring(['g1', k1]) });
  const a = before.issue();
  const after = createIdentity({ keys: ring(['g2', k2], ['g1', k1]) });
  const v = after.verify(a.token);
  assert.equal(v?.k, 'g1');
  const b = after.issue(v);
  assert.equal(parseIdToken(b.token).k, 'g2');
  assert.equal(b.sub, a.sub, 'receipts of before still match');
  const dropped = createIdentity({ keys: ring(['g3', key()], ['g2', k2]) });
  assert.equal(dropped.verify(a.token), null, 'two rotations later a token never re-signed is gone');
  assert.equal(dropped.verify(b.token)?.sub, a.sub, 'one re-signed on a visit lives on');
});

test('the cookie: __Host- + Secure on https, a plain name on http, HttpOnly, SameSite=Lax, Path=/, 400 days; read only by its name', () => {
  const id = createIdentity({ keys: ring(['g1', key()]) });
  const a = id.issue();
  assert.equal(id.cookie(a, true), `__Host-sp_id=${a.token}; Path=/; Max-Age=${400 * 86400}; HttpOnly; SameSite=Lax; Secure`);
  assert.equal(id.cookie(a, false), `sp_id=${a.token}; Path=/; Max-Age=${400 * 86400}; HttpOnly; SameSite=Lax`);
  assert.equal(identityCookieOf(`x=1; __Host-sp_id=${a.token}; __Host-ark_gate=zzz`, true), a.token);
  assert.equal(identityCookieOf(`sp_id=${a.token}`, true), null, 'https reads the __Host- one only');
  assert.equal(identityCookieOf(`__Host-sp_id=${a.token}`, false), null);
  assert.equal(requestSecure({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-proto': 'https' } }), true, 'a trusted proxy');
  assert.equal(requestSecure({ socket: { remoteAddress: '203.0.113.9' }, headers: { 'x-forwarded-proto': 'https' } }), false, 'a stranger\'s header');
  // fromRequest: a valid cookie comes back re-signed (the same sub), none or a bad one gives a new identity
  const req = (cookie) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-proto': 'https', ...(cookie ? { cookie } : {}) } });
  const same = id.fromRequest(req(`${ID_COOKIE.secure}=${a.token}`));
  assert.equal(same.fresh, false); assert.equal(same.identity.sub, a.sub); assert.equal(same.secure, true);
  assert.equal(id.fromRequest(req(null)).fresh, true);
  assert.equal(id.fromRequest(req(`${ID_COOKIE.secure}=${a.token}x`)).fresh, true);
  assert.notEqual(id.fromRequest(req(null)).identity.sub, a.sub);
  // a page load sets it, keeping another Set-Cookie
  const headers = {};
  const res = { getHeader: (k) => headers[k], setHeader: (k, v) => { headers[k] = v; } };
  res.setHeader('Set-Cookie', 'other=1');
  id.onPage(req(`${ID_COOKIE.secure}=${a.token}`), res);
  assert.equal(headers['Set-Cookie'].length, 2);
  assert.ok(headers['Set-Cookie'][1].startsWith('__Host-sp_id=id1.g1.'));
});

/** A fake POST /api/identity request. */
function post({ origin = 'https://game.test', host = 'game.test', type = 'application/json', body = '' } = {}) {
  const req = Object.assign(new EventEmitter(), { headers: { origin, host, 'content-type': type, 'x-forwarded-proto': 'https' }, socket: { remoteAddress: '127.0.0.1' }, resume() {} });
  const headers = {};
  const res = { statusCode: 0, done: null, getHeader: (k) => headers[k], setHeader: (k, v) => { headers[k] = v; }, end() { this.done = true; } };
  return { req, res, headers, send() { req.emit('data', Buffer.from(body)); req.emit('end'); } };
}

test('POST /api/identity: same origin, JSON, a token that verifies → the cookie (re-signed); anything else refused', () => {
  const id = createIdentity({ keys: ring(['g1', key()]) });
  const a = id.issue();
  const good = post({ body: JSON.stringify({ token: a.token }) });
  id.handlePost(good.req, good.res); good.send();
  assert.equal(good.res.statusCode, 204);
  const set = good.headers['Set-Cookie'][0];
  assert.ok(set.startsWith('__Host-sp_id=') && set.includes('HttpOnly'));
  assert.equal(id.verify(set.split(';')[0].split('=')[1])?.sub, a.sub);
  const cross = post({ origin: 'https://evil.test', body: JSON.stringify({ token: a.token }) });
  id.handlePost(cross.req, cross.res);
  assert.equal(cross.res.statusCode, 403);
  const form = post({ type: 'text/plain', body: JSON.stringify({ token: a.token }) });
  id.handlePost(form.req, form.res);
  assert.equal(form.res.statusCode, 415);
  const forged = post({ body: JSON.stringify({ token: createIdentity({ keys: ring(['g1', key()]) }).issue().token }) });
  id.handlePost(forged.req, forged.res); forged.send();
  assert.equal(forged.res.statusCode, 400);
  assert.equal(forged.headers['Set-Cookie'], undefined);
  const big = post({ body: JSON.stringify({ token: 'x'.repeat(2000) }) });
  id.handlePost(big.req, big.res); big.send();
  assert.equal(big.res.statusCode, 413);
});

test('receipts: canonical dotted fields + HMAC-SHA256; forging, tampering and another key fail; replay into another identity counts nothing', () => {
  let now = 1_763_600_000_000;
  const rc = createReceipts({ keys: ring(['r1', key()]), now: () => now });
  const s = rc.issue(fields());
  assert.ok(s.length <= RECEIPT_LIMITS.chars);
  const f = parseReceipt(s);
  assert.deepEqual({ ...f, body: undefined, mac: undefined }, { k: 'r1', sub: 'A'.repeat(22), rec: 'B'.repeat(16), mode: 'coop', diff: 'ABYSS', ver: V3,
    w: 1, rp: 14, tr: 6, ai: 0, mod: 0, elo: 0, at: now, body: undefined, mac: undefined });
  assert.ok(rc.verify(s));
  // tampering any field: the MAC fails
  const p = s.split('.');
  for (const [i, v] of [[2, 'C'.repeat(21) + 'A'], [3, 'D'.repeat(16)], [5, 'NORMAL'], [6, V2], [7, '0'], [8, '3'], [9, '0'], [10, '1'], [11, '1'], [13, String(now - 1)]]) {
    const changed = [...p]; changed[i] = v;
    assert.equal(rc.verify(changed.join('.')), null, `field ${i}`);
  }
  // forged with another key, or a MAC made up
  const forger = createReceipts({ keys: ring(['r1', key()]), now: () => now });
  assert.equal(rc.verify(forger.issue(fields())), null);
  assert.equal(rc.verify(`${p.slice(0, 14).join('.')}.${'A'.repeat(43)}`), null);
  assert.equal(rc.verify(`${s}x`), null); assert.equal(rc.verify(s.replace('rc1.', 'rc2.')), null);
  assert.equal(rc.verify(rc.issue(fields({ ver: 'act9autochess' }))), null, 'an unknown version');
  // a receipt from the future is refused
  now += 10 * 60_000; const later = rc.issue(fields()); now -= 10 * 60_000;
  assert.equal(rc.verify(later), null);
  // replay into another identity: valid, but ELO takes only the session's own sub
  const mine = [rc.verify(s)];
  assert.deepEqual(eloReceiptEntries(mine, 'A'.repeat(22)), { [eloKey('coop', 'ABYSS', V3)]: [[1, 14]] });
  assert.deepEqual(eloReceiptEntries(mine, 'Z'.repeat(21) + 'A'), {}, 'another identity: nothing');
  assert.deepEqual(eloReceiptEntries(mine, null), {});
  assert.equal(JSON.stringify(rc.stats()).includes('AAAA'), false, 'counts only');
});

test('receipt key rotation: the previous generation verifies, two rotations later it does not', () => {
  const k1 = key(), k2 = key();
  const s = createReceipts({ keys: ring(['r1', k1]) }).issue(fields());
  assert.ok(createReceipts({ keys: ring(['r2', k2], ['r1', k1]) }).verify(s));
  assert.equal(createReceipts({ keys: ring(['r2', k2], ['r1', k1]) }).issue(fields()).split('.')[1], 'r2', 'the first generation signs');
  assert.equal(createReceipts({ keys: ring(['r3', key()], ['r2', k2]) }).verify(s), null);
});

test('ELO with receipts: help only from the own identity\'s receipts; the page\'s own list only lowers (the minimum of the two)', () => {
  const loss = [0, 14], win = [1, 14];
  const k = eloKey('coop', 'ABYSS', V3);
  const losses = Array.from({ length: 10 }, () => loss), wins = Array.from({ length: 10 }, () => win);
  // own records say 10 losses (full help), no receipts: no tilt
  assert.equal(eloSummary(losses).s, 1);
  assert.deepEqual(eloTrusted(losses, []).summary.s, 0);
  assert.equal(eloTrusted(losses, []).source, 'receipts');
  // receipts say 10 losses: help
  assert.equal(eloTrusted(wins.slice(0, 2), losses).summary.s, 1);
  // own records say 10 wins (hinder), receipts say losses: hinder (own lowers)
  const hinder = eloTrusted(wins, losses);
  assert.equal(hinder.source, 'own'); assert.ok(hinder.summary.s < 0);
  // own says a little hinder, receipts say more: the receipts' (lower)
  const both = eloTrusted([...wins.slice(0, 6), ...losses.slice(0, 4)], wins);
  assert.equal(both.source, 'receipts'); assert.equal(both.summary.s, eloSummary(wins).s);
  // the server's choice per key: the receipts' list, or the page's own when it hinders more; a legacy key never counts
  const rc = createReceipts({ keys: ring(['r1', key()]) });
  const mine = 'M'.repeat(21) + 'A', theirs = 'T'.repeat(21) + 'A';
  const receipts = Array.from({ length: 10 }, (_, i) => rc.verify(rc.issue(fields({ sub: mine, rec: `r${String(i).padStart(15, '0')}`, w: false, tr: 0 }))));
  const stolen = Array.from({ length: 10 }, (_, i) => rc.verify(rc.issue(fields({ sub: theirs, rec: `s${String(i).padStart(15, '0')}`, w: false, tr: 0 }))));
  assert.deepEqual(eloTrustedRec({ [k]: wins.slice(0, 1) }, receipts, mine)[k].length, 10, 'my receipts: help');
  assert.deepEqual(eloTrustedRec({ [k]: losses }, stolen, mine)[k], [], 'another identity\'s receipts: none');
  assert.deepEqual(eloTrustedRec({ [k]: wins }, receipts, mine)[k], wins, 'own hinders more');
  assert.deepEqual(eloTrustedRec({ 'coop:ABYSS': wins }, [], mine), {}, 'a legacy key without its version: nothing');
  // a match listed twice counts once
  assert.equal(eloTrustedRec({}, [...receipts, ...receipts], mine)[k].length, 10);
});

test('ELO per version: records and receipts of another version do not count, no fallback', () => {
  const rc = createReceipts({ keys: ring(['r1', key()]) });
  const sub = 'M'.repeat(21) + 'A';
  const v2 = Array.from({ length: 10 }, (_, i) => rc.verify(rc.issue(fields({ sub, ver: V2, rec: `v${String(i).padStart(15, '0')}`, w: false, tr: 0 }))));
  const rec = eloTrustedRec({ [eloKey('coop', 'ABYSS', V2)]: Array.from({ length: 10 }, () => [0, 14]) }, v2, sub);
  assert.equal(eloEntriesOf(rec, 'coop', 'ABYSS', V3), null, 'a 规程 room takes none of 第二期下半');
  assert.equal(eloEntriesOf(rec, 'coop', 'ABYSS', V2).length, 10);
  assert.equal(eloEntriesOf(rec, 'coop', 'HARD', V2), null, 'no fallback across difficulties');
  assert.equal(eloEntriesOf(rec, 'solo', 'ABYSS', V2), null, 'or modes');
  assert.equal(isEloRecords({ [eloKey('coop', 'ABYSS', V3)]: [[1, 14]] }), true);
  assert.equal(isEloRecords({ 'coop:ABYSS:act9autochess': [[1, 14]] }), false, 'an unknown version');
  assert.equal(validateC2S({ t: 'room.elo', rec: { 'coop:ABYSS': [[1, 14]] } }), null, 'a legacy page\'s key is accepted (and never counted)');
  assert.equal(validateC2S({ t: 'room.elo', rec: {}, rc: Array.from({ length: 31 }, () => 'x') }) !== null, true, 'at most 30 receipts');
});

test('the 规程 名片 trophies: counted from receipts of that season, any identity, one per match, never a plugin match', () => {
  const rc = createReceipts({ keys: ring(['r1', key()]) });
  const v = (o) => rc.verify(rc.issue(fields(o)));
  const list = [v({ rec: 'a'.repeat(16), tr: 6 }), v({ rec: 'a'.repeat(16), tr: 6, sub: 'Q'.repeat(21) + 'A' }), v({ rec: 'b'.repeat(16), tr: 3, sub: 'Q'.repeat(21) + 'A' }),
    v({ rec: 'c'.repeat(16), tr: 4, mod: true }), v({ rec: 'd'.repeat(16), tr: 5, ver: V2 })];
  assert.equal(receiptTrophies(list, 'act3autochess'), 9, '6 + 3: one per match, the plugin match and 二期 left out');
  assert.equal(receiptTrophies(list, 'act2autochess'), 5);
});

test('matchReceipts: every human row still seated with an identity; never a bot, a leaver, a test match or a session without one', () => {
  const rc = createReceipts({ keys: ring(['r1', key()]) });
  const seats = new Map([['p1', { isBot: false, left: false }], ['p2', { isBot: false, left: false }], ['p3', { isBot: false, left: true }], ['ai', { isBot: true }]]);
  const room = { mode: 'coop', difficulty: 'ABYSS', version: V3, modded: false, experimental: { elo: true }, seatOf: (id) => seats.get(id) };
  const subs = { p1: 'S'.repeat(21) + 'A', p3: 'U'.repeat(21) + 'A' };
  const summary = { difficulty: 'ABYSS', version: V3, players: [
    { playerId: 'p1', isBot: false, victory: true, roundsPassed: 14, trophies: 6 },
    { playerId: 'p2', isBot: false, victory: true, roundsPassed: 14, trophies: 6 },
    { playerId: 'p3', isBot: false, left: true, victory: false, roundsPassed: 3, trophies: 0 },
    { playerId: 'ai', isBot: true, victory: true, roundsPassed: 14 }] };
  const out = matchReceipts(rc, { summary, room, subOf: (id) => subs[id] ?? null });
  assert.deepEqual([...out.keys()], ['p1'], 'p2 has no identity, p3 left, ai is a bot');
  const f = parseReceipt(out.get('p1'));
  assert.deepEqual([f.sub, f.mode, f.diff, f.ver, f.w, f.rp, f.tr, f.ai, f.mod, f.elo], [subs.p1, 'coop', 'ABYSS', V3, 1, 14, 6, 0, 0, 1]);
  assert.equal(matchReceipts(rc, { summary: { ...summary, test: true }, room, subOf: (id) => subs[id] }).size, 0, 'a test match');
  assert.equal(matchReceipts(null, { summary, room, subOf: (id) => subs[id] }).size, 0, 'no authority');
  const takeover = matchReceipts(rc, { summary: { ...summary, players: [{ ...summary.players[0], aiTakeoverRound: 5 }] }, room, subOf: (id) => subs[id] });
  assert.equal(parseReceipt(takeover.get('p1')).ai, 1);
});

test('a cluster ingress forwards the identity cookie on its link: OPEN { ip, origin, proto, id? }', () => {
  const plain = decodeFrame(encodeOpen(1, { ip: '198.51.100.7', origin: 'https://game.test', proto: 'https' }), 'ingress');
  assert.deepEqual(plain.info, { ip: '198.51.100.7', origin: 'https://game.test', proto: 'https' });
  const withId = decodeFrame(encodeOpen(2, { ip: '198.51.100.7', origin: 'https://game.test', proto: 'https', id: 'id1.g1.abc.def.1.mac' }), 'ingress');
  assert.equal(withId.info.id, 'id1.g1.abc.def.1.mac');
  assert.throws(() => decodeFrame(encodeOpen(3, { ip: '198.51.100.7', origin: 'https://game.test', proto: 'https', id: 'a b;c' }), 'ingress'));
});

test('a cluster ingress forwards the identity cookie, and no other, to the coordinator\'s /ws', async (t) => {
  const http = await import('node:http');
  const { WebSocket, WebSocketServer } = await import('ws');
  const { startIngress } = await import('../server/cluster/ingress.js');
  const seen = [];
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket, req) => { seen.push(req.headers.cookie ?? null); socket.on('error', () => {}); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origins = ['https://game.invalid', 'http://lan.invalid'];
  const ingress = await startIngress({ coordinatorUrl: `http://127.0.0.1:${server.address().port}`, nodes: [], origins, shutdownMs: 100 });
  t.after(async () => {
    await ingress.close();
    for (const s of wss.clients) s.terminate();
    await new Promise((resolve) => wss.close(resolve));
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  });
  const open = (origin, cookie) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${ingress.url.replace(/^http/, 'ws')}/ws`, { origin, headers: cookie ? { cookie } : {} });
    ws.once('open', () => resolve(ws)); ws.once('error', reject);
  });
  const until = async (n) => { for (let i = 0; i < 200 && seen.length < n; i++) await new Promise((r) => setTimeout(r, 10)); };
  const tok = 'id1.g1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBA.1.' + 'C'.repeat(42) + 'A';
  const sockets = [
    await open(origins[0], `__Host-ark_gate=secret; __Host-sp_id=${tok}; other=1`),
    await open(origins[1], `sp_id=${tok}; __Host-ark_gate=secret`),
    await open(origins[0], `sp_id=${tok}`),
  ];
  await until(3);
  assert.deepEqual(seen, [`__Host-sp_id=${tok}`, `sp_id=${tok}`, null], 'https: the __Host- one; http: the plain one; never the gate cookie');
  for (const ws of sockets) ws.terminate();
});
