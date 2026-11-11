// server/match/match/common.js — constants and small helpers shared by the Match method modules
// (server/match/match/*.js); server/match/Match.js re-exports FLOW_TICKER_PRIORITY, DELAYS and BAND_TURN_SECONDS.

/**
 * Ticker priority of the remake's match-flow notices (隐秘核心已解锁, 联防阶段, a player out or gone): the official lines
 * (research 06 §9.2) go BOSS_HIT 30 > CHAR_DAMAGE 20 > SHOP_LEVEL 11 > GOLDEN_CHAR 2 > CHAR_GIFT 1; ours sit under the
 * leader-damage lines [ASSUMED].
 */
export const FLOW_TICKER_PRIORITY = 25;
/** Boss clock period (overtime drain, end checks, silence watchdog) in real ms. */
export const BOSS_CLOCK_MS = 250;
export const OK = Object.freeze({ ok: true });
export const fail = (error, detail) => (detail ? { error, detail } : { error });

/** Fixed presentation delays (real ms, × timerScale). */
export const DELAYS = Object.freeze({
  ROUND_START: 2000,
  COMBAT_END: 1500,
  SETTLE: 3000,
  BOT_ACTION: 900,
  BOT_STAGGER: 350,
  PUBLIC_THROTTLE: 100,
});

/**
 * Seconds of one turn of the co-op strategy draft (user playtest #4 item 4: the old 12 s per turn — research 06 §724,
 * itself [ASSUMED] — inside the 50 s step was far too little and counted apart from the header's 50 s). [ASSUMED]: the
 * official data only gives the whole BAND_CHECK step (autoChessData.enterStepList: 50 s, hint 15 s); the turn clock is
 * the remake's (50 s per turn per the owner's 2026-10-10 official-play report). It is also the step's only countdown (m.public.deadline = draft.turnDeadline). × timerScale.
 */
export const BAND_TURN_SECONDS = 50;

/**
 * 挂机移出 (the owner's rule; Match opts.afkRemoveRounds, 0 = off): the rounds in a row without a substantive intent after
 * which a human seat of a match that started with ≥ 2 humans is removed like a g.leave (MatchPlatform._checkIdle).
 */
export const AFK_REMOVE_ROUNDS = 2;
/**
 * 掉线由 AI 接管 (the owner's rule of 2026-10-14): the prep ends in a row a human seat spends offline before the AI plays
 * it (AI 托管) — from the next phase on; the player takes the seat back by reconnecting (MatchPlatform._checkOffline,
 * onReconnect).
 */
export const OFFLINE_TAKEOVER_ROUNDS = 2;
/**
 * The offline hold (the owner's rule of 2026-11-11, match/offlineHold.js): a match whose human seats are all offline
 * stands still until one of them comes back, and ends 'abandoned' when nobody has come back for this many minutes — a
 * co-op match by default after the plain reconnect window (net.js NET_DEFAULTS.reconnectWindowMs, 10 min: the
 * sessions of a match nobody is online in last that long, Lobby.refreshMatchWindows), a solo run after its own window
 * (data singleReconnectTime, 24 h). Env SP_OFFLINE_HOLD_MINUTES: the co-op figure, an integer 1–1440; 0 = no hold (the
 * seats play on under the offline rules as before).
 */
export const OFFLINE_HOLD_MINUTES = 10;
/**
 * The match's own clear comes a tenth of offlineHoldMs later, at most this long (offlineHold.js offlineGraceMs): the
 * platform's session expiry (same length) departs the players first, as it always did; the match's timer is the backstop
 * where no session is left to expire.
 */
export const OFFLINE_HOLD_GRACE_MS = 60_000;
/** Solo fallback when the data has no singleReconnectTime (server/lobby.js SOLO_RECONNECT_FALLBACK_SEC). */
export const OFFLINE_HOLD_SOLO_FALLBACK_SEC = 86_400;

/** SP_OFFLINE_HOLD_MINUTES → minutes (0 = off); unset → OFFLINE_HOLD_MINUTES; anything else throws. @param {unknown} value */
export function parseOfflineHoldMinutes(value) {
  if (value === undefined || value === null || value === '') return OFFLINE_HOLD_MINUTES;
  const text = String(value).trim();
  const n = /^\d{1,4}$/.test(text) ? Number(text) : NaN;
  if (Number.isInteger(n) && n >= 0 && n <= 1440) return n;
  throw new RangeError('SP_OFFLINE_HOLD_MINUTES must be an integer 0–1440 (0 = no offline hold)');
}
/**
 * A timed PREP ends this long after its published deadline (m.public.deadline is unchanged): an intent a player made
 * just before the countdown ran out still counts when the last mile delayed it — the browser shows it at once (rel26
 * prediction), and refusing it as WRONG_PHASE rolled the board back when the battle started. Match option
 * `prepGraceMs` (0 … 5000) overrides it.
 */
export const PREP_INTENT_GRACE_MS = 1500;
/**
 * The intents that count as playing for that rule — accepted ones only. g.ready, g.infoReady, g.emote, g.watch,
 * g.unitStats, g.pause, g.art, g.bandFocus, g.autoplay, g.rerollVote, g.kickVote, g.kickBallot, g.speedVote, the battle reports and
 * anything else do not.
 */
export const AFK_ACTIONS = new Set(['g.buy', 'g.sell', 'g.move', 'g.refresh', 'g.levelUp', 'g.freeze', 'g.equip', 'g.destroy',
  'g.choice', 'g.reward', 'g.revive', 'g.band', 'g.bandSkip', 'g.bandHold', 'g.bandCancel', 'g.bandLock']);

export const REVIVAL_COST = 10;
export const REVIVAL_MIN_DONOR_LP = 11;
export const REVIVAL_WINDOW_SECONDS = 15;
export const REVIVAL_UNAVAILABLE_REASONS = Object.freeze([
  'disabled', 'no-helper', 'donor-lp', 'window-expired', 'window-closed', 'already-used', 'left', 'match-ended',
]);
