import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { loadClusterConfig } from '../server/cluster/config.js';

const build = 'a'.repeat(40);
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'owned-cluster-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'node-key'), file = path.join(dir, 'runtime.json');
  await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
  const write = async config => { await writeFile(file, JSON.stringify(config), { mode: 0o600 }); return loadClusterConfig(file); };
  return { dir, keyFile, file, write };
}
const game = keyFile => ({ role: 'game', nodeId: 'game-1', build, host: '127.0.0.1', port: 34111, keyFile, coordinatorUrl: 'http://10.253.77.2:34110/' });

test('game configuration loads exactly one external binary key without accepting inline credentials', async t => {
  const f = await fixture(t), config = await f.write(game(f.keyFile));
  assert.ok(Buffer.isBuffer(config.key)); assert.equal(config.key.length, 32);
  assert.equal(Object.hasOwn(config, 'keyFile'), false);
  await assert.rejects(f.write({ ...game(f.keyFile), key: 'never-inline' }));
  await assert.rejects(f.write({ ...game(f.keyFile), generation: 'static-generation-must-not-reuse' }));
});

test('node URLs must remain credential-free private IP endpoints', async t => {
  const f = await fixture(t);
  for (const coordinatorUrl of ['http://8.8.8.8/', 'https://external.invalid/', 'http://user:password@127.0.0.1/', 'http://127.0.0.1/?token=invalid', 'http://127.0.0.1/other']) {
    await assert.rejects(f.write({ ...game(f.keyFile), coordinatorUrl }));
  }
  assert.equal((await f.write({ ...game(f.keyFile), coordinatorUrl: 'http://[::1]:34110/' })).role, 'game');
});

test('only fixed revisions, legal worker counts and bounded future clock allowances are accepted', async t => {
  const f = await fixture(t);
  for (const extra of [{ build: 'master' }, { build: build + '\n' }, { combatWorkers: 0 }, { combatWorkers: 33 }, { trialWorkers: 3 }, { futureSkewMs: 2001 }, { role: 'games' }]) {
    await assert.rejects(f.write({ ...game(f.keyFile), ...extra }));
  }
  const value = await f.write({ ...game(f.keyFile), combatWorkers: 12, trialWorkers: 2, futureSkewMs: 1000 });
  assert.equal(value.combatWorkers, 12);
});

test('world-readable/writable, wrong-size and symbolic-link key files fail closed', async t => {
  const f = await fixture(t);
  await chmod(f.keyFile, 0o644); await assert.rejects(f.write(game(f.keyFile)));
  await chmod(f.keyFile, 0o600);
  await writeFile(f.keyFile, Buffer.alloc(31)); await assert.rejects(f.write(game(f.keyFile)));
  await writeFile(f.keyFile, Buffer.alloc(33)); await assert.rejects(f.write(game(f.keyFile)));
  await writeFile(f.keyFile, randomBytes(32));
  const link = path.join(f.dir, 'key-link'); await symlink(f.keyFile, link);
  await assert.rejects(f.write(game(link)));
});

test('runtime config itself is protected and rejects raw/malformed/non-object documents', async t => {
  const f = await fixture(t);
  await f.write(game(f.keyFile));
  await chmod(f.file, 0o644); await assert.rejects(loadClusterConfig(f.file));
  await chmod(f.file, 0o600);
  for (const text of ['not-json', 'null', '[]', '{}']) {
    await writeFile(f.file, text); await assert.rejects(loadClusterConfig(f.file));
  }
});

test('coordinator nodes are unique, use separate files and preserve unlimited capacity default', async t => {
  const f = await fixture(t);
  const cfg = { role: 'coordinator', build, host: '127.0.0.1', port: 34100, privateHost: '127.0.0.1', privatePort: 34110,
    nodes: [{ nodeId: 'game-1', url: 'http://10.253.77.2:34111/', keyFile: f.keyFile }] };
  const value = await f.write(cfg);
  assert.equal(value.nodes[0].key.length, 32);
  await assert.rejects(f.write({ ...cfg, nodes: [cfg.nodes[0], cfg.nodes[0]] }));
  await assert.rejects(f.write({ ...cfg, privateHost: '8.8.8.8' }));
});

test('one ingress configuration can later be copied to many entries without introducing keys or shard selection', async t => {
  const f = await fixture(t);
  const cfg = { role: 'ingress', host: '127.0.0.1', port: 34101, coordinatorUrl: 'http://10.253.77.2:34100/',
    nodes: [{ nodeId: 'game-1', url: 'http://10.253.77.2:34111/' }], origins: ['https://ark-proto.stardust.matce.cn'] };
  const value = await f.write(cfg);
  assert.equal(Object.hasOwn(value, 'key'), false);
  await assert.rejects(f.write({ ...cfg, nodes: [{ ...cfg.nodes[0], keyFile: f.keyFile }] }));
  await assert.rejects(f.write({ ...cfg, origins: ['*'] }));
});

test('public game display slots are bounded, unique and available only on game or keyed coordinator nodes', async t => {
  const f = await fixture(t);
  assert.equal((await f.write({ ...game(f.keyFile), publicSlot: 16, combatWorkers: 8 })).publicSlot, 16);
  for (const publicSlot of [0, 257, '16', 1.5, null]) await assert.rejects(f.write({ ...game(f.keyFile), publicSlot }));
  const cfg = { role: 'coordinator', build, host: '127.0.0.1', port: 34100, privateHost: '127.0.0.1', privatePort: 34110,
    nodes: [1, 2].map(slot => ({ nodeId: `game-${slot}`, publicSlot: slot, url: `http://10.253.77.2:${34110 + slot}/`, keyFile: f.keyFile })) };
  const value = await f.write(cfg);
  assert.deepEqual(value.nodes.map(node => node.publicSlot), [1, 2]);
  await assert.rejects(f.write({ ...cfg, nodes: cfg.nodes.map(node => ({ ...node, publicSlot: 1 })) }));
  await assert.rejects(f.write({ ...cfg, nodes: cfg.nodes.map(node => ({ ...node, publicSlot: 257 })) }));
  await assert.rejects(f.write({ role: 'ingress', host: '127.0.0.1', port: 34101, coordinatorUrl: 'http://10.253.77.2:34100/',
    nodes: [{ nodeId: 'game-1', publicSlot: 1, url: 'http://10.253.77.2:34111/' }], origins: ['https://ark-proto.stardust.matce.cn'] }));
});
