// Isolated Node24 test fixture. No production secrets, external fetches, or persistent services.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer } from '../../../../server/index.js';
import { createGate, makeSecrets } from '../../auth/server.mjs';
import { startServer as startResolver } from '../../openi-resolver/server.mjs';

const dir = process.env.FIXTURE_DIR;
if (!dir || process.versions.node.split('.')[0] !== '24') throw new Error('Isolated Node24 fixture required');
const observed = [];
const game = await startServer({ port: 0, host: '127.0.0.1', quiet: true, combatWorkers: 6, trustProxy: 'auto' });
const gate = createGate({ secrets: await makeSecrets('local-only-simple-password') });
await new Promise(resolve => gate.listen(0, '127.0.0.1', resolve));
const release = 'v012-alliance-20261004';
const prefix = '/test-bucket/test-dataset/';
const manifest = {
  schemaVersion: 1, release, dataset: 'Stardust_minus/arknight_assets',
  apiOrigin: 'https://openi.pcl.ac.cn', ossOrigin: 'https://obs.cn-south-222.ai.pcl.cn', ossPathPrefix: prefix,
  fallbackBase: 'https://ark-asset.hanabi-ai.cn:25442/releases/' + release,
  entries: [
    { requestPath: '/assets/a.png', fileName: 'releases/test-mirror/assets/a.png', bytes: 123, sha256: '0'.repeat(64), mime: 'image/png' },
    { requestPath: '/media/audio', fileName: 'releases/test-mirror/media/audio', bytes: 123, sha256: '0'.repeat(64), mime: 'audio/mpeg' },
  ],
};
const assets = await startResolver({ manifest, host: '127.0.0.1', port: 0, prewarm: false, maxRetries: 0,
  fetchImpl: async url => {
    const filename = new URL(url).searchParams.get('file_name');
    return new Response(null, { status: 301, headers: {
      Location: `${manifest.ossOrigin}${prefix}${filename}?AWSAccessKeyId=test-only&Expires=${Math.floor(Date.now() / 1000) + 3600}&Signature=test-only`,
    } });
  },
});
let failAssets = false;
// Test observer only: not an additional deployed service. The real resolver still owns every response.
const tap = http.createServer((req, res) => {
  observed.push({ path: req.url, headers: req.headers });
  if (failAssets) { res.writeHead(503); res.end(); return; }
  const upstream = http.request({ hostname: '127.0.0.1', port: assets.server.address().port,
    method: req.method, path: req.url, headers: req.headers }, incoming => {
    res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(upstream);
});
await new Promise(resolve => tap.listen(0, '127.0.0.1', resolve));
let stopping;
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    clearInterval(timer);
    gate.closeAllConnections(); await new Promise(resolve => gate.close(resolve));
    tap.closeAllConnections(); await new Promise(resolve => tap.close(resolve));
    await assets.close(); await game.close();
  })();
  return stopping;
}
process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
await fs.writeFile(path.join(dir, 'ready.json'), JSON.stringify({ runtime: process.version,
  game: game.port, auth: gate.address().port, assets: tap.address().port }), { mode: 0o600 });
// Private test-file IPC, never a production/admin HTTP endpoint.
let last = 0, working = false;
const timer = setInterval(async () => {
  if (working) return;
  working = true;
  try {
    const { seq, op } = JSON.parse(await fs.readFile(path.join(dir, 'command.json'), 'utf8'));
    if (seq <= last) return;
    last = seq;
    let result;
    if (op === 'observed') result = observed;
    else if (op === 'addresses') result = [...game.registry.all()].map(({ addr, limitKey }) => ({ addr, limitKey }));
    else if (op === 'assets-down') { failAssets = true; result = { ok: true }; }
    else if (op === 'auth-down') { gate.closeAllConnections(); await new Promise(resolve => gate.close(resolve)); result = { ok: true }; }
    else throw new Error('Unknown fixture command');
    await fs.writeFile(path.join(dir, 'reply.json'), JSON.stringify({ seq, result }), { mode: 0o600 });
  } catch (error) {
    if (error.code !== 'ENOENT') await fs.writeFile(path.join(dir, 'reply.json'), JSON.stringify({ seq: last, error: error.message }), { mode: 0o600 });
  } finally { working = false; }
}, 20);
timer.unref();
