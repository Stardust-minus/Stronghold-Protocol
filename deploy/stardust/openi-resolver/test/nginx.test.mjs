import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const binary = process.env.NGINX_BIN;
const snippet = fileURLToPath(new URL('../../nginx/asset-resolver-location.conf', import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('Nginx asset routing strips credentials, preserves 404, and falls back when the sidecar fails', { skip: !binary }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ark-resolver-nginx-'));
  const observed = [];
  let mode = 'redirect';
  const backend = http.createServer((request, response) => {
    observed.push({ path: request.url, cookie: request.headers.cookie, authorization: request.headers.authorization,
      proxyAuthorization: request.headers['proxy-authorization'], upgrade: request.headers.upgrade });
    if (mode === 'missing') { response.writeHead(404); response.end(); }
    else if (mode === 'error') { response.writeHead(500); response.end(); }
    else {
      response.writeHead(302, { Location: 'https://obs.cn-south-222.ai.pcl.cn/test?Signature=test-only',
        'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      response.end();
    }
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const fallback = 'https://ark-asset.hanabi-ai.cn:25442/releases/v012-workers-20261004';
  await writeFile(join(dir, 'nginx.conf'), `
worker_processes 1;
worker_shutdown_timeout 1s;
pid ${dir}/nginx.pid;
error_log stderr crit;
events { worker_connections 64; }
http {
  access_log off;
  client_body_temp_path ${dir}/body;
  proxy_temp_path ${dir}/proxy;
  fastcgi_temp_path ${dir}/fastcgi;
  uwsgi_temp_path ${dir}/uwsgi;
  scgi_temp_path ${dir}/scgi;
  upstream ark_proto_assets_backend { server 127.0.0.1:${backend.address().port}; keepalive 4; }
  server {
    listen 127.0.0.1:${port};
    keepalive_timeout 1s;
    add_header Cache-Control "private, no-store" always;
    add_header X-Content-Type-Options nosniff always;
    proxy_hide_header Cache-Control;
    location ^~ /assets/ { include ${snippet}; }
    location ^~ /media/ { include ${snippet}; }
    location @ark_proto_asset_fallback { auth_request off; return 302 ${fallback}$request_uri; }
    location = /healthz { return 404; }
    location / { return 401; }
  }
}
`);
  const child = spawn(binary, ['-p', dir, '-c', join(dir, 'nginx.conf'), '-g', 'daemon off;'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; child.stderr.on('data', data => { errors += data.toString(); });
  t.after(async () => {
    backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve));
    if (child.exitCode == null) {
      const stopped = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGQUIT');
      const kill = setTimeout(() => child.kill('SIGKILL'), 2500);
      await stopped; clearTimeout(kill);
    }
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (child.exitCode != null) throw new Error('isolated Nginx exited: ' + errors);
    try { await fetch(base + '/healthz'); break; } catch { if (i >= 100) throw new Error('isolated Nginx not ready'); await wait(20); }
  }
  for (const path of ['/assets/image.png?v=release', '/media/bgm/track']) {
    const response = await fetch(base + path, { redirect: 'manual', headers: {
      Cookie: 'test-only=value', Authorization: 'Bearer test-only', 'Proxy-Authorization': 'Basic test-only',
    } });
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get('location')).hostname, 'obs.cn-south-222.ai.pcl.cn');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    const got = observed.at(-1);
    assert.equal(got.path, path);
    for (const key of ['cookie', 'authorization', 'proxyAuthorization', 'upgrade']) assert.equal(got[key], undefined);
  }
  mode = 'missing';
  assert.equal((await fetch(base + '/assets/not-listed.png', { redirect: 'manual' })).status, 404);
  mode = 'error';
  let response = await fetch(base + '/assets/image.png', { redirect: 'manual' });
  assert.equal(response.status, 302); assert.equal(response.headers.get('location'), fallback + '/assets/image.png');
  backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve));
  response = await fetch(base + '/media/bgm/track', { redirect: 'manual' });
  assert.equal(response.status, 302); assert.equal(response.headers.get('location'), fallback + '/media/bgm/track');
  assert.equal((await fetch(base + '/healthz')).status, 404);
  assert.equal((await fetch(base + '/data/config.json')).status, 401);
});
