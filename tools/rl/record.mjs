// Behaviour-cloning data (plan §8.9 / B2): legacy procurement with the AI-seat rules enforced (a forbidden call fails and
// legacy moves on; refused calls are never recorded), every executed call stored as the env action it equals.
//   node tools/rl/record.mjs --out data --tag s1 --matches 400 --seed 100000 [--envs 8]
//     [--configs solo:NORMAL,...] [--humans random] [--rehearsal 0]
// Writes <out>/<dataId>/<tag>.bin (fixed records), <tag>.terms.jsonl (trajectory ends) and <tag>.meta.json.
// Record: f16 obs[D] · u8 mask bits[ceil(A/8)] · u8 action · u8 kind · u16 0 · u32 traj · f32 reward (since the
// trajectory's previous record: it belongs to the previous transition) — little endian, no padding beyond that.
import { openSync, writeSync, closeSync, mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { SPEnv } from './env.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const out = arg('out', 'data'), tag = arg('tag', 'shard'), matches = Number(arg('matches', 100));
const seed = Number(arg('seed', 1)), envs = Number(arg('envs', 8)), humansArg = arg('humans', 'random');
const configs = String(arg('configs', 'solo:NORMAL,solo:HARD,solo:ABYSS,coop2:NORMAL,coop2:HARD,coop3:HARD,coop4:NORMAL,coop4:HARD,coop4:ABYSS')).split(',');
const t0 = performance.now();
let fd = null, D = 0, A = 0, MB = 0, REC = 0, buf = null, used = 0, samples = 0, terms = 0;
const termLines = [];
const CHUNK = 2048;
const flush = () => { if (used) { writeSync(fd, buf, 0, used * REC); used = 0; } };
const recorder = {
  sample(kind, traj, obs, mask, action, reward) {
    let o = used * REC;
    // eslint-disable-next-line no-undef -- Node 24 global, not yet in the lint globals
    const f16 = new Float16Array(buf.buffer, buf.byteOffset + o, D); // records start 2-aligned (REC is even)
    f16.set(obs); o += 2 * D;
    for (let b = 0; b < MB; b++) { let v = 0; for (let k = 0; k < 8; k++) { const a = b * 8 + k; if (a < A && mask[a]) v |= 1 << k; } buf[o + b] = v; }
    o += MB;
    buf[o] = action; buf[o + 1] = kind; buf.writeUInt16LE(0, o + 2); buf.writeUInt32LE(traj >>> 0, o + 4); buf.writeFloatLE(reward, o + 8);
    used++; samples++;
    if (used === CHUNK) flush();
  },
  term(t) { terms++; termLines.push(JSON.stringify(t)); },
};
const env = new SPEnv({ envs, configs, seed, envSeed: seed, maxMatches: matches, mode: 'teacher', enforce: true, recorder,
  humans: humansArg === 'random' ? 'random' : Number(humansArg), legacyMates: Number(arg('mates', 0)), rehearsal: Number(arg('rehearsal', 0)) });
// the encoder exists once the first matches are open; set the layout before any sample (samples start in collect())
const spec = env.spec();
D = spec.dim; A = spec.actions; MB = Math.ceil(A / 8); REC = 2 * D + MB + 12;
if (REC % 2) throw new Error('record size must stay even (f16 alignment)');
buf = Buffer.alloc(REC * CHUNK);
const dir = `${out}/${spec.dataId}`;
mkdirSync(dir, { recursive: true });
fd = openSync(`${dir}/${tag}.bin`, 'w');
env.reset();
flush(); closeSync(fd);
writeFileSync(`${dir}/${tag}.terms.jsonl`, termLines.join('\n') + '\n');
const meta = { tag, dataId: spec.dataId, D, A, maskBytes: MB, recordBytes: REC, samples, terms, matches: env.stats.matches, configs: spec.configs,
  seed, envs, seconds: +((performance.now() - t0) / 1000).toFixed(1), errors: env.stats.errors, failed: env.stats.failed,
  teacher: env.stats.teacher, summary: env.summary(), spec };
writeFileSync(`${dir}/${tag}.meta.json`, JSON.stringify(meta));
console.log(JSON.stringify({ tag, samples, terms, matches: meta.matches, seconds: meta.seconds, errors: meta.errors, failed: meta.failed, bytes: samples * REC }));
