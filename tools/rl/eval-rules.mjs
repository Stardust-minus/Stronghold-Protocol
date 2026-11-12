// The AI-seat rules of 2026-11-11 (plan §8.3), rule by rule: node tools/rl/eval-rules.mjs [--matches 10] [--seed 601]
//   [--configs coop4:NORMAL,coop4:HARD] [--humans 1]. Same seeds and seat roles for every variant (round trips: a
//   watched number, no rule):
//   legacy                      plain legacy AI seats (today's behaviour): how often each rule would be broken
//   enforce:<rules>             legacy procurement with the listed rules enforced (a forbidden call fails, legacy moves on)
//   random:<rules>              random legal policy: the rules hold exactly (its counts must be 0)
//   random:pool-*               card-pool settings: independent pools (yieldMain / yieldMerge off) and a pool plan
// Prints per variant: AI-seat rule counts per match, human survival / main-bond tier, team win rate.
import { performance } from 'node:perf_hooks';
import { SPEnv, randomActions } from './env.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const N = Number(arg('matches', 10)), seed = Number(arg('seed', 601)), humans = Number(arg('humans', 1));
const configs = String(arg('configs', 'coop4:NORMAL,coop4:HARD')).split(',');
const OFF = { yieldMain: false, yieldMerge: false };
const only = (k) => ({ ...OFF, [k]: true });
const variants = [
  ['legacy', { mode: 'legacy' }],
  ['enforce:all', { mode: 'teacher', enforce: true }],
  ['enforce:yieldMain', { mode: 'teacher', enforce: true, rules: only('yieldMain') }],
  ['enforce:yieldMerge', { mode: 'teacher', enforce: true, rules: only('yieldMerge') }],
  ['enforce:pool-independent', { mode: 'teacher', enforce: true, experimental: { disableSharedPool: true } }],
  ['enforce:pool-plan-0011', { mode: 'teacher', enforce: true, experimental: { poolPlan: [0, 0, 1, 1] } }],
  ['random:all', { mode: 'policy' }],
  ['random:none', { mode: 'policy', rules: OFF }],
  ['random:pool-independent', { mode: 'policy', experimental: { disableSharedPool: true } }],
  ['random:pool-plan-0011', { mode: 'policy', experimental: { poolPlan: [0, 0, 1, 1] } }],
];
let a = 0x2545F491; const rng = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = arg('variants', '');
for (const cfg of configs) {
  for (const [name, o] of variants) {
    if (pick && !pick.split(',').includes(name)) continue;
    const t0 = performance.now();
    const env = new SPEnv({ envs: Math.min(4, N), configs: [cfg], seed, envSeed: seed, check: true, maxMatches: N, humans, metrics: true, ...o });
    let b = env.reset();
    while (b.n > 0) b = env.step(randomActions(b, rng));
    const y = env.yieldSummary(), rows = env.summary();
    const team = env.results.length ? env.results.filter((r) => r.seats.some((s) => s.win)).length / env.results.length : 0;
    const human = rows.find((r) => r.key.endsWith(':human-legacy')) || {};
    const ai = Object.fromEntries(Object.entries(y).map(([role, x]) => [role, `buys ${(x.buys / x.matches).toFixed(1)} main ${x.yieldMainPerMatch} merge ${x.yieldMergePerMatch} roundTrips/prep ${x.roundTripsPerPrep}`]));
    console.log(`${cfg} ${name.padEnd(24)} team win ${team.toFixed(2)} | human survival ${human.survival ?? '-'} mainTier ${human.humanMainTier ?? '-'} | AI/match ${JSON.stringify(ai)}`
      + ` | errors ${env.stats.errors} failed ${env.stats.failed} violations ${env.stats.violations} ${((performance.now() - t0) / 1000).toFixed(0)}s`);
    if (o.mode === 'teacher') console.log(`    legacy calls outside the mask: ${JSON.stringify(env.stats.teacher.blocked)}`);
    if (process.argv.includes('--json')) {
      const hs = env.results.flatMap((r) => r.seats.filter((x) => x.role === 'human-legacy'));
      console.log('JSON ' + JSON.stringify({ cfg, name, matches: env.results.length, teamWins: env.results.filter((r) => r.seats.some((x) => x.win)).length,
        humanSeats: hs.length, humanSurvival: hs.reduce((n, x) => n + x.survivalRound, 0), humanTier: hs.reduce((n, x) => n + (x.mainTier || 0), 0),
        ai: y, errors: env.stats.errors, failed: env.stats.failed, violations: env.stats.violations }));
    }
    for (const e of env.errorSamples.slice(0, 3)) console.log('    !', e);
  }
}
