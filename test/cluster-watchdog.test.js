// Main-thread watchdog of a game node (server/cluster/watchdog.js; 2026-11-04 game-08): a child process whose main
// thread spins forever is paused through the inspector, logs one JSON line with the frames, and is SIGKILLed; a thread
// that keeps answering is left alone; the environment threshold has bounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { watchdogMs, WATCHDOG_DEFAULT_MS } from '../server/cluster/watchdog.js';

const MODULE = new URL('../server/cluster/watchdog.js', import.meta.url).href;

/** Run `source` as an ES module file in a child process (a game node runs server/cluster/start.mjs as a file). */
function run(source, ms = 20_000) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-watchdog-')), file = path.join(dir, 'child.mjs');
  writeFileSync(file, source);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`child did not end: ${out} ${err}`)); }, ms);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err }); });
  }).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('a main thread that never yields is captured and killed', async () => {
  const started = Date.now();
  const r = await run(`
    import { startMainWatchdog } from ${JSON.stringify(MODULE)};
    startMainWatchdog({ thresholdMs: 500, role: 'game' });
    function payForever() { let n = 0; for (;;) n++; }
    setTimeout(function spinSoon() { payForever(); }, 100);
    setInterval(() => {}, 1000);
  `);
  assert.equal(r.signal, 'SIGKILL', `${r.code} ${r.err}`);
  const lines = r.out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1, r.out);
  const [line] = lines;
  assert.equal(line.event, 'watchdog');
  assert.equal(line.role, 'game');
  assert.equal(line.captured, true);
  assert.ok(line.blockedMs >= 500, String(line.blockedMs));
  assert.ok(line.frames.length >= 2 && line.frames.length <= 30);
  assert.equal(line.frames[0].fn, 'payForever');
  assert.ok(line.frames.some((f) => f.fn === 'spinSoon'));
  assert.match(line.frames[0].at, /child\.mjs:\d+:\d+$/);
  assert.ok(Date.now() - started < 15_000);
});

test('a main thread that keeps answering is left alone, and stop() ends the watch', async () => {
  const r = await run(`
    import { startMainWatchdog } from ${JSON.stringify(MODULE)};
    const w = startMainWatchdog({ thresholdMs: 600, role: 'game' });
    const busy = (ms) => { const end = Date.now() + ms; while (Date.now() < end); };
    let left = 8;
    const step = () => { busy(150); if (--left > 0) setTimeout(step, 50); else w.stop().then(() => console.log('stopped')); };
    setTimeout(step, 50);
  `);
  assert.equal(r.signal, null, r.out);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), 'stopped');
});

test('SP_MAIN_WATCHDOG_MS: unset = 30 s, 0 = off, out of bounds = the default', () => {
  assert.equal(watchdogMs(undefined), WATCHDOG_DEFAULT_MS);
  assert.equal(watchdogMs(''), WATCHDOG_DEFAULT_MS);
  assert.equal(watchdogMs('0'), 0);
  assert.equal(watchdogMs('45000'), 45_000);
  for (const bad of ['100', '4999', '600001', 'x', '1.5e4', '-1']) assert.equal(watchdogMs(bad), bad === '1.5e4' ? 15_000 : WATCHDOG_DEFAULT_MS, bad);
});
