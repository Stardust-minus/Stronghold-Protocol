// A phase, not a field, is the isolation boundary: all boss fields share HP, LP and tick ordering.
import { FieldRunner, DeadBattle, GAME_SPEED, HARD_CAP_SECONDS, MAX_TICKS_PER_INTERVAL, snapFrame, eventFrame, battleLayerGains } from '../fields.js';
import { SharedBossPool } from '../finalAssault.js';
import { GameData, COMBAT_TIME_SCALE, DEFAULTS } from '../gamedata.js';
import { createBattleFromSpec, battleProgress, uniteLeft } from '../../sim/spec.js';
import { combatData } from './data.js';
import { damageFrame, emptyDamageRows } from '../../sim/damageBoard.js';
import { MAX_PLAYER_CAPACITY } from '../../../shared/playerCapacity.js';
import { isSyncTick, stateHash } from '../../sim/syncHash.js';

export const DAMAGE_INTERVAL_MS = 1000;

export const MAX_ADVANCE_TICKS = 1024;
const QUIET = Object.freeze({ error() {}, warn() {}, info() {} });
const finite = (n, d = 0) => Number.isFinite(n) ? n : d;

// Keep FieldRunner's actual step / onTick / second-finished-check semantics. Only the transport differs.
class EngineRunner extends FieldRunner {
  constructor(m, fields, hooks) {
    super(m, fields, hooks);
    this.beforeStep = (field) => this.m.engine._beforeStep(field);
    this.afterStep = (field) => this.m.engine._afterStep(field);
  }
  _emitStart(field) { this.m.engine._emitStart(field); }
  _emit(field) { this.m.engine._emit(field); }
  _forceField(field, reason) {
    this.m.engine._saveErrors(field);
    this.m.engine._noteEnd(field, reason);
    super._forceField(field, reason);
  }
}

export class CombatEngine {
  constructor({ specs, boss = null, wireFrames = false, coalesceFrames = false, damageBoard = false, snapshotHz = 20, gameSpeed = GAME_SPEED,
    metaOnDemand = false, terminalOnce = false, stepTimes = false },
    { data, log = QUIET, BattleClass, now = () => performance.now(), cloneOutput = true } = {}) {
    if (!Array.isArray(specs) || specs.length > MAX_PLAYER_CAPACITY) throw new TypeError(`specs must contain at most ${MAX_PLAYER_CAPACITY} fields`);
    // A leader phase remains ONE worker / ONE SharedBossPool, with at most ten pair fields.
    if ((boss || specs.some(s => s?.kind === 'boss' || s?.kind === 'hidden')) && specs.length > MAX_PLAYER_CAPACITY / 2) {
      throw new TypeError('boss specs must contain at most ten fields');
    }
    const ids = new Set();
    for (const s of specs) {
      if (!s || typeof s.fieldId !== 'string' || ids.has(s.fieldId)) throw new TypeError('unique fieldId required');
      ids.add(s.fieldId);
    }
    if (specs.some((s) => s.kind === 'boss' || s.kind === 'hidden') && !boss) throw new TypeError('shared boss config required');
    const ds = combatData(data);
    this.log = log;
    this.damageBoard = damageBoard === true;
    this.now = now;
    this.wireFrames = wireFrames === true;
    this.coalesceFrames = this.wireFrames && coalesceFrames === true;
    this.coalescing = false;
    // WorkerFieldRunner opts in to both (it keeps the consistent meta/snapshot pair and the 1s terminal retry itself):
    // live frames carry field meta only for metaFields, state replies and finished fields; a finished field without a
    // shared Boss pool (its final view can no longer change) sends its terminal frame/result once, not every reply.
    this.metaOnDemand = metaOnDemand === true;
    this.terminalOnce = terminalOnce === true;
    // with each field's result its step time on this Worker (shadow statistics; WorkerFieldRunner opts in — a timing,
    // so a DTO compared across runs leaves it out)
    this.stepTimes = stepTimes === true;
    this.metaFields = new Set();
    this.stateOutput = false;
    // A Worker posts each reply synchronously (postMessage copies it then); inline callers keep their isolated copy.
    this.cloneOutput = cloneOutput !== false;
    this.disposed = false;
    this.frames = [];
    this.effects = [];
    this.watched = new Set();
    // Fields shown to a browser's local display replica: their state digest after every sync tick (syncHash.js).
    this.synced = new Set();
    this.syncs = [];
    this.detachers = [];
    this.diagnostics = new Map(specs.map((s) => [s.fieldId, []]));
    this.boss = null;
    this.pool = null;
    if (boss) {
      const maxHp = Math.max(1, finite(boss.maxHp, 1));
      this.boss = {
        teamLp: Math.max(0, finite(boss.teamLp)),
        overtimeApplied: Math.max(0, finite(boss.overtimeApplied)),
        combatTimeScale: boss.combatTimeScale > 0 && Number.isFinite(boss.combatTimeScale) ? boss.combatTimeScale : COMBAT_TIME_SCALE,
        bossOvertimeAfterReal: Math.max(0, finite(boss.bossOvertimeAfterReal, DEFAULTS.bossOvertimeAfter)),
        bossOvertimeDrainReal: Math.max(0, finite(boss.bossOvertimeDrainReal, DEFAULTS.bossOvertimeDrainPerSec)),
      };
      this.pool = new SharedBossPool(maxHp, {
        onHit: (playerId, amount) => this.effects.push({ type: 'bossDamage', playerId, amount }),
      });
      this.pool.hp = Math.max(0, Math.min(maxHp, finite(boss.hp, maxHp)));
    }
    this.fields = specs.map((spec) => {
      const f = { fieldId: spec.fieldId, kind: spec.kind, round: spec.round,
        players: (spec.players || []).map((p) => p.playerId), battle: null };
      if (this.damageBoard) { f.damageRows = emptyDamageRows(spec); f.damageAt = -Infinity; }
      try {
        f.battle = createBattleFromSpec(spec, ds, { sharedBoss: this.pool, BattleClass, logger: log });
      } catch (e) {
        this._error(`battle ${f.fieldId} construct`, e, f.fieldId);
        f.battle = new DeadBattle(spec);
      }
      // A boss field's record of the pool for local display replicas (b.ext, sim/spec.js ReplayBossPool): `last` = the
      // pool after this field's previous step, `hp` = the [tick, hp] entries not yet output, `end` = its forced end.
      if (this.pool && (f.kind === 'boss' || f.kind === 'hidden')) f.ext = { last: this.pool.hp, hp: [], end: null, endOut: false };
      if (this.boss && (f.kind === 'boss' || f.kind === 'hidden')) {
        const b = f.battle;
        try {
          const leak = b.on('enemyLeak', (ctx) => {
            if (!ctx?.enemy) return;
            const lpr = ctx.enemy.lpr;
            this._lpLoss(Number.isFinite(lpr) && lpr >= 0 ? lpr : 1);
          }, { priority: -1000, owner: 'match' });
          this.detachers.push(() => b.off(leak));
          const loss = b.on('lpLoss', (ctx) => this._lpLoss(ctx?.amount), { priority: -1000, owner: 'match' });
          this.detachers.push(() => b.off(loss));
        } catch (e) { this._error('boss leak hook', e, f.fieldId); }
      }
      return f;
    });
    const facade = {
      engine: this, snapshotHz, gameSpeed,
      markPublic() {},
      reportError: (label, e) => this._error(label, e),
    };
    this.runner = new EngineRunner(facade, this.fields, {
      onDone() {},
      onTick: this.boss ? (runner) => {
        // Call the original formula, including whole-real-second rounding and fractional drain rates.
        const due = GameData.prototype.bossOvertimeDue.call(this.boss, runner.time);
        if (due > this.boss.overtimeApplied) {
          const loss = due - this.boss.overtimeApplied;
          this.boss.overtimeApplied = due;
          this._lpLoss(loss);
        }
        if (this.boss.teamLp <= 0 && this.pool.hp > 0) runner.forceAll('forced');
      } : null,
    });
    this.runner._checkDone();
  }

  _error(label, error, fieldId = null) {
    const record = { label, who: '', message: String(error?.message ?? error), stack: error?.stack ?? null };
    const ids = fieldId ? [fieldId] : this.fields?.filter((f) => label.startsWith(`field ${f.fieldId} `)).map((f) => f.fieldId) || [];
    if (!ids.length) ids.push(...this.diagnostics.keys());
    for (const id of ids) {
      const list = this.diagnostics.get(id);
      if (list && list.length < 100 && !list.some((e) => e.label === label && e.message === record.message)) list.push(record);
    }
    try { this.log?.error?.(`[combat] ${label}: ${record.message}`); } catch { /* logging cannot break a phase */ }
  }

  _saveErrors(f) {
    const list = this.diagnostics.get(f.fieldId);
    for (const e of f.battle.errors || []) {
      if (list.length < 100 && !list.some((x) => x.label === e.label && x.who === e.who && x.message === e.message)) list.push({ ...e });
    }
  }

  _lpLoss(amount) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return;
    this.boss.teamLp = Math.max(0, this.boss.teamLp - n);
    this.effects.push({ type: 'lpLoss', amount: n });
  }

  _emitStart(f) {
    if (!Array.isArray(f.battle._startUnitStats)) return;
    try {
      const meta = f.battle.fieldMeta({ includeUnitStats: true });
      if (!Array.isArray(meta.unitStats)) return;
      const msg = { t: 'm.field', ...meta, fieldId: f.fieldId, kind: f.kind, live: !!f.live };
      this.frames.push(this.wireFrames ? { fieldId: f.fieldId, startMetaWire: JSON.stringify(msg) }
        : structuredClone({ fieldId: f.fieldId, startMeta: msg }));
    } catch (e) { this._error(`field ${f.fieldId} start stats`, e); }
  }

  /**
   * Right before a boss field's step: the pool when other fields changed it since this field's previous step — the one
   * input a replica of this field cannot compute itself (sim/spec.js ReplayBossPool). Every boss field keeps its record
   * from the first tick, watched or not: a browser that starts its replica later replays it from the spec.
   */
  _beforeStep(f) {
    const x = f.ext;
    if (!x) return;
    const h = this.pool.hp;
    if (h !== x.last && !(h !== h && x.last !== x.last)) x.hp.push([(Number(f.battle.tickCount) || 0) + 1, h]);
  }

  /** A forced end of a boss field (team LP 0, the hard cap, forceField): replicas end after the same step. */
  _noteEnd(f, reason) {
    if (f.ext && !f.ext.end && !f.battle.finished) f.ext.end = { tick: Number(f.battle.tickCount) || 0, reason: String(reason) };
  }

  /** Digest a synced field right after its step, before any snapshot of that tick reads lazy stats. */
  _afterStep(f) {
    if (f.ext) f.ext.last = this.pool.hp;
    if (!this.synced.has(f.fieldId) || f.syncDone) return;
    const b = f.battle;
    if (!isSyncTick(b)) return;
    try {
      const done = !!b.finished;
      if (done) f.syncDone = true;
      this.syncs.push(done ? { fieldId: f.fieldId, tick: Number(b.tickCount) || 0, h: stateHash(b), done: true }
        : { fieldId: f.fieldId, tick: Number(b.tickCount) || 0, h: stateHash(b) });
    } catch (e) { this._error(`field ${f.fieldId} sync hash`, e); }
  }

  _metaDue(f) {
    return !this.metaOnDemand || this.stateOutput || !f.live || this.metaFields.has(f.fieldId);
  }

  _frame(f, events = []) {
    let snapshot = null, meta = null;
    const withMeta = this._metaDue(f);
    try { snapshot = f.battle.snapshot(); } catch (e) { this._error(`field ${f.fieldId} snapshot`, e); }
    if (withMeta) try { meta = f.battle.fieldMeta(); } catch (e) { this._error(`field ${f.fieldId} fieldMeta`, e); }
    if (this.wireFrames) {
      // Encode at this exact tick boundary, once for all watchers. Only immutable strings cross the
      // worker port: no snapshot/event/meta object-tree cloning or per-viewer main-thread encoding.
      const snap = snapFrame(f.fieldId, snapshot);
      this.frames.push({
        fieldId: f.fieldId,
        snapshotWire: JSON.stringify(snap),
        eventsWire: events.length ? JSON.stringify({ t: 'b.ev', fieldId: f.fieldId, gt: snap.gt, ev: events }) : null,
        metaWire: withMeta ? JSON.stringify({ t: 'm.field', ...meta, fieldId: f.fieldId, kind: f.kind, live: !!f.live }) : null,
      });
    } else {
      // Also isolate inline DTOs: a later command may not mutate a previously returned frame/result.
      this.frames.push(structuredClone({ fieldId: f.fieldId, events, snapshot, meta }));
    }
  }

  _emit(f, force = false) {
    let events = [];
    try { events = f.battle.drainEvents() || []; } catch (e) { this._error(`field ${f.fieldId} drainEvents`, e); }
    if (!this.watched.has(f.fieldId) && f.live) return;
    if (force || this.runner._snapshotDue(f)) this._frame(f, events);
    else if (events.length) {
      // Events retain the original boundary/gt even when snapshot and UnitInfo encoding are skipped.
      const msg = eventFrame(f.fieldId, f.battle, events);
      this.frames.push(this.wireFrames ? { fieldId: f.fieldId, eventsWire: JSON.stringify(msg) }
        : structuredClone({ fieldId: f.fieldId, events, gt: msg.gt }));
    }
  }

  /** A finished field whose terminal frame/result already went out and whose final view cannot change. */
  _terminalSent(f) {
    return this.terminalOnce && !f.live && f.terminalSent === true && !f.battle?.sharedBoss;
  }

  /** Later events of a field whose unchanged terminal frame is not re-sent keep their original b.ev wire. */
  _emitEvents(f) {
    let events = [];
    try { events = f.battle.drainEvents() || []; } catch (e) { this._error(`field ${f.fieldId} drainEvents`, e); }
    if (!events.length) return;
    const msg = eventFrame(f.fieldId, f.battle, events);
    this.frames.push(this.wireFrames ? { fieldId: f.fieldId, eventsWire: JSON.stringify(msg) }
      : structuredClone({ fieldId: f.fieldId, events, gt: msg.gt }));
  }

  _begin(snapshotFields = [], coalescing = false, metaFields = [], syncFields = []) {
    if (this.disposed) throw new Error('combat engine disposed');
    if (!Array.isArray(snapshotFields)) throw new TypeError('snapshotFields must be an array');
    if (!Array.isArray(metaFields)) throw new TypeError('metaFields must be an array');
    if (!Array.isArray(syncFields)) throw new TypeError('syncFields must be an array');
    this.watched = new Set(snapshotFields);
    this.metaFields = new Set(metaFields);
    this.synced = new Set(syncFields);
    this.syncs = [];
    this.frames = [];
    this.coalescing = this.coalesceFrames && coalescing;
  }

  _damage(f, now, force = false) {
    if (!force && (f.damageFinal || now - f.damageAt < DAMAGE_INTERVAL_MS)) return null;
    try { if (typeof f.battle.damageRows === 'function') f.damageRows = f.battle.damageRows(); }
    catch (e) { this._error(`field ${f.fieldId} damageRows`, e); }
    f.damageAt = now;
    f.damageFinal = !f.live;
    const frame = damageFrame(f, f.damageRows);
    return this.wireFrames ? { fieldId: f.fieldId, damageWire: JSON.stringify(frame), gt: frame.gt }
      : structuredClone({ fieldId: f.fieldId, damageRows: f.damageRows, gt: frame.gt });
  }

  _output({ state = false, final = false } = {}) {
    const damageFrames = [];
    if (this.damageBoard) {
      const now = this.now();
      // All owners feed the round ledger even if nobody watched their field. Real time, not 2x game time.
      for (const f of this.fields) {
        const frame = this._damage(f, now, state || final || (!f.live && !f.damageFinal));
        if (frame) damageFrames.push(frame);
      }
    }
    // forceAll in onTick can finish after the ordinary emit point. Always return a current terminal frame,
    // even with no watchers, and do not reuse an earlier frame whose boss state/meta is now stale.
    for (const f of this.fields) {
      if (state && (this.watched.has(f.fieldId) || !f.live)) this._frame(f);
      else if (this._terminalSent(f) && !final) this._emitEvents(f);
      else if (!f.live || final) {
        this._emit(f, true);
        if (!f.live) f.terminalSent = true;
      }
    }
    const fields = this.fields.map((f) => {
      const b = f.battle;
      let progress = null, left = null;
      try { progress = battleProgress(b); } catch (e) { this._error(`field ${f.fieldId} progress`, e); }
      if (f.kind === 'unite') {
        try { left = uniteLeft(b); } catch (e) { this._error(`field ${f.fieldId} left`, e); }
      }
      // A once-sent result is retained by RemoteBattle; state/final replies still carry it.
      const sendResult = !f.live && (!this._terminalSent(f) || !f.resultSent || state || final);
      const result = sendResult ? this.runner.resultOf(f) : undefined;
      if (sendResult) f.resultSent = true;
      this._saveErrors(f);
      return {
        fieldId: f.fieldId, kind: f.kind, players: f.players, live: f.live,
        time: Number(b.time) || 0, tickCount: Number(b.tickCount) || 0,
        killed: Number(b.killed) || 0, total: Number(b.total) || 0,
        resolved: Number.isFinite(b.resolved) ? Math.max(0, Math.min(Number(b.total) || 0, Math.trunc(b.resolved))) : null,
        progress, left, layerGains: battleLayerGains(b), errors: this.diagnostics.get(f.fieldId), ...(result ? { result } : {}),
        // with the result: the field's step time on this Worker (shadow statistics, server/match/verify/hub.js)
        ...(result && this.stepTimes ? { stepMs: Math.round((f.stepMs || 0) * 1000) / 1000 } : {}),
        ...(this.damageBoard && sendResult ? { damageRows: f.damageRows } : {}),
      };
    });
    // the boss pool record since the last output (b.ext): complete through `ticks`
    const ext = [];
    for (const f of this.fields) {
      const x = f.ext;
      if (!x || (!x.hp.length && (!x.end || x.endOut))) continue;
      ext.push({ fieldId: f.fieldId, hp: x.hp, ...(x.end && !x.endOut ? { end: x.end } : {}) });
      x.hp = [];
      if (x.end) x.endOut = true;
    }
    const output = {
      ticks: this.runner.ticks, time: this.runner.time, done: this.runner.done,
      fields, effects: this.effects,
      ...(this.syncs.length ? { syncs: this.syncs } : {}),
      ...(ext.length ? { ext } : {}),
      ...(this.damageBoard ? { damageFrames } : {}),
      boss: this.boss ? {
        maxHp: this.pool.maxHp, hp: this.pool.hp, byPlayer: [...this.pool.byPlayer],
        teamLp: this.boss.teamLp, overtimeApplied: this.boss.overtimeApplied,
      } : null,
    };
    const dto = this.cloneOutput ? structuredClone(output) : output;
    // Frames were already detached at their individual tick boundaries; don't clone their heavy unit
    // arrays a second time here (postMessage will perform the one necessary cross-thread copy).
    if (this.coalescing) {
      // A delayed command may cover several snapshot intervals. Keep every ordered event wire (including
      // spawn UnitInfo and its original gt), but only the last consistent snapshot/meta pair per field.
      // Do not merge/re-time events or change simulation/effect/result ordering to smooth the transport.
      const latest = new Map();
      const events = [];
      for (const frame of this.frames) {
        if (frame.startMetaWire) events.push(frame);
        if (frame.snapshotWire) latest.set(frame.fieldId, { ...frame, eventsWire: null });
        if (frame.eventsWire) events.push({ fieldId: frame.fieldId, eventsWire: frame.eventsWire });
      }
      dto.frames = [...events, ...latest.values()];
    } else dto.frames = this.frames;
    this.effects = [];
    this.frames = [];
    this.syncs = [];
    return dto;
  }

  advance(ticks, { snapshotFields = [], metaFields = [], syncFields = [] } = {}) {
    if (!Number.isInteger(ticks) || ticks < 0 || ticks > MAX_ADVANCE_TICKS) throw new RangeError(`ticks must be 0..${MAX_ADVANCE_TICKS}`);
    this._begin(snapshotFields, ticks > MAX_TICKS_PER_INTERVAL, metaFields, syncFields);
    for (let i = 0; i < ticks && !this.runner.done; i++) {
      this.runner._tick();
      if (this.runner.time >= HARD_CAP_SECONDS) this.runner._forceAll('timeout');
      this.runner._checkDone();
    }
    return this._output();
  }

  state({ snapshotFields = [] } = {}) {
    this._begin(snapshotFields);
    this.stateOutput = true;
    try { return this._output({ state: true }); } finally { this.stateOutput = false; }
  }

  forceField(id, reason = 'forced') {
    this._begin();
    const f = this.fields.find((field) => field.fieldId === id);
    if (!f) throw new Error(`unknown field ${id}`);
    if (f.live) this.runner._forceField(f, reason);
    this.runner._checkDone();
    return this._output();
  }

  forceAll(reason = 'forced') {
    this._begin();
    this.runner.forceAll(reason);
    return this._output();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.runner.stop();
    for (const detach of this.detachers) { try { detach(); } catch { /* unusable battle */ } }
    this.detachers = [];
    if (this.pool) this.pool.onHit = null;
    this.fields.length = 0;
    this.diagnostics.clear();
    this.frames = [];
    this.effects = [];
    this.syncs = [];
    this.watched.clear();
    this.synced.clear();
  }
}
