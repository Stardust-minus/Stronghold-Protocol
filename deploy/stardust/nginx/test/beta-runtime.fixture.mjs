// Test-only bounded HTTP + WS fixture, NOT a game release/export or production runtime.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from '/app/node_modules/ws/wrapper.mjs';
import { createGate, makeSecrets, signToken, SESSION_TTL } from '../../auth/server.mjs';

const dir = process.env.FIXTURE_DIR;
if (!dir || process.versions.node.split('.')[0] !== '24') throw new Error('Node24 isolated fixture required');
const ORIGIN = 'https://ark-proto-beta.stardust.matce.cn';
const nodeRoot = path.join(dir, 'node-app');
const observations = [];
const secrets = await makeSecrets('local-only-beta-test-password');
const gate = createGate({ profile: 'beta', secrets });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await listen(gate);
const game = http.createServer(async (req, res) => {
  observations.push({ kind: 'http', path: req.url, headers: req.headers });
  const url = new URL(req.url, ORIGIN);
  let body, type = 'application/json';
  if (url.pathname === '/healthz') body = JSON.stringify({ online: sockets.size, ok: true });
  else if (url.pathname === '/client-build') body = JSON.stringify({ build: 'beta-test-fixture-not-release' });
  else if (url.pathname === '/js/foo.js') {
    body = await fs.readFile(path.join(nodeRoot, 'public/js/foo.js'), 'utf8'); type = 'application/javascript';
    res.setHeader('X-Beta-Fixture-URI', req.url);
  } else if (url.pathname === '/js/business.js') { body = 'export const DummyBody = "beta-business-test-only";\n'; type = 'application/javascript'; }
  else if (url.pathname === '/data/config.json') body = JSON.stringify({ DummyBody: 'beta-data-test-only' });
  else if (url.pathname === '/' || url.pathname === '/index.html') { body = '<!doctype html><title>Beta test-only DummyBody</title>'; type = 'text/html'; }
  else { res.writeHead(404); res.end(); return; }
  // Deliberately hostile upstream CORS: private vhost must hide it.
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Access-Control-Allow-Origin': '*' });
  res.end(req.method === 'HEAD' ? undefined : body);
});
const sockets = new Set();
const wss = new WebSocketServer({ noServer: true });
game.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' || req.headers.origin !== ORIGIN) { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
  observations.push({ kind: 'ws', path: req.url, headers: req.headers });
  wss.handleUpgrade(req, socket, head, ws => {
    sockets.add(ws); ws.on('close', () => sockets.delete(ws));
    ws.on('message', value => ws.send(value.toString()));
    ws.send(JSON.stringify({ DummyBody: 'beta-ws-test-only' }));
  });
});
await listen(game);
const assets = http.createServer((req, res) => {
  observations.push({ kind: 'asset', path: req.url, headers: req.headers });
  res.writeHead(503); res.end('test-only assets unavailable');
});
await listen(assets);
const expired = signToken('session', Buffer.from(secrets.signingKey, 'base64url'), Math.floor(Date.now() / 1000) - SESSION_TTL - 60);
await fs.writeFile(path.join(dir, 'ready.json'), JSON.stringify({ runtime: process.version, nodeRoot,
  game: game.address().port, auth: gate.address().port, assets: assets.address().port,
  expiredCookie: '__Host-ark_gate=' + expired }), { mode: 0o600 });
let seq = 0, working = false, stopping = false;
const timer = setInterval(async () => {
  if (working || stopping) return;
  working = true;
  try {
    const command = JSON.parse(await fs.readFile(path.join(dir, 'command.json'), 'utf8'));
    if (command.seq <= seq) return;
    seq = command.seq;
    let result;
    if (command.op === 'observed') result = observations.map(row => ({ ...row, hasCookie: Object.hasOwn(row.headers, 'cookie'), headers: { ...row.headers, cookie: undefined } }));
    else if (command.op === 'auth-down') { gate.closeAllConnections(); await new Promise(resolve => gate.close(resolve)); result = true; }
    else throw new Error('Unknown test-only command');
    await fs.writeFile(path.join(dir, 'reply.json'), JSON.stringify({ seq, result }), { mode: 0o600 });
  } catch (error) {
    if (error.code !== 'ENOENT') await fs.writeFile(path.join(dir, 'reply.json'), JSON.stringify({ seq, error: error.message }), { mode: 0o600 });
  } finally { working = false; }
}, 20);
async function stop() {
  if (stopping) return;
  stopping = true; clearInterval(timer);
  for (const ws of sockets) ws.terminate();
  for (const server of [game, assets, gate]) { server.closeAllConnections(); server.close(); }
  wss.close();
  process.exit(0);
}
process.once('SIGTERM', stop); process.once('SIGINT', stop);
console.log('Node24 Beta bounded fixture ready; candidate auth is read-only working tree, not image source.');
