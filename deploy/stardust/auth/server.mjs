import http from 'node:http';
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { moderateName, nameReasonMessage } from './name-policy.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const derive = promisify(scrypt);
export const ORIGIN = 'https://ark-proto.stardust.matce.cn';
const PROFILE_ORIGINS = Object.freeze({ prod: ORIGIN, beta: 'https://ark-proto-beta.stardust.matce.cn' });
export const SESSION_COOKIE = '__Host-ark_gate';
export const CSRF_COOKIE = '__Host-ark_gate_csrf';
export const SESSION_TTL = 7 * 86400;
const CSRF_TTL = 1800;
const BODY_LIMIT = 4096;
const KDF = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const ASSETS = new Map([
  ['gate.css', 'text/css; charset=utf-8'],
  ['gate.js', 'text/javascript; charset=utf-8'],
  ['warmup.js', 'text/javascript; charset=utf-8'],
  ['scene.js', 'text/javascript; charset=utf-8'],
  ['terminal-motion.js', 'text/javascript; charset=utf-8'],
  ['entry-nav.js', 'text/javascript; charset=utf-8'],
  ['three.module.js', 'text/javascript; charset=utf-8'],
  ['three.core.js', 'text/javascript; charset=utf-8'],
  ['css3d.js', 'text/javascript; charset=utf-8'],
  ['bender-regular.woff2', 'font/woff2'],
]);
const OPTIONAL_ART = new Map([
  ['doctor.webp', 'image/webp'], ['rhodes.webp', 'image/webp'], ['ae-sphere.json', 'application/json; charset=utf-8'],
]);

function decode(value, bytes = null) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
  const buffer = Buffer.from(value, 'base64url');
  if (buffer.toString('base64url') !== value || (bytes !== null && buffer.length !== bytes)) throw new Error('Invalid encoding');
  return buffer;
}

function equal(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function makeSecrets(password) {
  if (typeof password !== 'string' || password.length < 6 || password.length > 256 || Buffer.byteLength(password) > 512) {
    throw new Error('Password must contain 6–256 characters and at most 512 UTF-8 bytes; 12+ random characters are recommended');
  }
  const salt = randomBytes(16);
  const hash = await derive(password, salt, 32, KDF);
  return { version: 1, salt: salt.toString('base64url'), hash: hash.toString('base64url'), signingKey: randomBytes(32).toString('base64url') };
}

export function validateSecrets(value) {
  if (!value || value.version !== 1) throw new Error('Invalid secrets version');
  return { salt: decode(value.salt, 16), hash: decode(value.hash, 32), signingKey: decode(value.signingKey, 32) };
}

export function signToken(kind, key, now = Math.floor(Date.now() / 1000)) {
  const ttl = kind === 'session' ? SESSION_TTL : CSRF_TTL;
  const body = Buffer.from(JSON.stringify({ v: 1, iat: now, exp: now + ttl, nonce: randomBytes(16).toString('base64url') })).toString('base64url');
  const signature = createHmac('sha256', key).update(`${kind}\0${body}`).digest('base64url');
  return `${body}.${signature}`;
}

export function verifyToken(token, kind, key, now = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string' || token.length > 512) return false;
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const body = decode(parts[0]);
    const signature = decode(parts[1], 32);
    const expected = createHmac('sha256', key).update(`${kind}\0${parts[0]}`).digest();
    if (!equal(signature, expected)) return false;
    const p = JSON.parse(body.toString('utf8'));
    const ttl = kind === 'session' ? SESSION_TTL : CSRF_TTL;
    return p?.v === 1 && Number.isSafeInteger(p.iat) && Number.isSafeInteger(p.exp)
      && p.iat <= now + 30 && p.exp > now && p.exp - p.iat === ttl && decode(p.nonce, 16).length === 16;
  } catch { return false; }
}

export function cookieValue(header, name) {
  if (typeof header !== 'string' || header.length > 8192) return null;
  const hits = header.split(';').map(x => x.trim()).filter(x => x.startsWith(name + '='));
  return hits.length === 1 ? hits[0].slice(name.length + 1) : null;
}

function profileOrigin(profile) {
  if (typeof profile !== 'string' || !Object.hasOwn(PROFILE_ORIGINS, profile)) throw new Error('Invalid AUTH_PROFILE: expected prod or beta');
  return PROFILE_ORIGINS[profile];
}

export function safeNext(value, profile = 'prod') {
  const origin = profileOrigin(profile);
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000- \u007f]/.test(value)) return '/';
  try {
    const decoded = decodeURIComponent(value);
    if (/[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.startsWith('//')
      || decoded.split('?')[0].split('/').some(segment => segment === '.' || segment === '..')) return '/';
    const url = new URL(value, origin);
    const entry = ['/', '/index.html'].includes(url.pathname);
    if (url.origin !== origin || !entry || url.hash) return '/';
    return url.pathname + url.search;
  } catch { return '/'; }
}

export function gameDestination(value, profile = 'prod') {
  const url = new URL(safeNext(value, profile), profileOrigin(profile));
  url.searchParams.set('_prts', '1');
  return url.pathname + url.search;
}

export class AttemptLimiter {
  constructor({ perIP = 10, window = 300, global = 60, globalWindow = 60, maxKeys = 5000 } = {}) {
    Object.assign(this, { perIP, window, global, globalWindow, maxKeys });
    this.rows = new Map();
    this.total = { count: 0, until: 0 };
    this.nextSweep = 0;
  }
  take(ip, now) {
    if (now >= this.nextSweep) {
      for (const [key, row] of this.rows) if (row.until <= now) this.rows.delete(key);
      this.nextSweep = now + 30;
    }
    if (this.total.until <= now) this.total = { count: 0, until: now + this.globalWindow };
    if (this.total.count >= this.global) return Math.max(1, this.total.until - now);
    let row = this.rows.get(ip);
    if (row && row.until <= now) { this.rows.delete(ip); row = null; }
    if (!row) {
      if (this.rows.size >= this.maxKeys) return 30;
      row = { count: 0, until: now + this.window };
      this.rows.set(ip, row);
    }
    if (row.count >= this.perIP) return Math.max(1, row.until - now);
    row.count++;
    this.total.count++;
    return 0;
  }
}

const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cookie = (name, value, age) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
const wantsJSON = req => /\bapplication\/json\b/.test(req.headers.accept || '');

function headers(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self' https://ark-asset.hanabi-ai.cn:25442; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
}

function send(req, res, status, body, type = 'text/plain; charset=utf-8') {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': data.length });
  res.end(req.method === 'HEAD' ? undefined : data);
}

class InputError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readForm(req) {
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new InputError(415, '不支持的请求格式，请刷新页面后重试。');
  const length = req.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) throw new InputError(413, '输入内容过长。');
  const body = await new Promise((resolveBody, reject) => {
    const chunks = [];
    let total = 0, done = false;
    req.on('data', chunk => {
      total += chunk.length;
      if (done) return;
      if (total > BODY_LIMIT) { done = true; chunks.length = 0; reject(new InputError(413, '输入内容过长。')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!done) { done = true; resolveBody(Buffer.concat(chunks).toString('utf8')); } });
    req.on('aborted', () => { if (!done) { done = true; reject(new InputError(400, '请求已中断，请重试。')); } });
    req.on('error', () => { if (!done) { done = true; reject(new InputError(400, '请求未完成，请重试。')); } });
  });
  const form = new URLSearchParams(body);
  for (const key of form.keys()) {
    if (!['password', 'csrf', 'next', 'callsign'].includes(key) || form.getAll(key).length !== 1) throw new InputError(400, '请求格式不正确。');
  }
  return form;
}

export function createGate({ secrets, profile = 'prod', now = () => Math.floor(Date.now() / 1000), limiter = new AttemptLimiter(), publicDir = join(ROOT, 'public') } = {}) {
  const origin = profileOrigin(profile);
  const trustedHost = new URL(origin).host;
  const keys = validateSecrets(secrets);
  const template = readFileSync(join(publicDir, 'login.html'), 'utf8');
  const assets = new Map([...ASSETS].map(([name, type]) => [name, { type, data: readFileSync(join(publicDir, name)) }]));
  for (const [name, type] of OPTIONAL_ART) {
    try { assets.set(name, { type, data: readFileSync(join(publicDir, name)) }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let activeKDF = 0;

  const authenticated = req => verifyToken(cookieValue(req.headers.cookie, SESSION_COOKIE), 'session', keys.signingKey, now());
  function render(req, res, status, next = '/', message = '') {
    const authed = authenticated(req);
    let csrf = cookieValue(req.headers.cookie, CSRF_COOKIE);
    if (!verifyToken(csrf, 'csrf', keys.signingKey, now())) csrf = signToken('csrf', keys.signingKey, now());
    // Every render refreshes the browser expiry, while the signature still bounds server-side validity.
    res.setHeader('Set-Cookie', cookie(CSRF_COOKIE, csrf, CSRF_TTL));
    const values = { NEXT: gameDestination(next, profile), CSRF: csrf, MESSAGE: message, AUTHENTICATED: String(authed), LOGIN_HIDDEN: authed ? 'hidden' : '', STATUS_HIDDEN: authed ? '' : 'hidden' };
    const html = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => escapeHTML(values[key] ?? ''));
    send(req, res, status, html, 'text/html; charset=utf-8');
  }
  function fail(req, res, status, message, next = '/', retryAfter = null, rejection = null) {
    if (retryAfter) res.setHeader('Retry-After', String(retryAfter));
    if (wantsJSON(req)) send(req, res, status, JSON.stringify({ ok: false, message, ...(retryAfter ? { retryAfter } : {}), ...(rejection || {}) }), 'application/json; charset=utf-8');
    else render(req, res, status, next, message);
  }

  async function handle(req, res) {
    headers(res);
    if (!req.url || req.url.length > 8192 || !req.url.startsWith('/') || req.url.startsWith('//')) return send(req, res, 400, 'Bad request');
    const url = new URL(req.url, origin);
    if (url.origin !== origin) return send(req, res, 400, 'Bad request');
    const path = url.pathname;
    // Only the local health probe may use a loopback Host; forwarded Host is never trusted.
    const localProbe = ['GET', 'HEAD'].includes(req.method) && req.url === '/healthz'
      && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
      && [`127.0.0.1:${req.socket.localPort}`, `[::1]:${req.socket.localPort}`].includes(req.headers.host);
    if (req.headersDistinct.host?.length !== 1 || (req.headers.host !== trustedHost && !localProbe)) return send(req, res, 400, 'Bad request');
    if (['GET', 'HEAD'].includes(req.method)) {
      if (path === '/healthz') return send(req, res, 200, '{"ok":true}', 'application/json');
      if (path === '/check') {
        res.writeHead(authenticated(req) ? 204 : 401);
        return res.end();
      }
      if (path === '/login' || path === '/entry') return render(req, res, 200, url.searchParams.get('next') || '/');
      if (path.startsWith('/_gate/assets/')) {
        const asset = assets.get(path.slice('/_gate/assets/'.length));
        if (!asset) return send(req, res, 404, 'Not found');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return send(req, res, 200, asset.data, asset.type);
      }
      return send(req, res, 404, 'Not found');
    }
    if (!['/_gate/login', '/_gate/logout', '/_gate/profile'].includes(path)) return send(req, res, 404, 'Not found');
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(req, res, 405, 'Method not allowed'); }
    const fetchSite = req.headers['sec-fetch-site'];
    if (req.headers.origin !== origin || (fetchSite && fetchSite !== 'same-origin')) return fail(req, res, 403, '请求来源无效，请在本站刷新后重试。');
    let form;
    try { form = await readForm(req); }
    catch (error) {
      if (error instanceof InputError) {
        if (error.status === 413) { res.setHeader('Connection', 'close'); req.resume(); }
        return fail(req, res, error.status, error.message);
      }
      throw error;
    }
    const next = safeNext(form.get('next') || '/', profile);
    const csrf = cookieValue(req.headers.cookie, CSRF_COOKIE);
    if (!csrf || !form.get('csrf') || !equal(csrf, form.get('csrf')) || !verifyToken(csrf, 'csrf', keys.signingKey, now())) {
      return fail(req, res, 403, '认证页面已过期，请刷新后重试。', next);
    }
    if (path === '/_gate/logout') {
      res.setHeader('Set-Cookie', [cookie(SESSION_COOKIE, '', 0), cookie(CSRF_COOKIE, '', 0)]);
      if (wantsJSON(req)) return send(req, res, 200, '{"ok":true,"next":"/login"}', 'application/json; charset=utf-8');
      res.writeHead(303, { Location: '/login' });
      return res.end();
    }
    if (path === '/_gate/profile') {
      // A remembered access cookie is not approval of a stale localStorage callsign. Every entry
      // validates the new name, with the same Origin/CSRF checks, without changing the access token.
      if (!authenticated(req)) return fail(req, res, 401, '访问授权已过期，请重新登录。', next);
      const checked = moderateName(form.get('callsign'));
      if (!checked.ok) return fail(req, res, 400, nameReasonMessage(checked.reason), next, null, { code: 'NAME_REJECTED', reason: checked.reason });
      if (wantsJSON(req)) return send(req, res, 200, JSON.stringify({ ok: true, next, callsign: checked.name }), 'application/json; charset=utf-8');
      res.writeHead(303, { Location: gameDestination(next, profile) });
      return res.end();
    }
    const password = form.get('password');
    if (!password || password.length > 256 || Buffer.byteLength(password) > 512) return fail(req, res, 400, '请输入有效的访问口令。', next);
    const forwarded = req.headers['x-real-ip'];
    const ip = typeof forwarded === 'string' && isIP(forwarded) ? forwarded : req.socket.remoteAddress || 'unknown';
    const retry = limiter.take(ip, now());
    if (retry) return fail(req, res, 429, '尝试过于频繁，请稍后重试。', next, retry);
    if (activeKDF >= 2) return fail(req, res, 429, '认证终端正忙，请稍后重试。', next, 2);
    activeKDF++;
    let hash;
    try { hash = await derive(password, keys.salt, 32, KDF); }
    finally { activeKDF--; }
    if (!equal(hash, keys.hash)) return fail(req, res, 401, '访问口令不正确，请重新输入。', next);
    // Keep password verification/CSRF/rate-limit ordering unchanged. No access cookie is minted
    // until BOTH credentials and the displayed name pass; rejected values are never reflected.
    const checked = moderateName(form.get('callsign'));
    if (!checked.ok) return fail(req, res, 400, nameReasonMessage(checked.reason), next, null, { code: 'NAME_REJECTED', reason: checked.reason });
    res.setHeader('Set-Cookie', cookie(SESSION_COOKIE, signToken('session', keys.signingKey, now()), SESSION_TTL));
    if (wantsJSON(req)) return send(req, res, 200, JSON.stringify({ ok: true, next, callsign: checked.name }), 'application/json; charset=utf-8');
    res.writeHead(303, { Location: gameDestination(next, profile) });
    res.end();
  }

  const server = http.createServer({ maxHeaderSize: 16384 }, (req, res) => {
    handle(req, res).catch(() => {
      // Do not log request bodies, URLs, cookies, or supplied credentials.
      console.error('Authentication service request failed');
      if (!res.headersSent) { headers(res); send(req, res, 500, 'Authentication service unavailable'); }
      else res.end();
    });
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 1000;
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profile = process.env.AUTH_PROFILE ?? 'prod';
  profileOrigin(profile);
  const filename = process.env.AUTH_SECRETS_FILE || '/run/secrets/ark-gate.json';
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const secrets = JSON.parse(readFileSync(filename, 'utf8'));
  const server = createGate({ secrets, profile });
  server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`ark-proto access gate listening on ${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
