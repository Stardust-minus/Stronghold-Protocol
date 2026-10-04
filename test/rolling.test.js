// Real local HTTP/WS backends + stable gateway. No production services, deployment, or art downloads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { startServer } from '../server/index.js';
import { startGateway } from '../server/rolling/gateway.js';
import { controlRequest, startControl, writePrivateJson } from '../server/rolling/control.js';
import { TestClient } from './helpers/wsClient.js';
import { MATCHMAKING_VERSION } from '../shared/constants.js';

const ORIGIN = 'https://game.example.test';
const HOST = 'game.example.test';
function request(port, pathname, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers: { host: HOST, ...headers }, agent: false }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.end();
  });
}
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(10); }
  assert.fail('local state did not settle');
}
async function fixture(t, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-roll-')); await fs.chmod(dir, 0o700);
  const clients = new Set(); const backends = [];
  let gateway;
  t.after(async () => {
    await Promise.all([...clients].map((c) => c.terminate().catch(() => {})));
    await gateway?.close(); await Promise.all(backends.map((b) => b.close()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  async function backend(id, options = {}) {
    const publicDir = path.join(dir, id);
    await fs.mkdir(path.join(publicDir, 'js', 'nested'), { recursive: true });
    await fs.mkdir(path.join(publicDir, 'assets', 'audio'), { recursive: true });
    await fs.writeFile(path.join(publicDir, 'index.html'), `<script type="module" src="./js/version.js"></script>${id}`);
    await fs.writeFile(path.join(publicDir, 'js', 'version.js'), `export default '${id}';`);
    await fs.writeFile(path.join(publicDir, 'js', 'nested', 'index.html'), id);
    await fs.writeFile(path.join(publicDir, 'assets', 'audio', 'song.mp3'), `fake-audio-${id}`);
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, publicDir, releaseId: id,
      controlSocket: path.join(dir, `${id}.sock`), draining: id !== 'old', helloTimeoutMs: 10000, ...options });
    backends.push(srv); return srv;
  }
  const old = await backend('old', extra.backendOptions);
  const next = await backend('new', extra.backendOptions);
  const releases = [old, next].map((srv, i) => ({ id: i ? 'new' : 'old', port: srv.port, controlSocket: srv.rollingControl.socketPath, localStatic: true }));
  const registryFile = path.join(dir, 'registry.json'); await writePrivateJson(registryFile, { releases });
  const config = { publicOrigins: [ORIGIN], trustedProxyAddresses: ['127.0.0.1'], allowLocalStatic: true,
    activeReleaseId: 'old', registryFile, stateFile: path.join(dir, 'state.json'), controlSocket: path.join(dir, 'gateway.sock'), ...extra.gatewayOptions };
  gateway = await startGateway(config);
  async function connect(id = 'old', headers = {}) {
    const c = await TestClient.connect(`ws://127.0.0.1:${gateway.port}/_release/${id}/ws`, { wsOptions: { origin: ORIGIN, headers: { host: HOST, ...headers } } });
    clients.add(c); return c;
  }
  async function player(id = 'old', token, headers) {
    const client = await connect(id, headers); const welcome = await client.hello('Doctor', token);
    return { client, welcome };
  }
  return { dir, old, next, config, releases, registryFile, backend, connect, player,
    get gateway() { return gateway; }, admin: (input) => controlRequest(config.controlSocket, input, 10000),
    async restart() { await gateway.close(); gateway = await startGateway(config); } };
}
async function create(client, mode = 'solo') {
  assert.equal((await client.request({ t: 'room.create', mode, difficulty: 'NORMAL' })).t, 'ok');
  return client.waitFor('room.state', (value) => value.mode === mode);
}
async function start(client) {
  assert.equal((await client.request({ t: 'room.start' })).t, 'ok');
  return client.waitFor('m.public');
}

test('rolling cutover/rollback keep real matches and both live WS tunnels on their own process', async (t) => {
  const f = await fixture(t);
  const a = await f.player(); const room = await create(a.client); await start(a.client);
  const match = f.old.lobby.getRoom(room.code).match;
  const gamePlayer = match.players.get(a.welcome.playerId);
  const lobbyPlayer = await f.player(); const idleRoom = await create(lobbyPlayer.client, 'coop');
  const queued = await f.connect(); await queued.hello('Queued', undefined, { matchmakingVersion: MATCHMAKING_VERSION });
  assert.equal((await queued.request({ t: 'queue.join', difficulty: 'NORMAL' })).t, 'ok');
  assert.equal(f.old.lobby.stats().queued, 1);
  assert.equal((await request(f.gateway.port, '/?room=ABCD&token=never&redirect=https://evil')).headers.location, '/_release/old/public/?room=ABCD');
  await f.admin({ op: 'activate', releaseId: 'new' });
  assert.equal(f.old.lobby.stats().queued, 0, 'drain cancels old queue tickets without moving them into a new release');
  assert.equal((await request(f.gateway.port, '/')).headers.location, '/_release/new/public/');
  assert.equal(a.client.isOpen, true);
  assert.equal((await a.client.request({ t: 'ping', c: 1 })).t, 'pong');
  assert.equal(f.old.lobby.getRoom(room.code).match, match);
  assert.equal(match.players.get(a.welcome.playerId), gamePlayer);
  assert.equal(match.ended, false);
  assert.equal((await lobbyPlayer.client.request({ t: 'room.start' })).code, 'MAINTENANCE');
  assert.equal((await a.client.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' })).code, 'MAINTENANCE');
  const outsider = await f.player();
  assert.equal((await outsider.client.request({ t: 'room.join', code: idleRoom.code })).code, 'MAINTENANCE');
  assert.equal((await outsider.client.request({ t: 'queue.join', difficulty: 'NORMAL' })).code, 'MAINTENANCE');
  const b = await f.player('new'); const newRoom = await create(b.client); await start(b.client);
  const newMatch = f.next.lobby.getRoom(newRoom.code).match;
  await f.admin({ op: 'rollback', releaseId: 'old' });
  assert.equal((await request(f.gateway.port, '/')).headers.location, '/_release/old/public/');
  assert.equal((await a.client.request({ t: 'ping', c: 2 })).t, 'pong');
  assert.equal((await b.client.request({ t: 'ping', c: 3 })).t, 'pong');
  assert.equal(f.next.lobby.getRoom(newRoom.code).match, newMatch);
  assert.equal(newMatch.ended, false);
  const bootstrap = JSON.parse((await request(f.gateway.port, '/_release/new/_bootstrap')).body);
  assert.deepEqual(bootstrap, { releaseId: 'new', releaseBase: '/_release/new/public/', wsPath: '/_release/new/ws', currentReleaseId: 'old', currentReleaseBase: '/_release/old/public/', draining: true });
  const state = await f.admin({ op: 'status' });
  assert.equal(state.releases.find((r) => r.id === 'new').matches, 1);
  assert.equal(state.releases.find((r) => r.id === 'old').retainedSessions, 2);
});

test('unrelated origins may access only registered public material mounts, never business routes', async (t) => {
  const f = await fixture(t);
  const asset = '/_release/old/public/assets/audio/song.mp3';
  for (const value of ['https://another-site.example', 'null']) {
    const headers = { origin: value };
    const response = await request(f.gateway.port, asset, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.body.toString(), 'fake-audio-old');
    for (const url of ['/', '/_server/presence', '/_release/old/public/', '/_release/old/public/js/version.js', '/_release/old/data/config.json', '/_release/old/client-build', '/_release/old/_bootstrap']) {
      assert.equal((await request(f.gateway.port, url, { headers })).status, 403, `private origin policy: ${url}`);
    }
  }
  const preflight = await request(f.gateway.port, asset, { method: 'OPTIONS', headers: { origin: 'https://another-site.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'range, if-range' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], '*');
  assert.equal(preflight.headers['access-control-allow-credentials'], undefined);
  assert.match(preflight.headers['access-control-allow-methods'], /GET, HEAD, OPTIONS/);
  assert.equal((await request(f.gateway.port, asset, { method: 'OPTIONS', headers: { origin: 'https://another-site.example', 'access-control-request-method': 'POST' } })).status, 405);
  assert.equal((await request(f.gateway.port, asset, { method: 'OPTIONS', headers: { origin: 'https://another-site.example', 'access-control-request-headers': 'authorization' } })).status, 403);
  assert.equal((await request(f.gateway.port, '/_release/old/public/js/version.js', { method: 'OPTIONS', headers: { origin: 'https://another-site.example' } })).status, 403);
  assert.equal((await request(f.gateway.port, asset, { headers: { origin: 'not-an-origin' } })).status, 403);
  assert.equal((await request(f.gateway.port, asset, { headers: { origin: 'https://another-site.example', host: 'wrong.example' } })).status, 403);
  assert.equal((await request(f.gateway.port, '/_release/unknown/public/assets/audio/song.mp3', { headers: { origin: 'https://another-site.example' } })).status, 404);
});

test('client build markers are minimal, release-pinned and never expose private health', async (t) => {
  const f = await fixture(t);
  const marker = async id => {
    const response = await request(f.gateway.port, `/_release/${id}/client-build`);
    assert.equal(response.status, 200);
    assert.match(response.headers['cache-control'], /no-store/);
    const value = JSON.parse(response.body);
    assert.deepEqual(Object.keys(value), ['build']);
    assert.match(value.build, /^[a-f0-9]{12}$/);
    return value;
  };
  const old = await marker('old'), next = await marker('new');
  await f.admin({ op: 'activate', releaseId: 'new' });
  assert.deepEqual(await marker('old'), old);
  assert.deepEqual(await marker('new'), next);
  for (const url of ['/healthz', '/_release/old/healthz', '/control', '/_release/old/control']) assert.equal((await request(f.gateway.port, url)).status, 404);
});

test('forced disconnect and gateway restart resume the old release with exact token, player and real room', async (t) => {
  const f = await fixture(t);
  const a = await f.player(); const room = await create(a.client); await start(a.client);
  const match = f.old.lobby.getRoom(room.code).match;
  await f.admin({ op: 'activate', releaseId: 'new' });
  await a.client.terminate();
  const b = await f.player('old', a.welcome.token);
  assert.equal(b.welcome.resumed, true); assert.equal(b.welcome.playerId, a.welcome.playerId); assert.equal(b.welcome.token, a.welcome.token);
  assert.equal((await b.client.waitFor('room.state')).code, room.code);
  assert.equal(f.old.lobby.getRoom(room.code).match, match);
  const previousPort = f.gateway.port;
  await f.restart(); await b.client.closed;
  await assert.rejects(request(previousPort, '/'));
  assert.equal((await request(f.gateway.port, '/')).headers.location, '/_release/new/public/', 'persisted active id wins over startup old default');
  const c = await f.player('old', a.welcome.token);
  assert.equal(c.welcome.resumed, true); assert.equal((await c.client.waitFor('room.state')).code, room.code);
  assert.equal(f.old.lobby.getRoom(room.code).match, match, 'gateway close never killed backend');
  assert.equal((await c.client.request({ t: 'ping', c: 1 })).t, 'pong');
});

test('unknown/dead releases explicitly fail, never fall back to current process', async (t) => {
  const f = await fixture(t); await f.admin({ op: 'activate', releaseId: 'new' });
  assert.equal((await request(f.gateway.port, '/_release/unknown/js/version.js')).status, 404);
  await f.old.close();
  assert.equal((await request(f.gateway.port, '/_release/old/public/')).status, 502);
  await assert.rejects(f.connect('old'), /502/);
  assert.equal(f.next.registry.size, 0);
  await assert.rejects(f.admin({ op: 'rollback', releaseId: 'old' }));
  assert.equal((await request(f.gateway.port, '/')).headers.location, '/_release/new/public/');
});

test('retirement fences tunnels, live rooms, retained results and queued/identified sessions, and never stops backend', async (t) => {
  const f = await fixture(t); const a = await f.player(); const room = await create(a.client); await start(a.client);
  await f.admin({ op: 'activate', releaseId: 'new' });
  await assert.rejects(f.admin({ op: 'retire', releaseId: 'old' }), /RELEASE_HAS_CONNECTIONS/);
  await a.client.terminate(); await until(async () => (await f.admin({ op: 'status' })).releases.find((r) => r.id === 'old').tunnels === 0);
  await assert.rejects(f.admin({ op: 'retire', releaseId: 'old' }), /RELEASE_HAS_STATE/);
  const back = await f.player('old', a.welcome.token); await back.client.waitFor('room.state');
  assert.equal((await back.client.request({ t: 'room.leave' })).t, 'ok'); await back.client.terminate();
  await until(() => f.old.lobby.stats().online === 0);
  const retained = f.old.registry.create('Retained'); retained.pendingResult = ['test-result'];
  await assert.rejects(f.admin({ op: 'retire', releaseId: 'old' }), /RELEASE_HAS_STATE/);
  retained.pendingResult = null;
  const unidentified = await f.connect('old');
  await assert.rejects(f.admin({ op: 'retire', releaseId: 'old' }), /RELEASE_HAS_CONNECTIONS/);
  await unidentified.terminate(); await until(async () => (await f.admin({ op: 'status' })).releases.find((r) => r.id === 'old').tunnels === 0);
  assert.equal(f.old.lobby.getRoom(room.code), null);
  const result = await f.admin({ op: 'retire', releaseId: 'old' }); assert.equal(result.backendStopped, false);
  assert.equal((await request(f.gateway.port, '/_release/old/public/')).status, 410);
  assert.equal((await request(f.old.port, '/healthz')).status, 200);
  await assert.rejects(f.admin({ op: 'retire', releaseId: 'new' }), /CANNOT_RETIRE_ACTIVE/);
  await f.restart(); assert.equal((await request(f.gateway.port, '/_release/old/public/')).status, 410);
});

test('gateway blocks traversal, unknown public admin/health/auth, forged hosts and websocket Origins', async (t) => {
  const f = await fixture(t);
  for (const url of ['/control', '/healthz', '/_server/status', '/entry', '/api/auth', '/ws', '/js/version.js', '/_release/old/healthz', '/_release/old/control', '/_release/old/server/index.js']) {
    assert.equal((await request(f.gateway.port, url)).status, 404, url);
  }
  for (const url of ['/_release/old/../new/', '/_release/old/%2e%2e/new/', '/_release/old/%252e%252e/new/', '/_release/old/%2f%2fevil.test/', '/_release/old/js/a\\b.js', '//evil.test/', 'http://evil.test/_release/old/']) {
    assert.equal((await request(f.gateway.port, url)).status, 400, url);
  }
  assert.equal((await request(f.gateway.port, '/', { headers: { host: 'evil.test' } })).status, 403);
  assert.equal((await request(f.gateway.port, '/_server/presence', { headers: { origin: 'https://evil.test' } })).status, 403);
  await assert.rejects(TestClient.connect(`ws://127.0.0.1:${f.gateway.port}/_release/old/ws`, { wsOptions: { origin: 'https://evil.test', headers: { host: HOST, 'x-forwarded-origin': ORIGIN } } }), /403/);
  await assert.rejects(TestClient.connect(`ws://127.0.0.1:${f.gateway.port}/_release/old/ws`, { wsOptions: { headers: { host: HOST } } }), /403/);
  await assert.rejects(TestClient.connect(`ws://127.0.0.1:${f.gateway.port}/_release/old/ws?target=new`, { wsOptions: { origin: ORIGIN, headers: { host: HOST } } }), /404/);
});

test('trusted original public client addresses survive proxy and forged CF/XFF cannot defeat backend quotas', async (t) => {
  const f = await fixture(t, { backendOptions: { maxConnectionsPerAddr: 1, trustProxy: 'auto' } });
  const headers = { 'x-real-ip': '203.0.113.7', 'cf-connecting-ip': '127.0.0.1', 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'evil.test' };
  const a = await f.player('old', undefined, headers);
  const b = await f.player('old', undefined, { ...headers, 'x-real-ip': '198.51.100.8' });
  assert.equal(f.old.registry.byId(a.welcome.playerId).limitKey, '203.0.113.7');
  assert.equal(f.old.registry.byId(b.welcome.playerId).limitKey, '198.51.100.8');
  assert.equal(f.old.registry.byId(a.welcome.playerId).addr, '203.0.113.7');
  await assert.rejects(f.connect('old', headers), /429/);
  assert.equal((await a.client.request({ t: 'ping', c: 1 })).t, 'pong');
});

test('forwarding headers from an untrusted peer are discarded', async (t) => {
  const f = await fixture(t, { gatewayOptions: { trustedProxyAddresses: [] } });
  const a = await f.player('old', undefined, { 'x-real-ip': '203.0.113.7', 'cf-connecting-ip': '203.0.113.8' });
  assert.equal(f.old.registry.byId(a.welcome.playerId).addr, '127.0.0.1');
});

test('code and local test assets remain release-pinned including HEAD, Range and directory redirects', async (t) => {
  const f = await fixture(t);
  const before = await request(f.gateway.port, '/_release/old/assets/audio/song.mp3');
  await f.admin({ op: 'activate', releaseId: 'new' });
  assert.equal((await request(f.gateway.port, '/_release/old/js/version.js')).body.toString(), "export default 'old';");
  assert.equal((await request(f.gateway.port, '/_release/new/js/version.js')).body.toString(), "export default 'new';");
  assert.deepEqual((await request(f.gateway.port, '/_release/old/assets/audio/song.mp3')).body, before.body);
  const range = await request(f.gateway.port, '/_release/old/media/song', { headers: { range: 'bytes=2-5' } });
  assert.equal(range.status, 206); assert.equal(range.body.toString(), 'ke-a');
  assert.equal(range.headers['content-range'], 'bytes 2-5/14');
  const head = await request(f.gateway.port, '/_release/old/media/song', { method: 'HEAD', headers: { range: 'bytes=2-5' } });
  assert.equal(head.status, 206); assert.equal(head.body.length, 0); assert.equal(head.headers['content-length'], '4');
  const redirect = await request(f.gateway.port, '/_release/old/js/nested');
  assert.equal(redirect.headers.location, '/_release/old/js/nested/');
  const notModified = await request(f.gateway.port, '/_release/old/assets/audio/song.mp3', { headers: { 'if-none-match': before.headers.etag } });
  assert.equal(notModified.status, 304);
});

test('canonical public/server URL topology preserves native relative imports within the exact release', async (t) => {
  const f = await fixture(t);
  assert.equal((await request(f.gateway.port, '/_release/old/?room=ABCD')).headers.location, '/_release/old/public/?room=ABCD');
  assert.equal((await request(f.gateway.port, '/_release/old/public/')).status, 200);
  assert.equal((await request(f.gateway.port, '/_release/old/public/js/version.js')).body.toString(), "export default 'old';");
  assert.equal((await request(f.gateway.port, '/_release/old/public/js/nested')).headers.location, '/_release/old/public/js/nested/');
  for (const [specifier, importer, expected] of [
    ['../../shared/constants.js', '/public/js/net.js', '/shared/constants.js'],
    ['../../shared/constants.js', '/server/sim/constants.js', '/shared/constants.js'],
    ['../../../data.js', '/server/sim/content/support/index.js', '/server/data.js'],
    ['./sim/simdata.js', '/server/data.js', '/server/sim/simdata.js'],
  ]) {
    const resolved = new URL(specifier, ORIGIN + '/_release/old' + importer).pathname;
    assert.equal(resolved, '/_release/old' + expected);
    assert.equal((await request(f.gateway.port, resolved)).status, 200, resolved);
  }
  assert.equal((await request(f.gateway.port, '/_release/old/server/sim/nodeData.js')).status, 404);
  assert.equal((await request(f.gateway.port, '/_release/old/public/server/index.js')).status, 404);
});

test('presence aggregates numeric identities across releases without private health or session data', async (t) => {
  const f = await fixture(t); const a = await f.player(); await f.admin({ op: 'activate', releaseId: 'new' }); await f.player('new');
  const value = JSON.parse((await request(f.gateway.port, '/_server/presence')).body);
  assert.equal(value.online, 2); assert.equal(value.scope, 'all-releases'); assert.equal(value.available, true);
  assert.deepEqual(Object.keys(value).sort(), ['available', 'online', 'queued', 'scope', 'serverNow']);
  assert.ok(!JSON.stringify(value).includes(a.welcome.token));
  await f.old.close(); await delay(1010);
  const unavailable = JSON.parse((await request(f.gateway.port, '/_server/presence')).body);
  assert.equal(unavailable.available, false);
});

test('registry hot reload adds a staged release but existing and retired target identities are immutable', async (t) => {
  const f = await fixture(t); const third = await f.backend('third');
  const entry = { id: 'third', port: third.port, controlSocket: third.rollingControl.socketPath, localStatic: true };
  await writePrivateJson(f.registryFile, { releases: [...f.releases, entry] });
  const stateBefore = await fs.readFile(f.config.stateFile);
  await assert.rejects(startGateway(f.config), /CONTROL_PATH_EXISTS/);
  assert.deepEqual(await fs.readFile(f.config.stateFile), stateBefore, 'second gateway cannot rewrite live routing state before claiming listener');
  await f.admin({ op: 'reload' }); await f.admin({ op: 'activate', releaseId: 'third' });
  assert.equal((await request(f.gateway.port, '/')).headers.location, '/_release/third/public/');
  await writePrivateJson(f.registryFile, { releases: [{ ...f.releases[0], port: third.port }, f.releases[1], entry] });
  await assert.rejects(f.admin({ op: 'reload' }), /IMMUTABLE_RELEASE_CHANGED/);
  assert.equal((await request(f.gateway.port, '/_release/old/js/version.js')).body.toString(), "export default 'old';");
  assert.equal((await fs.stat(f.config.stateFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.config.controlSocket)).mode & 0o777, 0o600);
});

test('production static routing pins OpenI resolver identity, display/CORS modes and same-release fallback without credentials', async (t) => {
  const f = await fixture(t);
  const captures = []; let metadataBad = false, locationBad = false, failed = false;
  const hash = createHash('sha256').update('explicit-test-material').digest('hex');
  const resolver = http.createServer((req, res) => {
    if (req.url === '/_material') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ release: 'art-old', manifestHash: metadataBad ? '0'.repeat(64) : hash })); return;
    }
    captures.push({ path: req.url, headers: req.headers, method: req.method });
    const mode = req.headers.origin || req.headers['sec-fetch-mode'] === 'cors' ? 'cors' : 'display';
    if (failed) { res.writeHead(503); res.end(); return; }
    const base = locationBad ? 'https://objects.example.test/root/releases/art-new' : 'https://objects.example.test/root/releases/mirror-old';
    const location = req.method === 'HEAD' ? 'https://static.example.test/releases/art-old' + req.url : base + req.url + '?Signature=test-only&sp_request=' + mode;
    res.writeHead(302, { Location: location }); res.end();
  });
  await new Promise((resolve) => resolver.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => resolver.close(resolve)));
  const staticRoutes = Object.fromEntries(['fonts', 'vendor'].map((mount) => [mount, { materialReleaseId: 'art-old', redirectBase: `https://static.example.test/releases/art-old/${mount}/` }]));
  const release = { id: 'old', port: f.old.port, controlSocket: f.old.rollingControl.socketPath, staticRoutes,
    assetResolver: { port: resolver.address().port, materialReleaseId: 'art-old', mirrorReleaseId: 'mirror-old', manifestHash: hash,
      ossOrigin: 'https://objects.example.test', ossPathPrefix: '/root/releases/mirror-old/', fallbackBase: 'https://static.example.test/releases/art-old/' } };
  const cfg = { publicOrigins: [ORIGIN], staticOrigins: ['https://objects.example.test', 'https://static.example.test'], activeReleaseId: 'old', releases: [release], stateFile: path.join(f.dir, 'prod.json'), controlSocket: path.join(f.dir, 'prod.sock') };
  const gateway = await startGateway(cfg); t.after(() => gateway.close());
  const image = '/_release/old/assets/spine/unit%5Bskin%5D.skel';
  const display = await request(gateway.port, image, { headers: { 'sec-fetch-mode': 'no-cors', cookie: 'gate=test-only', authorization: 'test-only', 'proxy-authorization': 'test-only' } });
  assert.equal(display.status, 302); assert.match(display.headers.location, /mirror-old\/assets\/spine\/unit%5Bskin%5D.skel\?Signature=test-only&sp_request=display$/);
  const cors = await request(gateway.port, image, { headers: { origin: ORIGIN, 'sec-fetch-mode': 'cors' } });
  assert.match(cors.headers.location, /sp_request=cors$/);
  assert.equal(captures[0].headers.cookie, undefined); assert.equal(captures[0].headers.authorization, undefined); assert.equal(captures[0].headers['proxy-authorization'], undefined);
  assert.equal(captures[1].headers.origin, ORIGIN); assert.equal(captures[1].headers['sec-fetch-mode'], 'cors');
  const fonts = await request(gateway.port, '/_release/old/fonts/fonts.css');
  assert.equal(fonts.headers.location, 'https://static.example.test/releases/art-old/fonts/fonts.css');
  const audio = await request(gateway.port, '/_release/old/media/song');
  assert.match(audio.headers.location, /mirror-old\/media\/song\?/); assert.doesNotMatch(audio.headers.location, /\.mp3/);
  const head = await request(gateway.port, '/_release/old/media/song', { method: 'HEAD' });
  assert.equal(head.headers.location, 'https://static.example.test/releases/art-old/media/song'); assert.equal(head.body.length, 0);
  assert.equal((await request(gateway.port, '/_release/old/_material')).status, 404);
  locationBad = true;
  assert.equal((await request(gateway.port, image)).status, 502, 'another material release is never a valid signed redirect');
  locationBad = false; metadataBad = true;
  assert.equal((await request(gateway.port, image)).status, 503, 'metadata mismatch must not silently fallback');
  await assert.rejects(controlRequest(cfg.controlSocket, { op: 'activate', releaseId: 'old' }), /MATERIAL_IDENTITY_FAILED/);
  metadataBad = false; failed = true;
  assert.equal((await request(gateway.port, '/_release/old/media/song')).headers.location, 'https://static.example.test/releases/art-old/media/song');
  await new Promise((resolve) => resolver.close(resolve));
  assert.equal((await request(gateway.port, '/_release/old/assets/a.png')).headers.location, 'https://static.example.test/releases/art-old/assets/a.png');
});

test('private control refuses browser Origin, unsafe directory permissions and listener takeover', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-roll-sec-')); await fs.chmod(dir, 0o700);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const socketPath = path.join(dir, 'control.sock'); const control = await startControl(socketPath, () => ({ ok: true }));
  t.after(() => control.close());
  await assert.rejects(startControl(socketPath, () => ({})), /CONTROL_PATH_EXISTS/);
  const denied = await new Promise((resolve, reject) => {
    const body = '{"op":"status"}';
    const req = http.request({ socketPath, path: '/control', method: 'POST', headers: { origin: ORIGIN, 'Content-Length': body.length } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(body);
  }); assert.equal(denied, 403);
  await fs.chmod(dir, 0o755);
  await assert.rejects(startControl(path.join(dir, 'unsafe.sock'), () => ({})), /PRIVATE_DIRECTORY_REQUIRED/);
  await fs.chmod(dir, 0o700);
});
