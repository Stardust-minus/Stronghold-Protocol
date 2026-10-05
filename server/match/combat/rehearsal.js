// A rehearsal owns frozen trial inputs, never the player's board, pool, money or random stream.
import { Battle } from '../../sim/Battle.js';
import { TrialEngine, MAX_TRIAL_TICKS, assembleTrialInput } from './trial.js';

export function canUseWorkerRehearsal(match) {
  const pool = match.trialPool;
  // createTrial is an EXPLICIT legacy adapter for parity/benchmarks, never an implicit combatPool loan.
  return !!(pool && (typeof pool.runTrial === 'function' || typeof pool.createTrial === 'function')
    && !match.clientCombat && !match.sched.virtual && match.BattleClass === Battle);
}

// Only this seat's proposal inputs matter. Private-view caches, timers and other players' dirty flags do not.
export function rehearsalFingerprint(match, ps) {
  const piece = (p) => p && [p.uid, p.kind, p.id, p.dir, p.ownerUid, p.count, p.poolCopies,
    (p.items || []).map((i) => [i.uid, i.id])];
  return JSON.stringify([match.stageId, ps.bandId, ps.deployCap, ps.loadout,
    [...ps.board].map(([key, p]) => [key, piece(p)]), ps.hand.map(piece), ps.temp.map(piece),
    Object.entries(ps.bonds).map(([id, b]) => [id, b.count, b.active, b.tier, b.layers]),
    ps.layers, ps.pendingLayerGains, ps.effects, ps.deviceOverrides, ps.tileOverrides, ps.bounties]);
}

export function createWorkerRehearsal(pool, input) {
  return typeof pool.runTrial === 'function' ? createStreamedRehearsal(pool, input) : createLegacyRehearsal(pool, input);
}

// Retain the original per-32-tick protocol and main-thread driving for explicit legacy comparisons.
function createLegacyRehearsal(pool, { playerId, chosen, plans, candidates, cap }) {
  let handle = null;
  let local = null;
  let initialized = false;
  let released = false;
  let cancelled = false;
  let advancing = false;
  let closing = null;
  let lastTicks = 0;
  const release = (cancel = false) => {
    if (cancel) cancelled = true;
    if (!closing) {
      released = true;
      try { local?.dispose(); local = null; closing = Promise.resolve(handle?.close()); }
      catch (e) { closing = Promise.reject(e); }
      closing.catch(() => {});
    }
    return closing;
  };
  const invalid = () => { throw new TypeError('invalid rehearsal winner/progress'); };
  const validate = (p) => {
    if (!initialized && (!p || p.ticks !== 0 || p.candidateIndex !== 0 || p.done !== false || p.bestIndex !== 0)) invalid();
    if (!p || typeof p.done !== 'boolean' || !Number.isInteger(p.bestIndex) || p.bestIndex < 0 || p.bestIndex >= plans.length ||
        !Number.isInteger(p.candidateIndex) || p.candidateIndex < 0 || p.candidateIndex > candidates.length ||
        p.done !== (p.candidateIndex === candidates.length) || !Number.isSafeInteger(p.ticks) || p.ticks < lastTicks ||
        p.ticks - lastTicks > MAX_TRIAL_TICKS || p.ticks > cap * candidates.length || !Array.isArray(p.candidates) || p.candidates.length !== p.candidateIndex) invalid();
    if (p.done) {
      if (p.candidates.reduce((n, c) => n + (c?.ticks ?? NaN), 0) !== p.ticks) invalid();
      for (let i = 0; i < p.candidates.length; i++) {
        const c = p.candidates[i];
        if (!c || c.index !== i || typeof c.beaten !== 'boolean' || !Number.isInteger(c.ticks) || c.ticks < 0 || c.ticks > cap ||
            !Number.isFinite(c.duration) || c.duration < 0 || !(c.score === null || Number.isFinite(c.score)) ||
            !(c.leaks === null || (Number.isInteger(c.leaks) && c.leaks >= 0)) ||
            !(c.result === null || typeof c.result === 'object') || !(c.error == null || typeof c.error === 'string')) invalid();
      }
      const best = p.candidates[p.bestIndex];
      if (p.bestScore === -Infinity) {
        if (p.bestIndex !== 0 || p.bestLeaks !== Infinity || p.candidates.some((c) => c.score !== null)) invalid();
      } else if (!best || best.score !== p.bestScore || best.leaks !== p.bestLeaks ||
          p.candidates.some((c) => c.score !== null && c.score > p.bestScore)) invalid();
    }
    lastTicks = p.ticks;
  };
  const job = {
    chosen, plans, best: plans[0], done: false, remote: true,
    close: () => release(true),
    fallback(data) {
      if (cancelled || advancing || job.done || job.inline || (handle && !released)) throw new Error('rehearsal cannot restart');
      // An RPC failure must not silently reduce the bot's search. Restart ALL frozen candidates, preserving
      // seeds/order/cap/pruning, without repeating shop decisions, layout generation or any match RNG draw.
      local = new TrialEngine({ playerId, candidates, cap }, { data });
      handle = null;
      closing = null;
      released = false;
      initialized = false;
      lastTicks = 0;
      job.inline = true;
      job.progress = null;
    },
    async advance() {
      if (released) throw new Error('rehearsal cancelled');
      if (advancing) throw new Error('rehearsal already advancing');
      advancing = true;
      try {
        // Admission is lazy: cancellation while the surrounding planning generator still places the default
        // layout cannot strand an initialized session whose returned job Match has not received yet.
        if (!handle && !local) handle = pool.createTrial({ playerId, candidates, cap });
        const progress = local ? (initialized ? local.advance() : local.state())
          : initialized ? await handle.advance() : await handle.ready;
        if (cancelled) throw new Error('rehearsal cancelled');
        validate(progress);
        initialized = true;
        job.progress = progress;
        if (progress.done) {
          await release();
          if (cancelled) throw new Error('rehearsal cancelled');
          job.best = plans[progress.bestIndex];
          job.done = true;
        }
        return job.done;
      } catch (e) {
        await release();
        throw e;
      } finally { advancing = false; }
    },
  };
  return job;
}

function createStreamedRehearsal(pool, { playerId, chosen, plans, candidates, cap }) {
  const input = assembleTrialInput({ playerId, candidates, cap });
  if (plans.length !== candidates.length) throw new TypeError('rehearsal plans/candidates differ');
  let handle = null, local = null, started = false, cancelled = false, released = false;
  let closing = null, cleanupAcknowledged = false;
  let lastTicks = 0, lastSlices = 0, lastCandidates = [];
  const invalid = () => { throw new TypeError('invalid rehearsal winner/progress'); };
  const candidateFields = (c) => [c.index, c.ticks, c.duration, c.beaten, c.leaks, c.score, c.error, c.synthetic];
  const validate = (p) => {
    if (!p || p.summary !== true || typeof p.done !== 'boolean' ||
        !Number.isInteger(p.candidateIndex) || p.candidateIndex < lastCandidates.length || p.candidateIndex > candidates.length ||
        p.done !== (p.candidateIndex === candidates.length) || !Number.isSafeInteger(p.ticks) || p.ticks < lastTicks ||
        !Number.isSafeInteger(p.sliceCount) || p.sliceCount < lastSlices ||
        p.ticks - lastTicks > MAX_TRIAL_TICKS * (p.sliceCount - lastSlices) || p.ticks > cap * candidates.length ||
        !Array.isArray(p.candidates) || p.candidates.length !== p.candidateIndex ||
        !Number.isInteger(p.bestIndex) || p.bestIndex < 0 || p.bestIndex >= plans.length) invalid();
    let completedTicks = 0, bestIndex = 0, bestScore = -Infinity, bestLeaks = Infinity;
    const records = [];
    for (let i = 0; i < p.candidates.length; i++) {
      const c = p.candidates[i];
      if (!c || c.index !== i || typeof c.beaten !== 'boolean' || !Number.isSafeInteger(c.ticks) || c.ticks < 0 || c.ticks > cap ||
          !Number.isFinite(c.duration) || c.duration < 0 || !(c.score === null || Number.isFinite(c.score)) ||
          !(c.leaks === null || (Number.isSafeInteger(c.leaks) && c.leaks >= 0)) || c.result !== null ||
          !(c.error == null || typeof c.error === 'string') || !(c.synthetic === null || typeof c.synthetic === 'boolean') ||
          (c.score !== null && (c.beaten || c.synthetic !== false || c.leaks === null))) invalid();
      const fields = JSON.stringify(candidateFields(c));
      if (i < lastCandidates.length && fields !== lastCandidates[i]) invalid();
      records.push(fields);
      completedTicks += c.ticks;
      if (c.score !== null && c.score > bestScore) { bestIndex = i; bestScore = c.score; bestLeaks = c.leaks; }
    }
    // Completed records are immutable prefixes; only the currently running candidate can account for extra ticks.
    if (p.ticks < completedTicks || p.ticks > completedTicks + (p.done ? 0 : cap) ||
        p.bestIndex !== bestIndex || p.bestScore !== bestScore || p.bestLeaks !== bestLeaks) invalid();
    lastTicks = p.ticks; lastSlices = p.sliceCount; lastCandidates = records;
  };
  const validateReady = (p) => {
    if (!p || p.summary !== true || p.ticks !== 0 || p.sliceCount !== 0 || p.candidateIndex !== 0 || p.done !== false ||
        p.bestIndex !== 0 || p.bestScore !== -Infinity || p.bestLeaks !== Infinity || !Array.isArray(p.candidates) || p.candidates.length) invalid();
  };
  const release = (cancel = false) => {
    if (cancel) cancelled = true;
    if (!closing) {
      released = true;
      try { local?.dispose(); local = null; closing = Promise.resolve(handle?.close()); }
      catch (e) { closing = Promise.reject(e); }
      closing = closing.then(() => { cleanupAcknowledged = true; });
      closing.catch(() => {});
    }
    return closing;
  };
  const job = {
    chosen, plans, best: plans[0], done: false, remote: true, streamed: true,
    close: () => release(true),
    async start({ onProgress, onReady, timeoutMs } = {}) {
      if (cancelled || released) throw Object.assign(new Error('rehearsal cancelled'), { code: 'SESSION_CLOSED' });
      if (started) throw new Error('rehearsal already started');
      started = true;
      let rejectFault;
      const fault = new Promise((_, reject) => { rejectFault = reject; });
      fault.catch(() => {});
      try {
        // Admission is lazy: candidate collection and default placement cannot strand a hidden remote job.
        handle = pool.runTrial(input, { summary: true, timeoutMs, onFailure: rejectFault, onProgress(p) {
          if (released || cancelled) return;
          try { validate(p); job.progress = p; onProgress?.(p); }
          catch (e) { rejectFault(e); }
        } });
        // Observe both immediately: done may reject while acknowledgement/ready is still in flight.
        const ready = Promise.race([handle.ready, fault]);
        const done = Promise.race([handle.done, fault]);
        done.catch(() => {});
        const initial = await ready;
        if (cancelled) throw Object.assign(new Error('rehearsal cancelled'), { code: 'SESSION_CLOSED' });
        validateReady(initial);
        if (!job.progress) job.progress = initial;
        onReady?.();
        if (cancelled) throw Object.assign(new Error('rehearsal cancelled'), { code: 'SESSION_CLOSED' });
        const final = await done;
        if (cancelled) throw Object.assign(new Error('rehearsal cancelled'), { code: 'SESSION_CLOSED' });
        validate(final);
        if (!final.done) invalid();
        job.progress = final;
        await release();
        if (cancelled) throw Object.assign(new Error('rehearsal cancelled'), { code: 'SESSION_CLOSED' });
        job.best = plans[final.bestIndex]; job.done = true;
        return true;
      } catch (e) {
        // A failed remote reservation must actually be gone before the same search can restart inline.
        await release();
        throw e;
      }
    },
    fallback(data) {
      if (cancelled || job.done || job.inline || !cleanupAcknowledged) throw new Error('rehearsal cannot restart');
      local = new TrialEngine(input, { data, summary: true });
      handle = null; closing = null; released = false; cleanupAcknowledged = false;
      lastTicks = 0; lastSlices = 0; lastCandidates = [];
      job.inline = true; job.progress = null;
    },
    run(budgetMs = Infinity) {
      if (cancelled || released || !local) throw new Error('rehearsal cancelled');
      const start = performance.now();
      let done;
      do { done = local.advanceSlice(); } while (!done && performance.now() - start < budgetMs);
      const p = local.state();
      validate(p); job.progress = p;
      if (p.done) { job.best = plans[p.bestIndex]; job.done = true; release(); }
      return job.done;
    },
  };
  return job;
}
