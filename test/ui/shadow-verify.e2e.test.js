// SP_E2E=1 node --test test/ui/shadow-verify.e2e.test.js
// Shadow verification in a real Chrome (DESIGN §14): the page's verifier (battle/verify.js + battle/verifyWorker.js, a
// module Worker on the page's own official data) runs pseudonymized golden battles and answers g.verifyResult; every
// result hash equals the server's (node:crypto over its own run, renamed the same way) — the canonical JSON, the
// pseudonyms, the sim and crypto.subtle all agree with Node. Also reports how long the runs took. DevTools CPU throttling
// does not reach a dedicated Worker (measured 2026-11-11: 1×, 4× and 6× took the same), so a phone's time is estimated
// from this one by tools/perfbench.mjs's factors instead (4× ≈ a mid-range phone, 6× ≈ a low-end one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { CHROME, hasChrome } from '../e2e/client.mjs';
import { createStaticHandler } from '../../server/http/static.js';
import { createRequestHandler } from '../../server/http/routes.js';
import { siteCsp } from '../../server/http/csp.js';
import { createBattleFromSpec } from '../../server/sim/spec.js';
import { DataSource } from '../../server/sim/simdata.js';
import { getData } from '../../server/data.js';
import { pseudonymizeSpec } from '../../server/match/verify/pseudonym.js';
import { resultHashOfResult } from '../../server/match/verify/hash.js';
import { VERIFY_CAP_TICKS } from '../../server/match/verify/hub.js';
import { corpusSpecs } from '../../tools/sim-check.mjs';

const enabled = process.env.SP_E2E === '1' && hasChrome();

test('Chrome: a verifier page answers the server\'s result hash for pseudonymized battles (and how long it takes)', { skip: !enabled, timeout: 300_000 }, async (t) => {
  const ds = new DataSource(getData(), null);
  const corpus = corpusSpecs().filter((c) => c.fast).slice(0, 24);
  const tasks = corpus.map(({ id, spec, cap }, i) => {
    const vid = `sv${i}`;
    const { spec: pseudo, rename } = pseudonymizeSpec(spec, vid);
    const b = createBattleFromSpec(spec, ds, { quiet: true, recordEvents: false });
    const limit = cap ?? VERIFY_CAP_TICKS;
    while (!b.finished && b.tickCount < limit) b.step();
    if (!b.finished) b.forceEnd('timeout');
    return { id, vid, spec: pseudo, cap: limit, want: resultHashOfResult(b.result(), rename), ticks: b.tickCount };
  });
  const root = path.resolve('.');
  const staticFiles = createStaticHandler({ publicDir: path.join(root, 'public'), sharedDir: path.join(root, 'shared'), dataDir: path.join(root, 'data') });
  const handler = createRequestHandler({ csp: siteCsp(path.join(root, 'public')), health: {}, log: console,
    serveStatic: async (req, res, url, query) => {
      if (url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>verify</title>'); return; }
      await staticFiles(req, res, url, query);
    } });
  const server = http.createServer(handler);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const puppeteer = (await import('puppeteer-core')).default;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(await page.evaluate(() => window.isSecureContext && !!crypto.subtle), true, 'a secure context: the page hashes with crypto.subtle');
  // the production verifier with a stand-in socket and the page's own sim load (main.js wires the real ones)
  await page.evaluate(async () => {
    const { installVerify } = await import('/js/battle/verify.js');
    const { loadBrowserSim } = await import('/js/battle/simLoader.js');
    const handlers = new Map(); const sent = [];
    const net = { on: (type, fn) => { handlers.set(type, fn); return () => handlers.delete(type); }, send: (type, msg) => { sent.push({ type, ...msg }); } };
    let sim = null;
    installVerify({ net, runner: { ensureSim: async () => (sim ||= await loadBrowserSim()) } });
    window.__verify = { handlers, sent };
  });
  const timing = {};
  {
    const answers = await page.evaluate(async (tasks) => {
      const { handlers, sent } = window.__verify;
      sent.length = 0;
      const out = [];
      for (const task of tasks) { // one at a time, as the server hands them
        handlers.get('b.verify')({ t: 'b.verify', vid: task.vid, spec: task.spec, deadline: 120000, cap: task.cap });
        const t0 = Date.now();
        while (!sent.some((m) => m.vid === task.vid)) { if (Date.now() - t0 > 120000) break; await new Promise((r) => setTimeout(r, 5)); }
        out.push(sent.find((m) => m.vid === task.vid) || { vid: task.vid, missing: true });
      }
      return out;
    }, tasks.map(({ vid, spec, cap }) => ({ vid, spec, cap })));
    for (const [i, a] of answers.entries()) {
      assert.equal(a.type, 'g.verifyResult', `${tasks[i].id}: answered`);
      assert.equal(a.error, undefined, `${tasks[i].id}: no error`);
      assert.equal(a.rh, tasks[i].want, `${tasks[i].id}: the result hash`);
      assert.equal(a.ticks, tasks[i].ticks, `${tasks[i].id}: ticks`);
    }
    const ms = answers.map((a) => a.ms), ticks = tasks.reduce((n, x) => n + x.ticks, 0);
    Object.assign(timing, { battles: ms.length, totalMs: Math.round(ms.reduce((x, y) => x + y, 0)), maxMs: Math.round(Math.max(...ms)),
      msPer1000Ticks: Math.round(ms.reduce((x, y) => x + y, 0) / ticks * 1000 * 100) / 100, ticks });
  }
  t.diagnostic(`shadow-verify timing ${JSON.stringify(timing)}`);
  assert.deepEqual(errors, []);
});
