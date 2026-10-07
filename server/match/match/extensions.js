// Server-authoritative Worker transport, damage ledger and room-owned experimental rescue.
import { PHASE, ERR } from '../../../shared/constants.js';
import { msg } from '../../../shared/i18n.js';
import { createDamageBoard } from '../damageBoard.js';
import { emptyDamageRows } from '../../sim/damageBoard.js';
import { buildBattleSpec } from '../../sim/spec.js';
import { RemoteBattle } from '../combat/runner.js';
import { REVIVAL_COST, REVIVAL_MIN_DONOR_LP, REVIVAL_UNAVAILABLE_REASONS, FLOW_TICKER_PRIORITY, OK, fail } from './common.js';

const DAMAGE_PUBLIC_MS = 1000;

export class MatchExtensions {
  poolFor(player) {
    if (!this.playerPools) return this.pool;
    const pool = this.playerPools.get(typeof player === 'string' ? player : player?.playerId);
    if (!pool) throw new TypeError('player card pool required');
    return pool;
  }

  sendEncoded(playerId, type, data) {
    if (this.disposed || !['m.field', 'b.snap', 'b.ev', 'b.damage', 'm.damage'].includes(type) || typeof data !== 'string') return false;
    const ps = this.players.get(playerId) || this.spectators.get(playerId);
    if (!ps || ps.isBot || ps.left) return false;
    try {
      if (typeof this.opts.sendEncoded === 'function') return !!this.opts.sendEncoded(playerId, type, data);
      return this.sendTo(playerId, JSON.parse(data)); // capture-only fixtures / embedding without an encoded transport
    } catch (e) { this.reportError('send encoded', e); return false; }
  }

  _beginDamage(phase) {
    this.cancel(this._damageTimer);
    this._damageTimer = null;
    // A forced phase replacement may reuse the same round/field ids; only its new field objects may write scores.
    if (phase !== 'unite' && this.damageBoard.round === this.round && this.damageBoard.phase === phase) {
      const previous = this.damageBoard.freeze();
      this.damageBoard = createDamageBoard(this.battlePrefix);
      this.damageBoard.previousRound = previous;
    }
    this.damageBoard.startCombat(this.round, phase, this.order);
    this._damageSampleAt = -Infinity;
    this._damageSent.clear();
    this._damageDirty = true;
    if (!this.clientCombat) for (const f of this.fields) {
      this._onDamageRows(f, emptyDamageRows(f.spec || f.battle?.opts || { players: f.players.map((playerId) => ({ playerId })) }));
    }
    this._sampleDamage(true);
  }

  _onDamageRows(f, rows, { final = null } = {}) {
    if (this.clientCombat || this.disposed || this.ended || !this.fields.includes(f)
      || f.kind !== this.damageBoard.phase || this.round !== this.damageBoard.round) return false;
    if (this.damageBoard.replaceField({ matchId: this.battlePrefix, round: this.round, phase: f.kind,
      kind: f.kind, fieldId: f.fieldId, gt: f.remote ? f.battle._damageGt ?? f.battle.time : f.battle.time || 0,
      owners: rows?.owners, final: final ?? (!f.live || !!f.battle.finished) })) this._damageDirty = true;
    return false; // Match sends the complete permitted round ledger, not per-field raw-score broadcasts.
  }

  _sampleDamage(force = false, final = false) {
    if (this.clientCombat || this.damageBoard.status !== 'live') return;
    const now = this.sched.now();
    if (!force && (this.paused || now - this._damageSampleAt < DAMAGE_PUBLIC_MS)) return;
    this._damageSampleAt = now;
    for (const f of this.fields) {
      if (!force && f.remote) continue;
      if (typeof f.battle?.damageRows !== 'function') continue;
      try { this._onDamageRows(f, f.battle.damageRows(), { final: final ? true : null }); }
      catch (e) { this.reportError('damage rows', e); }
    }
  }

  _damagePacket() {
    const packet = this.damageBoard.packet();
    // Browser-authoritative results are not a trusted operator meter. Preserve their existing combat authority.
    return packet && this.clientCombat ? { ...packet, owners: [], available: false } : packet;
  }

  _damageView(ps, packet) {
    // Same restriction as watch(): fighting boss players may never see the other group's operator statistics.
    // A frozen score remains restricted while boss fields are displayed; no-field PREP follows prep scouting rules.
    if (ps.alive && (this.phase === PHASE.FINAL_ASSAULT || this.phase === PHASE.HIDDEN_CORE)) {
      const own = this.fields.find((f) => f.players.includes(ps.playerId));
      if (own) return { ...packet, owners: packet.owners.filter((row) => own.players.includes(row.playerId)) };
    }
    return packet;
  }

  _sendDamageTo(playerId) {
    const ps = this.players.get(playerId) || this.spectators.get(playerId);
    const packet = this._damagePacket();
    if (!ps?.connected || ps.left || !packet) return;
    const wire = JSON.stringify(this._damageView(ps, packet));
    if (this.sendEncoded(playerId, 'm.damage', wire)) this._damageSent.set(playerId, wire);
  }

  _flushDamage(force = false) {
    if (this.disposed || (!force && !this._damageDirty)) return;
    const now = this.sched.now();
    if (!force && now - this._damageAt < DAMAGE_PUBLIC_MS) {
      if (!this._damageTimer) this._damageTimer = this.later(Math.max(1, DAMAGE_PUBLIC_MS - (now - this._damageAt)), () => {
        this._damageTimer = null;
        this._flushDamage();
      });
      return;
    }
    this.cancel(this._damageTimer);
    this._damageTimer = null;
    this._damageDirty = false;
    this._damageAt = now;
    const packet = this._damagePacket();
    if (!packet) return;
    const wires = new Map();
    for (const ps of this._viewers()) {
      if (!ps.connected) continue;
      const own = ps.alive && (this.phase === PHASE.FINAL_ASSAULT || this.phase === PHASE.HIDDEN_CORE) ? this.fieldOf(ps) : null;
      const key = own || 'all';
      let wire = wires.get(key);
      if (!wire) { wire = JSON.stringify(this._damageView(ps, packet)); wires.set(key, wire); }
      if (!force && this._damageSent.get(ps.playerId) === wire) continue;
      if (this.sendEncoded(ps.playerId, 'm.damage', wire)) this._damageSent.set(ps.playerId, wire);
    }
  }

  _freezeDamage(send = true) {
    this._sampleDamage(true, true);
    if (this.damageBoard.freeze()) this._damageDirty = true;
    this.cancel(this._damageTimer);
    this._damageTimer = null;
    if (send) this._flushDamage(true);
  }

  _cancelBotPrep(ps) {
    ps._botPrepToken = (ps._botPrepToken || 0) + 1;
    ps._botPrepWork?.cancel();
  }

  _remoteField(opts, players) {
    const spec = buildBattleSpec({ ...opts, content: this.battleContent,
      boss: this.bossPool ? { poolHp: this.bossPool.hp, poolMax: this.bossPool.maxHp } : null });
    return { remote: true, fieldId: spec.fieldId, kind: spec.kind, players, spec, battle: new RemoteBattle(spec), live: true };
  }

  _revivalHelpers(plan, uniteResult) {
    const eligible = new Set();
    if (!this.revivalEnabled || this.phase !== PHASE.UNITE || !plan || plan !== this.unitePlan
      || !uniteResult || uniteResult.synthetic || !['cleared', 'timeout'].includes(uniteResult.reason)) return eligible;
    const field = this.fields.find((f) => f.kind === 'unite' && !f.live);
    if (!field) return eligible;
    for (const ps of plan.helpers) {
      const normal = this.lastResults.get(ps.playerId);
      if (this.players.get(ps.playerId) !== ps || !field.players.includes(ps.playerId)
        || !uniteResult.perPlayer?.[ps.playerId] || !normal || normal.synthetic || normal.perfect === false
        || (normal.leaked || []).some((l) => l && l.counted !== false)) continue;
      eligible.add(ps.playerId);
    }
    return eligible;
  }

  revivalWindowOpen() {
    const state = this._revival;
    return !!(this.revivalEnabled && !this.ended && !this.disposed && this.phase === PHASE.SETTLE
      && this.teamLp == null && state && state.windowOpen && state.round === this.round && this.sched.now() < state.deadline);
  }

  revivalDonorEligible(ps) {
    return !!(ps && !ps.isBot && !ps.left && ps.alive && Number.isFinite(ps.lp) && ps.lp >= REVIVAL_MIN_DONOR_LP
      && this._revival?.round === this.round && this._revival.eligible.has(ps.playerId));
  }

  revivalTargetEligible(ps) { return !!(ps && ps.pendingDeath && !ps.alive && !ps.left && !ps.revived); }

  _revivalDeathReason(ps) {
    if (ps.left) return 'left';
    if (ps.revived) return 'already-used';
    if (!this.revivalEnabled) return 'disabled';
    if (this.teamLp != null || this.ended || this.disposed) return 'match-ended';
    const helpers = this.order.filter((p) => this.players.get(p.playerId) === p && !p.isBot && !p.left && p.alive
      && this._revival?.round === this.round && this._revival.eligible.has(p.playerId));
    if (!helpers.length) return 'no-helper';
    return helpers.every((p) => Number.isFinite(p.lp) && p.lp < REVIVAL_MIN_DONOR_LP) ? 'donor-lp' : 'window-closed';
  }

  _deferDeath(ps) {
    ps.revivalUnavailableReason = null;
    ps.lp = 0;
    ps.alive = false;
    ps.pendingDeath = true;
    ps.dirty();
    this.toast(ps, 'warn', msg('你的目标生命值耗尽，等待救援'));
  }

  _finalizeDeath(ps, { round = this.round, notify = true, reason = this._revivalDeathReason(ps) } = {}) {
    if (!ps.alive && !ps.pendingDeath) return false;
    if (ps.revivalUnavailableReason == null) {
      ps.revivalUnavailableReason = REVIVAL_UNAVAILABLE_REASONS.includes(reason) ? reason : 'window-closed';
    }
    ps.lp = 0;
    ps.eliminate(round);
    if (notify) {
      this.toast(ps, 'error', msg('你的目标生命值耗尽，已被淘汰'));
      this.tickerText(msg('{name}博士的目标生命值已耗尽', { name: ps.name }), FLOW_TICKER_PRIORITY);
    }
    return true;
  }

  _finalizePendingDeaths({ notify = true, reason = this.ended || this.disposed ? 'match-ended'
    : this._revival?.deadline > 0 && this.sched.now() >= this._revival.deadline ? 'window-expired' : 'window-closed' } = {}) {
    if (this._revival) this._revival.windowOpen = false;
    for (const ps of this.order) if (ps.pendingDeath) this._finalizeDeath(ps, { notify, reason });
  }

  revive(ps, msg) {
    if (!this.revivalEnabled) return fail(ERR.WRONG_PHASE, 'revival-disabled');
    if (!this.revivalWindowOpen()) return fail(ERR.WRONG_PHASE, 'revival-window-closed');
    if (msg.matchId !== this.battlePrefix) return fail(ERR.BAD_TARGET, 'stale-match');
    if (!Number.isInteger(msg.round) || msg.round !== this.round) return fail(ERR.WRONG_PHASE, 'stale-round');
    if (!ps || ps.isBot || ps.left) return fail(ERR.NOT_IN_ROOM);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (!this.revivalDonorEligible(ps)) return fail(ERR.BAD_TARGET, ps.lp < REVIVAL_MIN_DONOR_LP ? 'revival-lp-insufficient' : 'revival-not-helper');
    const target = this.players.get(msg.playerId);
    if (target && !target.alive && !target.pendingDeath && !target.left && !target.revived) return fail(ERR.BAD_TARGET, 'revival-target-finalized');
    if (target === ps || !this.revivalTargetEligible(target)) return fail(ERR.BAD_TARGET, 'revival-target-ineligible');
    // Claim usage before any updates/hooks/views: another donor's duplicate request cannot spend twice.
    target.revived = true;
    target.alive = true;
    target.pendingDeath = false;
    target.revivalUnavailableReason = null;
    target.lp = 1;
    ps.lp -= REVIVAL_COST; // >=11 before payment: the donor always keeps at least 1 LP
    ps.stats.lpLost += REVIVAL_COST;
    // Bonds depend on the unchanged holdings; teammate effects read alivePlayers dynamically. No reset/reroll/hooks.
    target.dirty();
    ps.dirty();
    this.markPublic();
    return OK;
  }

}
