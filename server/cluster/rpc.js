// Private, bounded control RPC. Browser requests never select a target URL or key.
// Signatures are headers, not URL parameters; neither bodies nor headers are logged.
import http from 'node:http';
import https from 'node:https';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PATH = '/_cluster/rpc';
const MAX_BYTES = 64 * 1024;
const safeId = v => typeof v === 'string' && v.length > 0 && v.length <= 128 && /^[A-Za-z0-9_-][A-Za-z0-9_.:-]*(?![\s\S])/.test(v);
const plain = v => !!v && Object.getPrototypeOf(v) === Object.prototype;
const keys = (v, allowed) => plain(v) && Object.keys(v).length === allowed.length && Object.keys(v).every(k => allowed.includes(k));
const safeTime = v => Number.isSafeInteger(v) && v >= 0;

export class RpcError extends Error {
  constructor(code) { super(code); this.name = 'RpcError'; this.code = code; }
}

export function createRpcAuthenticator({ key, scope, now = Date.now, maxAgeMs = 10_000, maxFutureMs = 1000 }) {
  if (!Buffer.isBuffer(key) || key.length < 32 || !safeId(scope) || typeof now !== 'function') throw new TypeError('invalid RPC authority');
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 30_000
    || !Number.isSafeInteger(maxFutureMs) || maxFutureMs < 0 || maxFutureMs > 2000) throw new RangeError('invalid RPC time budget');
  const signingKey = Buffer.from(key), seen = new Map();
  const clock = () => { const t = now(); if (!safeTime(t)) throw new RangeError('invalid RPC clock'); return t; };
  const digest = (timestamp, nonce, body) => createHmac('sha256', signingKey)
    .update(`stronghold-rpc-v1\nPOST\n${PATH}\n${scope}\n${timestamp}\n${nonce}\n`)
    .update(createHash('sha256').update(body).digest('hex')).digest();
  const sign = body => {
    if (!Buffer.isBuffer(body) || body.length > MAX_BYTES) throw new TypeError('invalid RPC body');
    const timestamp = String(clock()), nonce = randomBytes(16).toString('hex');
    return { 'x-ark-cluster-scope': scope, 'x-ark-cluster-time': timestamp, 'x-ark-cluster-nonce': nonce,
      'x-ark-cluster-signature': digest(timestamp, nonce, body).toString('hex') };
  };
  const verify = (headers, body) => {
    try {
      if (!Buffer.isBuffer(body) || body.length > MAX_BYTES || !headers) return false;
      const timestamp = headers['x-ark-cluster-time'], nonce = headers['x-ark-cluster-nonce'], signature = headers['x-ark-cluster-signature'];
      if (headers['x-ark-cluster-scope'] !== scope || typeof timestamp !== 'string' || !/^(0|[1-9]\d{0,15})(?![\s\S])/.test(timestamp)
        || typeof nonce !== 'string' || !/^[a-f0-9]{32}(?![\s\S])/.test(nonce)
        || typeof signature !== 'string' || !/^[a-f0-9]{64}(?![\s\S])/.test(signature)) return false;
      const at = Number(timestamp), t = clock();
      if (!safeTime(at) || at > t + maxFutureMs || at + maxAgeMs <= t) return false;
      if (!timingSafeEqual(Buffer.from(signature, 'hex'), digest(timestamp, nonce, body))) return false;
      for (const [id, until] of seen) if (until <= t) seen.delete(id);
      if (seen.has(nonce)) return false;
      seen.set(nonce, at + maxAgeMs);
      return true;
    } catch { return false; }
  };
  return Object.freeze({ sign, verify });
}

function readBody(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.removeListener('aborted', onAborted);
      if (error) reject(error); else resolve(value);
    };
    const onData = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) { stream.resume(); finish(new RpcError('TOO_LARGE')); return; }
      chunks.push(bytes);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks));
    const onError = () => finish(new RpcError('TRANSPORT'));
    const onAborted = () => finish(new RpcError('TRANSPORT'));
    stream.on('data', onData); stream.on('end', onEnd); stream.on('error', onError); stream.on('aborted', onAborted);
  });
}

function reply(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function createRpcHandler({ authority, operations, readTimeoutMs = 5000 }) {
  if (!authority || typeof authority.verify !== 'function' || !plain(operations)
    || !Object.entries(operations).every(([name, fn]) => safeId(name) && typeof fn === 'function')) throw new TypeError('invalid RPC handler');
  if (!Number.isSafeInteger(readTimeoutMs) || readTimeoutMs < 1 || readTimeoutMs > 10_000) throw new RangeError('invalid RPC read deadline');
  return async (req, res) => {
    if (req.url !== PATH) { reply(res, 404, { ok: false, code: 'NOT_FOUND' }); return; }
    if (req.method !== 'POST') { reply(res, 405, { ok: false, code: 'METHOD' }); return; }
    if (req.headers['content-type'] !== 'application/json') { reply(res, 415, { ok: false, code: 'CONTENT_TYPE' }); return; }
    const declared = req.headers['content-length'];
    if (declared != null && (!/^\d+(?![\s\S])/.test(declared) || Number(declared) > MAX_BYTES)) {
      reply(res, 413, { ok: false, code: 'TOO_LARGE' }); req.resume(); return;
    }
    const timer = setTimeout(() => { reply(res, 408, { ok: false, code: 'TIMEOUT' }); req.destroy(); }, readTimeoutMs);
    timer.unref?.();
    let body;
    try { body = await readBody(req, MAX_BYTES); }
    catch (e) { clearTimeout(timer); reply(res, e?.code === 'TOO_LARGE' ? 413 : 400, { ok: false, code: e?.code === 'TOO_LARGE' ? 'TOO_LARGE' : 'BAD_REQUEST' }); return; }
    clearTimeout(timer);
    if (!authority.verify(req.headers, body)) { reply(res, 401, { ok: false, code: 'UNAUTHORIZED' }); return; }
    let message;
    try { message = JSON.parse(body.toString('utf8')); } catch { reply(res, 400, { ok: false, code: 'BAD_REQUEST' }); return; }
    if (!keys(message, ['id', 'op', 'payload']) || !safeId(message.id) || !safeId(message.op) || !plain(message.payload)) {
      reply(res, 400, { ok: false, code: 'BAD_REQUEST' }); return;
    }
    if (!Object.hasOwn(operations, message.op)) { reply(res, 404, { id: message.id, ok: false, code: 'UNKNOWN_OPERATION' }); return; }
    try {
      const value = await operations[message.op](message.payload);
      const encoded = JSON.stringify({ id: message.id, ok: true, value: value ?? null });
      if (Buffer.byteLength(encoded) > MAX_BYTES) throw new RpcError('TOO_LARGE');
      reply(res, 200, JSON.parse(encoded));
    } catch (e) {
      // Only stable machine-readable codes cross the peer boundary, never a
      // stack, arbitrary error message, request body or admission credential.
      const code = e && safeId(e.code) ? e.code : 'INTERNAL';
      reply(res, 409, { id: message.id, ok: false, code });
    }
  };
}

export function createRpcClient({ url, authority, timeoutMs = 6000 }) {
  const endpoint = new URL(url);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !['/', PATH].includes(endpoint.pathname) || !authority || typeof authority.sign !== 'function') throw new TypeError('invalid RPC endpoint');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new RangeError('invalid RPC deadline');
  endpoint.pathname = PATH;
  const transport = endpoint.protocol === 'https:' ? https : http;
  const agent = new transport.Agent({ keepAlive: true, maxSockets: 8 });
  let closed = false;
  const call = (op, payload = {}, { signal } = {}) => {
    if (closed) return Promise.reject(new RpcError('CLOSED'));
    if (!safeId(op) || !plain(payload)) return Promise.reject(new RpcError('BAD_REQUEST'));
    const id = randomBytes(16).toString('hex');
    let body, headers;
    try { body = Buffer.from(JSON.stringify({ id, op, payload })); headers = authority.sign(body); }
    catch { return Promise.reject(new RpcError('BAD_REQUEST')); }
    if (signal?.aborted) return Promise.reject(new RpcError('ABORTED'));
    return new Promise((resolve, reject) => {
      let settled = false, timer;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const request = transport.request(endpoint, { method: 'POST', agent, headers: { ...headers, 'content-type': 'application/json', 'content-length': body.length } }, async res => {
        try {
          const bytes = await readBody(res, MAX_BYTES);
          const message = JSON.parse(bytes.toString('utf8'));
          if (res.statusCode !== 200 || !plain(message) || message.id !== id || message.ok !== true || !Object.hasOwn(message, 'value')) {
            finish(new RpcError(plain(message) && safeId(message.code) ? message.code : 'BAD_REPLY')); return;
          }
          finish(null, message.value);
        } catch { finish(new RpcError('BAD_REPLY')); }
      });
      const abort = () => { finish(new RpcError('ABORTED')); request.destroy(); };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { finish(new RpcError('TIMEOUT')); request.destroy(); }, timeoutMs);
      timer.unref?.();
      request.on('error', () => finish(new RpcError('TRANSPORT')));
      request.end(body);
    });
  };
  return Object.freeze({ call, close: () => { closed = true; agent.destroy(); } });
}
