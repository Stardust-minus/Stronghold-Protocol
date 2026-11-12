// server/match/match/shadowVerify.js — Match methods: shadow verification (DESIGN §14 "Shadow verification",
// server/match/verify/hub.js). The match only reports to its process's hub — the server-run battle is the authority
// whatever the hub counts:
//   * a server-run field starts (combat/runner.js) → the hub may hand its spec to a verifier of another match;
//   * the Worker's result of a field arrives → the field's step time by kind (phase 0) and the comparisons of the
//     hashes its replicas and its verifier report;
//   * g.verifyResult from a seat of THIS match → it was some other match's verifier: the hub takes the answer;
//   * g.sim `client` / `rh` (localReplica.js setLocalSim) → what a page says about itself / a replica's end hash.
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated).

import { OK } from './common.js';
import { fieldCpuKind } from '../verify/hub.js';

/** Finished fields kept by battle id for a replica hash that comes after the next phase replaced `fields`. */
const SHADOW_RECENT = 64;

export class MatchShadowVerify {
  /** A server-run field starts (its spec is what the Worker runs). */
  _shadowStart(f) {
    if (!this.verifyHub) return;
    try { this.verifyHub.offer(this, f); } catch (e) { this.reportError('shadow verify offer', e); }
  }

  /** The Worker's result of field `f` (once per field); `stepMs`: its battle's step time on the Worker. */
  _shadowResult(f, result, stepMs) {
    const hub = this.verifyHub;
    if (!hub || !f || f.shadowSeen) return;
    f.shadowSeen = true;
    try {
      hub.noteFieldCpu(fieldCpuKind(this, f), { ms: Number(stepMs) || 0, ticks: Number(f.battle?.tickCount) || 0 });
      hub.serverResult(this, f, result);
      if (f.battleId) {
        const recent = this._shadowRecent || (this._shadowRecent = new Map());
        recent.set(f.battleId, f);
        if (recent.size > SHADOW_RECENT) recent.delete(recent.keys().next().value);
      }
    } catch (e) { this.reportError('shadow verify result', e); }
  }

  /** The field record of a battle id this match ran (now, or finished recently). */
  _shadowField(battleId) {
    return this.fields?.find((f) => f.battleId === battleId) || this._shadowRecent?.get(battleId) || null;
  }

  /** g.verifyResult { vid, rh?, ticks?, ms?, error? }: this seat verified a battle of another match. */
  verifyResult(ps, msg) {
    if (!this.verifyHub || ps.isBot || ps.spectator) return OK;
    try { this.verifyHub.answer(this, ps, msg); } catch (e) { this.reportError('shadow verify answer', e); }
    return OK;
  }
}
