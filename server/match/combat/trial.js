// Pure bot rehearsal, not a combat phase: no match hooks, settlement, frames or shared boss authority.
import { Battle } from '../../sim/Battle.js';
import { deepFreeze } from '../../data.js';
import { combatData } from './data.js';
import { DeadBattle } from '../fields.js';

export const MAX_TRIAL_TICKS = 32;
export const TRIAL_SLICE_MS = 4;
const QUIET = Object.freeze({ error() {}, warn() {}, info() {} });
const invalid = (message) => Object.assign(new TypeError(message), { code: 'BAD_TRIAL_INPUT' });

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
      !Array.isArray(input.candidates) || !input.candidates.length || input.candidates.length > 5 ||
      !Number.isSafeInteger(input.cap) || input.cap < 1) throw invalid('playerId, 1..5 candidates and positive cap required');
  for (const candidate of input.candidates) {
    if (!candidate || typeof candidate !== 'object') throw invalid('invalid trial candidate');
    if (candidate.content != null && !['full', 'generic', 'none'].includes(candidate.content)) throw invalid('unknown trial content mode');
    if (!candidate || (candidate.kind != null && candidate.kind !== 'normal') || candidate.sharedBoss != null ||
        candidate.data != null || candidate.logger != null || candidate.extraContent != null || candidate.stage != null) {
      throw invalid('trial requires normal, data-only Battle options with stageId and no shared authority');
    }
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
export function assembleTrialInput({ playerId, candidates, cap }) {
  if (typeof playerId !== 'string' || !playerId || !Number.isSafeInteger(cap) || cap < 1 ||
      !Array.isArray(candidates) || !candidates.length || candidates.length > 5 ||
      !candidates.every((c) => frozenCandidates.has(c) && c.players.some((p) => p?.playerId === playerId))) {
    return snapshotTrialInput({ playerId, candidates, cap });
  }
  return remember(Object.freeze({ playerId, candidates: Object.freeze(candidates.slice()), cap }));
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
    this.completed = [];
    this.done = false;
    this.disposed = false;
  }

  state({ stream = this.summary } = {}) {
    if (this.disposed) throw new Error('trial engine disposed');
    const state = { done: this.done, candidateIndex: this.index, ticks: this.totalTicks,
      bestIndex: this.bestIndex, bestScore: this.bestScore, bestLeaks: this.bestLeaks };
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
    while (!this.done) {
      if (!this.battle) {
        // Lazy construction bounds initialization too: never build all candidates in one wire turn.
        this.candidateError = null;
        try {
          this.battle = new this.BattleClass({ ...this.input.candidates[this.index], data: this.data, logger: this.log });
        } catch (e) {
          // Match.newBattle's same stand-in: synthetic candidates cannot score, but later candidates still run.
          this.battle = new DeadBattle(this.input.candidates[this.index]);
          this.candidateError = String(e?.message ?? e);
        }
        if (performance.now() - start >= TRIAL_SLICE_MS) break;
      }
      let beaten = false, failed = false;
      try {
        while (this.ticks < this.input.cap && !this.battle.finished) {
          this.battle.step();
          this.ticks++;
          this.totalTicks++;
          n++;
          // Exactly the original rehearsal's 64-tick pruning boundary, before its time-budget check.
          if ((this.ticks & 63) === 0 && this.bestLeaks < Infinity && countedLeaks(this.battle, this.input.playerId) > this.bestLeaks) {
            beaten = true;
            break;
          }
          if (n >= ticks || ((n & 3) === 0 && performance.now() - start >= TRIAL_SLICE_MS)) return this.done;
        }
      } catch (e) {
        failed = true;
        this.candidateError = String(e?.message ?? e);
      }
      const record = { index: this.index, ticks: this.ticks, duration: this.battle.time, beaten, leaks: null, score: null, result: null, error: this.candidateError };
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
          record.score = -record.leaks * 1000 + (pp.killed || 0) - this.index * 0.01;
          if (record.score > this.bestScore) {
            this.bestScore = record.score;
            this.bestLeaks = record.leaks;
            this.bestIndex = this.index;
          }
        }
      } catch (e) {
        record.error = String(e?.message ?? e);
        record.result = null;
      }
      this.completed.push(record);
      this.synthetic.push(synthetic);
      this.battle = null;
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
  }
}
