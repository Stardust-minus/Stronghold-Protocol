// server/match/match/prep.js — Match methods: the PREP phase — its start (deferred item merges, onPrepStart), the AI
// seats' sliced preps (scheduleBotPrep: economy + layout, rehearsal, Ready), Ready and the deadline, and its end
// (the AFK rule's check, the offline takeover, onPrepEnd, PlayerState.endPrep, then COMBAT or the Final Assault / Hidden
// Core).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE } from '../../../shared/constants.js';
import { canUseWorkerRehearsal, rehearsalFingerprint } from '../combat/rehearsal.js';
import { testSlice } from '../testTrace.js';
import { DELAYS } from './common.js';

export class MatchPrep {
  enterPrep() {
    this.phase = PHASE.PREP;
    this.sp = null;
    const alive = this.alivePlayers();
    for (const ps of alive) {
      ps.ready = false;
      // Items gained as the previous prep ended waited unmerged (acquireItem deferMerge). Merge them now, before
      // this prep's onPrepStart grants and before the player acts — not in endPrep, which runs in the same prep
      // that granted them and would take an equipped copy off for the fight about to start.
      ps.checkItemMerges();
      ps.recompute();
      this.dispatch(ps, 'onPrepStart', { round: this.round });
      ps.recompute();
    }
    // solo / single-human matches: untimed (soloUntimed); co-op: the round's prepTime
    const secs = this.soloUntimed ? null : this.gd.prepTime(this.round);
    this.armPrepDeadline(secs);
    let i = 0;
    for (const ps of alive) if (ps.botControlled) this.scheduleBotPrep(ps, i++);
    this.markPublic();
    this.maybeEndPrep();
  }

  /**
   * The bot plays a prep in three stages, every one in slices of ≤ botSliceMs wall-clock ms (one scheduler callback
   * each, so other rooms' battles and every player's requests keep flowing): economy + the default layout
   * (bot.js botPrepBeginSteps — shop decisions and layout planning, 50–120 ms late in a 4-bot match), the layout
   * rehearsal (whole simulated battles, 0.2–1 s of CPU per bot late in a match), then botPrepEndSteps (the rehearsed
   * layout, temp, Ready). The step generators run the same actions in the same order as the one-shot routine (same
   * rng draws, same decisions); in virtual time (botSliceMs unbounded) each stage runs at once. The prep ending first
   * (deadline) or a newer schedule for the seat drops the job (a step never leaves a transient board behind).
   * A rehearsal offered to the host's browser (botRehearsalDelegate, DESIGN §14 — AI teammates only) is not stepped
   * here: the job stays `pending` until MatchRehearsal accepts the host's pick (`done`, the layout ready to apply) or
   * takes it over, and only a takeover runs `job.run` — the server's slices, never a second simulation of what the host
   * already ran; a pick accepted before this driver subscribed to the job is applied just the same (`job.done`). Either
   * outcome is applied once the generator that offered the task has finished — it still places the default layout after
   * the delegation — which is why the continuation is installed here and not with the frame.
   */
  scheduleBotPrep(ps, i = 0) {
    this._cancelBotPrep(ps);
    const round = this.round, token = ps._botPrepToken;
    const bounded = Number.isFinite(this.botSliceMs);
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const warn = (message, e) => this.log.warn?.(`[match ${this.roomCode}] bot ${ps.playerId} ${message}${e ? `: ${e.message ?? e}` : ''}`);
    const work = {
      timer: null, gen: null, job: null, cancelled: false, fingerprint: null, wave: null,
      verify: this.botRehearsal > 0 && canUseWorkerRehearsal(this),
      // Identify the explicit comparison adapter before planning, not only after work.job exists.
      legacy: typeof this.trialPool?.runTrial !== 'function' && typeof this.trialPool?.createTrial === 'function',
      cancel: () => {
        if (work.cancelled) return;
        work.cancelled = true;
        if (ps._botPrepWork === work) ps._botPrepWork = null;
        this.cancel(work.timer); work.timer = null;
        try { work.gen?.return(); } catch { /* cancellation can be triggered by Ready inside this generator */ }
        work.gen = null;
        const job = work.job; work.job = null;
        try { Promise.resolve(job?.close?.()).catch((e) => warn('rehearsal cleanup failed', e)); }
        catch (e) { warn('rehearsal cleanup failed', e); }
      },
    };
    ps._botPrepWork = work;
    const valid = () => !this.disposed && !this.ended && !work.cancelled && ps._botPrepWork === work &&
      this.phase === PHASE.PREP && this.round === round && ps.alive && !ps.left && !ps.ready && ps.botControlled && ps._botPrepToken === token;
    const fresh = () => !work.verify || work.fingerprint === null ||
      (this.wave === work.wave && rehearsalFingerprint(this, ps) === work.fingerprint);
    const capture = () => {
      if (work.verify) { work.wave = this.wave; work.fingerprint = rehearsalFingerprint(this, ps); }
    };
    const stale = () => {
      // Owner input changed externally. Never apply a proposal for the former holdings, nor repeat economy/RNG.
      const job = work.job; work.job = null;
      Promise.resolve(job?.close?.()).catch((e) => warn('rehearsal cleanup failed', e));
      try { work.gen?.return(); } catch { /* already yielded */ }
      work.gen = null; work.verify = false; work.fingerprint = null;
      warn('rehearsal discarded after own inputs changed');
      if (valid()) end(null); else work.cancel();
    };
    const defer = (ms, fn) => {
      work.timer = this.later(ms, () => {
        work.timer = null;
        if (!valid()) { work.cancel(); return; }
        // Preserve legacy comparison's original defer + drive/slice checks, including the planning stage.
        // Dedicated streaming jobs only fingerprint at drive/slice entry, not twice in this callback.
        if (work.legacy && !fresh()) { stale(); return; }
        fn();
      });
    };
    /** Only synchronous .next() owns the worker-enabled context. One-shot helpers and virtual/custom fixtures do not. */
    // Test replay ignores the wall clock and stops after the journalled step count (testSlice).
    const sliceCtl = testSlice(this);
    const drive = (gen, label, then) => {
      if (!valid()) { work.cancel(); return; }
      if (!fresh()) { stale(); return; }
      const t0 = now(), owner = this._workerBotPrepOwner;
      let r = null, failure = null;
      work.gen = gen;
      if (work.verify) this._workerBotPrepOwner = ps;
      try {
        do {
          r = gen.next();
          if (!r || typeof r.done !== 'boolean') throw new TypeError('Bot prep hooks must return a synchronous iterator');
          if (sliceCtl) sliceCtl.note(1);
        } while (!r.done && !(sliceCtl ? sliceCtl.wall(now() - t0, this.botSliceMs) : (bounded && now() - t0 >= this.botSliceMs))); // loop-cap: generator and the bot time slice
      } catch (e) { failure = e; }
      finally { this._workerBotPrepOwner = owner; }
      if (!valid()) { work.cancel(); return; }
      // Expected default/winning layout mutations are captured after OUR atomic slice. The next callback checks
      // this signature before advancing: gifts/equip/moves between candidate collection and default placement
      // cannot be blindly accepted by capturing a fresh signature for old inputs at the first RPC call.
      capture();
      if (failure) { this.reportError(`bot ${ps.playerId}${label}`, failure); work.gen = null; then(null); return; }
      if (r.done) { work.gen = null; then(r.value); return; }
      defer(0, () => drive(gen, label, then));
    };
    const ready = () => {
      if (valid()) {
        this.autoPickPersonalChoice(ps, 'random');
        ps.resolveTemp();
        ps.setReady(true);
      }
    };
    const end = (job) => {
      let gen = null;
      try { gen = this.bot.prepEnd(this, ps, job); } catch (e) { this.reportError(`bot ${ps.playerId}`, e); }
      if (!gen) { ready(); return; }
      drive(gen, '', ready);
    };
    const begin = () => {
      if (!valid()) { work.cancel(); return; }
      let gen;
      try { gen = this.bot.prepBegin(this, ps, { delegate: this.botRehearsalDelegate, pooled: !!this.simPool }); }
      catch (e) { this.reportError(`bot ${ps.playerId}`, e); end(null); return; }
      drive(gen, '', (job) => {
        if (!job) { end(null); return; }
        work.job = job;
        const complete = () => { if (bounded || job.remote) defer(0, () => end(job)); else end(job); };
        const slice = () => {
          if (!valid()) { work.cancel(); return; }
          if (!fresh()) { stale(); return; }
          if (job.streamed && !job.inline) {
            // Dedicated workers own their bounded internal slices. Main wakes only for low-frequency progress
            // and completion, never once per 32 ticks. All these callbacks are new asynchronous boundaries.
            const remaining = this.deadline ? this.deadline - this.sched.now() : 30_000;
            if (remaining <= 0) { work.cancel(); return; }
            const check = () => {
              if (!valid() || (this.deadline && this.sched.now() >= this.deadline)) { work.cancel(); return false; }
              if (!fresh()) { stale(); return false; }
              return true;
            };
            job.start({ timeoutMs: Math.min(30_000, remaining),
              onReady: () => this.guard(check), onProgress: () => this.guard(check) }).then(
              () => this.guard(() => { if (check()) complete(); }),
              (e) => this.guard(() => {
                if (!check()) return;
                // True cancellation/shutdown is not a worker fault and cannot restart a discarded search.
                if (e.code === 'SESSION_CLOSED' || e.code === 'POOL_CLOSED') { work.cancel(); return; }
                warn('rehearsal RPC failed; restarting all frozen candidates inline', e);
                try { job.fallback(this.data); defer(0, slice); }
                catch (fallbackError) { this.reportError(`bot ${ps.playerId} rehearsal fallback`, fallbackError); end(null); }
              }));
            return;
          }
          if (job.remote && !job.streamed) {
            job.advance().then((done) => this.guard(() => {
              if (!valid()) { work.cancel(); return; }
              if (!fresh()) { stale(); return; }
              if (done) complete(); else defer(0, slice);
            }), (e) => this.guard(() => {
              if (!valid()) { work.cancel(); return; }
              if (!fresh()) { stale(); return; }
              if (!job.inline) {
                warn('rehearsal RPC failed; restarting all frozen candidates inline', e);
                try { job.fallback(this.data); defer(0, slice); return; }
                catch (fallbackError) { e = fallbackError; }
              }
              this.reportError(`bot ${ps.playerId} rehearsal fallback`, e);
              end(null);
            }));
            return;
          }
          let done = true;
          try { done = job.run(this.botSliceMs, sliceCtl); } catch (e) { this.reportError(`bot ${ps.playerId} rehearsal`, e); }
          if (done) complete(); else defer(0, slice);
        };
        // A rehearsal offered to the host's browser (SP_BOT_REHEARSAL=host, DESIGN §14): the host's pick may already be in
        // (`done`: applied, never simulated again); still waiting, MatchRehearsal calls back once it is in or once the
        // server took the job over, whose own slices follow. The continuation is installed here, after the generator
        // placed the default layout, so an answer applied earlier cannot drop those steps.
        if (job.done) { complete(); return; }
        if (job.pending) {
          job.onSettled = () => this.guard(() => {
            if (!valid()) { work.cancel(); return; }
            if (!fresh()) { stale(); return; }
            if (job.done) complete();
            else { job.takeOver(); defer(0, slice); }
          });
          return;
        }
        if (bounded || job.remote) defer(0, slice); else slice();
      });
    };
    defer(this.scaled(DELAYS.BOT_ACTION + i * DELAYS.BOT_STAGGER), () => {
      if (this.bot.decide?.(this, ps, { kind: 'prep', valid, complete: () => ps.ready,
        fallback: () => defer(0, begin) })) return;
      begin();
    });
  }

  onReadyChanged(ps) {
    if (ps.ready) this._cancelBotPrep(ps);
    this.markPublic();
    this.maybeEndPrep();
  }

  maybeEndPrep() {
    if (this.phase !== PHASE.PREP || this._prepEndQueued) return;
    const allReady = () => { const alive = this.alivePlayers(); return alive.length > 0 && alive.every((p) => p.ready); };
    if (!allReady()) return;
    const round = this.round;
    this._prepEndQueued = true;
    // the prep deadline stays armed until the phase really ends: a player may un-ready before this runs
    this.later(0, () => {
      this._prepEndQueued = false;
      if (this.phase === PHASE.PREP && this.round === round && allReady()) this.endPrep();
    });
  }

  /** The PREP countdown: `secs` published, the phase ends prepGraceMs later (PREP_INTENT_GRACE_MS). */
  armPrepDeadline(secs) {
    this.setDeadline(secs, () => this.prepDeadline(), { graceMs: this.prepGraceMs });
  }

  prepDeadline() {
    if (this.phase !== PHASE.PREP) return;
    for (const ps of this.alivePlayers()) {
      if (ps.ready) continue;
      this.autoPickPersonalChoice(ps, 'random');
      ps.resolveTemp();
      ps.ready = true;
      ps.dirty();
    }
    this.endPrep();
  }

  endPrep() {
    if (this.phase !== PHASE.PREP) return;
    // an open 投票移出 ends with the prep (kickVote.js)
    this.cancelKickVote('prepEnd');
    // the round's checkpoint (snapshot.js): the finished prep, before its end changes anything — a match interrupted
    // during this round's battle comes back here
    this._checkpoint('prep-end');
    // 挂机移出: an idle human is removed before this round's battle exists (it may end the match)
    this._checkIdle();
    if (this.ended || this.disposed || this.phase !== PHASE.PREP) return;
    // 掉线由 AI 接管: a seat offline for OFFLINE_TAKEOVER_ROUNDS prep ends is the AI's from the next phase on
    this._checkOffline();
    for (const ps of this.order) this._cancelBotPrep(ps);
    // rehearsals still waiting for a host's answer die with the prep: their bots place the default layout, a late answer
    // is ignored (Match._takeOverRehearsal / MatchRehearsal) and nothing of them runs after the phase ended
    this._cancelRehearsal();
    this.setDeadline(0);
    const alive = this.alivePlayers();
    for (const ps of alive) this.dispatch(ps, 'onPrepEnd', { round: this.round });
    for (const ps of alive) ps.endPrep();
    const r = this.round;
    if (r === this.gd.bossRound) {
      this.hiddenLayerSum = alive.reduce((s, p) => s + p.activatedLayers(), 0);
      this.startFinalAssault(false);
    } else if (r === this.gd.hiddenRound) {
      this.startFinalAssault(true);
    } else {
      this.startCombat();
    }
  }
}
