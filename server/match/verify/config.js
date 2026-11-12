// server/match/verify/config.js — the shadow verification settings (DESIGN §14 "Shadow verification"; the consensus
// design's phases 0 and 1). Read once per process; a bad value refuses to start (server/index.js, cluster/game-runtime.js).
//
//   SP_SHADOW_VERIFY            0 (default): phase 0 only — the server counts, per field kind, the CPU its battles take
//                               and, per browser engine / system, how local display replicas fared; no browser is asked
//                               anything. 1: phase 1 — besides, a battle of a human's normal / 联防 field is also handed to
//                               one browser of ANOTHER match on this process (a verifier) and its result hash compared with
//                               the server's. The server stays the only authority either way: nothing a browser reports
//                               changes a battle, a result or a player's standing.
//   SP_SHADOW_VERIFY_RATE       share of the eligible fields offered to a verifier, 0–1 (default 1)
//   SP_SHADOW_VERIFY_MAX        verifications in flight on this process at most, 1–1000 (default 64)
//   SP_SHADOW_VERIFY_PER_ROUND  verifications one browser runs per round of its own match at most, 1–4 (default 2)
//   SP_SHADOW_VERIFY_DEADLINE_MS how long a verifier has, 2000–120000 ms (default 20000)

export const SHADOW_DEFAULTS = Object.freeze({ verify: false, rate: 1, maxJobs: 64, perRound: 2, deadlineMs: 20_000 });

const blank = (v) => v === undefined || v === null || String(v).trim() === '';

function num(name, raw, min, max, int, dflt) {
  if (blank(raw)) return dflt;
  const s = String(raw).trim();
  const n = Number(s);
  if (!/^\d+(\.\d+)?$/.test(s) || !Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) {
    throw new RangeError(`${name} must be ${int ? 'an integer' : 'a number'} from ${min} to ${max}`);
  }
  return n;
}

/** @param {Record<string, string | undefined>} [env] @returns {typeof SHADOW_DEFAULTS} */
export function parseShadowVerify(env = process.env) {
  const raw = env.SP_SHADOW_VERIFY;
  let verify = SHADOW_DEFAULTS.verify;
  if (!blank(raw)) {
    const s = String(raw).trim().toLowerCase();
    if (s === '1' || s === 'on' || s === 'true') verify = true;
    else if (s === '0' || s === 'off' || s === 'false') verify = false;
    else throw new RangeError('SP_SHADOW_VERIFY must be 0 or 1');
  }
  return Object.freeze({
    verify,
    rate: num('SP_SHADOW_VERIFY_RATE', env.SP_SHADOW_VERIFY_RATE, 0, 1, false, SHADOW_DEFAULTS.rate),
    maxJobs: num('SP_SHADOW_VERIFY_MAX', env.SP_SHADOW_VERIFY_MAX, 1, 1000, true, SHADOW_DEFAULTS.maxJobs),
    perRound: num('SP_SHADOW_VERIFY_PER_ROUND', env.SP_SHADOW_VERIFY_PER_ROUND, 1, 4, true, SHADOW_DEFAULTS.perRound),
    deadlineMs: num('SP_SHADOW_VERIFY_DEADLINE_MS', env.SP_SHADOW_VERIFY_DEADLINE_MS, 2000, 120_000, true, SHADOW_DEFAULTS.deadlineMs),
  });
}
