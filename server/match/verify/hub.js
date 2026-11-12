// server/match/verify/hub.js — shadow verification, one per game process (DESIGN §14 "Shadow verification"; the
// consensus design's phases 0 and 1, the owner's decisions of 2026-11-11). The server-run battle stays the only
// authority: what browsers report here is counted and compared, never applied.
//
// Phase 0 (always, on every main-thread game process): per field kind (a human's normal field, an AI's, 联防, leader,
// hidden leader) the CPU its battle took on the combat Worker; per browser engine / system / device class how local
// display replicas fared (started, diverged from b.sync, asked for the stream, switched off) and whether the result hash a
// replica reports at its end equals the server's (g.sim { battleId, rh }).
// Phase 1 (SP_SHADOW_VERIFY=1, server/match/verify/config.js): a human's normal / 联防 field is also handed, when it
// starts, to ONE browser of another match on this process — the verifier — as a pseudonymized spec (pseudonym.js):
// S→C b.verify { vid, spec, deadline }; the page runs it in a Worker and answers C→S g.verifyResult { vid, rh, ticks,
// ms } | { vid, error: true }; the hub compares rh with the SHA-256 of the server's own result renamed the same way.
//
// Who may verify (the consensus design §2.2): a connected human seat of another official room of the same version
// whose page declared it can (g.sim { client: { verify: true, build } } — not opted out, a module Worker, not a weak
// device), with the owner's front-end build, whose own replicas agreed with the server at least once ("certified": its
// sim is the server's sim, and it has played a round), not of the owner's device, not of the owner's network (/24, /64;
// only where this process knows the addresses — setAddressResolver; a cluster game node does not, counted as `ip.
// unavailable`), not busy with another verification, at most perRound per round of its own match, and not slow lately
// (a timeout or an answer past 80 % of the deadline rests it for SLOW_REST_MS). One is picked with crypto.randomInt when
// the battle starts — no owner knows beforehand who checks them.
// Mismatches of certified clients go to the reputation ledger (ledger.js) — recorded and logged only.

import { randomInt, randomBytes } from 'node:crypto';
import { isMainThread } from 'node:worker_threads';
import { parseShadowVerify, SHADOW_DEFAULTS } from './config.js';
import { pseudonymizeSpec } from './pseudonym.js';
import { resultHashOfResult } from './hash.js';
import { ReputationLedger } from './ledger.js';
import { HARD_CAP_SECONDS } from '../fields.js';
import { TICK } from '../../sim/constants.js';

export const CLIENT_ENGINES = Object.freeze(['blink', 'gecko', 'webkit', 'other']);
export const CLIENT_OSES = Object.freeze(['ios', 'android', 'windows', 'mac', 'linux', 'other']);
export const CLIENT_DEVICES = Object.freeze(['mobile', 'desktop']);
export const CLIENT_ROLES = Object.freeze(['verifier', 'owner', 'replica']);
export const VERIFY_OUTCOMES = Object.freeze(['agree', 'mismatch', 'timeout', 'error', 'aborted']);
export const FIELD_KINDS = Object.freeze(['normal_human', 'normal_ai', 'unite', 'boss', 'hidden']);
/** Upper edges (ms) of the answer-latency and device-time histograms; the last bucket is above the last edge. */
export const VERIFY_EDGES_MS = Object.freeze([250, 500, 1000, 2000, 5000, 10_000, 20_000, 60_000]);
/** After its deadline a verification still waits this long for an answer in flight. */
export const VERIFY_GRACE_MS = 2000;
/** An answered verification waits this long for the server's own result at most (the battle runs in real time). */
export const VERIFY_SERVER_WAIT_MS = 10 * 60_000;
/** A verifier that timed out or answered late is not picked for this long. */
export const SLOW_REST_MS = 10 * 60_000;
const VERIFY_KINDS = new Set(['normal', 'unite']);
/** b.verify `cap`: the server's hard cap in ticks — a run past it ends 'timeout', as the field runner ends it. */
export const VERIFY_CAP_TICKS = Math.ceil(HARD_CAP_SECONDS / TICK);
const BUILD = /^[A-Za-z0-9_.:-]{1,64}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const noopLog = Object.freeze({ info() {}, warn() {}, error() {} });

/** What a page said about itself (g.sim `client`, shared/protocol.js), defensively; null when unusable. */
export function normalizeSimClient(c) {
  if (!c || typeof c !== 'object') return null;
  const pick = (v, list) => (list.includes(v) ? v : 'other');
  return {
    eng: pick(c.eng, CLIENT_ENGINES), os: pick(c.os, CLIENT_OSES), dev: c.dev === 'mobile' ? 'mobile' : 'desktop',
    build: typeof c.build === 'string' && BUILD.test(c.build) ? c.build : null,
    id: typeof c.id === 'string' && DEVICE_ID.test(c.id) ? c.id : null,
    verify: c.verify === true,
  };
}

/** The network of an address for the "same network" exclusion: IPv4 /24, IPv6 /64; null when unknown. */
export function networkOf(addr) {
  if (typeof addr !== 'string' || !addr) return null;
  const v4 = addr.replace(/^::ffff:/i, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return v4.split('.').slice(0, 3).join('.');
  if (addr.includes(':')) return addr.toLowerCase().split(':').slice(0, 4).join(':');
  return null;
}

/** The phase-0 kind of a field: whose battle it is. */
export function fieldCpuKind(m, f) {
  if (f.kind === 'boss' || f.kind === 'hidden' || f.kind === 'unite') return f.kind;
  return (f.players || []).some((pid) => { const ps = m.players.get(pid); return ps && !ps.isBot; }) ? 'normal_human' : 'normal_ai';
}

const histogram = () => new Array(VERIFY_EDGES_MS.length + 1).fill(0);
const bucket = (h, ms) => {
  if (!Number.isFinite(ms) || ms < 0) return;
  let i = 0;
  while (i < VERIFY_EDGES_MS.length && ms > VERIFY_EDGES_MS[i]) i++; // loop-cap: bounded by the edges
  h[i]++;
};
const clientKey = (c, role) => `${c?.eng || 'other'}|${c?.os || 'other'}|${c?.dev || 'desktop'}|${role}`;
const versionOf = (m) => m?.data?.config?.version?.id ?? null;
const officialMatch = (m) => !!m && !m.requireCs && !m.disposed && !m.ended;
const officialSpec = (spec) => !!spec && typeof spec === 'object' && !spec.cs && !spec.version;

export class VerifyHub {
  /**
   * @param {{ config?: Partial<typeof SHADOW_DEFAULTS>, now?: () => number, pickIndex?: (n: number) => number,
   *   chance?: () => number, newId?: () => string, timers?: { setTimeout: Function, clearTimeout: Function }, log?: object,
   *   ledger?: ReputationLedger }} [opts] — the defaults are the process's: crypto randomness, real timers
   */
  constructor({ config = {}, now = Date.now, pickIndex = (n) => randomInt(n), chance = () => randomInt(1_000_000) / 1_000_000,
    newId = () => `sv${randomBytes(8).toString('hex')}`, timers = globalThis, log = noopLog, ledger = null } = {}) {
    this.config = Object.freeze({ ...SHADOW_DEFAULTS, ...config });
    this.now = now;
    this.pickIndex = pickIndex;
    this.chance = chance;
    this.newId = newId;
    this.timers = timers;
    this.log = log;
    this.ledger = ledger || new ReputationLedger({ now });
    /** @type {Set<any>} the matches whose seats may verify (phase 1 only) */
    this.matches = new Set();
    /** vid → the verification in flight */
    this.jobs = new Map();
    /** vids whose verification ended without an answer (a later answer is counted as late), bounded */
    this.expired = new Map();
    /** PlayerState → { busy, round, count, slowUntil, certified } */
    this.seats = new WeakMap();
    /** (playerId) → address, where this process has the clients' addresses (server/index.js) */
    this.addrOf = null;
    this.c = {
      jobs: { offered: 0, agree: 0, mismatch: 0, timeout: 0, error: 0, aborted: 0, late: 0,
        skipped: { rate: 0, capacity: 0, noCandidate: 0, noOwner: 0, content: 0, send: 0 } },
      latency: histogram(), deviceMs: histogram(),
      clients: new Map(), replicas: new Map(),
      fields: Object.fromEntries(FIELD_KINDS.map((k) => [k, { fields: 0, ticks: 0, ms: 0 }])),
      ip: { checked: 0, unavailable: 0 },
      unrankedMatches: 0,
    };
  }

  get verifying() { return this.config.verify === true; }

  setAddressResolver(fn) { this.addrOf = typeof fn === 'function' ? fn : null; }

  /** A match may lend its seats as verifiers (phase 1); unregister drops what it had in flight. */
  register(m) { if (this.verifying && m) this.matches.add(m); }

  unregister(m) {
    if (!m) return;
    this.matches.delete(m);
    for (const job of [...this.jobs.values()]) {
      if (job.ownerMatch === m || job.verifier.match === m) this._finish(job, 'aborted');
    }
  }

  _seat(ps) {
    let s = this.seats.get(ps);
    if (!s) { s = { busy: null, round: -1, count: 0, slowUntil: 0, certified: false }; this.seats.set(ps, s); }
    return s;
  }

  _clientRow(c, role) {
    const k = clientKey(c, role);
    let row = this.c.clients.get(k);
    if (!row) {
      row = { eng: c?.eng || 'other', os: c?.os || 'other', dev: c?.dev || 'desktop', role, agree: 0, mismatch: 0, timeout: 0, error: 0 };
      this.c.clients.set(k, row);
    }
    return row;
  }

  // ------------------------------------------------------------------------------------------------- phase 0

  /** One server-run field ended: its battle's step time on the Worker (engine.js `stepMs`) and ticks. */
  noteFieldCpu(kind, { ms = 0, ticks = 0 } = {}) {
    const row = this.c.fields[kind];
    if (!row) return;
    row.fields++;
    if (Number.isFinite(ticks) && ticks > 0) row.ticks += ticks;
    if (Number.isFinite(ms) && ms > 0) row.ms += ms;
  }

  /** A local display replica of a page: started, diverged, requested (too slow), off, or completed (its end hash came). */
  noteReplica(client, outcome) {
    const k = `${client?.eng || 'other'}|${client?.os || 'other'}|${client?.dev || 'desktop'}`;
    let row = this.c.replicas.get(k);
    if (!row) {
      row = { eng: client?.eng || 'other', os: client?.os || 'other', dev: client?.dev || 'desktop',
        started: 0, completed: 0, diverged: 0, requested: 0, off: 0 };
      this.c.replicas.set(k, row);
    }
    if (Object.hasOwn(row, outcome) && typeof row[outcome] === 'number') row[outcome]++;
  }

  /**
   * A replica's end hash (g.sim { battleId, rh }) of field `f`, from seat `ps` (its owner, or a seat watching it). Compared
   * when the server's result is known (now, or when it comes — serverResult).
   */
  ownerDigest(m, ps, f, rh) {
    if (!f || !ps) return;
    const sh = f.shadow || (f.shadow = {});
    if (sh.server) { this._ownerOutcome(m, f, ps, rh); return; }
    const owners = sh.owners || (sh.owners = new Map());
    if (!owners.has(ps.playerId) && owners.size < 32) owners.set(ps.playerId, { ps, rh });
  }

  _ownerOutcome(m, f, ps, rh) {
    const sh = f.shadow;
    if (!sh.done) sh.done = new Set();
    if (sh.done.has(ps.playerId)) return;
    sh.done.add(ps.playerId);
    const c = ps.simClient;
    const role = (f.players || []).includes(ps.playerId) ? 'owner' : 'replica';
    const agree = rh === sh.server;
    this.noteReplica(c, 'completed');
    this._clientRow(c, role)[agree ? 'agree' : 'mismatch']++;
    const seat = this._seat(ps);
    if (agree) { seat.certified = true; return; }
    this.log.warn?.(`[verify] match ${m.roomCode} seat ${ps.seat}: its ${role} replica of a ${f.kind} field ended with another hash than the server (${c?.eng}/${c?.os}/${c?.dev}${seat.certified ? '' : ', not certified'})`);
    if (role === 'owner' && seat.certified) this._record(m, ps, role, f.kind);
  }

  // ------------------------------------------------------------------------------------------------- phase 1

  /** A server-run field of `m` starts: maybe hand it to a verifier. */
  offer(m, f) {
    if (!this.verifying || !f || !VERIFY_KINDS.has(f.kind) || !this.matches.has(m)) return null;
    const j = this.c.jobs;
    if (!officialMatch(m) || !officialSpec(f.spec)) { j.skipped.content++; return null; }
    const owner = (f.players || []).map((pid) => m.players.get(pid))
      .find((ps) => ps && !ps.isBot && ps.simClient?.build && this._seat(ps).certified);
    if (!owner) { j.skipped.noOwner++; return null; }
    if (!(this.chance() < this.config.rate)) { j.skipped.rate++; return null; }
    if (this.jobs.size >= this.config.maxJobs) { j.skipped.capacity++; return null; }
    const candidates = this._candidates(m, owner);
    if (!candidates.length) { j.skipped.noCandidate++; return null; }
    const pick = candidates[Math.min(candidates.length - 1, Math.max(0, this.pickIndex(candidates.length) | 0))];
    const vid = this.newId();
    let spec, rename;
    try { ({ spec, rename } = pseudonymizeSpec(f.spec, vid)); } catch (e) { this.log.warn?.(`[verify] pseudonymize: ${e.message}`); j.skipped.content++; return null; }
    const deadline = this.config.deadlineMs;
    if (pick.match.sendTo(pick.ps.playerId, { t: 'b.verify', vid, spec, deadline, cap: VERIFY_CAP_TICKS }) === false) { j.skipped.send++; return null; }
    const seat = this._seat(pick.ps);
    if (seat.round !== pick.match.round) { seat.round = pick.match.round; seat.count = 0; }
    seat.count++;
    seat.busy = vid;
    const job = { vid, ownerMatch: m, field: f, kind: f.kind, rename, sentAt: this.now(), deadline,
      verifier: { match: pick.match, ps: pick.ps, client: pick.ps.simClient }, answer: null, server: null, timer: null };
    job.timer = this.timers.setTimeout(() => this._expire(vid), deadline + VERIFY_GRACE_MS);
    job.timer?.unref?.();
    this.jobs.set(vid, job);
    (f.shadow || (f.shadow = {})).vid = vid;
    j.offered++;
    return vid;
  }

  _candidates(m, owner) {
    const now = this.now();
    const oc = owner.simClient;
    const version = versionOf(m);
    const ownerNet = this.addrOf ? networkOf(this.addrOf(owner.playerId)) : null;
    if (this.addrOf && ownerNet) this.c.ip.checked++; else this.c.ip.unavailable++;
    const out = [];
    for (const m2 of this.matches) {
      if (m2 === m || !officialMatch(m2) || versionOf(m2) !== version || !m2.players) continue;
      for (const ps of m2.players.values()) {
        const c = ps.simClient;
        if (!c || !c.verify || ps.isBot || ps.spectator || ps.left || !ps.connected || c.build !== oc.build) continue;
        if (c.id && oc.id && c.id === oc.id) continue;
        const s = this._seat(ps);
        if (!s.certified || s.busy || s.slowUntil > now || (s.round === m2.round && s.count >= this.config.perRound)) continue;
        if (ownerNet && networkOf(this.addrOf(ps.playerId)) === ownerNet) continue;
        out.push({ match: m2, ps });
      }
    }
    return out;
  }

  /** g.verifyResult from seat `ps` of match `m`: only the verifier the job was sent to is heard. */
  answer(m, ps, msg) {
    const job = this.jobs.get(msg?.vid);
    if (!job) { if (this.expired.has(msg?.vid)) { this.expired.delete(msg.vid); this.c.jobs.late++; } return; }
    if (job.verifier.ps !== ps || job.verifier.match !== m || job.answer) return;
    job.answer = { rh: typeof msg.rh === 'string' ? msg.rh : null, ms: Number(msg.ms), ticks: msg.ticks, error: msg.error === true, at: this.now() };
    const seat = this._seat(ps);
    if (seat.busy === job.vid) seat.busy = null;
    bucket(this.c.latency, job.answer.at - job.sentAt);
    if (Number.isFinite(job.answer.ms)) bucket(this.c.deviceMs, job.answer.ms);
    if (job.answer.at - job.sentAt > job.deadline * 0.8) seat.slowUntil = this.now() + SLOW_REST_MS;
    if (job.answer.error || !job.answer.rh) { this._finish(job, 'error'); return; }
    if (job.server) { this._compare(job); return; }
    // the battle still runs on the server: wait for its result (serverResult), bounded
    this.timers.clearTimeout?.(job.timer);
    job.timer = this.timers.setTimeout(() => { if (this.jobs.get(job.vid) === job) this._finish(job, 'aborted'); }, VERIFY_SERVER_WAIT_MS);
    job.timer?.unref?.();
  }

  /** The server's own result of field `f` of `m` (combat/runner.js, when the Worker's result arrives). */
  serverResult(m, f, result) {
    if (!f || !result || typeof result !== 'object') return;
    const sh = f.shadow || (f.shadow = {});
    if (sh.server) return;
    try { sh.server = resultHashOfResult(result); } catch (e) { this.log.warn?.(`[verify] hash: ${e.message}`); return; }
    for (const { ps, rh } of sh.owners?.values() || []) this._ownerOutcome(m, f, ps, rh);
    sh.owners = null;
    const job = sh.vid ? this.jobs.get(sh.vid) : null;
    if (!job) return;
    try { job.server = resultHashOfResult(result, job.rename); } catch (e) { this.log.warn?.(`[verify] hash: ${e.message}`); this._finish(job, 'aborted'); return; }
    if (job.answer) this._compare(job);
  }

  _compare(job) {
    this._finish(job, job.answer.rh === job.server ? 'agree' : 'mismatch');
  }

  _expire(vid) {
    const job = this.jobs.get(vid);
    if (!job || job.answer) return;
    this._seat(job.verifier.ps).slowUntil = this.now() + SLOW_REST_MS;
    this._finish(job, 'timeout');
    this.expired.set(vid, true);
    if (this.expired.size > 256) this.expired.delete(this.expired.keys().next().value);
  }

  _finish(job, outcome) {
    if (this.jobs.get(job.vid) !== job) return;
    this.jobs.delete(job.vid);
    this.timers.clearTimeout?.(job.timer);
    const seat = this._seat(job.verifier.ps);
    if (seat.busy === job.vid) seat.busy = null;
    this.c.jobs[outcome]++;
    if (outcome !== 'aborted') this._clientRow(job.verifier.client, 'verifier')[outcome === 'agree' ? 'agree' : outcome]++;
    if (outcome === 'mismatch') {
      const c = job.verifier.client;
      this.log.warn?.(`[verify] ${job.vid}: verifier hash ≠ the server's (${c?.eng}/${c?.os}/${c?.dev}, field kind ${job.kind})`);
      this._record(job.verifier.match, job.verifier.ps, 'verifier', job.kind);
    }
  }

  /** A certified client's proven wrong result: into the ledger, and what the rules WOULD do now (logged, flagged). */
  _record(m, ps, role, kind) {
    const c = ps.simClient;
    const { count, level } = this.ledger.note({ account: ps.playerId, device: c?.id ?? null, role, kind, eng: c?.eng || 'other' });
    if (level < 3) return;
    const would = level >= 4 ? 'teammates could vote them out; the match would count for no one while they stay' : 'their results would no longer be accepted';
    this.log.warn?.(`[verify] match ${m?.roomCode} seat ${ps.seat}: ${count} wrong results in 7 days — ${would} (phase 1: recorded only)`);
    if (level >= 4 && m && !m.shadowFlags?.unranked) {
      m.shadowFlags = { ...(m.shadowFlags || {}), unranked: { at: this.now(), playerId: ps.playerId, records: count } };
      this.c.unrankedMatches++;
    }
  }

  // ------------------------------------------------------------------------------------------------- stats

  /** /healthz `verify` (server/http/routes.js), summed over nodes by mergeVerifyStats (cluster/platform.js). */
  snapshot() {
    const c = this.c;
    return {
      verify: this.verifying,
      config: { rate: this.config.rate, maxJobs: this.config.maxJobs, perRound: this.config.perRound, deadlineMs: this.config.deadlineMs },
      jobs: { ...c.jobs, skipped: { ...c.jobs.skipped }, inFlight: this.jobs.size },
      edgesMs: [...VERIFY_EDGES_MS], latency: [...c.latency], deviceMs: [...c.deviceMs],
      clients: [...c.clients.values()].map((r) => ({ ...r })),
      replicas: [...c.replicas.values()].map((r) => ({ ...r })),
      fields: Object.fromEntries(Object.entries(c.fields).map(([k, v]) => [k, { ...v, ms: Math.round(v.ms) }])),
      ip: { ...c.ip },
      ledger: { ...this.ledger.stats(), unrankedMatches: c.unrankedMatches },
    };
  }
}

const isPlainNum = (v) => typeof v === 'number' && Number.isFinite(v);
const LABELS = ['eng', 'os', 'dev', 'role'];

/** Sum `verify` snapshots (the coordinator: its game nodes'); rows of `clients` / `replicas` merge by their labels. */
export function mergeVerifyStats(list) {
  const items = (Array.isArray(list) ? list : []).filter((s) => s && typeof s === 'object');
  if (!items.length) return null;
  const sum = (a, b) => {
    if (isPlainNum(a) && isPlainNum(b)) return a + b;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.every(isPlainNum) && b.every(isPlainNum)) return a.length === b.length ? a.map((x, i) => x + b[i]) : a;
      const key = (r) => LABELS.map((k) => r?.[k] ?? '').join('|');
      const rows = new Map(a.map((r) => [key(r), { ...r }]));
      for (const r of b) {
        const k = key(r);
        if (!rows.has(k)) { rows.set(k, { ...r }); continue; }
        const t = rows.get(k);
        for (const [f, v] of Object.entries(r)) if (isPlainNum(v)) t[f] = (isPlainNum(t[f]) ? t[f] : 0) + v;
      }
      return [...rows.values()];
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const out = { ...a };
      for (const [k, v] of Object.entries(b)) out[k] = Object.hasOwn(out, k) ? sum(out[k], v) : v;
      return out;
    }
    return a ?? b;
  };
  let acc = structuredClone(items[0]);
  for (const s of items.slice(1)) {
    acc = sum(acc, s);
    acc.verify = acc.verify === true || s.verify === true;
  }
  // settings and edges are not summed: the first node's
  if (items[0].config) acc.config = { ...items[0].config };
  if (items[0].edgesMs) acc.edgesMs = [...items[0].edgesMs];
  return acc;
}

let processHub;
/**
 * This process's hub: one per main thread, with the process's settings (SP_SHADOW_VERIFY…, config.js). A match host's
 * Worker (server/match/host/) has none — its rooms run plugin content, which is never verified. Throws on a bad setting.
 */
export function processVerifyHub() {
  if (!isMainThread) return null;
  if (processHub === undefined) processHub = new VerifyHub({ config: parseShadowVerify(process.env) });
  return processHub;
}

/** Tests: drop the process hub so the next call reads the environment again. */
export function resetProcessVerifyHub() { processHub = undefined; }
