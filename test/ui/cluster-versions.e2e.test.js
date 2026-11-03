// The production shape in a real browser: one origin serving coordinator HTTP and ingress WS, one game node, nothing
// mocked. A match of the default version runs on the game node; since rel26 so does one of an older version, in the
// game node's version host (versionPlacement 'node', the default; the coordinator's version host is the
// SP_VERSION_PLACEMENT=coordinator fallback, test/cluster-version-room.test.js). No gate, TLS, Nginx or WAN here.
//
//   SP_E2E=1 CHROME_PATH=… node --test test/ui/cluster-versions.e2e.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Client, hasChrome, sleep } from '../e2e/client.mjs';
import { startCoordinator } from '../../server/cluster/coordinator.js';
import { startGameRuntime } from '../../server/cluster/game-runtime.js';
import { startIngress } from '../../server/cluster/ingress.js';

const enabled = process.env.SP_E2E === '1' && hasChrome();
const sockets = new Set();
let game, coordinator, ingress, proxy, url;

const combatEnv = process.env.SP_COMBAT;

before(async () => {
  if (!enabled) return;
  process.env.SP_COMBAT = 'server'; // as the image (Dockerfile.cluster): the version hosts inherit it
  const key = randomBytes(32); // ephemeral, never recorded
  game = await startGameRuntime({ nodeId: 'browser-node', generation: 'browser-generation', build: 'browser-build', key,
    combatWorkers: 1, trialWorkers: 0, onEnd() {}, shutdownMs: 100 });
  const nodes = [{ nodeId: 'browser-node', url: game.url, key }];
  coordinator = await startCoordinator({ nodes, build: 'browser-build', host: '127.0.0.1', port: 0, heartbeatMs: 500, quiet: true });
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
  url = `http://127.0.0.1:${proxy.address().port}`;
  ingress = await startIngress({ coordinatorUrl: coordinator.url, nodes: nodes.map(({ nodeId, url }) => ({ nodeId, url })), host: '127.0.0.1', port: 0,
    origins: [url], wsCompression: 'on', shutdownMs: 100 });
});

after(async () => {
  if (combatEnv === undefined) delete process.env.SP_COMBAT; else process.env.SP_COMBAT = combatEnv;
  for (const socket of sockets) socket.destroy();
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
  await ingress?.close(); await coordinator?.close(); await game?.close();
});

/** Lobby → (the version) → 独立模拟 → briefing → strategy → round 1 → a bought operator → the fight → round 2's prep. */
async function play(version) {
  const puppeteer = (await import('puppeteer-core')).default;
  const c = new Client(puppeteer, url, version, { prefix: 'cluster', prefs: {} });
  try {
    await c.open();
    await c.enter('集群');
    if (version !== 'act2autochess') {
      await c.click('[data-testid="version-switch"]');
      await c.click(`.verpick__pick[data-version="${version}"]`);
      await c.page.waitForFunction((v) => document.querySelector('[data-testid="version-switch"]')?.dataset.version === v, { timeout: 30000 }, version);
    }
    await c.createSolo('标准模拟');
    await c.waitFor((s) => !!s.room, 'solo room');
    if (!(await c.st()).phase) await c.roomStart({ timeout: 20000 });
    await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 30000);
    await c.settled('.brief-go');
    await c.click('.brief__foot .btn--primary', '准备就绪');
    await c.waitFor((s) => s.phase === 'BAND_DRAFT', 'band draft', 30000);
    await c.click('.dband', null, { nth: 0 });
    await c.click('.draft-detail__btns .btn--primary', '确认选择');
    await c.waitFor((s) => s.phase === 'PREP', 'round 1 prep', 60000);
    const start = await c.st();
    assert.equal(await c.page.evaluate(() => globalThis.__SP__.store.get().match.public?.version ?? 'act2autochess'), version);
    // 战斗 2 倍速: g.speedVote reaches the match on the game node and through the version host's proxy
    await c.click('[data-testid="speed-vote"]');
    await c.page.waitForFunction(() => document.querySelector('[data-testid="speed-vote"]')?.dataset.status === 'next', { timeout: 10000 });
    await c.page.evaluate(() => globalThis.__SP__.net.request('g.ready', { ready: true }));
    const end = Date.now() + 240000;
    let local = false;
    let fastest = 0;
    for (;;) {
      const s = await c.st();
      if (s.phase === 'COMBAT') local ||= await c.page.evaluate(() => globalThis.__SP__.store.get().match.field?.local === true);
      if (s.phase === 'COMBAT') fastest = Math.max(fastest, await c.page.evaluate(() => globalThis.__SP__.store.get().match.public?.speedVote?.speed ?? 0));
      if (s.phase === 'PREP' && s.round > start.round) break;
      if (s.result) throw new Error('the match ended in round 1');
      if (s.phase === 'SP_DRAFT' || Date.now() > end) break;
      await sleep(200);
    }
    const s = await c.st();
    assert.ok(s.round > start.round || s.phase === 'SP_DRAFT', `past round 1: ${JSON.stringify({ phase: s.phase, round: s.round })}`);
    assert.equal(local, true, 'the battle ran as a local display replica');
    assert.equal(fastest, 4, 'the battle ran at 2 倍速');
    assert.deepEqual(c.problems, [], 'no console errors or failed requests');
  } finally { await c.close(); }
}

test('公开同盟: room.setListed and room.list pass the ingress to the rooms on the coordinator', { skip: !enabled, timeout: 2 * 60 * 1000 }, async () => {
  const puppeteer = (await import('puppeteer-core')).default;
  const c = new Client(puppeteer, url, 'act2autochess', { prefix: 'cluster', prefs: {} });
  try {
    await c.open();
    await c.enter('列表');
    const rooms = await c.page.evaluate(async () => {
      const { net } = globalThis.__SP__;
      await new Promise((resolve) => setTimeout(resolve, 3500)); // the page's opening requests fill the heavy bucket
      await net.request('room.create', { mode: 'coop', difficulty: 'NORMAL', experimental: { revivalEnabled: false, disableSharedPool: false, playerCapacity: 8 } });
      await net.request('room.setListed', { listed: true });
      return (await net.request('room.list')).rooms;
    });
    assert.equal(rooms.length, 1);
    assert.deepEqual([rooms[0].host, rooms[0].humans, rooms[0].capacity], ['列表', 1, 8]);
  } finally { await c.close(); }
});

test('同盟设置 of a twelve-seat room: the 公开 switch works, the pool plan reaches the game node', { skip: !enabled, timeout: 3 * 60 * 1000 }, async () => {
  const puppeteer = (await import('puppeteer-core')).default;
  const c = new Client(puppeteer, url, 'act2autochess', { prefix: 'cluster', prefs: {} });
  try {
    await c.open();
    await c.enter('十二人');
    await c.page.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3500)); // the page's opening requests fill the heavy bucket
      await globalThis.__SP__.net.request('room.create', { mode: 'coop', difficulty: 'NORMAL', experimental: { revivalEnabled: false, disableSharedPool: false, playerCapacity: 12 } });
    });
    await c.page.waitForSelector('.rs-pill__gear', { visible: true, timeout: 30000 });
    await c.page.$eval('.rs-pill__gear', (b) => b.click());
    await c.page.waitForSelector('[data-testid="room-opt-listed"]', { visible: true, timeout: 5000 });
    // the owner's report: 公开 answered 无效的目标 in a twelve-seat room. The click, not the message.
    await c.page.click('[data-testid="room-opt-listed"]');
    await c.page.waitForFunction(() => globalThis.__SP__.store.get().room?.listed === true, { timeout: 10000 });
    assert.equal(await c.page.$eval('[data-testid="room-opt-listed"]', (el) => el.checked), true);
    assert.deepEqual(await c.page.$$eval('.toast', (els) => els.map((el) => el.textContent)), []);
    const rooms = await c.page.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return (await globalThis.__SP__.net.request('room.list')).rooms;
    });
    assert.deepEqual(rooms.map((r) => r.capacity), [12]);

    await c.page.$eval('[data-testid="room-settings-pools"]', (b) => b.click());
    await c.page.waitForSelector('#experimental-pools-manual', { visible: true, timeout: 5000 });
    await c.page.click('#experimental-pools-manual');
    await c.page.waitForFunction(() => globalThis.__SP__.store.get().room?.experimental?.poolPlan?.length === 12, { timeout: 10000 });
    await c.page.waitForSelector('.pooled', { visible: true, timeout: 5000 });
    await c.page.keyboard.press('Escape');
    await c.page.waitForSelector('.room-settings-modal', { hidden: true, timeout: 5000 });
    await c.page.evaluate(async () => {
      const { net, store } = globalThis.__SP__;
      for (let i = 0; i < 3; i++) await net.request('room.addBot');
      const { revivalEnabled, disableSharedPool, playerCapacity } = store.get().room.experimental;
      await net.request('room.setExperimental', { experimental: { revivalEnabled, disableSharedPool, playerCapacity, poolPlan: [0, 1, 1, 0, 2, 2, 2, 2, 2, 2, 2, 2] } });
      await net.request('room.start');
    });
    await c.page.waitForFunction(() => !!globalThis.__SP__.store.get().match?.public?.poolGroups, { timeout: 30000 });
    const groups = await c.page.evaluate(() => globalThis.__SP__.store.get().match.public.poolGroups.map((g) => [g.id, g.playerIds.length, g.scale]));
    assert.deepEqual(groups, [[1, 2, 1], [2, 2, 1]], 'seats 0 and 3 in one pool, 1 and 2 in the other, the empty third gone');
    assert.deepEqual(c.problems, [], 'no console errors or failed requests');
  } finally { await c.close(); }
});

test('a default-version match on the game node, in a browser', { skip: !enabled, timeout: 5 * 60 * 1000 }, async () => {
  await play('act2autochess');
  assert.equal(coordinator.versionHosts?.stats?.().matches ?? 0, 0);
});

test('an older version\'s match in the game node\'s version host, on its Worker, in a browser', { skip: !enabled, timeout: 5 * 60 * 1000 }, async () => {
  await play('act1autochess');
  const stats = game.versionHosts.stats();
  assert.equal(stats.matches, 1);
  // SP_NODE_VERSION_COMBAT_WORKERS (default 1) server-combat Worker per version host
  assert.ok(stats.combat?.size >= 1 && stats.combat.ready === stats.combat.size, JSON.stringify(stats.combat));
  assert.equal(coordinator.versionHosts?.stats?.().matches ?? 0, 0, 'nothing in the coordinator\'s version host');
});
