// Policy forward cost in headless Chrome with CPU throttling (mid-phone / low-end proxies):
//   node tools/rl/chrome_bench.mjs <policy base> [n] [chromePath]   (it starts Chrome: run it through your job queue on a shared machine)
// Real observations from the env; infer.mjs and infer2.mjs both timed per throttling rate (1x, 4x, 6x).
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import puppeteer from 'puppeteer-core';
import { SPEnv, randomActions } from './env.mjs';

const base = process.argv[2], N = Number(process.argv[3] || 1500), chromePath = process.argv[4] || '/usr/bin/google-chrome';
const env = new SPEnv({ envs: 6, configs: ['coop4:ABYSS', 'solo:HARD', 'coop2:NORMAL', 'solo:ABYSS'], seed: 3600000000, envSeed: 4, humans: 'random' });
const O = [], M = []; let b = env.reset(); const D = env.D, A = env.A;
while (O.length < N && b.n) { for (let k = 0; k < b.n && O.length < N; k++) { O.push(b.obs.slice(k * D, (k + 1) * D)); M.push(b.mask.slice(k * A, (k + 1) * A)); } b = env.step(randomActions(b)); }
env.close();
const obsBuf = Buffer.alloc(O.length * D * 4), maskBuf = Buffer.alloc(O.length * A);
O.forEach((o, i) => Buffer.from(o.buffer, o.byteOffset, o.byteLength).copy(obsBuf, i * D * 4)); M.forEach((m, i) => Buffer.from(m).copy(maskBuf, i * A));
const strip = (f) => readFileSync(new URL(f, import.meta.url), 'utf8').replace(/^import \{ readFileSync \} from 'node:fs';\n/m, '')
  .replace(/static load\(base\) \{[\s\S]*?\n  \}\n/, '').replace(/\n\/\/ parity check:[\s\S]*$/, '\n');
const files = { '/infer.js': strip('./infer.mjs'), '/infer2.js': strip('./infer2.mjs'), '/p.json': readFileSync(`${base}.json`), '/p.bin': readFileSync(`${base}.bin`),
  '/obs.bin': obsBuf, '/mask.bin': maskBuf, '/': '<!doctype html><meta charset="utf-8"><title>bench</title>' };
const srv = http.createServer((q, r) => { const f = files[q.url]; if (f === undefined) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'content-type': q.url.endsWith('.js') ? 'text/javascript' : q.url === '/' ? 'text/html' : 'application/octet-stream' }); r.end(f); });
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const url = `http://127.0.0.1:${srv.address().port}/`;
const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage(); await page.goto(url);
const cdp = await page.createCDPSession();
const out = { observations: O.length, D, A, node: {} , chrome: {} };
for (const rate of [1, 4, 6]) {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  out.chrome[`${rate}x`] = await page.evaluate(async ({ D, A, n }) => {
    const { SPPolicy } = await import('/infer.js'), { SPPolicy2 } = await import('/infer2.js');
    const m = await (await fetch('/p.json')).json(), w = new Float32Array(await (await fetch('/p.bin')).arrayBuffer());
    const obs = new Float32Array(await (await fetch('/obs.bin')).arrayBuffer()), mask = new Uint8Array(await (await fetch('/mask.bin')).arrayBuffer());
    const p1 = new SPPolicy(m, w), p2 = new SPPolicy2(m, w), res = {};
    for (const [name, f] of [['infer', (o, k) => p1.forward(o, k)], ['infer2', (o, k) => p2.forward(o, k, { value: false })]]) {
      for (let i = 0; i < 100; i++) f(obs.subarray((i % n) * D, (i % n + 1) * D), mask.subarray((i % n) * A, (i % n + 1) * A));
      const t0 = performance.now();
      for (let i = 0; i < n; i++) f(obs.subarray(i * D, (i + 1) * D), mask.subarray(i * A, (i + 1) * A));
      res[name] = +((performance.now() - t0) / n).toFixed(3);
    }
    return res;
  }, { D, A, n: O.length });
}
await browser.close(); srv.close();
// Node, for reference (same observations)
const { SPPolicy } = await import('./infer.mjs'), { SPPolicy2 } = await import('./infer2.mjs');
const p1 = SPPolicy.load(base), p2 = SPPolicy2.load(base);
for (const [name, f] of [['infer', (o, k) => p1.forward(o, k)], ['infer2', (o, k) => p2.forward(o, k, { value: false })]]) {
  for (let i = 0; i < 100; i++) f(O[i % O.length], M[i % O.length]);
  const t0 = performance.now(); for (let i = 0; i < O.length; i++) f(O[i], M[i]); out.node[name] = +((performance.now() - t0) / O.length).toFixed(3);
}
console.log(JSON.stringify(out));
