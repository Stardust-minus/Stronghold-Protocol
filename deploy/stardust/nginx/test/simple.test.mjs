// Real isolated TLS Nginx -> real Node24 game/auth/OpenI resolver. No production actions or external fetches.
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
const configDir = fileURLToPath(new URL('../', import.meta.url));
const ORIGIN = 'https://ark-proto.stardust.matce.cn';
const HOST = new URL(ORIGIN).hostname;
const PREFIX = '/_release/v012-alliance-20261004';
const STATIC = 'https://ark-asset.hanabi-ai.cn:25442/releases/v012-alliance-20261004';
const image = process.env.SIMPLE_NODE24_IMAGE || 'ark-proto:v012-alliance-20261004';
const binary = process.env.NGINX_BIN;
const enabled = process.env.SIMPLE_NGINX_SMOKE === '1' && !!binary;
const lua = process.env.NGINX_HAS_LUA === '1';
const presenceBlock = /    location = \/_server\/presence \{\n        content_by_lua_block \{[\s\S]*?\n        \}\n    \}/;
async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function waitFor(check, label, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(25); }
  throw new Error('Deadline exceeded: ' + label);
}
async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGQUIT');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2500); await ended; clearTimeout(timer);
}

test('simple configuration has only three direct targets and exact legacy compatibility', async () => {
  const text = await fs.readFile(path.join(configDir, 'ark-proto.conf'), 'utf8');
  assert.deepEqual([...text.matchAll(/server 127\.0\.0\.1:(\d+);/g)].map(match => Number(match[1])).sort(), [3120, 3130, 3141]);
  assert.match(text, /upstream ark_proto_game_backend/);
  assert.doesNotMatch(text, /gateway|rolling|3110|3111|3190|\[A-Za-z0-9\]/i);
  assert.doesNotMatch(text, /proxy_hide_header Location|add_header Location/);
  assert.match(text, /location = \/vendor\/hooks\.module\.js \{[\s\S]*?proxy_pass http:\/\/ark_proto_game_backend;/);
  assert.match(text, /location \/_release\/ \{ return 404; \}/);
  assert.match(text, presenceBlock);
  const entry = await fs.readFile(path.join(configDir, 'entry-location.conf'), 'utf8');
  assert.match(entry, /proxy_pass http:\/\/ark_proto_game_backend/);
  assert.doesNotMatch(entry, /auth_request off/);
});

test('REAL simple Nginx TLS/gate/root+legacy WS/OpenI/CORS/redirect smoke', { skip: !enabled, timeout: 90000 }, async t => {
  execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore', timeout: 10000 });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ark-simple-nginx-'));
  await fs.chmod(dir, 0o755); await fs.chown(dir, 1000, 1000);
  const name = 'ark-simple-test-' + process.pid + '-' + Date.now();
  const clients = new Set(); let nginx, fixture, log = '', nginxLog = '', dockerStarted = false;
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
    if (process.env.SIMPLE_NGINX_KEEP !== '1') await fs.rm(dir, { recursive: true, force: true });
  });
  fixture = spawn('docker', ['run', '--rm', '--pull=never', '--name', name, '--network', 'host',
    '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '128', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
    '-v', repo + ':/app:ro', '-v', `${dir}:${dir}:rw`, '-e', 'FIXTURE_DIR=' + dir,
    '-e', 'SP_COMBAT=server', '-e', 'SP_VERIFY=off', '--entrypoint', 'node', image,
    '/app/deploy/stardust/nginx/fixtures/simple-runtime.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
  dockerStarted = true;
  fixture.stdout.on('data', data => { log += data; }); fixture.stderr.on('data', data => { log += data; });
  const ready = await waitFor(async () => {
    if (fixture.exitCode !== null) throw new Error('Node24 fixture failed: ' + log);
    try { return JSON.parse(await fs.readFile(path.join(dir, 'ready.json'))); } catch { return null; }
  }, 'Node24 fixture');
  assert.match(ready.runtime, /^v24\./); t.diagnostic('game/auth/resolver runtime ' + ready.runtime + '; orchestration ' + process.version);
  let seq = 0;
  async function command(op) {
    const commandSeq = ++seq;
    await fs.writeFile(path.join(dir, 'command.tmp'), JSON.stringify({ seq: commandSeq, op }));
    await fs.rename(path.join(dir, 'command.tmp'), path.join(dir, 'command.json'));
    const reply = await waitFor(async () => {
      try { const value = JSON.parse(await fs.readFile(path.join(dir, 'reply.json'))); return value.seq === commandSeq ? value : null; } catch { return null; }
    }, 'fixture IPC', 10000);
    if (reply.error) throw new Error(reply.error); return reply.result;
  }
  const tlsPort = await freePort(), httpPort = await freePort();
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=simple-local.test', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore', timeout: 10000 });
  let text = await fs.readFile(path.join(configDir, 'ark-proto.conf'), 'utf8');
  text = text.replace('127.0.0.1:3141', '127.0.0.1:' + ready.auth)
    .replace('127.0.0.1:3120', '127.0.0.1:' + ready.game).replace('127.0.0.1:3130', '127.0.0.1:' + ready.assets)
    .replace('listen 80;', `listen 127.0.0.1:${httpPort};`).replace('listen [::]:80;', '')
    .replace('listen 443 ssl;', `listen 127.0.0.1:${tlsPort} ssl;`).replace('listen [::]:443 ssl;', '')
    .replace('/www/sites/ark-proto.stardust.matce.cn/ssl/fullchain.pem', path.join(dir, 'cert.pem'))
    .replace('/www/sites/ark-proto.stardust.matce.cn/ssl/key.pem', path.join(dir, 'key.pem'))
    .replace('access_log /www/sites/ark-proto.stardust.matce.cn/log/access.log main;', 'access_log off;')
    .replace('error_log /www/sites/ark-proto.stardust.matce.cn/log/error.log;', 'error_log stderr warn;')
    .replaceAll('/www/sites/ark-proto.stardust.matce.cn/entry-location.conf', path.join(configDir, 'entry-location.conf'))
    .replaceAll('/www/sites/ark-proto.stardust.matce.cn/asset-resolver-location.conf', path.join(configDir, 'asset-resolver-location.conf'));
  if (!lua) {
    assert.match(text, presenceBlock);
    // Use a normal content-phase proxy, not rewrite-phase return (which would skip auth_request).
    text = text.replace(presenceBlock, '    location = /_server/presence { proxy_pass http://ark_proto_game_backend/client-build; }');
    t.diagnostic('Stock Nginx has no Lua: only presence BODY uses a test-only build-marker proxy; inherited gate/internal health still tested. Actual OpenResty aggregation subtest is skipped.');
  }
  const config = `worker_processes 1;\nworker_shutdown_timeout 1s;\npid ${dir}/nginx.pid;\nerror_log stderr warn;\nevents { worker_connections 256; }\nhttp {\naccess_log off;\nclient_body_temp_path ${dir}/body;\nproxy_temp_path ${dir}/proxy;\nfastcgi_temp_path ${dir}/fastcgi;\nuwsgi_temp_path ${dir}/uwsgi;\nscgi_temp_path ${dir}/scgi;\n${text}\n}\n`;
  const configPath = path.join(dir, 'nginx.conf'); await fs.writeFile(configPath, config);
  execFileSync(binary, ['-p', dir, '-c', configPath, '-t'], { timeout: 10000 });
  nginx = spawn(binary, ['-p', dir, '-c', configPath, '-g', 'daemon off;'], { stdio: ['ignore', 'ignore', 'pipe'] });
  nginx.stderr.on('data', data => { nginxLog += data; });
  function request(uri, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: tlsPort, path: uri, method, rejectUnauthorized: false,
        servername: HOST, agent: false, headers: { host: HOST, ...headers } }, res => {
        const chunks = []; res.on('data', data => chunks.push(data)); res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject); req.setTimeout(6000, () => req.destroy(new Error('isolated TLS timeout'))); req.end(body);
    });
  }
  await waitFor(async () => {
    if (nginx.exitCode !== null) throw new Error('Nginx failed: ' + nginxLog);
    try { return (await request('/healthz')).status === 404; } catch { return false; }
  }, 'TLS listener', 10000);
  for (const uri of ['/?_prts=1', '/index.html?_prts=1', '/js/main.js', '/data/config.json', '/shared/constants.js', '/sim/constants.js',
    '/client-build', '/_server/presence', PREFIX + '/public/js/main.js', PREFIX + '/shared/constants.js']) {
    assert.equal((await request(uri)).status, 401, 'anonymous private route ' + uri);
  }
  const login = await request('/login?next=' + encodeURIComponent('/?room=ABCD'));
  assert.equal(login.status, 200); assert.match(login.headers['content-security-policy'], /frame-ancestors 'none'/);
  const csrfCookie = login.headers['set-cookie'][0].split(';')[0];
  const csrf = login.body.match(/name="csrf" value="([^"]+)"/)[1];
  const form = new URLSearchParams({ password: 'local-only-simple-password', csrf, next: '/?room=ABCD', callsign: '阿米娅' }).toString();
  const auth = await request('/_gate/login', { method: 'POST', headers: { origin: ORIGIN, cookie: csrfCookie,
    accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  assert.equal(auth.status, 200); assert.equal(JSON.parse(auth.body).next, '/?room=ABCD');
  const cookie = auth.headers['set-cookie'].find(value => value.startsWith('__Host-ark_gate=')).split(';')[0];
  const headers = { cookie }, navigation = { ...headers, accept: 'text/html', 'sec-fetch-mode': 'navigate' };
  for (const uri of ['/', '/index.html']) {
    const entry = await request(uri + '?room=ABCD', { headers: navigation });
    assert.equal(entry.status, 303); assert.equal(new URL(entry.headers.location, ORIGIN).pathname, '/entry');
    assert.equal(new URL(entry.headers.location, ORIGIN).searchParams.get('next'), '/?room=ABCD');
    const page = await request(uri + '?_prts=1', { headers: navigation });
    assert.equal(page.status, 200); assert.equal(page.headers.location, undefined);
    assert.equal(page.body, (await fs.readFile(path.join(repo, 'public/index.html'), 'utf8')).replace('<head>', '<head><script src="/_gate/assets/entry-nav.js"></script>'));
  }
  for (const uri of [PREFIX + '/', PREFIX + '/public/', PREFIX + '/public/index.html']) {
    const legacy = await request(uri + '?_prts=1&room=ABCD', { headers: navigation });
    assert.equal(legacy.status, 302);
    const root = new URL(legacy.headers.location, ORIGIN);
    assert.equal(root.pathname + root.search, '/?_prts=1&room=ABCD');
    assert.equal((await request(root.pathname + root.search, { headers: navigation })).status, 200, 'already-played marker is not dropped');
  }
  for (const [query, expected] of [
    ['?_prts=1&room=ABCD&token=test-only&next=https%3A%2F%2Fevil.test&redirect=elsewhere', '/?_prts=1&room=ABCD'],
    ['?room=ABCD&token=test-only&next=%2Fjs%2Fmain.js', '/?room=ABCD'],
    ['?_prts=1&room=ABCD%2Fescape&token=test-only', '/?_prts=1'],
    ['?_prts=2&room=invalid%20room&next=%2F', '/'],
  ]) {
    const legacy = await request(PREFIX + '/public/' + query, { headers: navigation });
    assert.equal(legacy.status, 302);
    const target = new URL(legacy.headers.location, ORIGIN);
    assert.equal(target.pathname + target.search, expected, 'legacy query is allowlisted, never reflected');
  }
  for (const uri of ['/healthz', '/control', '/_material', '/_ark_single_status', '/_gate/check', PREFIX + '/healthz', PREFIX + '/public/_material',
    PREFIX + '/server/index.js', PREFIX + '/_bootstrap', '/_release/unknown/public/', '/_release/unknown/public/js/main.js', '/_release/unknown/assets/a.png']) {
    assert.equal((await request(uri, { headers })).status, 404, 'unknown/private endpoint ' + uri);
  }
  assert.equal((await request('/client-build', { headers: { cookie: '__Host-ark_gate=forged' } })).status, 401);
  for (const uri of ['/client-build', '/js/main.js', '/_server/presence']) {
    assert.equal((await request(uri, { headers: { ...headers, origin: 'https://evil.test', 'x-forwarded-origin': ORIGIN } })).status, 403);
  }
  const marker = await request('/client-build', { headers });
  assert.deepEqual(Object.keys(JSON.parse(marker.body)), ['build']);
  for (const [legacy, root] of [['/public/js/main.js', '/js/main.js'], ['/shared/constants.js', '/shared/constants.js'],
    ['/data/config.json', '/data/config.json'], ['/server/sim/constants.js', '/sim/constants.js'], ['/server/data.js', '/data.js'], ['/client-build', '/client-build']]) {
    assert.equal((await request(PREFIX + legacy, { headers })).body, (await request(root, { headers })).body, legacy);
  }
  async function ws(uri = '/ws', options = {}) {
    const client = await TestClient.connect(`wss://127.0.0.1:${tlsPort}${uri}`, { wsOptions: {
      rejectUnauthorized: false, origin: ORIGIN, headers: { host: HOST, cookie }, ...options } });
    clients.add(client); return client;
  }
  await assert.rejects(ws('/ws', { headers: { host: HOST } }), /401/);
  await assert.rejects(ws('/ws', { origin: 'https://evil.test' }), /403/);
  await assert.rejects(ws('/ws', { origin: undefined }), /403/);
  await assert.rejects(ws('/_release/unknown/ws'), /404/);
  const spoofed = { headers: { host: HOST, cookie, 'cf-connecting-ip': '203.0.113.7', 'x-real-ip': '203.0.113.8',
    'x-forwarded-for': '203.0.113.9', forwarded: 'for=203.0.113.10' } };
  const client = await ws('/ws', spoofed); const welcome = await client.hello('Doctor');
  assert.deepEqual(await command('addresses'), [{ addr: '127.0.0.1', limitKey: null }], 'root WS overwrites forged forwarding headers');
  assert.equal((await client.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' })).t, 'ok');
  const room = await client.waitFor('room.state');
  const started = await client.request({ t: 'room.start' });
  assert.equal(started.t, 'ok', JSON.stringify(started)); await client.waitFor('m.public');
  await client.terminate();
  const back = await ws(PREFIX + '/ws', spoofed); const restored = await back.hello('Doctor', welcome.token);
  assert.deepEqual(await command('addresses'), [{ addr: '127.0.0.1', limitKey: null }], 'legacy WS has the same trusted-header boundary');
  assert.equal(restored.resumed, true); assert.equal(restored.playerId, welcome.playerId); assert.equal(restored.token, welcome.token);
  assert.equal((await back.waitFor('room.state')).code, room.code); assert.equal((await back.request({ t: 'ping', c: 1 })).t, 'pong');
  await t.test('OpenResty single-server presence body exposes only aggregate fields', { skip: !lua }, async () => {
    const presence = await request('/_server/presence', { headers });
    const value = JSON.parse(presence.body); assert.equal(value.online, 1); assert.equal(value.available, true);
    assert.equal(value.scope, 'single-server'); assert.deepEqual(Object.keys(value).sort(), ['available', 'online', 'scope', 'serverNow']);
  });
  for (const route of ['/assets/a.png', '/media/audio', PREFIX + '/public/assets/a.png', PREFIX + '/public/media/audio']) {
    for (const [mode, origin, expected] of [['no-cors', undefined, 'display'], ['cors', 'https://unrelated.test', 'cors']]) {
      const asset = await request(route, { headers: { cookie, authorization: 'Bearer test-only', 'proxy-authorization': 'Basic test-only',
        'sec-fetch-mode': mode, range: 'bytes=0-9', 'if-range': 'test-only-etag', ...(origin ? { origin } : {}) } });
      assert.equal(asset.status, 302); assert.equal(asset.headers['access-control-allow-origin'], '*');
      assert.equal(asset.headers['access-control-allow-credentials'], undefined);
      const location = new URL(asset.headers.location); assert.equal(location.origin, 'https://obs.cn-south-222.ai.pcl.cn');
      assert.equal(location.searchParams.get('sp_request'), expected);
      assert.equal(location.pathname, '/test-bucket/test-dataset/releases/test-mirror' + (route.includes('assets') ? '/assets/a.png' : '/media/audio'));
    }
  }
  const preflight = await request('/assets/a.png', { method: 'OPTIONS', headers: { origin: 'https://unrelated.test',
    'access-control-request-method': 'GET', 'access-control-request-headers': 'Range,If-Range' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers['access-control-allow-origin'], '*');
  assert.match(preflight.headers['access-control-allow-headers'], /Range/);
  for (const route of ['/assets/not-listed.png', PREFIX + '/public/assets/not-listed.png']) assert.equal((await request(route)).status, 404);
  for (const route of ['/fonts/fonts.css', '/vendor/preact.module.js']) {
    const response = await request(route, { headers: { origin: 'https://unrelated.test' } });
    assert.equal(response.status, 302); assert.equal(response.headers.location, STATIC + route); assert.equal(response.headers['access-control-allow-origin'], '*');
  }
  const hooks = await request('/vendor/hooks.module.js');
  assert.equal(hooks.status, 200); assert.match(hooks.body, /from["']\.\/preact\.module\.js["']/); assert.equal(hooks.headers.location, undefined);
  assert.match((await request('/_gate/assets/three.module.js')).headers.location, /\/releases\/prts-libs-20261004\/three\.module\.js$/);
  const observations = await command('observed');
  assert.ok(observations.some(row => row.headers.origin === 'https://unrelated.test' && row.headers.range === 'bytes=0-9'));
  for (const row of observations) for (const key of ['cookie', 'authorization', 'proxy-authorization', 'upgrade']) assert.equal(row.headers[key], undefined);
  await command('assets-down');
  for (const route of ['/assets/a.png', '/media/audio', PREFIX + '/public/assets/a.png']) {
    const response = await request(route); assert.equal(response.status, 302);
    assert.equal(response.headers.location, STATIC + (route.startsWith(PREFIX) ? '/assets/a.png' : route));
  }
  await command('auth-down');
  assert.equal((await request('/client-build', { headers })).status, 500); await assert.rejects(ws(), /500/);
  t.diagnostic('nginx -t + real TLS gate/redirect/root+exact-prefix WS/OpenI/CORS smoke passed; fixture cleanup registered');
});
