// Node-only throughput of the RL environment: node tools/rl/bench.mjs [--envs 16] [--seconds 30] [--configs solo:NORMAL]
//   [--rehearsal 0] [--mode policy|teacher]. policy: random legal actions (short matches: random play dies early);
//   teacher: legacy procurement expressed as env actions, i.e. legacy-length matches (its heuristics' CPU included).
//   One JSON line on stdout.
import { performance } from 'node:perf_hooks';
import { SPEnv, randomActions } from './env.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const envs = Number(arg('envs', 16)), seconds = Number(arg('seconds', 30)), seed = Number(arg('seed', 1)), mode = arg('mode', 'policy');
const t0 = performance.now(), c0 = process.cpuUsage();
const env = new SPEnv({ envs, configs: String(arg('configs', 'solo:NORMAL')).split(','), seed, envSeed: seed, rehearsal: Number(arg('rehearsal', 0)),
  mode, until: mode === 'teacher' ? t0 + seconds * 1000 : Infinity, humans: arg('humans', 'random') === 'random' ? 'random' : Number(arg('humans')) });
let steps = 0;
let b = env.reset();
if (mode !== 'teacher') {
  while (performance.now() - t0 < seconds * 1000) { const acts = randomActions(b); steps += b.n; b = env.step(acts); }
} else {
  steps = Object.values(env.stats.teacher.calls).reduce((a, x) => a + x, 0);
}
const dt = (performance.now() - t0) / 1000, cpu = process.cpuUsage(c0);
console.log(JSON.stringify({ mode, envs, seconds: +dt.toFixed(1), decisions: steps, perSec: Math.round(steps / dt), matches: env.stats.matches,
  cpuS: +((cpu.user + cpu.system) / 1e6).toFixed(1), rejected: env.stats.rejected, errors: env.stats.errors, failed: env.stats.failed,
  summary: env.summary() }));
env.close();
