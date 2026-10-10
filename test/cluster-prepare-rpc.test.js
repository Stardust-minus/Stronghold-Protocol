import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createRpcAuthenticator, createRpcClient, createRpcHandler, RpcError } from '../server/cluster/rpc.js';

const PREPARE_PATH = '/_cluster/rpc/prepare';
const PREPARE_BYTES = 2 * 1024 * 1024;
const envelope = (op = 'prepare', padding = '') => Buffer.from(JSON.stringify({ id: 'prepare-test', op, payload: { padding } }));
const code = expected => error => error instanceof RpcError && error.code === expected;
async function fixture(t, operations) {
  const authority = createRpcAuthenticator({ key: randomBytes(32), scope: 'prepare-node' });
  const handler = createRpcHandler({ authority, operations });
  const server = http.createServer((req, res) => { void handler(req, res).catch(() => res.destroy()); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = createRpcClient({ url, authority });
  t.after(async () => { client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { authority, url, client };
}
async function raw(url, bytes, headers = {}, path = PREPARE_PATH, chunked = false) {
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(path, url), { method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', ...(!chunked ? { 'content-length': bytes.length } : {}), ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks).toString()), headers: response.headers }));
    });
    request.on('error', reject);
    if (chunked) {
      for (let at = 0; at < bytes.length; at += 16384) request.write(bytes.subarray(at, at + 16384));
      request.end();
    } else request.end(bytes);
  });
}

test('large prepare uses one authenticated request with a private, operation-specific budget', async t => {
  let calls = 0;
  const f = await fixture(t, { prepare: payload => { calls++; return { bytes: payload.padding.length }; } });
  assert.deepEqual(await f.client.call('prepare', { padding: 'p'.repeat(100000) }), { bytes: 100000 });
  assert.equal(calls, 1);
});

test('prepare signatures bind the exact private path, body, scope and one-use nonce', () => {
  const authority = createRpcAuthenticator({ key: randomBytes(32), scope: 'prepare-node' });
  const bytes = envelope('prepare', 'p'.repeat(100000));
  assert.throws(() => authority.sign(bytes), TypeError);
  const headers = authority.sign(bytes, PREPARE_PATH);
  assert.equal(authority.verify(headers, bytes), false);
  assert.equal(authority.verify(headers, bytes, PREPARE_PATH + '?op=status'), false);
  assert.equal(authority.verify({ ...headers, 'x-ark-cluster-scope': 'another-node' }, bytes, PREPARE_PATH), false);
  assert.equal(authority.verify(headers, Buffer.concat([bytes, Buffer.from(' ')]), PREPARE_PATH), false);
  assert.equal(authority.verify(headers, bytes, PREPARE_PATH), true);
  assert.equal(authority.verify(headers, bytes, PREPARE_PATH), false);
  assert.throws(() => authority.sign(Buffer.alloc(PREPARE_BYTES + 1), PREPARE_PATH), TypeError);
});

test('large prepare cannot be redirected to ordinary control or invoke another operation', async t => {
  const calls = [];
  const f = await fixture(t, { prepare: () => { calls.push('prepare'); return null; }, status: () => { calls.push('status'); return null; } });
  const bytes = envelope('status', 's'.repeat(100000));
  const wrongOp = await raw(f.url, bytes, f.authority.sign(bytes, PREPARE_PATH));
  assert.equal(wrongOp.status, 400); assert.equal(wrongOp.value.code, 'BAD_REQUEST');
  const ordinary = await raw(f.url, bytes, f.authority.sign(bytes, PREPARE_PATH), '/_cluster/rpc');
  assert.equal(ordinary.status, 413);
  await assert.rejects(f.client.call('status', { padding: 's'.repeat(100000) }), code('BAD_REQUEST'));
  assert.deepEqual(calls, []);
});

test('unauthenticated, altered and replayed large prepare bodies never invoke an operation', async t => {
  let calls = 0;
  const f = await fixture(t, { prepare: () => { calls++; return null; } });
  const bytes = envelope('prepare', 'p'.repeat(100000)), headers = f.authority.sign(bytes, PREPARE_PATH);
  assert.equal((await raw(f.url, bytes)).status, 401);
  assert.equal((await raw(f.url, Buffer.concat([bytes, Buffer.from(' ')]), headers)).status, 401);
  assert.equal((await raw(f.url, bytes, headers)).status, 200);
  assert.equal((await raw(f.url, bytes, headers)).status, 401);
  assert.equal(calls, 1);
});

test('prepare route remains unavailable on handlers without prepare and rejects route variants', async t => {
  const f = await fixture(t, { status: () => ({ ready: true }) });
  const bytes = envelope();
  for (const path of [PREPARE_PATH, PREPARE_PATH + '/', PREPARE_PATH + '?op=prepare', '/_cluster/rpc/other']) {
    assert.equal((await raw(f.url, bytes, {}, path)).status, 404);
  }
});

test('prepare rejects declared and chunked over-budget bodies and preserves the exact finite boundary', async t => {
  let calls = 0;
  const f = await fixture(t, { prepare: payload => { calls++; return { bytes: payload.padding.length }; } });
  const padding = PREPARE_BYTES - envelope().length;
  const exact = envelope('prepare', 'p'.repeat(padding));
  assert.equal(exact.length, PREPARE_BYTES);
  const accepted = await raw(f.url, exact, f.authority.sign(exact, PREPARE_PATH));
  assert.equal(accepted.status, 200); assert.equal(accepted.headers['cache-control'], 'no-store');
  for (const chunked of [false, true]) {
    const rejected = await raw(f.url, Buffer.alloc(PREPARE_BYTES + 1), {}, PREPARE_PATH, chunked);
    assert.equal(rejected.status, 413); assert.equal(rejected.value.code, 'TOO_LARGE');
  }
  assert.equal(calls, 1);
  await assert.rejects(f.client.call('prepare', { padding: 'p'.repeat(PREPARE_BYTES) }), code('BAD_REQUEST'));
  assert.equal(calls, 1);
});

test('small prepare keeps the ordinary RPC route and its original signature contract', async t => {
  const f = await fixture(t, { prepare: () => ({ prepared: true }) });
  const bytes = envelope();
  const result = await raw(f.url, bytes, f.authority.sign(bytes), '/_cluster/rpc');
  assert.equal(result.status, 200); assert.equal(result.value.value.prepared, true);
  assert.deepEqual(await f.client.call('prepare', {}), { prepared: true });
});

test('prepare replies, cancellation and deadlines retain ordinary RPC bounds', async t => {
  const f = await fixture(t, { prepare: payload => payload.largeReply ? 'x'.repeat(65536)
    : new Promise(resolve => setTimeout(() => resolve(null), 100)) });
  await assert.rejects(f.client.call('prepare', { padding: 'p'.repeat(100000), largeReply: true }), code('TOO_LARGE'));
  const short = createRpcClient({ url: f.url, authority: f.authority, timeoutMs: 20 });
  t.after(() => short.close());
  await assert.rejects(short.call('prepare', { padding: 'p'.repeat(100000) }), code('TIMEOUT'));
  const abort = new AbortController();
  const pending = f.client.call('prepare', { padding: 'p'.repeat(100000) }, { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, code('ABORTED'));
});
