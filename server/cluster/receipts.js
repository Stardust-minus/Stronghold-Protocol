// Low-frequency end/replay receipts only. The caller binds opsForNode(nodeId)
// to that fixed node's authenticated private RPC handler; no payload selects an
// authority. Nothing here logs/persists receipts or starts a cleanup daemon.
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { TextDecoder } from 'node:util';
import { RpcError } from './rpc.js';

const CHUNK_BYTES = 24 * 1024;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
const MAX_TTL_MS = 60_000;
// Also bound tiny receipts and tombstones, independently of player counts.
const MAX_RECORDS = 1024;
const RETRY_DELAYS = [25, 75, 150];
const RETRYABLE = new Set(['TRANSPORT', 'TIMEOUT', 'BAD_REPLY']);
const ERROR_CODES = new Set(['BAD_REQUEST', 'EVENT_CONFLICT', 'STALE_ASSIGNMENT', 'NOT_READY', 'BUSY', 'CLOSED',
  'ABORTED', 'TRANSPORT', 'TIMEOUT', 'BAD_REPLY', 'TOO_LARGE', 'UNAUTHORIZED', 'UNKNOWN_OPERATION',
  'INTERNAL', 'NOT_FOUND', 'METHOD', 'CONTENT_TYPE']);
const RECEIPT_KEYS = ['assignmentId', 'generation', 'summary', 'lastPublic', 'results'];
const META_KEYS = ['assignmentId', 'nodeGeneration', 'actorGeneration', 'parts', 'totalBytes', 'sha256'];
const CHUNK_KEYS = [...META_KEYS, 'index', 'data'];
const plain = v => !!v && typeof v === 'object'
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const keys = (v, allowed) => plain(v) && Reflect.ownKeys(v).length === allowed.length
  && Reflect.ownKeys(v).every(k => allowed.includes(k));
const id = v => typeof v === 'string' && v.length > 0 && v.length <= 128
  && /^[A-Za-z0-9_-][A-Za-z0-9_.:-]*(?![\s\S])/.test(v);
const integer = (v, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new RpcError(code); };
const accepted = Object.freeze({ accepted: true });
const applied = Object.freeze({ accepted: true, pending: false });
const pending = Object.freeze({ accepted: true, pending: true });
const absent = Object.freeze({ accepted: false });

function receiptShape(receipt, assignmentId, actorGeneration) {
  return keys(receipt, RECEIPT_KEYS) && id(receipt.assignmentId) && integer(receipt.generation, 1)
    && receipt.assignmentId === assignmentId && receipt.generation === actorGeneration
    && (receipt.lastPublic === null || (plain(receipt.lastPublic) && receipt.lastPublic.t === 'm.public')) && plain(receipt.results)
    && Object.values(receipt.results).every(v => plain(v) && v.t === 'm.result');
  // summary is the host's JSON DTO, not an invented settlement. Full message
  // schemas, replay own-keys and membership remain lobby.receiveEnd's authority.
}

function parseReceipt(bytes, meta) {
  try {
    // Fatal decoding rejects malformed UTF-8; keeping a BOM makes JSON reject it
    // instead of silently treating a different wire document as valid JSON.
    const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    if (!receiptShape(receipt, meta.assignmentId, meta.actorGeneration)) fail('BAD_REQUEST');
    return receipt;
  } catch { fail('BAD_REQUEST'); }
}

function checkReply(value, commit) {
  if (commit ? !keys(value, ['accepted', 'pending']) || value.accepted !== true || typeof value.pending !== 'boolean'
    : !keys(value, ['accepted']) || value.accepted !== true) fail('BAD_REPLY');
  return value;
}

async function callWithRetry(client, op, payload, signal) {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) fail('ABORTED');
    try {
      // Each invocation, including retries, gets a fresh id/HMAC nonce from the
      // existing RPC client. Never reuse a signed request or replay its headers.
      return checkReply(await client.call(op, payload, { signal }), op === 'end.commit');
    } catch (error) {
      const code = signal?.aborted ? 'ABORTED' : ERROR_CODES.has(error?.code) ? error.code : 'INTERNAL';
      if (!RETRYABLE.has(code) || attempt >= RETRY_DELAYS.length) fail(code);
      try { await delay(RETRY_DELAYS[attempt], undefined, { signal }); }
      catch { fail(signal?.aborted ? 'ABORTED' : 'INTERNAL'); }
    }
  }
}

/** Resolves to the commit acknowledgement, or explicitly rejects; no queue. */
export async function sendEndReceipt({ client, nodeGeneration, receipt, signal } = {}) {
  let bytes;
  try {
    if (!client || typeof client.call !== 'function' || !id(nodeGeneration)
      || !receiptShape(receipt, receipt?.assignmentId, receipt?.generation)
      || (signal !== undefined && (typeof signal?.aborted !== 'boolean'
        || typeof signal?.addEventListener !== 'function' || typeof signal?.removeEventListener !== 'function'))) fail('BAD_REQUEST');
    bytes = Buffer.from(JSON.stringify(receipt), 'utf8');
    if (!integer(bytes.length, 1, MAX_BYTES)) fail('BAD_REQUEST');
    // Reject disappearing fields/toJSON substitutions instead of synthesising
    // missing end data. The source DTO itself is never mutated.
    parseReceipt(bytes, { assignmentId: receipt.assignmentId, actorGeneration: receipt.generation });
  } catch { fail('BAD_REQUEST'); }
  const meta = Object.freeze({ assignmentId: receipt.assignmentId, nodeGeneration, actorGeneration: receipt.generation,
    parts: Math.ceil(bytes.length / CHUNK_BYTES), totalBytes: bytes.length, sha256: hash(bytes) });
  for (let index = 0; index < meta.parts; index++) {
    const data = bytes.subarray(index * CHUNK_BYTES, Math.min((index + 1) * CHUNK_BYTES, bytes.length)).toString('base64url');
    await callWithRetry(client, 'end.chunk', Object.freeze({ ...meta, index, data }), signal);
  }
  return callWithRetry(client, 'end.commit', meta, signal);
}

/**
 * Byte budget reserves totalBytes on the first chunk (not just received bytes).
 * Pending completed receipts keep only their validated UTF-8 buffer, not a
 * second parsed DTO. Validation temporarily assembles at most one maxBytes DTO.
 * At most MAX_RECORDS records, including compact per-part-hash tombstones, live
 * at once. Deadlines never renew on a retry. The coordinator owns sweep calls.
 */
export function createReceiptSink({ platform, lobby, now = Date.now, maxBytes = MAX_BYTES,
  maxBufferedBytes = MAX_BUFFERED_BYTES, ttlMs = 15_000 } = {}) {
  if (!platform || typeof platform.assignmentInfo !== 'function' || !lobby || typeof lobby.receiveEnd !== 'function'
    || !lobby.assignments || typeof lobby.assignments.has !== 'function' || typeof now !== 'function') throw new TypeError('invalid receipt sink');
  if (!integer(maxBytes, 1, MAX_BYTES) || !integer(maxBufferedBytes, 1, MAX_BUFFERED_BYTES)
    || !integer(ttlMs, 1, MAX_TTL_MS)) throw new RangeError('invalid receipt budget');
  const records = new Map();
  let bufferedBytes = 0, closed = false;
  const clock = () => { const t = now(); if (!integer(t, 0, Number.MAX_SAFE_INTEGER - ttlMs)) fail('INTERNAL'); return t; };
  const open = () => { if (closed) fail('CLOSED'); };
  const discard = entry => {
    if (records.get(entry.meta.assignmentId) !== entry) return;
    bufferedBytes -= entry.bytes;
    records.delete(entry.meta.assignmentId);
  };
  const matches = (entry, info) => !!info && info.assignmentId === entry.meta.assignmentId && info.nodeId === entry.nodeId
    && info.generation === entry.meta.nodeGeneration && info.actorGeneration === entry.meta.actorGeneration;
  const currentOrReleased = (entry, info) => matches(entry, info) || (!info && entry.state === 'applied');
  const authorize = (nodeId, meta) => {
    const info = platform.assignmentInfo(meta.assignmentId);
    if (!matches({ nodeId, meta }, info)) {
      // receiveEnd(true) can synchronously release an already-left room. Only
      // that exact authenticated epoch/body's short-lived tombstone may ACK
      // retries without a platform record; a new receipt still fails closed.
      const entry = records.get(meta.assignmentId);
      if (info || !entry || entry.state !== 'applied' || entry.nodeId !== nodeId || !sameMeta(entry.meta, meta)) fail('STALE_ASSIGNMENT');
    }
    return info;
  };
  const checkMeta = (payload, chunk) => {
    try {
      if (!keys(payload, chunk ? CHUNK_KEYS : META_KEYS) || !id(payload.assignmentId)
        || !id(payload.nodeGeneration) || !integer(payload.actorGeneration, 1)
        || !integer(payload.totalBytes, 1, maxBytes) || payload.parts !== Math.ceil(payload.totalBytes / CHUNK_BYTES)
        || typeof payload.sha256 !== 'string' || !/^[a-f0-9]{64}(?![\s\S])/.test(payload.sha256)) fail('BAD_REQUEST');
      if (chunk && (!integer(payload.index, 0, payload.parts - 1) || typeof payload.data !== 'string')) fail('BAD_REQUEST');
      return Object.freeze(Object.fromEntries(META_KEYS.map(k => [k, payload[k]])));
    } catch { fail('BAD_REQUEST'); }
  };
  const decodeChunk = payload => {
    const size = Math.min(CHUNK_BYTES, payload.totalBytes - payload.index * CHUNK_BYTES);
    const encodedSize = Math.ceil(size * 4 / 3);
    if (payload.data.length !== encodedSize || !/^[A-Za-z0-9_-]+(?![\s\S])/.test(payload.data)) fail('BAD_REQUEST');
    const bytes = Buffer.from(payload.data, 'base64url');
    if (bytes.length !== size || bytes.toString('base64url') !== payload.data) fail('BAD_REQUEST');
    return bytes;
  };
  const sameMeta = (a, b) => META_KEYS.every(k => a[k] === b[k]);
  const sweep = () => {
    if (!closed) {
      const t = clock();
      for (const entry of records.values()) {
        if (!entry.applying && (entry.until <= t || !currentOrReleased(entry, platform.assignmentInfo(entry.meta.assignmentId)))) discard(entry);
      }
    }
    let tombstones = 0;
    for (const entry of records.values()) if (entry.state === 'applied') tombstones++;
    return Object.freeze({ bufferedBytes, receipts: records.size - tombstones, tombstones });
  };
  const lookup = (nodeId, meta, info) => {
    let entry = records.get(meta.assignmentId);
    if (entry && !currentOrReleased(entry, info)) { discard(entry); entry = null; }
    if (entry && (entry.nodeId !== nodeId || !sameMeta(entry.meta, meta))) fail('EVENT_CONFLICT');
    return entry;
  };
  const apply = (entry, info) => {
    if (entry.state === 'applied') return applied;
    if (entry.applying) fail('NOT_READY');
    if (info.state !== 'published' || !lobby.assignments.has(entry.meta.assignmentId)) return pending;
    const receipt = parseReceipt(entry.body, entry.meta);
    let ok;
    entry.applying = true;
    try {
      ok = lobby.receiveEnd(entry.meta.assignmentId, { assignmentId: entry.meta.assignmentId, roomCode: info.roomCode,
        generation: info.generation, summary: receipt.summary, lastPublic: receipt.lastPublic, results: receipt.results }) === true;
    } catch { ok = false; }
    finally { entry.applying = false; }
    // receiveEnd is synchronous. Its callbacks can release/reassign the room;
    // never carry an acknowledgement/tombstone into a different node/actor epoch.
    if (closed) fail('CLOSED');
    const afterInfo = platform.assignmentInfo(entry.meta.assignmentId);
    if ((afterInfo && !matches(entry, afterInfo)) || (!afterInfo && !ok)) { discard(entry); fail('STALE_ASSIGNMENT'); }
    if (!ok) { discard(entry); fail('BAD_REQUEST'); }
    bufferedBytes -= entry.bytes;
    entry.bytes = 0;
    entry.body = null;
    entry.state = 'applied';
    entry.until = clock() + ttlMs;
    return applied;
  };
  const chunk = (nodeId, payload) => {
    open();
    const meta = checkMeta(payload, true), bytes = decodeChunk(payload);
    sweep();
    const info = authorize(nodeId, meta);
    let entry = lookup(nodeId, meta, info);
    const digest = hash(bytes);
    if (entry?.hashes[payload.index] !== undefined) {
      if (entry.hashes[payload.index] !== digest) fail('EVENT_CONFLICT');
      return accepted;
    }
    if (!entry) {
      if (records.size >= MAX_RECORDS || bufferedBytes + meta.totalBytes > maxBufferedBytes) fail('BUSY');
      entry = { nodeId, meta, state: 'receiving', bytes: meta.totalBytes, until: clock() + ttlMs,
        chunks: new Array(meta.parts), hashes: new Array(meta.parts), received: 0, body: null, applying: false };
      records.set(meta.assignmentId, entry);
      bufferedBytes += entry.bytes;
    }
    entry.chunks[payload.index] = bytes;
    entry.hashes[payload.index] = digest;
    entry.received++;
    return accepted;
  };
  const commit = (nodeId, payload) => {
    open();
    const meta = checkMeta(payload, false);
    sweep();
    const info = authorize(nodeId, meta);
    const entry = lookup(nodeId, meta, info);
    if (!entry || entry.received !== meta.parts) fail('NOT_READY');
    if (entry.state === 'receiving') {
      try {
        const bytes = Buffer.concat(entry.chunks, meta.totalBytes);
        if (bytes.length !== meta.totalBytes || hash(bytes) !== meta.sha256) fail('BAD_REQUEST');
        parseReceipt(bytes, meta);
        entry.body = bytes;
        entry.chunks = null;
        entry.state = 'complete';
      } catch { discard(entry); fail('BAD_REQUEST'); }
    }
    return apply(entry, info);
  };
  const flush = assignmentId => {
    open();
    if (!id(assignmentId)) fail('BAD_REQUEST');
    sweep();
    const entry = records.get(assignmentId);
    if (!entry || entry.state === 'receiving') return absent;
    return apply(entry, authorize(entry.nodeId, entry.meta));
  };
  const opsForNode = nodeId => {
    open();
    if (!id(nodeId)) throw new TypeError('invalid receipt node');
    return Object.freeze({ 'end.chunk': payload => chunk(nodeId, payload), 'end.commit': payload => commit(nodeId, payload) });
  };
  const close = () => { closed = true; records.clear(); bufferedBytes = 0; };
  return Object.freeze({ opsForNode, flush, sweep, close });
}
