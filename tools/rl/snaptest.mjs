// S1 determinism: checkpoints of teacher games restored into fresh matches must finish exactly like the originals.
//   node tools/rl/snaptest.mjs [--matches 6]
import { performance } from 'node:perf_hooks';
import { SPEnv } from './env.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const base = { envs: 3, configs: ['solo:ABYSS', 'coop4:ABYSS'], seed: 3100000000, envSeed: 5, mode: 'teacher', enforce: true, humans: 'random',
  legacyMates: 0.3, rehearsal: 0, bossRehearsal: 3, check: true, timing: true };
const t0 = performance.now();
const A = new SPEnv({ ...base, maxMatches: Number(arg('matches', 6)), snapCollect: { rounds: [9, 11, 13], prob: 1, configs: ['ABYSS'], cap: 1000 } });
A.reset();
const tA = performance.now() - t0;
const queue = [...A.snaps.values()].flat();
const key = (r) => r.seats.map((s) => `${s.playerId}:${s.survivalRound}/${s.lp}/${s.win}`).join(',') + `|fa ${r.faShare.toFixed(6)}`;
const orig = new Map(A.results.map((r) => [r.seed, key(r)]));
const t1 = performance.now();
const B = new SPEnv({ ...base, maxMatches: queue.length, snapQueue: queue });
B.reset();
const tB = performance.now() - t1;
let same = 0;
for (const r of B.results) {
  const ok = orig.get(r.seed) === key(r);
  same += ok ? 1 : 0;
  if (!ok) console.log('DIFF seed', r.seed, 'from R' + r.fromSnapshot, '\n  orig', orig.get(r.seed), '\n  rest', key(r));
}
const dec = (e) => Object.values(e.timing).reduce((n, t) => n + t.decisions, 0);
const cpu = (e) => Object.values(e.timing).reduce((n, t) => n + t.prep + t.battle + t.other + t.encode - t.teach, 0);
console.log(JSON.stringify({ originals: A.results.length, snapshots: queue.length, byRound: queue.reduce((o, q) => ({ ...o, [q.round]: (o[q.round] || 0) + 1 }), {}),
  restored: B.results.length, identical: same, restoreFailed: B.snapStats.restoreFailed, refused: A.snapStats.refused,
  errors: [A.stats.errors, B.stats.errors], violations: [A.stats.violations, B.stats.violations], failed: [A.stats.failed, B.stats.failed],
  msPerDecisionExclTeacherProcurement: { full: +(cpu(A) / dec(A)).toFixed(2), fromSnapshots: +(cpu(B) / dec(B)).toFixed(2) },
  wall: { A: Math.round(tA), B: Math.round(tB) } }));
for (const e of [...A.errorSamples, ...B.errorSamples].slice(0, 6)) console.log('!', e);
