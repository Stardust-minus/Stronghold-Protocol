// server/persist/persister.js — keeps the lobby document and the local matches' checkpoints in the store, and takes them
// back at startup (docs/DEPLOY.md「断点续玩」). Used by server/index.js startServer for both a single-process server and
// the cluster coordinator (whose matches run on game nodes: their checkpoints are server/persist/node.js's, the lobby
// asks ClusterLobby.restoreRemoteMatch to place them again).
//
//   * every `saveMs` (default 10 s): each local match that may be checkpointed now (snapshot.js canSnapshot) and changed
//     since its last write is written, then the lobby document — only its records that changed (a session's settings
//     are compared by reference: the lobby replaces those frozen values, never mutates them), then its head; checkpoints
//     of matches that are gone are deleted after the document stopped naming them;
//   * at a safe point the match announces (Match._checkpoint: a draft starts, a prep ends) its checkpoint is taken at
//     once — the prep's end is the one a match interrupted during its battle comes back to;
//   * on a graceful shutdown: one last round of everything, then the lobby closes its rooms quietly (no room.closed: the
//     players are coming back);
//   * at startup (restore): sessions and rooms first (synchronously, before the server listens), then each local match
//     from its checkpoint; a match that cannot come back closes its room ('node-restarted', told on resume). A store
//     that is not answering yet (a host boot or a bare start runs its container and this process at once: refused,
//     no reply, still loading its data set) is asked again with a growing pause for up to RESTORE_WAIT_MS — the server
//     does not listen meanwhile; anything else (a refused password, a document that does not decode) is final at once.
//
// Nothing here may disturb a match: a capture that fails keeps the previous checkpoint, a store that is down is skipped
// (and counted), every timer is unref'd.

import { snapshotMatch, restoreMatch, CHECKPOINT_PREP_END } from '../match/snapshot.js';
import { createRngFromState } from '../sim/rng.js';
import { restoreLobby, roomDoc, sessionDoc, LOBBY_DOC_VERSION, SESSION_FIELDS } from './lobbyState.js';
import { TRANSIENT_FAILURES } from './store.js';

/** Default interval between rounds of writes (ms). */
export const SAVE_MS = 10_000;
/** How long the startup read waits for a store that is not answering yet (ms; restore). */
export const RESTORE_WAIT_MS = 60_000;
/** The pause before the startup read's second attempt (ms), doubled after each one up to RESTORE_PAUSE_MAX_MS. */
const RESTORE_PAUSE_MS = 500, RESTORE_PAUSE_MAX_MS = 5000;

/** A startup pause: the timer holds the process, nothing else may yet (unlike every other timer here). */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (ms) => (ms / 1000).toFixed(1);

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** A local match's checkpoint id: room, match number and seed (a new match of the room never reuses it). */
export const localCheckpointId = (code, matchNo, seed) => `L.${code}.${matchNo}.${(seed >>> 0).toString(36)}`;

export class LobbyPersister {
  /**
   * @param {{ store: import('./store.js').CheckpointStore, registry: import('../net.js').SessionRegistry,
   *   lobby: import('../lobby.js').Lobby, log?: object, saveMs?: number, now?: () => number, restoreWaitMs?: number,
   *   sleep?: (ms: number) => Promise<void> }} opts  `restoreWaitMs` / `sleep` (tests): the startup read's budget and pause
   */
  constructor({ store, registry, lobby, log = noopLog, saveMs = SAVE_MS, now = Date.now, restoreWaitMs = RESTORE_WAIT_MS, sleep = pause }) {
    this.store = store;
    this.registry = registry;
    this.lobby = lobby;
    this.log = log;
    this.now = now;
    this.sleep = sleep;
    this.saveMs = Math.max(1000, Number(saveMs) || SAVE_MS);
    this.restoreWaitMs = Math.max(0, Number(restoreWaitMs ?? RESTORE_WAIT_MS) || 0);
    this.cluster = typeof lobby.remoteMatchRef === 'function';
    /**
     * local matches (`pending`: the write of their last checkpoint)
     * @type {WeakMap<object, { id: string, seed: number, matchNo: number, room: string, json: string | null, pending: Promise<boolean> | null }>}
     */
    this.matches = new WeakMap();
    /** checkpoint ids written by this process and still named by the last lobby document */
    this.written = new Set();
    /** @type {Map<string, any[]>} player id → what its stored session record was made of (sessionKey) */
    this.sessionsStored = new Map();
    /** @type {Map<string, any[]>} room code → what its stored record was made of (roomKey) */
    this.roomsStored = new Map();
    this.timer = null;
    this.busy = null;
    this.closed = false;
    this.counts = { captures: 0, captureSkips: 0, docWrites: 0, docFailures: 0, restoredSessions: 0, restoredRooms: 0,
      restoredMatches: 0, droppedMatches: 0, deleted: 0 };
    // every local match the lobby starts offers its safe points here (Lobby.startMatch: opts.onCheckpoint); a cluster
    // lobby rebuilds a lost node's matches from their checkpoints (ClusterLobby.recoverRemote)
    lobby.onCheckpoint = (room, ctx, match, reason) => this.capture(room, match, reason);
    lobby.checkpointsOn = true;
  }

  /** The checkpoint record of a local match (created on first use). */
  record(room, match) {
    let rec = this.matches.get(match);
    if (!rec) {
      const seed = match.seed >>> 0, matchNo = room.matchCount;
      rec = { id: localCheckpointId(room.code, matchNo, seed), seed, matchNo, room: room.code, json: null, pending: null };
      this.matches.set(match, rec);
    }
    return rec;
  }

  /** A local, vanilla, running match of a room (not a match host's, not a cluster proxy). */
  localMatch(room) {
    const m = room.match;
    if (!m || room.disposed || !room.matchCtx?.live || m.hosted || this.cluster || !(m.players instanceof Map)) return null;
    return m;
  }

  /** Take a local match's checkpoint now (a safe point, or the periodic round) and queue its write. */
  capture(room, match, reason = 'tick') {
    if (this.closed || this.localMatch(room) !== match) return null;
    const doc = snapshotMatch(match);
    if (!doc) { this.counts.captureSkips++; return null; }
    const rec = this.record(room, match);
    const json = JSON.stringify({ v: 1, kind: 'local', room: room.code, matchNo: rec.matchNo, seed: rec.seed, reason, match: doc });
    if (json === rec.json) return rec;
    rec.json = json;
    this.counts.captures++;
    rec.pending = this.store.saveCheckpoint(rec.id, json).then((ok) => { if (ok) this.written.add(rec.id); return ok; });
    return rec;
  }

  /** The lobby document's reference of a room's running match. */
  matchRef(room) {
    if (this.cluster) return this.lobby.remoteMatchRef(room);
    const m = this.localMatch(room);
    if (!m) return null;
    const rec = this.matches.get(m);
    return rec && rec.json ? { kind: 'local', id: rec.id, seed: rec.seed, matchNo: rec.matchNo } : null;
  }

  /** One round of writes (never throws): local checkpoints, the lobby document, then stale checkpoints. */
  async flush(reason = 'tick') {
    if (this.busy) { if (reason === 'tick') return false; await this.busy; }
    const run = (async () => {
      const pending = [];
      if (!this.cluster) for (const room of this.lobby.rooms.values()) {
        const m = this.localMatch(room);
        if (!m) continue;
        // a match past its last safe point (a battle) is not captured again, but the write that safe point started (its
        // prep's end) still lands before the document names it and before a shutdown closes the store
        const rec = this.capture(room, m, reason) ?? this.matches.get(m);
        if (rec?.pending) pending.push(rec.pending);
      }
      await Promise.all(pending);
      let named;
      try { named = await this.writeLobby(); }
      catch (e) { named = null; this.log.warn?.(`[persist] lobby document failed (${e.message})`); }
      if (!named) { this.counts.docFailures++; return false; }
      this.counts.docWrites++;
      // checkpoints the document no longer names: their matches ended or their rooms are gone
      for (const id of [...this.written]) {
        if (named.has(id)) continue;
        this.written.delete(id);
        if (reason !== 'shutdown' && await this.store.deleteCheckpoint(id)) this.counts.deleted++;
      }
      return true;
    })();
    this.busy = run;
    try { return await run; } finally { if (this.busy === run) this.busy = null; }
  }

  /** What a session's stored record is made of: a change in any of these (by reference) rewrites it. */
  sessionKey(s) {
    return [s.token, s.name, s.roomCode, s.notice, !!s.connected, s.disconnectedAt, s.resumeWindowMs, !!s.matchHeld, s.skins,
      ...SESSION_FIELDS.map((k) => s[k])];
  }

  /** What a room's stored record is made of (scalars and references; the match's by identity): a change rewrites it. */
  roomKey(room) {
    const key = [room.hostId, room.mode, room.difficulty, room.aiPicksLast, room.listed, room.experimental, room.source, room.ownerKey, room.ownerKeys,
      room.matchKey, room.matchKeys, room.matchCount, room.createdAt, room.disposed, room.match, room.spectators.length];
    for (const s of room.spectators) key.push(s.playerId, s.name, s.owner);
    for (const s of room.seats) {
      if (!s) { key.push(null); continue; }
      key.push(s.playerId, s.name, s.isBot, s.ready, s.left, s.band, s.revivalVote, s.owner, s.skins, s.card, s.loadout, s.ops, s.notOwned,
        s.diy, s.loadoutCs, s.notOwnedCs, s.diyCs);
    }
    if (room.match) key.push(this.cluster ? this.lobby.remoteMatchKey(room) : this.matches.get(room.match)?.json != null);
    return key;
  }

  /**
   * The lobby document's changed records, its removed ones, then its head. @returns {Promise<Set<string> | null>} the local
   * checkpoint ids it names, null when the store refused a write (everything not confirmed is written again next time)
   */
  async writeLobby() {
    const sessionOf = (id) => this.registry.byId(id);
    const rooms = [], roomCodes = new Set(), named = new Set(), roomKeys = new Map();
    const same = (a, b) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);
    for (const room of this.lobby.rooms.values()) {
      const key = this.roomKey(room), prev = this.roomsStored.get(room.code);
      const local = !this.cluster && room.match ? this.matchRef(room) : null;
      if (same(prev, key)) {
        roomCodes.add(room.code);
        if (local) named.add(local.id);
        continue;
      }
      const doc = roomDoc(room, (r) => this.matchRef(r), sessionOf);
      if (!doc) continue;
      roomCodes.add(room.code);
      roomKeys.set(room.code, key);
      if (doc.match?.kind === 'local') named.add(doc.match.id);
      rooms.push([room.code, JSON.stringify(doc)]);
    }
    const sessions = [], keys = new Map();
    for (const s of this.registry.all()) {
      if (!s.roomCode || !roomCodes.has(s.roomCode)) continue;
      const key = this.sessionKey(s), prev = this.sessionsStored.get(s.playerId);
      keys.set(s.playerId, key);
      if (!prev || prev.length !== key.length || prev.some((v, i) => v !== key[i])) sessions.push([s.playerId, JSON.stringify(sessionDoc(s))]);
    }
    const goneRooms = [...this.roomsStored.keys()].filter((code) => !roomCodes.has(code));
    const goneSessions = [...this.sessionsStored.keys()].filter((id) => !keys.has(id));
    // the records first, the head last: a head always comes after the records it describes
    // a refused write: nothing of this round is known to be stored — every record is written (or deleted) again next time
    const unsure = (stored, attempted) => { for (const k of [...stored.keys(), ...attempted.map(([k]) => k)]) stored.set(k, []); };
    if (!await this.store.hashUpdate('lobby:sessions', sessions, goneSessions)) { unsure(this.sessionsStored, sessions); return null; }
    for (const id of goneSessions) this.sessionsStored.delete(id);
    for (const [id] of sessions) this.sessionsStored.set(id, keys.get(id));
    if (!await this.store.hashUpdate('lobby:rooms', rooms, goneRooms)) { unsure(this.roomsStored, rooms); return null; }
    for (const code of goneRooms) this.roomsStored.delete(code);
    for (const [code] of rooms) this.roomsStored.set(code, roomKeys.get(code));
    if (!await this.store.saveLobby({ v: LOBBY_DOC_VERSION, kind: this.cluster ? 'cluster' : 'local', savedAt: this.now(),
      sessions: this.sessionsStored.size, rooms: this.roomsStored.size })) return null;
    return named;
  }

  /** The stored lobby document (head + records), or { ok: false, error } when the store did not answer (store.js get). */
  async readLobby() {
    const head = await this.store.loadLobby();
    if (!head.ok || !head.value) return head;
    const [sessions, rooms] = await Promise.all([this.store.hashRead('lobby:sessions'), this.store.hashRead('lobby:rooms')]);
    if (!sessions.ok || !rooms.ok) return { ok: false, value: null, error: (sessions.ok ? rooms : sessions).error };
    return { ok: true, value: { ...head.value, sessions: [...sessions.value.values()], rooms: [...rooms.value.values()] } };
  }

  /**
   * The startup read (restore; see the header): readLobby again after a pause (0.5 s, doubling to 5 s) while the store
   * fails TRANSIENT_FAILURES, until `restoreWaitMs` would be over. Each retry and the outcome are logged.
   */
  async readLobbyAtStartup() {
    const t0 = this.now();
    let wait = RESTORE_PAUSE_MS;
    for (let attempt = 1; ; attempt++) { // loop-cap: every pass waits `wait` (>= 0.5 s) of the bounded restoreWaitMs, or returns
      const loaded = await this.readLobby();
      const spent = this.now() - t0;
      if (loaded.ok) {
        if (attempt > 1) this.log.info?.(`[persist] the store answered at startup (attempt ${attempt}, ${seconds(spent)} s)`);
        if (loaded.value) this.log.info?.(`[persist] saved lobby read: ${loaded.value.rooms.length} room(s), ${loaded.value.sessions.length} session(s) in ${seconds(this.now() - t0)} s`);
        return loaded;
      }
      if (!TRANSIENT_FAILURES.has(loaded.error)) {
        this.log.warn?.(`[persist] the saved lobby could not be read at startup (${loaded.error || 'error'}): nothing restored`);
        return loaded;
      }
      if (this.closed || spent + wait > this.restoreWaitMs) {
        this.log.warn?.(`[persist] the store did not answer at startup (${loaded.error}, ${attempt} attempt(s) in ${seconds(spent)} s): nothing restored`);
        return loaded;
      }
      this.log.warn?.(`[persist] the store is not answering at startup (${loaded.error}): attempt ${attempt + 1} in ${seconds(wait)} s`);
      await this.sleep(wait);
      wait = Math.min(RESTORE_PAUSE_MAX_MS, wait * 2);
    }
  }

  start() {
    if (this.timer || this.closed) return this;
    this.timer = setInterval(() => { this.flush('tick').catch(() => {}); }, this.saveMs);
    this.timer.unref?.();
    return this;
  }

  /**
   * Take the lobby and the local matches back (startServer, before listening). Sessions and rooms synchronously, then
   * every local match from its checkpoint; in the cluster the lobby places each remote match again in the background.
   * The lobby's read waits for a store that is not answering yet (readLobbyAtStartup), at most restoreWaitMs.
   */
  async restore() {
    const loaded = await this.readLobbyAtStartup();
    if (!loaded.ok) return { ok: false, reason: TRANSIENT_FAILURES.has(loaded.error) ? 'unavailable' : 'unreadable' };
    if (!loaded.value) { this.log.info?.('[persist] no saved lobby: a fresh start'); return { ok: true, sessions: 0, rooms: 0, matches: 0 }; }
    const doc = loaded.value;
    if (doc.kind !== (this.cluster ? 'cluster' : 'local')) {
      this.log.warn?.(`[persist] the saved lobby belongs to a ${doc.kind} server: nothing restored`);
      return { ok: false, reason: 'kind' };
    }
    // every stored record is rewritten (restored) or deleted (not restored) by the first round
    for (const r of doc.sessions) if (typeof r?.playerId === 'string') this.sessionsStored.set(r.playerId, []);
    for (const r of doc.rooms) if (typeof r?.code === 'string') this.roomsStored.set(r.code, []);
    const result = restoreLobby({ doc, registry: this.registry, lobby: this.lobby, now: this.now(), log: this.log });
    if (!result.ok) { this.log.warn?.(`[persist] saved lobby not restored (${result.reason})`); return result; }
    this.counts.restoredSessions += result.sessions;
    this.counts.restoredRooms += result.rooms;
    let matches = 0;
    for (const { room, ref, departed } of result.matches) {
      let ok = false;
      try { ok = this.cluster ? this.lobby.restoreRemoteMatch(room, ref, departed) : await this.restoreLocal(room, ref, departed); }
      catch (e) { this.log.warn?.(`[persist] ${room.code}: match not restored (${e.message})`); }
      if (ok) matches++;
      else {
        this.counts.droppedMatches++;
        if (!room.disposed) this.lobby.disposeRoom(room, 'node-restarted');
      }
    }
    if (!this.cluster) this.counts.restoredMatches += matches;
    this.log.info?.(`[persist] restored ${result.sessions} session(s) (${result.expired} expired), ${result.rooms} room(s), ${matches} match(es)${this.cluster ? ' being placed' : ''}`);
    return { ...result, matches };
  }

  /** A local match back from its checkpoint into its restored room. @returns {Promise<boolean>} */
  async restoreLocal(room, ref, departed) {
    if (ref?.kind !== 'local' || typeof ref.id !== 'string') return false;
    const loaded = await this.store.loadCheckpoint(ref.id);
    const cp = loaded.value;
    if (!cp || cp.kind !== 'local' || cp.room !== room.code || !cp.match || (cp.seed >>> 0) !== (ref.seed >>> 0) || cp.matchNo !== ref.matchNo) {
      this.log.warn?.(`[persist] ${room.code}: checkpoint ${loaded.ok ? 'missing or foreign' : 'unreadable'}`);
      return false;
    }
    const doc = cp.match;
    let refused = false;
    const result = this.lobby.startMatch(room, room.matchKey, room.matchKeys, { restore: {
      seed: cp.seed, matchNo: cp.matchNo, seats: doc.seats, spectators: room.spectators.map((s) => s.playerId),
      apply: (match) => {
        if (!restoreMatch(match, doc, { createRngFromState, log: this.log, replay: cp.reason === CHECKPOINT_PREP_END })) {
          refused = true; throw new Error('checkpoint refused');
        }
      },
    } });
    if (result?.error || refused || !room.match) return false;
    const rec = this.record(room, room.match);
    rec.json = null;
    this.written.add(rec.id);
    // departed seats (also those whose players did not come back) leave the restored match now — once
    for (const id of departed) if (!room.match.players.get(id)?.left) this.lobby.callMatch(room, 'onLeave', id);
    return true;
  }

  /** Stop the timer and write everything one last time; the lobby then closes its rooms without telling anybody. */
  async shutdown() {
    if (this.closed) return false;
    clearInterval(this.timer);
    this.timer = null;
    let ok;
    try { ok = await this.flush('shutdown'); } catch { ok = false; }
    this.closed = true;
    if (ok) this.lobby.closingQuietly = true;
    return ok;
  }

  snapshot() {
    return { enabled: true, saveMs: this.saveMs, ...this.counts, ...(this.cluster ? { remote: { ...this.lobby.restoreStats } } : {}),
      store: this.store.snapshot() };
  }

  async close() {
    clearInterval(this.timer);
    this.timer = null;
    this.closed = true;
    if (this.lobby.onCheckpoint) this.lobby.onCheckpoint = null;
    this.lobby.checkpointsOn = false;
  }
}
