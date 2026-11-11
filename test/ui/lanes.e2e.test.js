// Lanes (docs/design/network.md, Lanes) in a real browser: the page's one connection rides two WebSockets against the
// single-process server and through a cluster ingress (coordinator HTTP + ingress WS behind one origin, as in
// production minus nginx); `sp.lanes = '1'` is one plain WebSocket. Requests work either way.
//
//   SP_E2E=1 CHROME_PATH=… node --test test/ui/lanes.e2e.test.js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Client, hasChrome, sleep, startRealServer } from '../e2e/client.mjs';
import { startCoordinator } from '../../server/cluster/coordinator.js';
import { startGameRuntime } from '../../server/cluster/game-runtime.js';
import { startIngress } from '../../server/cluster/ingress.js';
import { laneCounters } from '../../server/wsLanes.js';

const enabled = process.env.SP_E2E === '1' && hasChrome();

const conn = (c) => c.page.evaluate(() => {
  const ws = globalThis.__SP__.net.ws;
  return { status: globalThis.__SP__.net.status, mode: ws?.mode ?? null, lanes: ws?.laneCount ?? null, native: ws instanceof WebSocket };
});
const lanesUp = (c, n) => c.page.waitForFunction((want) => globalThis.__SP__?.net.status === 'online' && globalThis.__SP__.net.ws?.laneCount === want,
  { timeout: 20000 }, n);
const request = (c, t, fields) => c.page.evaluate((type, f) => globalThis.__SP__.net.request(type, f), t, fields);

async function checkPage(puppeteer, base, label) {
  const c = new Client(puppeteer, base, label, { prefix: `lanes-${label}`, prefs: {} });
  try {
    await c.open();
    await c.enter(`通道${label}`);
    await lanesUp(c, 2);
    assert.deepEqual(await conn(c), { status: 'online', mode: 'lanes', lanes: 2, native: false });
    const created = await request(c, 'room.create', { mode: 'coop' });
    assert.ok(created, 'room.create answered over lanes');
    await c.waitFor((s) => !!s.room?.code, 'room created');
    await request(c, 'room.leave', {});
    await c.page.evaluate(() => localStorage.setItem('sp.lanes', '1'));
    await c.page.reload({ waitUntil: 'domcontentloaded' });
    await c.page.waitForFunction(() => globalThis.__SP__?.net.status === 'online', { timeout: 30000 });
    const plain = await conn(c);
    assert.equal(plain.native, true, 'sp.lanes=1: a plain WebSocket');
    assert.ok(await request(c, 'room.create', { mode: 'coop' }), 'room.create answered over one plain socket');
  } finally {
    await c.close();
  }
}

test('lanes against the single-process server', { skip: !enabled, timeout: 120000 }, async () => {
  const srv = await startRealServer({});
  try {
    const puppeteer = (await import('puppeteer-core')).default;
    await checkPage(puppeteer, srv.base, 'single');
  } finally { await srv.stop(); }
});

test('the page reports its network quality once a minute; the server sums it into /healthz netq', { skip: !enabled, timeout: 150000 }, async () => {
  const srv = await startRealServer({});
  const puppeteer = (await import('puppeteer-core')).default;
  const c = new Client(puppeteer, srv.base, 'netq', { prefix: 'lanes-netq', prefs: {} });
  try {
    await c.open();
    await c.enter('网络质量');
    await lanesUp(c, 2);
    let netq = null;
    const end = Date.now() + 100_000;
    while (Date.now() < end) {
      netq = (await (await fetch(`${srv.base}/healthz`)).json()).netq;
      if (netq?.reports >= 1) break;
      await sleep(2000);
    }
    assert.equal(netq?.reports, 1, 'one report after about a minute');
    const g = netq.groups[0];
    assert.deepEqual([g.isp, g.lanes], ['unknown', 2], 'no ISP table here; the page wanted two lanes');
    assert.ok(g.seconds >= 10 && g.rtt.reduce((a, b) => a + b, 0) >= 1, `seconds and round trips counted: ${JSON.stringify(g)}`);
    assert.ok(g.copies >= 1, 'later lane copies were timed');
    const errors = c.problems.filter((p) => /pageerror|netQuality|lanes\.js|net\.q/i.test(p));
    assert.deepEqual(errors, [], 'no page error from the reporter or the lanes');
  } finally { await c.close(); await srv.stop(); }
});

test('lanes through a cluster ingress', { skip: !enabled, timeout: 180000 }, async () => {
  const sockets = new Set();
  let game, coordinator, ingress, proxy, events;
  after(async () => {
    for (const socket of sockets) socket.destroy();
    if (proxy) await new Promise((resolve) => proxy.close(resolve));
    await ingress?.close(); await coordinator?.close(); await game?.close(); events?.close();
  });
  const { createRpcAuthenticator, createRpcClient } = await import('../../server/cluster/rpc.js');
  const { sendEndReceipt } = await import('../../server/cluster/receipts.js');
  const key = randomBytes(32); // ephemeral, never recorded
  game = await startGameRuntime({ nodeId: 'lanes-node', generation: 'lanes-generation', build: 'lanes-build', key,
    combatWorkers: 0, trialWorkers: 0, onEnd: (receipt) => sendEndReceipt({ client: events, nodeGeneration: 'lanes-generation', receipt }), shutdownMs: 100 });
  const nodes = [{ nodeId: 'lanes-node', url: game.url, key }];
  coordinator = await startCoordinator({ nodes, build: 'lanes-build', host: '127.0.0.1', port: 0, heartbeatMs: 500, quiet: true });
  events = createRpcClient({ url: coordinator.privateUrl, authority: createRpcAuthenticator({ key, scope: 'lanes-node' }) });
  proxy = http.createServer((req, res) => {
    const upstream = http.request(new URL(req.url, coordinator.url), { method: req.method, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  proxy.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  proxy.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws' || !ingress) { socket.destroy(); return; }
    const upstream = http.request(new URL('/ws', ingress.url), { headers: req.headers });
    upstream.on('upgrade', (response, target, targetHead) => {
      sockets.add(target); target.once('close', () => sockets.delete(target));
      const headers = [];
      for (let i = 0; i < response.rawHeaders.length; i += 2) headers.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (targetHead.length) socket.write(targetHead);
      if (head.length) target.write(head);
      socket.on('error', () => target.destroy()); target.on('error', () => socket.destroy());
      socket.once('close', () => target.destroy()); target.once('close', () => socket.destroy());
      socket.pipe(target); target.pipe(socket);
    });
    upstream.on('response', (response) => { response.resume(); socket.destroy(); });
    upstream.on('error', () => socket.destroy()); upstream.end();
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${proxy.address().port}`;
  ingress = await startIngress({ coordinatorUrl: coordinator.url, nodes: nodes.map(({ nodeId, url: u }) => ({ nodeId, url: u })), host: '127.0.0.1', port: 0,
    origins: [url], wsCompression: 'on', shutdownMs: 100 });
  const before = { ...laneCounters };
  const puppeteer = (await import('puppeteer-core')).default;
  await sleep(200);
  await checkPage(puppeteer, url, 'cluster');
  assert.ok(laneCounters.bundles > before.bundles && laneCounters.joins > before.joins, 'the ingress (this process) opened bundles and joined lanes');
  assert.equal(laneCounters.gaps, before.gaps);
});
