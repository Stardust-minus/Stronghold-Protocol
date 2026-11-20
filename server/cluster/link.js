// Ingress ↔ coordinator multiplexed link (opt-in). One authenticated binary WebSocket per ingress (or two) carries every
// browser session of that ingress instead of one coordinator WebSocket per browser. Frames are single binary WS
// messages: [op u8][connId u32 BE][payload]. connIds are allocated by the ingress, strictly increasing per link and
// never reused, so a late frame can never reach a newer session. Any malformed frame drops the whole link; its sessions
// then disconnect and reconnect through the ordinary path. Nothing here logs keys, signatures or frame bodies.
//
//   OPEN   ingress→coordinator  JSON { ip, origin, proto, id? }: the forwarding facts the direct path sent as headers (`id`:
//                               the browser's identity cookie value, server/identity.js §37.276; absent without one)
//   DATA   both directions      one UTF-8 JSON text, exactly the text frame the direct path carried
//   CLOSE  both directions      u16 code + UTF-8 reason (1006 = abnormal: refused admission, terminate, transport loss)
//   FANOUT coordinator→ingress  [op][count u32] count × [connId u32][prefixLen u32][suffixLen u32], the prefixes and
//                               suffixes in that order, then one shared payload: target i receives prefix_i+shared+suffix_i
//                               as if it were a DATA frame at this position of the stream (presence, room state, end frames)
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isUtf8 } from 'node:buffer';

export const LINK_PATH = '/_cluster/link';
export const OP = Object.freeze({ OPEN: 1, DATA: 2, CLOSE: 3, FANOUT: 4 });
export const MAX_CONN_ID = 0x7fffffff;
/** A coordinator frame may be as large as one direct control frame could be (net.js hardBufferBytes). */
export const MAX_LINK_FRAME = 16 * 1024 * 1024;
/** Browser frames are bounded by the ingress/coordinator WS limit (http/websocket.js WS_MAX_PAYLOAD). */
export const MAX_CLIENT_TEXT = 64 * 1024;
export const MAX_FANOUT_TARGETS = 4096;
export const MAX_CLOSE_REASON = 123;
export const ABNORMAL = 1006;
const HEADER = 5;
const id = v => typeof v === 'string' && v.length > 0 && v.length <= 64 && /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?![\s\S])/.test(v);
const plain = v => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

export class LinkProtocolError extends Error {
  constructor(code) { super(code); this.name = 'LinkProtocolError'; this.code = code; }
}
const fail = code => { throw new LinkProtocolError(code); };
const connIdOk = n => Number.isSafeInteger(n) && n >= 1 && n <= MAX_CONN_ID;

function frame(op, connId, payload) {
  const head = Buffer.allocUnsafe(HEADER);
  head[0] = op; head.writeUInt32BE(connId, 1);
  return payload.length ? Buffer.concat([head, payload]) : head;
}
const bytes = data => (Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));

export function encodeOpen(connId, { ip, origin, proto, id = null }) {
  if (!connIdOk(connId)) fail('BAD_CONN');
  return frame(OP.OPEN, connId, Buffer.from(JSON.stringify({ ip, origin, proto, ...(id ? { id } : {}) })));
}
export function encodeData(connId, data) {
  if (!connIdOk(connId)) fail('BAD_CONN');
  return frame(OP.DATA, connId, bytes(data));
}
export function encodeClose(connId, code = 1000, reason = '') {
  if (!connIdOk(connId)) fail('BAD_CONN');
  const text = Buffer.from(String(reason ?? ''), 'utf8').subarray(0, MAX_CLOSE_REASON);
  const payload = Buffer.allocUnsafe(2 + text.length);
  payload.writeUInt16BE(Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : ABNORMAL, 0);
  text.copy(payload, 2);
  return frame(OP.CLOSE, connId, payload);
}
/** @param {{ connId: number, prefix?: Buffer | string, suffix?: Buffer | string }[]} targets @param {Buffer | string} shared */
export function encodeFanout(targets, shared) {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > MAX_FANOUT_TARGETS) fail('BAD_FANOUT');
  const table = Buffer.allocUnsafe(targets.length * 12), parts = [];
  targets.forEach((target, i) => {
    if (!connIdOk(target.connId)) fail('BAD_CONN');
    const prefix = target.prefix ? bytes(target.prefix) : null, suffix = target.suffix ? bytes(target.suffix) : null;
    table.writeUInt32BE(target.connId, i * 12);
    table.writeUInt32BE(prefix?.length ?? 0, i * 12 + 4);
    table.writeUInt32BE(suffix?.length ?? 0, i * 12 + 8);
    if (prefix?.length) parts.push(prefix);
    if (suffix?.length) parts.push(suffix);
  });
  return frame(OP.FANOUT, targets.length, Buffer.concat([table, ...parts, bytes(shared)]));
}

function text(buffer, max, code) {
  if (buffer.length > max || !isUtf8(buffer)) fail(code);
  return buffer;
}

/**
 * Strict decode of one link message. `from` is the sender: 'ingress' or 'coordinator'. Throws LinkProtocolError.
 * @returns {{ op: number, connId?: number, info?: object, data?: Buffer, code?: number, reason?: string,
 *   targets?: { connId: number, prefix: Buffer, suffix: Buffer }[], shared?: Buffer }}
 */
export function decodeFrame(message, from) {
  if (!Buffer.isBuffer(message) || message.length < HEADER || message.length > MAX_LINK_FRAME) fail('BAD_FRAME');
  const op = message[0], n = message.readUInt32BE(1), payload = message.subarray(HEADER);
  if (op === OP.FANOUT) {
    if (from !== 'coordinator' || n < 1 || n > MAX_FANOUT_TARGETS || payload.length < n * 12) fail('BAD_FANOUT');
    let offset = n * 12;
    const targets = [], seen = new Set();
    for (let i = 0; i < n; i++) {
      const connId = payload.readUInt32BE(i * 12), prefixLength = payload.readUInt32BE(i * 12 + 4), suffixLength = payload.readUInt32BE(i * 12 + 8);
      if (!connIdOk(connId) || seen.has(connId) || offset + prefixLength + suffixLength > payload.length) fail('BAD_FANOUT');
      seen.add(connId);
      const prefix = text(payload.subarray(offset, offset + prefixLength), MAX_LINK_FRAME, 'BAD_UTF8');
      offset += prefixLength;
      const suffix = text(payload.subarray(offset, offset + suffixLength), MAX_LINK_FRAME, 'BAD_UTF8');
      offset += suffixLength;
      targets.push({ connId, prefix, suffix });
    }
    return { op, targets, shared: text(payload.subarray(offset), MAX_LINK_FRAME, 'BAD_UTF8') };
  }
  if (!connIdOk(n)) fail('BAD_CONN');
  if (op === OP.OPEN) {
    if (from !== 'ingress' || payload.length > 1024) fail('BAD_OPEN');
    let info;
    try { info = JSON.parse(text(payload, 1024, 'BAD_OPEN').toString('utf8')); } catch { fail('BAD_OPEN'); }
    const keys = Object.keys(info || {});
    if (!plain(info) || keys.length !== (Object.hasOwn(info, 'id') ? 4 : 3) || typeof info.ip !== 'string' || info.ip.length < 1 || info.ip.length > 64
      || typeof info.origin !== 'string' || info.origin.length > 512 || !['http', 'https'].includes(info.proto)
      || (Object.hasOwn(info, 'id') && !(typeof info.id === 'string' && /^[A-Za-z0-9_.-]{1,256}$/.test(info.id)))) fail('BAD_OPEN');
    return { op, connId: n, info };
  }
  if (op === OP.DATA) {
    if (!payload.length) fail('BAD_DATA');
    return { op, connId: n, data: text(payload, from === 'ingress' ? MAX_CLIENT_TEXT : MAX_LINK_FRAME, 'BAD_DATA') };
  }
  if (op === OP.CLOSE) {
    if (payload.length < 2 || payload.length > 2 + MAX_CLOSE_REASON) fail('BAD_CLOSE');
    const code = payload.readUInt16BE(0);
    if (code < 1000 || code > 4999) fail('BAD_CLOSE');
    return { op, connId: n, code, reason: text(payload.subarray(2), MAX_CLOSE_REASON, 'BAD_CLOSE').toString('utf8') };
  }
  fail('UNKNOWN_OP');
}

// ---------------------------------------------------------------------------------------------------------------------
// Authentication: the ingress signs its upgrade request with its own 32-byte link key (HMAC-SHA256, the node-RPC scheme
// with a separate domain); the coordinator proves knowledge of the same key in its 101 response. Nonces are single use.
// ---------------------------------------------------------------------------------------------------------------------
const DOMAIN = 'stronghold-link-v1';
const hexOf = (key, text) => createHmac('sha256', key).update(text).digest('hex');
const sameHex = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && /^[a-f0-9]{64}(?![\s\S])/.test(a)
  && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

export function createLinkAuthenticator({ key, scope, now = Date.now, maxAgeMs = 10_000, maxFutureMs = 1000 }) {
  if (!Buffer.isBuffer(key) || key.length < 32 || !id(scope) || typeof now !== 'function') throw new TypeError('invalid link authority');
  const signingKey = Buffer.from(key), seen = new Map();
  const request = (time, nonce) => `${DOMAIN}\nGET\n${LINK_PATH}\n${scope}\n${time}\n${nonce}\n`;
  const accept = nonce => `${DOMAIN}-accept\n${scope}\n${nonce}\n`;
  return Object.freeze({
    scope,
    sign() {
      const time = String(now()), nonce = randomBytes(16).toString('hex');
      return { 'x-ark-cluster-scope': scope, 'x-ark-cluster-time': time, 'x-ark-cluster-nonce': nonce,
        'x-ark-cluster-signature': hexOf(signingKey, request(time, nonce)) };
    },
    /** @returns {string | null} the accepted nonce */
    verify(headers) {
      try {
        const time = headers?.['x-ark-cluster-time'], nonce = headers?.['x-ark-cluster-nonce'];
        if (headers['x-ark-cluster-scope'] !== scope || typeof time !== 'string' || !/^(0|[1-9]\d{0,15})(?![\s\S])/.test(time)
          || typeof nonce !== 'string' || !/^[a-f0-9]{32}(?![\s\S])/.test(nonce)) return null;
        const at = Number(time), t = now();
        if (!Number.isSafeInteger(at) || at > t + maxFutureMs || at + maxAgeMs <= t) return null;
        if (!sameHex(headers['x-ark-cluster-signature'], hexOf(signingKey, request(time, nonce)))) return null;
        for (const [n, until] of seen) if (until <= t) seen.delete(n);
        if (seen.has(nonce)) return null;
        seen.set(nonce, at + maxAgeMs);
        return nonce;
      } catch { return null; }
    },
    proof: nonce => hexOf(signingKey, accept(nonce)),
    verifyProof: (nonce, value) => { try { return sameHex(value, hexOf(signingKey, accept(nonce))); } catch { return false; } },
  });
}
