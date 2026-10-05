// Read-only /healthz performance cache. One collector per listening server; no Worker RPC.
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const SAMPLE_MS = 10_000;
const RESOLUTION_MS = 20;
const nonnegative = (n) => Number.isFinite(n) && n >= 0 ? n : null;
const delta = (current, previous) => nonnegative(current) !== null && nonnegative(previous) !== null
  ? nonnegative(current - previous) : null;

function emptySnapshot(status) {
  return {
    status, sampledAt: null, windowMs: null,
    mainThread: {
      eventLoopDelayMs: { p50: null, p95: null, p99: null, max: null },
      eventLoopUtilization: null,
      memory: { heapUsedBytes: null, heapTotalBytes: null, externalBytes: null, arrayBuffersBytes: null },
    },
    process: { cpu: { userMs: null, systemMs: null, totalMs: null, percent: null }, rssBytes: null },
  };
}

export const PERFORMANCE_UNAVAILABLE = emptySnapshot('unavailable');

/** A cached main-thread pressure hint, not total machine CPU or Worker capacity. */
export function serverLoadState(snapshot, now = Date.now()) {
  const elu = snapshot?.mainThread?.eventLoopUtilization;
  const p95 = snapshot?.mainThread?.eventLoopDelayMs?.p95;
  const at = snapshot?.sampledAt;
  if (snapshot?.status !== 'ready' || !Number.isFinite(snapshot.windowMs) || snapshot.windowMs <= 0
      || !Number.isFinite(at) || !Number.isFinite(now) || now < at || now - at > SAMPLE_MS * 3
      || !Number.isFinite(elu) || elu < 0 || elu > 1 || !Number.isFinite(p95) || p95 < 0) return 'unknown';
  if (p95 >= 100 || (elu >= .95 && p95 >= 50)) return 'overloaded';
  if (elu >= .85 || p95 >= 40) return 'busy';
  return 'normal';
}

/** Injectable built-in readers/timers keep window and lifecycle tests deterministic. */
export function createHealthMetrics({
  log = console,
  now = () => performance.now(), wallNow = () => Date.now(),
  cpuUsage = () => process.cpuUsage(), memoryUsage = () => process.memoryUsage(),
  eventLoopUtilization = () => performance.eventLoopUtilization(),
  createHistogram = monitorEventLoopDelay,
  setInterval: schedule = globalThis.setInterval, clearInterval: unschedule = globalThis.clearInterval,
} = {}) {
  let cached = emptySnapshot('warming');
  let histogram = null, timer = null, baseline = null;
  let started = false, disposed = false, warned = false;

  function warn(error) {
    if (warned) return;
    warned = true;
    // A broken diagnostic reader/logger must never prevent the game from serving or closing.
    try { log.warn?.(`[health] performance metrics unavailable: ${error.message}`); } catch { /* diagnostic only */ }
  }

  function stopResources() {
    if (timer !== null) {
      const old = timer; timer = null;
      try { unschedule(old); } catch (e) { warn(e); }
    }
    if (histogram !== null) {
      const old = histogram; histogram = null;
      try { old.disable(); } catch (e) { warn(e); }
    }
  }

  function unavailable(error) {
    stopResources();
    cached = emptySnapshot('unavailable');
    warn(error);
  }

  function sample() {
    if (disposed || !histogram) return;
    try {
      const current = { at: now(), cpu: cpuUsage(), elu: eventLoopUtilization() };
      const elapsed = delta(current.at, baseline.at);
      const windowMs = elapsed > 0 ? elapsed : null;
      const next = emptySnapshot(windowMs === null ? 'warming' : 'ready');
      if (windowMs !== null) {
        const memory = memoryUsage();
        next.sampledAt = nonnegative(wallNow()); // Unix epoch ms, independent of the monotonic window.
        next.windowMs = windowMs;
        next.process.rssBytes = nonnegative(memory.rss);
        next.mainThread.memory = {
          heapUsedBytes: nonnegative(memory.heapUsed), heapTotalBytes: nonnegative(memory.heapTotal),
          externalBytes: nonnegative(memory.external), arrayBuffersBytes: nonnegative(memory.arrayBuffers),
        };
        const user = delta(current.cpu.user, baseline.cpu.user), system = delta(current.cpu.system, baseline.cpu.system);
        const userMs = user === null ? null : user / 1000;
        const systemMs = system === null ? null : system / 1000;
        const totalMs = userMs !== null && systemMs !== null ? nonnegative(userMs + systemMs) : null;
        next.process.cpu = {
          userMs, systemMs, totalMs,
          percent: totalMs === null ? null : nonnegative(totalMs / windowMs * 100),
        };
        const active = delta(current.elu.active, baseline.elu.active);
        const idle = delta(current.elu.idle, baseline.elu.idle);
        const total = active !== null && idle !== null ? nonnegative(active + idle) : null;
        next.mainThread.eventLoopUtilization = total > 0 ? nonnegative(active / total) : null;
        // An empty native histogram has percentile/min sentinels and max=0: none is a measurement.
        const count = histogram.count;
        if (Number.isFinite(count) && count > 0) {
          const ms = (ns) => Number.isFinite(ns) && ns >= 0 && ns < 2 ** 63 ? ns / 1e6 : null;
          next.mainThread.eventLoopDelayMs = {
            p50: ms(histogram.percentile(50)), p95: ms(histogram.percentile(95)),
            p99: ms(histogram.percentile(99)), max: ms(histogram.max),
          };
        }
      }
      // Only this sampler resets the histogram and advances CUMULATIVE CPU/ELU baselines.
      histogram.reset();
      baseline = current;
      cached = next;
    } catch (e) { unavailable(e); }
  }

  function start() {
    if (started || disposed) return;
    started = true;
    try {
      histogram = createHistogram({ resolution: RESOLUTION_MS });
      histogram.enable();
      baseline = { at: now(), cpu: cpuUsage(), elu: eventLoopUtilization() };
      timer = schedule(sample, SAMPLE_MS);
      timer.unref?.();
    } catch (e) { unavailable(e); }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stopResources();
    cached = emptySnapshot('stopped');
  }

  return { start, snapshot: () => cached, dispose };
}
