// MACs per decision actually executed by infer2.mjs (absent rows and masked actions skipped) vs infer.mjs (all rows):
//   node tools/rl/maccount.mjs <policy base> [n]
import { readFileSync } from 'node:fs';
import { SPEnv, randomActions } from './env.mjs';
const base = process.argv[2], N = Number(process.argv[3] || 1500);
const m = JSON.parse(readFileSync(`${base}.json`, 'utf8')), T = m.tensors, sh = (n) => T[n].shape;
const env = new SPEnv({ envs: 6, configs: ['coop4:ABYSS', 'solo:HARD', 'coop2:NORMAL', 'solo:ABYSS'], seed: 3600000000, envSeed: 4, humans: 'random' });
let b = env.reset(), n = 0, mac1 = 0, mac2 = 0;
const lin = (p) => { const [o, i] = sh(`${p}.weight`); return o * i; };
while (n < N && b.n) {
  for (let k = 0; k < b.n && n < N; k++, n++) {
    const obs = b.obs.subarray(k * b.D, (k + 1) * b.D), mask = b.mask.subarray(k * b.A, (k + 1) * b.A);
    let a1 = 0, a2 = 0; const present = {};
    for (const [name, L] of Object.entries(m.layout)) {
      const per = lin(`enc.${name}.0`) + lin(`enc.${name}.2`);
      const [h0] = sh(`enc.${name}.0.weight`), num = L.numeric.length;
      const per2 = h0 * num + h0 * L.ids.length + lin(`enc.${name}.2`); // folded embedding tables: one add per id field
      let p = 0; for (let r = 0; r < L.count; r++) if (obs[L.offset + r * L.width] > 0.5 || name === 'global') p++;
      present[name] = p; a1 += L.count * per; a2 += p * per2;
    }
    const common = lin('bonds.0') + lin('bonds.2') + lin('trunk.0') + lin('trunk.2');
    a1 += common + lin('scalar') + lin('value.0') + lin('value.2'); a2 += common;
    let kk = sh('scalar.weight')[0];
    for (let a = 0; a < kk; a++) if (mask[a]) a2 += sh('scalar.weight')[1];
    for (const name of m.pointer) {
      const [h, inn] = sh(`ptr.${name}.0.weight`), C = sh('trunk.2.weight')[0], o = inn - C, cnt = m.layout[name].count;
      a1 += cnt * (lin(`ptr.${name}.0`) + lin(`ptr.${name}.2`));
      let legal = 0; for (let r = 0; r < cnt; r++) if (mask[kk + r]) legal++;
      if (legal) a2 += h * C + legal * (h * o + h);
      kk += cnt;
    }
    mac1 += a1; mac2 += a2;
  }
  b = env.step(randomActions(b));
}
env.close();
console.log(JSON.stringify({ decisions: n, macPerDecision: { infer: Math.round(mac1 / n), infer2: Math.round(mac2 / n) } }));
