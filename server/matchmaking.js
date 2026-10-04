// Bounded, synchronous four-human matchmaking. Entries belong to session identities, never sockets.
// Offers require every participant's explicit acceptance before the lobby atomically allocates a room.
import { randomBytes } from 'node:crypto';
import { ERR, MAX_SEATS, DIFFICULTIES, MATCHMAKING_VERSION } from '../shared/constants.js';

export const MATCHMAKING_DEFAULTS = Object.freeze({ maxEntries: 2000, maxPerAddr: 16, waitMs: 600_000, acceptMs: 30_000 });
const OK = Object.freeze({ ok: true });
const fail = (error, detail) => ({ error, detail });
const id = () => randomBytes(16).toString('hex');

export class Matchmaking {
  constructor({ now = Date.now, send, available, allocate, options = {}, timers = { setTimeout, clearTimeout } }) {
    this.now = now;
    this.send = send;
    this.available = available;
    this.allocate = allocate;
    this.timers = timers;
    this.opts = { ...MATCHMAKING_DEFAULTS, ...options };
    const limits = { maxEntries: 20_000, maxPerAddr: 20_000, waitMs: 3_600_000, acceptMs: 120_000 };
    for (const [key, max] of Object.entries(limits)) {
      if (!Number.isSafeInteger(this.opts[key]) || this.opts[key] < 1 || this.opts[key] > max) throw new TypeError(`invalid matchmaking ${key}`);
    }
    this.entries = new Map();
    this.offers = new Map();
    this.sequence = 0;
    this.timer = null;
    this.draining = false;
    this.closed = false;
  }

  has(session) { return this.entries.has(session.playerId); }
  get size() { return this.entries.size; }

  state(session) {
    const e = this.entries.get(session.playerId);
    if (!e) {
      const matched = session.matchmakingResult;
      return matched && session.roomCode === matched.code ? { t: 'queue.state', state: 'matched', required: MAX_SEATS, ...matched }
        : { t: 'queue.state', state: 'idle', ticketId: null, required: MAX_SEATS };
    }
    const offer = e.offerId ? this.offers.get(e.offerId) : null;
    return {
      t: 'queue.state', state: offer ? 'offered' : 'queued', ticketId: e.ticketId,
      difficulty: e.difficulty, required: MAX_SEATS, joinedAt: e.joinedAt,
      deadline: offer ? offer.deadline : e.expiresAt,
      ...(e.reason ? { reason: e.reason } : {}),
      ...(offer ? { offerId: offer.id, accepted: e.accepted, acceptedCount: offer.entries.filter((x) => x.accepted).length } : {}),
    };
  }

  sync(session) { this.refresh(session); this.send(session, this.state(session)); }
  push(e) { this.send(e.session, this.state(e.session)); }
  idle(e, reason) { this.send(e.session, { t: 'queue.state', state: 'idle', ticketId: null, required: MAX_SEATS, reason }); }

  join(session, { difficulty }) {
    this.refresh(session);
    if (this.closed || this.draining) return fail(ERR.MAINTENANCE, 'matchmaking is draining');
    if (!DIFFICULTIES.includes(difficulty)) return fail(ERR.BAD_MSG, 'invalid matchmaking difficulty');
    if (session.matchmakingVersion !== MATCHMAKING_VERSION) return fail(ERR.BAD_MSG, 'matchmaking version required; refresh the page');
    if (!this.available(session)) return fail(ERR.WRONG_PHASE, 'leave your room before matchmaking');
    const previous = this.entries.get(session.playerId);
    if (previous) {
      if (previous.difficulty !== difficulty) return fail(ERR.QUEUED, 'cancel before changing difficulty');
      this.push(previous);
      return OK;
    }
    this.sweep();
    if (this.entries.size >= this.opts.maxEntries) return fail(ERR.RATE, 'matchmaking queue is full');
    const key = session.limitKey;
    if (key && [...this.entries.values()].filter((e) => e.key === key).length >= this.opts.maxPerAddr) {
      return fail(ERR.RATE, 'too many queued players from your network');
    }
    const now = this.now();
    const e = {
      session, key, ticketId: id(), difficulty, version: session.matchmakingVersion,
      joinedAt: now, expiresAt: now + this.opts.waitMs, sequence: ++this.sequence, offerId: null, accepted: false,
    };
    session.matchmakingResult = null;
    this.entries.set(session.playerId, e);
    this.push(e);
    this.pump();
    this.arm();
    return OK;
  }

  cancel(session, { ticketId }) {
    this.refresh(session);
    const e = this.entries.get(session.playerId);
    if (!e) { this.send(session, this.state(session)); return OK; }
    if (ticketId !== e.ticketId) return fail(ERR.BAD_TARGET, 'stale matchmaking ticket');
    this.remove(session, 'cancelled');
    return OK;
  }

  accept(session, { ticketId, offerId }) {
    this.refresh(session);
    if (this.closed || this.draining) return fail(ERR.MAINTENANCE, 'matchmaking is draining');
    const e = this.entries.get(session.playerId);
    const matched = session.matchmakingResult;
    if (!e && matched?.ticketId === ticketId && matched.offerId === offerId && session.roomCode === matched.code) {
      this.send(session, this.state(session));
      return OK;
    }
    const offer = this.offers.get(offerId);
    if (!e || e.ticketId !== ticketId || e.offerId !== offerId || !offer || !offer.entries.includes(e)) {
      return fail(ERR.BAD_TARGET, 'stale matchmaking offer');
    }
    if (!this.available(session) || session.matchmakingVersion !== e.version) {
      this.remove(session, 'unavailable');
      return fail(ERR.WRONG_PHASE, 'player unavailable');
    }
    if (e.accepted) { this.push(e); return OK; }
    e.accepted = true;
    for (const member of offer.entries) this.push(member);
    if (!offer.entries.every((x) => x.accepted)) return OK;
    // There is no await between validation and allocation. The lobby rechecks every membership/quota before writing.
    let result;
    try { result = this.allocate(offer.entries.map((x) => x.session), e.difficulty); }
    catch { result = fail(ERR.INTERNAL, 'could not allocate a match'); }
    if (!result || result.error || typeof result.code !== 'string') {
      this.breakOffer(offer, new Set(offer.entries), 'unavailable');
      this.arm();
      return result?.error ? result : fail(ERR.INTERNAL, 'could not allocate a match');
    }
    this.offers.delete(offer.id);
    for (const member of offer.entries) {
      this.entries.delete(member.session.playerId);
      member.session.matchmakingResult = { ticketId: member.ticketId, offerId: offer.id, difficulty: member.difficulty, code: result.code };
    }
    for (const member of offer.entries) {
      this.send(member.session, this.state(member.session));
    }
    result.publish?.();
    this.pump();
    this.arm();
    return OK;
  }

  /** Remove one identity; accepted survivors keep their original FIFO age and receive a fresh offer id. */
  remove(session, reason = 'disconnected') {
    const e = this.entries.get(session.playerId);
    if (!e) return;
    if (e.offerId) this.breakOffer(this.offers.get(e.offerId), new Set([e]), reason);
    else { this.entries.delete(session.playerId); this.idle(e, reason); }
    this.pump();
    this.arm();
  }

  breakOffer(offer, removed, reason) {
    if (!offer || this.offers.get(offer.id) !== offer) return;
    this.offers.delete(offer.id);
    for (const e of offer.entries) {
      e.offerId = null;
      e.accepted = false;
      if (removed.has(e)) { this.entries.delete(e.session.playerId); this.idle(e, reason); }
      else {
        e.reason = reason === 'cancelled' ? 'peer_cancelled' : reason === 'disconnected' ? 'peer_disconnected' : reason;
        this.push(e);
      }
    }
  }

  pump() {
    if (this.closed || this.draining) return;
    const groups = new Map();
    for (const e of this.entries.values()) {
      if (e.offerId) continue;
      const key = `${e.version}:${e.difficulty}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => a.sequence - b.sequence);
      for (let i = 0; i + MAX_SEATS <= group.length; i += MAX_SEATS) {
        const members = group.slice(i, i + MAX_SEATS);
        const offer = { id: id(), deadline: Math.min(this.now() + this.opts.acceptMs, ...members.map((e) => e.expiresAt)), entries: members };
        this.offers.set(offer.id, offer);
        for (const e of members) { e.offerId = offer.id; e.accepted = false; e.reason = null; }
        for (const e of members) this.push(e);
      }
    }
  }

  stale(e, now) {
    return e.expiresAt <= now || !this.available(e.session) || e.session.matchmakingVersion !== e.version
      || (e.session.limitKey || null) !== (e.key || null);
  }

  /** Hello/repeated accepts inspect at most one four-seat offer, not the entire queue on each network frame. */
  refresh(session) {
    const e = this.entries.get(session.playerId);
    if (!e) return;
    const now = this.now();
    const offer = e.offerId ? this.offers.get(e.offerId) : null;
    if (!offer) {
      if (this.stale(e, now)) this.remove(session, e.expiresAt <= now ? 'expired' : 'unavailable');
      return;
    }
    const removed = new Set(offer.entries.filter((member) => this.stale(member, now) || (offer.deadline <= now && !member.accepted)));
    if (!removed.size) return;
    this.breakOffer(offer, removed, offer.deadline <= now ? 'confirmation_timeout' : 'unavailable');
    this.pump();
    this.arm();
  }

  /** The single expiry timer scans only the bounded queue; incoming operations still enforce their own deadlines. */
  sweep() {
    const now = this.now();
    const expired = new Set([...this.entries.values()].filter((e) => this.stale(e, now)));
    for (const offer of [...this.offers.values()]) {
      const removed = new Set(offer.entries.filter((e) => expired.has(e) || (offer.deadline <= now && !e.accepted)));
      if (removed.size) this.breakOffer(offer, removed, offer.deadline <= now ? 'confirmation_timeout' : 'unavailable');
    }
    for (const e of expired) if (this.entries.delete(e.session.playerId)) this.idle(e, e.expiresAt <= now ? 'expired' : 'unavailable');
    this.pump();
    this.arm();
  }

  arm() {
    if (this.timer != null) { this.timers.clearTimeout(this.timer); this.timer = null; }
    if (this.closed || !this.entries.size) return;
    let at = Infinity;
    for (const e of this.entries.values()) at = Math.min(at, e.expiresAt);
    for (const offer of this.offers.values()) at = Math.min(at, offer.deadline);
    this.timer = this.timers.setTimeout(() => { this.timer = null; this.sweep(); }, Math.max(1, at - this.now()));
    this.timer?.unref?.();
  }

  clear(reason) {
    if (this.timer != null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.offers.clear();
    for (const e of entries) this.idle(e, reason);
  }

  setDraining(value) {
    this.draining = !!value;
    if (this.draining) this.clear('updating');
  }

  close() { this.closed = true; this.clear('shutdown'); }
}
