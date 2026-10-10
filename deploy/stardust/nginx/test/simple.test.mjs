// Real isolated TLS Nginx -> real Node24 game/auth/OpenI resolver. No production actions or external fetches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import https from 'node:https';
import http from 'node:http';
import { startCoordinator } from '../../../../server/cluster/coordinator.js';
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

for (const [profile, name, upstream, statusPath] of [
  ['formal', 'ark-proto.conf', 'ark_proto_game_backend', '/_ark_single_status'],
  ['beta', 'ark-proto-beta.conf', 'ark_beta_game_backend', '/_ark_beta_status'],
]) test(profile + ' exact anonymous health uses only the existing HTTP target without changing native diagnosis', async () => {
  const text = await fs.readFile(path.join(configDir, name), 'utf8');
  const start = text.indexOf('    location = /healthz {');
  assert.ok(start >= 0);
  const route = text.slice(start, text.indexOf('\n    }', start) + 6);
  assert.match(route, /auth_request off;/);
  assert.match(route, /\$request_uri !~ "\^\/healthz\(\?:\[\?\]\|\$\)"/);
  assert.match(route, /\$request_method !~ \^\(GET\|HEAD\)\$.*return 405;/);
  assert.match(route, /set \$args "";/);
  assert.match(route, new RegExp(`proxy_pass http://${upstream}/healthz;`));
  assert.match(text.slice(text.indexOf(`    location = ${statusPath} {`)), new RegExp(`proxy_pass http://${upstream}/healthz;`));
  for (const header of ['Cookie', 'Authorization', 'Proxy-Authorization', 'Upgrade', 'Connection', 'Content-Length']) {
    assert.ok(route.includes(`proxy_set_header ${header} "";`), header);
  }
  for (const directive of ['proxy_pass_request_headers off;', 'proxy_pass_request_body off;', 'proxy_connect_timeout 1s;',
    'proxy_send_timeout 3s;', 'proxy_read_timeout 3s;', 'proxy_intercept_errors off;', 'proxy_next_upstream off;']) assert.ok(route.includes(directive), directive);
  assert.doesNotMatch(route, /proxy_method|content_by_lua|return 200|Access-Control-Allow-Origin|proxy_pass.*\$/);
  assert.match(text, /add_header Cache-Control (?:\$ark_proto_cache|"private, no-store") always;/);
  assert.match(text, /add_header Allow \$ark_(?:proto|beta)_health_allow always;/);
  assert.match(text, /~\^\/healthz:\(\?!GET\$\|HEAD\$\) "GET, HEAD";/);
  assert.match(text, /location ~ "\^\/.*healthz\|control\|_material.*return 404;/);
});

test('native coordinator rich health contains diagnosis but no credentials; reads do not request game status or allocate', async t => {
  let calls = 0;
  const coordinator = await startCoordinator({ port: 0, quiet: true, build: 'health-fixture-build', heartbeatMs: 30000,
    nodes: [{ nodeId: 'private-health-fixture-node', key: Buffer.alloc(32, 17), client: {
      async call() { calls++; throw new Error('test-only unavailable game'); }, close() {},
    } }] });
  t.after(() => coordinator.close());
  const before = calls;
  for (const method of ['GET', 'HEAD', 'GET']) {
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: coordinator.port, path: '/healthz', method, agent: false }, res => {
        const chunks = []; res.on('data', value => chunks.push(value)); res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('native health timeout'))); req.end();
    });
    assert.equal(result.status, 200, 'coordinator health is not an allocation-ready game promise');
    assert.match(result.headers['cache-control'], /no-store/); assert.equal(result.headers['set-cookie'], undefined);
    if (method === 'HEAD') assert.equal(result.body, '');
    else {
      const value = JSON.parse(result.body);
      for (const key of ['ok', 'version', 'app', 'uptimeSec', 'build', 'sockets', 'sessions', 'rooms', 'matches', 'maxRooms', 'combat', 'trial', 'performance']) {
        assert.ok(Object.hasOwn(value, key), 'native diagnostic field ' + key);
      }
      assert.equal(value.ok, true); assert.equal(value.combat.workers, 0); assert.equal(value.trial.workers, 0);
      assert.doesNotMatch(result.body, /private-health-fixture-node|signingKey|keyFingerprint|authorization|cookie|password|verifier|ticket|sessionId|playerId/i);
    }
  }
  assert.equal(calls, before, 'public/native health reads must not fan out to game RPC');
  assert.equal(coordinator.lobby.rooms.size, 0); assert.equal(coordinator.lobby.assignments.size, 0);
});

const healthEnabled = process.env.HEALTH_NGINX_SMOKE === '1' && !!binary;
for (const profile of ['formal', 'beta']) test('REAL ' + profile + ' template TLS anonymous raw health and failure/auth isolation',
  { skip: !healthEnabled, timeout: 35000 }, async t => {
  const scratch = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : path.join(repo, '.cache/stardust');
  const dir = await fs.mkdtemp(path.join(scratch, 'health-nginx-' + profile + '-'));
  await fs.mkdir(path.join(dir, 'logs'));
  const beta = profile === 'beta', host = beta ? 'ark-proto-beta.stardust.matce.cn' : HOST;
  const origin = 'https://' + host, namespace = beta ? 'ark_beta' : 'ark_proto';
  const fixtures = [], observations = []; let nginx, nginxLog = '', syntaxLog = '', passed = false, authChecks = 0;
  let authUp = true, mode = 'reply', replyStatus = 200;
  // Bounded synthetic upstream preserves deliberately non-canonical JSON bytes, not an image/game certification.
  let replyBody = '{\n "ok":true,"version":1,"app":"health-test","build":"fixture-build", "uptimeSec":7,\n "sockets":2,"sessions":3,"rooms":4,"matches":5,"maxRooms":0,\n "combat":{"workers":0},"trial":{"workers":0},"performance":{"status":"warming"},"futureField":[false,null,"诊断"]\n}\n';
  t.after(async () => {
    await stopChild(nginx);
    for (const server of fixtures) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await fs.writeFile(path.join(dir, 'health-result.json'), JSON.stringify({ ok: passed, profile, localOnly: true,
      runtime: process.version, syntheticUpstream: true, productionAccessed: false, syntaxLog, nginxLog }, null, 2) + '\n');
    t.diagnostic('Local TLS health evidence retained at ' + dir);
  });
  async function listen(handler) {
    const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    fixtures.push(server); return server;
  }
  const auth = await listen((req, res) => {
    if (req.url === '/check') {
      authChecks++; res.writeHead(authUp ? (req.headers.cookie === 'health-local-test=1' ? 204 : 401) : 503); res.end();
    } else { res.writeHead(200); res.end('local auth fixture'); }
  });
  const backend = await listen((req, res) => {
    const chunks = []; req.on('data', data => chunks.push(data));
    req.on('end', () => {
      observations.push({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url.split('?')[0] !== '/healthz') {
        res.writeHead(req.url.startsWith('/_cluster/') ? 404 : 200, { 'Content-Type': 'application/json' }); res.end('{"privateFixture":true}'); return;
      }
      if (mode === 'hang') return;
      if (mode === 'disconnect') { req.socket.destroy(); return; }
      res.writeHead(replyStatus, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(replyBody),
        'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
      res.end(req.method === 'HEAD' ? undefined : replyBody);
    });
  });
  const assets = await listen((_req, res) => { res.writeHead(503); res.end(); });
  const tlsPort = await freePort(), httpPort = await freePort();
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=health-local.test',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore', timeout: 10000 });
  await fs.writeFile(path.join(dir, 'localcode-locations.conf'), '');
  let text = await fs.readFile(path.join(configDir, beta ? 'ark-proto-beta.conf' : 'ark-proto.conf'), 'utf8');
  text = text.replace(beta ? '10.253.77.2:3220' : '127.0.0.1:3120', '127.0.0.1:' + backend.address().port)
    .replace(beta ? '127.0.0.1:3241' : '127.0.0.1:3141', '127.0.0.1:' + auth.address().port)
    .replace(beta ? '127.0.0.1:3230' : '127.0.0.1:3130', '127.0.0.1:' + assets.address().port)
    .replace('listen 80;', `listen 127.0.0.1:${httpPort};`).replace('listen [::]:80;', '')
    .replace('listen 443 ssl;', `listen 127.0.0.1:${tlsPort} ssl;`).replace('listen [::]:443 ssl;', '')
    .replace(`/www/sites/${host}/ssl/fullchain.pem`, path.join(dir, 'cert.pem'))
    .replace(`/www/sites/${host}/ssl/key.pem`, path.join(dir, 'key.pem'))
    .replace(`access_log /www/sites/${host}/log/access.log main;`, 'access_log off;')
    .replace(`error_log /www/sites/${host}/log/error.log;`, 'error_log stderr warn;')
    .replace(`/www/sites/${host}/index`, path.join(dir, 'acme'))
    .replaceAll(`/www/sites/${host}/entry-location.conf`, path.join(configDir, beta ? 'entry-location.beta.conf' : 'entry-location.conf'))
    .replaceAll(`/www/sites/${host}/asset-resolver-location.conf`, path.join(configDir, beta ? 'asset-resolver-location.beta.conf' : 'asset-resolver-location.conf'))
    .replace(`/www/sites/${host}/localcode-locations.conf`, path.join(dir, 'localcode-locations.conf'))
    .replaceAll('__STATIC_RELEASE__', 'health-fixture');
  if (!lua) {
    assert.match(text, presenceBlock);
    text = text.replace(presenceBlock, `    location = /_server/presence { proxy_pass http://${namespace}_game_backend/client-build; }`);
    t.diagnostic('Stock Nginx: only presence body is a fixture proxy; its gate remains tested, Lua body not exercised.');
  }
  const luaLib = process.env.HEALTH_NGINX_LUALIB;
  const luaPaths = luaLib ? `lua_package_path "${luaLib}/?.lua;${luaLib}/?/init.lua;;"; lua_package_cpath "${luaLib}/?.so;;";` : '';
  const conf = path.join(dir, 'nginx.conf');
  await fs.writeFile(conf, `user root;\nworker_processes 1;\nworker_shutdown_timeout 1s;\npid ${dir}/nginx.pid;\nerror_log stderr warn;\nevents { worker_connections 128; }\nhttp {\n${luaPaths}\naccess_log off;\nclient_body_temp_path ${dir}/body;\nproxy_temp_path ${dir}/proxy;\nfastcgi_temp_path ${dir}/fastcgi;\nuwsgi_temp_path ${dir}/uwsgi;\nscgi_temp_path ${dir}/scgi;\n${text}\n}\n`);
  const loader = process.env.HEALTH_NGINX_LOADER, command = loader || binary;
  const args = loader ? ['--library-path', process.env.HEALTH_NGINX_LIBRARIES, binary] : [];
  syntaxLog = execFileSync(command, [...args, '-p', dir, '-c', conf, '-t'], { encoding: 'utf8', timeout: 10000 });
  nginx = spawn(command, [...args, '-p', dir, '-c', conf, '-g', 'daemon off;'], { stdio: ['ignore', 'ignore', 'pipe'] });
  nginx.stderr.on('data', data => { nginxLog += data; });
  function request(uri, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: tlsPort, path: uri, method, rejectUnauthorized: false,
        servername: host, agent: false, headers: { host, ...headers } }, res => {
        const chunks = []; res.on('data', data => chunks.push(data)); res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject); req.setTimeout(6000, () => req.destroy(new Error('local health TLS timeout'))); req.end(body);
    });
  }
  await waitFor(async () => {
    if (nginx.exitCode !== null) throw new Error('Local Nginx exited: ' + nginxLog);
    try { return (await request('/login')).status === 200; } catch { return false; }
  }, 'local health TLS listener', 10000);
  function healthHeaders(result) {
    assert.equal(result.headers['cache-control'], 'private, no-store'); assert.equal(result.headers['x-content-type-options'], 'nosniff');
    for (const key of ['access-control-allow-origin', 'access-control-allow-credentials', 'set-cookie', 'location']) assert.equal(result.headers[key], undefined, key);
  }
  const beforeAuth = authChecks;
  const spoof = { cookie: 'health-local-test=1', authorization: 'Bearer local-test-only', 'proxy-authorization': 'Basic local-test-only',
    'cf-connecting-ip': '203.0.113.7', 'x-real-ip': '203.0.113.8', 'x-forwarded-for': '203.0.113.9', forwarded: 'for=203.0.113.10',
    'x-forwarded-host': 'foreign.test', 'x-forwarded-proto': 'http', upgrade: 'websocket', connection: 'upgrade' };
  for (const headers of [{}, { cookie: 'forged-local-test' }, { ...spoof, origin, 'if-none-match': 'local-test', range: 'bytes=0-9' }]) {
    const get = await request('/healthz?upstream=http%3A%2F%2Fforeign.test%2Fcontrol', { headers });
    assert.equal(get.status, 200); assert.equal(get.body, replyBody); healthHeaders(get);
    assert.equal(get.headers['content-type'], 'application/json');
  }
  const getWithBody = await request('/healthz', { headers: { 'content-length': '15' }, body: 'local-only-body' });
  assert.equal(getWithBody.status, 200); assert.equal(getWithBody.body, replyBody); healthHeaders(getWithBody);
  const head = await request('/healthz', { method: 'HEAD', headers: spoof });
  assert.equal(head.status, 200); assert.equal(head.body, ''); assert.equal(Number(head.headers['content-length']), Buffer.byteLength(replyBody)); healthHeaders(head);
  const observedHealth = observations.filter(row => row.path.split('?')[0] === '/healthz');
  assert.equal(observedHealth.length, 5); assert.equal(observedHealth.at(-1).method, 'HEAD');
  for (const row of observedHealth) {
    assert.equal(row.path.replace(/\?$/, ''), '/healthz', 'query cannot select another upstream/path and is not forwarded');
    assert.equal(row.body, ''); assert.equal(row.headers.host, host); assert.equal(row.headers['x-real-ip'], '127.0.0.1');
    assert.equal(row.headers['x-forwarded-for'], '127.0.0.1'); assert.equal(row.headers['x-forwarded-proto'], 'https');
    for (const key of ['cookie', 'authorization', 'proxy-authorization', 'upgrade', 'cf-connecting-ip', 'forwarded', 'x-forwarded-host', 'range', 'if-none-match', 'content-length']) assert.equal(row.headers[key], undefined, key);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const rejected = await request('/healthz', { method });
    assert.equal(rejected.status, 405); assert.equal(rejected.headers.allow, 'GET, HEAD'); healthHeaders(rejected);
  }
  for (const uri of ['/healthz/', '/healthz/child', '/public/healthz', '/public/healthz/', PREFIX + '/healthz', PREFIX + '/public/healthz',
    '/%68ealthz', '/health%7a', '//healthz', '/./healthz', '/healthz/../healthz', '/_gate/check', beta ? '/_ark_beta_status' : '/_ark_single_status', '/control', '/_material']) {
    for (const headers of [{}, { cookie: 'health-local-test=1' }]) assert.equal((await request(uri, { headers })).status, 404, uri);
  }
  assert.equal(observations.filter(row => row.path.split('?')[0] === '/healthz').length, 5, 'methods and aliases do not invoke health');
  assert.equal((await request('/healthz', { headers: { origin: 'https://foreign.test' } })).status, 403, 'existing foreign-Origin guard is not relaxed');
  assert.equal(authChecks, beforeAuth, 'all public health outcomes bypass only the health gate');
  for (const uri of ['/js/main.js', '/data/config.json', '/client-build', '/_server/presence', '/_cluster/rpc', '/_cluster/rpc/prepare']) {
    assert.equal((await request(uri)).status, 401, 'anonymous private ' + uri);
    assert.equal((await request(uri, { headers: { cookie: 'forged-local-test' } })).status, 401, 'forged private ' + uri);
  }
  assert.equal((await request('/ws', { headers: { origin } })).status, 401);
  assert.equal((await request('/ws', { headers: { origin: 'https://foreign.test', cookie: 'health-local-test=1' } })).status, 403);
  assert.equal((await request('/?_prts=1', { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } })).status, 303, 'normal private navigation still redirects to login');
  const privateResponse = await request('/client-build', { headers: { cookie: 'health-local-test=1' } });
  assert.equal(privateResponse.status, 200); assert.equal(privateResponse.headers.allow, undefined, 'health method header does not leak to other routes');
  assert.equal((await request('/_cluster/rpc', { headers: { cookie: 'health-local-test=1' } })).status, 404);
  if (lua) {
    const presence = await request('/_server/presence', { headers: { cookie: 'health-local-test=1' } });
    assert.equal(presence.status, 200); healthHeaders(presence);
    const value = JSON.parse(presence.body);
    assert.equal(value.available, true); assert.equal(value.online, 0); assert.equal(value.scope, beta ? 'beta' : 'single-server');
    assert.deepEqual(Object.keys(value).sort(), ['available', 'online', 'scope', 'serverNow'], 'presence still projects only its original aggregate');
  }
  for (const status of [201, 401, 403, 418, 500, 503]) {
    replyStatus = status; replyBody = status === 500 ? '{deliberately malformed diagnostic body' : ` { "ok": false, "diagnosis": ${status}, "extra": [1,2] }\n`;
    const result = await request('/healthz', { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } });
    assert.equal(result.status, status); assert.equal(result.body, replyBody); healthHeaders(result);
    const resultHead = await request('/healthz', { method: 'HEAD' });
    assert.equal(resultHead.status, status); assert.equal(resultHead.body, ''); healthHeaders(resultHead);
  }
  replyStatus = 200; replyBody = '{"ok":true,"diagnosis":"auth-independent"}\n'; authUp = false;
  assert.equal((await request('/client-build', { headers: { cookie: 'health-local-test=1' } })).status, 500, 'auth outage still fails private access closed');
  const checksAfterPrivate = authChecks;
  const healthDuringAuthOutage = await request('/healthz');
  assert.equal(healthDuringAuthOutage.status, 200); assert.equal(healthDuringAuthOutage.body, replyBody); healthHeaders(healthDuringAuthOutage);
  assert.equal(authChecks, checksAfterPrivate);
  mode = 'disconnect'; const disconnected = await request('/healthz'); assert.equal(disconnected.status, 502); healthHeaders(disconnected);
  mode = 'hang'; const began = Date.now(), timedOut = await request('/healthz');
  assert.equal(timedOut.status, 504); assert.ok(Date.now() - began < 5500, 'bounded backend read timeout'); healthHeaders(timedOut);
  backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve));
  const unreachable = await request('/healthz'); assert.equal(unreachable.status, 502); healthHeaders(unreachable);
  const unreachableHead = await request('/healthz', { method: 'HEAD' }); assert.equal(unreachableHead.status, 502); assert.equal(unreachableHead.body, ''); healthHeaders(unreachableHead);
  passed = true;
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
    try { return (await request('/login')).status === 200; } catch { return false; }
  }, 'TLS listener', 10000);
  for (const uri of ['/?_prts=1', '/index.html?_prts=1', '/js/main.js', '/data/config.json', '/data/announcements.json', '/shared/constants.js', '/sim/constants.js',
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
  const health = await request('/healthz');
  assert.equal(health.status, 200); assert.equal(JSON.parse(health.body).ok, true);
  assert.ok(JSON.parse(health.body).performance, 'rich health diagnostics are not cropped');
  assert.match(health.headers['cache-control'], /no-store/); assert.equal(health.headers['access-control-allow-origin'], undefined);
  const healthHead = await request('/healthz', { method: 'HEAD' });
  assert.equal(healthHead.status, 200); assert.equal(healthHead.body, '');
  for (const uri of ['/healthz/', '/public/healthz', '/control', '/_material', '/_ark_single_status', '/_gate/check', PREFIX + '/healthz', PREFIX + '/public/_material',
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
