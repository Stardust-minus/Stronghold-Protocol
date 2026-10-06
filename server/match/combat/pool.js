// Fixed, process-shared worker pool. Each session stays on one worker for its entire phase.
// One wire request per worker bounds MessagePort backlog; queued client requests are bounded globally.
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { deepFreeze, getData } from '../../data.js';
import { snapshotTrialInput, MAX_TRIAL_TICKS } from './trial.js';

const WORKER_URL = new URL('./worker.js', import.meta.url);
const OPS = new Set(['advance', 'state', 'forceField', 'forceAll']);
const MAX_REPLACEMENTS = 3; // lifetime budget per slot, NOT reset after a successful boot
const error = (message, code) => Object.assign(new Error(message), { code });
function positive(n, name, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(n) || n < 1 || n > max) throw new RangeError(`${name} must be an integer in 1..${max}`);
  return n;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Cancellation and idle worker failures may precede the caller attaching its handler. Still return the
  // original rejected promise, but ensure such lifecycle events never cause an unhandled rejection.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

export class CombatWorkerPool {
  constructor({ size, data = getData(), log = console, maxSessions = 0, maxPending = 8192,
    startupTimeoutMs = 15_000, requestTimeoutMs = 30_000, maxTrials = 64, maxTrialPending = 64,
    role = 'combat', trialAckTimeoutMs = 5_000, trialStallTimeoutMs = 5_000 } = {}) {
    if (!['combat', 'trial'].includes(role)) throw new RangeError('role must be combat or trial');
    this.role = role;
    this.size = positive(size, 'size', role === 'trial' ? 2 : 64);
    this.trialAckTimeoutMs = positive(trialAckTimeoutMs, 'trialAckTimeoutMs');
    this.trialStallTimeoutMs = positive(trialStallTimeoutMs, 'trialStallTimeoutMs');
    this.maxSessions = maxSessions === 0 ? 0 : positive(maxSessions, 'maxSessions'); // 0 = unlimited combat sessions
    this.maxPending = positive(maxPending, 'maxPending'); // execution backpressure, not human admission
    // Trials remain bounded background work: they cannot consume combat's request/session capacity.
    this.maxTrials = positive(maxTrials, 'maxTrials');
    this.maxTrialPending = positive(maxTrialPending, 'maxTrialPending');
    this.trials = 0;
    this.trialPending = 0;
    this.startupTimeoutMs = positive(startupTimeoutMs, 'startupTimeoutMs');
    this.requestTimeoutMs = positive(requestTimeoutMs, 'requestTimeoutMs');
    if (!data || typeof data !== 'object') throw new TypeError('full raw combat data required');
    this.data = deepFreeze(data);
    this.log = log;
    this.status = 'new';
    this.generation = randomUUID();
    this.nextSession = 0;
    this.pending = 0;
    this.sessions = new Map();
    this.terminating = new Set();
    this.slots = Array.from({ length: size }, (_, index) => ({
      index, epoch: 0, worker: null, ready: false, queue: [], cleanup: new Map(), active: null, trial: null,
      sessions: new Set(), replacements: 0, retry: null, startup: null, startupTimer: null,
    }));
    this._startPromise = null;
    this._closePromise = null;
  }

  start() {
    if (this._startPromise) return this._startPromise;
    if (this.status !== 'new') return Promise.reject(error('combat pool is closed', 'POOL_CLOSED'));
    this.status = 'starting';
    this._startPromise = (async () => {
      try {
        await Promise.all(this.slots.map((slot) => this._spawn(slot)));
        if (this.status !== 'starting') throw error('combat pool closed during startup', 'POOL_CLOSED');
        this.status = 'ready';
        return this;
      } catch (e) {
        await this.close();
        throw e;
      }
    })();
    this._startPromise.catch(() => {});
    return this._startPromise;
  }

  _spawn(slot) {
    const boot = deferred();
    slot.startup = boot;
    slot.epoch++;
    const epoch = slot.epoch;
    try {
      // Full data crosses the boundary only here, once per worker lifetime, never once per phase/command.
      const worker = new Worker(WORKER_URL, {
        workerData: { epoch, data: this.data, maxSessions: this.maxSessions, role: this.role },
        // Test runners/CLI eval can expose process-only flags (Node24 even includes V8 defaults).
        // These plain ESM workers need no loader/preload/inspection flags from the host entrypoint.
        execArgv: [],
      });
      slot.worker = worker;
      slot.termination = null;
      slot.ready = false;
      const onMessage = (message) => {
        if (slot.worker !== worker || message?.epoch !== epoch) return;
        if (message.type === 'ready') {
          if (slot.ready || !slot.startup) return;
          clearTimeout(slot.startupTimer);
          slot.startupTimer = null;
          slot.ready = true;
          slot.startup = null;
          boot.resolve();
          this._pump(slot);
        } else if (message.type === 'reply') this._reply(slot, message);
        else if (message.type === 'trialEvent' && this.role === 'trial') this._trialEvent(slot, message);
        else if (message.type === 'fatal') this._fail(slot, error(message.message || 'combat worker bootstrap failed', 'WORKER_STARTUP'));
      };
      const onError = (e) => { if (slot.worker === worker) this._fail(slot, e); };
      const onMessageError = (e) => { if (slot.worker === worker) this._fail(slot, e); };
      const onExit = (code) => {
        if (slot.worker === worker) this._fail(slot, error(`combat worker exited (${code})`, 'WORKER_EXIT'));
        // Keep the error listener until exit: a terminating worker can still emit an error.
        worker.removeListener('message', onMessage);
        worker.removeListener('messageerror', onMessageError);
        worker.removeListener('error', onError);
        worker.removeListener('exit', onExit);
      };
      worker.on('message', onMessage);
      worker.on('messageerror', onMessageError);
      worker.on('error', onError);
      worker.on('exit', onExit);
      slot.startupTimer = setTimeout(() => {
        if (slot.worker === worker) this._fail(slot, error('combat worker startup timed out', 'WORKER_STARTUP_TIMEOUT'));
      }, this.startupTimeoutMs);
    } catch (e) { this._fail(slot, e); }
    return boot.promise;
  }

  create(input, { onFailure = null } = {}) {
    if (this.role === 'trial') throw error('dedicated trial pool rejects combat', 'BAD_POOL_ROLE');
    if (this.status !== 'ready') throw error('combat pool is not ready', 'POOL_UNAVAILABLE');
    if (this.maxSessions > 0 && this.sessions.size - this.trials >= this.maxSessions) throw error('combat session limit reached', 'SESSION_LIMIT');
    if (this.pending - this.trialPending >= this.maxPending) throw error('combat request queue full', 'QUEUE_FULL');
    const count = (s) => [...s.sessions].filter((x) => x.kind === 'combat').length;
    const slot = this.slots.filter((s) => s.ready).sort((a, b) => count(a) - count(b) || a.queue.length - b.queue.length || a.index - b.index)[0];
    if (!slot) throw error('no combat workers available', 'POOL_UNAVAILABLE');
    const generation = `${this.generation}:${++this.nextSession}`;
    const session = { generation, kind: 'combat', slot, seq: 0, closed: false, onFailure, initialized: false, sent: false };
    this.sessions.set(generation, session);
    slot.sessions.add(session);
    const ready = this._enqueue(session, 'init', input);
    return Object.freeze({
      generation, ready,
      request: (op, payload = {}) => {
        if (!OPS.has(op)) return Promise.reject(error(`unsupported combat operation ${op}`, 'BAD_OPERATION'));
        return this._enqueue(session, op, payload);
      },
      close: () => this._closeSession(session, error('combat session cancelled', 'SESSION_CLOSED')),
    });
  }

  createTrial(input, { onFailure = null } = {}) {
    if (this.status !== 'ready') throw error('combat pool is not ready', 'POOL_UNAVAILABLE');
    if (this.trials >= this.maxTrials) throw error('trial session limit reached', 'TRIAL_LIMIT');
    if (this.trialPending >= this.maxTrialPending) throw error('trial request queue full', 'QUEUE_FULL');
    const count = (s) => [...s.sessions].filter((x) => x.kind === 'trial').length;
    const slot = this.slots.filter((s) => s.ready).sort((a, b) => count(a) - count(b) || a.queue.length - b.queue.length || a.index - b.index)[0];
    if (!slot) throw error('no combat workers available', 'POOL_UNAVAILABLE');
    const snapshot = snapshotTrialInput(input);
    const generation = `${this.generation}:${++this.nextSession}`;
    const session = { generation, kind: 'trial', slot, seq: 0, closed: false, onFailure, initialized: false, sent: false, pending: false, closedDone: deferred() };
    this.sessions.set(generation, session);
    slot.sessions.add(session);
    this.trials++;
    const ready = this._enqueue(session, 'init', snapshot);
    return Object.freeze({
      generation, ready,
      advance: (ticks = MAX_TRIAL_TICKS) => this._enqueue(session, 'advance', { ticks }),
      close: () => { this._closeSession(session, error('trial session cancelled', 'SESSION_CLOSED')); return session.closedDone.promise; },
    });
  }

  runTrial(input, { onProgress = null, onFailure = null, timeoutMs = this.requestTimeoutMs, summary = true } = {}) {
    if (this.role !== 'trial') throw error('autonomous trial requires dedicated pool', 'BAD_POOL_ROLE');
    if (this.status !== 'ready') throw error('trial pool is not ready', 'POOL_UNAVAILABLE');
    if (this.trials >= this.maxTrials) throw error('trial session limit reached', 'TRIAL_LIMIT');
    if (this.trialPending >= this.maxTrialPending) throw error('trial request queue full', 'QUEUE_FULL');
    positive(timeoutMs, 'timeoutMs');
    if (typeof summary !== 'boolean' || (onProgress != null && typeof onProgress !== 'function')) throw new TypeError('invalid trial run options');
    const snapshot = snapshotTrialInput(input);
    const count = (s) => [...s.sessions].filter((x) => x.kind === 'trial').length;
    const slot = this.slots.filter((s) => s.ready).sort((a, b) => count(a) - count(b) || a.queue.length - b.queue.length || a.index - b.index)[0];
    if (!slot) throw error('no trial workers available', 'POOL_UNAVAILABLE');
    const generation = `${this.generation}:${++this.nextSession}`;
    const session = { generation, kind: 'trial', stream: true, slot, seq: 0, controlSeq: 1, eventSeq: 0,
      closed: false, onFailure, onProgress, summary, cap: snapshot.cap, candidateCount: snapshot.candidates.length,
      initialized: false, sent: false, pending: false, closedDone: deferred(), done: deferred(), completed: false,
      lastTicks: 0, lastCandidate: 0, lastSlices: 0, lastScore: -Infinity, prefix: [], callbackBusy: false, latestProgress: null,
      deadline: performance.now() + timeoutMs };
    this.sessions.set(generation, session);
    slot.sessions.add(session);
    this.trials++;
    // Admission time, including queue time, belongs to the caller's bounded PREP budget.
    session.overallTimer = setTimeout(() => this._closeSession(session, error('trial deadline exceeded', 'TRIAL_TIMEOUT'), true), timeoutMs);
    const ready = this._enqueue(session, 'run', { input: snapshot, summary });
    return Object.freeze({ generation, ready, done: session.done.promise,
      close: () => { this._closeSession(session, error('trial session cancelled', 'SESSION_CLOSED')); return session.closedDone.promise; } });
  }

  _validateTrialProgress(session, p, initial = false) {
    const bad = () => { throw error('invalid autonomous trial progress', 'BAD_TRIAL_EVENT'); };
    if (!p || p.summary !== session.summary || typeof p.done !== 'boolean' ||
        !Number.isSafeInteger(p.ticks) || p.ticks < session.lastTicks || p.ticks > session.cap * session.candidateCount ||
        !Number.isSafeInteger(p.sliceCount) || p.sliceCount < session.lastSlices ||
        p.ticks - session.lastTicks > MAX_TRIAL_TICKS * (p.sliceCount - session.lastSlices) ||
        !Number.isInteger(p.candidateIndex) || p.candidateIndex < session.lastCandidate || p.candidateIndex > session.candidateCount ||
        p.done !== (p.candidateIndex === session.candidateCount) ||
        !Number.isInteger(p.bestIndex) || p.bestIndex < 0 || p.bestIndex >= session.candidateCount ||
        !(p.bestScore === -Infinity || Number.isFinite(p.bestScore)) || p.bestScore < session.lastScore ||
        !Array.isArray(p.candidates) || p.candidates.length !== p.candidateIndex) bad();
    if (initial && (p.ticks !== 0 || p.sliceCount !== 0 || p.candidateIndex !== 0 || p.done || p.bestIndex !== 0)) bad();
    if (!initial && p.sliceCount === session.lastSlices && p.candidateIndex !== session.lastCandidate) bad();
    const keys = ['index', 'ticks', 'duration', 'beaten', 'leaks', 'score', 'error', 'synthetic'];
    let total = 0;
    const prefix = [];
    for (let i = 0; i < p.candidates.length; i++) {
      const c = p.candidates[i];
      if (!c || c.index !== i || !Number.isInteger(c.ticks) || c.ticks < 0 || c.ticks > session.cap ||
          !Number.isFinite(c.duration) || c.duration < 0 || typeof c.beaten !== 'boolean' ||
          !(c.leaks === null || (Number.isSafeInteger(c.leaks) && c.leaks >= 0)) ||
          !(c.score === null || Number.isFinite(c.score)) || !(c.error === null || typeof c.error === 'string') ||
          !(c.synthetic === null || typeof c.synthetic === 'boolean') ||
          (c.score !== null && (c.synthetic !== false || c.leaks === null || c.beaten)) ||
          ((session.summary || !p.done) ? c.result !== null : !(c.result === null || typeof c.result === 'object'))) bad();
      if (session.prefix[i] && keys.some((k) => c[k] !== session.prefix[i][k])) bad();
      total += c.ticks;
      prefix.push(Object.fromEntries(keys.map((k) => [k, c[k]])));
    }
    if (total > p.ticks || (p.done && total !== p.ticks)) bad();
    const best = p.candidates[p.bestIndex];
    if (p.bestScore === -Infinity) {
      if (p.bestIndex !== 0 || p.bestLeaks !== Infinity || p.candidates.some((c) => c.score !== null)) bad();
    } else if (!best || best.score !== p.bestScore || best.leaks !== p.bestLeaks ||
        p.candidates.some((c) => c.score !== null && c.score > p.bestScore)) bad();
    const advanced = p.ticks > session.lastTicks || p.candidateIndex > session.lastCandidate;
    session.lastTicks = p.ticks;
    session.lastCandidate = p.candidateIndex;
    session.lastSlices = p.sliceCount;
    session.lastScore = p.bestScore;
    session.prefix = prefix;
    return advanced;
  }

  _watchTrial(session) {
    clearTimeout(session.stallTimer);
    session.stallTimer = setTimeout(() => this._closeSession(session, error('trial made no progress', 'TRIAL_STALLED'), true), this.trialStallTimeoutMs);
  }

  _trialControl(session, op, payload = null) {
    const slot = session.slot;
    slot.worker.postMessage({ type: 'trialControl', epoch: slot.epoch, kind: 'trial',
      generation: session.generation, seq: ++session.controlSeq, op, payload });
    return session.controlSeq;
  }

  _deliverTrialProgress(session, dto) {
    if (!session.onProgress || session.closed) return;
    if (session.callbackBusy) { session.latestProgress = dto; return; }
    session.callbackBusy = true;
    const complete = () => {
      session.callbackBusy = false;
      const latest = session.latestProgress;
      session.latestProgress = null;
      if (latest && !session.closed) this._deliverTrialProgress(session, latest);
    };
    try {
      const result = session.onProgress(dto);
      if (result && typeof result.then === 'function') Promise.resolve(result).then(complete, (e) => {
        session.callbackBusy = false;
        this._closeSession(session, e, true);
      });
      else complete();
    } catch (e) { session.callbackBusy = false; this._closeSession(session, e, true); }
  }

  _trialEvent(slot, message) {
    const session = this.sessions.get(message.generation) || slot.cleanup.get(message.generation);
    if (!session?.stream || session.slot !== slot || message.kind !== 'trial') return;
    // Old/duplicate events are harmless; a gap on a live generation is a protocol failure.
    if (!Number.isSafeInteger(message.eventSeq) || message.eventSeq < 1) {
      if (!session.closed) this._closeSession(session, error('invalid trial event sequence', 'BAD_TRIAL_EVENT'), true);
      return;
    }
    if (message.eventSeq <= session.eventSeq && message.event !== 'closed') return;
    if (message.event === 'closed') {
      if (!session.closed || message.seq !== session.cancelSeq) return;
      clearTimeout(session.cancelTimer);
      slot.cleanup.delete(session.generation);
      if (slot.trial === session) slot.trial = null;
      session.closedDone.resolve();
      this._pump(slot);
      return;
    }
    if (session.closed) { session.eventSeq = Math.max(session.eventSeq, message.eventSeq); return; }
    try {
      if (performance.now() >= session.deadline) throw error('trial deadline exceeded', 'TRIAL_TIMEOUT');
      if (!session.initialized || message.eventSeq !== session.eventSeq + 1) throw error('out-of-order trial event', 'BAD_TRIAL_EVENT');
      session.eventSeq = message.eventSeq;
      if (message.event === 'error') throw error(message.error?.message || 'trial worker failed', message.error?.code || 'WORKER_COMMAND');
      if (!['progress', 'done'].includes(message.event) || message.dto?.done !== (message.event === 'done')) throw error('invalid trial event', 'BAD_TRIAL_EVENT');
      const advanced = this._validateTrialProgress(session, message.dto);
      if (message.event === 'done') {
        session.completed = true;
        session.done.resolve(message.dto);
        this._closeSession(session, error('trial completed', 'SESSION_CLOSED'));
      } else {
        if (advanced) this._watchTrial(session);
        // ACK transport immediately. Async consumers coalesce independently, so backpressure cannot
        // conceal valid computation from the stall watchdog or hold terminal/cancel delivery hostage.
        this._trialControl(session, 'progressAck', { eventSeq: message.eventSeq });
        this._deliverTrialProgress(session, message.dto);
      }
    } catch (e) { this._closeSession(session, e, true); }
  }

  _closeTrialStream(session, failure, notify) {
    session.closed = true;
    clearTimeout(session.overallTimer);
    clearTimeout(session.stallTimer);
    session.latestProgress = null;
    session.onProgress = null;
    if (!session.completed) session.done.reject(failure);
    this.sessions.delete(session.generation);
    this.trials--;
    const slot = session.slot;
    slot.sessions.delete(session);
    const removed = slot.queue.filter((task) => task.session === session);
    slot.queue = slot.queue.filter((task) => task.session !== session);
    for (const task of removed) this._settle(task, failure);
    if (slot.active?.session === session) this._settle(slot.active, failure);
    if (session.sent && slot.ready) {
      slot.cleanup.set(session.generation, session);
      session.cancelTimer = setTimeout(() => this._fail(slot, error('trial cancellation acknowledgement timed out', 'TRIAL_CANCEL_TIMEOUT')), this.trialAckTimeoutMs);
      try { session.cancelSeq = this._trialControl(session, 'cancel'); }
      catch (e) { this._fail(slot, e); }
    } else if (session.sent && slot.termination) {
      Promise.resolve(slot.termination).then(() => session.closedDone.resolve());
    } else session.closedDone.resolve();
    const callback = session.onFailure;
    session.onFailure = null;
    if (notify && typeof callback === 'function') {
      try { Promise.resolve(callback(failure)).catch((e) => this._log(e)); }
      catch (e) { this._log(e); }
    }
    this._pump(slot);
  }

  async evaluateTrial(input, { signal, onProgress = null, onFailure = null } = {}) {
    if (signal?.aborted) throw error('trial session cancelled', 'SESSION_CLOSED');
    const handle = this.createTrial(input, { onFailure });
    const abort = () => { handle.close(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      let out = await handle.ready;
      while (!out.done) {
        out = await handle.advance(); // each real reply admits just one low-priority slice
        if (onProgress) await onProgress(out);
        if (signal?.aborted) throw error('trial session cancelled', 'SESSION_CLOSED');
      }
      return out;
    } finally {
      signal?.removeEventListener('abort', abort);
      await handle.close();
    }
  }

  _enqueue(session, op, payload) {
    if (session.closed || this.status !== 'ready') return Promise.reject(error('combat session closed', 'SESSION_CLOSED'));
    const trial = session.kind === 'trial';
    if (trial && session.pending) return Promise.reject(error('trial request already pending', 'TRIAL_BUSY'));
    if (trial ? this.trialPending >= this.maxTrialPending : this.pending - this.trialPending >= this.maxPending) return Promise.reject(error('combat request queue full', 'QUEUE_FULL'));
    const done = deferred();
    const task = { generation: session.generation, kind: session.kind, seq: ++session.seq, op, payload, session, done, timer: null };
    this.pending++;
    if (trial) { this.trialPending++; session.pending = true; }
    task.timer = setTimeout(() => {
      if (!task.done) return;
      const failure = error(`combat request ${op} timed out`, 'REQUEST_TIMEOUT');
      // Waiting behind real battles is not evidence that a worker failed. Only the wire watchdog may kill it.
      if (trial) this._closeSession(session, failure, true);
      else this._fail(session.slot, failure);
    }, this.requestTimeoutMs);
    session.slot.queue.push(task);
    this._pump(session.slot);
    return done.promise;
  }

  _settle(task, failure, dto) {
    if (!task.done) return;
    clearTimeout(task.timer);
    task.timer = null;
    const done = task.done;
    task.done = null;
    task.payload = null;
    this.pending--;
    if (task.kind === 'trial') { this.trialPending--; task.session.pending = false; }
    if (failure) done.reject(failure); else done.resolve(dto);
  }

  _pump(slot) {
    if (!slot.ready || slot.active || this.status === 'closing' || this.status === 'closed') return;
    let task;
    const cleanupCombat = [...slot.cleanup].find(([, session]) => session.kind === 'combat');
    const combatIndex = slot.queue.findIndex((t) => t.kind === 'combat');
    // Autonomous cancellation uses its own control path; legacy cleanup stays ordered on the wire.
    const cleanupTrial = [...slot.cleanup].find(([, session]) => !session.stream);
    const cleanup = cleanupCombat ?? (combatIndex < 0 ? cleanupTrial : null);
    if (cleanup) {
      const [generation, session] = cleanup;
      slot.cleanup.delete(generation);
      task = { generation, kind: session.kind, seq: 0, op: 'close', payload: null, done: null, session: null, closedSession: session };
    } else {
      // Combat FIFO always wins. A trial relinquishes the wire at every reply, never self-runs to completion.
      const index = combatIndex >= 0 ? combatIndex : slot.queue.findIndex((t) => !slot.trial || slot.trial === t.session);
      if (index >= 0) task = slot.queue.splice(index, 1)[0];
    }
    if (!task) return;
    if (task.session?.stream && performance.now() >= task.session.deadline) {
      const failure = error('trial deadline exceeded', 'TRIAL_TIMEOUT');
      this._settle(task, failure);
      this._closeSession(task.session, failure, true);
      return;
    }
    slot.active = task;
    if (task.session && (task.op === 'init' || task.op === 'run')) {
      task.session.sent = true;
      if (task.kind === 'trial') slot.trial = task.session;
    }
    // This watchdog remains even when the caller cancels an in-flight command and its promise is removed.
    // A blocked/looping worker must not strand every other phase or grow an unbounded cleanup queue.
    task.wireTimer = setTimeout(() => this._fail(slot, error('combat worker response timed out', 'REQUEST_TIMEOUT')),
      task.session?.stream ? this.trialAckTimeoutMs : this.requestTimeoutMs);
    try {
      slot.worker.postMessage({ type: 'request', epoch: slot.epoch, kind: task.kind, generation: task.generation, seq: task.seq, op: task.op, payload: task.payload });
      task.payload = null;
    } catch (e) { this._fail(slot, e); }
  }

  _reply(slot, message) {
    const task = slot.active;
    if (!task || message.generation !== task.generation || message.seq !== task.seq ||
        (message.kind ?? 'combat') !== task.kind) return; // stale/cancelled generation or wrong session kind
    clearTimeout(task.wireTimer);
    slot.active = null;
    if (task.closedSession) {
      if (slot.trial === task.closedSession) slot.trial = null;
      task.closedSession.closedDone?.resolve();
    }
    if (task.session && !task.session.closed) {
      if (message.error) {
        const e = error(message.error.message || 'combat worker operation failed', message.error.code || 'WORKER_COMMAND');
        this._settle(task, e);
        this._closeSession(task.session, e, true);
      } else {
        if (task.op === 'run') {
          try {
            if (performance.now() >= task.session.deadline) throw error('trial deadline exceeded', 'TRIAL_TIMEOUT');
            this._validateTrialProgress(task.session, message.dto, true);
            task.session.initialized = true;
            this._watchTrial(task.session);
          } catch (e) {
            this._settle(task, e);
            this._closeSession(task.session, e, true);
            this._pump(slot);
            return;
          }
        } else if (task.op === 'init') task.session.initialized = true;
        this._settle(task, null, message.dto);
      }
    }
    this._pump(slot);
  }

  _closeSession(session, failure, notify = false) {
    if (session.closed) return;
    if (session.stream) return this._closeTrialStream(session, failure, notify);
    session.closed = true;
    this.sessions.delete(session.generation);
    if (session.kind === 'trial') this.trials--;
    const slot = session.slot;
    slot.sessions.delete(session);
    const removed = slot.queue.filter((task) => task.session === session);
    slot.queue = slot.queue.filter((task) => task.session !== session);
    for (const task of removed) this._settle(task, failure);
    if (slot.active?.session === session) this._settle(slot.active, failure);
    if (session.sent && slot.ready) slot.cleanup.set(session.generation, session);
    else session.closedDone?.resolve();
    const callback = session.onFailure;
    session.onFailure = null;
    if (notify && typeof callback === 'function') {
      try {
        // Also contain accidentally async callbacks, not just synchronous throws.
        Promise.resolve(callback(failure)).catch((e) => this._log(e));
      } catch (e) { this._log(e); }
    }
    this._pump(slot);
  }

  _terminate(worker) {
    if (!worker) return;
    const promise = worker.terminate().catch((e) => this._log(e));
    this.terminating.add(promise);
    promise.then(() => this.terminating.delete(promise));
    return promise;
  }

  _fail(slot, failure) {
    if (!slot.worker && !slot.startup) return;
    const worker = slot.worker;
    slot.worker = null;
    slot.ready = false;
    clearTimeout(slot.startupTimer);
    slot.startupTimer = null;
    slot.startup?.reject(failure);
    slot.startup = null;
    if (slot.active) {
      clearTimeout(slot.active.wireTimer);
      this._settle(slot.active, failure);
      slot.active.closedSession?.closedDone?.resolve();
      slot.active = null;
    }
    // Register termination before callbacks: an onFailure callback may itself await pool.close().
    const terminated = this._terminate(worker);
    slot.termination = terminated;
    for (const session of [...slot.sessions]) this._closeSession(session, failure, true);
    slot.queue = [];
    for (const session of slot.cleanup.values()) {
      clearTimeout(session.cancelTimer);
      if (session.stream) Promise.resolve(terminated).then(() => session.closedDone.resolve());
      else session.closedDone?.resolve();
    }
    slot.cleanup.clear();
    if (slot.trial?.stream) {
      const session = slot.trial;
      Promise.resolve(terminated).then(() => session.closedDone.resolve());
    } else slot.trial?.closedDone?.resolve();
    slot.trial = null;
    if (this.status === 'ready' && slot.replacements < MAX_REPLACEMENTS) {
      const delay = 50 * 2 ** slot.replacements++;
      // A replacement never overlaps the old thread, even if termination is slower than the backoff.
      Promise.resolve(terminated).then(() => {
        if (this.status !== 'ready') return;
        slot.retry = setTimeout(() => {
          slot.retry = null;
          if (this.status === 'ready') this._spawn(slot).catch((e) => this._log(e));
        }, delay);
      });
    }
    if (failure.code !== 'POOL_CLOSED') this._log(failure);
  }

  _log(e) { try { this.log?.error?.(`[combat worker] ${e?.message ?? e}`); } catch { /* logger is not authority */ } }

  stats() {
    return {
      status: this.status, size: this.size, workers: this.slots.filter((s) => !!s.worker).length,
      ready: this.slots.filter((s) => s.ready).length, sessions: this.sessions.size, pending: this.pending,
      queued: this.slots.reduce((n, s) => n + s.queue.length, 0),
      active: this.slots.filter((s) => !!s.active).length,
      cleanup: this.slots.reduce((n, s) => n + s.cleanup.size, 0),
      trials: this.trials, trialPending: this.trialPending, activeTrials: this.slots.filter((s) => !!s.trial).length,
      replacements: this.slots.reduce((n, s) => n + s.replacements, 0),
    };
  }

  close() {
    if (this._closePromise) return this._closePromise;
    this.status = 'closing';
    this._closePromise = (async () => {
      const e = error('combat pool closed', 'POOL_CLOSED');
      for (const slot of this.slots) {
        clearTimeout(slot.retry);
        slot.retry = null;
        // Do not notify match failure on deliberate shutdown/cancel.
        for (const session of [...slot.sessions]) this._closeSession(session, e);
        this._fail(slot, e);
      }
      await Promise.all([...this.terminating]);
      this.data = null;
      this.status = 'closed';
    })();
    return this._closePromise;
  }
}
