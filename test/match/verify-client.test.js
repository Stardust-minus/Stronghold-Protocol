// The page's side of shadow verification: public/js/battle/verify.js (a battle of another match in one module Worker,
// answered with its result hash — the Worker itself runs in a real Chrome in test/ui/shadow-verify.e2e.test.js) and
// public/js/battle/clientInfo.js (what the page says about itself: engine / system / device class, build, device id,
// whether it verifies).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installVerify, MAX_VERIFY_QUEUE } from '../../public/js/battle/verify.js';
import { classifyClient, simClientInfo } from '../../public/js/battle/clientInfo.js';

function fakeNet() {
  const handlers = new Map();
  const net = { sent: [], on(t, fn) { handlers.set(t, fn); return () => handlers.delete(t); },
    send(t, fields) { net.sent.push({ t, ...fields }); return true; }, push(msg) { handlers.get(msg.t)?.(msg); },
    status(status) { handlers.get('status')?.({ status }); }, listeners: () => handlers.size };
  return net;
}
function fakeWorker() {
  let handler = null;
  const w = { messages: [], terminated: false, onerror: null, postMessage(m) { w.messages.push(m); }, terminate() { w.terminated = true; },
    reply(msg) { handler?.({ data: msg }); }, task: () => w.messages.filter((m) => m.t === 'verify').pop() || null };
  Object.defineProperty(w, 'onmessage', { get: () => handler, set(fn) { handler = fn; if (fn) setImmediate(() => w.reply({ t: 'ready' })); } });
  return w;
}
const runner = { calls: 0, ensureSim() { this.calls++; return Promise.resolve({ raw: { chess: {} } }); } };
const flush = () => new Promise((r) => setImmediate(r));
const QUIET = { warn() {} };
const task = (vid, deadline = 20000) => ({ t: 'b.verify', vid, spec: { kind: 'normal', players: [] }, deadline, cap: 111000 });
const HASH = 'a'.repeat(64);

test('a battle goes to the worker with the page\'s data once; its hash is answered', async () => {
  const net = fakeNet(), worker = fakeWorker();
  const v = installVerify({ net, runner, createWorker: () => worker, log: QUIET });
  net.push(task('sv1'));
  await flush();
  assert.deepEqual(worker.messages[0], { t: 'data', raw: { chess: {} } });
  assert.deepEqual(worker.task(), { t: 'verify', vid: 'sv1', spec: { kind: 'normal', players: [] }, cap: 111000 });
  worker.reply({ t: 'done', vid: 'sv1', rh: HASH, ticks: 900, ms: 12.5 });
  assert.deepEqual(net.sent, [{ t: 'g.verifyResult', vid: 'sv1', rh: HASH, ticks: 900, ms: 12.5 }]);
  net.push(task('sv2'));
  await flush();
  assert.equal(worker.messages.filter((m) => m.t === 'data').length, 1, 'the data went once');
  worker.reply({ t: 'error', vid: 'sv2', message: 'boom' });
  assert.deepEqual(net.sent[1], { t: 'g.verifyResult', vid: 'sv2', error: true });
  v.dispose();
  assert.equal(net.listeners(), 0);
});

test('past the queue, after the deadline, without a Worker: answered error; offline drops everything', async () => {
  const net = fakeNet(), worker = fakeWorker();
  let t = 0;
  installVerify({ net, runner, createWorker: () => worker, now: () => t, log: QUIET });
  for (let i = 0; i <= MAX_VERIFY_QUEUE + 1; i++) net.push(task(`q${i}`));
  assert.deepEqual(net.sent.map((m) => [m.vid, m.error]), [[`q${MAX_VERIFY_QUEUE + 1}`, true]], 'one running, MAX queued, the next refused');
  t = 30_000; // the queued ones' deadline passed while the first ran
  await flush();
  worker.reply({ t: 'done', vid: 'q0', rh: HASH, ticks: 1, ms: 1 });
  assert.ok(net.sent.filter((m) => m.error).length >= 2, 'expired queued tasks are answered error, not run');
  const none = fakeNet();
  installVerify({ net: none, runner, createWorker: () => { throw new Error('no module worker'); }, log: QUIET });
  none.push(task('x1'));
  assert.deepEqual(none.sent, [{ t: 'g.verifyResult', vid: 'x1', error: true }]);
  const off = fakeNet(), w2 = fakeWorker();
  installVerify({ net: off, runner, createWorker: () => w2, log: QUIET });
  off.push(task('o1'));
  await flush();
  off.status('reconnecting');
  assert.equal(w2.terminated, true);
  w2.reply({ t: 'done', vid: 'o1', rh: HASH, ticks: 1, ms: 1 });
  assert.deepEqual(off.sent, [], 'nothing is answered for a dropped task');
});

test('the page classifies its engine, system and device; it verifies only when it can', () => {
  const cases = [
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Mobile Safari/537.36', { eng: 'blink', os: 'android', dev: 'mobile' }],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/148.0 Mobile/15E148 Safari/604.1', { eng: 'webkit', os: 'ios', dev: 'mobile' }],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:159.0) Gecko/20100101 Firefox/159.0', { eng: 'gecko', os: 'linux', dev: 'desktop' }],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', { eng: 'webkit', os: 'mac', dev: 'desktop' }],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Safari/537.36 Edg/148.0', { eng: 'blink', os: 'windows', dev: 'desktop' }],
  ];
  for (const [ua, want] of cases) assert.deepEqual(classifyClient(ua), want, ua);
  assert.deepEqual(classifyClient('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18 Safari/605', { maxTouchPoints: 5 }).os, 'ios', 'an iPad asks for the desktop site');
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  const nav = { userAgent: cases[0][0], hardwareConcurrency: 8, deviceMemory: 8 };
  const info = simClientInfo({ nav, storage, build: 'b123', stale: false, hasWorker: true });
  assert.equal(info.verify, true);
  assert.match(info.id, /^[0-9a-f]{24}$/);
  assert.equal(simClientInfo({ nav, storage, build: 'b123', stale: false, hasWorker: true }).id, info.id, 'the device id is kept');
  for (const [why, o] of [['weak', { nav: { ...nav, hardwareConcurrency: 2 } }], ['low memory', { nav: { ...nav, deviceMemory: 2 } }],
    ['stale', { stale: true }], ['no build', { build: null }], ['no Worker', { hasWorker: false }]]) {
    assert.equal(simClientInfo({ nav, storage, build: 'b123', stale: false, hasWorker: true, ...o }).verify, false, why);
  }
  store.set('sp.verify', '0');
  assert.equal(simClientInfo({ nav, storage, build: 'b123', stale: false, hasWorker: true }).verify, false, 'opted out');
});
