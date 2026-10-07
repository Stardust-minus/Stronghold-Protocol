import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createRpcAuthenticator, createRpcClient, createRpcHandler, RpcError } from '../server/cluster/rpc.js';

const body = () => Buffer.from(JSON.stringify({ id: 'test-request', op: 'status', payload: {} }));
const code = expected => e => e instanceof RpcError && e.code === expected;
async function fixture(t, operations = { status: () => ({ ready: true }) }, extra = {}) {
  const key = randomBytes(32);
  const authority = createRpcAuthenticator({ key, scope: 'game-test' });
  const handler = createRpcHandler({ authority, operations, ...extra });
  const server = http.createServer((req, res) => { handler(req, res).catch(() => res.destroy()); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = createRpcClient({ url, authority });
  t.after(async () => {
    client.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { key, authority, server, url, client };
}
async function raw(url, bytes, headers = {}, method = 'POST', path = '/_cluster/rpc') {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(path, url);
    const request = http.request(endpoint, { method, agent: false, headers: { 'content-type': 'application/json', 'content-length': bytes.length, ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, value: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    request.on('error', reject); request.end(bytes);
  });
}

test('private control RPC signs the exact body, scope and one-use nonce', () => {
  const authority = createRpcAuthenticator({ key: randomBytes(32), scope: 'game-a', now: () => 1000 });
  const bytes = body(), headers = authority.sign(bytes);
  assert.equal(authority.verify(headers, Buffer.concat([bytes, Buffer.from(' ')])), false);
  assert.equal(authority.verify({ ...headers, 'x-ark-cluster-scope': 'game-b' }, bytes), false);
  assert.equal(authority.verify(headers, bytes), true);
  assert.equal(authority.verify(headers, bytes), false);
});

test('RPC clock has explicit bounded future tolerance and exclusive expiry', () => {
  const key = randomBytes(32);
  let now = 10000;
  const issuer = createRpcAuthenticator({ key, scope: 'game-a', now: () => 10000 });
  const receiver = createRpcAuthenticator({ key, scope: 'game-a', now: () => now, maxAgeMs: 100, maxFutureMs: 10 });
  const bytes = body();
  now = 9990; assert.equal(receiver.verify(issuer.sign(bytes), bytes), true);
  now = 9989; assert.equal(receiver.verify(issuer.sign(bytes), bytes), false);
  now = 10099; assert.equal(receiver.verify(issuer.sign(bytes), bytes), true);
  now = 10100; assert.equal(receiver.verify(issuer.sign(bytes), bytes), false);
});

test('RPC header parsing rejects duplicate, noncanonical, malformed and wrong-key signatures', () => {
  const authority = createRpcAuthenticator({ key: randomBytes(32), scope: 'game-a' });
  const other = createRpcAuthenticator({ key: randomBytes(32), scope: 'game-a' });
  const bytes = body(), headers = authority.sign(bytes);
  for (const invalid of [{ ...headers, 'x-ark-cluster-time': '01' }, { ...headers, 'x-ark-cluster-time': '-1' },
    { ...headers, 'x-ark-cluster-nonce': `${headers['x-ark-cluster-nonce']}\n` },
    { ...headers, 'x-ark-cluster-signature': [headers['x-ark-cluster-signature']] },
    { ...headers, 'x-ark-cluster-signature': '0'.repeat(64) }]) {
    assert.equal(authority.verify(invalid, bytes), false);
  }
  assert.equal(other.verify(headers, bytes), false);
  assert.equal(authority.verify(headers, Buffer.alloc(65537)), false);
});

test('real loopback RPC round-trip and stable machine-readable errors', async t => {
  const f = await fixture(t, {
    prepare: payload => ({ assignmentId: payload.assignmentId, state: 'prepared' }),
    failure: () => { throw new RpcError('STALE_ASSIGNMENT'); },
    internal: () => { throw new Error('test-only private diagnostic must not cross RPC'); },
  });
  assert.deepEqual(await f.client.call('prepare', { assignmentId: 'test-allocation' }), { assignmentId: 'test-allocation', state: 'prepared' });
  await assert.rejects(f.client.call('failure'), code('STALE_ASSIGNMENT'));
  await assert.rejects(f.client.call('internal'), code('INTERNAL'));
  await assert.rejects(f.client.call('unknown'), code('UNKNOWN_OPERATION'));
});

test('unauthenticated, replayed and altered requests never invoke game operations', async t => {
  let calls = 0;
  const f = await fixture(t, { status: () => { calls++; return null; } });
  const bytes = body();
  assert.equal((await raw(f.url, bytes)).status, 401);
  const headers = f.authority.sign(bytes);
  assert.equal((await raw(f.url, bytes, headers)).status, 200);
  assert.equal((await raw(f.url, bytes, headers)).status, 401);
  assert.equal((await raw(f.url, Buffer.concat([bytes, Buffer.from(' ')]), f.authority.sign(bytes))).status, 401);
  assert.equal(calls, 1);
});

test('only the fixed POST route and bounded JSON envelopes are accepted', async t => {
  const f = await fixture(t);
  const bytes = body();
  assert.equal((await raw(f.url, bytes, {}, 'POST', '/_cluster/rpc?token=invalid')).status, 404);
  assert.equal((await raw(f.url, bytes, {}, 'GET')).status, 405);
  assert.equal((await raw(f.url, bytes, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await raw(f.url, Buffer.alloc(65537))).status, 413);
  for (const value of [{ id: 'request', op: 'status', payload: {}, extra: true }, { id: 'request', op: 'status', payload: [] }, []]) {
    const payload = Buffer.from(JSON.stringify(value));
    assert.equal((await raw(f.url, payload, f.authority.sign(payload))).status, 400);
  }
});

test('oversized operation replies are rejected without forwarding their contents', async t => {
  const f = await fixture(t, { large: () => 'test'.repeat(20000) });
  await assert.rejects(f.client.call('large'), code('TOO_LARGE'));
});

test('client cancellation and end-to-end deadline include queued and response-read work', async t => {
  const f = await fixture(t, { delayed: () => new Promise(resolve => setTimeout(() => resolve(null), 100)) });
  const short = createRpcClient({ url: f.url, authority: f.authority, timeoutMs: 20 });
  t.after(() => short.close());
  await assert.rejects(short.call('delayed'), code('TIMEOUT'));
  const abort = new AbortController();
  const pending = f.client.call('delayed', {}, { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, code('ABORTED'));
  await assert.rejects(f.client.call('delayed', {}, { signal: abort.signal }), code('ABORTED'));
  f.client.close();
  await assert.rejects(f.client.call('delayed'), code('CLOSED'));
});

test('private responses are no-store and never contain a reflected request', async t => {
  const f = await fixture(t);
  const bytes = body();
  const result = await raw(f.url, bytes, f.authority.sign(bytes));
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(result.value, { id: 'test-request', ok: true, value: { ready: true } });
});

test('bad endpoint, configuration and request types fail before contacting a peer', () => {
  const authority = createRpcAuthenticator({ key: randomBytes(32), scope: 'game-test' });
  for (const url of ['ftp://127.0.0.1/', 'http://user:password@127.0.0.1/', 'http://127.0.0.1/?secret=invalid', 'http://127.0.0.1/other']) {
    assert.throws(() => createRpcClient({ url, authority }), TypeError);
  }
  assert.throws(() => createRpcAuthenticator({ key: Buffer.alloc(31), scope: 'game-test' }), TypeError);
  assert.throws(() => createRpcAuthenticator({ key: randomBytes(32), scope: 'game-test', maxFutureMs: 2001 }), RangeError);
});
