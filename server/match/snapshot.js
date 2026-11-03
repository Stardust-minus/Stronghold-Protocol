// server/match/snapshot.js — checkpoints of a running match (docs/DEPLOY.md「断点续玩」, server/persist/).
//
// WHY A CHECKPOINT AND NOT A REPLAY: the engine is deterministic in virtual time (tests run whole matches on a
// VirtualScheduler), but a *live* match is not: bot preps, rehearsals and server-run fields are sliced by wall-clock
// budgets (server/match/bot.js, server/match/fields.js, the combat Worker pool), so how a client frame interleaves with
// a sliced job depends on real time. Instead this module saves the match *state* — and only while the match sits in a
// phase whose state is plain data apart from a handful of Maps, Sets and the RNG positions.
//
// SAFE PHASES. A checkpoint is taken in INFO_CHECK, BAND_DRAFT, SP_DRAFT, ROUND_START or PREP (in PREP only once every
// AI-driven seat finished its sliced prep, canSnapshot): no battle object, pacer, field or boss pool is alive then. The
// last one of a round is taken as its prep ends (Match._checkpoint('prep-end'), before the prep's end mutates
// anything): a match interrupted in COMBAT / UNITE / SETTLE / FINAL_ASSAULT / HIDDEN_CORE resumes from it — the same
// round, operators, items, economy, LP, pools and RNG positions, the round's battle fought again under a fresh battleId
// (RESTORE_SEQ_GAP).
//
// ON RESTORE (restoreMatch, into a fresh Match built from the same seats and seed — the constructor redraws the same
// setup) the saved fields replace the constructor's, the pools are rebuilt from the saved bans and given their saved
// copies, every human seat is offline (the platform rebinds it when its player comes back) and the phase is entered
// again: a phase clock restarts from the remaining time the checkpoint recorded, a prep gets at least
// MIN_RECOVER_PREP_SEC and its humans are not Ready (they come back to their board first), a draft starts its current
// turn (a concurrent draft: its one countdown) over, a setup vote is dropped. A solo pause does not survive.
// A checkpoint written as the prep ended (its envelope's reason CHECKPOINT_PREP_END) means the match was past that
// prep — fighting, settling — when it stopped: restoreMatch({ replay: true }) marks the round (replayRound), and
// m.public carries it through that prep so the players learn the round's battle is fought again (ui/matchNotice.js).
//
// EVERY FIELD IS CLASSIFIED. MATCH_FIELDS / PLAYER_FIELDS below name what is saved, derived (rebuilt from the seats,
// the seed, the options and the data) or transient (timers, caches, views, battle objects). test/match/snapshot.test.js
// plays whole matches and fails on any own property of a Match or a PlayerState that is not classified — a new field
// must be added to one of the lists (and SNAPSHOT_VERSION raised when a saved field changes meaning).

import { PHASE } from '../../shared/constants.js';
import { SharedPool, createItemPools } from './pool.js';

/**
 * Checkpoint layout version. A document of another version is refused (the match is dropped, server/persist/).
 * Raise it whenever a saved field is added, removed or changes its meaning, or the restore rules below change.
 */
export const SNAPSHOT_VERSION = 1;

/** Phases whose state is fully serializable (see the header). */
export const SNAPSHOT_PHASES = Object.freeze([PHASE.INFO_CHECK, PHASE.BAND_DRAFT, PHASE.SP_DRAFT, PHASE.ROUND_START, PHASE.PREP]);

/** The checkpoint reason of the prep's end (Match._checkpoint in match/prep.js): a restore from it replays the round. */
export const CHECKPOINT_PREP_END = 'prep-end';

/** A restored round's battles get ids far above the interrupted ones (a stale report can never match a new battle). */
export const RESTORE_SEQ_GAP = 1000;

/** The prep a restored match is guaranteed to have left (s). */
export const MIN_RECOVER_PREP_SEC = 20;

/** The INFO_CHECK guard a restored match is guaranteed to have left (s). */
const MIN_RECOVER_INFO_SEC = 5;

/** Match DELAYS.ROUND_START in seconds (kept local: the engine's timers are re-armed through its own methods). */
const ROUND_START_SEC = 2;

/** The RNG streams the match owns (Match constructor; server/sim/rng.js state() / createRngFromState). */
const RNG_NAMES = Object.freeze(['rngSetup', 'rngShop', 'rngWaves', 'rngDraft', 'rngBots', 'rngMeta']);

/**
 * Every own property of a Match. `saved`: copied into the checkpoint and back; `special`: saved, restored by its own
 * rule below; `derived`: rebuilt by the constructor from the seats / seed / options / data, or by restoreMatch;
 * `transient`: timers, caches, view plumbing and battle state — reset on restore.
 */
export const MATCH_FIELDS = Object.freeze({
  saved: Object.freeze([
    'stageId', 'factions', 'bossId', 'hiddenBossId', 'disabledBonds', 'staticInactiveBonds', 'bannedChess',
    'setupRevision', '_setupVoteSeq', 'loneHuman', 'uidSeq', 'pausedMs', 'verifyStats', 'rehearsalStats', '_rehearsalSeq',
    'errors', 'errorCount', 'simErrors', 'simErrorLog', 'localStats', 'watchPref', 'lastResults', '_revival',
    'draft', 'sp', 'wave', 'bossWaves', 'bossPairs', 'bossPairsRound', 'hiddenLayerSum', 'finalAliveCount', 'hiddenReached', 'outcome',
    '_botEmotesSettledRound',
    // plugin interaction windows (0.3.1, match/offers.js): the id counter only — no checkpoint is taken while one is open
    'offerSeq',
  ]),
  special: Object.freeze([
    'phase', 'round', 'deadline', 'startedAt', '_battleSeq', 'damageBoard', 'poolGroups', 'playerItemPools',
    ...RNG_NAMES,
  ]),
  derived: Object.freeze([
    'opts', 'roomCode', 'mode', 'difficulty', 'modeId', 'seed', 'log', 'sendFn', 'broadcastFn', 'onEndFn', 'data', 'cs', 'vs',
    'requireCs', 'gd', 'isSolo', 'aiPicksLast', 'afkRemoveRounds', 'ownsScheduler', 'sched', 'registry', 'dispatcher',
    'BattleClass', 'battleContent', 'timerScale', 'baseGameSpeed', 'snapshotHz', 'localReplica', 'botRehearsal', 'botSliceMs',
    'botRehearsalDelegate', 'botRehearsalDelegateMs', 'hostId', 'ds', 'clientCombat', 'verifyMode', 'combatPool', 'trialPool',
    'headlessSliceMs', 'battlePrefix', 'experimental', 'revivalEnabled', 'disableSharedPool', 'poolPlan', 'playerCapacity',
    'capacityExperiment', 'twentyPlayerMode', 'disableDuckLord', 'disableLayerCap', 'disableHitLimit', 'enemyHpMul', 'enemyAtkMul', 'players', 'order', 'spectators', 'botBands', 'stage', 'pool',
    'playerPools', 'itemPool', 'ended', 'disposed',
    // 0.3.1: the content set's declared windows and the room's 测试 flag (both from the match options)
    'offers', 'test',
    // 0.3.2: the official version (a hosted match's: its match host checkpoints it, server/persist/persister.js), the bot
    // strategy, the room's simulation pool, the external AI
    'version', 'bot', 'simPool', 'externalAI',
  ]),
  transient: Object.freeze([
    '_rehearsalTasks', 'paused', '_pausedAt', '_bossPubTimer', '_bossPubAt', '_bossClockOn', '_damageDirty', '_damageTimer',
    '_damageAt', '_damageSampleAt', '_damageSent', '_progressTimer', '_bossClock', '_lastPoolAt', '_poolTimer', '_lastPoolKey',
    'pacer', 'overtimeAt', '_timers', '_phaseTimer', '_infoAdvanceTimer', 'setupVote', '_lastSetupVoteAt', '_turnTimer',
    '_pubDirty', '_pubTimer', '_lastPubAt', '_lastPubJson', '_privDirty', '_prepEndQueued', 'fields', 'runner', 'watchers',
    'localViews', 'unitePlan', '_normalAliveCount', '_uniteRelay', 'uniteResultView', '_uniteLeftKey', '_uniteBounds',
    'teamLp', 'bossPool', '_turnToken', '_botPath', '_botTraits', '_workerBotPrepOwner', '_botEmotesMerges', 'overtimeApplied',
    'bossOvertimeStartReal', '_finalEnding', '_bossStartAt', 'lastResultMsg', 'onCheckpoint', 'replayRound',
    // the reroll proposal marks and the kick vote (setupVote.js, kickVote.js): a restore drops them
    '_setupProposals', 'kickVote', '_kickVoteSeq', '_kickFailed', '_kickVoteAt',
    // 战斗 2 倍速 (speedVote.js): the votes and the speed they set go with the run; a restore is back on the base speed
    '_speedVotes', '_speedVoteAt', '_speedUp', 'gameSpeed',
    // an open plugin window and its continuation (match/offers.js): checkpoints wait for it to close (canSnapshot)
    'offerWin', '_offerTimers', '_offerResume', '_offerResumeTimer',
    // how the bot rehearsals offered to simPool ended
    'rehearsalPoolStats',
  ]),
});

/** Every own property of a PlayerState (the same four kinds as MATCH_FIELDS). */
export const PLAYER_FIELDS = Object.freeze({
  saved: Object.freeze([
    'left', 'revived', 'pendingDeath', 'revivalUnavailableReason', 'autoplay', 'afkActed', 'afkRounds', 'offlineRounds',
    'offlineAutoplay', 'alive', 'lp', 'bandId', 'funds', 'pendingFunds', 'infoReady', 'lastEmoteAt', 'bondPlan',
    'shop', 'offers', 'hand', 'temp', 'prepsEnded', '_tempDue', 'board', 'layers', 'battleLayerGains', 'pendingLayerGains',
    'bondCountBonus', 'effects', 'bounties', 'personalChoice', 'counters', 'round', 'deployCapBonus', 'deployCapMin',
    'deviceOverrides', 'tileOverrides', 'stats', 'eliminatedRound', 'creditedKills', 'lpAtFinal', 'lastResult',
    '_botFocus', '_botFocusId', '_botSeenUids', '_deferItemMerge', 'aiTakeoverRound',
    // 自选候补 (feedback #114): the briefing's choice per tier (a server without it ignores the key)
    'diyChoice',
  ]),
  special: Object.freeze(['ready', 'connected', 'loadout', 'ops', 'skins', 'diyStock']),
  derived: Object.freeze([
    'm', 'gd', 'playerId', 'seat', 'name', 'isBot', 'standIns', '_standInSet', 'diy', '_diyRecords', 'diyBanned', 'bonds',
    'diyPreset',
  ]),
  transient: Object.freeze([
    '_deployMap', '_deployField', '_legalityStale', '_botPrepToken', '_botPrepWork', '_lastPriv', '_botRangeRecs',
    // the rid echoed as m.private `ack` (client-side prediction, rel26): per socket, reset on every reconnect
    'intentAck',
  ]),
});

/**
 * True when a checkpoint of the match's current state may be taken (see the header). PREP additionally waits for every
 * AI-driven seat to finish its sliced prep: a checkpoint in the middle of a bot's chain would capture a half-built
 * layout that the restored prep would buy for again.
 * @param {import('./Match.js').Match} m
 */
export function canSnapshot(m) {
  if (!m || m.disposed || m.ended || m.paused) return false;
  if (!m.sched || typeof m.sched.now !== 'function' || !(m.players instanceof Map) || !Array.isArray(m.poolGroups)) return false;
  if (!SNAPSHOT_PHASES.includes(m.phase)) return false;
  if (m.fields?.length || m.runner || m.pacer || m.bossPool || m.teamLp) return false;
  // an open plugin window (0.3.1) holds the round back on a continuation a checkpoint cannot carry; a test match never
  // checkpoints (its journal is the record)
  if ((Array.isArray(m.offerWin) && m.offerWin.length) || m._offerResume || m.test) return false;
  if (m.phase === PHASE.PREP) for (const ps of m.alivePlayers()) if (ps.botControlled && !ps.ready) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------------
// value codec (JSON + Map / Set / non-finite numbers / non-enumerable properties)
// ---------------------------------------------------------------------------------------------------
//
// The engine keeps a few things JSON cannot carry: Maps (boards, the temp due list, caches), Sets, ±Infinity (an
// untouched emote cooldown) — and `factions`, which carries the round schedule as a *non-enumerable* `schedule`
// property (waves.js setupMatchWaves: a plain array must stay an array for buildNormalWave). Dropping it would silently
// change every later wave, so the codec round-trips own data properties of arrays and objects whether enumerable or
// not. Accessors are never read. A function or a class instance is refused (unsupported state: the match is not
// checkpointed rather than restored wrong).

const MAP_TAG = '$spMap';
const SET_TAG = '$spSet';
const NUM_TAG = '$spNum';
const ARR_TAG = '$spArr';
const PROPS_TAG = '$spProps';
const UNDEF_TAG = '$spUndef';

class SnapshotError extends Error {}

const isIndex = (k, v) => String(Number(k)) === k && Number(k) >= 0 && Number(k) < v.length;

/** Own data properties not already covered by the value itself (an array's extra keys; an object's hidden ones). */
function extraProps(v, depth) {
  const out = {};
  let n = 0;
  for (const k of Object.getOwnPropertyNames(v)) {
    if (Array.isArray(v) && (k === 'length' || isIndex(k, v))) continue;
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || !('value' in d)) continue;
    if (!Array.isArray(v) && d.enumerable) continue;
    out[k] = encodeValue(d.value, depth);
    n++;
  }
  return n > 0 ? out : null;
}

/**
 * JSON-safe encoding of a state value.
 * @param {unknown} v
 * @param {number} [depth]
 * @returns {unknown}
 */
export function encodeValue(v, depth = 0) {
  if (depth > 64) throw new SnapshotError('state too deep');
  if (v === null) return null;
  if (v === undefined) return { [UNDEF_TAG]: 1 };
  const t = typeof v;
  if (t === 'number') return Number.isFinite(v) ? v : { [NUM_TAG]: String(v) };
  if (t === 'string' || t === 'boolean') return v;
  if (t !== 'object') throw new SnapshotError(`unsupported ${t} in match state`);
  const d = depth + 1;
  if (Array.isArray(v)) {
    const items = new Array(v.length);
    for (let i = 0; i < v.length; i++) items[i] = encodeValue(v[i], d);
    const extra = extraProps(v, d);
    return extra ? { [ARR_TAG]: items, [PROPS_TAG]: extra } : items;
  }
  if (v instanceof Map) return { [MAP_TAG]: [...v].map(([k, x]) => [encodeValue(k, d), encodeValue(x, d)]) };
  if (v instanceof Set) return { [SET_TAG]: [...v].map((x) => encodeValue(x, d)) };
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) throw new SnapshotError(`unsupported ${proto?.constructor?.name || 'object'} in match state`);
  const out = {};
  for (const k of Object.keys(v)) out[k] = encodeValue(v[k], d);
  const extra = extraProps(v, d);
  // the marker form only ever holds marker keys, so a plain object never collides with it (decodeValue)
  return extra ? { [PROPS_TAG]: { ...extra, ...out }, $spHidden: Object.keys(extra) } : out;
}

const markerOnly = (v, ...tags) => {
  const ks = Object.keys(v);
  return ks.length > 0 && ks.every((k) => tags.includes(k));
};

function hide(target, key, value) {
  try { Object.defineProperty(target, key, { value, enumerable: false, writable: true, configurable: true }); }
  catch { /* a frozen target: nothing sensible to do */ }
}

/** Inverse of encodeValue. */
export function decodeValue(v) {
  if (v === null) return null;
  const t = typeof v;
  if (t === 'number' || t === 'string' || t === 'boolean') return v;
  if (Array.isArray(v)) return v.map(decodeValue);
  if (t !== 'object') return null;
  if (markerOnly(v, UNDEF_TAG)) return undefined;
  if (markerOnly(v, NUM_TAG)) return Number(v[NUM_TAG]);
  if (markerOnly(v, MAP_TAG)) return new Map((v[MAP_TAG] || []).map(([k, x]) => [decodeValue(k), decodeValue(x)]));
  if (markerOnly(v, SET_TAG)) return new Set((v[SET_TAG] || []).map(decodeValue));
  if (markerOnly(v, ARR_TAG, PROPS_TAG)) {
    const arr = (v[ARR_TAG] || []).map(decodeValue);
    for (const [k, x] of Object.entries(v[PROPS_TAG] || {})) hide(arr, k, decodeValue(x));
    return arr;
  }
  if (markerOnly(v, PROPS_TAG, '$spHidden')) {
    const hidden = new Set(Array.isArray(v.$spHidden) ? v.$spHidden : []);
    const out = {};
    for (const [k, x] of Object.entries(v[PROPS_TAG] || {})) {
      if (hidden.has(k)) hide(out, k, decodeValue(x));
      else out[k] = decodeValue(x);
    }
    return out;
  }
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = decodeValue(x);
  return out;
}

const deepFreeze = (v) => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
};

// ---------------------------------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------------------------------

/**
 * The seats a restored match is built from (Match opts.seats): what the constructor derives state from — seat index,
 * id, name, AI flag, an AI seat's designated strategy, a human's stand-ins and 自选 picks (fixed for the match; with
 * 候补 — feedback #114 — the slots as they are now plus the candidates not slotted as bench keys, player/diy.js
 * diyBenchSeat: a restore fields the same slots, and a server without 候补 drops the bench keys). The loadout, 潜能 /
 * 练度 and skins are saved player fields.
 * @param {import('./Match.js').Match} m
 */
export function matchSeats(m) {
  return m.order.map((ps) => ({
    seat: ps.seat, playerId: ps.playerId, name: ps.name, isBot: ps.isBot, connected: false,
    ...(ps.isBot ? {} : { notOwned: [...ps.standIns], diy: { ...ps.diy, ...ps.diyBenchSeat() } }),
    ...(ps.isBot && m.botBands.has(ps.playerId) ? { band: m.botBands.get(ps.playerId) } : {}),
  }));
}

/**
 * Checkpoint the match, or null when it cannot be checkpointed now (canSnapshot) or holds state the codec refuses —
 * the caller keeps the previous checkpoint then. The document is plain JSON (JSON.stringify-ready).
 * @param {import('./Match.js').Match} m
 * @returns {object | null}
 */
export function snapshotMatch(m) {
  if (!canSnapshot(m)) return null;
  try { return buildSnapshot(m); } catch { return null; }
}

/** @param {import('./Match.js').Match} m */
function buildSnapshot(m) {
  const now = m.sched.now();
  const doc = {
    v: SNAPSHOT_VERSION, phase: m.phase, round: m.round, seed: m.seed, battlePrefix: m.battlePrefix, savedAt: now,
    mode: m.mode, difficulty: m.difficulty, modeId: m.modeId, experimental: { ...m.experimental }, aiPicksLast: m.aiPicksLast,
    seats: matchSeats(m), spectators: [...m.spectators.keys()],
    // the phase clock travels as *remaining* time: the match is frozen while the server is down
    deadlineRemainingMs: m.deadline > 0 ? Math.max(0, Math.round(m.deadline - now)) : 0,
    startedAtAgoMs: Math.max(0, Math.round(now - (Number(m.startedAt) || now))),
    battleSeq: m._battleSeq | 0,
    match: {}, players: [],
    // every chess-pool group's remaining copies (caps and tiers are data-derived), every equipment group's debt
    pools: m.poolGroups.map((g) => Object.fromEntries([...g.pool.entries].map(([id, e]) => [id, e.left]))),
    ...(m.disableSharedPool ? { soloPool: Object.fromEntries([...m.pool.entries].map(([id, e]) => [id, e.left])) } : {}),
    itemDebt: m.poolGroups.map((g) => [...(m.playerItemPools.get(g.playerIds[0])?.debt || new Map())]),
    rng: Object.fromEntries(RNG_NAMES.map((n) => [n, m[n].state() >>> 0])),
    damageBoard: encodeValue({ ...m.damageBoard }),
  };
  // a vote in INFO_CHECK is dropped on restore: keep its paused confirmation budget instead of a zero deadline
  if (m.setupVote && m.phase === PHASE.INFO_CHECK) doc.deadlineRemainingMs = Math.max(0, Number(m.setupVote.remainingMs) || 0);
  for (const k of MATCH_FIELDS.saved) doc.match[k] = encodeValue(m[k]);
  for (const ps of m.order) {
    const p = { playerId: ps.playerId, ready: !!ps.ready, loadout: { ...ps.loadout }, ops: { ...ps.ops }, skins: { ...ps.skins },
      // an absolute time travels as its age (a test's virtual clock, or a host whose clock moved, restarts elsewhere)
      lastEmoteAgoMs: Number.isFinite(ps.lastEmoteAt) ? Math.max(0, now - ps.lastEmoteAt) : null,
      diyStock: Object.fromEntries([...ps.diyStock.entries].map(([id, e]) => [id, e.left])), f: {} };
    for (const k of PLAYER_FIELDS.saved) p.f[k] = encodeValue(ps[k]);
    doc.players.push(p);
  }
  // JSON-safe as it stands (encodeValue): the caller serializes it once
  return doc;
}

// ---------------------------------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------------------------------

/**
 * Whether a checkpoint can be applied to `m` (a fresh Match built from doc.seats with doc.seed): version, phase, seed,
 * battleId prefix and the exact seat roster. @returns {string | null} the reason it cannot, null when it can
 */
export function checkSnapshot(m, doc) {
  if (!m || !doc || typeof doc !== 'object') return 'empty';
  if (doc.v !== SNAPSHOT_VERSION) return `version ${doc.v}`;
  if (!SNAPSHOT_PHASES.includes(doc.phase)) return `phase ${doc.phase}`;
  if ((Number(doc.seed) >>> 0) !== m.seed || doc.battlePrefix !== m.battlePrefix) return 'seed';
  if (!m.sched || typeof m.sched.now !== 'function' || !Array.isArray(m.poolGroups)) return 'engine';
  const players = Array.isArray(doc.players) ? doc.players : [];
  if (players.length !== m.players.size || players.some((p) => !m.players.has(p?.playerId))) return 'seats';
  if (!Array.isArray(doc.pools) || !doc.match || typeof doc.match !== 'object' || !doc.rng) return 'shape';
  return null;
}

/**
 * Apply a checkpoint to a fresh Match instance — built with the checkpoint's seats (matchSeats), seed, mode, difficulty
 * and experimental options, NOT started — and re-enter its phase (the header). A human's 自选 slots are taken from the
 * checkpoint's seat even when the instance was built from other seats (the cluster: its assignment's). Nothing is dispatched again: income,
 * round-start hooks and prep-start effects already ran before the checkpoint was taken.
 * @param {import('./Match.js').Match} m fresh instance
 * @param {object} doc snapshotMatch
 * @param {{ createRngFromState: (state: number) => any, log?: object, replay?: boolean }} deps `replay`: the checkpoint
 *   was written as its prep ended (CHECKPOINT_PREP_END) — the round's battle is fought again (replayRound)
 * @returns {boolean} false when the document does not fit this match (checkSnapshot)
 */
export function restoreMatch(m, doc, { createRngFromState, log = null, replay = false } = {}) {
  const why = checkSnapshot(m, doc);
  if (why) { log?.warn?.(`[snapshot] ${m?.roomCode}: checkpoint refused (${why})`); return false; }
  if (typeof createRngFromState !== 'function') throw new TypeError('restoreMatch: createRngFromState required');
  const now = m.sched.now();
  for (const k of MATCH_FIELDS.saved) if (Object.hasOwn(doc.match, k)) m[k] = decodeValue(doc.match[k]);
  m.round = Number(doc.round) | 0;
  m.phase = doc.phase;
  m.ended = false;
  m.disposed = false;
  m.startedAt = now - (Number(doc.startedAtAgoMs) || 0);
  // a re-fought round must never collide with the reports of the interrupted one
  m._battleSeq = (Number(doc.battleSeq) || 0) + RESTORE_SEQ_GAP;
  for (const name of RNG_NAMES) {
    const state = doc.rng[name];
    if (Number.isInteger(state)) m[name] = createRngFromState(state >>> 0);
  }
  if (doc.damageBoard && typeof doc.damageBoard === 'object') Object.assign(m.damageBoard, decodeValue(doc.damageBoard));
  m.stage = m.stageId ? m.gd.stage(m.stageId) : null;
  // the game data a release ships may have dropped what the checkpoint holds: such a match does not come back
  if ((m.stageId && !m.stage) || (m.bossId && !m.gd.boss(m.bossId))) { log?.warn?.(`[snapshot] ${m.roomCode}: checkpoint refused (data)`); return false; }

  // the pools of the saved setup (a setup reroll may have changed the bans since the constructor drew them), then the
  // saved copies left and equipment debt — exactly as MatchSetupVote.completeSetupReroll rebuilds them
  const bans = m.bannedChess || [];
  // a six-seat match saved before the 3 + 3 rule goes on with the one enlarged pool it started with
  const poolGroups = m.buildPoolGroups(bans, { legacySix: doc.pools.length === 1 });
  if (poolGroups.length !== doc.pools.length) { log?.warn?.(`[snapshot] ${m.roomCode}: checkpoint refused (pool groups)`); return false; }
  const applyLeft = (pool, saved) => {
    for (const [id, left] of Object.entries(saved || {})) {
      const e = pool.entries.get(id);
      const n = Math.trunc(Number(left));
      // an overdrawn (negative) balance must survive, or returns would expose free copies too early (pool.js take overdraw)
      if (e && Number.isFinite(n)) e.left = Math.min(e.cap, n);
    }
  };
  poolGroups.forEach((g, i) => applyLeft(g.pool, doc.pools[i]));
  m.poolGroups = poolGroups;
  m.pool = m.disableSharedPool ? new SharedPool(m.gd, { banned: bans }) : poolGroups[0].pool;
  if (m.disableSharedPool) applyLeft(m.pool, doc.soloPool);
  m.playerPools = m.routePools(poolGroups);
  m.playerItemPools = createItemPools(m.gd, poolGroups, (id) => m.players.get(id));
  m.itemPool = m.playerItemPools.get(poolGroups[0].playerIds[0]);
  poolGroups.forEach((g, i) => {
    const pool = m.playerItemPools.get(g.playerIds[0]);
    for (const [id, n] of Array.isArray(doc.itemDebt?.[i]) ? doc.itemDebt[i] : []) if (Number(n) > 0) pool.debt.set(id, Math.trunc(Number(n)));
  });

  // transient plumbing: nothing of the interrupted run's timers, views or battles
  for (const h of [...m._timers]) m.cancel(h);
  m._timers.clear();
  Object.assign(m, {
    paused: false, _pausedAt: 0, overtimeAt: 0, deadline: 0, setupVote: null, kickVote: null, _phaseTimer: null, _infoAdvanceTimer: null,
    _turnTimer: null, _pubTimer: null, _pubDirty: false, _lastPubAt: -Infinity, _lastPubJson: '', _prepEndQueued: false,
    _turnToken: 0, _progressTimer: null, _bossPubTimer: null, _bossClock: null, _bossClockOn: false, _poolTimer: null,
    pacer: null, runner: null, fields: [], unitePlan: null, teamLp: null, bossPool: null, _botPath: null, lastResultMsg: null,
    gameSpeed: m.baseGameSpeed, _speedUp: false,
  });
  m._speedVotes.clear();
  m._speedVoteAt.clear();
  m.watchers.clear();
  m.localViews.clear();
  m._privDirty.clear();

  const off = new Set([...(m.disabledBonds || []), ...(m.staticInactiveBonds || [])]);
  for (const p of doc.players) {
    const ps = m.players.get(p.playerId);
    for (const k of PLAYER_FIELDS.saved) if (Object.hasOwn(p.f, k)) ps[k] = decodeValue(p.f[k]);
    if (Number.isFinite(p.lastEmoteAgoMs)) ps.lastEmoteAt = now - p.lastEmoteAgoMs;
    if (!ps.isBot) {
      ps.loadout = deepFreeze(decodeValue(p.loadout) || {});
      ps.ops = deepFreeze(decodeValue(p.ops) || {});
      ps.skins = deepFreeze(decodeValue(p.skins) || {});
    }
    // 自选候补 (feedback #114): the slots the checkpoint's seat names (matchSeats). A platform that builds the fresh match
    // from its own seats — the cluster's assignment, the preset as the match started — would field the preset's first
    // slots, not the ones the player chose in the briefing; the same picks again change nothing.
    const seat = !ps.isBot && Array.isArray(doc.seats) ? doc.seats.find((s) => s && s.playerId === p.playerId) : null;
    if (seat && seat.diy && typeof seat.diy === 'object') ps.setDiy(seat.diy, ps.diyMatchOpts());
    if (!piecesKnown(ps)) { log?.warn?.(`[snapshot] ${m.roomCode}: checkpoint refused (pieces of ${ps.playerId})`); return false; }
    const { stock, banned } = ps.buildDiyStock(off);
    for (const [id, left] of Object.entries(p.diyStock || {})) {
      const e = stock.entries.get(id);
      const n = Math.trunc(Number(left));
      if (e && Number.isFinite(n)) e.left = Math.min(e.cap, n);
    }
    ps.diyStock = stock;
    ps.diyBanned = banned;
    // every socket is gone: the platform rebinds a human seat when its player comes back
    ps.connected = ps.isBot;
    ps.ready = !!p.ready;
    ps._deployMap = null;
    ps._deployField = undefined;
    ps._legalityStale = true;
    ps._botPrepToken = 0;
    ps._botPrepWork = null;
    ps._lastPriv = null;
    ps._botRangeRecs = null;
    ps.recompute();
  }
  enterPhase(m, doc);
  m.replayRound = replay === true && m.phase === PHASE.PREP ? m.round : 0;
  return true;
}

/** Every piece the player holds — and every item on its operators — still exists in its game data (a new release's). */
function piecesKnown(ps) {
  const known = (p) => !p || typeof p !== 'object' ? !p
    : p.kind === 'chess' ? !!ps.gd.chess(p.id) && (Array.isArray(p.items) ? p.items : []).every((x) => !!x && !!ps.gd.item(x.id))
      : p.kind === 'item' ? !!ps.gd.item(p.id) : p.kind === 'token' ? !!ps.gd.token(p.id) : false;
  return ps.hand.every(known) && ps.temp.every(known) && [...ps.board.values()].every(known);
}

/** Re-enter the checkpointed phase (see the header for the clock rules). */
function enterPhase(m, doc) {
  const remaining = Math.max(0, Number(doc.deadlineRemainingMs) || 0);
  switch (m.phase) {
    case PHASE.INFO_CHECK: {
      // solo waits for 准备就绪; co-op keeps the official guard (what was left of it)
      if (m.soloUntimed) m.setDeadline(0);
      else m.setDeadline(Math.max(MIN_RECOVER_INFO_SEC, Math.round(remaining / 1000)), () => m.enterBandDraft());
      m.markPublic();
      for (const ps of m.order) m.markPrivate(ps);
      m.maybeEndInfo();
      break;
    }
    case PHASE.BAND_DRAFT: {
      const d = m.draft;
      if (!d || typeof d !== 'object') throw new TypeError('restored strategy draft missing');
      if (!(d.focus instanceof Map)) d.focus = new Map();
      // the current turn — a concurrent draft's one countdown — starts over with a full clock
      d.turnDeadline = 0;
      if (d.concurrent) { d.armed = false; d.done = false; d.botQueued = new Set(); }
      m.setDeadline(0);
      m.startDraftTurn();
      m.markPublic();
      break;
    }
    case PHASE.SP_DRAFT: {
      const s = m.sp;
      if (!s || typeof s !== 'object') throw new TypeError('restored 机变 draft missing');
      s.turnDeadline = 0;
      if (s.concurrent) { s.armed = false; s.done = false; s.botQueued = new Set(); }
      m.setDeadline(0);
      m.startSpTurn();
      m.markPublic();
      break;
    }
    case PHASE.ROUND_START: {
      m.setDeadline(ROUND_START_SEC, () => m.afterRoundStart(), { silent: m.soloUntimed });
      m.markPublic();
      break;
    }
    case PHASE.PREP: {
      // the humans come back to their board first: not Ready, at least MIN_RECOVER_PREP_SEC (an AI-driven seat stays
      // Ready — its prep was complete when the checkpoint was taken)
      for (const ps of m.alivePlayers()) if (!ps.botControlled) ps.ready = false;
      const secs = m.soloUntimed ? null : Math.max(MIN_RECOVER_PREP_SEC, Math.round(remaining / 1000));
      m.setDeadline(secs, () => m.prepDeadline());
      let i = 0;
      for (const ps of m.alivePlayers()) if (ps.botControlled && !ps.ready) m.scheduleBotPrep(ps, i++);
      m.markPublic();
      for (const ps of m.order) m.markPrivate(ps);
      m.maybeEndPrep();
      break;
    }
    default:
      throw new TypeError(`unsupported restored phase ${m.phase}`);
  }
}

// ---------------------------------------------------------------------------------------------------
// diagnostics (tests / tools)
// ---------------------------------------------------------------------------------------------------

/**
 * The persisted surface of a match, encoded: every saved field, the pools, the RNG positions and the players. Tests use
 * it to assert a checkpoint restores losslessly (clock-dependent draft fields are left out).
 * @param {import('./Match.js').Match} m
 */
export function matchState(m) {
  const match = {};
  for (const k of MATCH_FIELDS.saved) match[k] = encodeValue(m[k]);
  for (const k of ['draft', 'sp']) {
    if (match[k] && typeof match[k] === 'object') for (const x of ['turnDeadline', 'armed', 'done', 'botQueued']) delete match[k][x];
  }
  const pools = m.poolGroups.map((g) => Object.fromEntries([...g.pool.entries].map(([id, e]) => [id, e.left])));
  const rng = Object.fromEntries(RNG_NAMES.map((n) => [n, m[n].state() >>> 0]));
  const players = {};
  for (const ps of m.order) {
    const p = { loadout: ps.loadout, ops: ps.ops, skins: ps.skins, diyStock: Object.fromEntries([...ps.diyStock.entries].map(([id, e]) => [id, e.left])) };
    for (const k of PLAYER_FIELDS.saved) p[k] = encodeValue(ps[k]);
    p.lastEmoteAt = encodeValue(Number.isFinite(ps.lastEmoteAt) ? m.sched.now() - ps.lastEmoteAt : ps.lastEmoteAt);
    players[ps.playerId] = p;
  }
  return { phase: m.phase, round: m.round, match, pools, rng, players };
}
