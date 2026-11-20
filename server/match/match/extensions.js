// Server-authoritative Worker transport, damage ledger and room-owned experimental rescue.
import { PHASE, ERR } from '../../../shared/constants.js';
import { msg } from '../../../shared/i18n.js';
import { createDamageBoard } from '../damageBoard.js';
import { emptyDamageRows } from '../../sim/damageBoard.js';
import { buildBattleSpec } from '../../sim/spec.js';
import { morphBattleOpt } from '../../../shared/plugins/rules.js';
import { RemoteBattle } from '../combat/runner.js';
import { createPoolGroups, dealChessShares, dealItemShares, poolGroupOf, splitPoolGroup } from '../pool.js';
import { createRng } from '../../sim/rng.js';
import { REVIVAL_COST, REVIVAL_MIN_DONOR_LP, REVIVAL_UNAVAILABLE_REASONS, FLOW_TICKER_PRIORITY, OK, fail } from './common.js';
import { buildOutResult } from '../results.js';
import { eloWillRescue } from '../tilt.js';

const DAMAGE_PUBLIC_MS = 1000;

export class MatchExtensions {
  /**
   * The seat groups of this match's chess pools (pool.js createPoolGroups): the constructor, a setup reroll, a restore.
   * 卡池静态初始化 (staticPoolSplit) splits every group of two seats or more (pool.js splitPoolGroup) and deals it with an
   * rng of its own, seeded by the match and `revision` (the setup the groups are for: a reroll deals its new pools again),
   * so no other stream of the match moves; a restore (`deal` false) sets the saved shares instead (snapshot.js).
   */
  buildPoolGroups(banned, { legacySix = false, deal = true, revision = this.setupRevision ?? 0 } = {}) {
    const groups = createPoolGroups(this.gd, this.order, { banned, experimental: this.capacityExperiment, independent: this.disableSharedPool,
      fixedChunks: this.twentyPlayerMode, legacySix, plan: this.poolPlan });
    if (this.staticPoolSplit) {
      const rng = deal ? createRng(this.streamSeed(`pool-split:${revision}`)) : null;
      for (const g of groups) splitPoolGroup(this.gd, g, rng);
    }
    return groups;
  }

  /** seat → its group's pool (its own share in a split group), whenever a seat cannot simply read `pool` (null in an ordinary match). */
  routePools(poolGroups) {
    return this.disableSharedPool || this.capacityExperiment || this.poolPlan || this.staticPoolSplit
      ? new Map(poolGroups.flatMap(g => g.playerIds.map(id => [id, g.shares?.get(id) ?? g.pool]))) : null;
  }

  /**
   * 卡池静态初始化: `ps` is out of its split group — eliminated, or gone (中途退出 is an elimination: platform.js _quit) —
   * and its pieces went back to its share (PlayerState.eliminate): every copy the group has left, chess and equipment, is
   * dealt again among the seats still in it (pool.js dealChessShares / dealItemShares). A seat still in: alive, or a death
   * still waiting for its rescue (队友复活) — if that one is finalized too, the group is dealt again then. A seat AI 托管
   * plays on (g.autoplay, the offline takeover, an AI seat a spectator took over) is not out and keeps its share. The rng is
   * the match's, salted by the round and the seat, so a replayed round deals the same.
   */
  _redealPools(ps) {
    if (!this.staticPoolSplit) return;
    const g = poolGroupOf(this, ps);
    if (!g?.shares) return;
    const seats = g.playerIds.filter((id) => { const p = this.players.get(id); return !!p && (p.alive || p.pendingDeath === true); });
    if (!seats.length) return;
    const rng = createRng(this.streamSeed(`pool-redeal:${this.round}:${ps.playerId}`));
    dealChessShares(g, seats, rng);
    dealItemShares(this.gd, g, seats, rng, (id) => this.playerItemPools.get(id));
    for (const id of seats) this.players.get(id)?.dirty();
    this.log?.info?.(`[match ${this.roomCode}] pool group ${g.id} dealt again among ${seats.length} seats (R${this.round}, ${ps.playerId} out)`);
  }

  poolFor(player) {
    const id = typeof player === 'string' ? player : player?.playerId;
    if (this.capacityExperiment && !this.players.has(id)) throw new TypeError('player card pool required');
    if (!this.playerPools) return this.pool;
    const pool = this.playerPools.get(id);
    if (!pool) throw new TypeError('player card pool required');
    return pool;
  }

  /** The equipment stock a seat draws from: its chess-pool group's (pool.js createItemPools). */
  itemPoolFor(player) {
    const id = typeof player === 'string' ? player : player?.playerId;
    const pool = this.playerItemPools.get(id);
    if (pool) return pool;
    if (this.poolGroups.length > 1) throw new TypeError('player item stock required');
    return this.itemPool;
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
      const finals = this.damageBoard.finals;
      this.damageBoard = createDamageBoard(this.battlePrefix);
      this.damageBoard.previousRound = previous;
      // the re-fought scope freezes again: only the other final scope's packet carries over
      if (finals && typeof finals === 'object') this.damageBoard.finals = Object.fromEntries(Object.entries(finals).filter(([k]) => k !== phase));
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
    // Fighting boss players see only their own group's operator statistics, also while they watch the other group's
    // field (allowed since round 83, PR #971: the display, not the statistics).
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
    // A room of another official version names its content, as a client-run spec does (clientCombat.js _ccField): a local
    // display replica runs on that version's data (the runner's ensureSim(spec.cs)). A default room's spec keeps its keys.
    const spec = buildBattleSpec({ ...opts, ...morphBattleOpt(this.rules), content: this.battleContent,
      boss: this.bossPool ? { poolHp: this.bossPool.hp, poolMax: this.bossPool.maxHp } : null,
      ...(this.requireCs ? { cs: this.cs, vs: this.vs, version: this.data.config?.version?.id } : {}) });
    return { remote: true, fieldId: spec.fieldId, kind: spec.kind, players, spec, battle: new RemoteBattle(spec), live: true };
  }

  /**
   * The rescue donors of this SETTLE (rel35, the owner: 「队友复活移除不漏怪的要求」): every teammate still in the match as
   * the round settles — a leaker, a 联防 helper or neither, in a round with or without a 联防 (an all-leak round settles
   * straight from COMBAT). Whether one can pay is decided later (revivalDonorEligible: alive, not left, LP >= 11 after this
   * round's loss). Until rel34 only the round's leak-free 联防 helpers who fought on the field qualified — and a helper is
   * leak-free by definition (unite.js planUnite), so dropping only the leak condition would have changed nothing. Since
   * §37.274 (the owner, 2026-11-20: AI teammates rescue too) the AI seats are in it as well: an AI pays for a human
   * teammate on its own as the window opens (_aiRescues), never for another AI (revivalDonorFor), and only a human sends
   * g.revive. The Set keeps its checkpoint shape: an older build restoring this SETTLE skips the AI ids (its own
   * revivalDonorEligible refuses AI seats).
   */
  _revivalDonors() {
    const donors = new Set();
    if (!this.revivalEnabled) return donors;
    for (const ps of this.order) {
      if (this.players.get(ps.playerId) === ps && !ps.left && ps.alive) donors.add(ps.playerId);
    }
    return donors;
  }

  revivalWindowOpen() {
    const state = this._revival;
    return !!(this.revivalEnabled && !this.ended && !this.disposed && this.phase === PHASE.SETTLE
      && this.teamLp == null && state && state.windowOpen && state.round === this.round && this.sched.now() < state.deadline);
  }

  /** The rule's own terms of a donor, human or AI: alive, not left, LP >= 11 after this round's loss, a donor of this SETTLE. */
  revivalDonorEligible(ps) {
    return !!(ps && !ps.left && ps.alive && Number.isFinite(ps.lp) && ps.lp >= REVIVAL_MIN_DONOR_LP
      && this._revival?.round === this.round && this._revival.eligible.has(ps.playerId));
  }

  /** Who may pay for whom (§37.274): a human for any teammate, an AI for a human teammate only — no AI rescues an AI. */
  revivalDonorFor(donor, target) { return !!(donor && target && donor !== target && (!donor.isBot || !target.isBot)); }

  revivalTargetEligible(ps) { return !!(ps && ps.pendingDeath && !ps.alive && !ps.left && !ps.revived); }

  /** Whether the death of `ps` (LP just ran out) can be put off for a rescue: some donor of this SETTLE may pay for it. */
  _revivalRescuable(ps) {
    return !!(this.revivalEnabled && this.teamLp == null
      && this.order.some((p) => this.revivalDonorFor(p, ps) && this.revivalDonorEligible(p)));
  }

  _revivalDeathReason(ps) {
    if (ps.left) return 'left';
    if (ps.revived) return 'already-used';
    if (!this.revivalEnabled) return 'disabled';
    if (this.teamLp != null || this.ended || this.disposed) return 'match-ended';
    // a teammate whose LP ran out in the same settlement is no donor (still `alive` until its own death is handled)
    const helpers = this.order.filter((p) => this.revivalDonorFor(p, ps) && this.players.get(p.playerId) === p && !p.left && p.alive
      && !(p.lp <= 0) && this._revival?.round === this.round && this._revival.eligible.has(p.playerId));
    if (!helpers.length) return 'no-helper';
    return helpers.every((p) => Number.isFinite(p.lp) && p.lp < REVIVAL_MIN_DONOR_LP) ? 'donor-lp' : 'window-closed';
  }

  /** Put the death off for the rescue window; settle tells the player once the AI rescues are done (settle.js). */
  _deferDeath(ps) {
    ps.revivalUnavailableReason = null;
    ps.lp = 0;
    ps.alive = false;
    ps.pendingDeath = true;
    ps.dirty();
  }

  /**
   * THE decision hook of an AI rescue (§37.274): whether the AI `bot` pays for the pending human `target` now. Asked only
   * once the rule's terms hold (bot: alive, not left, LP >= 11; target: pending, never rescued), in the order the AIs would
   * pay (most LP first, ties by seat), until one says yes. true by default — every AI rescues; in an ELO room (§37.275,
   * tilt.js eloWillRescue) a target the tilt hinders (s < 0) only with chance 1 + s, one draw of the match's own stream of
   * this round and target. Must not change any state: it may be asked about several AIs for one target.
   */
  aiWillRescue(_bot, target) { return eloWillRescue(this, target); }

  /**
   * The AI teammates' rescues (§37.274, the owner 2026-11-20), as the SETTLE window opens: every pending human, in seat
   * order, is rescued by the AI with the most LP that may pay (ties: the lower seat) and that aiWillRescue lets. A death a
   * human could still cancel waits for the window; when no human can pay, what is still pending is final now (its reason
   * as an immediate death's) and no window opens. Called by settle only.
   */
  _aiRescues() {
    for (const target of this.order) {
      if (target.isBot || !this.revivalTargetEligible(target)) continue;
      const donors = this.order.filter((p) => p.isBot && this.revivalDonorFor(p, target) && this.revivalDonorEligible(p))
        .sort((a, b) => b.lp - a.lp || a.seat - b.seat);
      const donor = donors.find((p) => this.aiWillRescue(p, target) === true);
      if (donor) this._rescue(donor, target);
    }
    if (this.order.some((p) => !p.isBot && this.revivalDonorEligible(p))) return;
    for (const ps of this.order) if (ps.pendingDeath) this._finalizeDeath(ps);
  }

  _finalizeDeath(ps, { round = this.round, notify = true, reason = this._revivalDeathReason(ps) } = {}) {
    if (!ps.alive && !ps.pendingDeath) return false;
    if (ps.revivalUnavailableReason == null) {
      ps.revivalUnavailableReason = REVIVAL_UNAVAILABLE_REASONS.includes(reason) ? reason : 'window-closed';
    }
    ps.lp = 0;
    // feedback #111: a human knocked out while the match goes on gets its 个人战报 now (m.private `out`), built before its
    // board returns to the pool; the match's m.result still follows at the end
    if (!ps.isBot && !ps.left && !this.ended && !this.disposed) {
      try { ps.outResult = buildOutResult(this, ps, round); } catch { ps.outResult = null; }
    }
    ps.eliminate(round);
    this._redealPools(ps);
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
    this._rescue(ps, target);
    return OK;
  }

  /**
   * One rescue, a human's g.revive or an AI's (_aiRescues): `donor` pays REVIVAL_COST, `target` comes back at LP 1 with
   * everything it held. The callers have checked both. The rescued player's toast and everyone's ticker line name the
   * donor (§37.274: who rescued, a human or an AI — there was no such notice before).
   */
  _rescue(donor, target) {
    // Claim usage before any updates/hooks/views: another donor's duplicate request cannot spend twice.
    target.revived = true;
    target.alive = true;
    target.pendingDeath = false;
    target.revivalUnavailableReason = null;
    target.lp = 1;
    donor.lp -= REVIVAL_COST; // >=11 before payment: the donor always keeps at least 1 LP
    donor.stats.lpLost += REVIVAL_COST;
    // Bonds depend on the unchanged holdings; teammate effects read alivePlayers dynamically. No reset/reroll/hooks.
    target.dirty();
    donor.dirty();
    this.markPublic();
    this.toast(target, 'success', msg('{name}博士支付 10 点生命救下了你，你回到 1 点生命', { name: donor.name }));
    this.tickerText(msg('{donor}博士支付 10 点生命，救下了{target}博士', { donor: donor.name, target: target.name }), FLOW_TICKER_PRIORITY);
  }

}
