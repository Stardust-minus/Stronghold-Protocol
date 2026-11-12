// tools/rl/env.mjs — batched whole-match RL environment (route B, plan §8). One Node process runs `envs` matches in
// virtual time (Match + VirtualScheduler, as tools/botbench.mjs). The policy owns, per RL seat, the prep economy
// (buy / sell / refresh / level / freeze / reward / personal choice) and the 机变 draft card; the unchanged legacy
// planner places the lineup (rehearsal 0 or 1 in training), takes leftover rewards, resolves temp and readies.
// A match with a decision pending runs no scheduler callback, so its virtual clock stands still until the policy acts.
import { performance } from 'node:perf_hooks';
import { Names, summarize, actionLabel } from './describe.mjs';
import { Match } from '../../server/match/Match.js';
import { VirtualScheduler } from '../../server/match/scheduler.js';
import { getData } from '../../server/data.js';
import { defineBotStrategy, LEGACY_BOT } from '../../server/match/botStrategyContract.js';
import { createBotPrepSteps, runSteps } from '../../server/match/bot.js';
import { collectViolations } from '../../server/match/invariants.js';
import { snapshotMatch, restoreMatch } from '../../server/match/snapshot.js';
import { createRngFromState } from '../../server/sim/rng.js';
import { Encoder, ACT, KIND, MAX_PREP_ACTIONS, SHOP, OWNED, REWARDS, PERSONAL, CARDS, BANDS, humanBonds, humanPairs, chessInBonds, mainCoreBondOf, rulesOf, bandConflicts } from './spec.mjs';

// Legacy prep with its procurement switched off — rewards too (the policy picks them, under the 让盟约 mask): a personal
// choice left over, arrange, equip, final arrange (+ rehearsal); prepEnd (legacy) applies the rehearsed plan, resolves
// temp, frees a hand slot and readies.
const noop = () => {};
// eslint-disable-next-line require-yield -- an empty step generator: the legacy step it replaces does nothing
const none = function* () { return null; };
export const LAYOUT_ONLY = createBotPrepSteps({ takeOffers: noop, sellJunk: noop, buyLoopSteps: none, levelUp: noop,
  advisorSpendSteps: none, spendDown: noop, maybeFreeze: noop });
// Legacy procurement only (the teacher): everything before the first arrange.
export const PROCURE_ONLY = createBotPrepSteps({ arrangeSteps: none, equipItems: noop });

// Rewards are mostly the team's (the owner's call of 2026-11-11: no learning to sacrifice a teammate): per decision,
// round × (team share of rounds reached + own share) − lp × (team share of LP lost + own share) / starting LP; a win +win.
// fa: the team's share of the round-14 Final Assault leader pool (1 − hp / maxHp of that SharedBossPool: 0 when untouched,
// 1 for a win), paid to every policy seat at the match end (ppo2: a signal between "reached the Final Assault and lost
// badly" and "nearly cleared it"). Every term can be overridden per environment (option `reward`).
export const REWARD = Object.freeze({ round: 0.1, lp: 1.0, win: 2.0, team: 0.75, fa: 0 });

/**
 * Bond potential (盟约激活 / 盟约叠层, the owner's call of 11-12): raw terms of a seat's own bond strip (privateView bonds,
 * which count the board as placed). T = Σ active tier / max tier; S = Σ over ACTIVE stackable bonds (noStack false and
 * per-stack parameters) of min(layers / next layer milestone, 1), the reference being STACK_REF when a bond has no
 * milestone left. Layers banked on an inactive bond do nothing in battle, so they do not count.
 */
export const STACK_REF = 40;
export function bondTerms(gd, bonds) {
  let T = 0, S = 0;
  for (const b of bonds || []) {
    const max = Array.isArray(b.thresholds) && b.thresholds.length ? b.thresholds.length : 1;
    const tier = b.active ? Math.min(b.tier || 0, max) : 0;
    T += tier / max;
    if (!tier) continue;
    const rec = gd.bond(b.bondId);
    if (!rec || rec.noStack || !(rec.perStackParams || []).length) continue;
    const layers = Number(b.layers) || 0;
    const next = (rec.layerMilestones || []).map((x) => Number(x.layer)).filter((x) => x > layers).sort((x, y) => x - y)[0];
    const ref = next || ((rec.layerMilestones || []).length ? 0 : STACK_REF);
    S += ref ? Math.min(layers / ref, 1) : 1; // past the last milestone: full
  }
  return { T, S };
}

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function parseConfig(s) {
  const [mode, diff] = String(s).split(':');
  const solo = mode === 'solo';
  return { name: s, mode: solo ? 'solo' : 'coop', players: solo ? 1 : Math.max(1, Math.min(4, Number(mode.replace('coop', '')) || 4)),
    difficulty: String(diff || 'NORMAL').toUpperCase() };
}

export class SPEnv {
  /**
   * @param {object} o
   * @param {number} [o.envs] matches run side by side
   * @param {Array<string|{name:string,w:number}>} [o.configs] e.g. ['solo:NORMAL', {name:'coop4:HARD', w:2}]
   * @param {number} [o.seed] first match seed (each new match takes the next)
   * @param {number} [o.rehearsal] legacy layout rehearsal candidates (0 or 1 for training)
   * @param {number} [o.legacyMates] in co-op: chance that a seat other than seat 0 is a legacy bot
   * @param {'policy'|'teacher'|'legacy'} [o.mode] policy: decisions come from step(); teacher: legacy procurement with
   *   its calls recorded as env actions (no decisions returned); legacy: no RL seat at all (baseline)
   * @param {boolean} [o.check] collectViolations at every match end
   * @param {'random'|number} [o.humans] co-op seats other than seat 0 marked human (让盟约 training): 'random' = 0..n−1
   * @param {number} [o.humanRL] chance a marked human is driven by the policy instead of legacy (default 0: the policy
   *   drives AI seats only, as in a real room, where a human seat under AI 托管 is legacy's)
   * @param {object} [o.rules] { yieldMain, yieldMerge } (spec.mjs RULES, both on by default)
   * @param {object} [o.experimental] the room's experimental options (Match opts.experimental: disableSharedPool, poolPlan)
   * @param {boolean} [o.metrics] rule metrics for every AI seat and the humans' bond tiers (evaluation; off in training:
   *   they rebuild views on every AI purchase); with `scoutCheck` the direct 让合成 read is compared with the scout
   * @param {boolean} [o.enforce] teacher mode: a legacy call a rule forbids fails instead of running (legacy then does
   *   something else) — the rules' effect at legacy's strength, before any policy is trained
   */
  constructor(o = {}) {
    this.data = o.data || getData({ log: { warn() {}, error() {}, info() {} } });
    this.envs = Math.max(1, o.envs | 0 || 8);
    this.setConfigs(o.configs || ['solo:NORMAL']);
    this.seed = Number.isFinite(o.seed) ? o.seed : 1;
    this.rehearsal = o.rehearsal ?? 0;
    // A4: legacy layout rehearsal on the deciding fights only (Final Assault, Hidden Core), `rehearsal` elsewhere; null = off.
    // m.botRehearsal is read when a prep arranges (bot.js arrangeSteps / createRehearsalSteps); under the VirtualScheduler
    // no worker rehearsal reads it earlier (canUseWorkerRehearsal is false), so switching it at prepBegin is exact.
    this.bossRehearsal = Number.isInteger(o.bossRehearsal) && o.bossRehearsal >= 0 ? Math.min(o.bossRehearsal, 8) : null;
    this.legacyMates = o.legacyMates ?? 0;
    this.mode = o.mode || 'policy';
    this.check = !!o.check;
    this.humans = o.humans ?? 'random';
    this.humanRL = o.humanRL ?? 0;
    this.rules = rulesOf({ ...(o.yieldBonds === false ? { yieldMain: false } : {}), ...(o.rules || {}) });
    this.experimental = o.experimental || null;
    this.enforce = !!o.enforce;
    this.metrics = !!o.metrics;
    // potential-based shaping r = γ·Φ(s') − Φ(s), Φ = wTier·T + wStack·S (bondTerms), Φ(terminal) = 0; own seat only
    this.shaping = o.shaping && (o.shaping.wTier || o.shaping.wStack)
      ? { gamma: Number(o.shaping.gamma), wTier: Number(o.shaping.wTier) || 0, wStack: Number(o.shaping.wStack) || 0 } : null;
    if (this.shaping && !(this.shaping.gamma > 0 && this.shaping.gamma <= 1)) throw new Error('shaping.gamma must be the GAE gamma');
    this.phiSamples = o.phiSamples ? [] : null; // diagnostics: raw bond terms of every seat's final board
    // replay viewer: readable states of these seats' decisions (describe()), and the teacher's own per-prep log
    this.describeSeats = new Set(o.describeSeats || []);
    // diagnostics (ppo3 cost model): CPU ms per round x {prep, battle, teacherProcurement, encode}, decisions per round
    this.timing = o.timing ? {} : null;
    // S1 (ppo3): late-game starts. snapCollect { rounds, prob, configs (difficulty list), cap }: prep-end checkpoints
    // (server/match/snapshot.js, after legacy placement) of these matches go into a per-config pool, with the env's own
    // seat roles; snapStart { frac, configs }: that share of new matches of those difficulties restores a random pooled
    // checkpoint (restoreMatch replay: the checkpoint's round is fought again) instead of starting at round 1.
    // snapQueue: explicit checkpoints to start from, in order (tests).
    this.snapCollect = o.snapCollect ? { rounds: [9, 10, 11, 12, 13], prob: 0.25, configs: ['ABYSS'], cap: 64, ...o.snapCollect } : null;
    this.snapStart = o.snapStart ? { frac: 0.4, configs: ['ABYSS'], ...o.snapStart } : null;
    this.snaps = new Map(); // config name -> [{ doc, roles, round, seed }]
    this.snapQueue = o.snapQueue ? o.snapQueue.slice() : null;
    this.snapStats = { collected: 0, refused: 0, started: 0, restoreFailed: 0 };
    // S3 (ppo3): explicit seeds for the next matches (prioritized level replay; a seed fixes config and roles)
    this.seedQueue = [];
    // band choice (ppo3): bandPolicy { share: RL seats whose band the policy picks (the rest legacy's random pick),
    // planProb: chance a human proxy without a band-tied bond announces a random core 主盟约 }; null = legacy picks all
    this.obsVersion = o.obsVersion ?? 3; // 2: the ppo1/ppo2 layout and 60 actions; 3: S5 blocks + band choice
    this.bandPolicy = o.bandPolicy && this.obsVersion >= 3 ? { share: 0.6, planProb: 0.5, ...o.bandPolicy } : null;
    this.bandStats = { decisions: 0, fallback: 0, humanConflict: 0, aiSameBond: 0, policySeats: 0, legacySeats: 0 };
    // Step 0 (band strength table): seat ai_0's legacy pick returns this band; teammates re-draw instead of taking it
    this.forceBand = o.forceBand || null;
    this.R = Object.freeze({ ...REWARD, ...(o.reward || {}) });
    this.tripLog = !!o.tripLog; // with metrics: every round trip's details in the match result (diagnostics)
    this.scoutCheck = !!o.scoutCheck;
    this.maxMatches = o.maxMatches ?? Infinity; // stop opening new matches after this many (smoke tests)
    this.until = o.until ?? Infinity; // performance.now() after which no new match opens (benchmarks)
    this.envSeed = (o.envSeed ?? 12345) >>> 0;
    this.rng = mulberry32(this.envSeed); // only the config pick of a match without a seed-derived stream
    this.recorder = o.recorder || null; // teacher mode: { sample(kind, traj, obs, mask, action, reward), term(t) }
    this.encoder = null;
    this.trajSeq = 0;
    this.started = 0;
    this.terms = [];
    this.results = [];
    this.stats = { decisions: 0, rejected: 0, forcedEnd: 0, matches: 0, errors: 0, failed: 0, violations: 0, callbacks: 0,
      teacher: { calls: {}, illegal: {}, unrepresented: {}, overCap: 0, preps: 0, blocked: {} }, scoutChecks: 0, scoutMismatch: 0 };
    this.errorSamples = [];
    this.slots = new Array(this.envs).fill(null);
    for (let i = 0; i < this.envs; i++) this.slots[i] = this._open(i);
    this.D = this.encoder.dim; this.A = this.encoder.A;
    this._buf(64);
  }

  setConfigs(list) {
    this.configs = list.map((c) => (typeof c === 'string' ? { ...parseConfig(c), w: 1 } : { ...parseConfig(c.name), w: c.w ?? 1 }));
    this.cw = this.configs.reduce((s, c) => s + c.w, 0);
  }

  spec() { return { ...this.encoder.spec(), reward: this.R, configs: this.configs.map((c) => c.name) }; }

  _buf(n) {
    this.cap = n;
    this.obs = new Float32Array(n * this.D); this.mask = new Uint8Array(n * this.A);
    this.ids = new Int32Array(n); this.kinds = new Int32Array(n); this.rew = new Float32Array(n);
  }

  _pick(rng = this.rng) {
    let x = rng() * this.cw;
    for (let i = 0; i < this.configs.length; i++) { x -= this.configs[i].w; if (x < 0) return i; }
    return this.configs.length - 1;
  }

  _open(i) {
    if (this.started >= this.maxMatches || performance.now() > this.until) return null;
    let seed = this.seedQueue.length ? this.seedQueue.shift() : this.seed + this.started;
    this.started++;
    // config and seat roles come from the seed itself (not from the order matches open in), so a seed is the same
    // match under every mode — a policy evaluation and its legacy baseline see identical configs and roles
    const rng = mulberry32((this.envSeed ^ Math.imul(seed | 0, 0x9E3779B1)) >>> 0);
    rng(); rng();
    let ci = this._pick(rng), cfg = this.configs[ci];
    // S1: a late-game start (a pooled checkpoint of this config, or the next one of the test queue)
    let snap = null;
    if (this.snapQueue) {
      snap = this.snapQueue.shift() || null;
      if (snap) { ci = Math.max(0, this.configs.findIndex((c) => c.name === snap.config)); cfg = this.configs[ci]; }
    } else if (this.snapStart && this.snapStart.configs.includes(cfg.difficulty) && rng() < this.snapStart.frac) {
      const pool = this.snaps.get(cfg.name);
      if (pool && pool.length) snap = pool[Math.floor(rng() * pool.length)];
    }
    if (snap) seed = snap.seed;
    const sched = new VirtualScheduler();
    const seats = [];
    for (let s = 0; s < cfg.players; s++) seats.push({ seat: s, playerId: `ai_${s}`, name: `AI-${s + 1}`, isBot: true, connected: true });
    const slot = { i, ci, cfg, seed, sched, pending: [], seat: new Map(), rl: new Set(), humans: new Set(), role: new Map(), ended: false,
      summary: null, failed: null, cb: 0, m: null, seenRound: 0, yield: {}, humanTier: new Map(), trips: [],
      names: this.describeSeats.size ? new Names() : null, replay: [] };
    // seat roles; the env RNG is drawn the same way in every mode, so a seed gets the same roles under legacy / teacher / policy
    const mates = []; for (let s = 1; s < cfg.players; s++) mates.push(s);
    const legacyMate = new Map(mates.map((s) => [s, rng() < this.legacyMates]));
    for (let j = mates.length - 1; j > 0; j--) { const k = Math.floor(rng() * (j + 1)); [mates[j], mates[k]] = [mates[k], mates[j]]; }
    const nH = this.humans === 'random' ? Math.floor(rng() * cfg.players) : Math.min(Number(this.humans) || 0, mates.length);
    const humanSeats = new Set(mates.slice(0, nH));
    const humanRL = new Map(mates.map((s) => [s, rng() < this.humanRL]));
    for (let s = 0; s < cfg.players; s++) {
      const pid = `ai_${s}`;
      const role = humanSeats.has(s) ? (humanRL.get(s) ? 'human-rl' : 'human-legacy') : s > 0 && legacyMate.get(s) ? 'legacy' : 'rl';
      if (humanSeats.has(s)) slot.humans.add(pid);
      slot.role.set(pid, this.mode === 'legacy' ? (role.startsWith('human') ? 'human-legacy' : 'legacy') : role);
      if (this.mode !== 'legacy' && (role === 'rl' || role === 'human-rl')) slot.rl.add(pid);
    }
    slot.deferredBand = []; slot.bandSeats = new Set(); slot.announced = new Set();
    if (this.bandPolicy && !snap) for (const pid of slot.rl) {
      if (slot.humans.has(pid)) continue;
      if (rng() < this.bandPolicy.share) { slot.bandSeats.add(pid); this.bandStats.policySeats++; } else this.bandStats.legacySeats++;
    }
    if (snap) { // the checkpoint's own seat roles (human marks, legacy mates) and its round
      slot.humans = new Set(snap.roles.humans); slot.rl = new Set(this.mode === 'legacy' ? [] : snap.roles.rl);
      slot.role = new Map(snap.roles.role.map(([pid, r]) => [pid, this.mode === 'legacy' ? (r.startsWith('human') ? 'human-legacy' : 'legacy') : r]));
      slot.fromSnapshot = snap.round;
    }
    const env = this;
    const log = { info() {}, debug() {}, warn() {}, error: (...a) => { env.stats.errors++; if (env.errorSamples.length < 20) env.errorSamples.push(`[seed ${seed}] ${a.map(String).join(' ').slice(0, 400)}`); } };
    const strategy = defineBotStrategy({ id: 'rl-env',
      decide(m, ps, d) {
        // a human seat under AI 托管 (isBot false) stays legacy's, as every seat the env does not give the policy
        if (d.kind === 'band' && env.bandPolicy && ps.isBot && slot.bandSeats?.has(ps.playerId)) {
          // the model AI picks after every human(-proxy) seat (aiPicksLast semantics, the owner's call of 11-12)
          slot.deferredBand.push({ slot, ps, d, kind: 'band', actions: 0, freezes: 0, own: null, owned: null, cache: {} });
          return true;
        }
        if (!ps.isBot || !slot.rl.has(ps.playerId) || (d.kind !== 'prep' && d.kind !== 'card')) return false;
        if (env.mode === 'teacher') return env._teach(slot, ps, d);
        slot.pending.push({ slot, ps, d, kind: d.kind, actions: 0, freezes: 0, own: null, owned: null,
          startUids: new Set(ps.allChess().map((p) => p.uid)), soldBases: new Set(), cache: {} });
        return true;
      },
      pickBand(m, ps) {
        const f = env.forceBand;
        if (f && ps.playerId === 'ai_0' && m.gd.bandAllowed(f) && !m.bandTaken(f, ps.playerId)) return f;
        let id = LEGACY_BOT.pickBand(m, ps);
        for (let k = 0; f && id === f && k < 8; k++) id = LEGACY_BOT.pickBand(m, ps);
        return id;
      },
      *prepBegin(m, ps, o) {
        if (env.bossRehearsal !== null) m.botRehearsal = m.round === m.gd.bossRound || m.round === m.gd.hiddenRound ? env.bossRehearsal : env.rehearsal;
        return yield* (slot.rl.has(ps.playerId) ? LAYOUT_ONLY : LEGACY_BOT).prepBegin(m, ps, o);
      },
    });
    const collect = this.snapCollect && this.snapCollect.configs.includes(cfg.difficulty) ? this.snapCollect : null;
    const onCheckpoint = collect ? (mm, reason) => {
      if (reason !== 'prep-end' || !collect.rounds.includes(mm.round) || slot.collectRng() >= collect.prob) return;
      const doc = snapshotMatch(mm);
      if (!doc) { this.snapStats.refused++; return; }
      const pool = this.snaps.get(cfg.name) || []; this.snaps.set(cfg.name, pool);
      const entry = { config: cfg.name, seed: doc.seed, round: mm.round, doc: JSON.parse(JSON.stringify(doc)),
        roles: { humans: [...slot.humans], rl: [...slot.rl], role: [...slot.role.entries()] } };
      if (pool.length < collect.cap) pool.push(entry); else pool[Math.floor(slot.collectRng() * pool.length)] = entry;
      this.snapStats.collected++;
    } : null;
    slot.collectRng = mulberry32((seed ^ 0x51A9) >>> 0);
    slot.m = new Match({ roomCode: 'RL', mode: snap ? snap.doc.mode : cfg.mode, difficulty: snap ? snap.doc.difficulty : cfg.difficulty,
      seats: snap ? snap.doc.seats : seats, seed, data: this.data, scheduler: sched, ...(onCheckpoint ? { onCheckpoint } : {}),
      ...(this.experimental && cfg.mode !== 'solo' ? { experimental: { revivalEnabled: false, disableSharedPool: false, ...this.experimental } } : {}),
      botRehearsal: this.rehearsal, botStrategy: strategy, log, send: () => true, broadcast: () => {},
      onEnd: (s) => { slot.summary = s; slot.ended = true; } });
    if (!this.encoder) this.encoder = new Encoder(slot.m.gd, { version: this.obsVersion });
    if (this.metrics) this._instrument(slot);
    if (this.timing) { // battle stepping time, rehearsal fields ('r:…') apart from real battles (as tools/botbench.mjs)
      const timing = this.timing, nb = slot.m.newBattle.bind(slot.m);
      slot.m.newBattle = (opts) => {
        const b = nb(opts);
        if (b && typeof b.step === 'function') {
          const reh = typeof opts?.fieldId === 'string' && opts.fieldId.startsWith('r:'), step = b.step.bind(b);
          b.step = (...args) => {
            const t0 = performance.now();
            try { return step(...args); } finally {
              const t = timing[slot.m.round || 0] ||= { prep: 0, battle: 0, other: 0, teach: 0, encode: 0, decisions: 0 };
              t[reh ? 'rehSim' : 'battleSim'] = (t[reh ? 'rehSim' : 'battleSim'] || 0) + performance.now() - t0;
            }
          };
        }
        return b;
      };
    }
    // the round-14 Final Assault's leader pool (m.bossPool is replaced by the Hidden Core's): kept for the fa reward
    const startFA = slot.m.startFinalAssault;
    slot.m.startFinalAssault = function (hidden) {
      const r = startFA.call(this, hidden);
      if (!hidden && !slot.faPool) slot.faPool = this.bossPool;
      return r;
    };
    if (snap) {
      let ok = false;
      try { ok = restoreMatch(slot.m, structuredClone(snap.doc), { createRngFromState, replay: true }); }
      catch (e) { if (this.errorSamples.length < 20) this.errorSamples.push(`[seed ${seed}] restore: ${String(e?.message || e).slice(0, 200)}`); }
      if (ok) { this.snapStats.started++; return slot; }
      this.snapStats.restoreFailed++;
      try { slot.m.dispose(); } catch { /* refused */ }
      return this._open(i); // a refused checkpoint: an ordinary match instead
    }
    slot.m.start();
    return slot;
  }

  /**
   * Rule metrics for every AI seat, whatever drives it (legacy or the policy): operators bought / taken, how many of them
   * a rule forbids (yieldMain, yieldMerge: same-pool living humans only — the policy's seats must count 0 for a rule that
   * is on), and round trips: within one prep, a sale and a purchase of the same operator (either order) — not a rule,
   * a watch for exploits (e.g. selling and buying to steer refreshes), compared with legacy.
   */
  _instrument(slot) {
    const m = slot.m, gd = m.gd, env = this;
    for (const ps of m.players.values()) {
      if (slot.humans.has(ps.playerId)) continue;
      const role = slot.role.get(ps.playerId);
      const y = slot.yield[role] ||= { buys: 0, sells: 0, yieldMain: 0, yieldMerge: 0, roundTrips: 0 };
      const prep = { key: null, buys: new Map(), sells: new Map() };
      const fresh = () => { // the seat's prep bookkeeping, reset at its first action of a new prep
        const key = `${m.round}:${m.phase}`;
        if (prep.key !== key) { prep.key = key; prep.buys = new Map(); prep.sells = new Map(); }
      };
      // one round trip per sale matched by a purchase of the same operator in the same prep (either order);
      // each side's list holds its events ({ funds delta, layers delta, id }) for the trip log
      const trip = (base, mine, other, ev) => {
        const o = other.get(base);
        if (o && o.length) {
          const first = o.shift(); y.roundTrips++;
          if (env.tripLog && slot.trips.length < 400) {
            const [b, s] = ev.side === 'buy' ? [ev, first] : [first, ev];
            slot.trips.push({ round: m.round, role, order: ev.side === 'buy' ? 'sell-buy' : 'buy-sell', id: b.id, golden: !!gd.isGolden?.(s.id),
              tier: gd.tierOf?.(b.id) || 0, paid: -b.funds, gain: s.funds, net: b.funds + s.funds, layersBuy: b.layers, layersSell: s.layers,
              fundsLeft: ps.funds, fundsBeforeBuy: b.before, handFreeAfterBuy: b.handFree, soldBy: s.by, band: ps.bandId,
              keepsLeftover: gd.leftoverKeptBands.includes(ps.bandId) });
          }
        } else { if (!mine.has(base)) mine.set(base, []); mine.get(base).push(ev); }
      };
      const layerSum = () => Object.values(ps.layers || {}).reduce((n, v) => n + (Number(v) || 0), 0);
      const proto = Object.getPrototypeOf(ps);
      const acquire = (name, idOf) => {
        ps[name] = function (arg) {
          fresh();
          const id = idOf(arg), chess = !!(id && gd.chess(id));
          let main = false, merge = false;
          if (chess && slot.humans.size) {
            const pub = m.publicView();
            main = chessInBonds(gd, id, humanBonds(gd, pub, ps.playerId, slot.humans));
            const pairs = humanPairs(m, pub, ps.playerId, slot.humans);
            merge = pairs.has(gd.baseIdOf(id));
            if (env.scoutCheck) {
              const viaScout = humanPairs(m, pub, ps.playerId, slot.humans, { scout: true });
              env.stats.scoutChecks++;
              if ([...pairs].sort().join() !== [...viaScout].sort().join()) env.stats.scoutMismatch++;
            }
          }
          const f0 = ps.funds, l0 = layerSum();
          const r = proto[name].call(this, arg);
          if (!(r && r.error) && chess) {
            y.buys++; if (main) y.yieldMain++; if (merge) y.yieldMerge++;
            if (name === 'buy') trip(gd.baseIdOf(id), prep.buys, prep.sells, { side: 'buy', id, funds: ps.funds - f0, layers: layerSum() - l0,
              before: f0, handFree: ps.hand.filter((p) => !p).length });
          }
          return r;
        };
      };
      acquire('buy', (i) => ps.shop?.slots?.[i]?.id);
      acquire('pickReward', (i) => ps.offers?.[0]?.slots?.[i]?.id);
      ps.sell = function (uid) {
        fresh();
        const piece = ps.find(uid)?.piece;
        const f0 = ps.funds, l0 = layerSum();
        const r = proto.sell.call(this, uid);
        if (!(r && r.error) && piece) {
          y.sells++; trip(gd.baseIdOf(piece.id), prep.sells, prep.buys, { side: 'sell', id: piece.id, funds: ps.funds - f0, layers: layerSum() - l0,
            by: slot.acting === ps.playerId ? 'policy' : 'legacy' });
        }
        return r;
      };
    }
  }

  /** Band draft bookkeeping: human proxies announce a plan once picked; deferred model-AI band decisions become pending
   *  once every human proxy has picked (or the draft moved on). */
  _bandStep(slot) {
    const m = slot.m, d = m.draft, gd = m.gd;
    for (const pid of slot.humans) {
      const band = d.picks?.[pid];
      if (!band || slot.announced.has(pid)) continue;
      slot.announced.add(pid);
      const ps = m.players.get(pid);
      const tied = gd.bandBondIds(band).filter((b) => gd.bondPlannable?.(b));
      let main = tied[0] || null;
      if (!main && slot.collectRng() < this.bandPolicy.planProb) {
        const cores = gd.bondIds.filter((b) => gd.bond(b)?.isCore && gd.bondPlannable?.(b) && !gd.modeInactiveBonds?.has?.(b));
        main = cores.length ? cores[Math.floor(slot.collectRng() * cores.length)] : null;
      }
      if (main && ps) {
        try { m.planBond(ps, main, []); } catch { /* the plan stays display-only then */ }
        ps._envPlanBonds = [{ id: main, priority: 1 }]; // bot.js bondPlan (src-next copy): legacy's focus = the announced plan
      }
    }
    if (!slot.deferredBand.length) return;
    const proxiesDone = [...slot.humans].every((pid) => d.picks?.[pid] || !m.players.get(pid)?.alive);
    if (!proxiesDone && m.phase === 'BAND_DRAFT') return;
    for (const dec of slot.deferredBand.splice(0)) if (dec.d.valid() && !dec.d.complete()) slot.pending.push(dec);
  }

  /** The team's rounds reached and LP (every seat of the match), for the team share of the reward. */
  _team(m) {
    let rounds = 0, lp = 0, n = 0;
    for (const p of m.players.values()) {
      if (p.spectator) continue;
      n++; rounds += p.alive ? m.round : (p.eliminatedRound ?? m.round); lp += Math.max(0, p.lp || 0);
    }
    return { rounds, lp, n: n || 1 };
  }

  /** Reward of seat state `s` since its last decision (team-weighted), advancing its bookkeeping. */
  _reward(s, m, round, lp) {
    const t = this._team(m), w = this.R.team;
    const dRound = w * (t.rounds - s.teamRounds) / t.n + (1 - w) * (round - s.lastRound);
    const dLp = w * (t.lp - s.teamLp) / t.n + (1 - w) * (lp - s.lastLp);
    s.lastRound = round; s.lastLp = lp; s.teamRounds = t.rounds; s.teamLp = t.lp;
    const rRound = this.R.round * dRound, rLp = this.R.lp * dLp / s.lp0;
    s.cRound = (s.cRound || 0) + rRound; s.cLp = (s.cLp || 0) + rLp; // trajectory totals of the two terms (TensorBoard)
    return rRound + rLp;
  }

  /** Once per round: each marked human's main core bond and its tier (public strip). */
  _sampleHumans(slot) {
    const m = slot.m;
    slot.seenRound = m.round;
    if (!slot.humans.size) return;
    const pub = m.publicView();
    for (const p of pub.players || []) {
      if (!slot.humans.has(p.playerId) || !p.alive) continue;
      const main = mainCoreBondOf(m.gd, p), tier = main ? (p.bonds.find((b) => b.bondId === main)?.tier || 0) : 0;
      const h = slot.humanTier.get(p.playerId) || { max: 0 };
      h.max = Math.max(h.max, tier); h.last = tier;
      slot.humanTier.set(p.playerId, h);
    }
  }

  _seat(slot, ps) {
    let s = slot.seat.get(ps.playerId);
    if (!s) {
      const t = this._team(slot.m);
      s = { traj: ++this.trajSeq, lp0: ps.lp || 1, lastLp: Math.max(0, ps.lp || 0), lastRound: slot.m.round || 1, teamRounds: t.rounds, teamLp: t.lp, steps: 0 };
      slot.seat.set(ps.playerId, s);
    }
    return s;
  }

  /** Run slot i until it waits on the policy or is finished and replaced. */
  _advance(i) {
    let slot = this.slots[i];
    for (let guard = 0; guard < 1e7 && slot; guard++) {
      if (slot.pending.length) return;
      if (slot.ended || slot.failed) { this._finish(slot); slot = this.slots[i] = this._open(i); continue; }
      let ok;
      if (this.timing) {
        const r = slot.m.round || 0, ph = slot.m.phase, t0 = performance.now();
        ok = slot.sched.runNext();
        const key = ph === 'PREP' ? 'prep' : ph === 'COMBAT' || ph === 'FINAL_ASSAULT' || ph === 'HIDDEN_CORE' || ph === 'UNITE' ? 'battle' : 'other';
        const t = this.timing[r] ||= { prep: 0, battle: 0, other: 0, teach: 0, encode: 0, decisions: 0 };
        t[key] += performance.now() - t0;
      } else ok = slot.sched.runNext();
      if (!ok) { slot.failed = 'stuck'; continue; }
      if (++slot.cb > 2e6) slot.failed = 'callbacks';
      if (this.metrics && slot.m.round !== slot.seenRound) this._sampleHumans(slot);
      if (this.bandPolicy && slot.m.draft) this._bandStep(slot);
    }
  }

  _finish(slot) {
    const m = slot.m;
    this.stats.matches++;
    this.stats.callbacks += slot.cb;
    if (slot.failed) { this.stats.failed++; if (this.errorSamples.length < 20) this.errorSamples.push(`[seed ${slot.seed}] ${slot.failed} in ${m.phase} R${m.round}`); }
    let violations = [];
    if (this.check) { try { violations = collectViolations(m); } catch (e) { violations = [`collectViolations threw ${e.message}`]; } }
    if (violations.length) { this.stats.violations += violations.length; if (this.errorSamples.length < 20) this.errorSamples.push(`[seed ${slot.seed}] violations ${violations.slice(0, 3).join(' | ')}`); }
    const rows = slot.summary?.players || [];
    if (this.phiSamples) for (const p of rows) {
      const ps = m.players.get(p.playerId);
      if (ps) this.phiSamples.push({ config: slot.cfg.name, role: slot.role.get(p.playerId), round: p.eliminatedRound ?? m.round,
        win: p.victory ? 1 : 0, ...bondTerms(m.gd, ps.privateView().bonds) });
    }
    const pool = slot.faPool;
    const faShare = pool && pool.maxHp > 0 ? Math.min(1, Math.max(0, 1 - Math.max(0, pool.hp) / pool.maxHp)) : 0;
    const res = { config: slot.cfg.name, seed: slot.seed, failed: slot.failed, seats: [], yield: slot.yield, humans: slot.humans.size, faShare,
      ...(slot.fromSnapshot ? { fromSnapshot: slot.fromSnapshot } : {}),
      ...(this.tripLog ? { trips: slot.trips } : {}), ...(slot.names ? { names: slot.names.list, replay: slot.replay } : {}) };
    for (const p of rows) {
      const round = p.eliminatedRound ?? m.round;
      const rl = slot.rl.has(p.playerId);
      res.seats.push({ playerId: p.playerId, rl, role: slot.role.get(p.playerId), band: m.players.get(p.playerId)?.bandId ?? null, survivalRound: round, roundsPassed: p.roundsPassed,
        lp: p.lp, win: p.victory ? 1 : 0, mainTier: slot.humanTier.get(p.playerId)?.max ?? null });
      const s = slot.seat.get(p.playerId);
      if (!s) continue;
      // terminal shaping: γ·Φ(terminal = 0) − Φ(last decision), also for a seat eliminated earlier
      const shapeEnd = this.shaping && s.phi !== undefined ? -s.phi : 0;
      s.shape = (s.shape || 0) + shapeEnd;
      const reward = this._reward(s, m, round, Math.max(0, p.lp || 0)) + (p.victory ? this.R.win : 0) + this.R.fa * faShare + shapeEnd;
      const t = { traj: s.traj, reward, win: p.victory ? 1 : 0, round, lp: p.lp || 0, config: slot.ci, steps: s.steps, faShare,
        rRound: s.cRound || 0, rLp: s.cLp || 0, shape: s.shape || 0, seedOffset: slot.seed - this.seed };
      if (this.recorder) this.recorder.term(t); else this.terms.push(t);
    }
    this.results.push(res);
    if (this.results.length > 10000) this.results.shift();
    try { m.dispose(); } catch { /* finished */ }
  }

  /** Decisions waiting on the policy, encoded into this.obs / this.mask (n rows). Ended matches are replaced. */
  collect() {
    for (let i = 0; i < this.envs; i++) this._advance(i);
    const items = [];
    for (const slot of this.slots) if (slot) for (const dec of slot.pending) items.push(dec);
    if (items.length > this.cap) this._buf(Math.max(items.length, this.cap * 2));
    const D = this.D, A = this.A;
    for (let k = 0; k < items.length; k++) {
      const dec = items[k], { slot, ps } = dec, m = slot.m;
      const s = this._seat(slot, ps);
      this.rew[k] = this._reward(s, m, m.round, Math.max(0, ps.lp || 0));
      s.steps++;
      this.ids[k] = s.traj; this.kinds[k] = KIND[dec.kind];
      const te0 = this.timing ? performance.now() : 0;
      const newUids = dec.startUids ? new Set(ps.allChess().map((p) => p.uid).filter((u) => !dec.startUids.has(u))) : null;
      const aiPicks = dec.kind === 'band' ? new Set([...m.players.keys()].filter((pid) => !slot.humans.has(pid) && m.draft?.picks?.[pid])) : null;
      const r = this.encoder.encode(m, ps, { kind: dec.kind, actions: dec.actions, freezes: dec.freezes, lp0: s.lp0, humans: slot.humans,
        rules: this.rules, newUids, soldBases: dec.soldBases, cache: dec.cache || {}, aiPicks },
        this.obs.subarray(k * D, (k + 1) * D), this.mask.subarray(k * A, (k + 1) * A));
      dec.own = r.own; dec.owned = r.owned;
      if (dec.kind === 'band') { this.bandStats.decisions++; if (r.bandFallback) this.bandStats.fallback++; dec.aiPicks = aiPicks; }
      if (this.timing) { const t = this.timing[m.round || 0] ||= { prep: 0, battle: 0, other: 0, teach: 0, encode: 0, decisions: 0 };
        t.encode += performance.now() - te0; t.decisions++; }
      if (this.shaping) {
        const { T, S } = bondTerms(m.gd, r.own.bonds);
        const phi = this.shaping.wTier * T + this.shaping.wStack * S;
        if (s.phi !== undefined) { const sh = this.shaping.gamma * phi - s.phi; this.rew[k] += sh; s.shape = (s.shape || 0) + sh; }
        s.phi = phi;
      }
    }
    this.items = items;
    this.stats.decisions += items.length;
    const terms = this.terms; this.terms = [];
    return { n: items.length, ids: this.ids, kinds: this.kinds, rew: this.rew, obs: this.obs, mask: this.mask, D, A, terms };
  }

  reset() { return this.collect(); }

  /** For the rows of the last collect(): a readable state of each describeSeats row (null for the others), with the
   *  labels of its legal actions. */
  describe() {
    return (this.items || []).map((dec, k) => {
      if (!this.describeSeats.has(dec.ps.playerId) || !dec.slot.names) return null;
      const s = summarize(dec.slot.m, dec.ps, dec.own, dec.slot.names, dec.kind);
      const mask = this.mask.subarray(k * this.A, (k + 1) * this.A), labels = {};
      for (let a = 0; a < this.A; a++) if (mask[a]) labels[a] = actionLabel(a, s, dec.slot.names);
      return { seed: dec.slot.seed, playerId: dec.ps.playerId, s, labels };
    });
  }

  /** Apply one action per row of the last collect(), then collect the next decisions. */
  step(actions) {
    const items = this.items || [];
    for (let k = 0; k < items.length; k++) this._apply(items[k], actions[k] | 0, this.mask.subarray(k * this.A, (k + 1) * this.A));
    this.items = null;
    return this.collect();
  }

  _drop(dec) { const p = dec.slot.pending, j = p.indexOf(dec); if (j >= 0) p.splice(j, 1); }

  _apply(dec, a, mask) {
    const { slot, ps, d } = dec, m = slot.m;
    if (!(a >= 0 && a < this.A) || !mask[a]) { this.stats.rejected++; a = dec.kind === 'card' ? -1 : ACT.END; }
    if (dec.kind === 'band') {
      this._drop(dec);
      if (!d.valid()) return;
      const j = a - ACT.BAND, bandId = a >= ACT.BAND && j < BANDS ? this.encoder.vocab.bandList[j] : null;
      if (bandId) {
        const bc = bandConflicts(m.gd, m.publicView(), ps.playerId, slot.humans, dec.aiPicks);
        const tied = m.gd.bandBondIds(bandId);
        if (tied.some((b) => bc.humanBand.has(b) || bc.humanMain.has(b))) this.bandStats.humanConflict++;
        if (tied.some((b) => bc.aiPick.has(b))) this.bandStats.aiSameBond++;
        const r = m._handleSeatIntent(ps, { t: 'g.band', bandId });
        if (r?.error) this.stats.rejected++;
      }
      if (!d.complete()) d.fallback();
      return;
    }
    if (dec.kind === 'card') {
      this._drop(dec);
      if (!d.valid()) return;
      const c = a >= ACT.CARD ? m.sp?.cards?.[a - ACT.CARD] : null;
      if (c) { const r = m._handleSeatIntent(ps, { t: 'g.choice', idx: c.idx }); if (r?.error) this.stats.rejected++; }
      if (!d.complete()) d.fallback();
      return;
    }
    if (!d.valid()) { this._drop(dec); return; }
    if (a === ACT.END) { this._drop(dec); if (!d.complete()) d.fallback(); return; }
    let intent = null;
    if (a === ACT.REFRESH) intent = { t: 'g.refresh' };
    else if (a === ACT.LEVEL) intent = { t: 'g.levelUp' };
    else if (a === ACT.FREEZE) { intent = { t: 'g.freeze' }; dec.freezes++; }
    else if (a < ACT.SELL) intent = { t: 'g.buy', slot: a - ACT.BUY };
    else if (a < ACT.REWARD) { const p = dec.owned?.[a - ACT.SELL]; if (p) { intent = { t: 'g.sell', uid: p.uid }; dec.soldBase = m.gd.baseIdOf(p.id); } }
    else if (a < ACT.PERSONAL) intent = { t: 'g.reward', idx: a - ACT.REWARD };
    else if (a < ACT.CARD) { const pc = dec.own?.personalChoice; if (pc) intent = { t: 'g.choice', idx: a - ACT.PERSONAL, choiceId: pc.id }; }
    dec.actions++;
    slot.acting = ps.playerId; // the trip log tells the policy's own sales from legacy's cleanup
    let r;
    try { r = intent ? m._handleSeatIntent(ps, intent) : { error: 'BAD_ACTION' }; } finally { slot.acting = null; }
    if (r?.error) this.stats.rejected++;
    else if (intent?.t === 'g.sell' && dec.soldBase) dec.soldBases.add(dec.soldBase);
    dec.soldBase = null;
    if (dec.actions >= MAX_PREP_ACTIONS) this.stats.forcedEnd++; // the next mask offers END only
    if (!d.valid() || d.complete()) this._drop(dec);
  }

  // ---- teacher: legacy procurement, every PlayerState call it makes recorded as the env action it equals ----
  _teach(slot, ps, d) {
    const m = slot.m, T = this.stats.teacher;
    const obs = new Float32Array(this.encoder.dim), mask = new Uint8Array(this.encoder.A);
    const s = this._seat(slot, ps);
    const startUids = new Set(ps.allChess().map((p) => p.uid)), soldBases = new Set();
    const ctx = { kind: d.kind, actions: 0, freezes: 0, lp0: s.lp0, humans: slot.humans, rules: this.rules, soldBases, newUids: new Set(), cache: {} };
    const rec = this.recorder;
    const log = slot.names && this.describeSeats.has(ps.playerId)
      ? (() => { const e = { r: m.round, k: d.kind === 'card' ? 1 : 0, before: null, acts: [] }; slot.replay.push(e); return e; })() : null;
    let lastOwn = null;
    const note = (a, label) => {
      if (log && a >= 0 && lastOwn) log.acts.push(actionLabel(a, summarize(m, ps, lastOwn, slot.names, d.kind), slot.names));
      T.calls[label] = (T.calls[label] || 0) + 1;
      if (a < 0 || !mask[a]) { T.illegal[label] = (T.illegal[label] || 0) + 1; return; }
      // behaviour-cloning sample: the observation and mask the call was made in, the env action it equals, and the
      // reward since this trajectory's previous sample (it belongs to the previous transition, as in step())
      if (rec) { s.steps++; rec.sample(KIND[d.kind], s.traj, obs, mask, a, this._reward(s, m, m.round, Math.max(0, ps.lp || 0))); }
    };
    if (d.kind === 'card') {
      const sp = m.sp; if (!sp) return false;
      const avail = sp.cards.filter((c) => m.spCardAvailable(c, ps)).map((c) => c.idx);
      if (!avail.length) return false;
      const idx = LEGACY_BOT.pickCard(m, ps, sp.cards, avail);
      lastOwn = this.encoder.encode(m, ps, ctx, obs, mask).own;
      if (log) log.before = summarize(m, ps, lastOwn, slot.names, d.kind);
      const pos = sp.cards.findIndex((c) => c.idx === idx);
      const r = m._handleSeatIntent(ps, { t: 'g.choice', idx });
      if (r?.error) return false; // the engine falls back to the legacy pick
      note(pos >= 0 && pos < CARDS ? ACT.CARD + pos : -1, 'card');
      return true;
    }
    T.preps++;
    let owned = null, protect = new Set(), pairs = new Set();
    const before = () => {
      ctx.newUids = new Set(ps.allChess().map((p) => p.uid).filter((u) => !startUids.has(u)));
      const r = this.encoder.encode(m, ps, ctx, obs, mask); owned = r.owned; protect = r.protect; pairs = r.pairs;
      lastOwn = r.own;
      if (log && !log.before) log.before = summarize(m, ps, r.own, slot.names, d.kind);
    };
    // which rule a recorded legacy call breaks (it is outside the mask): the 2026-11-11 rule metrics of legacy itself
    const env = this;
    const why = (name, args) => {
      const gd = m.gd, out = [];
      const id = name === 'buy' ? ps.shop?.slots?.[args[0]]?.id : name === 'pickReward' ? ps.offers?.[0]?.slots?.[args[0]]?.id : null;
      if (id && gd.chess(id)) {
        if (this.rules.yieldMain && chessInBonds(gd, id, protect)) out.push('yieldMain');
        if (this.rules.yieldMerge && pairs.has(gd.baseIdOf(id))) out.push('yieldMerge');
      }
      return out.length ? out : ['other'];
    };
    // compose with the instance's own wrappers (the 让盟约 counter) and restore them afterwards
    const saved = new Map();
    const inner = (name) => { saved.set(name, Object.getOwnPropertyDescriptor(ps, name)); return ps[name]; };
    const wrap = (name, toAction) => {
      const base = inner(name);
      ps[name] = function (...args) {
        before();
        const a = toAction(...args);
        const reasons = a >= 0 && !mask[a] ? why(name, args) : null;
        const soldBase = name === 'sell' ? m.gd.baseIdOf(ps.find(args[0])?.piece?.id || '') : null;
        if (env.enforce && reasons && reasons[0] !== 'other') {
          for (const k of reasons) T.blocked[`${name}:${k}:refused`] = (T.blocked[`${name}:${k}:refused`] || 0) + 1;
          return { error: 'RULE' };
        }
        const r = base.apply(this, args);
        if (!(r && r.error)) {
          note(a, name); ctx.actions++;
          if (name === 'freeze') ctx.freezes++;
          if (soldBase) soldBases.add(soldBase);
          if (reasons) for (const k of reasons) T.blocked[`${name}:${k}`] = (T.blocked[`${name}:${k}`] || 0) + 1;
        }
        return r;
      };
    };
    const count = (name) => { const base = inner(name); ps[name] = function (...args) { const r = base.apply(this, args); if (!(r && r.error)) T.unrepresented[name] = (T.unrepresented[name] || 0) + 1; return r; }; };
    wrap('buy', (slotIdx) => (slotIdx >= 0 && slotIdx < SHOP ? ACT.BUY + slotIdx : -1));
    wrap('sell', (uid) => { const j = owned ? owned.findIndex((p) => p && p.uid === uid) : -1; return j >= 0 && j < OWNED ? ACT.SELL + j : -1; });
    wrap('refresh', () => ACT.REFRESH);
    wrap('freeze', () => ACT.FREEZE);
    wrap('levelUp', () => ACT.LEVEL);
    wrap('pickReward', (idx) => (idx >= 0 && idx < REWARDS ? ACT.REWARD + idx : -1));
    for (const name of ['move', 'destroy', 'equip', 'unequip']) count(name);
    const mPick = Object.getPrototypeOf(m).pickPersonalChoice;
    m.pickPersonalChoice = function (p, idx, id) {
      if (p !== ps) return mPick.call(this, p, idx, id);
      before();
      const r = mPick.call(this, p, idx, id);
      if (!(r && r.error)) { note(idx >= 0 && idx < PERSONAL ? ACT.PERSONAL + idx : -1, 'personal'); ctx.actions++; }
      return r;
    };
    const tt0 = this.timing ? performance.now() : 0;
    try { runSteps(PROCURE_ONLY.prepBegin(m, ps, {})); }
    catch (e) { this.stats.errors++; if (this.errorSamples.length < 20) this.errorSamples.push(`teacher: ${e.stack?.slice(0, 300)}`); }
    finally {
      for (const [name, desc] of saved) { if (desc) Object.defineProperty(ps, name, desc); else delete ps[name]; }
      if (this.timing) { const t = this.timing[m.round || 0] ||= { prep: 0, battle: 0, other: 0, teach: 0, encode: 0, decisions: 0 };
        t.teach += performance.now() - tt0; t.decisions += ctx.actions + 1; }
      delete m.pickPersonalChoice;
    }
    if (ctx.actions > MAX_PREP_ACTIONS) T.overCap++;
    before(); note(ACT.END, 'end');
    if (d.valid() && !d.complete()) d.fallback();
    return true;
  }

  /** Survival summary of finished matches, per config and seat role (rl / legacy / human-legacy / human-rl). */
  summary() {
    const g = new Map();
    for (const r of this.results) for (const s of r.seats) {
      const key = `${r.config}:${s.role || (s.rl ? 'rl' : 'legacy')}`;
      const x = g.get(key) || { key, seats: 0, survival: 0, wins: 0, lp: 0, tier: 0, tiers: 0 };
      x.seats++; x.survival += s.survivalRound; x.wins += s.win; x.lp += s.lp;
      if (s.mainTier != null) { x.tier += s.mainTier; x.tiers++; }
      g.set(key, x);
    }
    return [...g.values()].map((x) => ({ key: x.key, seats: x.seats, survival: +(x.survival / x.seats).toFixed(2), winRate: +(x.wins / x.seats).toFixed(3),
      lp: +(x.lp / x.seats).toFixed(1), ...(x.tiers ? { humanMainTier: +(x.tier / x.tiers).toFixed(2) } : {}) }));
  }

  /** Rule metrics per driver of the AI seats (see _instrument), totals and per match. */
  yieldSummary() {
    const g = {};
    for (const r of this.results) for (const [role, y] of Object.entries(r.yield)) {
      const x = g[role] ||= { matches: 0, preps: 0, buys: 0, sells: 0, yieldMain: 0, yieldMerge: 0, roundTrips: 0 };
      x.matches++;
      // preps of this role's seats: one per round each reached
      x.preps += r.seats.filter((s) => s.role === role).reduce((n, s) => n + s.survivalRound, 0);
      for (const k of ['buys', 'sells', 'yieldMain', 'yieldMerge', 'roundTrips']) x[k] += y[k];
    }
    for (const x of Object.values(g)) {
      for (const k of ['yieldMain', 'yieldMerge']) x[`${k}PerMatch`] = +(x[k] / Math.max(1, x.matches)).toFixed(2);
      x.roundTripsPerPrep = +(x.roundTrips / Math.max(1, x.preps)).toFixed(3);
    }
    return g;
  }

  close() { for (const slot of this.slots) if (slot) try { slot.m.dispose(); } catch { /* */ } }
}

/** A uniformly random legal action per row. */
export function randomActions(batch, rng = Math.random, out = new Int32Array(batch.n)) {
  const { n, mask, A } = batch;
  for (let k = 0; k < n; k++) {
    let c = 0, pick = 0;
    for (let a = 0; a < A; a++) if (mask[k * A + a]) { c++; if (rng() * c < 1) pick = a; }
    out[k] = pick;
  }
  return out;
}
