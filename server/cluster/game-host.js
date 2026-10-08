// Process-local game actors. A whole Match stays here; this is neither a session
// registry nor durable recovery. The caller owns authentication, transport and pools.
import { Match } from '../match/Match.js';
import { C2S, LOADOUT_LIMITS, isNotOwnedList, isDiyPicks } from '../../shared/protocol.js';
import { experimentalOptions, isExperimental } from '../../shared/experimental.js';
import { isSkinChoices } from '../../shared/skins.js';
import { DIFFICULTIES, ERR, MAX_SEATS, NAME_MAX_LEN, modeIdFor } from '../../shared/constants.js';

const OK = Object.freeze({ ok: true });
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
const identifier = (v, max = 128) => typeof v === 'string' && v.length > 0 && v.length <= max && /^[A-Za-z0-9_-][A-Za-z0-9_.:-]*(?![\s\S])/.test(v);
const integer = (v, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;
const plain = v => !!v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const onlyKeys = (v, keys) => Object.keys(v).every(k => keys.includes(k));
const SPEC_KEYS = ['assignmentId', 'roomCode', 'build', 'protocol', 'seed', 'matchNo', 'mode', 'difficulty', 'modeId', 'seats', 'spectators', 'revivalEnabled', 'disableSharedPool', 'experimental', 'snapshotHz'];
const SEAT_KEYS = ['seat', 'playerId', 'name', 'isBot', 'connected', 'loadout', 'notOwned', 'diy', 'skins'];
// Match's public observer contract, including the lobby's broadcast ticker/emote
// and server-combat streams. Unknown types fail closed for observers.
const SPECTATOR_TYPES = new Set(['m.public', 'm.field', 'm.result', 'm.ticker', 'm.emote', 'm.damage', 'b.start', 'b.snap', 'b.ev', 'b.pool', 'b.end', 'b.damage']);
const ENCODED_TYPES = new Set(['m.field', 'b.snap', 'b.ev', 'm.damage', 'b.damage']);
const GAME_TYPES = new Set(Object.keys(C2S).filter(t => t.startsWith('g.') || t === 'b.progress' || t === 'b.result'));
const fail = error => ({ error });
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const copy = value => structuredClone(value);

export class GameHostError extends Error {
  constructor(code) { super(code); this.name = 'GameHostError'; this.code = code; }
}
const invalid = () => { throw new GameHostError('INVALID_SPEC'); };

// Match takes the lobby's *normalised* loadout, whose module may be null (unlike
// room.loadout.entries). Preserve it rather than running checkLoadout a second time.
function loadoutCopy(value) {
  if (value == null) return value;
  if (!plain(value) || Object.keys(value).length > LOADOUT_LIMITS.entries) invalid();
  const entries = Object.entries(value).map(([id, entry]) => {
    if (!identifier(id, 64) || ['__proto__', 'constructor', 'prototype'].includes(id) || !plain(entry)
      || !Object.keys(entry).length || !onlyKeys(entry, ['skill', 'module'])
      || (entry.skill !== undefined && !integer(entry.skill, 0, LOADOUT_LIMITS.skillIndex))
      || (entry.module !== undefined && entry.module !== null && !identifier(entry.module, 64))) invalid();
    return [id, { ...entry }];
  });
  return Object.fromEntries(entries);
}

function specCopy(spec) {
  if (!plain(spec) || !onlyKeys(spec, SPEC_KEYS) || !identifier(spec.assignmentId) || !identifier(spec.build)
    || typeof spec.roomCode !== 'string' || !/^[A-Z]{4}(?![\s\S])/.test(spec.roomCode)
    || !integer(spec.protocol, 1) || !integer(spec.seed, 0, 0xffffffff) || !integer(spec.matchNo, 1)
    || !['solo', 'coop'].includes(spec.mode) || !DIFFICULTIES.includes(spec.difficulty)
    || spec.modeId !== modeIdFor(spec.mode, spec.difficulty)
    || !Array.isArray(spec.seats) || !spec.seats.length || spec.seats.length > MAX_SEATS
    || (spec.revivalEnabled !== undefined && typeof spec.revivalEnabled !== 'boolean')
    || (spec.disableSharedPool !== undefined && typeof spec.disableSharedPool !== 'boolean')
    || (spec.experimental !== undefined && (!isExperimental(spec.experimental)
      || (spec.revivalEnabled !== undefined && spec.revivalEnabled !== (spec.mode === 'coop' && spec.experimental.revivalEnabled))
      || (spec.disableSharedPool !== undefined && spec.disableSharedPool !== spec.experimental.disableSharedPool)))
    || (spec.snapshotHz !== undefined && ![5, 10, 20].includes(spec.snapshotHz))) invalid();
  const ids = new Set();
  const seats = new Set();
  let humans = 0;
  const players = Array.from(spec.seats, s => {
    if (!plain(s) || !onlyKeys(s, SEAT_KEYS) || !integer(s.seat, 0, MAX_SEATS - 1)
      || !identifier(s.playerId, 64) || ids.has(s.playerId) || seats.has(s.seat)
      || typeof s.name !== 'string' || !s.name.trim() || s.name.length > NAME_MAX_LEN || /[\x00-\x1f\x7f]/.test(s.name)
      || typeof s.isBot !== 'boolean' || typeof s.connected !== 'boolean'
      || s.isBot !== s.playerId.startsWith('ai_')) invalid();
    ids.add(s.playerId); seats.add(s.seat);
    if (!s.isBot) humans++;
    const seat = { seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot, connected: s.connected };
    if (s.loadout !== undefined) seat.loadout = loadoutCopy(s.loadout);
    if (s.notOwned !== undefined) {
      if (s.notOwned !== null && !isNotOwnedList(s.notOwned)) invalid();
      seat.notOwned = s.notOwned === null ? null : [...s.notOwned];
    }
    if (s.diy !== undefined) {
      if (s.diy !== null && (!isDiyPicks(s.diy) || Object.values(s.diy).some(p => p != null && !onlyKeys(p, ['charId', 'skillIndex', 'uniEquipId'])))) invalid();
      seat.diy = s.diy === null ? null : copy(s.diy);
    }
    if (s.skins !== undefined) {
      if (!isSkinChoices(s.skins)) invalid();
      seat.skins = { ...s.skins };
    }
    return seat;
  });
  const spectators = spec.spectators ?? [];
  if (!Array.isArray(spectators)) invalid();
  for (const id of spectators) {
    if (!identifier(id, 64) || id.startsWith('ai_') || ids.has(id)) invalid();
    ids.add(id);
  }
  if (!humans || (spec.mode === 'solo' && (players.length !== 1 || humans !== 1 || spectators.length))) invalid();
  return freeze({ assignmentId: spec.assignmentId, roomCode: spec.roomCode, build: spec.build, protocol: spec.protocol,
    seed: spec.seed, matchNo: spec.matchNo, mode: spec.mode, difficulty: spec.difficulty, modeId: spec.modeId,
    seats: players, spectators: [...spectators],
    revivalEnabled: spec.mode === 'coop' && (spec.experimental?.revivalEnabled ?? spec.revivalEnabled ?? false),
    disableSharedPool: spec.experimental?.disableSharedPool ?? spec.disableSharedPool ?? false,
    experimental: experimentalOptions(spec.experimental ?? { revivalEnabled: spec.revivalEnabled ?? false, disableSharedPool: spec.disableSharedPool ?? false }),
    ...(spec.snapshotHz === undefined ? {} : { snapshotHz: spec.snapshotHz }) });
}

// Only the small assignment spec is canonicalised. No BattleSpec/snapshot is
// stringify/parsed on its way to a channel; encoded worker frames pass unchanged.
function fingerprint(spec) {
  const canonical = v => Array.isArray(v) ? v.map(canonical) : plain(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return JSON.stringify(canonical(spec));
}

export class GameHost {
  constructor({ data, combatPool, trialPool, MatchClass = Match, now = Date.now, prepareMs = 15_000, retiredMs = 120_000, log = noopLog, onEnd = () => {}, terminalControl = false } = {}) {
    if (typeof MatchClass !== 'function' || typeof now !== 'function' || typeof onEnd !== 'function'
      || typeof terminalControl !== 'boolean') throw new TypeError('invalid game host callbacks');
    if (!integer(prepareMs, 1, 300_000)) throw new RangeError('invalid prepareMs');
    if (!integer(retiredMs, 60_000, 300_000)) throw new RangeError('invalid retirement fence');
    this.data = data;
    this.combatPool = combatPool;
    this.trialPool = trialPool;
    this.MatchClass = MatchClass;
    this.now = now;
    this.prepareMs = prepareMs;
    this.retiredMs = retiredMs;
    this.log = log ?? noopLog;
    this.onEnd = onEnd;
    this.terminalControl = terminalControl;
    this.contexts = new Map();
    // IDs are globally unique coordinator nonces, never deliberately reused.
    // Keep fences beyond RPC/admission lifetimes without retaining every match
    // forever. Old callbacks also compare the context object, not only its id.
    this.retired = new Map();
    this.sequence = 0;
    this.closed = false;
  }

  time() {
    const value = this.now();
    if (!integer(value, 0)) throw new RangeError('invalid game host clock');
    return value;
  }

  _log(operation) {
    // Error objects, inbound messages and ticket material must not reach logs.
    try { this.log.error?.(`[game-host] ${operation} failed`); } catch {}
  }

  _current(ctx) { return this.contexts.get(ctx.spec.assignmentId) === ctx; }
  _live(ctx) { return this._current(ctx) && ctx.live && !ctx.disposed; }

  _context(assignmentId) {
    const ctx = this.contexts.get(assignmentId);
    if (ctx?.state === 'prepared' && this.time() >= ctx.expiresAt) this._retire(ctx, 'expired');
    if (!ctx || !this._current(ctx)) throw new GameHostError('STALE_ASSIGNMENT');
    return ctx;
  }

  _view(ctx) {
    if (!ctx.view) {
      ctx.view = Object.freeze({ ...ctx.spec, generation: ctx.generation, preparedAt: ctx.preparedAt, expiresAt: ctx.expiresAt,
        get state() { return ctx.state; }, get committedAt() { return ctx.committedAt; },
        get endedAt() { return ctx.endedAt; }, get receipt() { return ctx.receipt; } });
    }
    return ctx.view;
  }

  get(assignmentId) {
    try { return this._view(this._context(assignmentId)); } catch (e) {
      if (e instanceof GameHostError) return null;
      throw e;
    }
  }

  // Admission must use current membership, not the original spec (observers can
  // join/leave later). This is a read-only actor fact, never a client role claim.
  member(assignmentId, playerId) {
    const view = this.get(assignmentId);
    if (!view) return null;
    const member = this.contexts.get(assignmentId).members.get(playerId);
    if (!member || member.left) return null;
    return Object.freeze({ assignmentId, playerId, generation: view.generation, role: member.role, connected: !!member.binding });
  }

  prepare(spec) {
    if (this.closed) throw new GameHostError('HOST_CLOSED');
    const safe = specCopy(spec);
    const key = fingerprint(safe);
    this.sweep();
    const existing = this.contexts.get(safe.assignmentId);
    if (existing) {
      if (existing.key !== key) throw new GameHostError('ASSIGNMENT_CONFLICT');
      return this._view(existing);
    }
    if (this.retired.has(safe.assignmentId)) throw new GameHostError('STALE_ASSIGNMENT');
    const preparedAt = this.time();
    const ctx = { spec: safe, key, generation: ++this.sequence, preparedAt, expiresAt: preparedAt + this.prepareMs,
      state: 'prepared', committedAt: null, endedAt: null, live: true, disposed: false, match: null, buffer: [],
      pendingEnd: null, lastPublic: null, results: new Map(), receipt: null, members: new Map(), seatIds: new Set(safe.seats.map(s => s.playerId)) };
    for (const s of safe.seats) if (!s.isBot) ctx.members.set(s.playerId, { role: 'player', left: false, binding: null, engineConnected: s.connected });
    for (const id of safe.spectators) ctx.members.set(id, { role: 'spectator', left: false, binding: null, engineRegistered: true });
    this.contexts.set(safe.assignmentId, ctx);
    try {
      const matchSpec = copy(safe);
      delete matchSpec.assignmentId; delete matchSpec.build; delete matchSpec.protocol;
      ctx.match = new this.MatchClass({ ...matchSpec, data: this.data, combatPool: this.combatPool, trialPool: this.trialPool,
        // This host owns server-authoritative games even without SP_COMBAT.
        clientCombat: false, log: this.log, now: this.now,
        send: (id, msg) => this._emit(ctx, 'send', id, msg?.t, msg),
        sendEncoded: (id, type, data) => this._emit(ctx, 'encoded', id, type, data),
        broadcast: msg => { this._emit(ctx, 'broadcast', null, msg?.t, msg); },
        onEnd: summary => this._end(ctx, summary) });
      if (typeof ctx.match.start !== 'function' || typeof ctx.match.dispose !== 'function') throw new TypeError('invalid Match interface');
    } catch {
      this._log('construct');
      this._retire(ctx, 'failed');
      throw new GameHostError('INTERNAL');
    }
    return this._view(ctx);
  }

  _rejectAsync(value, operation) {
    if (value && typeof value.then === 'function') {
      Promise.resolve(value).catch(() => this._log(operation));
      throw new TypeError('game hooks must be synchronous');
    }
    return value;
  }

  commit(assignmentId) {
    const ctx = this._context(assignmentId);
    if (ctx.state === 'committed' || ctx.state === 'ended') return this._view(ctx);
    if (ctx.state !== 'prepared') throw new GameHostError('STALE_ASSIGNMENT');
    ctx.state = 'starting';
    try {
      this._rejectAsync(ctx.match.start(), 'start');
      // Bind before start is deliberately silent. Reconcile the provided seat's
      // connection bit only *after* start; no pre-start reconnect/resync occurs.
      if (!ctx.pendingEnd) {
        for (const id of ctx.spec.spectators) if (!ctx.members.has(id)) this._invoke(ctx, 'removeSpectator', id);
        for (const [id, member] of ctx.members) {
          if (member.role === 'player' && !!member.binding !== member.engineConnected) {
            this._invoke(ctx, member.binding ? 'onReconnect' : 'onDisconnect', id);
            member.engineConnected = !!member.binding;
          } else if (member.role === 'spectator' && !member.engineRegistered) {
            this._invoke(ctx, 'addSpectator', id);
            member.engineRegistered = true;
          }
          if (ctx.pendingEnd) break;
        }
      }
      ctx.committedAt = this.time();
    } catch {
      this._log('start');
      this._retire(ctx, 'failed');
      throw new GameHostError('INTERNAL');
    }
    if (!this._live(ctx)) throw new GameHostError('STALE_ASSIGNMENT');
    ctx.state = 'committed';
    const frames = ctx.buffer;
    ctx.buffer = null;
    for (const frame of frames) {
      if (!this._live(ctx) || ctx.state !== 'committed') break;
      this._publish(ctx, frame);
    }
    if (ctx.pendingEnd && this._live(ctx) && ctx.state === 'committed') this._finish(ctx, ctx.pendingEnd.summary);
    return this._view(ctx);
  }

  abort(assignmentId) {
    const ctx = this.contexts.get(assignmentId);
    if (!ctx || ctx.state !== 'prepared') return false;
    this._retire(ctx, 'cancelled');
    return true;
  }

  release(assignmentId) {
    const ctx = this.contexts.get(assignmentId);
    if (!ctx) return false;
    this._retire(ctx, 'released');
    return true;
  }
  dispose(assignmentId) { return this.release(assignmentId); }

  _disposeMatch(ctx) {
    if (ctx.disposed) return;
    ctx.live = false;
    ctx.disposed = true;
    const match = ctx.match;
    ctx.match = null;
    try { this._rejectAsync(match?.dispose(), 'dispose'); } catch { this._log('dispose'); }
  }

  _retire(ctx, state) {
    ctx.state = state;
    ctx.live = false;
    ctx.buffer = null;
    ctx.pendingEnd = null;
    if (ctx.disposeTask) { clearImmediate(ctx.disposeTask); ctx.disposeTask = null; }
    this.contexts.delete(ctx.spec.assignmentId);
    let retiredAt;
    try { retiredAt = this.time(); } catch { retiredAt = ctx.preparedAt; }
    this.retired.set(ctx.spec.assignmentId, Math.min(Number.MAX_SAFE_INTEGER, retiredAt + this.retiredMs));
    this._disposeMatch(ctx);
    for (const member of ctx.members.values()) {
      const binding = member.binding;
      member.binding = null;
      if (binding) this._closeChannel(binding.channel, 1001, 'game assignment released');
    }
  }

  _closeChannel(channel, code, reason) { try { channel.close?.(code, reason); } catch { this._log('channel close'); } }

  bind(assignmentId, playerId, channel) {
    const ctx = this._context(assignmentId);
    const member = ctx.members.get(playerId);
    if (!member || member.left) throw new GameHostError('NOT_MEMBER');
    if (!channel || typeof channel.send !== 'function' || typeof channel.sendEncoded !== 'function'
      || (channel.close !== undefined && typeof channel.close !== 'function')) throw new GameHostError('INVALID_CHANNEL');
    const old = member.binding;
    const binding = { channel, generation: ctx.generation };
    member.binding = binding;
    if (old && old.channel !== channel) this._closeChannel(old.channel, 1000, 'game channel replaced');
    if (ctx.state === 'committed') {
      this._invoke(ctx, member.role === 'player' ? 'onReconnect' : 'addSpectator', playerId);
      member.engineConnected = !!member.binding;
      if (member.role === 'spectator') member.engineRegistered = true;
    } else if (ctx.state === 'ended') this._replay(ctx, playerId);
    // A replaced socket's eventual close must not disconnect its replacement.
    return () => this._unbind(ctx, playerId, binding);
  }

  _unbind(ctx, playerId, binding) {
    const member = ctx.members.get(playerId);
    if (!this._current(ctx) || binding.generation !== ctx.generation || member?.binding !== binding) return false;
    member.binding = null;
    if (ctx.state === 'committed' && member.role === 'player' && !member.left) {
      member.engineConnected = false;
      this._invoke(ctx, 'onDisconnect', playerId);
    }
    return true;
  }

  _allowed(member, type) { return member && !member.left && (member.role === 'player' || SPECTATOR_TYPES.has(type)); }

  _emit(ctx, kind, playerId, type, payload) {
    if (!this._live(ctx) || ctx.state === 'ended' || ctx.pendingEnd || typeof type !== 'string') return false;
    if (kind === 'encoded' && (!ENCODED_TYPES.has(type) || typeof payload !== 'string')) return false;
    if (kind !== 'encoded' && (!payload || typeof payload !== 'object')) return false;
    if (kind !== 'broadcast' && !this._allowed(ctx.members.get(playerId), type)) return false;
    if (ctx.state !== 'committed') {
      try { ctx.buffer.push({ kind, playerId, type, payload: kind === 'encoded' ? payload : copy(payload) }); return true; }
      catch { this._log('buffer frame'); return false; }
    }
    return this._publish(ctx, { kind, playerId, type, payload });
  }

  _capture(ctx, frame) {
    if (frame.type === 'm.public') ctx.lastPublic = frame.payload;
    if (frame.type !== 'm.result') return;
    const result = freeze(copy(frame.payload));
    if (frame.kind === 'broadcast') {
      for (const [id, member] of ctx.members) if (this._allowed(member, frame.type)) ctx.results.set(id, result);
    } else if (this._allowed(ctx.members.get(frame.playerId), frame.type)) ctx.results.set(frame.playerId, result);
  }

  _publish(ctx, frame) {
    if (!this._live(ctx) || ctx.state !== 'committed') return false;
    try { this._capture(ctx, frame); } catch { this._log('capture result'); }
    // In a coordinator topology the bounded terminal receipt is the sole final
    // delivery path. Its control WS also orders the result before lobby state and
    // teardown; the independent game WS cannot race it or produce a duplicate.
    if (this.terminalControl && (frame.type === 'm.result' || (frame.type === 'm.public'
      && ['RESULT', 'ENDED'].includes(frame.payload.phase)))) return true;
    if (frame.kind !== 'broadcast') return this._deliver(ctx, frame.playerId, frame);
    for (const [id, member] of ctx.members) {
      if (!this._live(ctx) || ctx.state !== 'committed') break;
      if (this._allowed(member, frame.type)) this._deliver(ctx, id, frame);
    }
    return true;
  }

  _deliver(ctx, playerId, frame) {
    const member = ctx.members.get(playerId);
    const binding = member?.binding;
    if (!this._current(ctx) || !this._allowed(member, frame.type) || !binding) return false;
    let accepted;
    let threw = false;
    try {
      accepted = frame.kind === 'encoded' ? binding.channel.sendEncoded(frame.type, frame.payload) : binding.channel.send(frame.payload);
      this._rejectAsync(accepted, 'channel send');
    } catch { threw = true; this._log('channel send'); }
    if (accepted === true) return true;
    // Only snapshots may be dropped softly. Losing a reliable frame is a broken
    // channel: detach first, then apply the Match's normal disconnect policy.
    if (!threw && accepted === false && frame.type === 'b.snap') return false;
    if (this._unbind(ctx, playerId, binding)) this._closeChannel(binding.channel, 1013, 'game channel unavailable');
    return false;
  }

  _invoke(ctx, method, ...args) {
    if (!this._live(ctx)) return fail(ERR.WRONG_PHASE);
    try {
      const fn = ctx.match?.[method];
      if (typeof fn !== 'function') return method === 'setLoadout' || method === 'setSkins' ? fail(ERR.ROOM_STARTED) : OK;
      return this._rejectAsync(fn.apply(ctx.match, args), method) ?? OK;
    } catch { this._log(method); return fail(ERR.INTERNAL); }
  }

  _actor(assignmentId, playerId, channel) {
    const ctx = this.contexts.get(assignmentId);
    if (!ctx || !this._current(ctx)) return null;
    const member = ctx.members.get(playerId);
    if (!member || member.left || !member.binding || (channel !== undefined && member.binding.channel !== channel)) return null;
    return { ctx, member };
  }

  // The optional channel argument fences intents from a replaced transport.
  // Without it, the authenticated caller is responsible for that origin check.
  handle(assignmentId, playerId, msg, channel) {
    const actor = this._actor(assignmentId, playerId, channel);
    if (!actor) return fail(ERR.NOT_IN_ROOM);
    const { ctx, member } = actor;
    if (!plain(msg) || !GAME_TYPES.has(msg.t)) return fail(ERR.BAD_MSG);
    if (msg.t === 'g.leave') return this.leave(assignmentId, playerId, channel);
    if (member.role === 'spectator' && msg.t !== 'g.watch') return fail(ERR.SPECTATOR);
    if (ctx.state === 'ended') return fail(ERR.WRONG_PHASE);
    if (ctx.state !== 'committed') return fail(ERR.WRONG_PHASE);
    return this._invoke(ctx, 'handle', playerId, msg);
  }

  setLoadout(assignmentId, playerId, loadout, channel) {
    const actor = this._actor(assignmentId, playerId, channel);
    if (!actor) return fail(ERR.NOT_IN_ROOM);
    if (actor.member.role === 'spectator') return fail(ERR.SPECTATOR);
    if (actor.ctx.state !== 'committed') return fail(ERR.WRONG_PHASE);
    let safe;
    try { safe = loadoutCopy(loadout); } catch { return fail(ERR.BAD_MSG); }
    return this._invoke(actor.ctx, 'setLoadout', playerId, safe);
  }

  setSkins(assignmentId, playerId, choices, channel) {
    const actor = this._actor(assignmentId, playerId, channel);
    if (!actor) return fail(ERR.NOT_IN_ROOM);
    if (actor.member.role === 'spectator') return fail(ERR.SPECTATOR);
    if (actor.ctx.state !== 'committed') return fail(ERR.WRONG_PHASE);
    if (!isSkinChoices(choices)) return fail(ERR.BAD_MSG);
    return this._invoke(actor.ctx, 'setSkins', playerId, freeze({ ...choices }));
  }

  leave(assignmentId, playerId, channel) {
    const ctx = this.contexts.get(assignmentId);
    const member = ctx?.members.get(playerId);
    if (!member || member.left || (channel !== undefined && member.binding?.channel !== channel)) return fail(ERR.NOT_IN_ROOM);
    if (!['committed', 'ended'].includes(ctx.state)) return fail(ERR.WRONG_PHASE);
    if (member.role === 'spectator') return this.removeSpectator(assignmentId, playerId);
    member.left = true;
    // Permanently leaving is not a socket drop; no onDisconnect follows.
    member.binding = null;
    return ctx.state === 'committed' ? this._invoke(ctx, 'onLeave', playerId) : OK;
  }

  addSpectator(assignmentId, playerId) {
    let ctx;
    try { ctx = this._context(assignmentId); } catch { return fail(ERR.NOT_IN_ROOM); }
    if (!identifier(playerId, 64) || playerId.startsWith('ai_') || ctx.seatIds.has(playerId)) return fail(ERR.BAD_TARGET);
    if (ctx.spec.mode !== 'coop') return fail(ERR.SPECTATOR);
    let member = ctx.members.get(playerId);
    if (!member) {
      member = { role: 'spectator', left: false, binding: null, engineRegistered: false };
      ctx.members.set(playerId, member);
    }
    if (ctx.state === 'committed') {
      const result = this._invoke(ctx, 'addSpectator', playerId);
      member.engineRegistered = true;
      return result;
    }
    return OK;
  }

  removeSpectator(assignmentId, playerId) {
    const ctx = this.contexts.get(assignmentId);
    const member = ctx?.members.get(playerId);
    if (!member || member.role !== 'spectator') return fail(ERR.NOT_IN_ROOM);
    ctx.members.delete(playerId);
    ctx.results.delete(playerId);
    if (ctx.state === 'committed') return this._invoke(ctx, 'removeSpectator', playerId);
    return OK;
  }

  _end(ctx, summary) {
    if (!this._live(ctx) || ctx.state === 'ended' || ctx.pendingEnd) return;
    let safe;
    try { safe = freeze(copy(summary ?? null)); } catch { safe = null; this._log('end summary'); }
    if (ctx.state !== 'committed') { ctx.pendingEnd = { summary: safe }; return; }
    this._finish(ctx, safe);
  }

  _finish(ctx, summary) {
    if (!this._live(ctx) || ctx.state !== 'committed') return;
    ctx.state = 'ended';
    try { ctx.endedAt = this.time(); } catch { ctx.endedAt = ctx.committedAt; this._log('end clock'); }
    let lastPublic = null;
    try { lastPublic = freeze(copy(ctx.lastPublic)); } catch { this._log('end public'); }
    const results = Object.fromEntries([...ctx.results].filter(([id]) => this._allowed(ctx.members.get(id), 'm.result')));
    ctx.receipt = freeze({ assignmentId: ctx.spec.assignmentId, generation: ctx.generation, summary, lastPublic, results });
    ctx.pendingEnd = null;
    ctx.disposeTask = setImmediate(() => {
      ctx.disposeTask = null;
      if (this._current(ctx) && ctx.state === 'ended') this._disposeMatch(ctx);
    });
    try {
      // This low-frequency coordinator callback is separate from channel I/O.
      const returned = this.onEnd(ctx.receipt);
      if (returned && typeof returned.then === 'function') Promise.resolve(returned).catch(() => this._log('onEnd'));
    } catch { this._log('onEnd'); }
  }

  _replay(ctx, playerId) {
    if (this.terminalControl) return; // Coordinator owns terminal replay as well.
    const receipt = ctx.receipt;
    const result = receipt && Object.hasOwn(receipt.results, playerId) ? receipt.results[playerId] : null;
    if (!result) return;
    for (const payload of [receipt.lastPublic, result]) if (payload) this._deliver(ctx, playerId, { kind: 'send', type: payload.t, payload });
  }

  sweep() {
    const now = this.time();
    let expired = 0;
    for (const ctx of this.contexts.values()) if (ctx.state === 'prepared' && now >= ctx.expiresAt) {
      this._retire(ctx, 'expired'); expired++;
    }
    for (const [id, until] of this.retired) if (until <= now) this.retired.delete(id);
    return expired;
  }

  stats() {
    this.sweep();
    const result = { prepared: 0, matches: 0, ended: 0, channels: 0, closed: this.closed };
    for (const ctx of this.contexts.values()) {
      if (ctx.state === 'prepared') result.prepared++;
      else if (ctx.state === 'starting' || ctx.state === 'committed') result.matches++;
      else if (ctx.state === 'ended') result.ended++;
      for (const member of ctx.members.values()) if (member.binding && !member.left) result.channels++;
    }
    return Object.freeze(result);
  }

  close() {
    if (this.closed) return false;
    this.closed = true;
    for (const ctx of this.contexts.values()) this._retire(ctx, 'released');
    return true;
  }
}
