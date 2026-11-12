// tools/rl/server.mjs — the RL environment behind a binary stdin/stdout protocol (plan §8; Python: tools/rl/py/spenv.py).
// Frame (both directions): u32 LE length of the rest, u8 type, payload. Stdout carries frames only.
//   1 INIT  json options (SPEnv constructor)          → 1 HELLO json spec
//   2 RESET                                            → 3 BATCH
//   4 ACT   int32[n], one action per row of the last BATCH → 3 BATCH
//   6 CONFIG json { configs }  (curriculum weights)    → 7 OK
//   8 STATS                                            → 9 json { stats, summary, errors }
//   12 DESCRIBE                                        → 13 json (env.describe(): readable states, replay viewer)
//   5 CLOSE                                            (exit)
// BATCH: int32[8] { n, nTerm, D, A, matches, errors + failed matches, rejected actions, invariant violations },
//   int32 ids[n], int32 kinds[n], f32 reward[n], f32 obs[n·D], u8 mask[n·A] (padded to 4), int32 termTraj[nTerm],
//   f32 termReward[nTerm], f32 termInfo[nTerm·7] (win, round, lp, config, Final Assault team share, the trajectory's
//   round-term total, its LP-term total, its bond-shaping total, its match seed − the INIT seed (exact below 2^24))
import { SPEnv } from './env.mjs';

let env = null, pending = Buffer.alloc(0);
const out = (type, payload = Buffer.alloc(0)) => {
  const head = Buffer.alloc(5); head.writeUInt32LE(payload.length + 1, 0); head.writeUInt8(type, 4);
  process.stdout.write(Buffer.concat([head, payload]));
};
const pad4 = (n) => (n + 3) & ~3;
function batchFrame(b) {
  const { n, D, A, terms } = b, t = terms.length;
  const size = 32 + 12 * n + 4 * n * D + pad4(n * A) + 44 * t;
  const buf = Buffer.alloc(size);
  let o = 0;
  const i32 = (v) => { buf.writeInt32LE(v, o); o += 4; };
  const st = env.stats;
  i32(n); i32(t); i32(D); i32(A); i32(st.matches); i32(st.errors + st.failed); i32(st.rejected); i32(st.violations);
  const copy = (arr, bytes) => { Buffer.from(arr.buffer, arr.byteOffset, bytes).copy(buf, o); o += bytes; };
  copy(b.ids, 4 * n); copy(b.kinds, 4 * n); copy(b.rew, 4 * n); copy(b.obs, 4 * n * D);
  copy(b.mask, n * A); o = pad4(o);
  for (const x of terms) i32(x.traj);
  for (const x of terms) { buf.writeFloatLE(x.reward, o); o += 4; }
  for (const x of terms) for (const v of [x.win, x.round, x.lp, x.config, x.faShare || 0, x.rRound || 0, x.rLp || 0, x.shape || 0, x.seedOffset || 0]) { buf.writeFloatLE(v, o); o += 4; }
  return buf;
}
function handle(type, payload) {
  if (type === 1) { env = new SPEnv(JSON.parse(payload.toString('utf8') || '{}')); out(1, Buffer.from(JSON.stringify(env.spec()))); return; }
  if (type === 2) { out(3, batchFrame(env.reset())); return; }
  if (type === 4) {
    const acts = new Int32Array(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.length));
    out(3, batchFrame(env.step(acts))); return;
  }
  if (type === 6) {
    const msg = JSON.parse(payload.toString('utf8'));
    if (msg.configs) env.setConfigs(msg.configs);
    if (Array.isArray(msg.seeds)) env.seedQueue.push(...msg.seeds.filter(Number.isInteger)); // S3: replayed levels
    out(7); return;
  }
  if (type === 8) {
    out(9, Buffer.from(JSON.stringify({ stats: env.stats, summary: env.summary(), yield: env.yieldSummary(), results: env.results, errors: env.errorSamples,
      snap: env.snapStats, snapPool: Object.fromEntries([...env.snaps].map(([k, v]) => [k, v.length])) })));
    return;
  }
  if (type === 12) { out(13, Buffer.from(JSON.stringify(env.describe()))); return; }
  if (type === 5) { env?.close(); process.exit(0); }
  throw new Error(`unknown frame type ${type}`);
}
process.stdin.on('data', (chunk) => {
  pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
  while (pending.length >= 5) { // loop-cap: received frames
    const len = pending.readUInt32LE(0);
    if (pending.length < 4 + len) break;
    const type = pending.readUInt8(4), payload = pending.subarray(5, 4 + len);
    pending = pending.subarray(4 + len);
    handle(type, payload);
  }
});
process.stdin.on('end', () => process.exit(0));
