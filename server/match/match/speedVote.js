// server/match/match/speedVote.js — Match methods: 战斗 2 倍速 (the owner's rule of 2026-11-01), a standing vote of the
// connected humans to run the battles at twice the normal speed: SPEED_VOTE_MULT × the match's base game speed (the forced
// 2× of the official battle, or opts.combatSpeed), so 4 game seconds per real second by default.
// [ASSUMED] A remake convenience, not an official rule.
//
// The vote (g.speedVote { agree }): a switch every seated human holds at any time of a running match, spectator seats and
// AI seats excepted; an eliminated human keeps it. voters = the humans connected and not left, recounted on every read,
// so a vote of someone offline neither counts nor blocks (it counts again when they are back); need = rerollNeed(voters),
// ceil(0.75 × voters), the same bar as 重刷本局; a lone human passes it alone.
// It only takes effect when a battle starts: _applySpeedVote runs before the fields of a normal, 联防 or boss / hidden
// battle are built and sets m.gameSpeed for that battle, so everything that reads it — the deadline, the boss clock, the
// Worker's pacing, a replica's b.start — agrees for the battle's whole length: a running battle never changes speed. Falling
// under the bar puts the next battle back on the base speed. Only the clocks scale: game seconds, ticks and every result
// stay what they are, so the time limits in data and combatTimeScale are not touched.
// Everything here is transient: a checkpoint restore drops the votes and goes back to the base speed
// (server/match/snapshot.js MATCH_FIELDS).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { ERR, SPEED_VOTE_MULT } from '../../../shared/constants.js';
import { MAX_GAME_SPEED } from '../fields.js';
import { OK, fail } from './common.js';
import { rerollNeed } from './setupVote.js';

export class MatchSpeedVote {
  /** g.speedVote { agree } */
  setSpeedVote(ps, agree) {
    if (this.disposed || this.ended) return fail(ERR.WRONG_PHASE);
    if (ps.spectator) return fail(ERR.SPECTATOR);
    if (ps.isBot || ps.left || !ps.connected) return fail(ERR.NOT_IN_ROOM);
    if (this._speedVotes.has(ps.playerId) === agree) return OK;
    const now = this.sched.now();
    if (now - (this._speedVoteAt.get(ps.playerId) ?? -Infinity) < 300) return fail(ERR.RATE);
    this._speedVoteAt.set(ps.playerId, now);
    if (agree) this._speedVotes.add(ps.playerId); else this._speedVotes.delete(ps.playerId);
    this.markPublic();
    return OK;
  }

  /**
   * m.public speedVote: `agreed` the voters counted now, `voters` their number, `need` the yes votes it takes; `next`:
   * the next battle starts at 2 倍速 as things stand; `on`: the battle running (or the last one) was started at it, at
   * `speed` game seconds per real second (a stream viewer's clock; a replica has it from b.start).
   */
  speedVoteView() {
    const voters = this.humans().filter((p) => p.connected).map((p) => p.playerId);
    const agreed = voters.filter((id) => this._speedVotes.has(id));
    const need = rerollNeed(voters.length);
    return { agreed, voters: voters.length, need, next: voters.length > 0 && agreed.length >= need,
      on: this._speedUp, speed: this.gameSpeed };
  }

  /** A battle is about to start: its speed, from the votes as they stand. */
  _applySpeedVote() {
    const up = this.speedVoteView().next;
    if (up === this._speedUp) return;
    this._speedUp = up;
    this.gameSpeed = up ? Math.min(this.baseGameSpeed * SPEED_VOTE_MULT, MAX_GAME_SPEED) : this.baseGameSpeed;
    this.log.info?.(`[match ${this.roomCode}] battle speed ${this.gameSpeed} (R${this.round})`);
    this.markPublic();
  }
}
