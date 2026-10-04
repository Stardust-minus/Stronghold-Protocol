// Test-only isolated Node24 fixture. No production URL fetch, secrets, images or service changes.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../../../server/index.js';
import { startGateway } from '../../../../server/rolling/gateway.js';
import { controlRequest } from '../../../../server/rolling/control.js';
import { createGate, makeSecrets, ORIGIN } from '../../auth/server.mjs';
import { startServer as startResolver } from '../../openi-resolver/server.mjs';

const dir = process.env.FIXTURE_DIR;
if (!dir || process.versions.node.split('.')[0] !== '24') throw new Error('Isolated Node24 fixture required');
const privateDir = path.join(dir, 'private');
// Each release has a separate REAL Node24 process/Worker pool, not merely two objects in one process.
if (process.env.ROLLING_FIXTURE_ROLE === 'backend') {
  const id = process.env.ROLLING_FIXTURE_RELEASE;
  const backend = await startServer({ port: 0, host: '127.0.0.1', quiet: true, publicDir: path.join(dir, id),
    combatWorkers: 6, trustProxy: 'auto', releaseId: id, controlSocket: path.join(privateDir, id + '.sock'), draining: id !== 'old' });
  process.send({ port: backend.port, pid: process.pid, runtime: process.version });
  process.once('SIGTERM', () => { void backend.close().then(() => process.exit(0)); });
  await new Promise(() => {});
}
async function backendProcess(id) {
  const child = fork(fileURLToPath(import.meta.url), [], { env: { ...process.env,
    ROLLING_FIXTURE_ROLE: 'backend', ROLLING_FIXTURE_RELEASE: id }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('backend child startup timeout')); }, 15000);
    child.once('message', value => { clearTimeout(timer); resolve(value); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('backend child exited ' + code + ': ' + errors)); });
  });
  return { ...ready, close: async () => {
    if (child.exitCode !== null) return;
    const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 2500); await ended; clearTimeout(force);
  } };
}
await fs.mkdir(privateDir, { mode: 0o700 });
const backends = [], resolvers = [], taps = [], observed = [];
const prefix = '/test-bucket/test-dataset/';
const ossOrigin = 'https://obs.cn-south-222.ai.pcl.cn';
const fallbackOrigin = 'https://ark-asset.hanabi-ai.cn:25442';
const releases = [];
let failMaterial = false;
for (const id of ['old', 'new']) {
  const publicDir = path.join(dir, id);
  await fs.mkdir(path.join(publicDir, 'js'), { recursive: true });
  // Use the actual current game HTML verbatim, including its relative imports/nonce substitution.
  await fs.writeFile(path.join(publicDir, 'index.html'), await fs.readFile(new URL('../../../../public/index.html', import.meta.url)));
  await fs.writeFile(path.join(publicDir, 'js/main.js'), `export const fixtureRelease = '${id}';`);
  const backend = await backendProcess(id);
  backends.push(backend);
  const materialId = 'material-' + id, mirrorId = 'mirror-' + id;
  const manifest = { schemaVersion: 1, release: materialId, dataset: 'Stardust_minus/arknight_assets',
    apiOrigin: 'https://openi.pcl.ac.cn', ossOrigin, ossPathPrefix: prefix,
    fallbackBase: `${fallbackOrigin}/releases/${materialId}`,
    entries: ['/assets/a.png', '/media/audio'].map(requestPath => ({ requestPath,
      fileName: `releases/${mirrorId}${requestPath}`, bytes: 123, sha256: '0'.repeat(64),
      mime: requestPath.startsWith('/media') ? 'audio/mpeg' : 'image/png' })) };
  // Inject only the public signing API reply, never contact OpenI/OBS/Ningxia.
  const resolver = await startResolver({ manifest, host: '127.0.0.1', port: 0, prewarm: false, maxRetries: 0,
    fetchImpl: async url => {
      const filename = new URL(url).searchParams.get('file_name');
      return new Response(null, { status: 301, headers: { Location: `${ossOrigin}${prefix}${filename}?AWSAccessKeyId=test-only&Expires=${Math.floor(Date.now() / 1000) + 3600}&Signature=test-only` } });
    } });
  resolvers.push(resolver);
  // Transparent test observer records headers AFTER gateway stripping, then uses the REAL resolver.
  const tap = http.createServer((req, res) => {
    if (req.url !== '/_material') observed.push({ id, path: req.url, headers: req.headers });
    if (failMaterial && req.url !== '/_material') { res.writeHead(503); res.end(); return; }
    const upstream = http.request({ hostname: '127.0.0.1', port: resolver.server.address().port,
      method: req.method, path: req.url, headers: req.headers }, incoming => { res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res); });
    upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  await new Promise(resolve => tap.listen(0, '127.0.0.1', resolve)); taps.push(tap);
  releases.push({ id, port: backend.port, controlSocket: path.join(privateDir, id + '.sock'),
    assetResolver: { port: tap.address().port, materialReleaseId: materialId, mirrorReleaseId: mirrorId,
      manifestHash: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
      ossOrigin, ossPathPrefix: `${prefix}releases/${mirrorId}/`, fallbackBase: `${manifest.fallbackBase}/` },
    staticRoutes: Object.fromEntries(['fonts', 'vendor'].map(mount => [mount,
      { materialReleaseId: materialId, redirectBase: `${manifest.fallbackBase}/${mount}/` }])) });
}
const gateway = await startGateway({ port: 0, publicOrigins: [ORIGIN], trustedProxyAddresses: ['127.0.0.1'],
  staticOrigins: [ossOrigin, fallbackOrigin], activeReleaseId: 'old', releases,
  stateFile: path.join(privateDir, 'state.json'), controlSocket: path.join(privateDir, 'gateway.sock') });
const gate = createGate({ secrets: await makeSecrets('local-only-rolling-password') });
await new Promise(resolve => gate.listen(0, '127.0.0.1', resolve));
let stopping;
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    await gateway.close();
    gate.closeAllConnections(); await new Promise(resolve => gate.close(resolve));
    for (const tap of taps) { tap.closeAllConnections(); await new Promise(resolve => tap.close(resolve)); }
    await Promise.all(resolvers.map(resolver => resolver.close()));
    await Promise.all(backends.map(backend => backend.close()));
  })();
  return stopping;
}
process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
await fs.writeFile(path.join(dir, 'ready.json'), JSON.stringify({ runtime: process.version, auth: gate.address().port,
  gateway: gateway.port, gatewayPid: process.pid, backends: backends.map(({ pid, runtime }) => ({ pid, runtime })),
  legacy: taps[0].address().port, privateDir }), { mode: 0o600 });
// Private file-based test IPC, never an HTTP admin endpoint. Input is created only by the parent test.
let last = 0, working = false;
const timer = setInterval(async () => {
  if (working) return;
  working = true;
  try {
    const { seq, op, releaseId } = JSON.parse(await fs.readFile(path.join(dir, 'command.json'), 'utf8'));
    if (seq <= last) return;
    last = seq;
    let result;
    if (op === 'observed') result = observed;
    else if (op === 'material-error') { failMaterial = true; result = { ok: true }; }
    else if (op === 'auth-down') { gate.closeAllConnections(); await new Promise(resolve => gate.close(resolve)); result = { ok: true }; }
    else result = await controlRequest(path.join(privateDir, 'gateway.sock'), { op, ...(releaseId ? { releaseId } : {}) });
    await fs.writeFile(path.join(dir, 'reply.json'), JSON.stringify({ seq, result }), { mode: 0o600 });
  } catch (error) {
    if (error.code !== 'ENOENT') await fs.writeFile(path.join(dir, 'reply.json'), JSON.stringify({ seq: last, error: error.message }), { mode: 0o600 });
  } finally { working = false; }
}, 20);
timer.unref();
