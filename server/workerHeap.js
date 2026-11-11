// server/workerHeap.js — the V8 young generation of the game's Worker isolates (combat, trial and simulation pools).
//
// V8 sizes a young generation by its allocation rate up to a limit — 192 MiB for a Worker on Node 24 when none is given
// (worker.resourceLimits) — and keeps what it grew to: under a live load every isolate of a game process held far more
// heap than it used. Measured 2026-11-11 (one process, 27 live matches, 3 combat + 1 trial Workers, Node 24, 180 s
// windows): V8's sizing 1010–1044 MiB RSS, the Workers holding 731–739 MiB of heap for 278–297 MiB in use; these
// Workers at 24 MiB 636 MiB (Worker heap 280 MiB); with the main isolate's --max-semi-space-size=8 as well 517 MiB.
// CPU 0.352–0.355 → 0.355–0.374 cores over four runs: more frequent scavenges, about the spread between runs. The main
// isolate takes its limit from the command line (Dockerfile NODE_OPTIONS); a Worker gets it here, however the process
// was started.
//
// SP_WORKER_YOUNG_MB: the young generation of each Worker in MiB, an integer 3–256 (default 24); 0 = V8's own sizing.

export const DEFAULT_WORKER_YOUNG_MB = 24;

/** @param {unknown} [value] SP_WORKER_YOUNG_MB @returns {number} MiB, 0 = V8's own sizing */
export function parseWorkerYoungMb(value = process.env.SP_WORKER_YOUNG_MB) {
  if (value === undefined || value === null || value === '') return DEFAULT_WORKER_YOUNG_MB;
  const n = typeof value === 'number' ? value : /^\d+$/.test(String(value).trim()) ? Number(String(value).trim()) : NaN;
  if (n === 0 || (Number.isInteger(n) && n >= 3 && n <= 256)) return n;
  throw new RangeError('SP_WORKER_YOUNG_MB must be 0 or an integer 3–256');
}

/** The resourceLimits of a game Worker (`{}` for V8's own sizing). @param {number} [mb] */
export function workerResourceLimits(mb = parseWorkerYoungMb()) {
  return mb > 0 ? { maxYoungGenerationSizeMb: mb } : {};
}
