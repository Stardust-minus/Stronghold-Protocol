// Opt-in localhost cluster + one browser + nineteen independent human WS sessions.
// Real Match/Worker startup; not twenty browsers, a full battle or a capacity test.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import puppeteer from 'puppeteer-core';
import { startCoordinator } from '../../server/cluster/coordinator.js';
import { startGameRuntime } from '../../server/cluster/game-runtime.js';
import { startIngress } from '../../server/cluster/ingress.js';
import { getData } from '../../server/data.js';
import { cultivationCharIds } from '../../shared/protocol.js';
import { PROTOCOL_VERSION, MATCHMAKING_VERSION } from '../../shared/constants.js';
import { PLAYER_CAPACITY_VERSION } from '../../shared/playerCapacity.js';

const enabled = process.env.SP_E2E === '1';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() >= end) throw new Error('twenty-human fixture deadline: ' + label); await pause(10); }
}

test('browser start button launches twenty real human sessions with more than 64 KiB of valid preferences', { skip: !enabled, timeout: 90000 }, async () => {
  const out = process.env.SP_PREPARE_EVIDENCE || mkdtempSync(fileURLToPath(new URL('../../.cache/stardust/twenty-human-prepare-fix-', import.meta.url)));
  const report = { ok: false, scope: 'localhost actual cluster, one browser, nineteen human WS clients, real Match and one Worker', productionAccessed: false,
    errors: [], externalRequestsBlocked: 0, browserStartFrames: 0 };
  let game, coordinator, ingress, proxy, browser;
  const clients = [], sockets = new Set();
  try {
    const data = getData();
    const ops = Object.fromEntries([...cultivationCharIds(data.chess, data.backups)].slice(0, 72).map(id => [id, { potential: 1, cultivate: 0 }]));
    const key = randomBytes(32); // Local ephemeral key only, never recorded.
    game = await startGameRuntime({ nodeId: 'twenty-browser-node', generation: 'twenty-browser-generation', build: 'twenty-browser-build', key,
      combatWorkers: 1, trialWorkers: 0, onEnd() {}, shutdownMs: 100 });
    const nodes = [{ nodeId: 'twenty-browser-node', url: game.url, key }];
    coordinator = await startCoordinator({ nodes, build: 'twenty-browser-build', host: '127.0.0.1', port: 0, heartbeatMs: 500, quiet: true });
    // The production-shaped browser origin serves coordinator HTTP and ingress WS.
    // This fixture has no gate/TLS/Nginx/WAN and exposes no external endpoints.
    proxy = http.createServer((req, res) => {
      const upstream = http.request(new URL(req.url, coordinator.url), { method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    proxy.on('upgrade', (req, socket, head) => {
      if (req.url !== '/ws' || !ingress) { socket.destroy(); return; }
      const upstream = http.request(new URL('/ws', ingress.url), { headers: req.headers });
      upstream.on('upgrade', (response, target, targetHead) => {
        sockets.add(target); target.once('close', () => sockets.delete(target));
        const headers = [];
        for (let i = 0; i < response.rawHeaders.length; i += 2) headers.push(response.rawHeaders[i] + ': ' + response.rawHeaders[i + 1]);
        socket.write('HTTP/1.1 101 Switching Protocols\r\n' + headers.join('\r\n') + '\r\n\r\n');
        if (targetHead.length) socket.write(targetHead);
        if (head.length) target.write(head);
        socket.on('error', () => target.destroy()); target.on('error', () => socket.destroy());
        socket.once('close', () => target.destroy()); target.once('close', () => socket.destroy());
        socket.pipe(target); target.pipe(socket);
      });
      upstream.on('response', response => { response.resume(); socket.destroy(); });
      upstream.on('error', () => socket.destroy()); upstream.end();
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${proxy.address().port}`;
    ingress = await startIngress({ coordinatorUrl: coordinator.url, nodes: nodes.map(({ nodeId, url }) => ({ nodeId, url })), host: '127.0.0.1', port: 0,
      origins: [url], wsCompression: 'on', shutdownMs: 100 });
    const prepare = coordinator.platform.prepare.bind(coordinator.platform);
    coordinator.platform.prepare = (input, options) => {
      report.prepareEnvelopeBytes = Buffer.byteLength(JSON.stringify({ id: '0'.repeat(32), op: 'prepare', payload: input }));
      return prepare(input, options);
    };
    browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true,
      args: ['--no-sandbox', '--mute-audio', '--disable-background-timer-throttling', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setRequestInterception(true);
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('request', request => {
      if (/^(data:|blob:|about:)/.test(request.url()) || new URL(request.url()).hostname === '127.0.0.1') void request.continue();
      else { report.externalRequestsBlocked++; void request.abort(); }
    });
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketFrameSent', event => {
      try { if (JSON.parse(event.response.payloadData).t === 'room.start') report.browserStartFrames++; } catch { /* non-JSON frame */ }
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.title-login input', { timeout: 20000 });
    await page.type('.title-login input', 'LocalHost'); await page.click('.title-login button');
    await page.waitForSelector('.lobby-screen', { timeout: 20000 });
    await page.evaluate(async ops => {
      const { data } = await import('/js/data.js'); await data.loadAll('chess', 'backups');
      const { setOpsMap } = await import('/js/ui/loadoutSync.js'); setOpsMap(ops);
    }, ops);
    await until(() => {
      const session = [...coordinator.registry.all()].find(s => s.name === 'LocalHost');
      return session && Object.keys(session.ops || {}).length === 72;
    }, 'host preference sync');
    const request = (type, fields = {}) => page.evaluate((type, fields) => globalThis.__SP__.net.request(type, fields).then(() => true), type, fields);
    await request('room.create', { mode: 'coop', difficulty: 'NORMAL', experimental: { revivalEnabled: false, disableSharedPool: false, playerCapacity: 20 } });
    await page.waitForSelector('.room-screen');
    const roomCode = await page.evaluate(() => globalThis.__SP__.store.get().room.code);
    for (let i = 1; i < 20; i++) {
      const socket = new WebSocket(url.replace(/^http/, 'ws') + '/ws', { origin: url, handshakeTimeout: 5000 });
      const frames = [], pending = new Map(); let rid = 0;
      const client = { socket, frames }; clients.push(client); socket.on('error', () => {});
      socket.on('message', raw => {
        const frame = JSON.parse(raw.toString()); frames.push(frame);
        const work = pending.get(frame.rid);
        if (work) { pending.delete(frame.rid); clearTimeout(work.timer); work.resolve(frame); }
      });
      socket.on('close', () => { for (const work of pending.values()) { clearTimeout(work.timer); work.reject(new Error('local human socket closed')); } pending.clear(); });
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      client.request = (type, fields = {}) => new Promise((resolve, reject) => {
        const id = ++rid, timer = setTimeout(() => { pending.delete(id); reject(new Error('local human request deadline')); }, 8000);
        pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ t: type, ...fields, rid: id }));
      });
      const hello = await client.request('hello', { name: 'Local' + i, version: PROTOCOL_VERSION, matchmakingVersion: MATCHMAKING_VERSION, playerCapacityVersion: PLAYER_CAPACITY_VERSION });
      assert.equal(hello.t, 'welcome'); client.playerId = hello.playerId;
      for (const [type, fields] of [['room.loadout', { entries: {}, ops }], ['room.join', { code: roomCode }], ['room.ready', { ready: true }]]) {
        assert.equal((await client.request(type, fields)).t, 'ok', type);
      }
    }
    await page.waitForFunction(() => globalThis.__SP__.store.get().room.seats.filter(Boolean).length === 20);
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('.room-screen button')].find(node => node.textContent.trim() === '开始模拟');
      if (!button || button.disabled) throw new Error('browser start button not ready');
      button.click();
    });
    await page.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'INFO_CHECK', { timeout: 20000 });
    await until(() => clients.every(client => client.frames.some(frame => frame.t === 'm.public' && frame.phase === 'INFO_CHECK')), 'all twenty human startup frames');
    const room = coordinator.lobby.getRoom(roomCode), assignment = coordinator.platform.directory.byRoom(roomCode);
    await coordinator.platform.contexts.get(assignment.assignmentId).publication;
    const match = game.gameHost.contexts.get(assignment.assignmentId).match;
    report.humans = [...match.players.values()].filter(player => !player.isBot).length;
    report.preferencesPreserved = [...match.players.values()].every(player => JSON.stringify(player.ops) === JSON.stringify(ops));
    report.matchErrors = match.errorCount;
    report.phase = await page.evaluate(() => globalThis.__SP__.store.get().match.public.phase);
    report.privateHumanRecipients = clients.filter(client => client.frames.some(frame => frame.t === 'm.private' && frame.playerId === client.playerId)).length + 1;
    report.combatWorkers = game.combatPool.stats().workers;
    assert.ok(report.prepareEnvelopeBytes > 65536); assert.equal(report.humans, 20);
    assert.equal(report.preferencesPreserved, true); assert.equal(report.matchErrors, 0);
    assert.equal(report.privateHumanRecipients, 20); assert.equal(report.browserStartFrames, 1);
    await page.waitForSelector('.brief', { timeout: 10000 });
    await page.screenshot({ path: out + '/twenty-human-info-desktop.png' });
    assert.deepEqual(report.errors, []); assert.equal(report.externalRequestsBlocked, 0);
    assert.ok(room.match);
    report.ok = true;
  } catch (error) { report.failure = error.message; throw error; }
  finally {
    await browser?.close();
    for (const client of clients) client.socket.terminate();
    for (const socket of sockets) socket.destroy();
    if (proxy) await new Promise(resolve => proxy.close(resolve));
    await ingress?.close(); await coordinator?.close(); await game?.close();
    report.allLocalProcessesClosed = true;
    writeFileSync(out + '/browser.json', JSON.stringify(report, null, 2) + '\n');
    console.log('Twenty-human browser evidence: ' + out);
  }
});
