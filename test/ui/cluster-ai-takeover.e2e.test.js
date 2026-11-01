// 「允许观战者接替 AI」 in real browsers on the production shape (coordinator HTTP and ingress WS behind one origin, one game
// node, nothing mocked): the host opts in, in an eight-seat room; a spectator asks in the 「AI 协作」 panel, the host's vote
// passes it, the page becomes the seat's, a reload keeps it, the next round is played from it and the result is marked.
//
//   SP_E2E=1 CHROME_PATH=… node --test test/ui/cluster-ai-takeover.e2e.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Client, hasChrome, sleep } from '../e2e/client.mjs';
import { startCoordinator } from '../../server/cluster/coordinator.js';
import { startGameRuntime } from '../../server/cluster/game-runtime.js';
import { startIngress } from '../../server/cluster/ingress.js';
import { createRpcAuthenticator, createRpcClient } from '../../server/cluster/rpc.js';
import { sendEndReceipt } from '../../server/cluster/receipts.js';

const enabled = process.env.SP_E2E === '1' && hasChrome();
const sockets = new Set();
let game, coordinator, ingress, proxy, url, events;

const combatEnv = process.env.SP_COMBAT;

before(async () => {
  if (!enabled) return;
  process.env.SP_COMBAT = 'server'; // as the image (Dockerfile.cluster): the version hosts inherit it
  const key = randomBytes(32); // ephemeral, never recorded
  game = await startGameRuntime({ nodeId: 'browser-node', generation: 'browser-generation', build: 'browser-build', key,
    combatWorkers: 1, trialWorkers: 0, onEnd: (receipt) => sendEndReceipt({ client: events, nodeGeneration: 'browser-generation', receipt }), shutdownMs: 100 });
  const nodes = [{ nodeId: 'browser-node', url: game.url, key }];
  coordinator = await startCoordinator({ nodes, build: 'browser-build', host: '127.0.0.1', port: 0, heartbeatMs: 500, quiet: true });
  events = createRpcClient({ url: coordinator.privateUrl, authority: createRpcAuthenticator({ key, scope: 'browser-node' }) });
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
  await ingress?.close(); await coordinator?.close(); await game?.close(); events?.close();
});


const net = (c, t, fields) => c.page.evaluate((type, f) => globalThis.__SP__.net.request(type, f), t, fields);
const mine = (c, id) => c.page.waitForFunction((pid) => { const s = globalThis.__SP__.store.get(); return s.me.playerId === pid && s.match.private?.playerId === pid; }, { timeout: 30000 }, id);

test('a spectator takes an AI seat of a twelve-seat room on a game node, keeps it over a reload and plays the next round', { skip: !enabled, timeout: 6 * 60 * 1000 }, async () => {
  const puppeteer = (await import('puppeteer-core')).default;
  const host = new Client(puppeteer, url, 'host', { prefix: 'cluster', prefs: {} }), late = new Client(puppeteer, url, 'late', { prefix: 'cluster', prefs: {} });
  try {
    await host.open();
    await host.enter('房主');
    await sleep(3500); // the page's opening requests fill the heavy bucket
    await net(host, 'room.create', { mode: 'coop', difficulty: 'NORMAL' });
    await net(host, 'room.setExperimental', { experimental: { revivalEnabled: false, disableSharedPool: false, playerCapacity: 12 } });
    // the switch the owner reported as 无效的目标, pressed where the host presses it
    await host.page.waitForSelector('.rs-pill__gear', { visible: true, timeout: 15000 });
    await host.page.click('.rs-pill__gear');
    await host.page.waitForSelector('[data-testid="room-ai-takeover"]', { visible: true, timeout: 5000 });
    await host.page.click('[data-testid="room-ai-takeover"]');
    await host.page.waitForFunction(() => document.querySelector('[data-testid="room-ai-takeover"]')?.checked === true, { timeout: 5000 });
    assert.equal(await host.page.evaluate(() => globalThis.__SP__.store.get().room.aiTakeoverEnabled), true);
    await host.page.keyboard.press('Escape');
    await host.page.waitForFunction(() => !document.querySelector('[data-testid="room-ai-takeover"]'), { timeout: 5000 });
    for (let i = 0; i < 11; i++) await net(host, 'room.addBot', {});
    await net(host, 'room.start', {});
    await host.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 30000);
    await host.settled('.brief-go');
    await host.click('.brief__foot .btn--primary', '准备就绪');
    await host.waitFor((s) => s.phase === 'BAND_DRAFT', 'band draft', 30000);
    await host.click('.dband', null, { nth: 0 });
    await host.click('.draft-detail__btns .btn--primary', '确认选择');
    await host.waitFor((s) => s.phase === 'PREP', 'round 1 prep', 90000);
    const code = (await host.st()).room.code;

    await late.open();
    await late.enter('观战者');
    await sleep(3500);
    await net(late, 'room.spectate', { code });
    await late.page.waitForSelector('.gm__corner .ai-participation-entry', { timeout: 30000 });
    await late.page.click('.gm__corner .ai-participation-entry');
    await late.page.waitForFunction(() => [...document.querySelectorAll('.modal button')].some((b) => b.textContent.includes('申请接替') && !b.disabled), { timeout: 15000 });
    await late.page.evaluate(() => [...document.querySelectorAll('.modal button')].find((b) => b.textContent.includes('申请接替') && !b.disabled).click());
    await host.page.waitForFunction(() => globalThis.__SP__.store.get().room?.aiTakeoverVotes?.length === 1, { timeout: 15000 });
    const vote = await host.page.evaluate(() => globalThis.__SP__.store.get().room.aiTakeoverVotes[0]);
    await net(host, 'room.aiVote', { voteId: vote.id, approve: true });
    await mine(late, vote.botId);
    assert.equal(await late.page.evaluate((id) => globalThis.__SP__.store.get().room.seats.find((s) => s?.playerId === id)?.isBot, vote.botId), false);

    await late.page.reload({ waitUntil: 'domcontentloaded' });
    await late.page.waitForFunction(() => !!globalThis.__SP__ && !!document.querySelector('.screen'), { timeout: 30000 });
    await mine(late, vote.botId);

    const start = await late.st();
    await net(late, 'g.ready', { ready: true });
    await net(host, 'g.ready', { ready: true });
    await late.waitFor((s) => s.round > start.round || s.phase === 'SP_DRAFT', 'past the round', 180000);
    await mine(late, vote.botId);

    const ctx = [...game.gameHost.contexts.values()].find((x) => x.spec.roomCode === code);
    assert.equal(ctx.match.players.get(vote.botId).aiTakeoverRound, start.round);
    ctx.match.finish({ victory: false, reason: 'test' });
    await late.page.waitForFunction((id) => globalThis.__SP__.store.get().match.result?.players?.some((p) => p.playerId === id && Number.isInteger(p.aiTakeoverRound)), { timeout: 30000 }, vote.botId);
    assert.deepEqual(host.problems.filter((p) => !/favicon/.test(p)), [], 'no console errors or failed requests on the host');
    assert.deepEqual(late.problems.filter((p) => !/favicon/.test(p)), [], 'no console errors or failed requests on the new seat');
  } finally { await host.close(); await late.close(); }
});
