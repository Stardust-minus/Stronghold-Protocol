// Bounded, synchronous four-human matchmaking. Parties are indivisible session identities, never sockets.
// Every human explicitly accepts and votes before the lobby atomically starts and commits a match.
import { randomBytes } from 'node:crypto';
import { ERR, MAX_SEATS, DIFFICULTIES, MATCHMAKING_VERSION } from '../shared/constants.js';

export const MATCHMAKING_DEFAULTS = Object.freeze({ maxEntries: 2000, maxPerAddr: 16, waitMs: 600_000, acceptMs: 30_000 });
const OK = Object.freeze({ ok: true });
const fail = (error, detail) => ({ error, detail });
const id = () => randomBytes(16).toString('hex');

export class Matchmaking {
  constructor({ now = Date.now, send, available, members, allocate, options = {}, timers = { setTimeout, clearTimeout } }) {
    this.now = now;
    this.send = send;
    this.available = available;
    this.members = members || ((session) => ({ sessions: [session], roomCode: null, leaderId: session.playerId }));
    this.allocate = allocate;
    this.timers = timers;
    this.opts = { ...MATCHMAKING_DEFAULTS, ...options };
    const limits = { maxEntries: 20_000, maxPerAddr: 20_000, waitMs: 3_600_000, acceptMs: 120_000 };
    for (const [key, max] of Object.entries(limits)) {
      if (!Number.isSafeInteger(this.opts[key]) || this.opts[key] < 1 || this.opts[key] > max) throw new TypeError(`invalid matchmaking ${key}`);
    }
    this.entries = new Map();
    this.parties = new Map();
    this.offers = new Map();
    this.sequence = 0;
    this.timer = null;
    this.closed = false;
  }

  has(session) { return this.entries.has(session.playerId); }
  get size() { return this.entries.size; }
  partyState(party) {
    return { partyId: party.id, partySize: party.entries.length, partyLeaderId: party.leaderId, partyRoomCode: party.roomCode };
  }

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
      deadline: offer ? offer.deadline : e.expiresAt, ...this.partyState(e.party),
      ...(e.reason ? { reason: e.reason } : {}),
      ...(offer ? { offerId: offer.id, accepted: e.accepted, revivalVote: e.revivalVote, acceptedCount: offer.entries.filter((x) => x.accepted).length } : {}),
    };
  }

  sync(session) { this.refresh(session); this.send(session, this.state(session)); }
  push(e) { this.send(e.session, this.state(e.session)); }
  idle(e, reason) { this.send(e.session, { t: 'queue.state', state: 'idle', ticketId: null, required: MAX_SEATS, reason }); }

  join(session, { difficulty, party = false }) {
    this.refresh(session);
    if (this.closed) return fail(ERR.WRONG_PHASE, 'matchmaking is closed');
    if (!DIFFICULTIES.includes(difficulty) || typeof party !== 'boolean') return fail(ERR.BAD_MSG, 'invalid matchmaking request');
    if (session.matchmakingVersion !== MATCHMAKING_VERSION) return fail(ERR.BAD_MSG, 'matchmaking version required; refresh the page');
    const previous = this.entries.get(session.playerId);
    if (previous) {
      if (previous.difficulty !== difficulty) return fail(ERR.QUEUED, 'cancel before changing difficulty');
      this.push(previous);
      if (!previous.offerId) { this.pump(); this.arm(); }
      return OK;
    }
    const group = this.members(session, difficulty, party);
    if (!group || group.error) return group || fail(ERR.INTERNAL, 'could not inspect party');
    const sessions = group.sessions;
    if (!Array.isArray(sessions) || sessions.length < 1 || sessions.length > MAX_SEATS
      || new Set(sessions.map((s) => s.playerId)).size !== sessions.length) return fail(ERR.BAD_TARGET, 'invalid party');
    for (const member of sessions) {
      if (this.has(member)) return fail(ERR.QUEUED, 'party member already queued');
      if (member.matchmakingVersion !== MATCHMAKING_VERSION) return fail(ERR.BAD_MSG, 'all party members must refresh the page');
    }
    this.sweep();
    if (this.entries.size + sessions.length > this.opts.maxEntries) return fail(ERR.RATE, 'matchmaking queue is full');
    const counts = new Map();
    for (const member of sessions) if (member.limitKey) counts.set(member.limitKey, (counts.get(member.limitKey) || 0) + 1);
    for (const e of this.entries.values()) if (counts.has(e.key)) counts.set(e.key, counts.get(e.key) + 1);
    if ([...counts.values()].some((count) => count > this.opts.maxPerAddr)) return fail(ERR.RATE, 'too many queued players from your network');
    const now = this.now();
    const unit = { id: id(), roomCode: group.roomCode || null, leaderId: group.leaderId || session.playerId, sequence: ++this.sequence, entries: [] };
    unit.entries = sessions.map((member) => ({
      session: member, key: member.limitKey, ticketId: id(), difficulty, version: member.matchmakingVersion, party: unit,
      joinedAt: now, expiresAt: now + this.opts.waitMs, sequence: unit.sequence, offerId: null, accepted: false, revivalVote: null,
    }));
    if (unit.entries.some((e) => !this.available(e.session, e))) return fail(ERR.WRONG_PHASE, 'party member unavailable');
    this.parties.set(unit.id, unit);
    for (const e of unit.entries) { e.session.matchmakingResult = null; this.entries.set(e.session.playerId, e); }
    for (const e of unit.entries) this.push(e);
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

  accept(session, { ticketId, offerId, revivalVote }) {
    if (typeof revivalVote !== 'boolean') return fail(ERR.BAD_MSG, 'explicit revival vote required');
    this.refresh(session);
    if (this.closed) return fail(ERR.WRONG_PHASE, 'matchmaking is closed');
    const e = this.entries.get(session.playerId);
    const matched = session.matchmakingResult;
    if (!e && matched?.ticketId === ticketId && matched.offerId === offerId && session.roomCode === matched.code) {
      if (revivalVote !== matched.revivalVote) return fail(ERR.BAD_MSG, 'accepted revival vote is locked');
      this.send(session, this.state(session));
      return OK;
    }
    const offer = this.offers.get(offerId);
    if (!e || e.ticketId !== ticketId || e.offerId !== offerId || !offer || !offer.entries.includes(e)) return fail(ERR.BAD_TARGET, 'stale matchmaking offer');
    if (!this.available(session, e) || session.matchmakingVersion !== e.version) {
      this.remove(session, 'unavailable');
      return fail(ERR.WRONG_PHASE, 'player unavailable');
    }
    if (e.accepted) {
      if (revivalVote !== e.revivalVote) return fail(ERR.BAD_MSG, 'accepted revival vote is locked');
      this.push(e);
      return OK;
    }
    e.revivalVote = revivalVote;
    e.accepted = true;
    for (const member of offer.entries) this.push(member);
    if (!offer.entries.every((x) => x.accepted)) return OK;
    // No await: the lobby validates identities, parties and quotas again before starting/committing.
    let result;
    try { result = this.allocate(offer.entries.map((x) => x.session), e.difficulty); }
    catch { result = fail(ERR.INTERNAL, 'could not allocate a match'); }
    if (!result || result.error || typeof result.code !== 'string') {
      // Healthy parties keep their original rooms, tickets, FIFO/TTL. No immediate capacity re-offer loop.
      const removed = new Set(offer.entries.filter((member) => this.stale(member, this.now())));
      this.breakOffer(offer, removed, 'allocation_failed');
      this.arm();
      return result?.error ? result : fail(ERR.INTERNAL, 'could not allocate a match');
    }
    this.offers.delete(offer.id);
    for (const member of offer.entries) {
      this.entries.delete(member.session.playerId);
      this.parties.delete(member.party.id);
      member.session.matchmakingResult = {
        ticketId: member.ticketId, offerId: offer.id, difficulty: member.difficulty, code: result.code,
        revivalVote: member.revivalVote, ...this.partyState(member.party),
      };
    }
    // room.state(inMatch) first: the client clears old game slices on a changed room. Matched is last.
    result.publish?.();
    for (const member of offer.entries) this.send(member.session, this.state(member.session));
    this.pump();
    this.arm();
    return OK;
  }

  /** Removing any identity removes its whole party; unrelated parties keep their FIFO age. */
  remove(session, reason = 'disconnected') {
    const e = this.entries.get(session.playerId);
    if (!e) return;
    if (e.offerId) this.breakOffer(this.offers.get(e.offerId), new Set(e.party.entries), reason);
    else this.dropParty(e.party, reason);
    this.pump();
    this.arm();
  }

  dropParty(party, reason) {
    this.parties.delete(party.id);
    for (const e of party.entries) if (this.entries.delete(e.session.playerId)) this.idle(e, reason);
  }

  breakOffer(offer, removed, reason) {
    if (!offer || this.offers.get(offer.id) !== offer) return;
    this.offers.delete(offer.id);
    const removedParties = new Set([...removed].map((e) => e.party));
    // Only parties whose every human accepted THIS offer may continue automatically. Capture before
    // clearing votes: allocation failures arrive fully accepted and must retain their tickets/rooms.
    const unconfirmedParties = new Set(offer.entries.filter((e) => !e.accepted).map((e) => e.party));
    for (const party of new Set([...removedParties, ...unconfirmedParties])) this.parties.delete(party.id);
    for (const e of offer.entries) {
      e.offerId = null;
      e.accepted = false;
      e.revivalVote = null;
      if (removedParties.has(e.party) || unconfirmedParties.has(e.party)) {
        this.entries.delete(e.session.playerId);
        this.idle(e, removedParties.has(e.party) ? reason : 'unconfirmed');
      } else {
        e.reason = reason === 'cancelled' ? 'peer_cancelled' : reason === 'disconnected' ? 'peer_disconnected' : reason;
        this.push(e);
      }
    }
  }

  pump() {
    if (this.closed) return;
    const pools = new Map();
    for (const party of this.parties.values()) {
      const e = party.entries[0];
      if (e.offerId) continue;
      const key = `${e.version}:${e.difficulty}`;
      if (!pools.has(key)) pools.set(key, []);
      pools.get(key).push(party);
    }
    for (const pool of pools.values()) {
      pool.sort((a, b) => a.sequence - b.sequence);
      const unused = new Set(pool);
      const sizes = Array.from({ length: MAX_SEATS + 1 }, () => []);
      const cursors = new Array(MAX_SEATS + 1).fill(0);
      for (const party of pool) sizes[party.entries.length].push(party);
      for (const leader of pool) {
        if (!unused.has(leader)) continue;
        const remaining = MAX_SEATS - leader.entries.length;
        const candidates = [];
        // Only the first floor(remaining/size) later units of each size can occur in an earliest fit.
        // At four seats this bounds the combination search to five candidates, not the whole queue.
        for (let size = 1; size <= remaining; size++) {
          const list = sizes[size];
          while (cursors[size] < list.length && (list[cursors[size]].sequence <= leader.sequence || !unused.has(list[cursors[size]]))) cursors[size]++;
          let taken = 0;
          for (let i = cursors[size]; i < list.length && taken < Math.floor(remaining / size); i++) {
            if (unused.has(list[i])) { candidates.push(list[i]); taken++; }
          }
        }
        candidates.sort((a, b) => a.sequence - b.sequence);
        const fit = (at, slots) => {
          if (!slots) return [];
          for (let i = at; i < candidates.length; i++) {
            const size = candidates[i].entries.length;
            if (size > slots) continue;
            const rest = fit(i + 1, slots - size);
            if (rest) return [candidates[i], ...rest];
          }
          return null;
        };
        const rest = fit(0, remaining);
        if (!rest) continue; // never split a party; an unfillable older unit does not block every later fit
        const parties = [leader, ...rest];
        const entries = parties.flatMap((party) => party.entries);
        const offer = { id: id(), deadline: Math.min(this.now() + this.opts.acceptMs, ...entries.map((e) => e.expiresAt)), entries };
        this.offers.set(offer.id, offer);
        for (const party of parties) unused.delete(party);
        for (const e of entries) { e.offerId = offer.id; e.accepted = false; e.revivalVote = null; e.reason = null; }
        for (const e of entries) this.push(e);
      }
    }
  }

  stale(e, now) {
    return e.expiresAt <= now || !this.available(e.session, e) || e.session.matchmakingVersion !== e.version
      || (e.session.limitKey || null) !== (e.key || null);
  }

  /** Hello/repeated accepts inspect at most one four-seat offer, never the entire queue per frame. */
  refresh(session) {
    const e = this.entries.get(session.playerId);
    if (!e) return;
    const now = this.now();
    const offer = e.offerId ? this.offers.get(e.offerId) : null;
    if (!offer) {
      const stale = e.party.entries.find((member) => this.stale(member, now));
      if (stale) this.remove(session, stale.expiresAt <= now ? 'expired' : 'unavailable');
      return;
    }
    const removed = new Set(offer.entries.filter((member) => this.stale(member, now) || (offer.deadline <= now && !member.accepted)));
    if (!removed.size) return;
    this.breakOffer(offer, removed, offer.deadline <= now ? 'confirmation_timeout' : 'unavailable');
    this.pump();
    this.arm();
  }

  /** One timer scans the bounded queue; incoming operations also enforce their own deadlines. */
  sweep() {
    const now = this.now();
    const expired = new Set([...this.entries.values()].filter((e) => this.stale(e, now)));
    for (const offer of [...this.offers.values()]) {
      const removed = new Set(offer.entries.filter((e) => expired.has(e) || (offer.deadline <= now && !e.accepted)));
      if (removed.size) this.breakOffer(offer, removed, offer.deadline <= now ? 'confirmation_timeout' : 'unavailable');
    }
    for (const e of expired) if (this.entries.has(e.session.playerId)) this.dropParty(e.party, e.expiresAt <= now ? 'expired' : 'unavailable');
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
    this.parties.clear();
    this.offers.clear();
    for (const e of entries) this.idle(e, reason);
  }

  close() { this.closed = true; this.clear('shutdown'); }
}
