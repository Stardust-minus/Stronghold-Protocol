// CPU cost per round (ppo3 cost model): node tools/rl/timing.mjs [--matches 24] [--mode teacher] [--boss-rehearsal 3]
// Teacher mode = legacy procurement for the policy seats (the policy's games are BC-initialised from it). Prints ms per
// round: prep callbacks (procurement + placement + rehearsal), of which rehearsal simulation, battle simulation, teacher
// procurement, encoding; and decisions per round.
import { performance } from 'node:perf_hooks';
import { SPEnv } from './env.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const cfg = String(arg('configs', 'solo:ABYSS,coop2:ABYSS,coop4:ABYSS,solo:HARD,coop4:HARD,coop4:NORMAL')).split(',');
const br = arg('boss-rehearsal', null);
const t0 = performance.now();
const env = new SPEnv({ envs: 4, configs: cfg, seed: Number(arg('seed', 3000000000)), envSeed: 11, maxMatches: Number(arg('matches', 24)),
  mode: arg('mode', 'teacher'), enforce: true, humans: 'random', legacyMates: 0.3, rehearsal: Number(arg('rehearsal', 0)),
  ...(br !== null ? { bossRehearsal: Number(br) } : {}), timing: true });
env.reset();
const T = env.timing, rows = Object.keys(T).map(Number).sort((a, b) => a - b);
let tot = { prep: 0, battle: 0, other: 0, teach: 0, encode: 0, decisions: 0, rehSim: 0, battleSim: 0 };
console.log('round  prep_ms  rehSim  battle_ms battleSim teach_ms encode decisions  ms/decision(excl. teacher procurement)');
for (const r of rows) {
  const t = { rehSim: 0, battleSim: 0, ...T[r] };
  for (const k of Object.keys(tot)) tot[k] += t[k] || 0;
  const work = t.prep + t.battle + t.other + t.encode - t.teach;
  console.log(String(r).padStart(5), ...[t.prep, t.rehSim, t.battle, t.battleSim, t.teach, t.encode].map((x) => x.toFixed(0).padStart(9)),
    String(t.decisions).padStart(9), (work / Math.max(1, t.decisions)).toFixed(2).padStart(9));
}
const wall = performance.now() - t0;
console.log(JSON.stringify({ matches: env.stats.matches, wallMs: Math.round(wall), totals: Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, Math.round(v)])), errors: env.stats.errors }));
