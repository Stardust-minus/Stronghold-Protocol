// Main-thread adapter for a server-streamed phase owned by one combat worker. Only views/results cross the boundary;
// Match still owns players, watchers, phase transitions and settlement. At most one command is in flight per phase.
import { TICK } from '../../sim/constants.js';
import { INTERVAL_MS, GAME_SPEED, HARD_CAP_SECONDS, snapFrame } from '../fields.js';

// Bound each FIFO worker turn, not the active game-time debt. At 2x this covers a 533 ms service cycle.
export const MAX_WORKER_ADVANCE_TICKS = 32;

/** Read-only view of the last accepted worker state, not a resumable simulation snapshot. */
export class RemoteBattle {
  constructor(spec) {
    this.fieldId = spec.fieldId;
    this.kind = spec.kind;
    this.time = 0;
    this.tickCount = 0;
    this.killed = 0;
    this.total = 0;
    this.finished = false;
    this.errors = [];
    this.progress = null;
    this.left = null;
    this._result = null;
    this._meta = null;
    this._snapshot = null;
    this._metaWire = null;
    this._snapshotWire = null;
    this.runner = null;
  }
  result() { return this._result; }
  fieldMeta() { return this._meta || (this._metaWire ? JSON.parse(this._metaWire) : null); }
  snapshot() {
    if (this._snapshot || !this._snapshotWire) return this._snapshot;
    const { t, gt, ...rest } = JSON.parse(this._snapshotWire);
    void t;
    return { ...rest, t: gt };
  }
  forceEnd(reason) { this.runner?.forceField(this.fieldId, reason); }
  update(view) {
    this.time = view.time;
    this.tickCount = view.tickCount;
    this.killed = view.killed;
    this.total = view.total;
    this.finished = !view.live;
    this.errors = view.errors || [];
    this.progress = view.progress;
    this.left = view.left;
    if (view.result) this._result = view.result;
  }
}

export class WorkerFieldRunner {
  constructor(m, fields, { onTick = null, onDone, boss = null }) {
    this.m = m;
    this.fields = fields;
    this.onTick = onTick;
    this.onDone = onDone;
    this.boss = boss;
    this.remote = true;
    this.ticks = 0;
    this.done = false;
    this.stopped = false;
    this.session = null;
    this.interval = null;
    this.inflight = false;
    this.ready = false;
    this.held = null;
    this.acc = 0;
    this.last = 0;
    this.resync = new Map();
    this.controls = new Map();
    for (const f of fields) f.battle.runner = this;
  }

  get time() { return this.ticks * TICK; }
  get active() { return !this.stopped && !this.done && !this.m.disposed && !this.m.ended && this.m.runner === this; }

  start() {
    this.last = this.m.sched.now();
    try {
      this.inflight = true;
      this.session = this.m.combatPool.create({ specs: this.fields.map((f) => f.spec), boss: this.boss, wireFrames: true, coalesceFrames: true }, {
        onFailure: (e) => this._fail(e),
      });
      this.session.ready.then((out) => this._receive(out, true), (e) => this._fail(e));
      this.interval = this.m.sched.setInterval(() => this.m.guard(() => this._pump()), INTERVAL_MS);
    } catch (e) { this._fail(e); }
  }

  stop() {
    this.stopped = true;
    this._release();
    this.resync.clear();
    this.controls.clear();
    this.held = null;
  }

  _release() {
    if (this.interval) { this.m.sched.clearInterval(this.interval); this.interval = null; }
    this.session?.close();
    this.session = null;
  }

  /** A pause holds a pre-pause in-flight reply without applying its frames, effects or settlement. */
  resume() {
    this.last = this.m.sched.now();
    // Intentional pause boundary: discard pre-pause unsent debt as before, never simulate paused wall time.
    this.acc = 0;
    if (this.held && this.active) {
      const out = this.held;
      this.held = null;
      this._receive(out);
    }
  }

  _pump() {
    if (!this.active) return;
    const now = this.m.sched.now();
    const dt = Math.max(0, now - this.last);
    this.last = now;
    const speed = Number.isFinite(this.m.gameSpeed) && this.m.gameSpeed > 0 ? this.m.gameSpeed : GAME_SPEED;
    // Active time remains owed even while the parent/worker queue is delayed. The phase hard cap bounds this
    // scalar debt; the command budget below bounds work/frames and preserves fair FIFO turns, not elapsed time.
    if (this.ready && !this.m.paused && !this.held) this.acc = Math.min(this.acc + dt / 1000 * speed, Math.max(0, HARD_CAP_SECONDS - this.time));
    if (this.inflight || !this.ready || this.held) return;
    // Controls are bounded by the phase's fields; nobody can enqueue a backlog of step or snapshot commands.
    if (this.controls.size) {
      const [key, command] = this.controls.entries().next().value;
      this.controls.delete(key);
      this._request(command.op, command.payload);
      return;
    }
    if (this.m.paused) return;
    for (const [pid, fid] of this.resync) {
      const ps = this.m.players.get(pid);
      if (!ps?.connected || ps.left || this.m.watchers.get(pid) !== fid) this.resync.delete(pid);
    }
    if (this.resync.size) {
      this._request('state', { snapshotFields: [...new Set(this.resync.values())] });
      return;
    }
    const n = Math.min(Math.floor(this.acc / TICK + 1e-9), MAX_WORKER_ADVANCE_TICKS);
    this.acc = Math.max(0, this.acc - n * TICK);
    if (n > 0) this._request('advance', { ticks: n, snapshotFields: this.fields.filter((f) => this._watchers(f.fieldId).length).map((f) => f.fieldId) });
  }

  _request(op, payload) {
    if (!this.active || this.inflight) return;
    this.inflight = true;
    try {
      this.session.request(op, payload).then((out) => this._receive(out), (e) => this._fail(e));
    } catch (e) { this._fail(e); }
  }

  _receive(out, initial = false) {
    if (!this.active) return;
    this.inflight = false;
    if (initial) { this.ready = true; this.last = this.m.sched.now(); }
    if (this.m.paused) { this.held = out; return; }
    this.m.guard(() => {
      try {
        this._apply(out);
        // One reply can admit at most one new bounded command. No timer/microtask spin when there is no debt;
        // the pool's existing FIFO still places this turn after other phases already waiting on the worker.
        if (this.active && !this.m.paused) this._pump();
      } catch (e) { this._fail(e); }
    });
  }

  _apply(out) {
    const before = this.ticks;
    this.ticks = out.ticks;
    for (const view of out.fields) {
      const f = this.fields.find((x) => x.fieldId === view.fieldId);
      if (!f) throw new Error('combat worker returned an unknown field');
      if (f.live !== view.live) this.m.markPublic();
      f.live = view.live;
      f.battle.update(view);
    }
    // Replay ordered deltas once, then reconcile the authoritative totals. The main-thread pool is a HUD/stat mirror;
    // no live Battle has access to it. Threshold tickers still observe each hit in the original order.
    for (const effect of out.effects || []) {
      if (effect.type === 'bossDamage') this.m.bossPool.damage(effect.playerId, effect.amount);
      else if (effect.type === 'lpLoss') this.m._teamLpLoss(effect.amount);
    }
    if (out.boss) {
      this.m.bossPool.hp = out.boss.hp;
      this.m.bossPool.byPlayer = new Map(out.boss.byPlayer);
      this.m.teamLp = out.boss.teamLp;
      this.m.overtimeApplied = out.boss.overtimeApplied;
      this.m._syncTeamLp();
    }
    const latest = new Map((out.frames || []).map((frame) => [frame.fieldId, frame]));
    for (const frame of out.frames || []) {
      const f = this.fields.find((x) => x.fieldId === frame.fieldId);
      if (!f) continue;
      // Catch-up event-only frames retain their original gt/order without replacing a consistent cached view.
      if (frame.snapshotWire || frame.snapshot) {
        f.battle._meta = frame.meta || null;
        f.battle._snapshot = frame.snapshot || null;
        f.battle._metaWire = frame.metaWire || null;
        f.battle._snapshotWire = frame.snapshotWire || null;
      }
      for (const pid of this._watchers(f.fieldId)) {
        if (this.resync.get(pid) === f.fieldId) {
          // Rejoin at the newest consistent tick in this batch, never send a current meta then an older snapshot.
          if (latest.get(f.fieldId) === frame) { this._sendCached(pid, f); this.resync.delete(pid); }
          continue;
        }
        if (frame.snapshotWire || frame.eventsWire) {
          if (frame.eventsWire) this.m.sendEncoded(pid, 'b.ev', frame.eventsWire);
          if (frame.snapshotWire) this.m.sendEncoded(pid, 'b.snap', frame.snapshotWire);
        } else {
          if (frame.events?.length) this.m.sendTo(pid, { t: 'b.ev', fieldId: f.fieldId, gt: frame.snapshot.t, ev: frame.events });
          this.m.sendTo(pid, snapFrame(f.fieldId, frame.snapshot));
        }
      }
    }
    // Batch boundaries need not land exactly on a tick divisible by 30.
    this.publicTick = Math.floor(before / 6) !== Math.floor(this.ticks / 6);
    this.secondTick = Math.floor(before / 30) !== Math.floor(this.ticks / 30);
    if (this.onTick) this.onTick(this);
    if (out.done && this.active) {
      this.done = true;
      this._release();
      this.onDone(this);
    }
  }

  _watchers(fieldId) {
    return this.m.watchersOf(fieldId).filter((pid) => {
      const ps = this.m.players.get(pid);
      return ps && ps.connected && !ps.left;
    });
  }

  _sendCached(pid, f) {
    const b = f.battle;
    if (b._metaWire && b._snapshotWire) {
      this.m.sendEncoded(pid, 'm.field', b._metaWire);
      this.m.sendEncoded(pid, 'b.snap', b._snapshotWire);
      return true;
    }
    if (!b._meta || !b._snapshot) return false;
    this.m.sendTo(pid, { t: 'm.field', ...b._meta, fieldId: f.fieldId, kind: f.kind, live: !!f.live });
    this.m.sendTo(pid, snapFrame(f.fieldId, b._snapshot));
    return true;
  }

  requestField(pid, fieldId) {
    const f = this.fields.find((x) => x.fieldId === fieldId);
    if (!f || this.stopped || this.m.disposed || this.m.ended) return;
    if (this.done || this.m.paused) {
      if (this._sendCached(pid, f)) return;
    }
    this.resync.set(pid, fieldId);
  }

  forceField(fieldId, reason = 'left') {
    if (!this.active || !this.fields.some((f) => f.fieldId === fieldId)) return;
    this.controls.set(fieldId, { op: 'forceField', payload: { fieldId, reason } });
  }

  forceAll(reason = 'forced') {
    if (!this.active) return;
    this.controls.clear();
    this.controls.set('*', { op: 'forceAll', payload: { reason } });
  }

  resultOf(f) {
    const result = f.battle.result();
    if (!result?.perPlayer) throw new Error(`combat worker result missing: ${f.fieldId}`);
    return result;
  }

  _fail(error) {
    if (!this.active) return;
    this.stop();
    this.m.guard(() => {
      this.m.reportError('combat worker failure', error);
      this.m.tickerText('战斗演算服务异常，本次模拟已中止；请重新开始。');
      // Never invent a winning battle or charge a fabricated timeout. A hidden-stage failure keeps the base victory.
      this.m.finish({ victory: this.m.hiddenReached, hiddenCleared: false, reason: 'error' });
    });
  }
}
