// server/identity.js — the browser's identity cookie (docs/history/0.4.0.md §37.276; the owner, 2026-11-20: 「按 cookie 加
// 导出带身份的方案」 — no accounts, no device fingerprinting, the server signs and stores nothing) and the key files of
// it and of the match receipts (server/resultReceipts.js).
//
//   * Token (shared/receipts.js parseIdToken): `id1.<k>.<id>.<sub>.<iat>.<mac>` — a random id, its pseudonym `sub` (what
//     receipts carry; HMAC of the id under the identity key, computed once at birth and carried), the signing time and
//     HMAC-SHA256 under the identity key's generation k. The raw id and the token never reach a receipt or a log.
//   * Carrier: a first-party cookie the server sets — HttpOnly, SameSite=Lax, Path=/, Max-Age 400 days (Chrome's cap),
//     `__Host-sp_id` + Secure on https, `sp_id` on LAN http — re-signed with the current key and re-set with a fresh
//     expiry on every page load (server/http/routes.js) and on a direct WebSocket upgrade (server/http/websocket.js). A
//     server-set cookie is not script-written storage: Safari's 7-day rule for the latter does not apply (not verified
//     on a real iPhone).
//   * The WebSocket reads it at the upgrade (Network.handleConnection: verified, else a fresh identity) — a cluster
//     ingress forwards the identity cookie and nothing else (identityCookieOf) — and the session keeps its `sub`; after
//     each welcome the page gets its own token (id.token, to that socket only) for the stats export.
//   * POST /api/identity { token } (same origin, JSON, ≤ 1 KB): a page adopts a token it holds — the identity of an
//     imported stats file the player chose to switch to, or the one its socket was given without a cookie (`fresh`) —;
//     the MAC is checked, the cookie re-set, nothing stored. 204, else 400 / 403 / 413.
//   * Key files (SP_IDENTITY_KEY_FILE, SP_RESULT_KEY_FILE; loadKeyring): text, one generation per line `<label> <key>`
//     (key: base64 / base64url of at least 32 bytes), the first signs, a second one (the previous generation) is still
//     accepted. An identity token is re-signed on every visit, so rotating the identity key at most once per 400 days
//     (the cookie's life) keeps every living cookie valid. Unset: an ephemeral key per process (identities and receipts
//     then die with it — LAN play, tests); set but unreadable or malformed: the server does not start. Never logged.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { open, constants } from 'node:fs/promises';
import path from 'node:path';
import { ID_COOKIE, idTokenBody, parseIdToken } from '../shared/receipts.js';
import { isLocalIp, normalizeIp } from './net.js';

/** POST /api/identity: the path, and the largest body it reads. */
export const IDENTITY_PATH = '/api/identity';
const MAX_BODY = 1024;
const LABEL = /^[A-Za-z0-9_-]{1,16}$/;
const MAX_KEY_FILE = 4096;

/**
 * @typedef {{ k: string, keys: ReadonlyMap<string, Buffer>, ephemeral: boolean }} Keyring
 *   k the current (signing) generation; keys every accepted one; ephemeral: made up for this process (no file)
 */

/**
 * A key ring from its lines (`<label> <key>`, the first one current; '#' comments and blank lines ignored), or a
 * TypeError naming what is wrong (never a key's bytes). At most two generations.
 * @param {string} text @returns {Keyring}
 */
export function parseKeyring(text) {
  const keys = new Map();
  let k = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+)\s+(\S+)$/.exec(line);
    if (!m || !LABEL.test(m[1]) || keys.has(m[1])) throw new TypeError('key file: one "<label> <base64 key>" per line, labels unique');
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(m[2])) throw new TypeError('key file: the key must be base64');
    const key = Buffer.from(m[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (key.length < 32) throw new TypeError('key file: a key needs at least 32 bytes');
    keys.set(m[1], key);
    k ??= m[1];
  }
  if (!k) throw new TypeError('key file: no key');
  if (keys.size > 2) throw new TypeError('key file: at most two generations (current, previous)');
  return Object.freeze({ k, keys, ephemeral: false });
}

/** A key ring for this process only (no key file). @param {string} [k] @returns {Keyring} */
export const ephemeralKeyring = (k = 'tmp') => Object.freeze({ k, keys: new Map([[k, randomBytes(32)]]), ephemeral: true });

/**
 * The key ring of `file` (an absolute path outside the checkout, a regular file the server's user or root owns, not
 * readable by others), an ephemeral one when `file` is empty. Throws on anything else.
 * @param {string | null | undefined} file @param {{ what: string, log?: { info: Function } }} opts
 * @returns {Promise<Keyring>}
 */
export async function loadKeyring(file, { what, log } = /** @type {any} */ ({})) {
  if (!file) {
    log?.info?.(`[${what}] no key file: an ephemeral key (void after a restart)`);
    return ephemeralKeyring();
  }
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file || file.includes('\0')) throw new TypeError(`${what}: the key file needs an absolute path`);
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat(), uid = process.getuid?.();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_KEY_FILE || (uid != null && stat.uid !== uid && stat.uid !== 0) || (stat.mode & 0o077) !== 0) {
      throw new TypeError(`${what}: the key file must be a small regular file only its owner can read`);
    }
    const ring = parseKeyring(await handle.readFile('utf8'));
    log?.info?.(`[${what}] key file loaded: ${ring.keys.size} generation(s)`);
    return ring;
  } catch (e) {
    if (e instanceof TypeError) throw e;
    throw new TypeError(`${what}: the key file cannot be read`, { cause: e });
  } finally { await handle?.close(); }
}

const mac = (key, body) => createHmac('sha256', key).update(body).digest('base64url');
const sameMac = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * The value of the identity cookie a request carries — `__Host-sp_id` on https, `sp_id` on http, nothing else read —,
 * or null. No key needed (a cluster ingress forwards it with this).
 * @param {string | undefined} header the Cookie header @param {boolean} secure
 */
export function identityCookieOf(header, secure) {
  if (typeof header !== 'string' || header.length > 16 * 1024) return null;
  const name = secure ? ID_COOKIE.secure : ID_COOKIE.plain;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value && value.length <= 256 ? value : null;
    }
  }
  return null;
}

/**
 * Did the browser reach us over https? The socket's own TLS, else a trusted proxy's X-Forwarded-Proto (the trust rule
 * of net.js clientAddress: `trustProxy` true, or 'auto' with a loopback / private peer).
 * @param {any} req @param {'auto' | boolean} [trustProxy]
 */
export function requestSecure(req, trustProxy = 'auto') {
  if (req?.socket?.encrypted) return true;
  const peer = normalizeIp(req?.socket?.remoteAddress);
  const trusted = trustProxy === true || (trustProxy !== false && (!peer || isLocalIp(peer)));
  const proto = req?.headers?.['x-forwarded-proto'];
  return trusted && typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https';
}

/**
 * @typedef {{ token: string, k: string, id: string, sub: string, iat: number }} Identity
 */

/**
 * The identity authority: issue, verify and re-sign tokens, read and set the cookie, answer POST /api/identity.
 * @param {{ keys: Keyring, now?: () => number, trustProxy?: 'auto' | boolean }} opts
 */
export function createIdentity({ keys, now = Date.now, trustProxy = 'auto' }) {
  if (!keys || !keys.keys?.get(keys.k)) throw new TypeError('identity: a key ring is required');
  const counts = { issued: 0, refreshed: 0, invalid: 0, adopted: 0 };
  const sign = (k, id, sub, iat) => {
    const body = idTokenBody({ k, id, sub, iat });
    return /** @type {Identity} */ (Object.freeze({ token: `${body}.${mac(keys.keys.get(k), body)}`, k, id, sub, iat }));
  };

  /** A new identity, or `prev` (verified) re-signed with the current key and time — the same id and sub. @param {Identity | null} [prev] */
  function issue(prev = null) {
    if (prev) { counts.refreshed++; return sign(keys.k, prev.id, prev.sub, now()); }
    counts.issued++;
    const id = randomBytes(16).toString('base64url');
    const sub = createHmac('sha256', keys.keys.get(keys.k)).update(`sub|${id}`).digest().subarray(0, 16).toString('base64url');
    return sign(keys.k, id, sub, now());
  }

  /** The identity of a token whose MAC holds under one of the accepted generations, else null. @param {unknown} token */
  function verify(token) {
    const f = parseIdToken(token);
    const key = f ? keys.keys.get(f.k) : null;
    if (!f || !key || !sameMac(mac(key, f.body), f.mac) || f.iat > now() + 60_000) { if (token != null) counts.invalid++; return null; }
    return /** @type {Identity} */ (Object.freeze({ token: /** @type {string} */ (token), k: f.k, id: f.id, sub: f.sub, iat: f.iat }));
  }

  /** The Set-Cookie value of an identity. @param {Identity} who @param {boolean} secure */
  const cookie = (who, secure) => `${secure ? ID_COOKIE.secure : ID_COOKIE.plain}=${who.token}; Path=/; Max-Age=${ID_COOKIE.maxAgeSec}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

  /**
   * The identity a request carries, re-signed (a valid cookie), else a new one (`fresh`): what a page load and an
   * upgrade set, and what a socket's session takes. @param {any} req
   */
  function fromRequest(req) {
    const secure = requestSecure(req, trustProxy);
    const had = verify(identityCookieOf(req?.headers?.cookie, secure));
    return { identity: issue(had), fresh: !had, secure };
  }

  /** Add the Set-Cookie header of `who` to a response (keeping any other one). @param {any} res @param {Identity} who @param {boolean} secure */
  function setCookie(res, who, secure) {
    const prev = res.getHeader?.('Set-Cookie');
    const list = prev == null ? [] : Array.isArray(prev) ? prev : [String(prev)];
    res.setHeader('Set-Cookie', [...list, cookie(who, secure)]);
  }

  /** A page load: set (refresh) the cookie on its response. @param {any} req @param {any} res */
  function onPage(req, res) {
    const { identity, secure } = fromRequest(req);
    setCookie(res, identity, secure);
  }

  /**
   * POST /api/identity (see the header). Same origin only (Origin's host = Host), JSON `{ token }`; answers 204 with the
   * cookie set, 400 for a token that does not verify. @param {any} req @param {any} res
   */
  function handlePost(req, res) {
    const answer = (status) => { res.statusCode = status; res.setHeader('Cache-Control', 'no-store'); res.end(); };
    let origin;
    try { origin = new URL(String(req.headers.origin)).host; } catch { origin = null; }
    if (!origin || origin !== req.headers.host) { req.resume(); answer(403); return; }
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) { req.resume(); answer(415); return; }
    let size = 0, chunks = [], over = false;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) over = true; else chunks.push(c); });
    req.on('end', () => {
      if (over) { answer(413); return; }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      const who = body && typeof body === 'object' ? verify(body.token) : null;
      if (!who) { answer(400); return; }
      counts.adopted++;
      setCookie(res, issue(who), requestSecure(req, trustProxy));
      answer(204);
    });
    req.on('error', () => answer(400));
  }

  return Object.freeze({ issue, verify, fromRequest, setCookie, cookie, onPage, handlePost,
    /** /healthz: aggregate counts only, never a token or a sub */
    stats: () => ({ keys: keys.ephemeral ? 'ephemeral' : 'file', generations: keys.keys.size, ...counts }) });
}
