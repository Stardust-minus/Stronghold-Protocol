// Smoke tests of the RL environment (plan §8):
//   node tools/rl/smoke.mjs [--matches N] [--configs solo:NORMAL,coop4:NORMAL] [--seed S] [--only random|teacher]
// 1. random legal actions for N whole matches per config: no error, no stuck match, collectViolations empty;
// 2. the legacy teacher (legacy procurement expressed as env actions) against plain legacy on the same seeds.
import { performance } from 'node:perf_hooks';
import { SPEnv, randomActions } from './env.mjs';
import { actionName } from './spec.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const N = Number(arg('matches', 4)), seed = Number(arg('seed', 1)), only = arg('only', ''), mates = Number(arg('mates', 0)), humansArg = arg('humans', '0'), humans = humansArg === 'random' ? 'random' : Number(humansArg);
const configs = String(arg('configs', 'solo:NORMAL,coop4:NORMAL')).split(',');
let a = 0x9e3779b9; const rng = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const report = (label, env, t0) => {
  const s = env.stats;
  console.log(`${label}: matches ${s.matches}, decisions ${s.decisions}, rejected ${s.rejected}, forcedEnd ${s.forcedEnd}, errors ${s.errors}, failed ${s.failed}, violations ${s.violations}, 让合成 scout check ${s.scoutMismatch}/${s.scoutChecks} mismatches, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  for (const r of env.summary()) console.log('   ', JSON.stringify(r));
  const y = env.yieldSummary(); if (Object.keys(y).length) console.log('    让盟约 buys', JSON.stringify(y));
  for (const e of env.errorSamples.slice(0, 8)) console.log('    !', e);
};

for (const cfg of configs) {
  if (only !== 'teacher') {
    const t0 = performance.now();
    const env = new SPEnv({ envs: Math.min(4, N), configs: [cfg], seed, check: true, maxMatches: N, legacyMates: mates, humans, metrics: true, scoutCheck: true });
    const hist = new Map();
    let b = env.reset();
    while (b.n > 0) { const acts = randomActions(b, rng); for (const x of acts.subarray(0, b.n)) { const k = actionName(x).replace(/\d+$/, ''); hist.set(k, (hist.get(k) || 0) + 1); } b = env.step(acts); }
    report(`random ${cfg}`, env, t0);
    console.log('    actions', JSON.stringify(Object.fromEntries(hist)));
  }
  if (only !== 'random') {
    const base = {};
    for (const mode of ['legacy', 'teacher']) {
      const t0 = performance.now();
      const env = new SPEnv({ envs: Math.min(4, N), configs: [cfg], seed, check: true, maxMatches: N, mode, humans, metrics: true, scoutCheck: true });
      env.reset();
      report(`${mode} ${cfg}`, env, t0);
      base[mode] = env.results.map((r) => `${r.seed}:${r.seats.map((s) => `${s.survivalRound}/${s.lp}/${s.win}`).join(',')}`).sort();
      if (mode === 'teacher') {
        const T = env.stats.teacher;
        console.log('    teacher calls', JSON.stringify(T.calls), 'illegal', JSON.stringify(T.illegal), 'unrepresented', JSON.stringify(T.unrepresented), 'overCap', T.overCap, 'preps', T.preps, 'blocked', JSON.stringify(T.blocked));
      }
    }
    const same = base.legacy.filter((x, i) => x === base.teacher[i]).length;
    console.log(`    teacher == legacy (survival/LP/win per seat): ${same}/${base.legacy.length} matches`);
    if (same < base.legacy.length) console.log('    legacy', base.legacy.slice(0, 4).join(' '), '\n    teacher', base.teacher.slice(0, 4).join(' '));
  }
}
