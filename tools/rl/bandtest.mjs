// Band choice in the env (ppo3): random legal band actions; masks, proxy plans, conflicts, fallbacks, errors.
import { SPEnv, randomActions } from './env.mjs';
import { KIND } from './spec.mjs';
const env = new SPEnv({ envs: 4, configs: ['coop4:HARD', 'coop4:ABYSS', 'solo:HARD', 'coop2:NORMAL'], seed: 3700000000, envSeed: 3, maxMatches: 16,
  humans: 'random', legacyMates: 0.3, bandPolicy: { share: 1, planProb: 0.5 }, check: true, metrics: true });
let b = env.reset(), bandRows = 0;
const legal = [];
while (b.n) {
  for (let k = 0; k < b.n; k++) if (b.kinds[k] === KIND.band) { bandRows++; let c = 0; for (let a = 0; a < b.A; a++) c += b.mask[k * b.A + a]; legal.push(c); }
  b = env.step(randomActions(b));
}
console.log(JSON.stringify({ matches: env.stats.matches, bandDecisions: bandRows, legalPerBandDecision: { min: Math.min(...legal), max: Math.max(...legal), mean: +(legal.reduce((x, y) => x + y, 0) / legal.length).toFixed(1) },
  bandStats: env.bandStats, errors: env.stats.errors, rejected: env.stats.rejected, failed: env.stats.failed, violations: env.stats.violations, samples: env.errorSamples.slice(0, 3) }));
