// Local transport/receipt tests only. Platform/lobby below are mocks: this is
// NOT actual Match settlement, browser gameplay, deployment or Node24 acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { createReceiptSink, sendEndReceipt } from '../server/cluster/receipts.js';
import { RpcError, createRpcAuthenticator, createRpcClient, createRpcHandler } from '../server/cluster/rpc.js';

const CHUNK_BYTES = 24 * 1024;
const MAX_BYTES = 2 * 1024 * 1024;
const NODE = 'game-a';
const NODE_GENERATION = 'game-a-generation';
const ACTOR_GENERATION = 17;
const AID = 'end-a';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const rpcCode = code => error => error instanceof RpcError && error.code === code && error.message === code;
const throwsCode = (fn, code) => assert.throws(fn, rpcCode(code));
const rejectsCode = (fn, code) => assert.rejects(fn, rpcCode(code));

function receipt(assignmentId = AID, text = 'end', generation = ACTOR_GENERATION) {
  return Object.freeze({ assignmentId, generation, summary: { placements: [{ uid: 'u1', rank: 1 }] },
    lastPublic: { t: 'm.public', round: 5, text }, results: { u1: { t: 'm.result', rank: 1, synthetic: false } } });
}

function wire(value, overrides = {}) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const meta = { assignmentId: AID, nodeGeneration: NODE_GENERATION, actorGeneration: ACTOR_GENERATION,
    parts: Math.ceil(bytes.length / CHUNK_BYTES), totalBytes: bytes.length, sha256: digest(bytes), ...overrides };
  const chunks = Array.from({ length: meta.parts }, (_, index) => ({ ...meta, index,
    data: bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString('base64url') }));
  return { bytes, meta, chunks };
}

function fixture(options = {}) {
  let time = 1000;
  const infos = new Map(), assignments = new Map(), calls = [], ended = new Set();
  let onReceive;
  const add = (assignmentId = AID, extra = {}, inLobby = true) => {
    infos.set(assignmentId, Object.freeze({ assignmentId, roomCode: 'ABCD', nodeId: NODE, generation: NODE_GENERATION,
      actorGeneration: ACTOR_GENERATION, build: 'test-build', protocol: 1, state: 'published', ...extra }));
    if (inLobby) assignments.set(assignmentId, {}); else assignments.delete(assignmentId);
  };
  add();
  const platform = { assignmentInfo: assignmentId => infos.get(assignmentId) ?? null };
  const lobby = { assignments, receiveEnd(assignmentId, value) {
    calls.push({ assignmentId, value: structuredClone(value) });
    // Mock the decisive receipt boundary, not actual game settlement/encoding.
    const info = infos.get(assignmentId);
    if (!assignments.has(assignmentId) || ended.has(assignmentId) || !info || value.assignmentId !== assignmentId
      || value.roomCode !== info.roomCode || value.generation !== info.generation
      || (value.lastPublic !== null && value.lastPublic.t !== 'm.public')
      || Object.entries(value.results).some(([uid, result]) => uid !== 'u1' || result.t !== 'm.result')) return false;
    if (onReceive && onReceive(assignmentId, value) === false) return false;
    ended.add(assignmentId);
    return true;
  } };
  const sink = createReceiptSink({ platform, lobby, now: () => time, ...options });
  const ops = sink.opsForNode(NODE);
  return { sink, ops, platform, lobby, calls, infos, assignments, add, ended,
    setTime: value => { time = value; }, setOnReceive: fn => { onReceive = fn; } };
}

function chunksInto(ops, document) {
  for (const payload of document.chunks) assert.deepEqual(ops['end.chunk'](payload), { accepted: true });
}
function complete(ops, document) { chunksInto(ops, document); return ops['end.commit'](document.meta); }

test('>64KiB receipt traverses real bounded HMAC RPC with fresh retry nonces and one mock apply', async t => {
  const f = fixture(), receivedSizes = [], signedNonces = [], operations = f.ops;
  const key = randomBytes(32), scope = NODE;
  const serverAuthority = createRpcAuthenticator({ key, scope });
  const signer = createRpcAuthenticator({ key, scope });
  const clientAuthority = { sign(body) {
    const headers = signer.sign(body);
    signedNonces.push(headers['x-ark-cluster-nonce']);
    return headers;
  } };
  let loseFirstChunk = true, loseFirstCommit = true;
  const observedOps = {
    'end.chunk': payload => {
      const value = operations['end.chunk'](payload);
      if (loseFirstChunk) { loseFirstChunk = false; throw new RpcError('TRANSPORT'); }
      return value;
    },
    'end.commit': payload => {
      const value = operations['end.commit'](payload);
      if (loseFirstCommit) { loseFirstCommit = false; throw new RpcError('BAD_REPLY'); }
      return value;
    },
  };
  const handler = createRpcHandler({ authority: serverAuthority, operations: observedOps });
  const server = http.createServer((req, res) => {
    receivedSizes.push(Number(req.headers['content-length']));
    return handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = createRpcClient({ url: `http://127.0.0.1:${server.address().port}`, authority: clientAuthority });
  t.after(async () => { client.close(); f.sink.close(); server.close(); server.closeAllConnections(); await once(server, 'close'); });
  const value = receipt(AID, '回放⭐'.repeat(18_000));
  assert.ok(Buffer.byteLength(JSON.stringify(value)) > 64 * 1024);
  assert.deepEqual(await sendEndReceipt({ client, nodeGeneration: NODE_GENERATION, receipt: value }), { accepted: true, pending: false });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].value, { assignmentId: AID, roomCode: 'ABCD', generation: NODE_GENERATION,
    summary: value.summary, lastPublic: value.lastPublic, results: value.results });
  assert.ok(receivedSizes.every(size => size <= 64 * 1024));
  assert.equal(new Set(signedNonces).size, signedNonces.length);
  assert.deepEqual(await sendEndReceipt({ client, nodeGeneration: NODE_GENERATION, receipt: value }), { accepted: true, pending: false });
  assert.equal(f.calls.length, 1);
  assert.equal(new Set(signedNonces).size, signedNonces.length);
  assert.deepEqual(f.sink.sweep(), { bufferedBytes: 0, receipts: 0, tombstones: 1 });
});

test('out-of-order chunks, identical retry and duplicate commit never apply before complete validation', () => {
  const f = fixture(), document = wire(receipt(AID, 'x'.repeat(70_000)));
  for (const payload of [...document.chunks].reverse()) {
    assert.deepEqual(f.ops['end.chunk'](payload), { accepted: true });
    assert.deepEqual(f.ops['end.chunk']({ ...payload }), { accepted: true });
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.sink.sweep().bufferedBytes, document.bytes.length);
  assert.deepEqual(f.ops['end.commit'](document.meta), { accepted: true, pending: false });
  assert.deepEqual(f.ops['end.commit']({ ...document.meta }), { accepted: true, pending: false });
  chunksInto(f.ops, document);
  assert.deepEqual(f.sink.flush(AID), { accepted: true, pending: false });
  assert.equal(f.calls.length, 1);
  const changed = Buffer.from(document.chunks[0].data, 'base64url'); changed[0] ^= 1;
  throwsCode(() => f.ops['end.chunk']({ ...document.chunks[0], data: changed.toString('base64url') }), 'EVENT_CONFLICT');
  throwsCode(() => f.ops['end.commit']({ ...document.meta, sha256: '0'.repeat(64) }), 'EVENT_CONFLICT');
  assert.equal(f.calls.length, 1);
});

test('missing chunks/early commits reject NOT_READY, keep good data, and never fabricate an end', () => {
  const f = fixture(), document = wire(receipt(AID, 'x'.repeat(50_000)));
  throwsCode(() => f.ops['end.commit'](document.meta), 'NOT_READY');
  assert.equal(f.sink.sweep().bufferedBytes, 0);
  f.ops['end.chunk'](document.chunks[0]);
  throwsCode(() => f.ops['end.commit'](document.meta), 'NOT_READY');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.sink.flush(AID), { accepted: false });
  for (const payload of document.chunks.slice(1)) f.ops['end.chunk'](payload);
  assert.deepEqual(f.ops['end.commit'](document.meta), { accepted: true, pending: false });
  assert.equal(f.calls.length, 1);
});

test('conflicting chunks/metadata cannot overwrite the original admitted receipt', () => {
  const f = fixture(), document = wire(receipt(AID, 'x'.repeat(60_000)));
  f.ops['end.chunk'](document.chunks[0]);
  const changed = Buffer.from(document.chunks[0].data, 'base64url'); changed[10] ^= 1;
  throwsCode(() => f.ops['end.chunk']({ ...document.chunks[0], data: changed.toString('base64url') }), 'EVENT_CONFLICT');
  throwsCode(() => f.ops['end.chunk']({ ...document.chunks[1], sha256: '0'.repeat(64) }), 'EVENT_CONFLICT');
  throwsCode(() => f.ops['end.commit']({ ...document.meta, sha256: '0'.repeat(64) }), 'EVENT_CONFLICT');
  assert.equal(f.sink.sweep().bufferedBytes, document.bytes.length);
  assert.deepEqual(complete(f.ops, document), { accepted: true, pending: false });
  assert.equal(f.calls.length, 1);
});

test('trusted node closure and both epochs are required; a payload cannot select another node', () => {
  const f = fixture(), document = wire(receipt());
  for (const [payload, code] of [
    [{ ...document.chunks[0], assignmentId: 'missing' }, 'STALE_ASSIGNMENT'],
    [{ ...document.chunks[0], nodeGeneration: 'restarted-node' }, 'STALE_ASSIGNMENT'],
    [{ ...document.chunks[0], actorGeneration: ACTOR_GENERATION + 1 }, 'STALE_ASSIGNMENT'],
    [{ ...document.chunks[0], nodeId: NODE }, 'BAD_REQUEST'],
    [{ ...document.chunks[0], nodeGeneration: 1 }, 'BAD_REQUEST'],
  ]) throwsCode(() => f.ops['end.chunk'](payload), code);
  throwsCode(() => f.sink.opsForNode('game-b')['end.chunk'](document.chunks[0]), 'STALE_ASSIGNMENT');
  throwsCode(() => f.sink.opsForNode('game-b')['end.commit'](document.meta), 'STALE_ASSIGNMENT');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.sink.sweep(), { bufferedBytes: 0, receipts: 0, tombstones: 0 });
  assert.deepEqual(complete(f.ops, document), { accepted: true, pending: false });
  f.add(AID, { actorGeneration: ACTOR_GENERATION + 1, generation: 'new-node-generation' });
  throwsCode(() => f.ops['end.commit'](document.meta), 'STALE_ASSIGNMENT');
  throwsCode(() => f.ops['end.chunk'](document.chunks[0]), 'STALE_ASSIGNMENT');
  assert.equal(f.calls.length, 1);
  assert.equal(f.sink.sweep().tombstones, 0);
});

test('strict part count, sizes, index, metadata and canonical base64url reject malformed chunks', () => {
  const f = fixture(), document = wire(receipt());
  const p = document.chunks[0];
  const variants = [
    { ...p, parts: 0 }, { ...p, parts: 2 }, { ...p, parts: '1' }, { ...p, index: -1 }, { ...p, index: 1 },
    { ...p, index: 0.5 }, { ...p, totalBytes: 0 }, { ...p, totalBytes: MAX_BYTES + 1 },
    { ...p, totalBytes: String(p.totalBytes) }, { ...p, sha256: p.sha256.toUpperCase() },
    { ...p, sha256: '0' }, { ...p, actorGeneration: 0 }, { ...p, actorGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { ...p, assignmentId: 'a\n' }, { ...p, nodeGeneration: '' }, { ...p, data: '' },
    { ...p, data: `${p.data}=` }, { ...p, data: p.data.slice(1) }, { ...p, data: `+${p.data.slice(1)}` },
    { ...p, data: `${p.data.slice(0, -1)}\n` }, { ...p, extra: true }, { ...p, data: Buffer.from(p.data) },
  ];
  const missing = { ...p }; delete missing.sha256; variants.push(missing);
  for (const payload of variants) throwsCode(() => f.ops['end.chunk'](payload), 'BAD_REQUEST');
  const nonCanonical = wire(Buffer.from([0]));
  throwsCode(() => f.ops['end.chunk']({ ...nonCanonical.chunks[0], data: 'AB' }), 'BAD_REQUEST');
  throwsCode(() => f.ops['end.commit']({ ...document.meta, index: 0 }), 'BAD_REQUEST');
  throwsCode(() => f.ops['end.commit']({ ...document.meta, data: p.data }), 'BAD_REQUEST');
  assert.equal(f.sink.sweep().bufferedBytes, 0);
  assert.equal(f.calls.length, 0);
});

test('whole-receipt SHA256 detects corrupted data before invoking lobby and releases its reservation', () => {
  const f = fixture(), document = wire(receipt(AID, 'x'.repeat(80_000)));
  const changed = Buffer.from(document.chunks[0].data, 'base64url'); changed[30] ^= 1;
  chunksInto(f.ops, { chunks: [{ ...document.chunks[0], data: changed.toString('base64url') }, ...document.chunks.slice(1)] });
  throwsCode(() => f.ops['end.commit'](document.meta), 'BAD_REQUEST');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.sink.sweep(), { bufferedBytes: 0, receipts: 0, tombstones: 0 });
  assert.deepEqual(complete(f.ops, document), { accepted: true, pending: false });
});

test('UTF-8, JSON and exact terminal receipt schema are validated even while unpublished', () => {
  const missing = { ...receipt() }; delete missing.summary;
  const invalid = [
    Buffer.from([0xff]), Buffer.from('{'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(receipt()))]),
    { ...receipt(), assignmentId: 'different-aid' }, { ...receipt(), generation: ACTOR_GENERATION + 1 },
    { ...receipt(), generation: String(ACTOR_GENERATION) }, { ...receipt(), roomCode: 'ABCD' },
    { ...receipt(), nodeGeneration: NODE_GENERATION }, { ...receipt(), lastPublic: [] },
    { ...receipt(), lastPublic: { t: 'b.snap', events: [] } }, { ...receipt(), results: [] },
    { ...receipt(), results: null }, { ...receipt(), results: { u1: null } },
    { ...receipt(), results: { u1: { t: 'b.ev' } } }, missing,
    { ...receipt(), ['__proto__']: { polluted: true } },
  ];
  for (const value of invalid) {
    const f = fixture(); f.add(AID, { state: 'committed' }, false);
    const document = wire(value);
    chunksInto(f.ops, document);
    throwsCode(() => f.ops['end.commit'](document.meta), 'BAD_REQUEST');
    assert.equal(f.calls.length, 0);
    assert.equal(f.sink.sweep().bufferedBytes, 0);
  }
});

test('result membership remains authoritative at lobby; rejection is not an accepted or invented end', () => {
  const f = fixture(), value = { ...receipt(), results: { outsider: { t: 'm.result', rank: 1 } } };
  const document = wire(value);
  chunksInto(f.ops, document);
  throwsCode(() => f.ops['end.commit'](document.meta), 'BAD_REQUEST');
  assert.equal(f.calls.length, 1);
  assert.equal(f.ended.size, 0);
  assert.equal(f.sink.sweep().bufferedBytes, 0);
  throwsCode(() => f.ops['end.commit'](document.meta), 'NOT_READY');
  const next = wire(receipt());
  assert.deepEqual(complete(f.ops, next), { accepted: true, pending: false });
  assert.equal(f.ended.size, 1);
});

test('an end before local publication is held complete and flush waits for both publication and lobby registration', () => {
  const f = fixture(), document = wire(receipt(AID, 'x'.repeat(70_000)));
  f.add(AID, { state: 'committed' }, false);
  assert.deepEqual(complete(f.ops, document), { accepted: true, pending: true });
  assert.deepEqual(f.ops['end.commit'](document.meta), { accepted: true, pending: true });
  chunksInto(f.ops, document);
  assert.deepEqual(f.sink.flush(AID), { accepted: true, pending: true });
  assert.equal(f.calls.length, 0);
  assert.equal(f.sink.sweep().bufferedBytes, document.bytes.length);
  f.add(AID, { state: 'published' }, false);
  assert.deepEqual(f.sink.flush(AID), { accepted: true, pending: true });
  assert.equal(f.calls.length, 0);
  f.assignments.set(AID, {});
  assert.deepEqual(f.sink.flush(AID), { accepted: true, pending: false });
  assert.deepEqual(f.sink.flush(AID), { accepted: true, pending: false });
  assert.equal(f.calls.length, 1);
  assert.equal(f.sink.sweep().bufferedBytes, 0);
});

test('pending receipts cannot survive an actor replacement or missing assignment', () => {
  for (const remove of [false, true]) {
    const f = fixture(), document = wire(receipt());
    f.add(AID, { state: 'committed' }, false);
    assert.deepEqual(complete(f.ops, document), { accepted: true, pending: true });
    if (remove) f.infos.delete(AID); else f.add(AID, { actorGeneration: ACTOR_GENERATION + 1 });
    assert.deepEqual(f.sink.flush(AID), { accepted: false });
    throwsCode(() => f.ops['end.commit'](document.meta), 'STALE_ASSIGNMENT');
    assert.equal(f.calls.length, 0);
    assert.equal(f.sink.sweep().bufferedBytes, 0);
  }
});

test('a synchronous trusted release is ACKed by a bounded exact-epoch tombstone, never reapplied', () => {
  const f = fixture({ ttlMs: 50 }), document = wire(receipt());
  f.setOnReceive(() => { f.infos.delete(AID); f.assignments.delete(AID); });
  assert.deepEqual(complete(f.ops, document), { accepted: true, pending: false });
  chunksInto(f.ops, document);
  assert.deepEqual(f.ops['end.commit'](document.meta), { accepted: true, pending: false });
  assert.deepEqual(f.sink.flush(AID), { accepted: true, pending: false });
  assert.equal(f.calls.length, 1);
  throwsCode(() => f.ops['end.commit']({ ...document.meta, sha256: '0'.repeat(64) }), 'STALE_ASSIGNMENT');
  assert.deepEqual(f.sink.sweep(), { bufferedBytes: 0, receipts: 0, tombstones: 1 });
  f.setTime(1050);
  assert.deepEqual(f.sink.sweep(), { bufferedBytes: 0, receipts: 0, tombstones: 0 });
  throwsCode(() => f.ops['end.commit'](document.meta), 'STALE_ASSIGNMENT');
  assert.equal(f.calls.length, 1);
});

test('a synchronous epoch change after genuine apply cannot create a reusable tombstone', () => {
  const f = fixture(), document = wire(receipt());
  f.setOnReceive(() => f.add(AID, { actorGeneration: ACTOR_GENERATION + 1 }));
  chunksInto(f.ops, document);
  throwsCode(() => f.ops['end.commit'](document.meta), 'STALE_ASSIGNMENT');
  assert.equal(f.calls.length, 1);
  assert.equal(f.sink.sweep().tombstones, 0);
  throwsCode(() => f.ops['end.commit'](document.meta), 'STALE_ASSIGNMENT');
  assert.equal(f.calls.length, 1);
});

test('fixed TTL expires incomplete/complete buffers and tombstones; retries do not renew deadlines', () => {
  const document = wire(receipt(AID, 'x'.repeat(50_000)));
  const incomplete = fixture({ ttlMs: 50 });
  incomplete.ops['end.chunk'](document.chunks[0]);
  incomplete.setTime(1049); incomplete.ops['end.chunk'](document.chunks[0]);
  incomplete.setTime(1050);
  assert.deepEqual(incomplete.sink.sweep(), { bufferedBytes: 0, receipts: 0, tombstones: 0 });
  throwsCode(() => incomplete.ops['end.commit'](document.meta), 'NOT_READY');
  assert.equal(incomplete.calls.length, 0);
  const waiting = fixture({ ttlMs: 50 }); waiting.add(AID, { state: 'committed' }, false);
  assert.deepEqual(complete(waiting.ops, document), { accepted: true, pending: true });
  waiting.setTime(1049); waiting.ops['end.commit'](document.meta);
  waiting.setTime(1050); waiting.add();
  assert.deepEqual(waiting.sink.flush(AID), { accepted: false });
  assert.equal(waiting.sink.sweep().bufferedBytes, 0);
  assert.equal(waiting.calls.length, 0);
  const done = fixture({ ttlMs: 50 }); complete(done.ops, document);
  done.setTime(1049); done.ops['end.commit'](document.meta);
  done.setTime(1050);
  assert.deepEqual(done.sink.sweep(), { bufferedBytes: 0, receipts: 0, tombstones: 0 });
  throwsCode(() => done.ops['end.commit'](document.meta), 'NOT_READY');
  assert.equal(done.calls.length, 1);
});

test('budget reserves the advertised receipt size and BUSY never mutates admitted data', () => {
  const a = wire(receipt(AID, 'x'.repeat(50_000)));
  const b = wire(receipt('end-b', 'x'.repeat(50_000)), { assignmentId: 'end-b' });
  const f = fixture({ maxBufferedBytes: a.bytes.length + b.bytes.length - 1 }); f.add('end-b');
  f.ops['end.chunk'](a.chunks[0]);
  assert.equal(f.sink.sweep().bufferedBytes, a.bytes.length);
  throwsCode(() => f.ops['end.chunk'](b.chunks[0]), 'BUSY');
  f.ops['end.chunk'](a.chunks[0]);
  assert.equal(f.sink.sweep().bufferedBytes, a.bytes.length);
  complete(f.ops, a);
  assert.deepEqual(f.sink.sweep(), { bufferedBytes: 0, receipts: 0, tombstones: 1 });
  assert.deepEqual(complete(f.ops, b), { accepted: true, pending: false });
  assert.equal(f.calls.length, 2);
  const tooSmall = fixture({ maxBufferedBytes: a.bytes.length - 1 });
  throwsCode(() => tooSmall.ops['end.chunk'](a.chunks[0]), 'BUSY');
  assert.equal(tooSmall.sink.sweep().bufferedBytes, 0);
});

test('tiny records and applied tombstones share a fixed record cap independent of player counts', () => {
  const f = fixture({ ttlMs: 50 });
  let first;
  for (let index = 0; index < 1024; index++) {
    const assignmentId = `tiny-${index}`;
    f.add(assignmentId);
    const document = wire(receipt(assignmentId), { assignmentId });
    f.ops['end.chunk'](document.chunks[0]);
    if (index === 0) first = document;
  }
  f.ops['end.commit'](first.meta);
  assert.equal(f.sink.sweep().receipts, 1023);
  assert.equal(f.sink.sweep().tombstones, 1);
  f.add('one-more');
  const next = wire(receipt('one-more'), { assignmentId: 'one-more' });
  throwsCode(() => f.ops['end.chunk'](next.chunks[0]), 'BUSY');
  f.setTime(1050);
  assert.deepEqual(f.sink.sweep(), { bufferedBytes: 0, receipts: 0, tombstones: 0 });
  assert.deepEqual(f.ops['end.chunk'](next.chunks[0]), { accepted: true });
});

test('close is idempotent, clears all counters/buffers and rejects captured operations or flush', () => {
  const f = fixture();
  const a = wire(receipt(AID, 'x'.repeat(50_000)));
  f.ops['end.chunk'](a.chunks[0]);
  f.add('pending', { state: 'committed' }, false);
  complete(f.ops, wire(receipt('pending'), { assignmentId: 'pending' }));
  f.add('applied'); complete(f.ops, wire(receipt('applied'), { assignmentId: 'applied' }));
  assert.equal(f.sink.sweep().receipts, 2);
  assert.equal(f.sink.sweep().tombstones, 1);
  f.sink.close(); f.sink.close();
  assert.deepEqual(f.sink.sweep(), { bufferedBytes: 0, receipts: 0, tombstones: 0 });
  throwsCode(() => f.ops['end.chunk'](a.chunks[0]), 'CLOSED');
  throwsCode(() => f.ops['end.commit'](a.meta), 'CLOSED');
  throwsCode(() => f.sink.flush(AID), 'CLOSED');
  throwsCode(() => f.sink.opsForNode(NODE), 'CLOSED');
});

test('exactly 2MiB is chunked into bounded messages; oversize never calls RPC', async () => {
  const base = receipt(AID, '');
  const padding = MAX_BYTES - Buffer.byteLength(JSON.stringify(base));
  const value = receipt(AID, 'x'.repeat(padding)), f = fixture(), sent = [];
  assert.equal(Buffer.byteLength(JSON.stringify(value)), MAX_BYTES);
  const client = { call(op, payload) {
    sent.push({ op, payload });
    assert.ok(Buffer.byteLength(JSON.stringify({ id: 'test-id', op, payload })) < 64 * 1024);
    if (op === 'end.chunk') assert.ok(Buffer.from(payload.data, 'base64url').length <= CHUNK_BYTES);
    return f.ops[op](payload);
  } };
  assert.deepEqual(await sendEndReceipt({ client, nodeGeneration: NODE_GENERATION, receipt: value }), { accepted: true, pending: false });
  assert.equal(sent.filter(s => s.op === 'end.chunk').length, Math.ceil(MAX_BYTES / CHUNK_BYTES));
  assert.equal(f.calls.length, 1);
  const before = sent.length;
  await rejectsCode(() => sendEndReceipt({ client, nodeGeneration: NODE_GENERATION, receipt: receipt(AID, 'x'.repeat(padding + 1)) }), 'BAD_REQUEST');
  assert.equal(sent.length, before);
});

test('sender retries only TRANSPORT/TIMEOUT/BAD_REPLY with bounded short backoff and the identical payload', async () => {
  const calls = [], failures = ['TRANSPORT', 'TIMEOUT', 'BAD_REPLY'];
  const client = { call(op, payload, options) {
    calls.push({ op, payload, options });
    if (op === 'end.chunk' && failures.length) {
      const code = failures.shift();
      if (code === 'BAD_REPLY') return { accepted: false };
      throw new RpcError(code);
    }
    return op === 'end.chunk' ? { accepted: true } : { accepted: true, pending: true };
  } };
  const controller = new AbortController();
  assert.deepEqual(await sendEndReceipt({ client, nodeGeneration: NODE_GENERATION, receipt: receipt(), signal: controller.signal }),
    { accepted: true, pending: true });
  assert.equal(calls.length, 5);
  assert.ok(calls.slice(0, 4).every(c => c.op === 'end.chunk' && c.payload === calls[0].payload && c.options.signal === controller.signal));
  assert.equal(calls[4].op, 'end.commit');
  assert.ok(!Object.hasOwn(calls[4].payload, 'data') && !Object.hasOwn(calls[4].payload, 'index'));
});

test('sender exhausts four attempts, explicitly rejects, and never enqueues commit/background work', async () => {
  for (const code of ['TRANSPORT', 'TIMEOUT', 'BAD_REPLY']) {
    let calls = 0;
    const client = { call(op) { assert.equal(op, 'end.chunk'); calls++; throw new RpcError(code); } };
    await rejectsCode(() => sendEndReceipt({ client, nodeGeneration: NODE_GENERATION, receipt: receipt() }), code);
    assert.equal(calls, 4);
  }
  let chunks = 0, commits = 0;
  const client = { call(op) {
    if (op === 'end.chunk') { chunks++; return { accepted: true }; }
    commits++; throw new RpcError('TIMEOUT');
  } };
  await rejectsCode(() => sendEndReceipt({ client, nodeGeneration: NODE_GENERATION, receipt: receipt() }), 'TIMEOUT');
  assert.equal(chunks, 1); assert.equal(commits, 4);
});

test('sender does not retry domain/auth/budget errors and never exposes arbitrary peer messages', async () => {
  for (const code of ['BAD_REQUEST', 'EVENT_CONFLICT', 'STALE_ASSIGNMENT', 'NOT_READY', 'BUSY', 'UNAUTHORIZED', 'CLOSED']) {
    let calls = 0;
    const client = { call() { calls++; const error = new Error('untrusted detail'); error.code = code; throw error; } };
    await rejectsCode(() => sendEndReceipt({ client, nodeGeneration: NODE_GENERATION, receipt: receipt() }), code);
    assert.equal(calls, 1);
  }
  for (const error of [new Error('untrusted detail'), Object.assign(new Error('untrusted detail'), { code: 'untrusted-detail' })]) {
    let calls = 0;
    const client = { call() { calls++; throw error; } };
    await rejectsCode(() => sendEndReceipt({ client, nodeGeneration: NODE_GENERATION, receipt: receipt() }), 'INTERNAL');
    assert.equal(calls, 1);
  }
});

test('sender abort cancels before dispatch or during retry delay without further calls', async () => {
  const pre = new AbortController(); pre.abort();
  let calls = 0;
  const client = { call() { calls++; return { accepted: true }; } };
  await rejectsCode(() => sendEndReceipt({ client, nodeGeneration: NODE_GENERATION, receipt: receipt(), signal: pre.signal }), 'ABORTED');
  assert.equal(calls, 0);
  const controller = new AbortController();
  const retryClient = { call() {
    calls++; queueMicrotask(() => controller.abort()); throw new RpcError('TRANSPORT');
  } };
  await rejectsCode(() => sendEndReceipt({ client: retryClient, nodeGeneration: NODE_GENERATION, receipt: receipt(), signal: controller.signal }), 'ABORTED');
  assert.equal(calls, 1);
});

test('sender rejects non-host schemas and sink configuration has hard byte/time upper bounds', async () => {
  let calls = 0;
  const client = { call() { calls++; return { accepted: true }; } };
  for (const value of [{ ...receipt(), extra: true }, { ...receipt(), summary: undefined },
    { ...receipt(), lastPublic: { t: 'b.ev' } }, { ...receipt(), results: { u1: { t: 'b.snap' } } },
    { ...receipt(), generation: '17' }, { ...receipt(), results: [] }]) {
    await rejectsCode(() => sendEndReceipt({ client, nodeGeneration: NODE_GENERATION, receipt: value }), 'BAD_REQUEST');
  }
  await rejectsCode(() => sendEndReceipt({ client, nodeGeneration: 1, receipt: receipt() }), 'BAD_REQUEST');
  await rejectsCode(() => sendEndReceipt({ client, nodeGeneration: NODE_GENERATION, receipt: receipt(), signal: {} }), 'BAD_REQUEST');
  assert.equal(calls, 0);
  for (const options of [{ ttlMs: 0 }, { ttlMs: 60_001 }, { maxBytes: 0 }, { maxBytes: MAX_BYTES + 1 },
    { maxBufferedBytes: 0 }, { maxBufferedBytes: 64 * 1024 * 1024 + 1 }]) assert.throws(() => fixture(options), RangeError);
  const f = fixture({ maxBytes: 100 });
  throwsCode(() => f.ops['end.chunk'](wire(receipt()).chunks[0]), 'BAD_REQUEST');
  assert.equal(f.sink.sweep().bufferedBytes, 0);
});
