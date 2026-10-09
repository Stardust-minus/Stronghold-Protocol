// WS-only copy preparation and opt-in real local OpenResty routing. Echo relays are not game/Worker fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { prepareDualIngressProxy } from '../../tools/prepare-dual-ingress-proxy.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
const sources = { formal: readFileSync(path.join(directory, 'ark-proto.conf'), 'utf8'), beta: readFileSync(path.join(directory, 'ark-proto-beta.conf'), 'utf8') };
for (const [profile, source] of Object.entries(sources)) test(profile + ' preparation changes only reviewed WS upstreams, preserving HTTP/auth/private/material directives byte-for-byte', () => {
  const r = prepareDualIngressProxy(source, { profile });
  assert.equal(r.manifest.activated, false); assert.equal(r.manifest.ingressInstances, 2);
  assert.equal(r.manifest.existingSocketsMigrated, false); assert.equal(r.manifest.deploymentPortsMatchProfile, true);
  assert.deepEqual(r.manifest.endpoints, profile === 'formal' ? ['127.0.0.1:35401', '127.0.0.1:35402'] : ['127.0.0.1:35301', '127.0.0.1:35302']);
  assert.match(r.vhost, /least_conn;/); assert.doesNotMatch(r.vhost.slice(0, r.vhost.indexOf('\n\n')), /keepalive|ip_hash|hash \$/);
  let restored = r.vhost.slice(r.vhost.indexOf('\n\n') + 2);
  const previous = r.manifest.webSocketLocations[0].previousUpstream;
  assert.ok(r.manifest.webSocketLocations.every(x => x.previousUpstream === previous));
  restored = restored.replaceAll(`proxy_pass http://${r.manifest.upstream};\n        proxy_next_upstream error timeout;\n        proxy_next_upstream_tries 2;`, `proxy_pass http://${previous};`);
  assert.equal(restored, source, 'no unrelated location, gate, Origin, headers, timeout, provider or HTTP backend changed');
  assert.equal(r.manifest.webSocketLocations.length, profile === 'formal' ? 2 : 1);
});

test('quoted/commented braces and non-BMP comments retain source offsets', () => {
  const source = '# 🔒 { location = /ws { proxy_pass http://ignored; } }\n' + sources.formal.replace('proxy_buffering off;', 'set $test_note "brace } # not a directive";\n        proxy_buffering off;');
  const r = prepareDualIngressProxy(source);
  assert.equal(r.manifest.webSocketLocations.length, 2);
  assert.ok(r.vhost.includes('# 🔒 { location = /ws { proxy_pass http://ignored; } }'));
  assert.ok(r.vhost.includes('set $test_note "brace } # not a directive";'));
});

test('ambiguous, ungated, duplicate, unexpected and already-prepared inputs are refused', () => {
  const source = sources.formal;
  for (const input of ['', source.replace('auth_request /_gate/check;', 'auth_request off;'),
    source.replaceAll("if ($http_origin != 'https://ark-proto.stardust.matce.cn') { return 403; }", ''),
    source.replace('proxy_pass http://ark_proto_game_backend;\n        proxy_buffering off;', 'auth_request off;\n        proxy_pass http://ark_proto_game_backend;\n        proxy_buffering off;'),
    source + '\nlocation = /ws { proxy_pass http://wrong; }',
    source.replace('/_release/v012-alliance-20261004/ws {', '/_release/unreviewed/ws {'),
    source.replace('proxy_buffering off;', 'proxy_next_upstream off;\n        proxy_buffering off;'),
    source.replace('proxy_pass http://ark_proto_game_backend;\n        proxy_buffering off;', 'proxy_pass http://127.0.0.1:35401;\n        proxy_buffering off;'),
    prepareDualIngressProxy(source).vhost]) assert.throws(() => prepareDualIngressProxy(input));
  for (const ports of [[1, 2], [35401], [35401, 35401], [35401, '35402'], [35401, 35402, 35403], [35401, 65536]]) assert.throws(() => prepareDualIngressProxy(source, { ports }));
  assert.throws(() => prepareDualIngressProxy(source, { profile: 'unknown' }));
});

const binary = process.env.DUAL_INGRESS_NGINX_BIN;
const enabled = process.env.DUAL_INGRESS_NGINX_SMOKE === '1' && !!binary;
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit'); child.kill('SIGQUIT');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 3000); await exit; clearTimeout(timeout);
}

test('REAL isolated OpenResty keeps HTTP/gate separate, balances new WS and survives one relay loss', { skip: !enabled, timeout: 45000 }, async t => {
  const scratch = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : fileURLToPath(new URL('../../../../.cache/stardust/', import.meta.url));
  const dir = await fs.mkdtemp(path.join(scratch, 'dual-ingress-proxy-'));
  await fs.mkdir(path.join(dir, 'logs'));
  const origin = 'http://dual-ingress.local', clients = [], fixtures = []; let nginx, log = '';
  t.after(async () => {
    for (const ws of clients) ws.terminate();
    await stop(nginx);
    for (const fixture of fixtures) {
      for (const ws of fixture.wss?.clients || []) ws.terminate();
      await new Promise(resolve => fixture.server.close(resolve));
    }
  });
  const main = http.createServer((req, res) => {
    if (req.url === '/check') { res.writeHead(req.headers.cookie === 'local-proof=1' ? 204 : 401); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('UNCHANGED_HTTP_BACKEND:' + req.url);
  });
  main.listen(0, '127.0.0.1'); await once(main, 'listening'); fixtures.push({ server: main });
  for (let i = 0; i < 2; i++) {
    const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
    server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)));
    wss.on('connection', ws => { ws.send(JSON.stringify({ echoRelay: i })); ws.on('message', data => ws.send(data)); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); fixtures.push({ server, wss });
  }
  const port = await freePort(), mainPort = main.address().port;
  const source = `upstream original_http { server 127.0.0.1:${mainPort}; }\nmap $http_upgrade $ws_connection { default upgrade; '' ''; }\nserver {\nlisten 127.0.0.1:${port};\nauth_request /_gate/check;\nadd_header Cache-Control "private, no-store" always;\nproxy_http_version 1.1;\nproxy_set_header Host $host;\nproxy_set_header X-Real-IP $remote_addr;\nproxy_set_header X-Forwarded-For $remote_addr;\nproxy_set_header CF-Connecting-IP "";\nproxy_set_header Forwarded "";\nproxy_set_header Upgrade $http_upgrade;\nproxy_set_header Connection $ws_connection;\nlocation = /_gate/check { internal; auth_request off; proxy_pass http://original_http/check; proxy_pass_request_body off; proxy_set_header Content-Length ""; }\nlocation = /ws {\n  if ($http_origin != '${origin}') { return 403; }\n  proxy_pass http://original_http;\n  proxy_buffering off;\n  proxy_read_timeout 3600s;\n  proxy_send_timeout 3600s;\n}\nlocation / { proxy_pass http://original_http; }\n}\n`;
  const prepared = prepareDualIngressProxy(source, { ports: fixtures.slice(1).map(f => f.server.address().port) });
  const luaLib = process.env.DUAL_INGRESS_NGINX_LUALIB;
  const lua = luaLib ? `lua_package_path "${luaLib}/?.lua;${luaLib}/?/init.lua;;"; lua_package_cpath "${luaLib}/?.so;;";` : '';
  const config = `user root;\nworker_processes 1;\npid ${dir}/nginx.pid;\nerror_log stderr warn;\nevents { worker_connections 128; }\nhttp { ${lua} access_log off; client_body_temp_path ${dir}/body; proxy_temp_path ${dir}/proxy; ${prepared.vhost} }\n`;
  const conf = path.join(dir, 'nginx.conf'); await fs.writeFile(conf, config, { flag: 'wx' });
  const loader = process.env.DUAL_INGRESS_NGINX_LOADER, libs = process.env.DUAL_INGRESS_NGINX_LIBRARIES;
  const command = loader || binary, prefix = loader ? ['--library-path', libs, binary] : [];
  execFileSync(command, [...prefix, '-p', dir, '-c', conf, '-t'], { timeout: 10000 });
  nginx = spawn(command, [...prefix, '-p', dir, '-c', conf, '-g', 'daemon off;'], { stdio: ['ignore', 'ignore', 'pipe'] });
  nginx.stderr.on('data', data => { log += data; });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 6000;
  for (;;) {
    if (nginx.exitCode !== null) throw new Error('Local OpenResty exited: ' + log);
    try { if ((await fetch(url + '/data/config.json')).status === 401) break; } catch {}
    if (Date.now() > deadline) throw new Error('Local OpenResty did not start: ' + log);
    await delay(20);
  }
  for (const uri of ['/', '/js/main.js', '/data/config.json', '/client-build']) {
    const anon = await fetch(url + uri); assert.equal(anon.status, 401); assert.match(anon.headers.get('cache-control'), /no-store/);
    const allowed = await fetch(url + uri, { headers: { cookie: 'local-proof=1' } });
    assert.equal(await allowed.text(), 'UNCHANGED_HTTP_BACKEND:' + uri);
  }
  async function connect(headers = { origin, cookie: 'local-proof=1' }) {
    const ws = new WebSocket(url.replace(/^http/, 'ws') + '/ws', { headers }); clients.push(ws);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { ws.terminate(); reject(new Error('WS handshake timeout')); }, 5000);
      ws.once('message', data => { clearTimeout(timeout); resolve({ ws, relay: JSON.parse(data).echoRelay }); });
      ws.once('unexpected-response', (req, response) => { clearTimeout(timeout); response.resume(); resolve({ refused: response.statusCode }); });
      ws.on('error', error => { clearTimeout(timeout); reject(error); });
    });
  }
  assert.equal((await connect({ origin })).refused, 401);
  assert.equal((await connect({ origin: 'http://wrong.local', cookie: 'local-proof=1' })).refused, 403);
  const active = [];
  for (let i = 0; i < 6; i++) active.push(await connect());
  assert.deepEqual(active.map(x => x.relay).sort(), [0, 0, 0, 1, 1, 1]);
  for (const ws of fixtures[2].wss.clients) ws.terminate();
  await new Promise(resolve => fixtures[2].server.close(resolve));
  const survivor = active.find(x => x.relay === 0).ws;
  const echoed = once(survivor, 'message'); survivor.send('surviving-old-ws'); assert.equal((await echoed)[0].toString(), 'surviving-old-ws');
  for (let i = 0; i < 3; i++) assert.equal((await connect()).relay, 0);
  await fs.writeFile(path.join(dir, 'native-proxy-result.json'), JSON.stringify({ ok: true, localOnly: true, echoFixtureNotGameWorker: true, sixInitialDistribution: active.map(x => x.relay), healthyEstablishedSocketPreserved: true, newHandshakeFallback: true, anonymous401: true, invalidOrigin403: true, httpBackendUnchanged: true, productionAccessed: false, nginxLog: log }, null, 2) + '\n', { flag: 'wx' });
  t.diagnostic('Real local OpenResty result retained at ' + dir + '; echo fixtures are NOT actual game/Worker proof');
});
