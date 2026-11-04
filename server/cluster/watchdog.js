// Main-thread watchdog of a game node (2026-11-04: a match's 维多利亚 payout held game-08's main thread at 100 % for
// 1 h 43 min; the coordinator moved its matches after 15 s (NODE_LOST) but nothing restarted the process). The main
// thread bumps a SharedArrayBuffer counter every beat; a Worker (./watchdog-worker.js) that sees it unchanged for
// `thresholdMs` pauses the main thread through the inspector (session.connectToMainThread), writes ONE JSON line
// `{"event":"watchdog","role":"game","blockedMs":…,"frames":[{fn,at}…]}` straight to fd 1 (the main thread that would
// forward a Worker's console is the one stuck), then SIGKILLs the process: the container's restart policy
// (unless-stopped) brings the node back with a new generation. Combat runs in the CombatWorkerPool, never here, and
// a 30 s silence of the main thread is never a normal state. SP_MAIN_WATCHDOG_MS: 0 = off, else 5 000..600 000.
import { Worker } from 'node:worker_threads';

export const WATCHDOG_DEFAULT_MS = 30_000;
export const WATCHDOG_MIN_MS = 5000, WATCHDOG_MAX_MS = 600_000;

/** The threshold from the environment: unset = WATCHDOG_DEFAULT_MS, '0' = off (0), anything out of bounds = default. */
export function watchdogMs(value = process.env.SP_MAIN_WATCHDOG_MS) {
  if (value === undefined || value === null || String(value).trim() === '') return WATCHDOG_DEFAULT_MS;
  const n = Number(value);
  if (n === 0) return 0;
  return Number.isSafeInteger(n) && n >= WATCHDOG_MIN_MS && n <= WATCHDOG_MAX_MS ? n : WATCHDOG_DEFAULT_MS;
}

/**
 * Start watching this thread. `thresholdMs` below WATCHDOG_MIN_MS is for tests only (≥ 200). @returns {{ stop(): Promise<void> } | null}
 * @param {{ thresholdMs?: number, beatMs?: number, role?: string, captureMs?: number }} [options]
 */
export function startMainWatchdog({ thresholdMs = watchdogMs(), beatMs, role = 'game', captureMs = 5000 } = {}) {
  if (!thresholdMs) return null;
  if (!Number.isSafeInteger(thresholdMs) || thresholdMs < 200 || thresholdMs > WATCHDOG_MAX_MS) throw new RangeError('invalid watchdog threshold');
  const beat = Math.max(50, Math.min(1000, beatMs ?? Math.floor(thresholdMs / 10)));
  const shared = new SharedArrayBuffer(4), counter = new Int32Array(shared);
  const timer = setInterval(() => { Atomics.add(counter, 0, 1); }, beat);
  timer.unref();
  const worker = new Worker(new URL('./watchdog-worker.js', import.meta.url), {
    // named: Hangzhou's main-thread-priority.py counts the unnamed WorkerThreads (the CombatWorkerPool) per game container
    name: 'sp-watchdog',
    // the process's flags but --input-type (refused for a file Worker: ERR_INPUT_TYPE_NOT_ALLOWED)
    execArgv: process.execArgv.filter((a) => !a.startsWith('--input-type')),
    workerData: { shared, thresholdMs, checkMs: beat, role, captureMs, root: new URL('../../', import.meta.url).href } });
  worker.unref();
  // a watchdog that cannot run must not take the node down; say so once
  worker.on('error', (e) => { console.error(`[cluster] watchdog stopped: ${e?.code || e?.message || e}`); });
  let stopped = false;
  return {
    async stop() {
      if (stopped) return; stopped = true;
      clearInterval(timer);
      await worker.terminate();
    },
  };
}
