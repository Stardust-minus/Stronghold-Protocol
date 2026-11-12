// server/match/match/intents.js — Match methods: the g.* / b.* intent router (_handle: the prep intents go to
// PlayerState, the drafts, watching, the pause and the battle reports to the match), emotes, AI 托管 (setAutoplay,
// kickBot), g.unitStats (the stats the board's units start their next battle with: a preview battle, started, read
// and dropped) and g.bondPlan (the announced 主盟约 and 副盟约, display only; a change after the strategy draft is told
// to everyone as m.notice bondPlan).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { unitStatsEntry } from '../../../shared/protocol.js';
import { PHASE, ERR, EMOTES, EMOTE_COOLDOWN_MS, GEO, BOND_PLAN_SUB_MAX, BOND_PLAN_COOLDOWN_MS } from '../../../shared/constants.js';
import { deriveSeed } from '../../sim/rng.js';
import { OK, fail } from './common.js';
import { onHumanEmote } from '../botEmotes.js';

export class MatchIntents {
  _handle(ps, msg) {
    switch (msg.t) {
      case 'g.infoReady':
        if (this.phase !== PHASE.INFO_CHECK) return fail(ERR.WRONG_PHASE);
        if (this.setupVote) return fail(ERR.WRONG_PHASE, 'setup reroll vote in progress');
        if ((msg.setupRevision ?? 0) !== this.setupRevision) return fail(ERR.BAD_TARGET, 'setup changed; confirm the current revision');
        if (!ps.infoReady) { ps.infoReady = true; this.markPublic(); this.maybeEndInfo(); }
        return OK;
      case 'g.rerollVote': return this.voteSetupReroll(ps, msg.voteId, msg.agree);
      // 自选候补 (feedback #114): the briefing's choice of one tier (phases.js chooseDiy)
      case 'g.diyChoose': return this.chooseDiy(ps, msg.tier, msg.charIds);
      // 投票移出 an offline seat under AI takeover (kickVote.js)
      case 'g.kickVote': return this.requestKickVote(ps, msg.targetId);
      case 'g.kickBallot': return this.answerKickVote(ps, msg.voteId, msg.agree);
      // 战斗 2 倍速: the seat's standing vote (speedVote.js)
      case 'g.speedVote': return this.setSpeedVote(ps, msg.agree === true);
      case 'g.band': return this.pickBand(ps, msg.bandId);
      case 'g.bandSkip': return this.skipBand(ps);
      // a free draft (MatchPhases.freeDraft): a tentative choice, its cancel and its 锁定
      case 'g.bandHold': return this.holdBand(ps, msg.bandId);
      case 'g.bandCancel': return this.cancelBand(ps);
      case 'g.bandLock': return this.lockBand(ps);
      // the strategy highlighted in the draft screen (what a timed-out turn takes, timeoutBand)
      case 'g.bandFocus': return this.bandFocus(ps, msg.bandId ?? null);
      // the bonds the player means to build (display only): 主盟约 and 副盟约, the whole match
      case 'g.bondPlan': return this.planBond(ps, msg.bondId ?? null, msg.subIds);
      case 'g.buy': return ps.buy(msg.slot);
      case 'g.refresh': return ps.refresh();
      case 'g.freeze': return ps.freeze();
      case 'g.levelUp': return ps.levelUp();
      case 'g.sell': return ps.sell(msg.uid);
      // dir: the deploy wheel's facing (DESIGN §3; absent ⇒ PlayerState reads to.dir, then RIGHT)
      case 'g.move': return ps.move(msg.uid, msg.to, msg.dir);
      case 'g.equip': return ps.equip(msg.itemUid, msg.targetUid, msg.replaceUid ?? null);
      case 'g.art': return ps.useArt(msg.itemUid, msg.row, msg.col, msg.dir);
      case 'g.destroy': return ps.destroy(msg.uid);
      case 'g.unequip': return ps.unequip(msg.itemUid);
      case 'g.reward': return ps.pickReward(msg.idx);
      case 'g.choice': return msg.choiceId !== undefined
        ? this.pickPersonalChoice(ps, msg.idx, msg.choiceId)
        : this.pickCard(ps, msg.idx);
      // a plugin interaction window (PLUGIN API v2, docs/PLUGINS.md §10b): the window's own id, not a draft card —
      // the host applies the declared primitive, a plugin never reaches the match state itself
      case 'g.offer': return this.requestOffer(ps, msg.offerId, msg.idx, msg);
      case 'g.offerRefresh': return this.requestOfferRefresh(ps, msg.offerId, msg.idx, msg);
      case 'g.ready': return ps.setReady(!!msg.ready);
      case 'g.revive': return this.revive(ps, msg);
      case 'g.emote': return this.emote(ps, msg.id);
      // playerId: the player tapped (a shared field names two) — the watch preference (item 56)
      case 'g.watch': return this.watch(ps, msg.fieldId, msg.playerId ?? null);
      case 'g.autoplay': return this.setAutoplay(ps, !!msg.on);
      case 'g.pause': return this.setPause(ps, !!msg.on);
      // server-run combat: this browser runs its own fields locally / its replica wants the stream (localReplica.js)
      case 'g.sim': return this.setLocalSim(ps, msg);
      // shadow verification (shadowVerify.js): this seat's page verified a battle of another match on this process
      case 'g.verifyResult': return this.verifyResult(ps, msg);
      // the stats the board's units start their next battle with (the detail card in prep, user playtest #4 item 7)
      case 'g.unitStats': return this.unitStats(ps, msg.seq ?? null);
      case 'g.leave': this.onLeave(ps.playerId); return OK;
      case 'g.test': return this.applyTestCommand(ps, msg);
      case 'b.progress': return this._onProgress(ps, msg);
      case 'b.result': return this._onResult(ps, msg);
      // the host's answer to a delegated bot layout rehearsal (DESIGN §14): a report, never an error — an unknown,
      // expired or foreign task is ignored (MatchRehearsal._onRehearsalResult)
      case 'b.rehearsalResult': this._onRehearsalResult(ps, msg); return OK;
      default: return fail(ERR.BAD_MSG);
    }
  }

  emote(ps, id) {
    if (!EMOTES.includes(id)) return fail(ERR.BAD_MSG, 'unknown emote');
    const now = this.sched.now();
    if (now - ps.lastEmoteAt < EMOTE_COOLDOWN_MS) return fail(ERR.RATE);
    ps.lastEmoteAt = now;
    this.broadcast({ t: 'm.emote', playerId: ps.playerId, id });
    // an AI teammate can react to a human's emote (enabled by default: server/match/botEmotes.js, SP_BOT_EMOTES=0 silences it)
    onHumanEmote(this, ps.playerId, id);
    return OK;
  }

  /**
   * g.bondPlan { bondId?, subIds? } (a remake feature, display only): the bonds (盟约) the player announces it means to
   * build — m.public players[].bondPlan (the 主盟约: one of GameData.plannableBondIds(), the core bonds; absent / null
   * clears it) and players[].bondPlanSub (the 副盟约: ≤ BOND_PLAN_SUB_MAX distinct ids of subPlannableBondIds(), not the
   * main one; absent keeps the current ones minus a new main — an older page's message changes the main only), seen by
   * every teammate and spectator for the rest of the match. Anything else is BAD_TARGET and changes nothing.
   * Changeable from INFO_CHECK until the match ends (bondPlanOpen, else WRONG_PHASE — the owner's 「预选的盟约在局内可以
   * 二次更改」, 2026-11-05) while the player is alive (else ELIMINATED); the same plan again changes nothing. A change after
   * the strategy draft (any phase but INFO_CHECK / BAND_DRAFT) is told to everyone in the match — m.notice { kind:
   * 'bondPlan', playerId, name, bondId, subIds }, a toast on the others' screens — at most once per BOND_PLAN_COOLDOWN_MS
   * (RATE otherwise). No rule, bot, timer or idle check reads the plan. AI seats and spectator seats cannot send it
   * (handle refuses them).
   * @param {PlayerState} ps @param {string|null} bondId @param {unknown} [subIds]
   */
  planBond(ps, bondId, subIds) {
    if (!this.bondPlanOpen()) return fail(ERR.WRONG_PHASE);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (bondId !== null && !this.gd.bondPlannable(bondId)) return fail(ERR.BAD_TARGET);
    const prevSub = Array.isArray(ps.bondPlanSub) ? ps.bondPlanSub : [];
    let sub;
    if (subIds === undefined) sub = prevSub.filter((id) => id !== bondId);
    else {
      if (!Array.isArray(subIds) || subIds.length > BOND_PLAN_SUB_MAX || new Set(subIds).size !== subIds.length) return fail(ERR.BAD_TARGET);
      if (subIds.some((id) => id === bondId || !this.gd.bondSubPlannable(id))) return fail(ERR.BAD_TARGET);
      sub = subIds.slice();
    }
    if (ps.bondPlan === bondId && sub.length === prevSub.length && sub.every((id, i) => id === prevSub[i])) return OK;
    const notify = this.phase !== PHASE.INFO_CHECK && this.phase !== PHASE.BAND_DRAFT;
    const now = this.sched.now();
    if (notify && now - ps._planAt < BOND_PLAN_COOLDOWN_MS) return fail(ERR.RATE);
    ps.bondPlan = bondId;
    ps.bondPlanSub = sub;
    this.markPublic();
    if (notify) {
      ps._planAt = now;
      this.broadcast({ t: 'm.notice', kind: 'bondPlan', playerId: ps.playerId, name: ps.name, bondId, subIds: sub.slice() });
    }
    return OK;
  }

  /** While a plan may change: from INFO_CHECK until the match ends (RESULT; an ended match refuses every intent). */
  bondPlanOpen() {
    return this.phase !== PHASE.LOBBY && this.phase !== PHASE.RESULT && !this.ended;
  }

  setAutoplay(ps, on) {
    if (ps.autoplay === on) return OK;
    ps.autoplay = on;
    this.markPublic();
    if (on) this.kickBot(ps);
    else this._cancelBotPrep(ps);
    return OK;
  }

  /** Let the bot act for a (newly) bot-controlled seat in the current phase. */
  kickBot(ps) {
    if (!ps.botControlled || this.ended) return;
    this.offersChanged();
    if (this.phase === PHASE.INFO_CHECK && !ps.infoReady) { ps.infoReady = true; this.markPublic(); this.maybeEndInfo(); }
    // a concurrent draft (concurrentDraft) looks at every seat still deciding again
    else if (this.phase === PHASE.BAND_DRAFT && this.draft?.concurrent) this._concurrentBandStep();
    else if (this.phase === PHASE.BAND_DRAFT && this.draftTurn() === ps.playerId) this.scheduleBandBot();
    else if (this.phase === PHASE.SP_DRAFT && this.sp?.concurrent) this._concurrentSpStep();
    else if (this.phase === PHASE.SP_DRAFT && this.spTurn() === ps.playerId) this.scheduleSpBot();
    else if (this.phase === PHASE.PREP && ps.alive && !ps.ready) this.scheduleBotPrep(ps, 0);
  }

  /**
   * g.unitStats { seq? } (user playtest #4 item 7: the detail card showed fixed record stats): the stats every unit of
   * the player's board will fight with at the start of its next battle — equipment, bonds and their layers, 特质, the
   * band and 机变 effects — computed exactly by the shared sim. The player's battle input after the onBattleStart meta
   * handlers (`ev.preview: true`, no enemies — those handlers must not change the match for a preview) builds a Battle
   * of the battle's options that is started (initial deployment + battleStart hooks), read and dropped: it is never
   * stepped: deployment skills contribute their initial stats but their timers do not advance. No SP / skill timer is
   * sent, and the real battle gets fresh units. Pushed to the player as `m.unitStats { seq, round, units }`
   * (units: shared/protocol.js unitStatsEntry, board operators and summons by uid); cached per input (a build costs
   * ≈ 0.3–0.7 ms). Prep phases only (ROUND_START, 机变, PREP); a battle's live stats come from the browser's own sim.
   * @param {PlayerState} ps @param {number|null} seq echoed (the client keeps the newest answer)
   */
  unitStats(ps, seq = null) {
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (this.phase !== PHASE.ROUND_START && this.phase !== PHASE.SP_DRAFT && this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    const units = this._unitStatsOf(ps);
    this.sendTo(ps.playerId, { t: 'm.unitStats', seq: Number.isInteger(seq) ? seq : null, round: this.round, units });
    return OK;
  }

  /** The start-of-battle stats of a player's board units (see unitStats); [] when the preview battle cannot be built. */
  _unitStatsOf(ps) {
    const input = ps.battleInput({ side: 'L', colOffset: 0 });
    const ev = { input, kind: 'normal', round: this.round, preview: true };
    this.dispatch(ps, 'onBattleStart', ev);
    const players = [ev.input && typeof ev.input === 'object' ? ev.input : input];
    let key = null;
    try { key = JSON.stringify([this.round, this.stageId, this.battleContent, players]); } catch { key = null; }
    if (!this._unitStatsCache) this._unitStatsCache = new WeakMap(); // PlayerState → { key, units } (the last preview)
    const cached = this._unitStatsCache.get(ps);
    if (key && cached && cached.key === key) return cached.units;
    const units = [];
    // the flags of the battle it previews: a normal round gains IN_BATTLE layers from its start (a <战斗开始时> layer gain
    // raises bond stats at t = 0 there too); the Final Assault / Hidden Core fight without (previewed as a normal field)
    const bossRound = this.round === this.gd.bossRound || this.round === this.gd.hiddenRound;
    const b = this.newBattle({
      seed: deriveSeed(this.seed, `preview:${this.round}:${ps.seat}`), kind: 'normal', modeId: this.modeId, round: this.round,
      stageId: this.stageId, rect: { ...GEO.NORMAL_RECT }, timeLimit: 60, players, spawns: [], routes: this.wave ? this.wave.routes : [],
      sharedBoss: null, flags: { layerGainsEnabled: !bossRound, ...this.gd.dp, ...this._ruleFlags() }, fieldId: `n:${ps.playerId}`, recordEvents: false,
    });
    try {
      if (typeof b.start === 'function') b.start();
      for (const u of Array.isArray(b.allyUnits) ? b.allyUnits : []) {
        if (u && Number.isInteger(u.uid) && (u.kind === 'op' || u.kind === 'token')) units.push(unitStatsEntry(u, u.s));
      }
    } catch (e) { this.reportError('unitStats', e); }
    this._unitStatsCache.set(ps, { key, units });
    return units;
  }
}
