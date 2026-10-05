// A phase, not a field, is the isolation boundary: all boss fields share HP, LP and tick ordering.
import { FieldRunner, DeadBattle, HARD_CAP_SECONDS, MAX_TICKS_PER_INTERVAL, snapFrame } from '../fields.js';
import { SharedBossPool } from '../finalAssault.js';
import { GameData, COMBAT_TIME_SCALE, DEFAULTS } from '../gamedata.js';
import { createBattleFromSpec, battleProgress, uniteLeft } from '../../sim/spec.js';
import { combatData } from './data.js';
import { damageFrame, emptyDamageRows } from '../../sim/damageBoard.js';

export const DAMAGE_INTERVAL_MS = 1000;

export const MAX_ADVANCE_TICKS = 1024;
const QUIET = Object.freeze({ error() {}, warn() {}, info() {} });
const finite = (n, d = 0) => Number.isFinite(n) ? n : d;

// Keep FieldRunner's actual step / onTick / second-finished-check semantics. Only the transport differs.
class EngineRunner extends FieldRunner {
  _emit(field) { this.m.engine._emit(field); }
  _forceField(field, reason) {
    this.m.engine._saveErrors(field);
    super._forceField(field, reason);
  }
}

export class CombatEngine {
  constructor({ specs, boss = null, wireFrames = false, coalesceFrames = false, damageBoard = false },
    { data, log = QUIET, BattleClass, now = () => performance.now() } = {}) {
    if (!Array.isArray(specs) || specs.length > 4) throw new TypeError('specs must contain at most four fields');
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
    this.disposed = false;
    this.frames = [];
    this.effects = [];
    this.watched = new Set();
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
      engine: this,
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

  _frame(f, events = []) {
    let snapshot = null, meta = null;
    try { snapshot = f.battle.snapshot(); } catch (e) { this._error(`field ${f.fieldId} snapshot`, e); }
    try { meta = f.battle.fieldMeta(); } catch (e) { this._error(`field ${f.fieldId} fieldMeta`, e); }
    if (this.wireFrames) {
      // Encode at this exact tick boundary, once for all watchers. Only immutable strings cross the
      // worker port: no snapshot/event/meta object-tree cloning or per-viewer main-thread encoding.
      const snap = snapFrame(f.fieldId, snapshot);
      this.frames.push({
        fieldId: f.fieldId,
        snapshotWire: JSON.stringify(snap),
        eventsWire: events.length ? JSON.stringify({ t: 'b.ev', fieldId: f.fieldId, gt: snap.gt, ev: events }) : null,
        metaWire: JSON.stringify({ t: 'm.field', ...meta, fieldId: f.fieldId, kind: f.kind, live: !!f.live }),
      });
    } else {
      // Also isolate inline DTOs: a later command may not mutate a previously returned frame/result.
      this.frames.push(structuredClone({ fieldId: f.fieldId, events, snapshot, meta }));
    }
  }

  _emit(f) {
    let events = [];
    try { events = f.battle.drainEvents() || []; } catch (e) { this._error(`field ${f.fieldId} drainEvents`, e); }
    if (this.watched.has(f.fieldId) || !f.live) this._frame(f, events);
  }

  _begin(snapshotFields = [], coalescing = false) {
    if (this.disposed) throw new Error('combat engine disposed');
    if (!Array.isArray(snapshotFields)) throw new TypeError('snapshotFields must be an array');
    this.watched = new Set(snapshotFields);
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
      else if (!f.live || final) this._emit(f);
    }
    const fields = this.fields.map((f) => {
      const b = f.battle;
      let progress = null, left = null;
      try { progress = battleProgress(b); } catch (e) { this._error(`field ${f.fieldId} progress`, e); }
      if (f.kind === 'unite') {
        try { left = uniteLeft(b); } catch (e) { this._error(`field ${f.fieldId} left`, e); }
      }
      const result = !f.live ? this.runner.resultOf(f) : undefined;
      this._saveErrors(f);
      return {
        fieldId: f.fieldId, kind: f.kind, players: f.players, live: f.live,
        time: Number(b.time) || 0, tickCount: Number(b.tickCount) || 0,
        killed: Number(b.killed) || 0, total: Number(b.total) || 0,
        progress, left, errors: this.diagnostics.get(f.fieldId), ...(result ? { result } : {}),
        ...(this.damageBoard && !f.live ? { damageRows: f.damageRows } : {}),
      };
    });
    const dto = structuredClone({
      ticks: this.runner.ticks, time: this.runner.time, done: this.runner.done,
      fields, effects: this.effects,
      ...(this.damageBoard ? { damageFrames } : {}),
      boss: this.boss ? {
        maxHp: this.pool.maxHp, hp: this.pool.hp, byPlayer: [...this.pool.byPlayer],
        teamLp: this.boss.teamLp, overtimeApplied: this.boss.overtimeApplied,
      } : null,
    });
    // Frames were already detached at their individual tick boundaries; don't clone their heavy unit
    // arrays a second time here (postMessage will perform the one necessary cross-thread copy).
    if (this.coalescing) {
      // A delayed command may cover several snapshot intervals. Keep every ordered event wire (including
      // spawn UnitInfo and its original gt), but only the last consistent snapshot/meta pair per field.
      // Do not merge/re-time events or change simulation/effect/result ordering to smooth the transport.
      const latest = new Map();
      const events = [];
      for (const frame of this.frames) {
        latest.set(frame.fieldId, { ...frame, eventsWire: null });
        if (frame.eventsWire) events.push({ fieldId: frame.fieldId, eventsWire: frame.eventsWire });
      }
      dto.frames = [...events, ...latest.values()];
    } else dto.frames = this.frames;
    this.effects = [];
    this.frames = [];
    return dto;
  }

  advance(ticks, { snapshotFields = [] } = {}) {
    if (!Number.isInteger(ticks) || ticks < 0 || ticks > MAX_ADVANCE_TICKS) throw new RangeError(`ticks must be 0..${MAX_ADVANCE_TICKS}`);
    this._begin(snapshotFields, ticks > MAX_TICKS_PER_INTERVAL);
    for (let i = 0; i < ticks && !this.runner.done; i++) {
      this.runner._tick();
      if (this.runner.time >= HARD_CAP_SECONDS) this.runner._forceAll('timeout');
      this.runner._checkDone();
    }
    return this._output();
  }

  state({ snapshotFields = [] } = {}) {
    this._begin(snapshotFields);
    return this._output({ state: true });
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
    this.watched.clear();
  }
}
