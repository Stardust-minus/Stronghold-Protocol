// server/match/match/settle.js — Match methods: SETTLE (the LP loss — a leaker's 联防 survivors —, stats, bounty coins,
// the IN_BATTLE layer gains clamped by layerGainRoom, CHAR_DAMAGE tickers, eliminations, the 联防 outcome the SETTLE
// view carries) and RESULT (finish: m.result to every human still here, onEnd).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE } from '../../../shared/constants.js';
import { REVIVAL_WINDOW_SECONDS } from './common.js';
import { uniteSurvivors } from '../unite.js';
import { buildResult } from '../results.js';
import { FLOW_TICKER_PRIORITY, DELAYS } from './common.js';
import { msg } from '../../../shared/i18n.js';
import { onSettle, resetRoundCounters } from '../botEmotes.js';

export class MatchSettle {
  settle(plan, uniteResult) {
    if (this.disposed || this.ended || (this.phase !== PHASE.COMBAT && this.phase !== PHASE.UNITE)) return;
    this._freezeDamage(); // before LP/death/board cleanup and fields clearing
    const relay = this._uniteRelay?.rounds.at(-1)?.plan === plan ? this._uniteRelay : null;
    const eligible = relay ? new Set(relay.eligible) : this._revivalHelpers(plan, uniteResult);
    // Per-field results stay archived (including the earlier leaks). Helpers are unique, so merging their
    // reward/stat entries cannot overwrite another round. LP below uses only the final field's survivors.
    const combinedUnite = relay ? { ...uniteResult,
      perPlayer: Object.assign({}, ...relay.rounds.map((r) => r.result?.perPlayer || {})) } : uniteResult;
    this.phase = PHASE.SETTLE;
    this.runner = null;
    this._stopClientCombat();
    // Only legacy/final-result gains not yet synchronized may have a pending display overlay.
    for (const ps of this.order) if (ps.pendingLayerGains) { ps.pendingLayerGains = null; ps.dirty(); }
    const cap = this.gd.lpCapPerRound;
    // a 联防 battle that could not run at all (synthetic result) must not wipe the leakers' losses: charge their own leaks
    const uniteRan = relay ? relay.rounds.some((r) => r.result && !r.result.synthetic)
      : !!(plan && uniteResult && !uniteResult.synthetic);
    const survivors = relay ? relay.rounds.at(-1).survivors : uniteRan ? uniteSurvivors(plan, uniteResult) : null;
    // The 联防's outcome as data for the SETTLE view (m.public.uniteResult, views.js; GitHub #235, PR #112 by @Convey123):
    // each client pops the official result box from it (ui/gameLogic/phases.js uniteResultBox) — `through` = the leakers'
    // enemies that still got through (uncapped; only decides whether 「全员无伤！」 is true), `losses` = every alive
    // player's own LP charge of this round, the same `loss` deducted below, so the box and the LP bar never disagree. A
    // leaker's own battle leaks are not its charge in a 联防 round, which is why the client cannot work the number out
    // itself. No ticker line: the official reports the outcome in the one dialog. null when no 联防 resolved.
    this.uniteResultView = uniteRan && plan.leakers.length ? {
      through: plan.leakers.reduce((n, lk) => n + Math.max(0, survivors.get(lk.playerId) || 0), 0),
      helpers: relay ? relay.rounds.flatMap((r) => r.view.helpers) : plan.helpers.map((p) => p.playerId),
      leakers: plan.leakers.map((p) => p.playerId),
      losses: {},
      ...(relay ? { rounds: relay.rounds.map((r) => ({ ...r.view, helpers: r.view.helpers.slice() })) } : {}),
    } : null;
    const alive = this.alivePlayers();
    for (const ps of alive) {
      const r = this.lastResults.get(ps.playerId) || { leaked: [], perfect: true, coins: 0, layerGains: {}, killed: 0, damageDealt: 0 };
      const counted = (r.leaked || []).filter((l) => l && l.counted !== false).length;
      const loss = uniteRan && plan.leakers.includes(ps) ? Math.min(cap, survivors.get(ps.playerId) || 0) : Math.min(cap, counted);
      if (this.uniteResultView) this.uniteResultView.losses[ps.playerId] = loss;
      ps.lp -= loss;
      ps.stats.lpLost += loss;
      ps.stats.leaks += counted;
      ps.stats.kills += Number(r.killed) || 0;
      ps.stats.dmgDealt += Number(r.damageDealt) || 0;
      ps.stats.healing += Number(r.healingDone) || 0;
      if (r.perfect !== false && counted === 0) ps.stats.perfectRounds++;
      // bounty coins (own battle + unite kills) are credited to the next prep
      let coins = Math.max(0, Math.trunc(Number(r.coins) || 0));
      const up = combinedUnite && combinedUnite.perPlayer && combinedUnite.perPlayer[ps.playerId];
      if (up) {
        coins += Math.max(0, Math.trunc(Number(up.coins) || 0));
        ps.stats.dmgDealt += Number(up.damageDealt) || 0;
        ps.stats.kills += Number(up.killed) || 0;
        if (relay) ps.stats.healing += Number(up.healingDone) || 0;
      }
      // perfect-payout bounties (战术特训): own phase perfect
      for (const b of ps.bounties) if (b.card.payout === 'perfect' && counted === 0 && r.perfect !== false) coins += b.card.coin;
      if (coins > 0) { ps.pendingFunds += coins; ps.stats.fundsGained += coins; }
      for (const b of ps.bounties) b.roundsLeft--;
      ps.bounties = ps.bounties.filter((b) => b.roundsLeft > 0);
      // Ordinary server battles already retain gains live. Reconcile only an unsynchronized final delta;
      // repeated results or a cap reached during combat must not award layers or milestone rewards again.
      this._applyBattleLayerGains(ps, r.layerGains);
      this._charDamageTickers(ps, r);
      this.dispatch(ps, 'onBattleResult', { result: r, lpLoss: loss, perfect: counted === 0 && r.perfect !== false, unite: combinedUnite || null });
      ps.recompute();
    }
    this._revival = { round: this.round, eligible, windowOpen: false, deadline: 0 };
    const canRescue = this.revivalEnabled && this.teamLp == null && this.order.some((ps) => this.revivalDonorEligible(ps));
    for (const ps of alive) {
      if (ps.lp <= 0) {
        if (canRescue && ps.alive && !ps.revived && !ps.left) this._deferDeath(ps);
        else this._finalizeDeath(ps);
      }
    }
    this.fields = [];
    this.watchers.clear();
    const rescue = canRescue && this.order.some((ps) => this.revivalTargetEligible(ps));
    this.setDeadline(rescue ? REVIVAL_WINDOW_SECONDS : DELAYS.SETTLE / 1000, () => this.afterSettle({ reason: 'window-expired' }), { silent: !rescue && this.soloUntimed });
    if (rescue) { this._revival.windowOpen = true; this._revival.deadline = this.deadline; }
    this.markPublic();
    onSettle(this); // one emote per alive AI per round (enabled by default; SP_BOT_EMOTES=0 silences it)
  }

  /**
   * CHAR_DAMAGE tickers: one per board unit of the battle (its highest threshold); units created in battle (summons,
   * no board uid) count once per unit type (the highest of them) — a result can never announce more units than the
   * lineup has kinds of.
   */
  _charDamageTickers(ps, r) {
    const steps = (Array.isArray(this.gd.config.broadcasts) ? this.gd.config.broadcasts : []).filter((b) => b.type === 'CHAR_DAMAGE' && Array.isArray(b.params)).map((b) => Number(b.params[0])).filter((n) => n > 0).sort((a, b) => b - a);
    if (!steps.length) return;
    const board = new Set();
    for (const p of ps.board.values()) board.add(p.uid);
    const best = new Map();
    for (const u of r.unitStats || []) {
      if (!u) continue;
      const key = Number.isInteger(u.uid) && board.has(u.uid) ? `uid:${u.uid}` : `def:${u.defId}`;
      const cur = best.get(key);
      if (!cur || (Number(u.dmg) || 0) > (Number(cur.dmg) || 0)) best.set(key, u);
    }
    for (const u of best.values()) {
      const hit = steps.find((s) => (u.dmg || 0) >= s);
      if (hit) this.tickerFor('CHAR_DAMAGE', [ps.name, u.name || u.defId, String(hit)], { playerId: ps.playerId, param: String(hit) });
    }
  }

  afterSettle({ reason } = {}) {
    // The scheduled timeout supplies its provenance: wall/monotonic clock rounding can differ by a millisecond.
    // A forced transition without that provenance is classified from the original deadline instead.
    this._finalizePendingDeaths({ reason });
    if (!this.alivePlayers().length) { this.finish({ victory: false, reason: 'eliminated' }); return; }
    resetRoundCounters(this); // AI bot merge-counter resets each round (server/match/botEmotes.js)
    this.startRound(this.round + 1);
  }

  finish({ victory, hiddenCleared = false, reason = 'defeat' }) {
    if (this.ended || this.disposed) return;
    this._freezeDamage();
    this.ended = true;
    for (const ps of this.order) this._cancelBotPrep(ps);
    this._finalizePendingDeaths();
    if (this.runner) { try { this.runner.stop(); } catch { /* ignore */ } this.runner = null; }
    this._stopClientCombat();
    this.cancel(this._phaseTimer);
    this.cancel(this._turnTimer);
    for (const h of this._timers) { try { this.sched.clearTimeout(h); } catch { /* ignore */ } }
    this._timers.clear();
    this.phase = PHASE.RESULT;
    this.deadline = 0;
    for (const f of this.fields) f.live = false;
    this.outcome = { victory: !!victory, hiddenReached: this.hiddenReached, hiddenCleared: !!hiddenCleared, reason };
    let result;
    try {
      result = buildResult(this, this.outcome);
    } catch (e) {
      this.reportError('buildResult', e);
      result = { t: 'm.result', victory: !!victory, roundsPassed: 0, reason, modeId: this.modeId, difficulty: this.difficulty, players: [] };
    }
    this.lastResultMsg = result;
    this.markPublic();
    try { this.flush(true); } catch (e) { this.reportError('flush', e); }
    // every human still here gets the settlement — the spectator seats the same public rows (none of them their own)
    for (const ps of this._viewers()) this.sendTo(ps.playerId, { ...result, playerId: ps.playerId });
    const { t, ...summary } = result;
    void t;
    summary.errors = this.errorCount;
    try { this.onEndFn(summary); } catch (e) { this.reportError('onEnd', e); }
  }
}
