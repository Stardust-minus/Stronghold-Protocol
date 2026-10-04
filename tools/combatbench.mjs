#!/usr/bin/env node
// Local-only saturation benchmark: identical heavy phases, IPC, live snapshots and JSON encoding. Not a capacity claim.
// node tools/combatbench.mjs --workers=0 --sessions=24 --ticks=600 --batch=6
import assert from 'node:assert/strict';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setImmediate as yieldLoop, setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { getData } from '../server/data.js';
import { DataSource, spawnsFromTemplate } from '../server/sim/simdata.js';
import { buildBattleSpec, createBattleFromSpec } from '../server/sim/spec.js';
import { FieldRunner, snapFrame } from '../server/match/fields.js';
import { CombatWorkerPool } from '../server/match/combat/pool.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--(workers|sessions|ticks|batch)=(\d+)$/.exec(a);
  if (!m) throw new Error(`unknown argument: ${a}`);
  return [m[1], Number(m[2])];
}));
const workers = args.workers ?? 0, sessions = args.sessions ?? 24, ticks = args.ticks ?? 600, batch = args.batch ?? 6;
assert.ok(workers >= 0 && workers <= 32 && sessions > 0 && sessions <= 256 && ticks > 0 && ticks <= 1200 && batch > 0 && batch <= 1024);
const log = { info() {}, warn() {}, error: (...a) => console.error(...a) };
const data = getData({ log });
const ds = new DataSource(data);
const { routes } = spawnsFromTemplate(ds.getWave('act1autochess_h05'));
const keys = ['enemy_1422_lrsldr', 'enemy_1427_lrnazg', 'enemy_1005_yokai', 'enemy_1042_frostd', 'enemy_1425_lrcmra', 'enemy_1040_bombd'];
const lineup = [
  ['chess_char_1_02_a', 9, 7], ['chess_char_2_09_a', 9, 4], ['chess_char_4_09_a', 12, 5], ['chess_char_3_08_a', 12, 7],
  ['chess_char_1_01_a', 10, 4], ['chess_char_1_03_a', 11, 4], ['chess_char_2_02_a', 12, 4], ['chess_char_2_14_a', 10, 5],
  ['chess_char_5_12_a', 11, 5], ['chess_char_6_13_a', 9, 8],
];
function input(seed) {
  return { wireFrames: true, specs: [buildBattleSpec({
    seed, fieldId: 'n:p', kind: 'normal', stageId: 'act2autochess_m01', timeLimit: 60, routes,
    spawns: Array.from({ length: 70 }, (_, i) => ({ time: i % 10 * 0.2, enemyKey: keys[i % keys.length], routeIndex: i % routes.length, mods: { hpMul: 10 } })),
    players: [{ playerId: 'p', units: lineup.map(([chessId, row, col], i) => ({ uid: i + 1, kind: 'chess', chessId, row, col, abs: true })) }],
  })] };
}
let bytes = 0, frames = 0, actualTicks = 0;
const encode = (msg) => { bytes += Buffer.byteLength(JSON.stringify(msg)); if (msg.t === 'b.snap') frames++; };
// The zero-worker baseline is the ORIGINAL runner, not an inline Engine with unnecessary IPC DTO cloning.
function inline(input) {
  const fields = input.specs.map((spec) => ({ fieldId: spec.fieldId, kind: spec.kind,
    players: spec.players.map((p) => p.playerId), battle: createBattleFromSpec(spec, ds, { logger: log }) }));
  const m = { watchersOf: () => ['p'], sendTo: (_, msg) => encode(msg), markPublic() {}, reportError: (...a) => log.error(...a) };
  const runner = new FieldRunner(m, fields, { onDone() {} });
  return {
    advance(count) {
      for (let i = 0; i < count && !runner.done; i++) { runner._tick(); runner._checkDone(); }
      return { ticks: runner.ticks, frames: [] };
    },
    forceAll(reason) { runner.forceAll(reason); return { fields: fields.map((f) => ({ result: runner.resultOf(f) })) }; },
    dispose() { runner.stop(); },
  };
}
let pool;
const engines = [];
try {
  if (workers) { pool = new CombatWorkerPool({ size: workers, data, log }); await pool.start(); }
  // One warm-up phase per thread, excluded from measurements.
  const warm = Array.from({ length: workers || 1 }, (_, i) => pool ? pool.create(input(100 + i)) : inline(input(100 + i)));
  if (pool) await Promise.all(warm.map((h) => h.ready));
  await Promise.all(warm.map(async (e) => {
    for (let n = 0; n < 300; n += 30) {
      if (pool) await e.request('advance', { ticks: 30, snapshotFields: ['n:p'] });
      else e.advance(30, { snapshotFields: ['n:p'] });
    }
    if (pool) e.close(); else e.dispose();
  }));
  for (let i = 0; i < sessions; i++) engines.push(pool ? pool.create(input(1000 + i)) : inline(input(1000 + i)));
  if (pool) await Promise.all(engines.map((e) => e.ready));
  bytes = 0; frames = 0; actualTicks = 0;
  const consume = (out) => {
    for (const frame of out.frames) {
      if (frame.snapshotWire) {
        bytes += Buffer.byteLength(frame.snapshotWire) + (frame.eventsWire ? Buffer.byteLength(frame.eventsWire) : 0);
        frames++;
      } else {
        if (frame.events.length) encode({ t: 'b.ev', fieldId: frame.fieldId, gt: frame.snapshot.t, ev: frame.events });
        encode(snapFrame(frame.fieldId, frame.snapshot));
      }
    }
  };
  const histogram = monitorEventLoopDelay({ resolution: 5 });
  histogram.enable();
  await delay(20);
  const cpu0 = process.cpuUsage(), thread0 = process.threadCpuUsage?.();
  const t0 = performance.now();
  for (let n = 0; n < ticks; n += batch) {
    const count = Math.min(batch, ticks - n);
    if (pool) {
      const outputs = await Promise.all(engines.map((e) => e.request('advance', { ticks: count, snapshotFields: ['n:p'] })));
      outputs.forEach(consume);
      actualTicks = outputs.reduce((total, out) => total + out.ticks, 0);
    } else {
      actualTicks = 0;
      for (const e of engines) { const out = e.advance(count, { snapshotFields: ['n:p'] }); consume(out); actualTicks += out.ticks; }
    }
    await yieldLoop();
  }
  const elapsedMs = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0), thread = thread0 && process.threadCpuUsage(thread0);
  await delay(20);
  histogram.disable();
  const final = pool ? await Promise.all(engines.map((e) => e.request('forceAll', { reason: 'forced' }))) : engines.map((e) => e.forceAll('forced'));
  const resultHash = createHash('sha256').update(JSON.stringify(final.map((out) => out.fields.map((f) => f.result)))).digest('hex');
  console.log(JSON.stringify({
    workers, sessions, ticks, batch, actualTicks, frames, encodedMiB: bytes / 2 ** 20, elapsedMs,
    ticksPerSecond: actualTicks / elapsedMs * 1000, cpuMs: (cpu.user + cpu.system) / 1000,
    mainThreadCpuMs: thread ? (thread.user + thread.system) / 1000 : null,
    eventLoopP95Ms: histogram.percentile(95) / 1e6, eventLoopMaxMs: histogram.max / 1e6,
    rssMiB: process.memoryUsage().rss / 2 ** 20, resultHash,
  }));
} finally {
  for (const e of engines) { if (pool) e.close(); else e.dispose(); }
  await pool?.close();
}
