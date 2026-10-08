import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/warmup.js', import.meta.url), 'utf8');
const gate = readFileSync(new URL('../public/gate.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture({ connection = {}, hidden = false, idleSupported = true } = {}) {
  const requests = [], events = new Map(), timers = new Map();
  let seq = 0, idleCallback;
  const context = {
    AbortController, navigator: { connection }, document: { hidden },
    fetch: (path, options) => new Promise((resolve, reject) => {
      requests.push({ path, options, resolve, reject });
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id), addEventListener: (name, fn) => events.set(name, fn),
    ...(idleSupported ? { requestIdleCallback(fn) { idleCallback = fn; return 1; }, cancelIdleCallback() { idleCallback = null; } } : {}),
  };
  context.window = context;
  vm.runInNewContext(source, context);
  return { context, requests, events, timers, runIdle: () => idleCallback?.(),
    respond: (request, ok = true) => request.resolve({ ok, arrayBuffer: async () => new ArrayBuffer(1), body: { cancel: async () => {} } }) };
}

test('anonymous page warms exactly seven fixed public dependencies, two at a time, credential-free', async () => {
  const f = fixture(); assert.equal(f.requests.length, 0);
  f.runIdle(); assert.equal(f.requests.length, 2);
  f.respond(f.requests[0]); await turn(); assert.equal(f.requests.length, 3);
  for (let i = 1; i < 7; i++) { f.respond(f.requests[i]); await turn(); }
  assert.deepEqual(f.requests.map(r => r.path), [
    '/fonts/fonts.css', '/fonts/bender-regular.woff2', '/fonts/bender-light.woff2',
    '/fonts/novecento-wide-normal.woff2', '/vendor/preact.module.js', '/vendor/hooks.module.js', '/vendor/htm.module.js',
  ]);
  for (const { options } of f.requests) {
    assert.equal(options.credentials, 'omit'); assert.equal(options.priority, 'low');
    assert.equal(options.cache, 'default'); assert.equal(options.mode, 'cors');
  }
  assert.equal(f.timers.size, 0);
  f.runIdle(); assert.equal(f.requests.length, 7, 'no duplicate warmup');
});
for (const options of [{ hidden: true }, { connection: { saveData: true } }, { connection: { effectiveType: '2g' } }, { connection: { effectiveType: 'slow-2g' } }]) {
  test(`background or economical connection skips warmup: ${JSON.stringify(options)}`, () => {
    const f = fixture(options); f.runIdle(); assert.equal(f.requests.length, 0);
  });
}
test('public requests have deadlines, no retries; hiding/stopping starts no further I/O', async () => {
  const f = fixture(); f.runIdle();
  const deadlines = [...f.timers.values()];
  assert.equal(deadlines.length, 2); assert.ok(deadlines.every(t => t.ms === 5000));
  f.context.document.hidden = true;
  for (const deadline of deadlines) deadline.fn();
  await turn(); assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every(r => r.options.signal.aborted));
  const g = fixture(); g.runIdle(); g.events.get('pagehide')(); await turn();
  assert.ok(g.requests.every(r => r.options.signal.aborted)); assert.equal(g.requests.length, 2);
});
test('public warmup failures never reject auth or retry unavailable files', async () => {
  const f = fixture(); f.runIdle();
  for (let i = 0; i < 7; i++) {
    if (i % 2) f.requests[i].reject(new Error('offline')); else f.respond(f.requests[i], false);
    await turn();
  }
  assert.equal(f.requests.length, 7); assert.equal(f.timers.size, 0);
});
test('without idle callback, pagehide cancels the bounded fallback timer', () => {
  const f = fixture({ idleSupported: false }); const scheduled = [...f.timers.values()];
  assert.equal(scheduled.length, 1); assert.equal(scheduled[0].ms, 1200);
  f.events.get('pagehide')(); assert.equal(f.timers.size, 0);
});
test('optional asynchronous warmup never imports or prepares private game code', () => {
  const build = gate.match(/body\.dataset\.build !== '([^']+)'/)[1];
  assert.ok(page.includes(`src="/_gate/assets/warmup.js?v=${build}" async`));
  assert.doesNotMatch(gate, /ArkEntryWarmup|speculationrules/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|caches\.open|serviceWorker|import\(|speculationrules|prerender|createElement/);
  const enter = gate.slice(gate.indexOf('  function enter('), gate.indexOf('  function busy('));
  assert.ok(enter.indexOf('setTimeout(navigate, 4100)') < enter.indexOf("setPhase('auth-morph')"));
});
test('auth CSP permits only the existing static host; private gates stay intact', () => {
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(server, /\['warmup\.js', 'text\/javascript; charset=utf-8'\]/);
  assert.doesNotMatch(server, /inline-speculation-rules/);
  for (const url of [new URL('../../nginx/ark-proto.conf', import.meta.url), new URL('../../nginx/ark-proto-beta.conf', import.meta.url)]) {
    const text = readFileSync(url, 'utf8');
    const policies = [...text.matchAll(/(?:\/login|\/entry|~\^\/_gate\/) "(default-src [^"]+)"/g)].map(m => m[1]);
    assert.equal(policies.length, 3);
    for (const policy of policies) {
      assert.match(policy, /script-src 'self' https:\/\/ark-asset\.hanabi-ai\.cn:25442/);
      assert.match(policy, /connect-src 'self' https:\/\/ark-asset\.hanabi-ai\.cn:25442;/);
      assert.match(policy, /frame-ancestors 'none'/);
      assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|inline-speculation-rules|\*/);
    }
    assert.match(text, /auth_request \/_gate\/check;/); assert.match(text, /private, no-store/);
  }
});
