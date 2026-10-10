// Real isolated stock Nginx TLS/access phases. No live vhost, production secrets, SSH, DNS or pulls.
// Follows simple.test.mjs: Node26 orchestrates; existing image supplies only Node24/ws runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { localcodeInclude } from '../../tools/prepare-localcode-release.mjs';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const configDir = fileURLToPath(new URL('../', import.meta.url));
const ORIGIN = 'https://ark-proto-beta.stardust.matce.cn';
const HOST = new URL(ORIGIN).hostname;
const ALPHA = 'https://ark-proto.stardust.matce.cn';
const RELEASE = 'v013-ui'; // Fixture value, NOT the source/image/release being certified.
const IMAGE = process.env.BETA_NODE24_IMAGE || 'ark-proto:v013-ui-20261005';
const BIN = process.env.NGINX_BIN || '/usr/sbin/nginx';
const DOCKER = '/usr/bin/docker';
const PURPOSE = 'ark-beta-nginx-localtest';
const enabled = process.env.BETA_NGINX_SMOKE === '1';
const presenceBlock = /    location = \/_server\/presence \{\n        content_by_lua_block \{[\s\S]*?\n        \}\n    \}/;
const DummyBody = 'export const DummyBody = "edge-beta-local-test-only";\n';
const FallbackBody = 'export const DummyBody = "node-beta-foo-test-only";\n';
const fixtureRevision = 'b'.repeat(40); // Pure generator input; never claimed as a verified Git export.

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

// Mandatory even when the machine has no Nginx; executable smoke is separately opt-in.
test('Beta candidate templates and exact private localcode generator remain isolated', async () => {
  const text = await fs.readFile(path.join(configDir, 'ark-proto-beta.conf'), 'utf8');
  assert.deepEqual([...text.matchAll(/server ([\d.]+):(\d+);/g)].map(m => m[1] + ':' + m[2]),
    ['10.253.77.2:3220', '127.0.0.1:3241', '127.0.0.1:3230']);
  assert.match(text, presenceBlock);
  assert.match(text, /auth_request \/_gate\/check;/);
  assert.match(text, /location @ark_beta_localcode_fallback \{[\s\S]*?auth_request \/_gate\/check;[\s\S]*?proxy_pass http:\/\/ark_beta_game_backend;/);
  assert.doesNotMatch(text, /ark_proto_game_backend|v012-alliance|10\.253\.77\.1:3120/);
  for (const name of ['entry-location.beta.conf', 'asset-resolver-location.beta.conf']) {
    assert.doesNotMatch(await fs.readFile(path.join(configDir, name), 'utf8'), /ark_proto_.*backend/);
  }
  const include = localcodeInclude({ namespace: 'beta', source: { fullref: fixtureRevision },
    files: [{ path: 'js/local.js' }, { path: 'js/foo.js' }] });
  assert.equal([...include.matchAll(/^location = /gm)].length, 2);
  assert.match(include, /error_page 404 = @ark_beta_localcode_fallback;/);
  assert.doesNotMatch(include, /try_files|auth_request off|Access-Control-Allow-Origin/);
});

test('REAL Beta isolated stock Nginx TLS, gate, localcode fallback and WS boundaries',
  { skip: !enabled, timeout: 90000 }, async t => {
  assert.ok(path.isAbsolute(BIN), 'NGINX_BIN must be an absolute existing stock path');
  // Version/metadata only: never load the installed config or talk to its master PID.
  const metadata = spawnSync(BIN, ['-V'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(metadata.status, 0, metadata.stderr);
  const versionInfo = metadata.stdout + metadata.stderr;
  execFileSync(BIN, ['-v'], { stdio: 'inherit', timeout: 10000 });
  assert.match(versionInfo, /http_auth_request_module/);
  const lua = /lua|openresty/i.test(versionInfo);
  const imageInfo = JSON.parse(execFileSync(DOCKER, ['image', 'inspect', IMAGE], { encoding: 'utf8', timeout: 10000 }))[0];
  const imageID = imageInfo.Id;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), PURPOSE + '-'));
  const logPath = dir + '-result.log';
  const run = process.pid + '-' + Date.now();
  const cidfile = path.join(dir, 'container.cid');
  const sockets = new Set();
  let nginx, cid, fixtureLog = '', nginxLog = '', syntaxLog = '', cleanup = '';
  try {
    await fs.chmod(dir, 0o755); await fs.chown(dir, 1000, 1000);
    const localRoot = path.join(dir, 'localcode');
    const nodeRoot = path.join(dir, 'node-app');
    await fs.mkdir(path.join(localRoot, 'js'), { recursive: true });
    await fs.mkdir(path.join(nodeRoot, 'public/js'), { recursive: true });
    await fs.writeFile(path.join(localRoot, 'js/local.js'), DummyBody, { mode: 0o644 });
    await fs.writeFile(path.join(nodeRoot, 'public/js/foo.js'), FallbackBody, { mode: 0o644 });
    const inventory = [{ path: 'js/local.js' }, { path: 'js/foo.js' }];
    let include = localcodeInclude({ namespace: 'beta', source: { fullref: fixtureRevision }, files: inventory });
    const expectedAliases = inventory.map(({ path: file }) => `/www/sites/${HOST}/localcode/${fixtureRevision}/${file}`);
    const actualAliases = [...include.matchAll(/^    alias ([^;]+);$/gm)].map(m => m[1]);
    assert.deepEqual(actualAliases, expectedAliases, 'rewrite only this fixture alias whitelist');
    for (let i = 0; i < expectedAliases.length; i++) include = include.replace(`alias ${expectedAliases[i]};`, `alias ${localRoot}/${inventory[i].path};`);
    const includePath = path.join(dir, 'localcode-locations.conf'); await fs.writeFile(includePath, include);
    cid = execFileSync(DOCKER, ['run', '-d', '--pull=never', '--name', PURPOSE + '-' + run,
      '--cidfile', cidfile, '--label', 'purpose=' + PURPOSE, '--label', 'beta-localtest-run=' + run,
      '--label', 'beta-localtest-source-image=' + imageID, '--network', 'host', '--user', '1000:1000',
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '-v', repo + ':/candidate:ro', '-v', `${dir}:${dir}:rw`,
      '-e', 'FIXTURE_DIR=' + dir, '--entrypoint', '/usr/local/bin/node', imageID,
      '/candidate/deploy/stardust/nginx/test/beta-runtime.fixture.mjs'], { encoding: 'utf8', timeout: 15000 }).trim();
    const ready = await waitFor(async () => {
      const state = JSON.parse(execFileSync(DOCKER, ['inspect', cid], { encoding: 'utf8', timeout: 5000 }))[0].State;
      if (!state.Running) throw new Error('Node24 fixture failed: ' + execFileSync(DOCKER, ['logs', cid], { encoding: 'utf8' }));
      try { return JSON.parse(await fs.readFile(path.join(dir, 'ready.json'), 'utf8')); } catch { return null; }
    }, 'Node24 bounded HTTP+WS and real Beta auth');
    assert.match(ready.runtime, /^v24\./); assert.equal(ready.nodeRoot, nodeRoot);
    t.diagnostic(`Node24 ${ready.runtime}; parent ${process.version}; runtime-only image ${IMAGE} ${imageID}; candidate auth=/candidate read-only working tree, NOT image-source certification`);
    let seq = 0;
    async function command(op) {
      const current = ++seq;
      await fs.writeFile(path.join(dir, 'command.tmp'), JSON.stringify({ seq: current, op }));
      await fs.rename(path.join(dir, 'command.tmp'), path.join(dir, 'command.json'));
      return waitFor(async () => {
        try { const reply = JSON.parse(await fs.readFile(path.join(dir, 'reply.json'), 'utf8'));
          if (reply.seq !== current) return null; if (reply.error) throw new Error(reply.error); return reply.result;
        } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
      }, 'fixture IPC');
    }
    const tlsPort = await freePort(), httpPort = await freePort();
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=beta-local.test', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore', timeout: 10000 });
    let text = await fs.readFile(path.join(configDir, 'ark-proto-beta.conf'), 'utf8');
    text = text.replace('10.253.77.2:3220', '127.0.0.1:' + ready.game)
      .replace('127.0.0.1:3241', '127.0.0.1:' + ready.auth).replace('127.0.0.1:3230', '127.0.0.1:' + ready.assets)
      .replace('listen 80;', `listen 127.0.0.1:${httpPort};`).replace('listen [::]:80;', '')
      .replace('listen 443 ssl;', `listen 127.0.0.1:${tlsPort} ssl;`).replace('listen [::]:443 ssl;', '')
      .replace(`/www/sites/${HOST}/ssl/fullchain.pem`, path.join(dir, 'cert.pem'))
      .replace(`/www/sites/${HOST}/ssl/key.pem`, path.join(dir, 'key.pem'))
      .replace(`/www/sites/${HOST}/log/access.log`, path.join(dir, 'access.log'))
      .replace(`/www/sites/${HOST}/log/error.log`, path.join(dir, 'error.log'))
      .replace(`/www/sites/${HOST}/index`, path.join(dir, 'acme'))
      .replaceAll(`/www/sites/${HOST}/entry-location.conf`, path.join(configDir, 'entry-location.beta.conf'))
      .replaceAll(`/www/sites/${HOST}/asset-resolver-location.conf`, path.join(configDir, 'asset-resolver-location.beta.conf'))
      .replace(`/www/sites/${HOST}/localcode-locations.conf`, includePath).replaceAll('__STATIC_RELEASE__', RELEASE);
    if (!lua) {
      assert.match(text, presenceBlock);
      text = text.replace(presenceBlock, '    location = /_server/presence { proxy_pass http://ark_beta_game_backend/client-build; }');
      t.diagnostic('Stock has no Lua: presence BODY only uses normal content-phase marker proxy; inherited auth_request/internal health unchanged. Actual presence aggregation SKIPPED.');
    }
    assert.doesNotMatch(text, /10\.253\.77\.2|\/www\/sites\/|__STATIC_RELEASE__/);
    const config = `worker_processes 1;\nworker_shutdown_timeout 1s;\npid ${dir}/nginx.pid;\nerror_log stderr warn;\nevents { worker_connections 256; }\nhttp {\nlog_format main '$remote_addr $request_method $uri $status';\naccess_log off;\nclient_body_temp_path ${dir}/body;\nproxy_temp_path ${dir}/proxy;\nfastcgi_temp_path ${dir}/fastcgi;\nuwsgi_temp_path ${dir}/uwsgi;\nscgi_temp_path ${dir}/scgi;\n${text}\n}\n`;
    const configPath = path.join(dir, 'nginx.conf'); await fs.writeFile(configPath, config);
    await t.test('rendered current Beta templates pass real stock nginx -t', () => {
      const syntax = spawnSync(BIN, ['-p', dir, '-c', configPath, '-t'], { encoding: 'utf8', timeout: 10000 });
      syntaxLog = (syntax.stdout || '') + (syntax.stderr || '');
      assert.equal(syntax.status, 0, syntaxLog);
    });
    nginx = spawn(BIN, ['-p', dir, '-c', configPath, '-g', 'daemon off;'], { stdio: ['ignore', 'ignore', 'pipe'] });
    nginx.stderr.on('data', data => { nginxLog += data; });
    function request(uri, { method = 'GET', headers = {}, body } = {}) {
      return new Promise((resolve, reject) => {
        const req = https.request({ host: '127.0.0.1', port: tlsPort, path: uri, method, rejectUnauthorized: false,
          servername: HOST, agent: false, headers: { host: HOST, ...headers } }, res => {
          const chunks = []; res.on('data', bytes => chunks.push(bytes)); res.on('error', reject);
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject); req.setTimeout(6000, () => req.destroy(new Error('isolated TLS timeout'))); req.end(body);
      });
    }
    await waitFor(async () => {
      if (nginx.exitCode !== null) throw new Error('Nginx failed: ' + nginxLog);
      try { return (await request('/login')).status === 200; } catch { return false; }
    }, 'loopback TLS', 10000);
    let cookie;
    await t.test('real createGate beta profile login with full Beta Host and test-only password', async () => {
      const login = await request('/login'); assert.equal(login.status, 200);
      assert.match(login.headers['content-security-policy'], /frame-ancestors 'none'/);
      const csrf = login.body.match(/name="csrf" value="([^"]+)"/)[1];
      const csrfCookie = login.headers['set-cookie'][0].split(';')[0];
      const result = await request('/_gate/login', { method: 'POST', headers: { origin: ORIGIN, cookie: csrfCookie,
        accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, password: 'local-only-beta-test-password', next: '/?room=BETA', callsign: 'Doctor' }).toString() });
      assert.equal(result.status, 200); assert.equal(JSON.parse(result.body).next, '/?room=BETA');
      cookie = result.headers['set-cookie'].find(row => row.startsWith('__Host-ark_gate=')).split(';')[0];
      assert.equal((await request('/login', { headers: { host: new URL(ALPHA).hostname } })).status, 400);
    });
    const privateHeaders = response => {
      assert.equal(response.headers['access-control-allow-origin'], undefined);
      assert.equal(response.headers['access-control-allow-credentials'], undefined);
      assert.match(response.headers['cache-control'], /private, no-store/);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
    };
    let etag;
    await t.test('exact edge body and marker; valid GET/HEAD/304/206 retain private headers', async () => {
      const get = await request('/js/local.js', { headers: { cookie } });
      assert.equal(get.status, 200); assert.equal(get.body, DummyBody); privateHeaders(get);
      assert.equal(get.headers['x-ark-code-source'], 'edge'); etag = get.headers.etag; assert.ok(etag);
      const head = await request('/js/local.js', { method: 'HEAD', headers: { cookie } });
      assert.equal(head.status, 200); assert.equal(head.body, ''); assert.equal(Number(head.headers['content-length']), Buffer.byteLength(DummyBody)); privateHeaders(head);
      const conditional = await request('/js/local.js', { headers: { cookie, 'if-none-match': etag } });
      assert.equal(conditional.status, 304); assert.equal(conditional.body, ''); privateHeaders(conditional);
      const partial = await request('/js/local.js', { headers: { cookie, range: 'bytes=0-9' } });
      assert.equal(partial.status, 206); assert.equal(partial.body, DummyBody.slice(0, 10)); privateHeaders(partial);
      assert.equal(partial.headers['content-range'], `bytes 0-9/${Buffer.byteLength(DummyBody)}`);
    });
    await t.test('anonymous/expired/forged gate rejects edge AND missing-localcode GET/HEAD/conditional/range before content', async () => {
      for (const bad of [undefined, ready.expiredCookie, '__Host-ark_gate=forged-test-only']) {
        for (const uri of ['/js/local.js', '/js/foo.js?fixture=beta']) {
          for (const options of [{}, { method: 'HEAD' }, { headers: { 'if-none-match': etag } }, { headers: { range: 'bytes=0-9' } }]) {
            const response = await request(uri, { ...options, headers: { ...options.headers, ...(bad ? { cookie: bad } : {}) } });
            assert.equal(response.status, 401, uri); assert.notEqual(response.body, DummyBody); assert.notEqual(response.body, FallbackBody); privateHeaders(response);
          }
        }
      }
    });
    await t.test('missing alias actually falls back to SAME Beta upstream actual nodeRoot foo file, gated with query intact', async () => {
      const response = await request('/js/foo.js?fixture=beta', { headers: { cookie } });
      assert.equal(response.status, 200); assert.equal(response.body, await fs.readFile(path.join(nodeRoot, 'public/js/foo.js'), 'utf8'));
      assert.equal(response.body, FallbackBody); assert.equal(response.headers['x-beta-fixture-uri'], '/js/foo.js?fixture=beta');
      assert.equal(response.headers['x-ark-code-source'], undefined); privateHeaders(response);
      const head = await request('/js/foo.js', { method: 'HEAD', headers: { cookie } }); assert.equal(head.status, 200); assert.equal(head.body, '');
      assert.equal((await request('/js/local.js', { method: 'POST', headers: { cookie } })).status, 405);
      assert.equal((await request('/js/foo.js', { method: 'POST', headers: { cookie } })).status, 405);
    });
    await t.test('business JS/data/presence and internal health boundaries; no business CORS', async () => {
      for (const uri of ['/js/business.js', '/data/config.json', '/client-build', '/_server/presence', '/?_prts=1']) {
        assert.equal((await request(uri)).status, 401, uri);
        assert.equal((await request(uri, { headers: { cookie: ready.expiredCookie } })).status, 401, uri);
        const response = await request(uri, { headers: { cookie, origin: ORIGIN } }); assert.equal(response.status, 200, uri); privateHeaders(response);
        for (const origin of [ALPHA, 'https://foreign.test']) assert.equal((await request(uri, { headers: { cookie, origin, 'x-forwarded-origin': ORIGIN } })).status, 403, uri);
      }
      for (const uri of ['/healthz/', '/public/healthz', '/control', '/_material', '/_ark_beta_status', '/_gate/check', '/localcode/js/local.js', '/dev/a', '/_release/unknown/ws']) {
        for (const headers of [{}, { cookie }]) assert.equal((await request(uri, { headers })).status, 404, uri);
      }
      for (const uri of ['/js/local.js', '/js/foo.js']) assert.equal((await request(uri, { headers: { cookie, origin: ALPHA } })).status, 403);
      assert.equal((await request('/?room=BETA', { headers: { cookie, accept: 'text/html', 'sec-fetch-mode': 'navigate' } })).status, 303);
    });
    function ws(headers, origin = ORIGIN) {
      return new Promise((resolve, reject) => {
        const socket = new WebSocket(`wss://127.0.0.1:${tlsPort}/ws`, { rejectUnauthorized: false, servername: HOST,
          headers: { host: HOST, ...headers }, ...(origin == null ? {} : { origin }) });
        sockets.add(socket); const timer = setTimeout(() => { socket.terminate(); reject(new Error('WS deadline')); }, 5000);
        socket.once('message', data => { clearTimeout(timer); resolve({ socket, body: JSON.parse(data.toString()) }); });
        socket.once('error', error => { clearTimeout(timer); reject(error); });
        socket.once('unexpected-response', (_req, response) => { clearTimeout(timer); response.resume(); socket.terminate(); reject(new Error('WS HTTP ' + response.statusCode)); });
      });
    }
    const spoof = { cookie, 'cf-connecting-ip': '203.0.113.7', 'x-real-ip': '203.0.113.8', 'x-forwarded-for': '203.0.113.9',
      forwarded: 'for=203.0.113.10', 'x-forwarded-host': 'foreign.test', 'x-forwarded-proto': 'http' };
    await t.test('real Beta-origin WS succeeds; anonymous/expired/Alpha/foreign/no-Origin refuse', async () => {
      for (const origin of [ALPHA, 'https://foreign.test', null]) await assert.rejects(ws({ cookie }, origin), /403/);
      await assert.rejects(ws({}), /401/); await assert.rejects(ws({ cookie: ready.expiredCookie }), /401/);
      const connected = await ws(spoof); assert.deepEqual(connected.body, { DummyBody: 'beta-ws-test-only' });
      const echoed = new Promise(resolve => connected.socket.once('message', data => resolve(data.toString())));
      connected.socket.send('beta-test-only-ping'); assert.equal(await echoed, 'beta-test-only-ping'); connected.socket.terminate();
    });
    await t.test('exact public health bypasses only its gate, strips credentials and keeps HEAD/no-store', async () => {
      const before = (await command('observed')).filter(row => row.path === '/healthz').length;
      const health = await request('/healthz', { headers: { ...spoof, authorization: 'Bearer test-only', 'proxy-authorization': 'Basic test-only' } });
      assert.equal(health.status, 200); assert.equal(JSON.parse(health.body).ok, true); privateHeaders(health);
      const head = await request('/healthz', { method: 'HEAD' });
      assert.equal(head.status, 200); assert.equal(head.body, ''); privateHeaders(head);
      assert.equal((await command('observed')).filter(row => row.path === '/healthz').length, before + 2, 'only public GET/HEAD added health requests');
    });
    await t.test('HTTP and WS overwrite fake forwarding; only exact public health is externally proxied', async () => {
      assert.equal((await request('/client-build', { headers: spoof })).status, 200);
      const rows = await command('observed');
      for (const kind of ['http', 'ws']) {
        const row = rows.findLast(value => value.kind === kind); assert.ok(row, kind);
        assert.equal(row.headers.host, HOST); assert.equal(row.headers['x-real-ip'], '127.0.0.1');
        assert.equal(row.headers['x-forwarded-for'], '127.0.0.1'); assert.equal(row.headers['x-forwarded-proto'], 'https');
        for (const key of ['cf-connecting-ip', 'forwarded', 'x-forwarded-host']) assert.equal(row.headers[key], undefined);
      }
      const healthRows = rows.filter(row => row.path === '/healthz');
      assert.ok(healthRows.length >= 2, 'public GET/HEAD are observed; internal Lua presence may also read health');
      for (const row of healthRows) {
        assert.equal(row.hasCookie, false);
        for (const key of ['authorization', 'proxy-authorization', 'upgrade']) assert.equal(row.headers[key], undefined);
      }
    });
    await t.test('public assets alone get wildcard CORS; fixture static release fixed and credentials stripped', async () => {
      const response = await request('/assets/DummyBody.png?fixture=1', { headers: { ...spoof, origin: 'https://foreign.test', authorization: 'Bearer test-only', 'proxy-authorization': 'Basic test-only' } });
      assert.equal(response.status, 302); assert.equal(response.headers.location, `https://ark-asset.hanabi-ai.cn:25442/releases/${RELEASE}/assets/DummyBody.png?fixture=1`);
      assert.equal(response.headers['access-control-allow-origin'], '*'); assert.equal(response.headers['access-control-allow-credentials'], undefined);
      const rows = await command('observed'); const asset = rows.findLast(row => row.kind === 'asset'); assert.ok(asset);
      assert.equal(asset.hasCookie, false, 'Cookie stripping is observed before test-only token redaction');
      for (const key of ['authorization', 'proxy-authorization', 'upgrade']) assert.equal(asset.headers[key], undefined);
      assert.equal((await request('/fonts/DummyBody.woff2')).headers.location, `https://ark-asset.hanabi-ai.cn:25442/releases/${RELEASE}/fonts/DummyBody.woff2`);
    });
    await t.test('actual Lua Beta presence aggregation', { skip: !lua }, async () => {
      const result = JSON.parse((await request('/_server/presence', { headers: { cookie } })).body);
      assert.equal(result.scope, 'beta'); assert.equal(result.available, true);
      assert.deepEqual(Object.keys(result).sort(), ['available', 'online', 'scope', 'serverNow']);
    });
    await t.test('auth outage fails closed for edge, missing alias, business and WS', async () => {
      await command('auth-down');
      for (const uri of ['/js/local.js', '/js/foo.js', '/client-build', '/_server/presence']) assert.equal((await request(uri, { headers: { cookie } })).status, 500, uri);
      await assert.rejects(ws({ cookie }), /500/);
    });
  } finally {
    for (const socket of sockets) socket.terminate();
    await stopChild(nginx);
    if (!cid) { try { cid = (await fs.readFile(cidfile, 'utf8')).trim(); } catch {} }
    if (cid) {
      const inspected = JSON.parse(execFileSync(DOCKER, ['inspect', cid], { encoding: 'utf8', timeout: 5000 }))[0];
      const labels = inspected.Config.Labels || {};
      assert.equal(inspected.Id, cid); assert.equal(inspected.Image, imageID);
      assert.equal(labels.purpose, PURPOSE); assert.equal(labels['beta-localtest-run'], run);
      assert.equal(labels['beta-localtest-source-image'], imageID);
      fixtureLog = execFileSync(DOCKER, ['logs', cid], { encoding: 'utf8', timeout: 5000 });
      execFileSync(DOCKER, ['rm', '-f', cid], { stdio: 'ignore', timeout: 15000 });
      cleanup = 'Removed exact CID after purpose/run/source-image checks: ' + cid;
    } else cleanup = 'No fixture container created';
    let errorLog = '', accessLog = '';
    try { errorLog = await fs.readFile(path.join(dir, 'error.log'), 'utf8'); } catch {}
    try { accessLog = await fs.readFile(path.join(dir, 'access.log'), 'utf8'); } catch {}
    await fs.writeFile(logPath, `${versionInfo}\nparent=${process.version}\nimage=${IMAGE} ${imageID}\n${syntaxLog}\n${fixtureLog}\n${nginxLog}\n${errorLog}\n${accessLog}\n${cleanup}\n`, { mode: 0o600 });
    await fs.rm(dir, { recursive: true, force: true });
    t.diagnostic(`${cleanup}; isolated cert/config/DummyBody files removed; log=${logPath}`);
  }
});
