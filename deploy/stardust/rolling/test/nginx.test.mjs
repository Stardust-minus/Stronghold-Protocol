// Real TLS Nginx -> actual password gate -> two real Node24 servers -> native rolling gateway.
// Host Node may be26; the backends/gateway/auth/resolvers MUST be the pinned Node24 image.
// Explicit opt-in, isolated loopback listeners, no external fetch, no production reload/restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { TestClient } from '../../../../test/helpers/wsClient.js';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const candidate = fileURLToPath(new URL('../', import.meta.url));
const ORIGIN = 'https://ark-proto.stardust.matce.cn';
const HOST = new URL(ORIGIN).hostname;
const image = 'node@sha256:7fddd9ddeae8196abf4a3ef2de34e11f7b1a722119f91f28ddf1e99dcafdf114';
const binary = process.env.NGINX_BIN;
const enabled = process.env.ROLLING_NGINX_SMOKE === '1' && !!binary;
async function freePort() {
  const srv = net.createServer(); await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port; await new Promise(resolve => srv.close(resolve)); return port;
}
async function waitFor(check, label, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(25); }
  throw new Error('Deadline exceeded: ' + label);
}
async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const done = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGQUIT');
  const kill = setTimeout(() => child.kill('SIGKILL'), 2500); await done; clearTimeout(kill);
}

test('candidate Compose keeps immutable loopback releases and host-network private gateway', async () => {
  const release = await fs.readFile(path.join(candidate, 'compose.release.yaml'), 'utf8');
  const gateway = await fs.readFile(path.join(candidate, 'compose.gateway.yaml'), 'utf8');
  const sidecars = await fs.readFile(path.join(candidate, 'compose.sidecars.yaml'), 'utf8');
  assert.match(release, /name: ark-release-\$\{SP_RELEASE_ID/);
  assert.match(release, /127\.0\.0\.1:\$\{ARK_GAME_PORT/);
  assert.match(release, /SP_COMBAT_WORKERS: "6"/);
  assert.match(release, /SP_COMBAT: server/); assert.match(release, /SP_VERIFY: "off"/);
  assert.match(release, /SP_ROLLING_DRAINING: "1"/); assert.match(release, /pids_limit: 128/);
  assert.doesNotMatch(release, /^\s*(?:cpus|mem_limit|mem_reservation|resources):/m);
  for (const text of [release, gateway]) {
    assert.match(text, /user: "1000:1000"/); assert.match(text, /create_host_path: false/);
    assert.match(text, /read_only: true/); assert.match(text, /no-new-privileges:true/);
  }
  assert.match(gateway, /network_mode: host/); assert.doesNotMatch(gateway, /^\s*ports:/m);
  assert.match(gateway, /server\/rolling\/gateway\.js/); assert.match(gateway, /disable: true/);
  assert.match(sidecars, /ARK_AUTH_IMAGE:\?set a new name-policy auth image/);
  assert.match(sidecars, /ARK_ASSETS_IMAGE:\?set a new material-metadata resolver image, not v3/);
  const config = JSON.parse(await fs.readFile(path.join(candidate, 'gateway.json.example')));
  assert.equal(config.port, 3190); assert.deepEqual(config.trustedProxyAddresses, ['127.0.0.1']);
  assert.equal(config.allowLocalStatic, undefined);
  const registry = JSON.parse(await fs.readFile(path.join(candidate, 'registry.json.example')));
  assert.doesNotMatch(registry.releases[0].assetResolver.manifestHash, /^[a-f0-9]{64}$/,
    'unprepared placeholder must fail closed, never masquerade as a release hash');
});

test('Docker Compose parses candidate YAML without creating containers or directories', { skip: !enabled }, () => {
  const env = { ...process.env, SP_RELEASE_ID: 'local-schema-only', ARK_GAME_PORT: '3120',
    ARK_GAME_IMAGE: 'ark-game:local-schema-only', ARK_GATEWAY_IMAGE: 'ark-game:local-schema-only',
    ARK_AUTH_IMAGE: 'ark-auth:new-policy-local-schema-only', ARK_ASSETS_IMAGE: 'ark-assets:new-material-local-schema-only',
    ARK_ASSETS_PORT: '3130', ARK_AUTH_PORT: '3140', ARK_ROLLING_PRIVATE_DIR: '/tmp/not-created-ark-private',
    ARK_AUTH_SECRETS_FILE: '/tmp/not-created-test-only-secret', ARK_ASSET_MANIFEST: '/tmp/not-created-test-only-manifest' };
  const parse = filename => JSON.parse(execFileSync('docker', ['compose', '-f', path.join(candidate, filename),
    'config', '--format', 'json'], { env, timeout: 10000 }).toString());
  const release = parse('compose.release.yaml');
  assert.equal(release.name, 'ark-release-local-schema-only');
  assert.equal(release.services.game.environment.SP_COMBAT_WORKERS, '6');
  assert.equal(release.services.game.ports[0].host_ip, '127.0.0.1');
  for (const key of ['cpus', 'mem_limit', 'mem_reservation', 'deploy', 'container_name']) assert.equal(release.services.game[key], undefined);
  assert.equal(release.services.game.volumes[0].bind.create_host_path, false);
  const gateway = parse('compose.gateway.yaml').services.gateway;
  assert.equal(gateway.network_mode, 'host'); assert.equal(gateway.ports, undefined);
  assert.equal(gateway.healthcheck.disable, true);
  const sidecars = parse('compose.sidecars.yaml').services;
  assert.equal(sidecars.auth.ports[0].host_ip, '127.0.0.1');
  assert.equal(sidecars.assets.ports[0].host_ip, '127.0.0.1');
});

test('REAL Nginx TLS/gate/release HTTP+WS+OpenI integration', { skip: !enabled, timeout: 90000 }, async t => {
  execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore', timeout: 10000 });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ark-rolling-nginx-'));
  await fs.chmod(dir, 0o755); await fs.chown(dir, 1000, 1000);
  const name = 'ark-rolling-nginx-test-' + process.pid + '-' + Date.now();
  const clients = new Set(); let nginx, fixture, log = '', nginxLog = '';
  let dockerStarted = false;
  t.after(async () => {
    await Promise.all([...clients].map(client => client.terminate().catch(() => {})));
    await stopChild(nginx);
    if (dockerStarted) {
      try { execFileSync('docker', ['stop', '--time', '5', name], { stdio: 'ignore', timeout: 12000 }); } catch {}
    }
    if (fixture && fixture.exitCode === null) {
      await Promise.race([new Promise(resolve => fixture.once('exit', resolve)), delay(1000)]);
      if (fixture.exitCode === null) fixture.kill('SIGKILL');
    }
    if (process.env.ROLLING_NGINX_KEEP !== '1') await fs.rm(dir, { recursive: true, force: true });
  });
  fixture = spawn('docker', ['run', '--rm', '--pull=never', '--name', name, '--network', 'host',
    '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '128', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
    '-v', repo + ':/app:ro', '-v', `${dir}:${dir}:rw`, '-e', 'FIXTURE_DIR=' + dir,
    '-e', 'SP_COMBAT=server', '-e', 'SP_VERIFY=off', image,
    'node', '/app/deploy/stardust/rolling/fixtures/nginx-runtime.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
  dockerStarted = true;
  fixture.stdout.on('data', chunk => { log += chunk; }); fixture.stderr.on('data', chunk => { log += chunk; });
  const ready = await waitFor(async () => {
    if (fixture.exitCode !== null) throw new Error('Node24 fixture failed: ' + log);
    try { return JSON.parse(await fs.readFile(path.join(dir, 'ready.json'))); } catch { return null; }
  }, 'Node24 fixture ready');
  assert.match(ready.runtime, /^v24\./);
  assert.equal(ready.backends.length, 2);
  assert.equal(new Set([ready.gatewayPid, ...ready.backends.map(value => value.pid)]).size, 3,
    'two separate game processes plus gateway, never shared in-memory game state');
  for (const backend of ready.backends) assert.match(backend.runtime, /^v24\./);
  t.diagnostic('two separate backend processes + gateway/gate/resolvers runtime ' + ready.runtime + '; orchestration ' + process.version);
  let seq = 0;
  async function command(op, releaseId) {
    const commandSeq = ++seq;
    await fs.writeFile(path.join(dir, 'command.tmp'), JSON.stringify({ seq: commandSeq, op, releaseId }));
    await fs.rename(path.join(dir, 'command.tmp'), path.join(dir, 'command.json'));
    const reply = await waitFor(async () => {
      try { const value = JSON.parse(await fs.readFile(path.join(dir, 'reply.json'))); return value.seq === commandSeq ? value : null; } catch { return null; }
    }, 'private fixture command', 10000);
    if (reply.error) throw new Error(reply.error); return reply.result;
  }
  const tlsPort = await freePort(), httpPort = await freePort();
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=rolling-local.test', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')],
    { stdio: 'ignore', timeout: 10000 });
  // Test the candidate verbatim except isolated addresses, certificate/log paths and include root.
  let text = await fs.readFile(path.join(candidate, 'nginx-candidate.conf'), 'utf8');
  text = text.replace('127.0.0.1:3140', '127.0.0.1:' + ready.auth)
    .replace('127.0.0.1:3190', '127.0.0.1:' + ready.gateway)
    .replace('127.0.0.1:3110', '127.0.0.1:' + ready.legacy)
    .replace('listen 80;', `listen 127.0.0.1:${httpPort};`).replace('listen [::]:80;', '')
    .replace('listen 443 ssl;', `listen 127.0.0.1:${tlsPort} ssl;`).replace('listen [::]:443 ssl;', '')
    .replace('/www/sites/ark-proto.stardust.matce.cn/ssl/fullchain.pem', path.join(dir, 'cert.pem'))
    .replace('/www/sites/ark-proto.stardust.matce.cn/ssl/key.pem', path.join(dir, 'key.pem'))
    .replace('access_log /www/sites/ark-proto.stardust.matce.cn/log/access.log main;', 'access_log off;')
    .replace('error_log /www/sites/ark-proto.stardust.matce.cn/log/error.log;', 'error_log stderr warn;')
    .replaceAll('/www/sites/ark-proto.stardust.matce.cn/rolling-candidate/', candidate);
  const config = `worker_processes 1;\nworker_shutdown_timeout 1s;\npid ${dir}/nginx.pid;\nerror_log stderr warn;\nevents { worker_connections 256; }\nhttp {\naccess_log off;\nclient_body_temp_path ${dir}/body;\nproxy_temp_path ${dir}/proxy;\nfastcgi_temp_path ${dir}/fastcgi;\nuwsgi_temp_path ${dir}/uwsgi;\nscgi_temp_path ${dir}/scgi;\n${text}\n}\n`;
  const configPath = path.join(dir, 'nginx.conf'); await fs.writeFile(configPath, config);
  execFileSync(binary, ['-p', dir, '-c', configPath, '-t'], { timeout: 10000 });
  nginx = spawn(binary, ['-p', dir, '-c', configPath, '-g', 'daemon off;'], { stdio: ['ignore', 'ignore', 'pipe'] });
  nginx.stderr.on('data', chunk => { nginxLog += chunk; });
  function request(url, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: tlsPort, path: url, method, rejectUnauthorized: false,
        servername: HOST, agent: false, headers: { host: HOST, ...headers } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject); req.setTimeout(6000, () => req.destroy(new Error('local TLS HTTP timeout'))); req.end(body);
    });
  }
  await waitFor(async () => {
    if (nginx.exitCode !== null) throw new Error('Nginx failed: ' + nginxLog);
    try { return (await request('/healthz')).status === 404; } catch { return false; }
  }, 'isolated TLS listener', 10000);
  const canonical = '/_release/old/public/';
  for (const uri of [canonical + '?_prts=1', canonical + 'index.html?_prts=1', canonical + 'js/main.js',
    '/_release/old/data/config.json', '/_release/old/shared/constants.js', '/_release/old/_bootstrap',
    '/_server/presence', '/_release/old/client-build']) {
    assert.equal((await request(uri)).status, 401, 'anonymous must not receive code/data/API ' + uri);
  }
  for (const cookie of ['__Host-ark_gate=forged', '__Host-ark_gate=bad; __Host-ark_gate=bad']) {
    assert.equal((await request('/_release/old/client-build', { headers: { cookie } })).status, 401);
  }
  const login = await request('/login?next=' + encodeURIComponent(canonical + '?room=ABCD'));
  assert.equal(login.status, 200);
  const csrfCookie = login.headers['set-cookie'][0].split(';')[0];
  const csrf = login.body.match(/name="csrf" value="([^"]+)"/)[1];
  const form = new URLSearchParams({ password: 'local-only-rolling-password', csrf, next: canonical + '?room=ABCD', callsign: '阿米娅' }).toString();
  const authorized = await request('/_gate/login', { method: 'POST', headers: { origin: ORIGIN, cookie: csrfCookie,
    accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  assert.equal(authorized.status, 200);
  assert.equal(JSON.parse(authorized.body).next, canonical + '?room=ABCD');
  const cookie = authorized.headers['set-cookie'].find(value => value.startsWith('__Host-ark_gate=')).split(';')[0];
  const headers = { cookie };
  const navigation = { ...headers, accept: 'text/html', 'sec-fetch-mode': 'navigate' };
  for (const uri of ['/', '/index.html', canonical, canonical + 'index.html']) {
    const entry = await request(uri + '?room=ABCD', { headers: navigation });
    assert.equal(entry.status, 303, 'normal navigation must replay entry: ' + uri + ' Location=' + entry.headers.location);
    const dest = new URL(entry.headers.location, ORIGIN);
    assert.equal(dest.pathname, '/entry');
    assert.equal(dest.searchParams.get('next'), (uri === '/index.html' ? '/' : uri) + '?room=ABCD');
  }
  const root = await request('/?_prts=1&room=ABCD&token=must-not-forward', { headers: navigation });
  assert.equal(root.status, 302); assert.equal(root.headers.location, canonical + '?room=ABCD&_prts=1');
  const rootIndex = await request('/index.html?_prts=1&room=ABCD', { headers: navigation });
  assert.equal(rootIndex.status, 302); assert.equal(rootIndex.headers.location, canonical + '?room=ABCD&_prts=1');
  const page = await request(canonical + '?_prts=1', { headers: navigation });
  assert.equal(page.status, 200);
  const original = await fs.readFile(path.join(repo, 'public/index.html'), 'utf8');
  assert.equal(page.body, original.replace('<head>', '<head><script src="/_gate/assets/entry-nav.js"></script>'),
    'only stable entry-nav injection changes the exact relative-resource game HTML');
  assert.match(page.headers['strict-transport-security'], /max-age=31536000/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.match(page.headers['cache-control'], /no-store/);
  assert.match(login.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal((await request(canonical + 'js/main.js', { headers })).status, 200);
  assert.equal((await request('/_release/old/data/config.json', { headers })).status, 200);
  const marker = await request('/_release/old/client-build', { headers });
  assert.equal(marker.status, 200); assert.deepEqual(Object.keys(JSON.parse(marker.body)), ['build']);
  const before = JSON.parse(marker.body);
  async function ws(id, options = {}) {
    const client = await TestClient.connect(`wss://127.0.0.1:${tlsPort}/_release/${id}/ws`, { wsOptions: {
      rejectUnauthorized: false, origin: ORIGIN, headers: { host: HOST, cookie }, ...options } });
    clients.add(client); return client;
  }
  await assert.rejects(ws('old', { headers: { host: HOST } }), /401/);
  await assert.rejects(ws('old', { origin: 'https://evil.example.test', headers: { host: HOST, cookie, 'x-forwarded-origin': ORIGIN } }), /403/);
  await assert.rejects(ws('old', { origin: undefined }), /403/);
  for (const uri of ['/healthz', '/control', '/_material', '/client-build', '/_gate/check',
    '/_release/old/healthz', '/_release/old/control', '/_release/old/_material',
    '/_release/old/public/healthz', '/_release/old/public/control', '/_release/old/public/_material']) {
    assert.equal((await request(uri, { headers })).status, 404, 'private endpoint ' + uri);
  }
  for (const uri of [canonical + 'js/main.js', '/_server/presence', '/_release/old/client-build']) {
    assert.equal((await request(uri, { headers: { ...headers, origin: 'https://evil.example.test', 'x-forwarded-origin': ORIGIN } })).status, 403);
  }
  const client = await ws('old'); const welcome = await client.hello('Doctor');
  assert.equal((await client.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' })).t, 'ok');
  const room = await client.waitFor('room.state');
  assert.equal((await client.request({ t: 'room.start' })).t, 'ok'); await client.waitFor('m.public');
  const status = await command('status');
  assert.equal(status.releases.find(value => value.id === 'old').matches, 1);
  const presence = await request('/_server/presence', { headers });
  assert.equal(presence.status, 200); assert.equal(JSON.parse(presence.body).online, 1);
  await command('activate', 'new');
  assert.equal((await request('/?_prts=1', { headers: navigation })).headers.location, '/_release/new/public/?_prts=1');
  assert.deepEqual(JSON.parse((await request('/_release/old/client-build', { headers })).body), before);
  assert.equal((await client.request({ t: 'ping', c: 1 })).t, 'pong');
  await client.terminate();
  const resumed = await ws('old'); const restored = await resumed.hello('Doctor', welcome.token);
  assert.equal(restored.resumed, true); assert.equal(restored.playerId, welcome.playerId);
  assert.equal((await resumed.waitFor('room.state')).code, room.code);
  const oldEntry = await request(canonical + '?room=' + room.code, { headers: navigation });
  assert.equal(new URL(oldEntry.headers.location, ORIGIN).searchParams.get('next'), canonical + '?room=' + room.code,
    'reauthentication/replay of an old page must not switch to current');
  const oldGate = await request('/entry?next=' + encodeURIComponent(canonical + '?room=' + room.code), { headers });
  assert.match(oldGate.body, /\/_release\/old\/public\//);
  await assert.rejects(command('retire', 'old'), /RELEASE_HAS_CONNECTIONS/);
  assert.equal((await request('/control', { method: 'POST', headers, body: '{"op":"retire","releaseId":"old"}' })).status, 404);
  // Public art remains unsigned; authenticated cookies and arbitrary credentials never reach resolver.
  for (const [mode, origin, suffix] of [['no-cors', undefined, 'display'], ['cors', ORIGIN, 'cors'],
    ['cors', 'https://unrelated.example.test', 'cors']]) {
    const artHeaders = { cookie, authorization: 'Bearer test-only', 'proxy-authorization': 'Basic test-only', 'sec-fetch-mode': mode,
      range: 'bytes=0-9', 'if-range': 'test-only-etag',
      ...(origin ? { origin } : {}) };
    for (const resource of ['assets/a.png', 'media/audio']) {
      const response = await request(canonical + resource, { headers: artHeaders });
      assert.equal(response.status, 302);
      const loc = new URL(response.headers.location); assert.equal(loc.origin, 'https://obs.cn-south-222.ai.pcl.cn');
      assert.equal(loc.pathname, '/test-bucket/test-dataset/releases/mirror-old/' + resource);
      assert.equal(loc.searchParams.get('sp_request'), suffix);
      assert.equal(response.headers['access-control-allow-origin'], '*');
      assert.equal(response.headers['access-control-allow-credentials'], undefined);
    }
  }
  const anonymousArt = await request(canonical + 'assets/a.png'); assert.equal(anonymousArt.status, 302);
  const preflight = await request(canonical + 'assets/a.png', { method: 'OPTIONS', headers: {
    origin: 'https://unrelated.example.test', 'access-control-request-method': 'GET',
    'access-control-request-headers': 'Range,If-Range', cookie,
    authorization: 'Bearer test-only', 'proxy-authorization': 'Basic test-only' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers['access-control-allow-origin'], '*');
  assert.equal(preflight.headers['access-control-allow-credentials'], undefined);
  assert.match(preflight.headers['access-control-allow-methods'], /GET/);
  assert.match(preflight.headers['access-control-allow-headers'], /Range/i);
  assert.equal((await request('/_release/old/client-build', { method: 'OPTIONS', headers: { origin: ORIGIN } })).status, 401);
  assert.equal((await request('/_release/old/client-build', { method: 'OPTIONS', headers: { ...headers, origin: 'https://unrelated.example.test' } })).status, 403);
  const observations = await command('observed');
  assert.ok(observations.length >= 7);
  const crossOrigin = observations.find(value => value.headers.origin === 'https://unrelated.example.test');
  assert.ok(crossOrigin); assert.equal(crossOrigin.headers['sec-fetch-mode'], 'cors');
  assert.equal(crossOrigin.headers.range, 'bytes=0-9'); assert.equal(crossOrigin.headers['if-range'], 'test-only-etag');
  for (const observation of observations) {
    assert.equal(observation.id, 'old');
    for (const key of ['cookie', 'authorization', 'proxy-authorization', 'upgrade']) assert.equal(observation.headers[key], undefined);
  }
  assert.equal((await request(canonical + 'assets/not-listed.png')).status, 404, 'unknown art never blindly falls back');
  const font = await request(canonical + 'fonts/fonts.css', { headers: { origin: 'https://unrelated.example.test' } });
  assert.equal(font.headers.location, 'https://ark-asset.hanabi-ai.cn:25442/releases/material-old/fonts/fonts.css');
  assert.equal(font.headers['access-control-allow-origin'], '*');
  assert.equal(font.headers['access-control-allow-credentials'], undefined);
  const oldArt = await request('/assets/a.png', { headers: { origin: 'https://unrelated.example.test' } });
  assert.equal(oldArt.status, 302); assert.equal(oldArt.headers['access-control-allow-origin'], '*');
  assert.equal((await request('/vendor/preact.module.js')).headers.location,
    'https://ark-asset.hanabi-ai.cn:25442/releases/v012-workers-20261004/vendor/preact.module.js');
  assert.match((await request('/_gate/assets/three.module.js')).headers.location, /\/releases\/prts-libs-20261004\/three\.module\.js$/);
  await command('material-error');
  assert.equal((await request(canonical + 'assets/a.png')).headers.location,
    'https://ark-asset.hanabi-ai.cn:25442/releases/material-old/assets/a.png', 'only real resolver failure uses pinned same-version fallback');
  const privateStat = await fs.stat(ready.privateDir); assert.equal(privateStat.mode & 0o777, 0o700);
  for (const filename of ['old.sock', 'new.sock', 'gateway.sock', 'state.json']) {
    const stat = await fs.stat(path.join(ready.privateDir, filename)); assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.uid, 1000);
  }
  // Fail closed even when a correct session cookie exists but auth backend is gone.
  await command('auth-down');
  assert.equal((await request('/_release/old/client-build', { headers })).status, 500);
  await assert.rejects(ws('old'), /500/);
  t.diagnostic('nginx -t and real TLS HTTP/WS/gate/OpenI redirect matrix passed; owned fixture cleanup registered');
});
