// Fixed, process-shared worker pool. Each session stays on one worker for its entire phase.
// One wire request per worker bounds MessagePort backlog; queued client requests are bounded globally.
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { deepFreeze, getData } from '../../data.js';

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
  constructor({ size, data = getData(), log = console, maxSessions = 4096, maxPending = 8192,
    startupTimeoutMs = 15_000, requestTimeoutMs = 30_000 } = {}) {
    this.size = positive(size, 'size', 64);
    this.maxSessions = positive(maxSessions, 'maxSessions');
    this.maxPending = positive(maxPending, 'maxPending');
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
      index, epoch: 0, worker: null, ready: false, queue: [], cleanup: new Set(), active: null,
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
        workerData: { epoch, data: this.data, maxSessions: this.maxSessions },
        // Test runners/CLI eval can expose process-only flags (Node24 even includes V8 defaults).
        // These plain ESM workers need no loader/preload/inspection flags from the host entrypoint.
        execArgv: [],
      });
      slot.worker = worker;
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
    if (this.status !== 'ready') throw error('combat pool is not ready', 'POOL_UNAVAILABLE');
    if (this.sessions.size >= this.maxSessions) throw error('combat session limit reached', 'SESSION_LIMIT');
    if (this.pending >= this.maxPending) throw error('combat request queue full', 'QUEUE_FULL');
    const slot = this.slots.filter((s) => s.ready).sort((a, b) => a.sessions.size - b.sessions.size || a.queue.length - b.queue.length || a.index - b.index)[0];
    if (!slot) throw error('no combat workers available', 'POOL_UNAVAILABLE');
    const generation = `${this.generation}:${++this.nextSession}`;
    const session = { generation, slot, seq: 0, closed: false, onFailure, initialized: false, sent: false };
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

  _enqueue(session, op, payload) {
    if (session.closed || this.status !== 'ready') return Promise.reject(error('combat session closed', 'SESSION_CLOSED'));
    if (this.pending >= this.maxPending) return Promise.reject(error('combat request queue full', 'QUEUE_FULL'));
    const done = deferred();
    const task = { generation: session.generation, seq: ++session.seq, op, payload, session, done, timer: null };
    this.pending++;
    task.timer = setTimeout(() => {
      if (task.done) this._fail(session.slot, error(`combat request ${op} timed out`, 'REQUEST_TIMEOUT'));
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
    if (failure) done.reject(failure); else done.resolve(dto);
  }

  _pump(slot) {
    if (!slot.ready || slot.active || this.status === 'closing' || this.status === 'closed') return;
    let task;
    if (slot.cleanup.size) {
      const generation = slot.cleanup.values().next().value;
      slot.cleanup.delete(generation);
      task = { generation, seq: 0, op: 'close', payload: null, done: null, session: null };
    } else task = slot.queue.shift();
    if (!task) return;
    slot.active = task;
    if (task.session && task.op === 'init') task.session.sent = true;
    // This watchdog remains even when the caller cancels an in-flight command and its promise is removed.
    // A blocked/looping worker must not strand every other phase or grow an unbounded cleanup queue.
    task.wireTimer = setTimeout(() => this._fail(slot, error('combat worker response timed out', 'REQUEST_TIMEOUT')), this.requestTimeoutMs);
    try {
      slot.worker.postMessage({ type: 'request', epoch: slot.epoch, generation: task.generation, seq: task.seq, op: task.op, payload: task.payload });
      task.payload = null;
    } catch (e) { this._fail(slot, e); }
  }

  _reply(slot, message) {
    const task = slot.active;
    if (!task || message.generation !== task.generation || message.seq !== task.seq) return; // stale/cancelled generation
    clearTimeout(task.wireTimer);
    slot.active = null;
    if (task.session && !task.session.closed) {
      if (message.error) {
        const e = error(message.error.message || 'combat worker operation failed', message.error.code || 'WORKER_COMMAND');
        this._settle(task, e);
        this._closeSession(task.session, e, true);
      } else {
        if (task.op === 'init') task.session.initialized = true;
        this._settle(task, null, message.dto);
      }
    }
    this._pump(slot);
  }

  _closeSession(session, failure, notify = false) {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session.generation);
    const slot = session.slot;
    slot.sessions.delete(session);
    const removed = slot.queue.filter((task) => task.session === session);
    slot.queue = slot.queue.filter((task) => task.session !== session);
    for (const task of removed) this._settle(task, failure);
    if (slot.active?.session === session) this._settle(slot.active, failure);
    if (session.sent && slot.ready) slot.cleanup.add(session.generation);
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
      slot.active = null;
    }
    // Register termination before callbacks: an onFailure callback may itself await pool.close().
    const terminated = this._terminate(worker);
    for (const session of [...slot.sessions]) this._closeSession(session, failure, true);
    slot.queue = [];
    slot.cleanup.clear();
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
