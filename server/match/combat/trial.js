// Pure bot rehearsal, not a combat phase: no match hooks, settlement, frames or shared boss authority. A Final Assault /
// Hidden Core candidate (kind boss / hidden) brings its pool as data (`boss: { poolHp, poolMax }`) and fights a fresh
// private SharedBossPool, as the inline rehearsal does (server/match/bot.js bossCandidateOpts: a new pool per candidate).
import { Battle } from '../../sim/Battle.js';
import { deepFreeze } from '../../data.js';
import { combatData } from './data.js';
import { DeadBattle } from '../fields.js';
import { SharedBossPool } from '../finalAssault.js';
import { FA_LEAK_SECONDS } from '../../sim/rehearsal.js';
import { REHEARSAL_MAX_CANDIDATES } from '../../../shared/constants.js';

export const MAX_TRIAL_TICKS = 32;
export const TRIAL_SLICE_MS = 4;
/** Candidates of one trial: as many as one rehearsal may compare (bot.js createRehearsalSteps maxCandidates). */
export const MAX_TRIAL_CANDIDATES = REHEARSAL_MAX_CANDIDATES;
/** §37.67 leader-damage counts a trial may return: one per piece uid of the seat (board, bench), far fewer in practice. */
export const MAX_TRIAL_LEAD = 256;
const QUIET = Object.freeze({ error() {}, warn() {}, info() {} });
const invalid = (message) => Object.assign(new TypeError(message), { code: 'BAD_TRIAL_INPUT' });
/** A Final Assault / Hidden Core candidate (the boss field of server/sim/rehearsal.js RehearsalScore). */
export const bossLike = (candidate) => !!candidate && (candidate.kind === 'boss' || candidate.kind === 'hidden');
const poolValue = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** The record nothing has beaten yet (RehearsalScore's initial state). */
export const NO_BEST = Object.freeze({ leaks: Infinity, boss: -Infinity, gain: -Infinity, score: -Infinity });

/**
 * Whether scored candidate record `a` ({ leaks, boss, gain, score }) beats the best so far `b`: server/sim/rehearsal.js
 * RehearsalScore.note's order, so a Worker rehearsal picks what the inline one picks. On a boss field (`boss`: the
 * candidate is a Final Assault / Hidden Core, §37.61) leader damage × max(0, 1 − leaks / FA_LEAK_SECONDS) ranks first
 * once a best exists; a difference within 1e-6 falls back to the usual order: fewer counted leaks, then more leader
 * damage (a normal field records 0), then more layers gained (`gain`, the sum of layerGains, §37.37), then the higher
 * score (−1000 per leak + kills − 0.01 × position: the earlier candidate). The best score therefore need not grow.
 * The candidates are compared one after another against the best so far (the tolerance makes this no total order), so a
 * validator replays that sequence (bestOf) instead of asking whether any record beats the winner.
 */
export function beatsCandidate(a, b, boss = false) {
  if (boss && b.leaks < Infinity && (a.boss > 0 || b.boss > 0)) {
    const value = a.boss * Math.max(0, 1 - a.leaks / FA_LEAK_SECONDS);
    const best = b.boss * Math.max(0, 1 - b.leaks / FA_LEAK_SECONDS);
    if (Math.abs(value - best) > 1e-6) return value > best;
  }
  return a.leaks < b.leaks || (a.leaks === b.leaks && a.boss > b.boss)
    || (a.leaks === b.leaks && a.boss === b.boss && a.gain > b.gain)
    || (a.leaks === b.leaks && a.boss === b.boss && a.gain === b.gain && a.score > b.score);
}

/**
 * The winner of scored records in candidate order (RehearsalScore's sequence): `{ index, best }`, index 0 and NO_BEST
 * while none is scored. `bossAt(i)`: whether candidate i is a boss field.
 * @param {Array<{ score: number|null }>} records
 * @param {(i: number) => boolean} bossAt
 */
export function bestOf(records, bossAt) {
  let index = 0, best = NO_BEST;
  for (let i = 0; i < records.length; i++) {
    const c = records[i];
    if (c && c.score !== null && beatsCandidate(c, best, bossAt(i))) { index = i; best = c; }
  }
  return { index, best };
}

/** §37.37: the layers a candidate's battle gained for its player (RehearsalScore `gain`). */
export const layerGain = (pp) => Object.values(pp?.layerGains || {}).reduce((s, n) => s + (Number(n) || 0), 0);

/**
 * §37.67: count each of `playerId`'s operators' leader damage (by piece uid) in a Final Assault rehearsal battle into
 * `lead` — the counts the damage items go by (bot.js faItemTarget). The inline rehearsal (bot.js createRehearsalJob)
 * and the trial Worker attach this same listener, so both count the same numbers in the same order.
 * @returns {Map<number, number>} `lead`
 */
export function countLeaderDamage(battle, playerId, lead = new Map()) {
  battle?.on?.('hpChanged', (c) => {
    const u = c && c.credit;
    if (!(c && c.delta < 0) || !c.target || !c.target.bossPool || c.target.side === 'ally' || !u || u.uid == null || u.ownerId !== playerId) return;
    lead.set(u.uid, (lead.get(u.uid) || 0) - c.delta);
  }, { priority: -2000, owner: 'bot-fa-items' });
  return lead;
}

/** Whether `lead` is a trial's §37.67 count list: [uid, damage] pairs, unique uids, finite non-negative damage. */
export function validLead(lead) {
  if (!Array.isArray(lead) || lead.length > MAX_TRIAL_LEAD) return false;
  const seen = new Set();
  for (const e of lead) {
    if (!Array.isArray(e) || e.length !== 2 || !Number.isSafeInteger(e[0]) || seen.has(e[0])
      || typeof e[1] !== 'number' || !Number.isFinite(e[1]) || e[1] < 0) return false;
    seen.add(e[0]);
  }
  return true;
}

function assertDataOnly(value, path = 'trial', ancestors = new Set()) {
  if (value == null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)) return;
  if (typeof value !== 'object' || ancestors.has(value) || Object.getOwnPropertySymbols(value).length ||
      (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) {
    throw invalid(`${path} must contain only plain data (no functions, instances or cycles)`);
  }
  ancestors.add(value);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value') || (!descriptor.enumerable && !(Array.isArray(value) && key === 'length'))) {
      throw invalid(`${path}.${key} must be an enumerable data property`);
    }
    assertDataOnly(descriptor.value, `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

// Do NOT round-trip through BattleSpec/JSON: rehearsal uses raw Battle options, including undefined flags,
// explicit Infinity and loadouts. Reject functions/references rather than silently erasing their semantics.
const snapshots = new WeakSet();
const frozenCandidates = new WeakSet();
function validateTrialInput(input) {
  assertDataOnly(input);
  if (!input || typeof input.playerId !== 'string' || !input.playerId ||
      !Array.isArray(input.candidates) || !input.candidates.length || input.candidates.length > MAX_TRIAL_CANDIDATES ||
      !Number.isSafeInteger(input.cap) || input.cap < 1) throw invalid(`playerId, 1..${MAX_TRIAL_CANDIDATES} candidates and positive cap required`);
  // §37.67: `lead` asks for the winner's per-operator leader damage (a bot's own Final Assault rehearsal)
  if (input.lead !== undefined && input.lead !== true) throw invalid('trial lead must be true or absent');
  for (const candidate of input.candidates) {
    if (!candidate || typeof candidate !== 'object') throw invalid('invalid trial candidate');
    if (candidate.content != null && !['full', 'generic', 'none'].includes(candidate.content)) throw invalid('unknown trial content mode');
    if (!candidate || (candidate.kind != null && candidate.kind !== 'normal' && !bossLike(candidate)) || candidate.sharedBoss != null ||
        candidate.data != null || candidate.logger != null || candidate.extraContent != null || candidate.stage != null) {
      throw invalid('trial requires normal / boss / hidden, data-only Battle options with stageId and no shared authority');
    }
    if (bossLike(candidate) && !(candidate.boss && typeof candidate.boss === 'object' && poolValue(candidate.boss.poolHp)
        && poolValue(candidate.boss.poolMax))) throw invalid('a boss / hidden trial candidate needs boss { poolHp, poolMax }');
    if (!Array.isArray(candidate.players) || !candidate.players.some((p) => p?.playerId === input.playerId)) throw invalid('trial player missing');
  }
}

function remember(input) {
  snapshots.add(input);
  for (const candidate of input.candidates) frozenCandidates.add(candidate);
  return input;
}

export function snapshotTrialInput(input) {
  if (input && snapshots.has(input)) return input;
  validateTrialInput(input);
  try { return remember(deepFreeze(structuredClone(input))); }
  catch (e) { throw invalid(`trial options are not serializable: ${e.message}`); }
}

// Only snapshots captured by this module are trusted. Frozen user objects/flags cannot forge admission.
// The new envelope and array are owned here; each candidate is already independently frozen data.
// `lead` (§37.67) is carried only when true, so every other trial input keeps its established shape.
export function assembleTrialInput({ playerId, candidates, cap, lead = false }) {
  if (typeof playerId !== 'string' || !playerId || !Number.isSafeInteger(cap) || cap < 1 || (lead !== false && lead !== true) ||
      !Array.isArray(candidates) || !candidates.length || candidates.length > MAX_TRIAL_CANDIDATES ||
      !candidates.every((c) => frozenCandidates.has(c) && c.players.some((p) => p?.playerId === playerId))) {
    return snapshotTrialInput({ playerId, candidates, cap, ...(lead === false ? {} : { lead }) });
  }
  return remember(Object.freeze({ playerId, candidates: Object.freeze(candidates.slice()), cap, ...(lead ? { lead: true } : {}) }));
}

// MessagePort has already separated ownership. Still validate every field before freezing it in place.
export function receiveTrialInput(input) {
  validateTrialInput(input);
  return remember(deepFreeze(input));
}

const countedLeaks = (battle, playerId) => {
  const pp = battle.result()?.perPlayer?.[playerId];
  return pp ? (pp.leaked || []).filter((l) => l && l.counted !== false).length : 0;
};

export class TrialEngine {
  constructor(input, { data, log = QUIET, BattleClass = Battle, summary = false, isolated = false } = {}) {
    this.input = isolated ? receiveTrialInput(input) : snapshotTrialInput(input);
    this.summary = summary;
    this.sliceCount = 0;
    this.synthetic = [];
    this.data = combatData(data);
    this.log = log;
    this.BattleClass = BattleClass;
    this.battle = null;
    this.index = 0;
    this.ticks = 0;
    this.totalTicks = 0;
    this.bestIndex = 0;
    this.bestScore = -Infinity;
    this.bestLeaks = Infinity;
    this.bestBoss = -Infinity;
    this.bestGain = -Infinity;
    /** §37.67 (input.lead): the running candidate's leader damage per piece uid, and the winner's */
    this.lead = null;
    this.bestLead = null;
    this.completed = [];
    this.done = false;
    this.disposed = false;
  }

  state({ stream = this.summary } = {}) {
    if (this.disposed) throw new Error('trial engine disposed');
    const state = { done: this.done, candidateIndex: this.index, ticks: this.totalTicks,
      bestIndex: this.bestIndex, bestScore: this.bestScore, bestLeaks: this.bestLeaks, bestBoss: this.bestBoss, bestGain: this.bestGain,
      // §37.67: the winner's [uid, leader damage] pairs once done (asked for by input.lead only)
      ...(this.input.lead ? { bestLead: this.done ? [...(this.bestLead || [])] : null } : {}) };
    if (stream) return { ...state, summary: this.summary, sliceCount: this.sliceCount,
      candidates: this.completed.map((c, i) => ({ ...c, synthetic: this.synthetic[i],
        result: this.done && !this.summary ? structuredClone(c.result) : null })) };
    // Full legacy results cross only once; its established DTO remains unchanged.
    return { ...state, candidates: this.done ? structuredClone(this.completed)
      : this.completed.map(({ result, ...score }) => score) };
  }

  advance(ticks = MAX_TRIAL_TICKS) {
    this.advanceSlice(ticks);
    return this.state();
  }

  advanceSlice(ticks = MAX_TRIAL_TICKS) {
    if (this.disposed) throw new Error('trial engine disposed');
    if (!Number.isInteger(ticks) || ticks < 1 || ticks > MAX_TRIAL_TICKS) throw new RangeError(`trial ticks must be 1..${MAX_TRIAL_TICKS}`);
    if (this.done) return true;
    this.sliceCount++;
    const start = performance.now();
    let n = 0;
    while (!this.done) { // loop-cap: the slice budget below (ticks / wall time), then the candidates run out
      if (!this.battle) {
        // Lazy construction bounds initialization too: never build all candidates in one wire turn.
        this.candidateError = null;
        this.lead = this.input.lead ? new Map() : null;
        try {
          const candidate = this.input.candidates[this.index];
          this.battle = new this.BattleClass({ ...candidate,
            ...(bossLike(candidate) ? { sharedBoss: new SharedBossPool(candidate.boss.poolHp) } : {}), data: this.data, logger: this.log });
          // the inline rehearsal's listener, attached at the same point (before the first step)
          if (this.lead) try { countLeaderDamage(this.battle, this.input.playerId, this.lead); } catch { /* no counts */ }
        } catch (e) {
          // Match.newBattle's same stand-in: synthetic candidates cannot score, but later candidates still run.
          this.battle = new DeadBattle(this.input.candidates[this.index]);
          this.candidateError = String(e?.message ?? e);
        }
        if (performance.now() - start >= TRIAL_SLICE_MS) break;
      }
      let beaten = false, failed = false;
      // RehearsalScore.alive: a boss field stops no candidate early (one that leaks more can still deal more, §37.61)
      const prunes = !bossLike(this.input.candidates[this.index]);
      try {
        while (this.ticks < this.input.cap && !this.battle.finished) { // loop-cap: input.cap ticks
          this.battle.step();
          this.ticks++;
          this.totalTicks++;
          n++;
          // Exactly the original rehearsal's 64-tick pruning boundary, before its time-budget check.
          if (prunes && (this.ticks & 63) === 0 && this.bestLeaks < Infinity && countedLeaks(this.battle, this.input.playerId) > this.bestLeaks) {
            beaten = true;
            break;
          }
          if (n >= ticks || ((n & 3) === 0 && performance.now() - start >= TRIAL_SLICE_MS)) return this.done;
        }
      } catch (e) {
        failed = true;
        this.candidateError = String(e?.message ?? e);
      }
      const record = { index: this.index, ticks: this.ticks, duration: this.battle.time, beaten, leaks: null, boss: null, gain: null, score: null, result: null, error: this.candidateError };
      // the inline job keeps candidate 0's counts while nothing beat it (leads[run.score.index])
      if (this.index === 0) this.bestLead = this.lead;
      let synthetic = null;
      if (!beaten && !failed) try {
        if (!this.battle.finished) this.battle.forceEnd('timeout');
        const result = this.battle.result();
        const pp = result && !result.synthetic && result.perPlayer?.[this.input.playerId];
        synthetic = result ? !!result.synthetic : null;
        if (!this.summary) record.result = structuredClone(result);
        record.duration = this.battle.time;
        if (pp) {
          record.leaks = (pp.leaked || []).filter((l) => l && l.counted !== false).length;
          record.boss = Math.max(0, Number(pp.bossDamage) || 0);
          record.gain = layerGain(pp);
          record.score = -record.leaks * 1000 + (pp.killed || 0) - this.index * 0.01;
          if (beatsCandidate(record, { leaks: this.bestLeaks, boss: this.bestBoss, gain: this.bestGain, score: this.bestScore },
            bossLike(this.input.candidates[this.index]))) {
            this.bestScore = record.score;
            this.bestLeaks = record.leaks;
            this.bestBoss = record.boss;
            this.bestGain = record.gain;
            this.bestIndex = this.index;
            this.bestLead = this.lead;
          }
        }
      } catch (e) {
        record.error = String(e?.message ?? e);
        record.result = null;
      }
      this.completed.push(record);
      this.synthetic.push(synthetic);
      this.battle = null;
      this.lead = null;
      this.index++;
      this.ticks = 0;
      this.done = this.index >= this.input.candidates.length;
      if (n >= ticks || performance.now() - start >= TRIAL_SLICE_MS) break;
    }
    return this.done;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.battle = null;
    this.input = null;
    this.data = null;
    this.BattleClass = null;
    this.log = null;
    this.completed = [];
    this.synthetic = [];
    this.lead = null;
    this.bestLead = null;
  }
}
