// server/match/match/unitePhase.js — Match methods: 联防 glue (the rules: server/match/unite.js) — the UNITE phase in
// both modes (the 联防 field from the helpers' carried state and the leakers' enemies), its end, and the leakers' live
// counts (_uniteLeft, user playtest #6 item 7; _uniteTick in the server-run mode).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, GEO } from '../../../shared/constants.js';
import { WorkerFieldRunner } from '../combat/runner.js';
import { deriveSeed } from '../../sim/rng.js';
import { uniteBattleOpts, uniteSurvivors, planUniteRelay, uniteRelayHelpers } from '../unite.js';
import { FieldRunner, timelineAt, uniteBillBounds } from '../fields.js';
import { uniteLeft } from '../../sim/spec.js';
import { FLOW_TICKER_PRIORITY, DELAYS } from './common.js';
import { msg } from '../../../shared/i18n.js';

export class MatchUnite {
  startUnite(plan) {
    if (this.twentyPlayerMode && !this.alivePlayers().length) { this.settle(null, null); return; }
    if (plan.uniteRound === 1) this._uniteRelay = { rounds: [], eligible: new Set() };
    if (plan.uniteRound && !this.clientCombat) plan.battleId = `${this.battlePrefix}.${this.round}.${++this._battleSeq}.relay${plan.uniteRound}`;
    if (this.clientCombat) { this._startUniteClient(plan); return; }
    this.phase = PHASE.UNITE;
    this.unitePlan = plan;
    const limit = this.uniteTimeLimit(plan);
    if (this.twentyPlayerMode && !(limit > 0)) { this.settle(plan, null); return; }
    const opts = this._uniteOpts(plan, limit);
    const players = plan.helpers.map((p) => p.playerId);
    this.fields = [this.combatPool ? this._remoteField(opts, players)
      : { fieldId: opts.fieldId, kind: 'unite', players, battle: this.newBattle(opts), live: true }];
    this._beginDamage('unite');
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this._defaultWatch();
    this.markPublic();
    this.tickerText(msg('联防阶段：{names} 迎战突破防线的敌人', { names: plan.helpers.map((p) => p.name) }), FLOW_TICKER_PRIORITY);
    this._uniteLeftKey = null;
    const Runner = this.combatPool ? WorkerFieldRunner : FieldRunner;
    this.runner = new Runner(this, this.fields, {
      onTick: (runner) => this._uniteTick(runner),
      onDone: (runner) => {
        if (this.phase !== PHASE.UNITE || this.runner !== runner || this.unitePlan !== plan) return;
        this._sampleDamage(true, true);
        this._flushDamage(true);
        const field = runner.fields[0];
        this._finishUniteField(plan, runner.resultOf(field), field);
      },
    });
    this._defaultWatch();
    this.markPublic();
    this.runner.start();
  }

  /** Twenty-mode has one frozen stage budget; only a viable distinct relay reserves a second share. */
  uniteTimeLimit(plan) {
    const base = this.wave ? this.wave.timeLimit : 60;
    if (!this.twentyPlayerMode) return base;
    if (!this._uniteBudget) {
      const entryAlive = this.alivePlayers().length;
      const total = Math.min(300, (base ?? 60) * entryAlive / 4);
      this._uniteBudget = { entryAlive, base: base ?? 60, total, remaining: total };
    }
    const budget = this._uniteBudget;
    plan.totalBudget = budget.total;
    plan.remainingBudget = budget.remaining;
    plan.gameSpeed = this.gameSpeed;
    plan.timeLimit = budget.remaining / (uniteRelayHelpers(this, plan).length ? 2 : 1);
    plan.budgetSpent = 0;
    return plan.timeLimit;
  }

  /** Natural terminals consume max parallel game time, never CPU time or an unreleased headless result. */
  _consumeUniteBudget(plan, res, field) {
    if (!this.twentyPlayerMode || !this._uniteBudget) return;
    const time = Number.isFinite(res?.time) ? res.time : Number(field.battle?.time) || 0;
    const spent = Math.min(plan.timeLimit, Math.max(plan.budgetSpent, time, 0));
    this._uniteBudget.remaining = Math.max(0, this._uniteBudget.remaining - (spent - plan.budgetSpent));
    plan.budgetSpent = spent;
  }

  /**
   * Battle options of the 联防 field (helpers' carried end state, the leakers' enemies) on the round's battlefield, its
   * terrain, crates, water, devices and runes included (unite.js header; the owner's decision of 2026-10-07 — 0.2.0's
   * escaped-level map is withdrawn). The field meta and the client-run spec carry the match stageId, so every viewer
   * draws the battlefield the boards stand on.
   */
  _uniteOpts(plan, limit) {
    const { wave, players } = uniteBattleOpts(this, plan, limit);
    return {
      seed: deriveSeed(this.seed, plan.uniteRound === 2 ? `u:${this.round}:2` : `u:${this.round}`),
      ...(plan.uniteRound ? { battleId: plan.battleId } : {}),
      kind: 'unite',
      modeId: this.modeId,
      round: this.round,
      stageId: this.stageId,
      rect: { ...GEO.UNITE_RECT },
      timeLimit: limit,
      players,
      spawns: this._sanitizeSpawns(wave.spawns),
      routes: wave.routes,
      sharedBoss: null,
      flags: { layerGainsEnabled: false, ...this.gd.dp },
      fieldId: plan.uniteRound === 2 ? 'u:2' : 'u',
      // leaked enemies re-enter with the stats they had: the round template's stat overrides apply again
      enemyOverrides: this.wave && this.wave.overrides ? this.wave.overrides : {},
      waveId: wave.templateId,
    };
  }

  _startUniteClient(plan) {
    this.phase = PHASE.UNITE;
    this.unitePlan = plan;
    const limit = this.uniteTimeLimit(plan);
    if (this.twentyPlayerMode && !(limit > 0)) { this.settle(plan, null); return; }
    const opts = this._uniteOpts(plan, limit);
    const f = this._ccField({ fieldId: opts.fieldId, kind: 'unite', players: plan.helpers.map((p) => p.playerId), opts });
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this.watchers.clear();
    this._launch([f]);
    this._beginDamage('unite');
    this._flushDamage(true);
    // helpers and everyone else (as observers, spectator seats included) simulate the same 联防 spec locally
    for (const ps of this._viewers()) {
      this.watchers.set(ps.playerId, f.fieldId);
      this._sendStart(ps.playerId, f, { watch: !f.players.includes(ps.playerId) });
    }
    this.markPublic();
    this.tickerText(msg('联防阶段：{names} 迎战突破防线的敌人', { names: plan.helpers.map((p) => p.name) }), FLOW_TICKER_PRIORITY);
  }

  _finishUniteClient() {
    if (this.phase !== PHASE.UNITE) return;
    const f = this.fields[0];
    const res = f.result;
    this._stopClientCombat();
    this._finishUniteField(this.unitePlan, res, f);
  }

  /** Archive a natural terminal once; a distinct field/generation owns the next relay. No LP is charged here. */
  _finishUniteField(plan, res, field) {
    if (this.disposed || this.ended || this.phase !== PHASE.UNITE || this.unitePlan !== plan
      || !this.fields.includes(field) || field.uniteCompleted
      || this.twentyPlayerMode && (field.cc ? !field.done : !field.battle?.finished)) return;
    field.uniteCompleted = true;
    this._consumeUniteBudget(plan, res, field);
    this._collectSimErrors(field, res);
    field.live = false;
    this.deadline = 0;
    if (this._uniteRelay && plan.uniteRound) {
      const survivors = res && !res.synthetic ? uniteSurvivors(plan, res) : new Map(plan.notReentered);
      if (!res || res.synthetic) for (const l of plan.leaked) {
        survivors.set(l.sourcePlayerId, (survivors.get(l.sourcePlayerId) || 0) + 1);
      }
      const eligible = this._revivalHelpers(plan, res);
      for (const pid of eligible) {
        const pp = res.perPlayer[pid];
        // Leak records belong to the helper's half; sourcePlayerId remains the original leaker billed for LP.
        if (pp.perfect !== false && !(pp.leaked || []).some((l) => l && l.counted !== false)) this._uniteRelay.eligible.add(pid);
      }
      this._uniteRelay.rounds.push({ plan, result: res, survivors,
        view: { round: plan.uniteRound, fieldId: field.fieldId,
          battleId: field.battleId || field.spec?.battleId || field.battle?.opts?.battleId,
          helpers: plan.helpers.map((ps) => ps.playerId),
          through: plan.leakers.reduce((n, ps) => n + (survivors.get(ps.playerId) || 0), 0) } });
    }
    this.markPublic();
    this.later(this.scaled(DELAYS.COMBAT_END), () => {
      if (this.phase !== PHASE.UNITE || this.unitePlan !== plan || !this.fields.includes(field) || field.uniteReleased) return;
      field.uniteReleased = true;
      const next = this.twentyPlayerMode && !(this._uniteBudget.remaining > 0) ? null
        : planUniteRelay(this, plan, res, field.spec?.spawns || field.battle?.opts?.spawns);
      if (next) {
        this.runner?.stop();
        this.runner = null;
        this._stopClientCombat();
        this.startUnite(next);
      } else this.settle(plan, res);
    });
  }

  /**
   * 联防 (user playtest #6 item 7; PRTS 卫戍协议/帮助 "防卫失败的玩家可通过上方信息栏确认自身所属敌人的剩余数量"): how many of
   * a leaker's enemies are still standing on the 联防 field — not spawned yet, alive, or through the objective again —
   * plus its leaks that could not re-enter: what settle() charges it (before the per-round cap) if the 联防 ended now.
   * It falls as the helpers strike them down and rises when one splits or summons (the children carry the leaker).
   * Live from the field (client run: the authority's b.progress `left`; server run: the headless timeline on the field
   * clock, or the streamed battle itself), clamped to what settlement can bill that leaker (fields.js uniteBillBounds:
   * sent in + the offspring bound, validateClientResult's budget); exact once the field has its result (unite.js
   * uniteSurvivors; a synthetic result charges the own leaks, as settle()). null for anyone but a leaker of the running
   * 联防.
   * @returns {number|null}
   */
  _uniteLeft(ps) {
    const plan = this.unitePlan;
    if (this.phase !== PHASE.UNITE || !plan || !ps || !plan.leakers.includes(ps)) return null;
    const pid = ps.playerId;
    const f = this.fields.find((x) => x && x.kind === 'unite') || null;
    let res = null;
    if (f && f.cc) res = f.done ? f.result : null;
    else if (f && f.battle && f.battle.finished) { try { res = f.battle.result(); } catch { res = null; } }
    if (res && res.synthetic) {
      if (plan.uniteRound) return plan.leaked.filter((l) => l.sourcePlayerId === pid).length + (plan.notReentered.get(pid) || 0);
      const own = this.lastResults.get(pid);
      return own && Array.isArray(own.leaked) ? own.leaked.filter((l) => l && l.counted !== false).length : 0;
    }
    if (res) return uniteSurvivors(plan, res).get(pid) || 0;
    const sent = plan.leaked.filter((l) => l.sourcePlayerId === pid).length;
    let live = null;
    if (f && f.cc) {
      if (f.mode === 'server' && f.timeline) {
        const sample = timelineAt(f.timeline, this._fieldElapsed(f));
        live = sample && sample[3] && typeof sample[3] === 'object' ? sample[3] : null;
      } else live = f.progress && f.progress.left && typeof f.progress.left === 'object' ? f.progress.left : null;
    } else if (f?.remote) live = f.battle.left;
    else if (f && f.battle) {
      try { live = uniteLeft(f.battle); } catch { live = null; }
    }
    if (!this._uniteBounds || this._uniteBounds.plan !== plan) this._uniteBounds = { plan, bounds: uniteBillBounds(plan.leaked, this.gd) };
    const bound = this._uniteBounds.bounds.get(pid) ?? sent;
    const standing = live ? Math.min(bound, Math.max(0, Math.trunc(Number(live[pid]) || 0))) : sent;
    return standing + (plan.notReentered.get(pid) || 0);
  }

  /** Server-run 联防 (streaming mode): refresh m.public about once a game second when a leaker's count moved. */
  _uniteTick(runner) {
    if (!runner.remote) this._sampleDamage();
    const f = runner && runner.fields ? runner.fields[0] : null;
    if (!f || !f.battle || (runner.remote ? !runner.secondTick : runner.ticks % 30 !== 0)) return;
    let key = '';
    try { key = JSON.stringify(f.remote ? f.battle.left : uniteLeft(f.battle)); } catch { key = ''; }
    if (key === this._uniteLeftKey) return;
    this._uniteLeftKey = key;
    this.markPublic();
  }
}
