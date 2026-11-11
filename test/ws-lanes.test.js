// Lanes (shared/lanes.js, server/wsLanes.js, public/js/lanes.js): one logical WebSocket over several real ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { LaneMerger, ReplayLog, laneToken, parseLaneToken, laneFrame, splitLaneFrame, splitLaneBytes, LANES_PLAIN, LANE_CLOSE } from '../shared/lanes.js';
import { createLaneHub } from '../server/wsLanes.js';
import { laneWebSocket, laneMetrics } from '../public/js/lanes.js';
import { Net } from '../public/js/net.js';
import { startServer } from '../server/index.js';

const BUNDLE = 'AAAAAAAAAAAAAAAAAAAAAA';

test('lane tokens and frames', () => {
  assert.deepEqual(parseLaneToken(laneToken(BUNDLE, 2, 'join', 17)), { bundle: BUNDLE, index: 2, mode: 'join', ack: 17 });
  assert.deepEqual(parseLaneToken(laneToken(BUNDLE, 0, 'new')), { bundle: BUNDLE, index: 0, mode: 'new', ack: 0 });
  for (const bad of [LANES_PLAIN, `sp.lanes1.${BUNDLE}.0.open`, `sp.lanes1.${BUNDLE}.1.join`, `sp.lanes1.${BUNDLE}.0.new.3`,
    `sp.lanes1.${BUNDLE.slice(1)}.0.new`, `sp.lanes2.${BUNDLE}.0.new`, null, 7]) {
    assert.equal(parseLaneToken(bad), null, String(bad));
  }
  assert.deepEqual(splitLaneFrame(laneFrame(12, '{"t":"x"}')), { seq: 12, payload: '{"t":"x"}' });
  assert.deepEqual(splitLaneFrame('3|'), { seq: 3, payload: '' });
  assert.deepEqual(splitLaneFrame('0|{"ack":4}'), { seq: 0, payload: '{"ack":4}' }, 'seq 0: lane control');
  for (const bad of ['{"t":"x"}', '|x', 'a1|x', '1234567890123456|x', 42]) assert.equal(splitLaneFrame(bad), null, String(bad));
  const bytes = splitLaneBytes(Buffer.from('7|{"a":1}'));
  assert.equal(bytes.seq, 7);
  assert.equal(Buffer.from(bytes.payload).toString(), '{"a":1}');
  assert.equal(splitLaneBytes(Buffer.from('0|{}')).seq, 0);
  for (const bad of ['{"t":"x"}', '|x', '12345678901234567']) assert.equal(splitLaneBytes(Buffer.from(bad)), null, bad);
  const log = new ReplayLog({ ms: 1000, bytes: 10 });
  for (let i = 1; i <= 4; i++) log.add(i, `f${i}`, 3, i * 100);
  assert.deepEqual(log.after(0).map((e) => e.seq), [2, 3, 4], 'bounded by bytes: 12 > 10, frame 1 fell out');
  assert.deepEqual(log.after(3).map((e) => e.seq), [4]);
  log.add(5, 'f5', 3, 2000);
  assert.deepEqual(log.after(0).map((e) => e.seq), [5], 'bounded by age');
});

test('merger: each seq once and in order; a later lane waits for the frames an older lane still owes', () => {
  const m = new LaneMerger(), a = {}, b = {};
  m.addLane(a); m.addLane(b);
  assert.deepEqual(m.push(a, 1, 'x1'), { deliver: ['x1'], fatal: null });
  assert.deepEqual(m.push(b, 1, 'x1').deliver, [], 'a duplicate');
  // frame 2 went out on a only; b opened before 3
  assert.deepEqual(m.push(b, 3, 'x3'), { deliver: [], fatal: null }, 'a may still bring 2');
  assert.deepEqual(m.push(a, 2, 'x2').deliver, ['x2', 'x3']);
  assert.deepEqual(m.push(a, 3, 'x3').deliver, []);
  assert.equal(m.seq, 3);
  assert.equal(m.pending.size, 0);
  assert.equal(m.push(a, 3, 'x3').fatal, 'LANE_ORDER', 'a lane never repeats a seq');
});

test('merger: a gap no open lane can fill is fatal; the backlog is bounded', () => {
  const m = new LaneMerger(), a = {}, b = {};
  m.addLane(a); m.addLane(b);
  m.push(a, 1, 'x1');
  assert.equal(m.push(b, 3, 'x3').fatal, null);
  assert.equal(m.removeLane(a), 'LANE_GAP', 'only a carried 2');
  const n = new LaneMerger({ maxPending: 2 }), c = {}, d = {};
  n.addLane(c); n.addLane(d);
  n.push(c, 2, 'y'); n.push(c, 3, 'y');
  assert.equal(n.push(c, 4, 'y').fatal, 'LANE_BACKLOG');
});

class FakeLane extends EventEmitter {
  constructor(protocol) {
    super();
    this.protocol = protocol; this.readyState = 1; this.bufferedAmount = 0;
    this.sent = []; this.pings = 0; this.closed = null; this.terminated = false;
    this.corks = 0; this.uncorks = 0;
    this._socket = { cork: () => { this.corks++; }, uncork: () => { this.uncorks++; } };
  }
  send(data, opts, cb) { this.sent.push(typeof data === 'string' ? data : Buffer.from(data).toString()); cb?.(); }
  ping() { this.pings++; }
  close(code, reason) { this.closed = { code, reason }; this.readyState = 3; queueMicrotask(() => this.emit('close', code, Buffer.from(reason ?? ''))); }
  terminate() { this.terminated = true; this.readyState = 3; queueMicrotask(() => this.emit('close', 1006, Buffer.alloc(0))); }
}
const tick = () => new Promise((r) => setImmediate(r));

test('bundle: frames on every lane with one seq; browser frames once; best-lane bufferedAmount; cork forwards', async () => {
  const hub = createLaneHub();
  assert.equal(hub.handleProtocols(new Set([LANES_PLAIN, laneToken(BUNDLE, 0, 'new')])), laneToken(BUNDLE, 0, 'new'));
  assert.equal(hub.handleProtocols(new Set(['a', 'b'])), 'a', "ws's default: the first offer");
  assert.equal(hub.handleProtocols(new Set()), false);
  assert.equal(createLaneHub({ enabled: false }).handleProtocols(new Set([LANES_PLAIN, laneToken(BUNDLE, 0, 'new')])), LANES_PLAIN);
  const plain = new FakeLane(LANES_PLAIN);
  assert.equal(hub.adopt(plain), plain, 'a plain socket is handed on as it is');
  const a = new FakeLane(laneToken(BUNDLE, 0, 'new')), b = new FakeLane(laneToken(BUNDLE, 1, 'join'));
  const bundle = hub.adopt(a);
  assert.notEqual(bundle, a);
  assert.equal(hub.adopt(b), null);
  assert.deepEqual(b.sent, ['0|{"ack":0}'], 'a join is told what the server delivered');
  b.sent.length = 0;
  assert.equal(bundle.laneCount, 2);
  const got = [];
  bundle.on('message', (data, binary) => got.push([Buffer.from(data).toString(), binary]));
  bundle.send('{"t":"one"}');
  bundle.send(Buffer.from('{"t":"two"}'), { binary: false });
  assert.deepEqual(a.sent, ['1|{"t":"one"}', '2|{"t":"two"}']);
  assert.deepEqual(b.sent, a.sent);
  a.emit('message', Buffer.from('1|{"t":"hello"}'), false);
  b.emit('message', Buffer.from('1|{"t":"hello"}'), false);
  b.emit('message', Buffer.from('2|{"t":"ping"}'), false);
  assert.deepEqual(got, [['{"t":"hello"}', false], ['{"t":"ping"}', false]]);
  a.bufferedAmount = 5000; b.bufferedAmount = 300;
  assert.equal(bundle.bufferedAmount, 300);
  bundle._socket.cork(); bundle._socket.uncork();
  assert.deepEqual([a.corks, b.corks, a.uncorks, b.uncorks], [1, 1, 1, 1]);
  const c = new FakeLane(laneToken(BUNDLE, 2, 'join')), d = new FakeLane(laneToken(BUNDLE, 3, 'join'));
  assert.equal(hub.adopt(c), null);
  for (const [lane, at] of [[a, 3000], [b, 1000], [c, 2000]]) [...bundle.lanes].find((l) => l.ws === lane).at = at;
  assert.equal(hub.adopt(d), null);
  assert.equal(d.closed, null, 'a join to a full bundle is taken');
  assert.ok(b.terminated && !a.terminated && !c.terminated, '…in place of the lane heard from longest ago');
  await tick();
  assert.equal(bundle.laneCount, 3);
  assert.equal(hub.adopt(new FakeLane(laneToken('B'.repeat(22), 1, 'join'))), null);
  assert.equal(hub.adopt(new FakeLane(laneToken(BUNDLE, 5, 'new'))), null, 'an open bundle id cannot be opened again');
});

test('bundle: a join gets the ack and the kept frames after the browser\'s seq, before anything new', () => {
  const hub = createLaneHub();
  const a = new FakeLane(laneToken(BUNDLE, 0, 'new'));
  const bundle = hub.adopt(a);
  a.emit('message', Buffer.from('1|{"t":"hello"}'), false);
  a.emit('message', Buffer.from('2|{"t":"ping"}'), false);
  for (const t of ['x', 'y', 'z']) bundle.send(`{"t":"${t}"}`);
  const b = new FakeLane(laneToken(BUNDLE, 1, 'join', 1));
  hub.adopt(b);
  bundle.send('{"t":"w"}');
  assert.deepEqual(b.sent, ['0|{"ack":2}', '2|{"t":"y"}', '3|{"t":"z"}', '4|{"t":"w"}']);
  b.emit('message', Buffer.from('0|{"ack":4}'), false);
  assert.equal(bundle.readyState, 1, 'a control frame from the browser is ignored');
});

test('bundle: a lane far behind or silent for a ping interval is dropped; the last lane closes the bundle', async () => {
  const hub = createLaneHub({ lagBytes: 1000 });
  const a = new FakeLane(laneToken(BUNDLE, 0, 'new')), b = new FakeLane(laneToken(BUNDLE, 1, 'join')), c = new FakeLane(laneToken(BUNDLE, 2, 'join'));
  const bundle = hub.adopt(a); hub.adopt(b); hub.adopt(c);
  let closes = [];
  bundle.on('close', (code) => closes.push(code));
  b.bufferedAmount = 5000;
  bundle.send('x');
  assert.ok(b.terminated, 'lagging lane dropped');
  await tick();
  assert.equal(bundle.laneCount, 2);
  bundle.ping();
  assert.deepEqual([a.pings, c.pings], [1, 1]);
  a.emit('pong');
  bundle.ping();
  assert.ok(c.terminated && !a.terminated, 'the lane that answered nothing goes');
  await tick();
  assert.equal(bundle.readyState, 1);
  bundle.close(4001, 'session replaced');
  assert.equal(a.closed.code, 4001);
  await tick();
  assert.deepEqual(closes, [4001]);
  assert.equal(bundle.readyState, 3);
  assert.notEqual(hub.adopt(new FakeLane(laneToken(BUNDLE, 0, 'new'))), null, 'a closed bundle id is free again');
});

// ---- real sockets ------------------------------------------------------------------------------------------------

async function echoServer({ plain = false, hubPerSocket = false, enabled = true } = {}) {
  const server = http.createServer();
  const shared = createLaneHub({ enabled });
  const wss = new WebSocketServer({ noServer: true, ...(plain ? {} : { handleProtocols: shared.handleProtocols }) });
  const sockets = [];
  wss.on('connection', (ws) => {
    const s = (hubPerSocket ? createLaneHub({ enabled }) : shared).adopt(ws);
    if (!s) return;
    sockets.push(s);
    s.on('message', (data) => s.send(`echo:${data.toString()}`));
  });
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `ws://127.0.0.1:${server.address().port}/ws`, sockets,
    close() { for (const c of wss.clients) c.terminate(); wss.close(); server.close(); },
  };
}

async function waitFor(pred, ms = 5000, what = 'condition') {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function client(url, lanes = 2) {
  const LWS = laneWebSocket({ lanes, WebSocket });
  const ws = new LWS(url);
  const c = { ws, got: [], closes: [], opened: false };
  ws.onopen = () => { c.opened = true; };
  ws.onmessage = (ev) => c.got.push(ev.data);
  ws.onclose = (ev) => c.closes.push(ev.code);
  return c;
}

test('real sockets: two lanes carry one logical socket, every frame once and in order', { timeout: 10000 }, async (t) => {
  const srv = await echoServer();
  t.after(() => srv.close());
  const c = client(srv.url);
  t.after(() => c.ws.close());
  await waitFor(() => c.opened && c.ws.laneCount === 2 && srv.sockets[0]?.laneCount === 2, 5000, 'two lanes');
  assert.equal(c.ws.mode, 'lanes');
  for (let i = 0; i < 50; i++) c.ws.send(`m${i}`);
  await waitFor(() => c.got.length >= 50, 5000, 'echoes');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(c.got, Array.from({ length: 50 }, (_, i) => `echo:m${i}`));
  assert.equal(srv.sockets.length, 1);
  assert.ok(c.ws.stats.duplicates >= 1, 'the second copies arrived and were dropped');
});

test('real sockets: a lane that dies is replaced while the stream goes on', { timeout: 15000 }, async (t) => {
  const srv = await echoServer();
  t.after(() => srv.close());
  const c = client(srv.url);
  t.after(() => c.ws.close());
  await waitFor(() => srv.sockets[0]?.laneCount === 2 && c.ws.laneCount === 2, 5000, 'two lanes');
  const first = [...srv.sockets[0].lanes][0];
  first.ws.terminate(); // the lane that opened the bundle
  for (let i = 0; i < 20; i++) c.ws.send(`m${i}`);
  await waitFor(() => c.got.length >= 20, 5000, 'echoes on the remaining lane');
  await waitFor(() => c.ws.laneCount === 2 && srv.sockets[0].laneCount === 2, 6000, 'a replacement lane');
  for (let i = 20; i < 30; i++) c.ws.send(`m${i}`);
  await waitFor(() => c.got.length >= 30, 5000, 'echoes');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(c.got, Array.from({ length: 30 }, (_, i) => `echo:m${i}`));
  assert.equal(c.ws.readyState, 1);
  assert.equal(c.closes.length, 0);
  assert.equal(srv.sockets.length, 1, 'still the one logical socket');
  assert.equal(c.ws.stats.lanesLost, 1);
});

test('real sockets: a server without lanes gets one plain WebSocket', { timeout: 10000 }, async (t) => {
  for (const opts of [{ plain: true }, { enabled: false }]) {
    const srv = await echoServer(opts);
    t.after(() => srv.close());
    const c = client(srv.url);
    t.after(() => c.ws.close());
    await waitFor(() => c.opened, 5000, 'open');
    assert.equal(c.ws.mode, 'plain', JSON.stringify(opts));
    c.ws.send('{"t":"x"}');
    await waitFor(() => c.got.length === 1, 5000, 'echo');
    assert.deepEqual(c.got, ['echo:{"t":"x"}'], 'no seq prefix either way');
    assert.equal(srv.sockets.length, 1);
    c.ws.close();
    await waitFor(() => c.closes.length === 1, 5000, 'close');
    srv.close();
  }
});

test('real sockets: joins refused (another process) stop after three; the socket keeps its lane', { timeout: 15000 }, async (t) => {
  const srv = await echoServer({ hubPerSocket: true });
  t.after(() => srv.close());
  const c = client(srv.url);
  t.after(() => c.ws.close());
  await waitFor(() => c.ws.stats.refusals >= 3, 10000, 'three refusals');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(c.ws.stats.refusals, 3);
  assert.equal(c.ws.laneCount, 1);
  c.ws.send('x');
  await waitFor(() => c.got.length === 1, 5000, 'echo');
  assert.equal(c.closes.length, 0);
});

test('real sockets: the server closing the logical socket closes it once with its code; losing every lane is 1006', { timeout: 10000 }, async (t) => {
  const srv = await echoServer();
  t.after(() => srv.close());
  const c = client(srv.url);
  await waitFor(() => srv.sockets[0]?.laneCount === 2 && c.ws.laneCount === 2, 5000, 'two lanes');
  srv.sockets[0].close(4001, 'session replaced');
  await waitFor(() => c.closes.length >= 1, 5000, 'close');
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(c.closes, [4001]);
  assert.equal(c.ws.readyState, 3);
  const d = client(srv.url);
  await waitFor(() => srv.sockets[1]?.laneCount === 2 && d.ws.laneCount === 2, 5000, 'two lanes');
  for (const lane of srv.sockets[1].lanes) lane.ws.terminate();
  await waitFor(() => d.closes.length >= 1, 5000, 'close');
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(d.closes, [1006]);
});

test('real sockets: frames sent while one lane was open reach the browser and the server over the join, not the stuck lane', { timeout: 15000 }, async (t) => {
  const srv = await echoServer();
  t.after(() => srv.close());
  const LWS = laneWebSocket({ lanes: 2, WebSocket, joinDelayMs: { min: 400, max: 400 } });
  const ws = new LWS(srv.url);
  t.after(() => ws.close());
  const got = [];
  let opened = false;
  ws.onopen = () => { opened = true; };
  ws.onmessage = (ev) => got.push(ev.data);
  await waitFor(() => opened && srv.sockets[0], 5000, 'open');
  const bundle = srv.sockets[0];
  const serverLane = [...bundle.lanes][0].ws, browserLane = [...ws._lanes][0].ws;
  // the first lane gets stuck both ways (nothing read at either end) before the join opens
  laneMetrics.take();
  serverLane._socket.pause();
  browserLane._socket.pause();
  for (let i = 0; i < 5; i++) ws.send(`up${i}`);      // browser → server, on the stuck lane only
  for (let i = 0; i < 5; i++) bundle.send(`down${i}`); // server → browser, on the stuck lane only
  await waitFor(() => ws.laneCount === 2, 5000, 'the join');
  await waitFor(() => got.length >= 10, 5000, 'all frames via the join');
  assert.deepEqual(got.slice(0, 5), ['down0', 'down1', 'down2', 'down3', 'down4'], 'downstream replayed on the join, in order');
  assert.deepEqual(got.slice(5).sort(), ['echo:up0', 'echo:up1', 'echo:up2', 'echo:up3', 'echo:up4'], 'upstream replayed on the join');
  await new Promise((r) => setTimeout(r, 400)); // the stuck lane's copies are now ≥ 400 ms behind the join's
  serverLane._socket.resume();
  browserLane._socket.resume();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(got.length, 10, 'the stuck lane\'s copies are duplicates');
  const late = laneMetrics.take().late;
  assert.ok(late[3] + late[4] >= 5, `the stuck lane's copies are measured as late (> 300 ms): ${late}`);
  assert.equal(ws.readyState, 1);
});

test('real server: net.js over two lanes says hello and pings through one logical socket', { timeout: 15000 }, async (t) => {
  const server = await startServer({ host: '127.0.0.1', port: 0, quiet: true, combatWorkers: 0, trialWorkers: 0, wsCompression: 'on' });
  t.after(() => server.close());
  const net = new Net({ url: `ws://127.0.0.1:${server.port}/ws`, WebSocket: laneWebSocket({ lanes: 2, WebSocket }) });
  t.after(() => net.close());
  net.setName('LaneTest');
  net.connect();
  await waitFor(() => net.status === 'online', 8000, 'welcome');
  await waitFor(() => net.ws?.laneCount === 2, 5000, 'two lanes');
  assert.equal(net.ws.mode, 'lanes');
  const reply = await net.request('room.create', { mode: 'coop' });
  assert.ok(reply, 'a request answered over lanes');
  const latency = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no pong')), 8000);
    net.on('ping', (v) => { if (Number.isFinite(v)) { clearTimeout(timer); resolve(v); } });
    net._sendPing();
  });
  assert.ok(latency >= 0);
});
