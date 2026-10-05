import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGate, makeSecrets, validateSecrets, signToken, verifyToken, safeNext, gameDestination, cookieValue, AttemptLimiter, ORIGIN, SESSION_COOKIE, CSRF_COOKIE, SESSION_TTL } from '../server.mjs';

let secrets, betaSecrets;
const BETA_ORIGIN = 'https://ark-proto-beta.stardust.matce.cn';
const origins = new Map();
const password = 'test-only-access-password-84!';
const fixture = mkdtempSync(join(tmpdir(), 'ark-gate-tests-'));
writeFileSync(join(fixture, 'login.html'), '<!doctype html><body data-authenticated="{{AUTHENTICATED}}"><form {{LOGIN_HIDDEN}}><input name="csrf" value="{{CSRF}}"><input name="next" value="{{NEXT}}"><p>{{MESSAGE}}</p></form><section {{STATUS_HIDDEN}}>authorized</section></body>');
for (const name of ['gate.css', 'gate.js', 'scene.js', 'entry-nav.js', 'three.module.js', 'three.core.js', 'css3d.js', 'bender-regular.woff2']) writeFileSync(join(fixture, name), 'test asset');
before(async () => { secrets = await makeSecrets(password); betaSecrets = await makeSecrets(password); });
after(() => rmSync(fixture, { recursive: true, force: true }));

async function start(t, opts = {}) {
  const server = createGate({ secrets, publicDir: fixture, ...opts });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  origins.set(base, opts.profile === 'beta' ? BETA_ORIGIN : ORIGIN);
  t.after(() => new Promise(resolve => { origins.delete(base); server.closeAllConnections(); server.close(resolve); }));
  return base;
}
async function request(url, options = {}) {
  const origin = origins.get(new URL(url).origin);
  const headers = { Host: new URL(origin).host, ...options.headers };
  const form = options.body instanceof URLSearchParams;
  const body = form ? options.body.toString() : options.body;
  if (body !== undefined && !Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = form ? 'application/x-www-form-urlencoded;charset=UTF-8' : 'text/plain;charset=UTF-8';
  }
  // Native HTTP preserves an explicit Host; built-in fetch replaces it with the fixture address.
  return new Promise((resolveResponse, reject) => {
    const req = http.request(url, { method: options.method || 'GET', headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(name, item);
        }
        resolveResponse(new Response([204, 304].includes(res.statusCode) ? null : Buffer.concat(chunks), { status: res.statusCode, headers: responseHeaders }));
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
async function rawRequest(base, path, headers = {}, method = 'GET') {
  return new Promise((resolveResponse, reject) => {
    const req = http.request(base, { path, method, headers, setHost: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolveResponse({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}
async function page(base, next = '/', existing = '') {
  const r = await request(base + '/login?next=' + encodeURIComponent(next), { headers: { Cookie: existing } });
  const html = await r.text();
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  return { r, html, cookie, csrf };
}
async function post(base, session, extra = {}, headers = {}, path = '/_gate/login') {
  return request(base + path, { method: 'POST', redirect: 'manual', headers: { Origin: origins.get(base), Accept: 'application/json', Cookie: session.cookie, ...headers }, body: new URLSearchParams({ csrf: session.csrf, password, callsign: '阿米娅', next: '/', ...extra }) });
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
  const initial = await request(base + '/entry?next=%2F%3Froom%3DABCD');
  assert.equal(initial.status, 200);
  assert.match(await initial.text(), /data-authenticated="false"/);
  const token = signToken('session', validateSecrets(secrets).signingKey);
  const remembered = await request(base + '/entry', { headers: { Cookie: SESSION_COOKIE + '=' + token } });
  assert.match(await remembered.text(), /data-authenticated="true"/);
  assert.equal((await request(base + '/check?_prts=1')).status, 401);
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
  assert.deepEqual(await r.json(), { ok: true, next: '/?room=ABCD&foo=a%26b', callsign: '阿米娅' });
  const auth = r.headers.get('set-cookie');
  assert.match(auth, /Max-Age=604800/);
  assert.match(auth, /^__Host-ark_gate=/);
  assert.match(auth, /Path=\/; Secure; HttpOnly; SameSite=Lax/);
  assert.doesNotMatch(auth, /Domain=/i);
  const cookie = p.cookie + '; ' + auth.split(';')[0];
  assert.equal((await request(base + '/check', { headers: { Cookie: cookie } })).status, 204);
  assert.match((await page(base, '/', cookie)).html, /data-authenticated="true"/);
  const out = await post(base, { ...p, cookie }, {}, {}, '/_gate/logout');
  assert.equal(out.status, 200);
  assert.equal((await out.json()).next, '/login');
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.doesNotMatch(out.headers.get('set-cookie'), /Domain=/i);
  assert.equal((await request(base + '/check')).status, 401);
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
  for (const value of [auth + 'x', `${auth}; ${auth}`, SESSION_COOKIE + '=forged']) assert.equal((await request(base + '/check', { headers: { Cookie: value } })).status, 401);
  clock += SESSION_TTL;
  assert.equal((await request(base + '/check', { headers: { Cookie: auth } })).status, 401);
});
test('rotating verifier and signing key revokes previously issued cookies', async t => {
  const base = await start(t); const p = await page(base);
  const r = await post(base, p); const auth = r.headers.get('set-cookie').split(';')[0];
  const replacement = await makeSecrets('replacement-test-password-93');
  const next = await start(t, { secrets: replacement });
  assert.equal((await request(next + '/check', { headers: { Cookie: auth } })).status, 401);
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
  assert.equal((await request(base + '/_gate/login', { method: 'POST', headers: h, body: JSON.stringify({ password }) })).status, 415);
  assert.equal((await post(base, p, { password: 'x'.repeat(5000) })).status, 413);
  const r = await request(base + '/_gate/login', { method: 'POST', headers: { ...h, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `csrf=${p.csrf}&password=a&password=b` });
  assert.equal(r.status, 400);
  assert.equal((await request(base + '/_gate/logout', { method: 'PUT', headers: h })).status, 405);
});
test('chunked body limits are enforced without relying on Content-Length', async t => {
  const base = await start(t); const p = await page(base);
  const status = await new Promise((resolveStatus, reject) => {
    const req = http.request(base + '/_gate/login', { method: 'POST', headers: { Host: new URL(ORIGIN).host, Origin: ORIGIN, Accept: 'application/json', Cookie: p.cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'Transfer-Encoding': 'chunked' } }, r => { r.resume(); r.on('end', () => resolveStatus(r.statusCode)); });
    req.on('error', reject); req.write('password=' + 'x'.repeat(3000)); req.end('x'.repeat(3000));
  });
  assert.equal(status, 413);
});
test('password page assets are allowlisted, not a filesystem proxy', async t => {
  const base = await start(t);
  assert.equal((await request(base + '/_gate/assets/gate.css')).status, 200);
  for (const path of ['/_gate/assets/secrets.json', '/_gate/assets/%2e%2e/server.mjs', '/server.mjs', '/data/chess.json', '/ws']) assert.equal((await request(base + path)).status, 404);
});
test('parallel derivations are bounded instead of creating an unbounded work queue', async t => {
  const base = await start(t); const p = await page(base);
  const responses = await Promise.all(Array.from({ length: 8 }, () => post(base, p, { password: 'wrong' })));
  assert.ok(responses.some(r => r.status === 429));
  assert.ok(responses.every(r => [401, 429].includes(r.status)));
});

test('safeNext keeps root invitations but rejects former rolling entries, code/assets and traversal', () => {
  for (const path of ['/?room=ABCD', '/index.html?room=ABCD&note=a%26b']) {
    assert.equal(safeNext(path), path);
    assert.equal(gameDestination(path), path + '&_prts=1');
  }
  for (const path of ['/_release/old/public/?room=ABCD', '/_release/r2_2026/public/index.html?room=ABCD&note=a%26b',
    '/_release/.old/public/', '/_release/old/public', '/_release/old/public/js/main.js',
    '/_release/old/public/assets/', '/_release/old/private/', '/_release/old/public/../public/',
    '/_release/old/public/%2e%2e/public/', '/_release/' + 'a'.repeat(65) + '/public/',
    '/_release/old/public//evil.test', '/_release/old/public/?x=%0d%0a', '/_release/old/public/#hash']) {
    assert.equal(safeNext(path), '/');
  }
});

test('login moderates callsign before issuing a session and never reflects a rejected value', async t => {
  const base = await start(t, { limiter: new AttemptLimiter({ perIP: 100, global: 100 }) });
  const p = await page(base);
  for (const callsign of ['傻逼', '傻​逼', 'ＦＵＣＫ', 'f.u.c.k', 'ＮＩＧＧＥＲ', '操你妈']) {
    const response = await post(base, p, { callsign });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), { ok: false, message: '代号含有不适宜内容，请换一个昵称。', code: 'NAME_REJECTED', reason: 'sensitive' });
    assert.equal((await request(base + '/check')).status, 401);
  }
  const valid = await post(base, p, { callsign: ' Ａｍｉｙａ ', next: '/?room=ABCD' });
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { ok: true, next: '/?room=ABCD', callsign: 'Amiya' });
  assert.match(valid.headers.get('set-cookie'), /^__Host-ark_gate=/);
});

test('callsign rejection cannot bypass Origin, CSRF, password verification or attempt limits', async t => {
  const base = await start(t, { limiter: new AttemptLimiter({ perIP: 2 }) });
  const p = await page(base), rejectedName = 'ＦＵＣＫ';
  assert.equal((await post(base, p, { callsign: rejectedName }, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await post(base, p, { callsign: rejectedName, csrf: 'invalid' })).status, 403);
  const badPassword = await post(base, p, { callsign: rejectedName, password: 'incorrect' });
  assert.equal(badPassword.status, 401);
  assert.equal(Object.hasOwn(await badPassword.json(), 'code'), false);
  assert.equal((await post(base, p, { callsign: rejectedName })).status, 400);
  assert.equal((await post(base, p)).status, 429);
});

test('missing/empty/oversized/duplicate callsign fails without a placeholder identity', async t => {
  const base = await start(t); const p = await page(base);
  for (const callsign of ['', '͏​‮', 'x'.repeat(13), '​'.repeat(300)]) {
    const response = await post(base, p, { callsign });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'NAME_REJECTED');
    assert.equal(response.headers.get('set-cookie'), null);
  }
  const fields = new URLSearchParams({ password, csrf: p.csrf, next: '/' });
  const missing = await request(base + '/_gate/login', { method: 'POST', headers: { Origin: ORIGIN, Accept: 'application/json', Cookie: p.cookie }, body: fields });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, 'NAME_REJECTED');
  fields.append('callsign', '阿米娅'); fields.append('callsign', '凯尔希');
  const duplicate = await request(base + '/_gate/login', { method: 'POST', headers: { Origin: ORIGIN, Accept: 'application/json', Cookie: p.cookie }, body: fields });
  assert.equal(duplicate.status, 400);
});

test('authenticated profile rechecks legacy callsign using Origin and CSRF without changing its session', async t => {
  const base = await start(t), p = await page(base);
  const auth = SESSION_COOKIE + '=' + signToken('session', validateSecrets(secrets).signingKey);
  const remembered = { ...p, cookie: p.cookie + '; ' + auth };
  assert.equal((await request(base + '/check', { headers: { Cookie: remembered.cookie } })).status, 204);
  const bad = await post(base, remembered, { callsign: '傻​逼' }, {}, '/_gate/profile');
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get('set-cookie'), null);
  assert.deepEqual(await bad.json(), { ok: false, message: '代号含有不适宜内容，请换一个昵称。', code: 'NAME_REJECTED', reason: 'sensitive' });
  assert.equal((await request(base + '/check', { headers: { Cookie: remembered.cookie } })).status, 204);
  const good = await post(base, remembered, { callsign: ' Ａｍｉｙａ ', next: '/?room=ABCD' }, {}, '/_gate/profile');
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('set-cookie'), null);
  assert.deepEqual(await good.json(), { ok: true, next: '/?room=ABCD', callsign: 'Amiya' });
  assert.equal((await post(base, p, {}, {}, '/_gate/profile')).status, 401);
  assert.equal((await post(base, remembered, { csrf: 'invalid' }, {}, '/_gate/profile')).status, 403);
  assert.equal((await post(base, remembered, {}, { Origin: 'https://evil.test' }, '/_gate/profile')).status, 403);
  assert.equal((await request(base + '/_gate/profile')).status, 404);
});

test('profiles are fixed, production stays the default, and unknown profiles or URLs fail closed', () => {
  assert.equal(ORIGIN, 'https://ark-proto.stardust.matce.cn');
  assert.equal(safeNext('/?room=ABCD'), safeNext('/?room=ABCD', 'prod'));
  assert.equal(gameDestination('/?room=ABCD'), gameDestination('/?room=ABCD', 'prod'));
  for (const profile of ['', 'unknown', 'PROD', 'constructor', '__proto__', ORIGIN, BETA_ORIGIN, 'https://evil.test', null, false, ['beta'], new String('prod')]) {
    assert.throws(() => createGate({ secrets, profile, publicDir: fixture }), /Invalid AUTH_PROFILE/);
    assert.throws(() => safeNext('/', profile), /Invalid AUTH_PROFILE/);
    assert.throws(() => gameDestination('/', profile), /Invalid AUTH_PROFILE/);
  }
});

test('CLI rejects an invalid AUTH_PROFILE before reading a verifier file', () => {
  for (const profile of ['', 'unknown', ORIGIN, BETA_ORIGIN]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], {
      env: { AUTH_PROFILE: profile, AUTH_SECRETS_FILE: join(fixture, 'missing-test-verifier.json') }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid AUTH_PROFILE: expected prod or beta/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  }
});

test('beta destinations preserve invite parameters and remain relative to beta', () => {
  for (const next of ['/?room=ABCD&note=a%26b', '/index.html?room=ABCD&label=%E4%BD%A0%E5%A5%BD']) {
    assert.equal(safeNext(next, 'beta'), next);
    const destination = gameDestination(next, 'beta');
    assert.equal(destination, next + '&_prts=1');
    assert.equal(new URL(destination, BETA_ORIGIN).origin, BETA_ORIGIN);
    assert.ok(destination.startsWith('/') && !destination.startsWith('//'));
  }
  for (const next of [ORIGIN + '/?room=ABCD', BETA_ORIGIN + '/?room=ABCD', '//ark-proto.stardust.matce.cn/', '/%2f%2fevil.test', '/\\evil.test', '/login', '/_release/old/public/', '/%2e%2e/', '/?bad=%zz', '/?x=%0d%0a', '/#hash']) {
    assert.equal(safeNext(next, 'beta'), '/');
    assert.equal(gameDestination(next, 'beta'), '/?_prts=1');
  }
  assert.equal(gameDestination('/?_prts=0&_prts=1&room=ABCD', 'beta'), '/?_prts=1&room=ABCD');
});

test('explicit prod and the default profile keep the same Host, Origin and login behavior', async t => {
  for (const opts of [{}, { profile: 'prod' }]) {
    const base = await start(t, opts), p = await page(base, '/?room=ABCD');
    assert.equal(p.r.status, 200);
    assert.equal((await request(base + '/healthz')).status, 200);
    const login = await post(base, p, { next: '/?room=ABCD' }, { 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(login.status, 200);
    assert.deepEqual(await login.json(), { ok: true, next: '/?room=ABCD', callsign: '阿米娅' });
    assert.equal((await post(base, p, {}, { Origin: BETA_ORIGIN })).status, 403);
    assert.equal((await request(base + '/login', { headers: { Host: new URL(BETA_ORIGIN).host } })).status, 400);
  }
});

test('beta login, profile and logout retain host-only cookies and complete relative destinations', async t => {
  const base = await start(t, { profile: 'beta', secrets: betaSecrets });
  const next = '/index.html?room=ABCD&note=a%26b', p = await page(base, next);
  assert.equal(p.r.status, 200);
  assert.match(p.html, /data-authenticated="false"/);
  assert.ok(p.html.includes('value="/index.html?room=ABCD&amp;note=a%26b&amp;_prts=1"'));
  assert.match(p.r.headers.get('set-cookie'), /^__Host-ark_gate_csrf=.*; Path=\/; Secure; HttpOnly; SameSite=Lax/);
  assert.doesNotMatch(p.r.headers.get('set-cookie'), /Domain=/i);
  const login = await post(base, p, { next });
  assert.equal(login.status, 200);
  assert.deepEqual(await login.json(), { ok: true, next, callsign: '阿米娅' });
  const auth = login.headers.get('set-cookie');
  assert.match(auth, /^__Host-ark_gate=.*; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=604800/);
  assert.doesNotMatch(auth, /Domain=/i);
  const remembered = { ...p, cookie: p.cookie + '; ' + auth.split(';')[0] };
  assert.equal((await request(base + '/check', { headers: { Cookie: remembered.cookie } })).status, 204);
  assert.match((await page(base, next, remembered.cookie)).html, /data-authenticated="true"/);
  assert.match(await (await request(base + '/entry', { headers: { Cookie: remembered.cookie } })).text(), /data-authenticated="true"/);
  const profile = await post(base, remembered, { next, callsign: ' Ａｍｉｙａ ' }, {}, '/_gate/profile');
  assert.equal(profile.status, 200);
  assert.equal(profile.headers.get('set-cookie'), null);
  assert.deepEqual(await profile.json(), { ok: true, next, callsign: 'Amiya' });
  assert.equal((await post(base, remembered, { callsign: 'ＦＵＣＫ' }, {}, '/_gate/profile')).status, 400);
  assert.equal((await post(base, p, {}, {}, '/_gate/profile')).status, 401);
  for (const path of ['/_gate/login', '/_gate/profile']) {
    const native = await post(base, remembered, { next }, { Accept: 'text/html' }, path);
    assert.equal(native.status, 303);
    assert.equal(native.headers.get('location'), next + '&_prts=1');
    assert.equal(new URL(native.headers.get('location'), BETA_ORIGIN).origin, BETA_ORIGIN);
  }
  const out = await post(base, remembered, {}, {}, '/_gate/logout');
  assert.equal(out.status, 200);
  assert.deepEqual(await out.json(), { ok: true, next: '/login' });
  const cleared = out.headers.getSetCookie();
  assert.equal(cleared.length, 2);
  for (const value of cleared) {
    assert.match(value, /^__Host-ark_gate(?:_csrf)?=; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=0$/);
    assert.doesNotMatch(value, /Domain=/i);
  }
  const nativeOut = await post(base, remembered, {}, { Accept: 'text/html' }, '/_gate/logout');
  assert.equal(nativeOut.status, 303);
  assert.equal(nativeOut.headers.get('location'), '/login');
  assert.equal((await request(base + '/check')).status, 401);
});

test('prod and beta mutually reject foreign and noncanonical raw Origins on every mutation', async t => {
  for (const [profile, origin, foreignOrigin, verifier] of [['prod', ORIGIN, BETA_ORIGIN, secrets], ['beta', BETA_ORIGIN, ORIGIN, betaSecrets]]) {
    const base = await start(t, { profile, secrets: verifier }), p = await page(base);
    const remembered = { ...p, cookie: p.cookie + '; ' + SESSION_COOKIE + '=' + signToken('session', validateSecrets(verifier).signingKey) };
    for (const path of ['/_gate/login', '/_gate/profile', '/_gate/logout']) {
      for (const value of [foreignOrigin, '', 'null', origin + '/', origin + ':443', origin.toUpperCase(), origin + ', ' + foreignOrigin]) {
        const response = await post(base, remembered, {}, { Origin: value }, path);
        assert.equal(response.status, 403);
        assert.equal(response.headers.get('set-cookie'), null);
      }
      for (const site of ['cross-site', 'same-site', 'none']) assert.equal((await post(base, remembered, {}, { 'Sec-Fetch-Site': site }, path)).status, 403);
      assert.equal((await post(base, remembered, {}, { Origin: foreignOrigin, 'X-Forwarded-Host': new URL(origin).host, 'X-Forwarded-Proto': 'https' }, path)).status, 403);
    }
    assert.equal((await post(base, remembered, {}, { 'Sec-Fetch-Site': 'same-origin' }, '/_gate/profile')).status, 200);
  }
});

test('only the exact profile Host reaches business routes and forwarded Host cannot repair it', async t => {
  for (const [profile, origin, foreignOrigin, verifier] of [['prod', ORIGIN, BETA_ORIGIN, secrets], ['beta', BETA_ORIGIN, ORIGIN, betaSecrets]]) {
    const base = await start(t, { profile, secrets: verifier }), p = await page(base);
    const host = new URL(origin).host;
    const remembered = { ...p, cookie: p.cookie + '; ' + SESSION_COOKIE + '=' + signToken('session', validateSecrets(verifier).signingKey) };
    for (const value of [new URL(foreignOrigin).host, host + '.evil.test', host + ':443', host + '.', host.toUpperCase(), 'evil.test', 'localhost', new URL(base).host, 'localhost:' + new URL(base).port]) {
      const headers = { Host: value, 'X-Forwarded-Host': host, Cookie: remembered.cookie };
      for (const path of ['/login', '/entry', '/check', '/_gate/assets/gate.js']) {
        const response = await request(base + path, { headers });
        assert.equal(response.status, 400);
        assert.equal(response.headers.get('set-cookie'), null);
      }
      for (const path of ['/_gate/login', '/_gate/profile', '/_gate/logout']) assert.equal((await post(base, remembered, {}, headers, path)).status, 400);
    }
    assert.equal((await rawRequest(base, '/login')).status, 400);
    assert.equal((await rawRequest(base, '/login', ['Host', host, 'Host', 'evil.test'])).status, 400);
    assert.equal((await rawRequest(base, '/login', ['Host', 'evil.test', 'Host', host])).status, 400);
    assert.equal((await request(base + '/login', { headers: { 'X-Forwarded-Host': 'evil.test' } })).status, 200);
    assert.equal((await post(base, remembered, {}, { 'X-Forwarded-Host': new URL(foreignOrigin).host }, '/_gate/profile')).status, 200);
  }
});

test('independent deployment keys mutually reject copied session and CSRF tokens', async t => {
  assert.notEqual(secrets.signingKey, betaSecrets.signingKey);
  const prod = await start(t), beta = await start(t, { profile: 'beta', secrets: betaSecrets });
  const prodPage = await page(prod), betaPage = await page(beta);
  for (const [base, ownPage, foreignPage, ownSecrets, foreignSecrets] of [[prod, prodPage, betaPage, secrets, betaSecrets], [beta, betaPage, prodPage, betaSecrets, secrets]]) {
    const ownKey = validateSecrets(ownSecrets).signingKey, foreignKey = validateSecrets(foreignSecrets).signingKey;
    const ownAuth = SESSION_COOKIE + '=' + signToken('session', ownKey), foreignAuth = SESSION_COOKIE + '=' + signToken('session', foreignKey);
    const copiedSession = { ...ownPage, cookie: ownPage.cookie + '; ' + foreignAuth };
    assert.equal((await request(base + '/check', { headers: { Cookie: copiedSession.cookie } })).status, 401);
    assert.match((await page(base, '/', copiedSession.cookie)).html, /data-authenticated="false"/);
    assert.equal((await post(base, copiedSession, {}, {}, '/_gate/profile')).status, 401);
    const copiedCSRF = { ...foreignPage, cookie: foreignPage.cookie + '; ' + ownAuth };
    for (const path of ['/_gate/login', '/_gate/profile', '/_gate/logout']) {
      const response = await post(base, copiedCSRF, {}, {}, path);
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('set-cookie'), null);
    }
    assert.ok(verifyToken(ownPage.csrf, 'csrf', ownKey));
    assert.equal(verifyToken(foreignPage.csrf, 'csrf', ownKey), false);
    assert.equal((await post(base, { ...ownPage, cookie: ownPage.cookie + '; ' + ownAuth }, {}, {}, '/_gate/profile')).status, 200);
  }
});

test('only GET and HEAD on the exact health path admit known local loopback probe Hosts', async t => {
  for (const profile of ['prod', 'beta']) {
    const base = await start(t, { profile }), port = new URL(base).port;
    for (const Host of ['127.0.0.1:' + port, '[::1]:' + port]) {
      for (const method of ['GET', 'HEAD']) {
        const response = await request(base + '/healthz', { method, headers: { Host } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('set-cookie'), null);
        assert.equal(await response.text(), method === 'GET' ? '{"ok":true}' : '');
      }
      for (const path of ['/healthz?probe=1', '/login', '/entry', '/check', '/_gate/assets/gate.js']) assert.equal((await request(base + path, { headers: { Host } })).status, 400);
      for (const method of ['POST', 'PUT']) assert.equal((await request(base + '/healthz', { method, headers: { Host } })).status, 400);
    }
    for (const Host of ['evil.test', 'localhost:' + port, '127.0.0.1', '127.0.0.1:1', '[::1]', new URL(profile === 'prod' ? BETA_ORIGIN : ORIGIN).host]) {
      assert.equal((await request(base + '/healthz', { headers: { Host, 'X-Forwarded-Host': new URL(origins.get(base)).host } })).status, 400);
    }
  }
});

test('forwarded loopback metadata cannot grant a nonlocal health probe exception', async () => {
  const server = createGate({ secrets, publicDir: fixture });
  for (const remoteAddress of ['192.0.2.1', '::ffff:192.0.2.1', '127.0.0.2']) {
    let status;
    const req = { method: 'GET', url: '/healthz', headers: { host: '127.0.0.1:3000', 'x-real-ip': '127.0.0.1', 'x-forwarded-for': '127.0.0.1' }, headersDistinct: { host: ['127.0.0.1:3000'] }, socket: { remoteAddress, localPort: 3000 } };
    await new Promise(resolveResponse => server.emit('request', req, { setHeader() {}, writeHead(value) { status = value; }, end() { resolveResponse(); } }));
    assert.equal(status, 400);
  }
});

test('request URLs cannot replace the fixed profile origin even with a trusted Host', async t => {
  for (const [profile, origin, foreignOrigin] of [['prod', ORIGIN, BETA_ORIGIN], ['beta', BETA_ORIGIN, ORIGIN]]) {
    const base = await start(t, { profile }), headers = { Host: new URL(origin).host };
    for (const path of [foreignOrigin + '/login', origin + '/login', '//' + new URL(foreignOrigin).host + '/login', '/\\' + new URL(foreignOrigin).host + '/login']) {
      const response = await rawRequest(base, path, headers);
      assert.equal(response.status, 400);
      assert.equal(response.headers['set-cookie'], undefined);
    }
  }
});
