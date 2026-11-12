// server/match/match/platform.js — Match methods: the platform interface of the server/match/Match.js header
// (server/lobby.js ⇄ Match) — start, handle (validation, error isolation, flush; the intents themselves: intents.js
// _handle), setLoadout (INFO_CHECK; rule-enabled PREP), onDisconnect / onReconnect and the full resync of one human, onLeave and 中途退出
// = elimination (_quit), the AFK rule (挂机移出: _checkIdle at each prep end, _removeIdle — also a passed 投票移出), the AI taking over a seat
// offline too long (掉线由 AI 接管: _checkOffline at each prep end, released by onReconnect), dispose.
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { C2S, ACKED_INTENTS } from '../../../shared/protocol.js';
import { PHASE, ERR } from '../../../shared/constants.js';
import { syntheticResult } from '../fields.js';
import { FLOW_TICKER_PRIORITY, OK, fail, AFK_ACTIONS, OFFLINE_TAKEOVER_ROUNDS } from './common.js';
import { msg } from '../../../shared/i18n.js';
import { ruleOption } from '../../../shared/plugins/rules.js';

const GAME_TYPES = new Set(Object.keys(C2S).filter((t) => Object.hasOwn(C2S, t) && (t.startsWith('g.') || t.startsWith('b.'))));
const ACKED = new Set(ACKED_INTENTS);

export class MatchPlatform {
  start() {
    if (this.disposed || this.ended || this.phase !== PHASE.LOBBY) return;
    this.guard(() => {
      if (!this.gd.visibleChess.length || this.pool.entries.size === 0) {
        this.log.error?.(`[match ${this.roomCode}] game data unusable (no chess pool) — ending the match`);
        this.phase = PHASE.INFO_CHECK;
        this.markPublic();
        this.flush(true);
        this.finish({ victory: false, reason: 'error' });
        return;
      }
      this.enterInfoCheck();
    });
  }

  /**
   * @param {string} playerId
   * @param {{ t: string }} msg validated intent
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  handle(playerId, msg) {
    const ps = this.players.get(playerId) || this.spectators.get(playerId);
    if (!ps || ps.isBot || ps.left) return fail(ERR.NOT_IN_ROOM);
    return this._handleSeatIntent(ps, msg);
  }

  /** Shared human / external-AI semantic validation and dispatch. C2S schema: net.js / the adapter. */
  _handleSeatIntent(ps, msg) {
    // a spectator seat only watches (the platform routes nothing else of it)
    if (ps.spectator && (!msg || msg.t !== 'g.watch')) {
      // g.test shares the host's rate bucket (applyTestCommand audits SPECTATOR after the stamp).
      if (this.test && msg?.t === 'g.test') {
        let res;
        try { res = this.applyTestCommand(ps, msg); }
        catch (e) { this.reportError('handle g.test', e); res = fail(ERR.INTERNAL); }
        try { this.flush(); } catch (e) { this.reportError('flush', e); }
        return res && res.error ? res : OK;
      }
      return fail(ERR.SPECTATOR);
    }
    if (this.disposed || this.ended) {
      // A report that crossed the match end (the last b.progress of a field, a delegated rehearsal's answer) is stale:
      // ignored, never an error (DESIGN §14 — an error frame without a rid would surface as a toast in the browser).
      if (msg && msg.t === 'b.rehearsalResult') return OK;
      return this.clientCombat && msg && (msg.t === 'b.progress' || msg.t === 'b.result') ? OK : fail(ERR.WRONG_PHASE);
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string' || !GAME_TYPES.has(msg.t)) return fail(ERR.BAD_MSG);
    let res;
    try {
      res = this._handle(ps, msg);
    } catch (e) {
      this.reportError(`handle ${msg.t}`, e);
      res = fail(ERR.INTERNAL);
    }
    // the AFK rule counts accepted substantive intents only (a spectator's g.watch never is one)
    if (!(res && res.error) && AFK_ACTIONS.has(msg.t)) ps.afkActed = true;
    // client-side prediction (rel26, shared/protocol.js ACKED_INTENTS): the browser's rid of this prep intent, accepted
    // or refused, rides on the seat's next m.private as `ack` — the flush below sends it before the reply, and an
    // m.private that is queued behind the reply still names what it contains. Only a browser's request carries a rid
    // (an external AI's or a bot's intent never does).
    if (ACKED.has(msg.t) && Number.isInteger(msg.rid) && msg.rid > 0 && !ps.isBot) {
      ps.intentAck = msg.rid;
      this.markPrivate(ps);
    }
    try { this.flush(); } catch (e) { this.reportError('flush', e); }
    if (res && typeof res === 'object' && res.error) return res;
    return OK;
  }

  /** Host-only asynchronous input, journalled by testTrace; never a C2S message. */
  externalReply(id, reply, failed) {
    this.guard(() => this.externalAI?.receive(id, reply, failed));
  }

  /**
   * room.loadout during the match (DESIGN §16): only while INFO_CHECK runs (the briefing's 干员调配 entry); the lobby
   * already checked it against the data (PlayerState.setLoadout re-checks it). `ops` (0.2.2): the per-operator 潜能 /
   * 练度 that come with it (undefined = unchanged). A room whose prepLoadout rule is prep also accepts one merge
   * during PREP while that seat has not pressed 准备 (DESIGN §34.15). INFO_CHECK stays a full replace.
   * @param {string} playerId
   * @param {Record<string, { skill: number, module: string|null }> | null} loadout
   * @param {Record<string, { potential: number, cultivate: number }> | null} [ops]
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  setLoadout(playerId, loadout, ops = undefined) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left) return fail(ERR.NOT_IN_ROOM);
    const prep = this.phase === PHASE.PREP && ruleOption(this.rules, 'prepLoadout') === 'prep';
    if (this.disposed || this.ended || (this.phase !== PHASE.INFO_CHECK && !prep)) return fail(ERR.WRONG_PHASE, 'loadout locked for this match');
    if (prep && ps.ready) return fail(ERR.WRONG_PHASE, 'loadout locked for this match');
    let res = OK;
    this.guard(() => {
      const before = prep ? ps.allChess().map((owner) => ({ owner, loadout: ps.loadoutFor(ps.gd.chess(owner.id)) })) : [];
      if (!ps.setLoadout(loadout, ops, prep ? { merge: true } : undefined)) { res = fail(ERR.BAD_TARGET, 'loadout does not match the game data'); return; }
      if (prep) {
        for (const { owner, loadout: previous } of before) {
          const next = ps.loadoutFor(ps.gd.chess(owner.id));
          if (['skillIndex', 'moduleId', 'potential', 'cultivate'].some((key) => previous[key] !== next[key])) ps._reconcileTokensFor(owner);
        }
        ps.recompute();
      } else this.markPrivate(ps);
    });
    return res;
  }

  /** Display preferences may change only during the briefing; the lobby keeps later edits for the next match. */
  setSkins(playerId, choices) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left) return fail(ERR.NOT_IN_ROOM);
    if (this.disposed || this.ended || this.phase !== PHASE.INFO_CHECK) return fail(ERR.WRONG_PHASE, 'skins locked for this match; stored for the next match');
    let res = OK;
    this.guard(() => {
      if (!ps.setSkins(choices)) { res = fail(ERR.BAD_MSG, 'invalid skin choices'); return; }
      this.markPrivate(ps);
    });
    return res;
  }

  onDisconnect(playerId) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || this.disposed) return;
    this.guard(() => {
      ps.connected = false;
      // A disconnected human's silence is never consent: it is dropped from an open vote, which is recounted
      // (setupVote.js, kickVote.js).
      this._dropSetupVoter(playerId);
      this._kickVoteMemberGone(playerId);
      // the last human online gone: the match holds until one comes back (offlineHold.js) — a solo pause on goes with it
      this._updateOfflineHold();
      // otherwise a paused solo battle resumes (the server takes the field over; nobody is left to resume it)
      this._resume();
      if (this.clientCombat) this._authorityLost(ps, 'disconnect');
      // a rehearsal this host was running falls back to the server (DESIGN §14; a no-op without tasks)
      this._rehearsalHostChanged();
      this.markPublic();
    });
  }

  onReconnect(playerId) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left || this.disposed) return;
    this.guard(() => {
      const was = ps.connected;
      ps.connected = true;
      ps.offlineRounds = 0;
      // a match held for its offline humans moves on — before the resync, so it shows the shifted clocks
      this._updateOfflineHold();
      // a new socket (or a reloaded page, whose rids start over): no intent of it has been handled yet
      ps.intentAck = 0;
      // 掉线由 AI 接管: back in the match, the player plays the seat again (an AI 托管 of its own choice stays on)
      const released = ps.offlineAutoplay && ps.autoplay && !this.ended;
      ps.offlineAutoplay = false;
      // a kick vote against this seat ends with the takeover (kickVote.js)
      this._kickVoteMemberGone(playerId, true);
      if (released) {
        this.setAutoplay(ps, false);
        this.log.info?.(`[match ${this.roomCode}] seat ${ps.seat} back online: AI takeover released (R${this.round})`);
        this.tickerText(msg('{name}博士已重新连接，收回了 AI 托管的席位', { name: ps.name }), FLOW_TICKER_PRIORITY);
      }
      this._resync(ps);
      if (released) this.toast(ps, 'info', msg('你已重新连接，AI 托管已解除'));
      if (!was) this.markPublic();
    });
  }

  /**
   * The full state of one human (a reconnect, a resync, a spectator seat): m.public, its m.private (players only), the
   * field it is on / watches — a spectator, like an eliminated player, the field of the player it follows (item 56),
   * else the first; in a prep phase that player's board — or the result once ended.
   */
  _resync(ps) {
    const playerId = ps.playerId;
    this.sendTo(playerId, this.publicView());
    if (!this.ended) {
      if (!ps.spectator) {
        ps._lastPriv = null;
        this._sendPrivate(ps, true);
      }
      if (this.clientCombat) this._resendBattle(ps);
      else if (!this.fields.length && this._follows(ps)) this._followScout(ps, { keep: true });
      else {
        let fid = this.watchers.get(playerId);
        if (!fid && ps.spectator && this.fields.length) { fid = (this._watchTargetField(ps, this.fields) || this.fields[0]).fieldId; this.watchers.set(playerId, fid); }
        // the own field a browser runs locally: b.start again (kept, or rebuilt after a reload; localReplica.js)
        const f = fid ? this.fields.find((x) => x.fieldId === fid) : null;
        if (fid && !(f && this._offerLocal(ps, f, { resend: true }))) this._sendField(playerId, fid);
      }
    } else if (this.lastResultMsg) {
      this.sendTo(playerId, { ...this.lastResultMsg, playerId });
    }
    this._sendDamageTo(playerId);
  }

  onLeave(playerId) {
    const ps = this.players.get(playerId);
    if (!ps || ps.isBot || ps.left || this.disposed) return;
    this.guard(() => {
      this._cancelBotPrep(ps);
      ps.left = true;
      this._dropSetupVoter(playerId);
      ps.connected = false;
      ps.autoplay = false;
      ps.offlineAutoplay = false;
      this._kickVoteMemberGone(playerId);
      this.watchers.delete(playerId);
      this.localViews.delete(playerId);
      if (this.ended) return;
      this._resume();
      if (this.clientCombat) this._authorityLost(ps, 'left');
      // a rehearsal the departed seat was running falls back to the server (DESIGN §14; a no-op without tasks)
      this._rehearsalHostChanged();
      this.markPublic();
      if (!this.order.some((p) => !p.isBot && !p.left)) {
        this.finish({ victory: false, reason: 'abandoned' });
        return;
      }
      this._quit(ps);
      // the humans who stay may all be offline (offlineHold.js)
      this._updateOfflineHold();
    });
  }

  /**
   * 中途退出 counts as elimination (research 00-INDEX §3, 01 §9, 06 §7 / §10.3): every copy the player holds goes back
   * to the shared pool at once, and the seat has no place in later rounds, the Final Assault pairing or the boss pool
   * (bloodPoint per player alive at the fight's start, DESIGN §25.13.4). Rounds passed = the rounds the player had
   * survived when leaving.
   */
  _quit(ps) {
    this._cancelBotPrep(ps);
    this.maybeEndInfo();
    if (!ps.alive && !ps.pendingDeath) return;
    const phase = this.phase;
    const d = this.draft;
    if (phase === PHASE.BAND_DRAFT && d && !d.picks[ps.playerId]) {
      // the departed seat passes its turn with the default band (never one a teammate holds — defaultBand); in a free
      // draft (freeDraft) the strategy it held, while it can
      const turn = this.draftTurn() === ps.playerId;
      d.picks[ps.playerId] = this.heldBand(ps) || this.defaultBand(ps.playerId);
      if (d.holds) delete d.holds[ps.playerId];
      ps.bandId = d.picks[ps.playerId];
      if (turn || d.concurrent) this.startDraftTurn();
    }
    const passedRound = phase === PHASE.SETTLE ? this.round + 1 : Math.max(1, this.round);
    // its own normal battle has nobody left to fight for
    for (const f of this.fields) {
      if (f.live && f.kind === 'normal' && f.players.length === 1 && f.players[0] === ps.playerId) {
        if (this.clientCombat && f.cc) {
          if (!f.result) f.result = syntheticResult(f.players);
          this._fieldDone(f);
          continue;
        }
        try { f.battle.forceEnd('left'); } catch (e) { this.reportError('quit forceEnd', e); }
      }
    }
    this._finalizeDeath(ps, { round: passedRound, notify: false, reason: 'left' });
    this.offersChanged();
    this.tickerText(msg('{name}博士中途退出了模拟', { name: ps.name }), FLOW_TICKER_PRIORITY);
    if (this.bossWaves && (phase === PHASE.ROUND_START || phase === PHASE.SP_DRAFT || phase === PHASE.PREP)) {
      // before the boss fight: pair the players left again (the prep preview shows the new partner / template); a
      // player moved to the other half re-checks its board there at once (recompute → deployMap, marks it private)
      this._planBossWaves();
      for (const p of this.alivePlayers()) p.recompute();
    }
    // whoever scouted the departed player's board follows the next player still in (item 56)
    for (const v of this._viewers()) if (this.watchers.get(v.playerId) === `n:${ps.playerId}`) this._followScout(v);
    this.markPublic();
    if (this.teamLp != null) this._syncTeamLp();
    if (!this.alivePlayers().length) {
      // only eliminated spectators are left
      this.finish({ victory: false, reason: 'eliminated' });
      return;
    }
    if (phase === PHASE.SP_DRAFT && this.sp && (this.sp.concurrent || this.spTurn() === ps.playerId)) this.startSpTurn();
    else if (phase === PHASE.PREP) this.maybeEndPrep();
  }

  /**
   * 挂机移出 (afkRemoveRounds, the header's leave policy): called as a PREP ends, before its battle / boss fight is built
   * (MatchPrep.endPrep). Every alive human of a match that started with ≥ 2 humans (never solo or soloUntimed) is
   * counted: an accepted AFK_ACTIONS intent since the previous check — or the AI playing the seat now (AI 托管), or the
   * seat being offline — resets its idle rounds, else they grow by one. Offline is not idle (the owner's decision of
   * 2026-10-13): a dropped seat keeps its place and its last lineup, the disconnect policy of Match.js (the AI takes it
   * over after OFFLINE_TAKEOVER_ROUNDS, _checkOffline) — the rule had removed it after two preps, so a player back
   * found the seat gone and could only watch. A seat reaching afkRemoveRounds is removed (_removeIdle); may end the
   * match. One round short of it, the seat is warned: a toast now and m.private afkWarn through its next prep.
   */
  _checkIdle() {
    const limit = this.afkRemoveRounds;
    if (!(limit > 0) || this.soloUntimed) return;
    const humans = this.order.filter((p) => !p.isBot && !p.left && p.alive);
    for (const ps of humans) {
      ps.afkRounds = ps.afkActed || ps.botControlled || !ps.connected ? 0 : ps.afkRounds + 1;
      ps.afkActed = false;
    }
    for (const ps of humans) {
      if (this.ended || this.disposed) return;
      if (!ps.left && ps.afkRounds >= limit) this._removeIdle(ps);
      else if (limit > 1 && ps.afkRounds === limit - 1) {
        this.toast(ps, 'warn', msg('你本回合没有任何操作，下回合备战仍无操作将被移出对局'));
        this.markPrivate(ps);
      }
    }
  }

  /**
   * 掉线由 AI 接管 (OFFLINE_TAKEOVER_ROUNDS, the owner's rule of 2026-10-14; the header's disconnect policy): called as a
   * PREP ends, after the AFK rule. An alive human seat offline at this prep end has one more offline round (0 when
   * online); at OFFLINE_TAKEOVER_ROUNDS the AI plays it (AI 托管, as g.autoplay) from the next phase on and everyone in
   * the match is told. The seat stays the player's: reconnecting hands it back (onReconnect). A seat already under its
   * own AI 托管 is left alone; an untimed match (soloUntimed) waits for its player instead.
   */
  _checkOffline() {
    if (this.soloUntimed) return;
    for (const ps of this.order) {
      if (ps.isBot || ps.left || !ps.alive) continue;
      ps.offlineRounds = ps.connected ? 0 : ps.offlineRounds + 1;
      if (ps.connected || ps.autoplay || ps.offlineRounds < OFFLINE_TAKEOVER_ROUNDS) continue;
      ps.autoplay = true;
      ps.offlineAutoplay = true;
      this.log.info?.(`[match ${this.roomCode}] seat ${ps.seat} offline for ${ps.offlineRounds} rounds: AI takes over (R${this.round})`);
      this.tickerText(msg('{name}博士掉线超过 {rounds} 回合，由 AI 托管其席位，重新连接后可收回', { name: ps.name, rounds: OFFLINE_TAKEOVER_ROUNDS }), FLOW_TICKER_PRIORITY);
      this.markPublic();
    }
  }

  /**
   * Remove a human exactly like a g.leave — an idle one (reason 'afk', the AFK rule) or one voted out (reason 'kicked',
   * kickVote.js; `rounds` = its offline rounds, clamped to 1..100): the player is told first (m.removed — its client
   * shows it and returns to the lobby), everyone else still in the match, spectator seats included, gets the m.notice
   * (afkRemoved, or the vote's kickPassed), then the platform detaches the seat (opts.onRemove: the lobby's
   * removeMember, whose onLeave quits it here). A platform without the hook, or one that hears of it later (the
   * cluster coordinator), leaves the quit to onLeave below.
   */
  _removeIdle(ps, reason = 'afk', notice = null) {
    const rounds = reason === 'afk' ? this.afkRemoveRounds : Math.min(100, Math.max(1, ps.offlineRounds | 0));
    if (reason === 'afk') this.log.info?.(`[match ${this.roomCode}] seat ${ps.seat} removed after ${ps.afkRounds} idle rounds (R${this.round})`);
    this.sendTo(ps.playerId, { t: 'm.removed', reason, rounds });
    notice ||= { t: 'm.notice', kind: 'afkRemoved', playerId: ps.playerId, name: ps.name, rounds };
    for (const p of this.order) if (p !== ps && !p.isBot && !p.left) this.sendTo(p.playerId, notice);
    for (const id of this.spectators.keys()) this.sendTo(id, notice);
    if (typeof this.opts.onRemove === 'function') {
      try { this.opts.onRemove(ps.playerId, { reason, rounds }); } catch (e) { this.reportError('onRemove', e); }
    }
    if (!ps.left) this.onLeave(ps.playerId);
  }

  dispose() {
    if (this.disposed) return;
    this._freezeDamage(false);
    this._finalizePendingDeaths({ notify: false, reason: 'match-ended' });
    this.disposed = true;
    for (const ps of this.order) this._cancelBotPrep(ps);
    this.externalAI?.close();
    if (this.runner) { try { this.runner.stop(); } catch { /* ignore */ } }
    this._stopClientCombat();
    this._cancelRehearsal();
    this._endOfflineHold();
    this.verifyHub?.unregister(this);
    // a plugin interaction window's own deadline timer (MatchOffers); the tracked timers below cover the rest
    if (typeof this.offersDispose === 'function') { try { this.offersDispose(); } catch { /* ignore */ } }
    this._clearTimers();
    if (this._pubTimer) { try { this.sched.clearTimeout(this._pubTimer); } catch { /* ignore */ } this._pubTimer = null; }
    if (this.ownsScheduler) this.sched.dispose();
  }
}
