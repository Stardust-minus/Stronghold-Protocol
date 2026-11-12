// infer2.mjs vs infer.mjs on real observations: node tools/rl/parity2.mjs <policy base> [n]
import { performance } from 'node:perf_hooks';
import { SPEnv, randomActions } from './env.mjs';
import { SPPolicy } from './infer.mjs';
import { SPPolicy2 } from './infer2.mjs';
const base = process.argv[2], N = Number(process.argv[3] || 3000);
const p1 = SPPolicy.load(base), p2 = SPPolicy2.load(base);
const env = new SPEnv({ envs: 6, configs: ['coop4:ABYSS', 'solo:HARD', 'coop2:NORMAL', 'solo:ABYSS'], seed: 3500000000, envSeed: 4, humans: 'random' });
const obs = [], masks = [];
let b = env.reset();
while (obs.length < N && b.n) {
  for (let k = 0; k < b.n && obs.length < N; k++) { obs.push(b.obs.slice(k * b.D, (k + 1) * b.D)); masks.push(b.mask.slice(k * b.A, (k + 1) * b.A)); }
  b = env.step(randomActions(b));
}
env.close();
let worst = 0, worstV = 0, argmaxDiff = 0;
for (let i = 0; i < obs.length; i++) {
  const r1 = p1.forward(obs[i], masks[i]), r2 = p2.forward(obs[i], masks[i], { value: true });
  let best1 = 0, best2 = 0;
  for (let a = 0; a < p1.A; a++) {
    if (!masks[i][a]) continue;
    worst = Math.max(worst, Math.abs(r1.logits[a] - r2.logits[a]));
    if (r1.logits[a] > r1.logits[best1] || !masks[i][best1]) best1 = a;
    if (r2.logits[a] > r2.logits[best2] || !masks[i][best2]) best2 = a;
  }
  if (best1 !== best2) argmaxDiff++;
  worstV = Math.max(worstV, Math.abs(r1.value - r2.value));
}
const time = (f) => { for (let i = 0; i < 200; i++) f(obs[i % obs.length], masks[i % obs.length]); const t0 = performance.now(); for (let i = 0; i < obs.length; i++) f(obs[i], masks[i]); return (performance.now() - t0) / obs.length; };
const ms1 = time((o, m) => p1.forward(o, m)), ms2 = time((o, m) => p2.forward(o, m, { value: false })), ms2v = time((o, m) => p2.forward(o, m, { value: true }));
console.log(JSON.stringify({ observations: obs.length, maxAbsLogitDiffLegal: worst, maxAbsValueDiff: worstV, argmaxDisagree: argmaxDiff,
  msPerForward: { infer: +ms1.toFixed(3), infer2: +ms2.toFixed(3), infer2WithValue: +ms2v.toFixed(3) }, speedup: +(ms1 / ms2).toFixed(2) }));
