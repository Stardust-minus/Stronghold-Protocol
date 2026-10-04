import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createGate, makeSecrets, validateSecrets, signToken, verifyToken, safeNext, gameDestination, cookieValue, AttemptLimiter, ORIGIN, SESSION_COOKIE, CSRF_COOKIE, SESSION_TTL } from '../server.mjs';

let secrets;
const password = 'test-only-access-password-84!';
const fixture = mkdtempSync(join(tmpdir(), 'ark-gate-tests-'));
writeFileSync(join(fixture, 'login.html'), '<!doctype html><body data-authenticated="{{AUTHENTICATED}}"><form {{LOGIN_HIDDEN}}><input name="csrf" value="{{CSRF}}"><input name="next" value="{{NEXT}}"><p>{{MESSAGE}}</p></form><section {{STATUS_HIDDEN}}>authorized</section></body>');
for (const name of ['gate.css', 'gate.js', 'scene.js', 'entry-nav.js', 'three.module.js', 'three.core.js', 'css3d.js', 'bender-regular.woff2']) writeFileSync(join(fixture, name), 'test asset');
before(async () => { secrets = await makeSecrets(password); });
after(() => rmSync(fixture, { recursive: true, force: true }));

async function start(t, opts = {}) {
  const server = createGate({ secrets, publicDir: fixture, ...opts });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function page(base, next = '/', existing = '') {
  const r = await fetch(base + '/login?next=' + encodeURIComponent(next), { headers: { Cookie: existing } });
  const html = await r.text();
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  return { r, html, cookie, csrf };
}
async function post(base, session, extra = {}, headers = {}, path = '/_gate/login') {
  return fetch(base + path, { method: 'POST', redirect: 'manual', headers: { Origin: ORIGIN, Accept: 'application/json', Cookie: session.cookie, ...headers }, body: new URLSearchParams({ csrf: session.csrf, password, next: '/', ...extra }) });
}

test('credentials validate and reject weak or malformed configuration', async () => {
  assert.equal(validateSecrets(secrets).hash.length, 32);
  assert.throws(() => validateSecrets({ ...secrets, version: 2 }));
  assert.throws(() => validateSecrets({ ...secrets, salt: 'invalid' }));
  await assert.rejects(makeSecrets('short'));
  assert.equal(validateSecrets(await makeSecrets('1234567')).hash.length, 32);
});
test('session signatures enforce purpose, key, expiry, future time, and canonical format', () => {
  const key = validateSecrets(secrets).signingKey;
  const token = signToken('session', key, 100);
  assert.ok(verifyToken(token, 'session', key, 100));
  assert.ok(verifyToken(token, 'session', key, 100 + SESSION_TTL - 1));
  assert.equal(verifyToken(token, 'session', key, 100 + SESSION_TTL), false);
  assert.equal(verifyToken(token, 'session', key, 1), false);
  assert.equal(verifyToken(token, 'csrf', key, 100), false);
  assert.equal(verifyToken(token, 'session', randomBytes(32), 100), false);
  for (const bad of ['', token.slice(1), token + '=', token + '.extra', 'x'.repeat(1000), token.replace('.', '.x')]) assert.equal(verifyToken(bad, 'session', key, 100), false);
});
test('cookie parsing rejects duplicates and prefix confusion', () => {
  assert.equal(cookieValue('abc=1; __Host-ark_gate=token', SESSION_COOKIE), 'token');
  assert.equal(cookieValue('__Host-ark_gate=one; __Host-ark_gate=two', SESSION_COOKIE), null);
  assert.equal(cookieValue('fake__Host-ark_gate=value', SESSION_COOKIE), null);
  assert.equal(cookieValue('x'.repeat(9000), SESSION_COOKIE), null);
});
test('safe return target preserves a complete invite query', () => {
  const next = '/?room=ABCD&label=%E4%BD%A0%E5%A5%BD&x=a%26b';
  assert.equal(safeNext(next), next);
  assert.equal(safeNext('/index.html?room=ABCD'), '/index.html?room=ABCD');
});
test('safe return target rejects redirects, controls, malformed escapes, and loops', () => {
  for (const next of ['https://evil.test', '//evil.test', '/\\evil.test', '/%2f%2fevil.test', '/login', '/_gate/login', '/assets/file', '/?x=%0d%0aLocation:evil', '/?bad=%zz', '/?x=\u0000', '/#hash', '/?a=' + 'x'.repeat(2100)]) assert.equal(safeNext(next), '/');
});
test('entry marker preserves invitation parameters without becoming an authorization token', () => {
  assert.equal(gameDestination('/?room=ABCD&note=a%26b'), '/?room=ABCD&note=a%26b&_prts=1');
  assert.equal(gameDestination('https://evil.test/'), '/?_prts=1');
  assert.equal(gameDestination('/?_prts=0&_prts=1'), '/?_prts=1');
});
test('entry screen works with and without an existing authenticated session', async t => {
  const base = await start(t);
  const initial = await fetch(base + '/entry?next=%2F%3Froom%3DABCD');
  assert.equal(initial.status, 200);
  assert.match(await initial.text(), /data-authenticated="false"/);
  const token = signToken('session', validateSecrets(secrets).signingKey);
  const remembered = await fetch(base + '/entry', { headers: { Cookie: SESSION_COOKIE + '=' + token } });
  assert.match(await remembered.text(), /data-authenticated="true"/);
  assert.equal((await fetch(base + '/check?_prts=1')).status, 401);
});
test('rate limiter bounds per-IP, global work, memory, and expiry', () => {
  const l = new AttemptLimiter({ perIP: 2, global: 3, window: 10, globalWindow: 10, maxKeys: 2 });
  assert.equal(l.take('a', 100), 0); assert.equal(l.take('a', 100), 0);
  assert.equal(l.take('a', 101), 9);
  assert.equal(l.take('b', 101), 0); assert.ok(l.take('c', 102) > 0);
  assert.equal(l.take('a', 111), 0);
  assert.ok(l.rows.size <= 2);
});
test('login form has local security headers and a host-only CSRF cookie', async t => {
  const base = await start(t);
  const p = await page(base, '/?room=ABCD&label=%22%3E%3Cscript%3E');
  assert.equal(p.r.status, 200);
  assert.match(p.r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(p.r.headers.get('cache-control'), 'no-store');
  assert.equal(p.r.headers.get('referrer-policy'), 'same-origin');
  assert.match(p.r.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Lax/);
  assert.doesNotMatch(p.r.headers.get('set-cookie'), /Domain=/i);
  assert.match(p.html, /&amp;label=/);
  assert.doesNotMatch(p.html, /<script>/);
});
test('valid login, cookie check, persistence, and browser logout', async t => {
  const base = await start(t);
  const p = await page(base);
  const r = await post(base, p, { next: '/?room=ABCD&foo=a%26b' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, next: '/?room=ABCD&foo=a%26b' });
  const auth = r.headers.get('set-cookie');
  assert.match(auth, /Max-Age=604800/);
  assert.match(auth, /^__Host-ark_gate=/);
  const cookie = p.cookie + '; ' + auth.split(';')[0];
  assert.equal((await fetch(base + '/check', { headers: { Cookie: cookie } })).status, 204);
  assert.match((await page(base, '/', cookie)).html, /data-authenticated="true"/);
  const out = await post(base, { ...p, cookie }, {}, {}, '/_gate/logout');
  assert.equal(out.status, 200);
  assert.equal((await out.json()).next, '/login');
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(base + '/check')).status, 401);
});
test('wrong password fails without reflecting or logging it', async t => {
  const base = await start(t); const p = await page(base);
  const r = await post(base, p, { password: 'definitely-wrong-secret' });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('set-cookie'), null);
  assert.doesNotMatch(await r.text(), /definitely-wrong-secret/);
});
test('native form login redirects with 303 and the complete safe destination', async t => {
  const base = await start(t); const p = await page(base);
  const r = await post(base, p, { next: '/?room=ABCD&mode=coop' }, { Accept: 'text/html' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/?room=ABCD&mode=coop&_prts=1');
});
test('native form errors render a fresh usable form', async t => {
  const base = await start(t); const p = await page(base);
  const r = await post(base, p, { password: 'bad' }, { Accept: 'text/html' });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(await r.text(), /访问口令不正确/);
});
test('missing, foreign, null Origin and cross-site metadata are rejected', async t => {
  const base = await start(t); const p = await page(base);
  for (const h of [{ Origin: '' }, { Origin: 'null' }, { Origin: 'https://evil.test' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await post(base, p, {}, h)).status, 403);
  }
});
test('missing, mismatched, expired and duplicate CSRF are rejected', async t => {
  let clock = 100; const base = await start(t, { now: () => clock }); const p = await page(base);
  assert.equal((await post(base, p, { csrf: 'bad' })).status, 403);
  assert.equal((await post(base, p, {}, { Cookie: '' })).status, 403);
  assert.equal((await post(base, p, {}, { Cookie: p.cookie + '; ' + p.cookie })).status, 403);
  clock = 2000;
  assert.equal((await post(base, p)).status, 403);
});
test('forged, expired and duplicated session cookies fail closed', async t => {
  let clock = 100;
  const base = await start(t, { now: () => clock }); const p = await page(base);
  const r = await post(base, p);
  const auth = r.headers.get('set-cookie').split(';')[0];
  for (const value of [auth + 'x', `${auth}; ${auth}`, SESSION_COOKIE + '=forged']) assert.equal((await fetch(base + '/check', { headers: { Cookie: value } })).status, 401);
  clock += SESSION_TTL;
  assert.equal((await fetch(base + '/check', { headers: { Cookie: auth } })).status, 401);
});
test('rotating verifier and signing key revokes previously issued cookies', async t => {
  const base = await start(t); const p = await page(base);
  const r = await post(base, p); const auth = r.headers.get('set-cookie').split(';')[0];
  const replacement = await makeSecrets('replacement-test-password-93');
  const next = await start(t, { secrets: replacement });
  assert.equal((await fetch(next + '/check', { headers: { Cookie: auth } })).status, 401);
});
test('failed attempts hit bounded rate limit and return Retry-After', async t => {
  const base = await start(t, { limiter: new AttemptLimiter({ perIP: 2, window: 300 }) }); const p = await page(base);
  assert.equal((await post(base, p, { password: 'wrong' })).status, 401);
  assert.equal((await post(base, p, { password: 'wrong' })).status, 401);
  const r = await post(base, p); assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
});
test('oversized input, wrong content type, duplicate fields and methods rejected', async t => {
  const base = await start(t); const p = await page(base);
  const h = { Origin: ORIGIN, Accept: 'application/json', Cookie: p.cookie };
  assert.equal((await fetch(base + '/_gate/login', { method: 'POST', headers: h, body: JSON.stringify({ password }) })).status, 415);
  assert.equal((await post(base, p, { password: 'x'.repeat(5000) })).status, 413);
  const r = await fetch(base + '/_gate/login', { method: 'POST', headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `csrf=${p.csrf}&password=a&password=b` });
  assert.equal(r.status, 400);
  assert.equal((await fetch(base + '/_gate/logout', { method: 'PUT', headers: h })).status, 405);
});
test('chunked body limits are enforced without relying on Content-Length', async t => {
  const base = await start(t); const p = await page(base);
  const status = await new Promise((resolveStatus, reject) => {
    const req = http.request(base + '/_gate/login', { method: 'POST', headers: { Origin: ORIGIN, Accept: 'application/json', Cookie: p.cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'Transfer-Encoding': 'chunked' } }, r => { r.resume(); r.on('end', () => resolveStatus(r.statusCode)); });
    req.on('error', reject); req.write('password=' + 'x'.repeat(3000)); req.end('x'.repeat(3000));
  });
  assert.equal(status, 413);
});
test('password page assets are allowlisted, not a filesystem proxy', async t => {
  const base = await start(t);
  assert.equal((await fetch(base + '/_gate/assets/gate.css')).status, 200);
  for (const path of ['/_gate/assets/secrets.json', '/_gate/assets/%2e%2e/server.mjs', '/server.mjs', '/data/chess.json', '/ws']) assert.equal((await fetch(base + path)).status, 404);
});
test('parallel derivations are bounded instead of creating an unbounded work queue', async t => {
  const base = await start(t); const p = await page(base);
  const responses = await Promise.all(Array.from({ length: 8 }, () => post(base, p, { password: 'wrong' })));
  assert.ok(responses.some(r => r.status === 429));
  assert.ok(responses.every(r => [401, 429].includes(r.status)));
});
