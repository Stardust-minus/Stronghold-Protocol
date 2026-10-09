import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_MANIFEST_ENTRIES, MAX_MANIFEST_BYTES, validateManifest, startServer } from '../server.mjs';

const NOW = 1791072000000;
const mirrors = ['large-old-fixture', 'large-new-fixture'];
function manifest(count) {
  const entries = Array.from({ length: count }, (_, i) => ({
    requestPath: `/assets/large-fixture/item_${i}.png`,
    fileName: `releases/${mirrors[i % 2]}/assets/large-fixture/item_${i}.png`,
    bytes: i + 1, sha256: String(i + 1).padStart(64, '0'), mime: 'image/png',
  }));
  return { schemaVersion: 1, release: 'large-next-fixture', dataset: 'Stardust_minus/arknight_assets',
    apiOrigin: 'https://openi.pcl.ac.cn', ossOrigin: 'https://obs.cn-south-222.ai.pcl.cn',
    ossPathPrefix: '/synthetic-bucket/synthetic-object-prefix/',
    fallbackBase: 'https://ark-asset.hanabi-ai.cn:25442/releases/large-next-fixture',
    mirrorReleases: [...mirrors], entries };
}
function request(base, path, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base, { path, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('manifest accepts the old limit plus one and the exact bounded next-release limit', () => {
  assert.equal(MAX_MANIFEST_ENTRIES, 100000);
  for (const count of [50001, MAX_MANIFEST_ENTRIES]) {
    const validated = validateManifest(manifest(count));
    assert.equal(validated.entries.size, count);
    assert.equal(validated.files.size, count);
    assert.ok(Object.isFrozen(validated.entries.get(`/assets/large-fixture/item_${count - 1}.png`)));
    assert.deepEqual(validated.mirrorReleases, mirrors);
  }
  assert.throws(() => validateManifest(manifest(MAX_MANIFEST_ENTRIES + 1)), { code: 'CONFIG' });
});

test('large inputs still reject a third mirror, duplicate paths, private namespaces and conflicting bytes', () => {
  for (const change of [
    input => input.mirrorReleases.push('third-mirror'),
    input => { input.entries.at(-1).requestPath = input.entries[0].requestPath; },
    input => { input.entries.at(-1).requestPath = '/data/assets.json'; },
    input => { input.entries.at(-1).fileName = input.entries[0].fileName; },
    input => { input.entries.at(-1).mime = 'image/png\r\nInjected: true'; },
  ]) {
    const input = manifest(50001);
    change(input);
    assert.throws(() => validateManifest(input), { code: 'CONFIG' });
  }
});

test('a real mounted 84796-alias JSON above 16 MiB starts and serves first, middle and last paths without public API calls', async t => {
  const directory = await mkdtemp(join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, 'tmp') : tmpdir(), 'openi-large-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = manifest(84796), raw = JSON.stringify(input), path = join(directory, 'manifest.json');
  assert.ok(Buffer.byteLength(raw) > 16 * 1024 * 1024);
  assert.ok(Buffer.byteLength(raw) < MAX_MANIFEST_BYTES);
  await writeFile(path, raw);
  const calls = [];
  const app = await startServer({ manifestPath: path, host: '127.0.0.1', port: 0,
    prewarm: false, clock: () => NOW, maxRetries: 0,
    fetchImpl: async (target, options) => {
      const name = new URL(target).searchParams.get('file_name');
      calls.push({ name, options });
      const encoded = (input.ossPathPrefix + name).split('/').map(encodeURIComponent).join('/');
      return { status: 301, headers: new Headers({ Location: input.ossOrigin + encoded
        + '?AWSAccessKeyId=clearly-synthetic-fixture&Expires=' + (NOW / 1000 + 3600)
        + '&Signature=clearly-synthetic-fixture' }), body: { async cancel() {} } };
    } });
  t.after(() => app.close());
  const base = 'http://127.0.0.1:' + app.server.address().port;
  assert.equal(calls.length, 0, 'construction must not prewarm or fetch');
  const health = await request(base, '/healthz');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).entries, 84796);
  assert.equal(health.headers['access-control-allow-origin'], undefined);
  for (const index of [0, 42398, 84795]) {
    const row = input.entries[index];
    const result = await request(base, row.requestPath, 'GET', { Origin: 'https://fixture.invalid',
      Cookie: 'synthetic-not-a-credential', Authorization: 'synthetic-not-a-credential' });
    assert.equal(result.status, 302);
    assert.equal(result.headers['access-control-allow-origin'], '*');
    assert.equal(result.headers['access-control-allow-credentials'], undefined);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.ok(result.headers.location.endsWith('&sp_request=cors'));
    assert.equal(decodeURIComponent(new URL(result.headers.location).pathname), input.ossPathPrefix + row.fileName);
    const head = await request(base, row.requestPath, 'HEAD');
    assert.equal(head.status, 302);
    assert.equal(head.headers.location, input.fallbackBase + row.requestPath);
    assert.equal(head.body, '');
    assert.equal((await request(base, row.requestPath, 'OPTIONS')).status, 204);
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.options.credentials === 'omit' && call.options.redirect === 'manual'));
  assert.ok(calls.every(call => JSON.stringify(call.options.headers) === JSON.stringify({ Accept: '*/*' })));
  for (const target of ['/data/assets.json', '/assets/not-listed.png', '/assets/%2e%2e/data.json', '/media/private']) {
    const denied = await request(base, target);
    assert.equal(denied.status, 404);
    assert.equal(denied.headers.location, undefined);
  }
  assert.equal(calls.length, 3);
  await app.close();
  assert.equal(app.resolver.health().active, 0);
});

test('mounted JSON remains byte-bounded and refuses 64 MiB plus one before listening', async t => {
  assert.equal(MAX_MANIFEST_BYTES, 64 * 1024 * 1024);
  const directory = await mkdtemp(join(process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, 'tmp') : tmpdir(), 'openi-large-byte-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'oversize.json');
  const padded = Buffer.alloc(MAX_MANIFEST_BYTES + 1, 32);
  padded.write(JSON.stringify(manifest(2)), 0, 'utf8');
  await writeFile(path, padded);
  await assert.rejects(startServer({ manifestPath: path, host: '127.0.0.1', port: 0,
    prewarm: false, fetchImpl: () => assert.fail('invalid manifest must never fetch') }), { code: 'CONFIG' });
});
