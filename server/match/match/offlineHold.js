// server/match/match/offlineHold.js — Match methods: the offline hold (the owner's rule of 2026-11-11). A match whose
// human seats are all offline stands still — every tracked timer suspended with the time it had left (infra.js
// _suspendTimers: phase deadlines, draft turns, AI preps and their rehearsal slices, votes, plugin windows), the battles
// frozen like the solo pause (field clocks, the result deadlines, the boss clock, the server pacers and the combat
// Worker runner: `paused`) — until one of them comes back; then every clock moves on by the hold, as after a solo pause.
// Nobody back within `offlineHoldMs` (common.js OFFLINE_HOLD_MINUTES; a solo run: its 24 h window): the platform's
// session expiry departs each player as before (Lobby.onExpire → onLeave; the last one ends it 'abandoned'); the match
// itself ends 'abandoned' OFFLINE_HOLD_GRACE_MS later should nobody's session expire it (a match restored from its
// checkpoint whose sessions are gone, a lost leave) — either way its battles, Worker sessions and memory are freed.
// Why: after the 2026-11-09 shutdown 127 co-op matches nobody came back to went on under the offline AI takeover
// (掉线由 AI 接管) with server-run battles and AI rehearsals: 7.7 cores and 15 GB for nobody.
// Spectator seats never count: they watch, they do not play; an offline AI 托管 seat neither (it is offline). Seats that
// departed (left) are not waited for. Installed on Match.prototype by server/match/Match.js (a method container: never
// instantiated; `this` is the match).

import { PHASE } from '../../../shared/constants.js';
import { OFFLINE_HOLD_GRACE_MS } from './common.js';

/** How long after offlineHoldMs the match clears itself: a tenth of the hold, at most OFFLINE_HOLD_GRACE_MS. */
export const offlineGraceMs = (holdMs) => Math.min(OFFLINE_HOLD_GRACE_MS, Math.floor(holdMs / 10));

export class MatchOfflineHold {
  /** Hold or release after a human seat's connection changed (onDisconnect, onReconnect, onLeave, a restore). */
  _updateOfflineHold() {
    if (this.disposed || this.ended) return;
    const humans = this.order.filter((p) => !p.isBot && !p.left);
    if (humans.length && humans.every((p) => p.connected === false)) this._holdOffline();
    else this._releaseOfflineHold();
  }

  /** Every human is offline: stop everything (no-op while held, or with offlineHoldMs 0). */
  _holdOffline() {
    if (this._offline || !(this.offlineHoldMs > 0) || this.phase === PHASE.RESULT) return;
    const now = this.sched.now();
    this._offline = true;
    this._offlineAt = now;
    // the battles: the solo pause's freeze (a solo pause already on just stays on — its own rearm flags are kept)
    if (!this.paused) { this.paused = true; this._pausedAt = now; }
    this._suspendTimers();
    this._offlineTimer = this.sched.setTimeout(() => this.guard(() => this._offlineHoldExpired()), this.offlineHoldMs + offlineGraceMs(this.offlineHoldMs));
    this.log.info?.(`[match ${this.roomCode}] every human seat offline: held (R${this.round} ${this.phase}; cleared after ${Math.round(this.offlineHoldMs / 60_000)} min)`);
    this.markPublic();
  }

  /** A human is back: every clock and deadline moves on by the hold, the timers run on with the time they had left. */
  _releaseOfflineHold() {
    if (!this._offline) return;
    const now = this.sched.now();
    const d = Math.max(0, now - this._offlineAt);
    this._resumeTimers();
    this._endOfflineHold();
    this.offlineHeldMs += d;
    // the clocks the solo pause does not shift (it only ever pauses a battle): draft turns, plugin windows, the
    // local replicas' start; the pause's own shift (deadline, overtime, boss clock, client fields) follows in _unpause
    if (this.draft && this.draft.turnDeadline) this.draft.turnDeadline += d;
    if (this.sp && this.sp.turnDeadline) this.sp.turnDeadline += d;
    for (const w of this.offerWin || []) if (!w.closed && w.deadline) w.deadline += d;
    for (const f of this.fields) if (f.startedAt) f.startedAt += d;
    this._unpause();
    this.log.info?.(`[match ${this.roomCode}] a human seat is back: released after ${Math.round(d / 1000)} s`);
  }

  /** Nobody came back (offlineHoldMs + the grace) and no session expiry ended it: 'abandoned', as MatchPlatform.onLeave. */
  _offlineHoldExpired() {
    this._offlineTimer = null;
    if (!this._offline || this.ended || this.disposed) return;
    this.offlineHeldMs += Math.max(0, this.sched.now() - this._offlineAt);
    this.log.info?.(`[match ${this.roomCode}] nobody came back within ${Math.round(this.offlineHoldMs / 60_000)} min: cleared (R${this.round} ${this.phase})`);
    this.offlineCleared = true;
    this.finish({ victory: false, reason: 'abandoned' });
  }

  /**
   * Drop the hold without moving any clock: a release shifts them and re-arms the timers itself first; finish, dispose
   * and a restore cancel every timer (infra.js _clearTimers, which also ends the suspension).
   */
  _endOfflineHold() {
    if (this._offlineTimer) { this.sched.clearTimeout(this._offlineTimer); this._offlineTimer = null; }
    this._offline = false;
    this._offlineAt = 0;
  }
}
