// Global lobby/membership only. Whole Match/Workers and all battle I/O remain on
// the assigned node. RemoteGamePlatform owns private ingress routing/credentials.
import { randomBytes, randomInt } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Lobby, Room } from '../lobby.js';
import { encode, isErrCode, sendSession } from '../net.js';
import { ERR, MAX_SEATS, MAX_SPECTATORS, MATCHMAKING_VERSION, modeIdFor } from '../../shared/constants.js';
import { experimentalOptions, isExperimental, sameExperimental } from '../../shared/experimental.js';
import { MAX_PLAYER_CAPACITY, roomCapacity } from '../../shared/playerCapacity.js';
import { DEFAULT_VERSION } from '../../shared/versions.js';

const OK = Object.freeze({ ok: true });
const fail = error => ({ error });
const invalid = (code = ERR.WRONG_PHASE) => { throw Object.assign(new Error('remote admission invalid'), { code }); };
const plain = value => value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9_.:-]*(?![\s\S])/.test(value) && value.length <= 128;
const quiet = value => Promise.resolve(value).catch(() => false);
const synchronous = value => {
  if (value && typeof value.then === 'function') { quiet(value); invalid(ERR.INTERNAL); }
  if (value === false || value?.error) invalid(ERR.INTERNAL);
  return value;
};
const sameSet = (a, b) => a.size === b.size && [...a].every(value => b.has(value));
// Allocation failures a player can simply retry — a member's game channel did not bind within the allocation window, or a
// member was momentarily unreachable when routed — say so; any other non-protocol failure stays INTERNAL. Every failed
// start is logged with its step (logStartFailure).
const RETRYABLE_START = new Set(['TIMEOUT', 'PLAYER_OFFLINE']);
const startError = error => isErrCode(error?.code) ? error.code : RETRYABLE_START.has(error?.code) ? ERR.START_RETRY : ERR.INTERNAL;
// A restored match waits this long for a node to take it (the whole stack restarts at once: nodes come up meanwhile,
// and a node whose checkpoint store is not answering yet says NOT_READY), retrying every RESTORE_RETRY_MS on these
// codes; any other failure closes its room at once.
const RESTORE_WAIT_MS = 120_000, RESTORE_RETRY_MS = 1000;
const RESTORE_RETRY = new Set(['NO_NODE', 'NOT_READY', 'TRANSPORT', 'TIMEOUT', 'BAD_REPLY', 'CLOSED', 'NODE_UNAVAILABLE', 'SESSION_BUSY', 'ROOM_BUSY']);

function matchDTO(room, seed, snapshotHz) {
  return {
    roomCode: room.code, mode: room.mode, difficulty: room.difficulty, modeId: modeIdFor(room.mode, room.difficulty),
    revivalEnabled: room.revivalState().enabled, disableSharedPool: room.experimental.disableSharedPool,
    experimental: room.experimental, aiPicksLast: room.mode !== 'solo' && room.aiPicksLast === true, seed, matchNo: room.matchCount + 1,
    seats: room.seats.filter(Boolean).map(s => ({ seat: s.seat, playerId: s.playerId, name: s.name,
      isBot: s.isBot, connected: s.connected, loadout: structuredClone(s.isBot ? null : s.loadout || null),
      ops: structuredClone(s.isBot ? null : s.ops || null),
      notOwned: structuredClone(s.isBot ? null : s.notOwned || null), diy: structuredClone(s.isBot ? null : s.diy || null),
      skins: Object.freeze({ ...(s.isBot ? {} : s.skins || {}) }), ...(s.isBot && s.band ? { band: s.band } : {}) })),
    spectators: room.spectators.map(s => s.playerId), ...(snapshotHz === undefined ? {} : { snapshotHz }),
  };
}
function optsDTO(opts) {
  const fields = ['roomCode', 'mode', 'difficulty', 'modeId', 'revivalEnabled', 'disableSharedPool', 'experimental', 'aiPicksLast', 'seed', 'matchNo', 'seats', 'spectators'];
  const dto = Object.fromEntries(fields.map(key => [key, opts[key]]));
  if (opts.snapshotHz !== undefined) dto.snapshotHz = opts.snapshotHz;
  return dto;
}
// The display-only member fields (room.card's `card`, the 服主 `owner` mark) never reach the match (matchDTO): a change
// while a start is being prepared does not invalidate it.
const stampMember = member => { if (!member) return member; const { card, owner, ...rest } = member; return rest; };
function roomStamp(room) {
  return structuredClone({ hostId: room.hostId, mode: room.mode, difficulty: room.difficulty, matchCount: room.matchCount,
    source: room.source, experimental: room.experimental, aiPicksLast: room.aiPicksLast, ownerKey: room.ownerKey, ownerKeys: room.ownerKeys ? [...room.ownerKeys].sort() : null,
    seats: room.seats.map(stampMember), spectators: room.spectators.map(stampMember), disposed: room.disposed });
}

class PreparedRemoteMatch {
  constructor(lobby, plan, opts) {
    this.lobby = lobby; this.plan = plan; this.opts = opts; this.started = false; this.ended = false;
    this.members = new Set([...plan.spec.seats.filter(s => !s.isBot).map(s => s.playerId), ...plan.spec.spectators]);
    this.loadoutSequence = 0; this.lastLoadout = null;
    this.skinsSequence = 0; this.lastSkins = null;
    this.mutationSequence = 0; this.lastMutation = null;
    this.pendingSpectators = new Map(); this.pendingSpectatorRemovals = new Set(); this.pendingPeers = new Map();
  }
  start() {
    if (this.started || this.plan.aborted || !this.plan.remoteCommitted) invalid(ERR.INTERNAL);
    this.started = true; // The actor was already started by platform.prepare. Never construct/simulate here.
    return OK;
  }
  handle() { return fail(ERR.WRONG_PHASE); } // Game input must go directly to the game channel.
  onDisconnect() {} // The actual game-channel close, not this coordination socket, drives the engine.
  onReconnect(playerId) {
    try { return this.plan.published && this.members.has(playerId) && this.lobby.platform.resume(this.plan.spec.assignmentId, playerId); }
    catch { return false; }
  }
  peer(method, playerId, loadout, ops = undefined) {
    if (!this.plan.published || this.ended || this.pendingPeers.has(playerId)
      || typeof this.lobby.platform.peer !== 'function') return Promise.resolve(fail(ERR.INTERNAL));
    try {
      const pending = Promise.resolve(this.lobby.platform.peer(this.plan.spec.assignmentId, method, playerId, loadout, ops))
        .then(result => result?.ok === true ? OK : fail(isErrCode(result?.error) ? result.error : ERR.INTERNAL), () => fail(ERR.INTERNAL))
        .catch(() => fail(ERR.INTERNAL));
      this.pendingPeers.set(playerId, pending);
      pending.then(() => { if (this.pendingPeers.get(playerId) === pending) this.pendingPeers.delete(playerId); });
      return pending;
    } catch { return Promise.resolve(fail(ERR.INTERNAL)); }
  }
  mutate(method, playerId) {
    this.mutationSequence++;
    this.lastMutation = this.peer(method, playerId);
    return this.lastMutation;
  }
  addSpectator(playerId) {
    if (this.pendingSpectators.has(playerId)) return this.pendingSpectators.get(playerId);
    if (this.members.has(playerId)) return this.onReconnect(playerId);
    this.members.add(playerId);
    this.mutationSequence++;
    const pending = this.peer('addSpectator', playerId).then(result => {
      if (this.pendingSpectators.get(playerId) === pending) this.pendingSpectators.delete(playerId);
      if (result.error) this.members.delete(playerId);
      else if (!this.pendingSpectatorRemovals.has(playerId) && (!this.members.has(playerId)
        || this.lobby.registry.byId(playerId)?.roomCode !== this.plan.room.code || !this.plan.room.spectatorOf(playerId))) {
        this.members.delete(playerId); quiet(this.peer('removeSpectator', playerId)); return fail(ERR.WRONG_PHASE);
      }
      return result;
    });
    this.pendingSpectators.set(playerId, pending);
    this.lastMutation = pending;
    return pending;
  }
  onLeave(playerId) {
    this.members.delete(playerId);
    this.lobby.platform.revoke?.(this.plan.spec.assignmentId, playerId);
    const pending = this.pendingPeers.get(playerId);
    if (!pending) return this.mutate('leave', playerId);
    this.mutationSequence++;
    this.lastMutation = pending.then(() => this.peer('leave', playerId));
    return this.lastMutation;
  }
  removeSpectator(playerId) {
    this.members.delete(playerId);
    this.lobby.platform.revoke?.(this.plan.spec.assignmentId, playerId);
    const pending = this.pendingSpectators.get(playerId);
    if (!pending) return this.mutate('removeSpectator', playerId);
    // A permanent departure wins over an in-flight spectator admission. Send
    // one removal after the role acknowledgement, not a MEMBER_BUSY request
    // that could leave a late observer authorized after moving to another room.
    this.pendingSpectatorRemovals.add(playerId); this.mutationSequence++;
    this.lastMutation = pending.then(result => result.error ? OK : this.peer('removeSpectator', playerId))
      .then(result => { this.pendingSpectatorRemovals.delete(playerId); return result; });
    return this.lastMutation;
  }
  requestSetupReroll(playerId, revision) { return this.peer('requestSetupReroll', playerId, revision); }
  cancelSetupReroll(playerId, voteId) { return this.peer('cancelSetupReroll', playerId, voteId); }
  setLoadout(playerId, loadout, ops = undefined) {
    this.loadoutSequence++;
    this.lastLoadout = this.peer('setLoadout', playerId, loadout, ops);
    return this.lastLoadout;
  }
  setSkins(playerId, choices) {
    this.skinsSequence++;
    this.lastSkins = this.peer('setSkins', playerId, choices);
    return this.lastSkins;
  }
  dispose() {
    // a coordinator that saved its state stops without releasing its matches: after its restart it takes them over
    // where they still run (ClusterLobby.restoreRemoteMatch), or their nodes rebuild them from their checkpoints
    if (this.lobby.closingQuietly) return undefined;
    if (!this.plan.published) return this.plan.abort();
    if (this.ended) return this.lobby.releasePlan(this.plan);
    if (this.plan.room.disposed) {
      // Last-human departure/explicit room disposal is authoritative cleanup,
      // not a fabricated settlement. Let the final leave RPC revoke membership
      // first; releasing the whole actor earlier would race that acknowledgement.
      const pending = [this.lastMutation, this.lastLoadout, ...this.pendingPeers.values()].filter(Boolean);
      if (!pending.length) return this.lobby.releasePlan(this.plan);
      return quiet(Promise.all(pending).then(() => this.lobby.releasePlan(this.plan)));
    }
  }
}

export class ClusterLobby extends Lobby {
  constructor({ platform, ...opts }) {
    if (!platform || typeof platform.prepare !== 'function' || typeof platform.resume !== 'function'
      || typeof platform.release !== 'function' || typeof platform.deliverEnd !== 'function'
      || !safeId(platform.build) || !Number.isSafeInteger(platform.protocol) || platform.protocol < 1) {
      throw new TypeError('invalid cluster lobby platform');
    }
    super(opts);
    this.platform = platform;
    this.preparedByRoom = new Map();
    this.manualPending = new Map();
    this.assignments = new Map();
    this.clusterClosed = false;
    this.inspectStart = false;
    this.queue.asyncAllocate = (sessions, difficulty, context) => this.prepareMatchmadeRoom(sessions, difficulty, context);
    /** remote matches placed again after a restart (restoreRemoteMatch; /healthz persistence.remote) */
    this.restoreStats = { pending: 0, adopted: 0, rebuilt: 0, failed: 0 };
    /** checkpoints are kept (server/persist/persister.js sets it): a lost node's matches are rebuilt (recoverRemote) */
    this.checkpointsOn = false;
  }

  createMatch(opts) {
    const plan = this.preparedByRoom.get(opts.roomCode);
    if (!plan || plan.aborted || !plan.remoteCommitted || !isDeepStrictEqual(optsDTO(opts), plan.dto)) invalid(ERR.INTERNAL);
    this.preparedByRoom.delete(opts.roomCode); // Exactly one factory consumption per prepared actor.
    plan.proxy = new PreparedRemoteMatch(this, plan, opts);
    return plan.proxy;
  }
  startMatch(room, key, keys, options) {
    if (this.inspectStart) return { ok: true, room, key, keys };
    return super.startMatch(room, key, keys, options);
  }
  inspectManual(session) {
    this.inspectStart = true;
    try { return super.start(session); } finally { this.inspectStart = false; }
  }

  newPlan(room, oldRooms, sessions, key, keys, check, signal) {
    const t0 = this.metrics.start();
    let seed;
    try { seed = this.seedFn() >>> 0; } catch { seed = randomInt(2 ** 32); }
    const dto = matchDTO(room, seed, this.opts.snapshotHz);
    // Diagnostics only: each admission re-check is one timed synchronous phase.
    const valid = () => { const at = this.metrics.start(); try { return check(); } finally { this.metrics.end('match.valid', at); } };
    const plan = { room, oldRooms, sessions, key, keys, dto, controller: new AbortController(), valid, startedAt: this.now(),
      aborted: false, published: false, remoteCommitted: false, transferred: false, rollbackDone: false,
      handle: null, remoteCleanup: null, proxy: null, ctx: null, basePublish: null, release: null,
      spec: structuredClone({ assignmentId: randomBytes(16).toString('hex'), build: this.platform.build, protocol: this.platform.protocol, ...dto }),
    };
    for (const seat of plan.spec.seats) Object.freeze(seat.skins);
    plan.abort = () => {
      plan.aborted = true;
      if (!plan.controller.signal.aborted) plan.controller.abort();
      this.rollbackPlan(plan);
      if (this.preparedByRoom.get(room.code) === plan) this.preparedByRoom.delete(room.code);
      if (!plan.handle || plan.remoteCleanup) return plan.remoteCleanup || Promise.resolve(false);
      try { plan.remoteCleanup = quiet(plan.handle.abort()); } catch { plan.remoteCleanup = Promise.resolve(false); }
      return plan.remoteCleanup;
    };
    const cancel = () => plan.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    plan.detach = () => signal?.removeEventListener('abort', cancel);
    if (signal?.aborted) plan.abort();
    this.metrics.end('match.plan', t0, plan.dto.seats.length);
    return plan;
  }

  async preparePlan(plan) {
    const signal = plan.controller.signal;
    if (signal.aborted || !plan.valid()) invalid();
    let abort;
    const cancellation = new Promise((resolve, reject) => {
      abort = () => reject(Object.assign(new Error('remote preparation cancelled'), { code: ERR.WRONG_PHASE }));
      signal.addEventListener('abort', abort, { once: true });
    });
    let raw;
    const t0 = this.metrics.start();
    try { raw = Promise.resolve(this.platform.prepare(structuredClone(plan.spec), { signal, isCurrent: () => !plan.aborted && plan.valid() })); }
    catch (error) { signal.removeEventListener('abort', abort); plan.abort(); throw error; }
    finally { this.metrics.end('match.prepare', t0); } // the synchronous part, up to the node RPC
    // A provider ignoring cancellation still receives late compensation; the
    // request itself does not wait indefinitely for that provider to settle.
    raw.then(handle => { plan.handle = handle; if (plan.aborted) plan.abort(); }, () => {});
    try {
      const handle = await Promise.race([raw, cancellation]);
      plan.handle = handle;
      if (!handle || handle.assignmentId !== plan.spec.assignmentId || !safeId(handle.nodeId) || !safeId(handle.generation)
        || ['commit', 'publish', 'abort'].some(key => typeof handle[key] !== 'function') || !plan.valid() || signal.aborted) invalid();
      return plan;
    } catch (error) { plan.abort(); throw error; }
    finally { signal.removeEventListener('abort', abort); }
  }

  collectMatchmade(sessions, difficulty, context) {
    if (sessions.length < MAX_SEATS || sessions.length > MAX_PLAYER_CAPACITY
      || new Set(sessions.map(s => s.playerId)).size !== sessions.length || !context.isCurrent()) invalid(ERR.BAD_TARGET);
    const first = this.queue.entries.get(sessions[0].playerId), offer = this.queue.offers.get(context.offerId), now = this.now();
    if (!offer || first?.offerId !== offer.id || offer.entries.length !== offer.required
      || sessions.length !== offer.required || now >= offer.deadline) invalid(ERR.BAD_TARGET);
    if (!isExperimental(offer.experimental) || roomCapacity('coop', offer.experimental) !== offer.required) invalid(ERR.BAD_MSG);
    const oldRooms = new Set();
    for (const session of sessions) {
      const entry = this.queue.entries.get(session.playerId);
      if (this.registry.byId(session.playerId) !== session || !this.matchmakingAvailable(session, entry)
        || session.matchmakingVersion !== MATCHMAKING_VERSION || entry?.session !== session || entry.version !== MATCHMAKING_VERSION
        || entry.expiresAt <= now || (entry.key || null) !== (session.limitKey || null) || !entry.accepted
        || entry.offerId !== offer.id || entry.difficulty !== difficulty
        || (entry.party.experimental && !sameExperimental(entry.party.experimental, offer.experimental))
        || !offer.entries.includes(entry) || entry.party.entries.some(member => !offer.entries.includes(member))) invalid();
      if (entry.party.roomCode) oldRooms.add(this.roomOf(session));
    }
    const spectators = [...oldRooms].flatMap(room => room.spectators);
    if (MAX_SPECTATORS > 0 && spectators.length > MAX_SPECTATORS) invalid(ERR.ROOM_FULL);
    for (const room of oldRooms) if (room.spectators.some(s => this.registry.byId(s.playerId)?.roomCode !== room.code)) invalid(ERR.BAD_TARGET);
    const maxRooms = this.cap('maxRooms'), perAddr = this.cap('maxRoomsPerAddr'), maxMatches = this.cap('maxMatchesPerAddr');
    if (maxRooms > 0 && this.rooms.size - oldRooms.size >= maxRooms) invalid(ERR.RATE);
    const keys = new Set(sessions.map(s => s.limitKey).filter(Boolean));
    for (const key of keys) {
      const released = [...oldRooms].filter(room => this.roomCharges(room, key)).length;
      if ((perAddr > 0 && this.countRooms(room => this.roomCharges(room, key)) - released >= perAddr)
        || (maxMatches > 0 && this.countRooms(room => !!room.match && this.matchCharges(room, key)) >= maxMatches)) invalid(ERR.RATE);
    }
    return { oldRooms, spectators, keys, experimental: experimentalOptions(offer.experimental) };
  }

  async prepareMatchmadeRoom(sessions, difficulty, context) {
    const initial = this.collectMatchmade(sessions, difficulty, context), code = this.genCode();
    if (!code) invalid(ERR.INTERNAL);
    const room = new Room(code, 'coop', difficulty, this.now());
    room.source = 'matchmaking'; room.experimental = initial.experimental;
    room.ownerKeys = initial.keys; room.ownerKey = sessions[0].limitKey || null; room.hostId = sessions[0].playerId;
    room.spectators = initial.spectators.map(s => ({ ...s }));
    room.seats = sessions.map((s, i) => ({ ...this.humanSeat(i, s), ready: true, revivalVote: this.queue.entries.get(s.playerId).revivalVote }));
    const stamps = new Map([...initial.oldRooms].map(old => [old, roomStamp(old)]));
    const entries = sessions.map(s => this.queue.entries.get(s.playerId));
    const tickets = entries.map(e => e.ticketId);
    let plan;
    const valid = () => {
      try {
        if (this.clusterClosed || this.rooms.has(code) || this.spectatorAliases.has(code)) return false;
        const current = this.collectMatchmade(sessions, difficulty, context);
        if (!sameSet(current.oldRooms, initial.oldRooms) || !sameSet(current.keys, initial.keys)
          || !isDeepStrictEqual(current.spectators, initial.spectators) || !sameExperimental(current.experimental, initial.experimental)) return false;
        for (const [old, stamp] of stamps) if (this.rooms.get(old.code) !== old || old.match || !isDeepStrictEqual(roomStamp(old), stamp)) return false;
        if (!sessions.every((s, i) => this.queue.entries.get(s.playerId) === entries[i] && entries[i].ticketId === tickets[i])) return false;
        const live = new Room(code, 'coop', difficulty, room.createdAt);
        live.hostId = room.hostId; live.experimental = current.experimental; live.spectators = current.spectators.map(s => ({ ...s }));
        live.seats = sessions.map((s, i) => ({ ...this.humanSeat(i, s), ready: true, revivalVote: entries[i].revivalVote }));
        return isDeepStrictEqual(matchDTO(live, plan.dto.seed, this.opts.snapshotHz), plan.dto);
      } catch { return false; }
    };
    plan = this.newPlan(room, initial.oldRooms, sessions, room.ownerKey, initial.keys, valid, context.signal);
    try { await this.preparePlan(plan); }
    catch (error) { this.logStartFailure('matchmaking', room, plan, error); throw error; }
    return { code, commit: () => this.commitPlan(plan), publish: () => this.publishPlan(plan), abort: () => plan.abort() };
  }

  /**
   * One line per failed start (no names): the reason code, the remote step it stopped at and how many players had bound
   * (RemoteGamePlatform.prepare), the plan's age and what the player was told. Never changes the reply.
   */
  logStartFailure(kind, room, plan, error) {
    try {
      const seats = plan?.dto?.seats || [], players = seats.filter(s => !s.isBot).length;
      const reason = typeof error?.code === 'string' ? error.code : error?.name || 'Error';
      const step = typeof error?.step === 'string' ? ` at ${error.step}` : '';
      const bound = Number.isSafeInteger(error?.playersConnected) ? `, ${error.playersConnected}/${players} bound` : '';
      const age = Number.isFinite(plan?.startedAt) ? `, ${Math.round(this.now() - plan.startedAt)}ms` : '';
      this.log.warn(`[lobby] ${room.code} match start failed (${kind}, ${seats.length} seats, ${players} players): ${reason}${step}${bound}${age} -> ${startError(error)}`);
    } catch { /* diagnostics only */ }
  }

  setExperimental(session, msg) {
    const room = this.roomOf(session), previous = room?.experimental;
    const result = super.setExperimental(session, msg);
    if (result.ok && room.experimental !== previous) this.manualPending.get(room.code)?.abort();
    return result;
  }

  // spectator-to-AI handover reads the match's seats, which live on the game node
  setAiTakeover(session, msg) { return msg.on === true ? fail(ERR.BAD_TARGET) : super.setAiTakeover(session, msg); }

  start(session) {
    // Another official version's match stays in this process's version hosts (server/match/host/, kind 'version'): a game
    // node's modules hold 第二期下半's data alone. Its frames ride the control channel, its room keeps no checkpoint.
    const own = this.roomOf(session);
    if (own && own.version !== DEFAULT_VERSION) return super.start(session);
    const check = this.inspectManual(session);
    if (check.error) return check;
    const room = check.room, previous = this.manualPending.get(room.code);
    if (previous) { if (!previous.valid()) previous.abort(); return previous.promise; }
    const stamp = roomStamp(room), identities = [...room.activeHumans(), ...room.spectators].map(s => this.registry.byId(s.playerId));
    if (identities.some(s => !s || s.roomCode !== room.code) || room.activeHumans().some(s => !this.isOnline(this.registry.byId(s.playerId)))) return fail(ERR.NOT_READY);
    const sessionKeys = identities.map(s => s.limitKey || null);
    const clientVersions = identities.map(s => s.playerCapacityVersion);
    let plan;
    const valid = () => {
      try {
        if (this.clusterClosed || this.manualPending.get(room.code) !== plan || this.now() >= plan.deadline
          || this.rooms.get(room.code) !== room || room.match || !isDeepStrictEqual(roomStamp(room), stamp)) return false;
        if (!identities.every((s, i) => this.registry.byId(s.playerId) === s && s.roomCode === room.code && (s.limitKey || null) === sessionKeys[i]
          && s.playerCapacityVersion === clientVersions[i]) || !this.capacityClients(room)) return false;
        if (!plan.dto.seats.filter(s => !s.isBot).every(seat => this.isOnline(this.registry.byId(seat.playerId))
          && isDeepStrictEqual(this.registry.byId(seat.playerId)?.loadout || null, seat.loadout)
          && isDeepStrictEqual(this.registry.byId(seat.playerId)?.ops || null, seat.ops)
          && isDeepStrictEqual(this.registry.byId(seat.playerId)?.notOwned || null, seat.notOwned)
          && isDeepStrictEqual(this.registry.byId(seat.playerId)?.diy || null, seat.diy)
          && isDeepStrictEqual(this.registry.byId(seat.playerId)?.skins || {}, seat.skins))) return false;
        const current = this.inspectManual(session);
        return !current.error && current.room === room && current.key === check.key
          && isDeepStrictEqual(current.keys, check.keys) && isDeepStrictEqual(matchDTO(room, plan.dto.seed, this.opts.snapshotHz), plan.dto);
      } catch { return false; }
    };
    plan = this.newPlan(room, new Set(), identities, check.key, check.keys, valid);
    plan.deadline = this.now() + this.queue.allocationMs;
    this.manualPending.set(room.code, plan);
    plan.timer = setTimeout(() => plan.abort(), this.queue.allocationMs); plan.timer.unref?.();
    plan.promise = (async () => {
      try { await this.preparePlan(plan); this.commitPlan(plan); this.publishPlan(plan); return OK; }
      catch (error) { plan.abort(); this.logStartFailure('manual', room, plan, error); return fail(startError(error)); }
      finally {
        clearTimeout(plan.timer); plan.detach();
        if (this.manualPending.get(room.code) === plan) this.manualPending.delete(room.code);
      }
    })();
    return plan.promise;
  }

  commitPlan(plan) {
    const t0 = this.metrics.start();
    try { return this.commitPlanNow(plan); } finally { this.metrics.end('match.commit', t0); }
  }

  commitPlanNow(plan) {
    if (plan.aborted || plan.transferred || !plan.valid()) invalid();
    plan.local = {
      room: Object.fromEntries(['match', 'matchCtx', 'matchCount', 'matchKey', 'matchKeys', 'revivalLocked', 'replay'].map(key => [key, plan.room[key]])),
      hostReady: plan.room.seatOf(plan.room.hostId)?.ready,
      old: [...plan.oldRooms].map(room => ({ room, disposed: room.disposed, replay: room.replay })),
      sessions: [...plan.sessions, ...plan.room.spectators.map(s => this.registry.byId(s.playerId))]
        .filter((s, i, all) => s && all.indexOf(s) === i).map(session => ({ session, roomCode: session.roomCode, notice: session.notice, pendingResult: session.pendingResult })),
    };
    try {
      synchronous(plan.handle.commit()); plan.remoteCommitted = true;
      this.preparedByRoom.set(plan.room.code, plan);
      const seedFn = this.seedFn;
      let result;
      try { this.seedFn = () => plan.dto.seed; result = super.startMatch(plan.room, plan.key, plan.keys, { deferPublish: true }); }
      finally { this.seedFn = seedFn; if (this.preparedByRoom.get(plan.room.code) === plan) this.preparedByRoom.delete(plan.room.code); }
      if (result.error || plan.aborted || !plan.proxy) invalid(ERR.INTERNAL);
      plan.ctx = plan.room.matchCtx; plan.basePublish = result.publish;
      plan.transferred = true; // Set before the first membership write, so partial transfer is compensable.
      for (const old of plan.oldRooms) { old.disposed = true; old.replay = null; this.rooms.delete(old.code); }
      if (plan.oldRooms.size || this.rooms.get(plan.room.code) !== plan.room) this.rooms.set(plan.room.code, plan.room);
      for (const saved of plan.local.sessions) { saved.session.roomCode = plan.room.code; saved.session.notice = null; saved.session.pendingResult = null; }
      return OK;
    } catch (error) { plan.abort(); throw error; }
  }

  rollbackPlan(plan) {
    if (!plan.local || plan.rollbackDone || plan.published) return;
    plan.rollbackDone = true;
    const room = plan.room;
    if (room.match === plan.proxy && room.matchCtx) this.disposeMatchCtx(room.matchCtx);
    if (room.match === plan.proxy || !room.match) {
      Object.assign(room, plan.local.room);
      const host = room.seatOf(room.hostId); if (host) host.ready = plan.local.hostReady;
    }
    if (!plan.transferred) return;
    const ownsRoom = this.rooms.get(room.code) === room;
    if (plan.oldRooms.size && ownsRoom) this.rooms.delete(room.code);
    for (const saved of plan.local.sessions) {
      if (this.registry.byId(saved.session.playerId) !== saved.session || saved.session.roomCode !== room.code || !ownsRoom) continue;
      Object.assign(saved.session, { roomCode: saved.roomCode, notice: saved.notice, pendingResult: saved.pendingResult });
    }
    for (const saved of plan.local.old) {
      if (this.rooms.has(saved.room.code)) continue; // Never overwrite a new room incarnation.
      saved.room.disposed = saved.disposed; saved.room.replay = saved.replay;
      // A permanent departure during a reentrant commit must not be resurrected.
      saved.room.seats = saved.room.seats.map(seat => seat && !seat.isBot && this.registry.byId(seat.playerId)?.roomCode !== saved.room.code ? null : seat);
      saved.room.spectators = saved.room.spectators.filter(s => this.registry.byId(s.playerId)?.roomCode === saved.room.code);
      if (!saved.room.seatOf(saved.room.hostId)) this.migrateHost(saved.room);
      if (saved.room.activeHumans().length) this.rooms.set(saved.room.code, saved.room);
    }
  }

  publishPlan(plan) {
    const t0 = this.metrics.start();
    try { return this.publishPlanNow(plan); } finally { this.metrics.end('match.publish', t0); }
  }

  publishPlanNow(plan) {
    if (plan.aborted || !plan.transferred || plan.published || plan.room.match !== plan.proxy) invalid(ERR.INTERNAL);
    // Both publishers are synchronous/nonthrowing by contract. Once publication
    // starts it cannot be un-sent; transport loss is not a fabricated end receipt.
    plan.basePublish(); // room.state(inMatch) first; no battle frames pass through this proxy.
    synchronous(plan.handle.publish()); // Then let the ingress release node startup frames.
    plan.published = true; plan.detach(); clearTimeout(plan.timer);
    this.assignments.set(plan.spec.assignmentId, plan);
    // Bind only after committed membership and successful publication. The exact ctx pins the remote proxy/assignment.
    this.bindSpectatorAliases(plan.oldRooms, plan.room);
    // Clear old timers only at final publication, never during rollback-capable commit.
    for (const old of plan.oldRooms) for (const s of [...old.activeHumans(), ...old.spectators]) { this.clearGrace(s.playerId); this.clearResync(s.playerId); }
    return OK;
  }

  releasePlan(plan) {
    if (plan.release) return plan.release;
    if (this.assignments.get(plan.spec.assignmentId) === plan) this.assignments.delete(plan.spec.assignmentId);
    try { plan.release = quiet(this.platform.release(plan.spec.assignmentId)); } catch { plan.release = Promise.resolve(false); }
    return plan.release;
  }

  /**
   * Trusted coordinator receipt adapter ONLY.
   * The adapter must authenticate the node and translate actorGeneration to the
   * platform's node generation. Accept only this room/assignment's end/replay DTO,
   * never battle snapshots/events or an invented success/termination receipt.
   */
  receiveEnd(assignmentId, receipt) {
    const plan = this.assignments.get(assignmentId);
    try {
      if (!plan || plan.proxy.ended || !plain(receipt) || receipt.assignmentId !== assignmentId || receipt.roomCode !== plan.room.code
        || receipt.generation !== plan.handle.generation || !plain(receipt.results)
        || Object.keys(receipt).some(key => !['assignmentId', 'roomCode', 'generation', 'lastPublic', 'results', 'summary'].includes(key))) return false;
      if (receipt.lastPublic != null && (!plain(receipt.lastPublic) || receipt.lastPublic.t !== 'm.public')) return false;
      const members = this.endMembers(plan);
      const frames = new Map();
      for (const [id, result] of Object.entries(receipt.results)) {
        if (!members.has(id) || !plain(result) || result.t !== 'm.result') return false;
        const frame = encode(result); if (frame == null) return false; frames.set(id, frame);
      }
      const publicFrame = receipt.lastPublic == null ? null : encode(receipt.lastPublic);
      if (receipt.lastPublic != null && publicFrame == null) return false;
      const summary = structuredClone(receipt.summary ?? null);
      return this.finishEnd(plan, assignmentId, frames, publicFrame, summary, JSON.stringify(summary));
    } catch { return false; }
  }

  /**
   * receiveEnd for the receipt sink's single parse (receipt-codec.js encodeReceipt output): `summary`, `lastPublic`
   * and each `results` entry are the JSON texts of an already shape-checked receipt. Same membership, size, order
   * and replay rules as receiveEnd; the frames are forwarded and replayed as these exact texts.
   * @param {string} assignmentId
   * @param {{ assignmentId: string, roomCode: string, generation: string, summary: string, lastPublic: string | null,
   *   results: [string, string][] }} receipt
   */
  receiveEncodedEnd(assignmentId, receipt) {
    const plan = this.assignments.get(assignmentId);
    try {
      if (!plan || plan.proxy.ended || !plain(receipt) || receipt.assignmentId !== assignmentId || receipt.roomCode !== plan.room.code
        || receipt.generation !== plan.handle.generation || !Array.isArray(receipt.results) || typeof receipt.summary !== 'string'
        || (receipt.lastPublic !== null && typeof receipt.lastPublic !== 'string')
        || Object.keys(receipt).some(key => !['assignmentId', 'roomCode', 'generation', 'lastPublic', 'results', 'summary'].includes(key))) return false;
      const members = this.endMembers(plan);
      const frames = new Map();
      for (const entry of receipt.results) {
        if (!Array.isArray(entry) || entry.length !== 2 || !members.has(entry[0]) || typeof entry[1] !== 'string' || frames.has(entry[0])) return false;
        frames.set(entry[0], entry[1]);
      }
      return this.finishEnd(plan, assignmentId, frames, receipt.lastPublic, JSON.parse(receipt.summary), receipt.summary);
    } catch { return false; }
  }

  /**
   * Trusted node event ONLY (receipt sink member.removed: authenticated, node / actor epochs checked): the assignment's
   * Match removed a player (the AFK rule). The player's m.removed (withheld from the game stream, GameHost._publish) goes
   * out on its ordered control path first, then the seat departs like a g.leave (matchRemoved → removeMember →
   * proxy.onLeave: revoke, then the node's leave, which finds the member gone). @returns {boolean} applied / nothing left
   */
  receiveRemoved(assignmentId, playerId, reason, rounds) {
    const plan = this.assignments.get(assignmentId);
    if (!plan || plan.proxy.ended || this.rooms.get(plan.room.code) !== plan.room || plan.room.matchCtx !== plan.ctx
      || plan.room.disposed) return false;
    const seat = plan.room.seatOf(playerId);
    if (!seat || seat.isBot || seat.left) return true; // already departed (a g.leave crossed it, or a retry)
    const session = this.registry.byId(playerId);
    if (session?.connected && session.roomCode === plan.room.code) sendSession(session, { t: 'm.removed', reason, rounds });
    this.matchRemoved(plan.room, playerId, reason);
    return true;
  }

  endMembers(plan) {
    return new Set([...plan.spec.seats.filter(s => !s.isBot).map(s => s.playerId), ...plan.spec.spectators, ...plan.proxy.members]);
  }

  /** Common end of both receipt forms: frames are encoded m.result texts by member, publicFrame the final m.public. */
  finishEnd(plan, assignmentId, frames, publicFrame, summary, summaryText) {
    const bytes = [...frames.values()].reduce((n, frame) => n + Buffer.byteLength(frame), Buffer.byteLength(publicFrame || ''));
    if (bytes > 2 * 1024 * 1024) return false;
    if (bytes + Buffer.byteLength(summaryText) > 2 * 1024 * 1024) return false;
    if (this.rooms.get(plan.room.code) === plan.room && plan.room.matchCtx === plan.ctx && plan.ctx.live && !plan.room.disposed) {
      const liveMembers = [...plan.proxy.members].filter(id => {
        const session = this.registry.byId(id), seat = plan.room.seatOf(id), observer = plan.room.spectatorOf(id);
        return session?.roomCode === plan.room.code && ((seat && !seat.isBot && !seat.left) || observer);
      });
      // These per-member terminal frames, the following room.state, and the
      // terminate marker share ONE ordered control WS. No wait/delay can make
      // two independent game/control connections correctly ordered.
      if (this.platform.deliverEnd(assignmentId, { lastPublic: publicFrame, results: frames }, liveMembers) !== true) return false;
      plan.proxy.ended = true;
      plan.ctx.lastPublic = publicFrame; plan.ctx.results = frames;
      plan.proxy.opts.onEnd(summary);
    } else {
      plan.proxy.ended = true;
      this.releasePlan(plan); // Real end of an already-left room; no replay into a new incarnation.
    }
    return true;
  }

  loadout(session, message) {
    const match = this.roomOf(session)?.match, before = match?.loadoutSequence;
    const result = super.loadout(session, message);
    if (result.error || !(match instanceof PreparedRemoteMatch) || match.loadoutSequence === before) return result;
    return match.lastLoadout; // Preserve the remote INFO_CHECK acknowledgement, not a fabricated local OK.
  }
  skins(session, message) {
    const match = this.roomOf(session)?.match, before = match?.skinsSequence;
    const result = super.skins(session, message);
    if (result.error || !(match instanceof PreparedRemoteMatch) || match.skinsSequence === before) return result;
    return match.lastSkins; // Only the owning game actor can acknowledge an INFO_CHECK edit.
  }
  leave(session) {
    const match = this.roomOf(session)?.match, before = match?.mutationSequence;
    const result = super.leave(session);
    return !result.error && match instanceof PreparedRemoteMatch && match.mutationSequence !== before ? match.lastMutation : result;
  }
  removeSpectator(session, message) {
    const match = this.roomOf(session)?.match, before = match?.mutationSequence;
    const result = super.removeSpectator(session, message);
    return !result.error && match instanceof PreparedRemoteMatch && match.mutationSequence !== before ? match.lastMutation : result;
  }
  spectate(session, message) {
    const room = this.spectatorRoom(message.code), match = room?.match, before = match?.mutationSequence;
    if (match instanceof PreparedRemoteMatch && match.pendingSpectatorRemovals.has(session.playerId)) return fail(ERR.WRONG_PHASE);
    if (match instanceof PreparedRemoteMatch && session.roomCode === room.code && match.pendingSpectators.has(session.playerId)) {
      return match.pendingSpectators.get(session.playerId);
    }
    const result = super.spectate(session, message);
    if (result.error || !(match instanceof PreparedRemoteMatch) || match.mutationSequence === before) return result;
    const observer = room.spectatorOf(session.playerId);
    return match.lastMutation.then(ack => {
      if (ack.error && this.rooms.get(room.code) === room && room.match === match && session.roomCode === room.code
        && room.spectatorOf(session.playerId) === observer) {
        room.spectators.splice(room.spectators.indexOf(observer), 1); session.roomCode = null;
        this.broadcastState(room);
      }
      return ack;
    });
  }
  /**
   * The lobby document's reference of a room's running remote match (server/persist/lobbyState.js; docs/DEPLOY.md
   * 「断点续玩」): its assignment — node and epochs, to take it over where it still runs — and its assignment DTO, to have
   * a node rebuild it from its checkpoint. A match still being placed after a restart keeps the reference it came with.
   */
  remoteMatchRef(room) {
    const plan = room.match instanceof PreparedRemoteMatch ? room.match.plan : null;
    if (!plan || plan.aborted || room.matchCtx !== plan.ctx || plan.proxy.ended) return null;
    if (plan.restoring && !plan.published) return plan.restoreRef;
    if (!plan.published || !plan.handle) return null;
    const info = this.platform.assignmentInfo?.(plan.spec.assignmentId);
    const { assignmentId, build, protocol, ...dto } = plan.spec;
    return { kind: 'remote', assignmentId, nodeId: plan.handle.nodeId, nodeGeneration: plan.handle.generation,
      actorGeneration: info?.actorGeneration ?? null, matchNo: plan.dto.matchNo, spec: structuredClone(dto) };
  }

  /** What identifies a room's remote match reference (the persister rewrites the room's record when it changes). */
  remoteMatchKey(room) {
    const plan = room.match instanceof PreparedRemoteMatch ? room.match.plan : null;
    return plan ? `${plan.spec.assignmentId}|${plan.handle?.generation ?? ''}|${plan.published}|${plan.aborted}|${plan.proxy.ended}` : null;
  }

  /**
   * A remote match back after a coordinator restart (server/persist/persister.js): the room holds it at once (inMatch;
   * its players' game input waits), and in the background it is taken over where it still runs (adopt — its node did
   * not restart) or rebuilt by a node from its checkpoint, retried while no node is ready yet (RESTORE_WAIT_MS). Then
   * every member already back gets its game channel (resume); the others bind as they return. A match that cannot
   * come back closes its room ('node-restarted'). `departed`: seats that leave it once it is back; they, and any seat or
   * observer gone while it is being placed, claim nothing for it (placeRestored).
   * @returns {boolean} accepted (a malformed reference is refused at once)
   */
  restoreRemoteMatch(room, ref, departed = []) {
    if (ref?.kind !== 'remote' || !safeId(ref.assignmentId) || !plain(ref.spec) || !Number.isSafeInteger(ref.spec.matchNo)) return false;
    const dto = { ...structuredClone(ref.spec), spectators: room.spectators.map(s => s.playerId) };
    const ctx = { live: true, ended: false, disposed: false, match: null, lastPublic: null, sharedResult: null, results: new Map() };
    const plan = { room, oldRooms: new Set(), sessions: [], key: room.matchKey, keys: room.matchKeys, dto, controller: new AbortController(),
      startedAt: this.now(), aborted: false, published: false, remoteCommitted: false, transferred: true, rollbackDone: true,
      handle: null, remoteCleanup: null, proxy: null, ctx, basePublish: null, release: null, restoring: true, restoreRef: ref,
      spec: structuredClone({ assignmentId: ref.assignmentId, build: this.platform.build, protocol: this.platform.protocol, ...dto }) };
    plan.valid = () => !this.clusterClosed && !plan.aborted && this.rooms.get(room.code) === room && room.match === plan.proxy && !room.disposed;
    plan.detach = () => {};
    plan.abort = () => {
      plan.aborted = true;
      if (!plan.controller.signal.aborted) plan.controller.abort();
      if (plan.handle && !plan.remoteCleanup) plan.remoteCleanup = quiet(plan.handle.abort());
      return plan.remoteCleanup || Promise.resolve(false);
    };
    plan.proxy = new PreparedRemoteMatch(this, plan, { ...dto, onEnd: summary => this.onMatchEnd(room, ctx, summary) });
    plan.proxy.started = true;
    ctx.match = plan.proxy;
    room.match = plan.proxy;
    room.matchCtx = ctx;
    room.matchCount = dto.matchNo;
    room.revivalLocked = Object.freeze(room.revivalState());
    room.replay = null;
    this.restoreStats.pending++;
    plan.restorePromise = this.placeRestored(plan, ref, departed).finally(() => { this.restoreStats.pending--; });
    return true;
  }

  async placeRestored(plan, ref, departed) {
    const { room } = plan, deadline = this.now() + RESTORE_WAIT_MS;
    let adopt = safeId(ref.nodeId) && safeId(ref.nodeGeneration) ? { nodeId: ref.nodeId, nodeGeneration: ref.nodeGeneration } : null;
    let handle = null, failure = null;
    while (!handle && plan.valid()) {
      // taken over: the same assignment; rebuilt: a new one from the old one's checkpoint (platform.restore). A departed
      // seat keeps its place in the roster but not its session (it may be in another match by now), and only the room's
      // current observers come with it: the directory's one assignment per session.
      const spec = { ...structuredClone(plan.spec), spectators: room.spectators.map(s => s.playerId),
        assignmentId: adopt ? ref.assignmentId : randomBytes(16).toString('hex') };
      try {
        handle = await this.platform.restore(spec, { adopt, checkpointId: ref.assignmentId, departed: this.restoredDeparted(room, spec, departed) });
        plan.spec = spec;
      } catch (error) {
        const code = error?.code;
        // the node that ran it restarted (or the actor is gone): rebuild it from its checkpoint instead
        if (adopt && ['STALE_ASSIGNMENT', 'NO_NODE', 'NOT_MEMBER', 'WRONG_PHASE'].includes(code)) { adopt = null; continue; }
        if (!RESTORE_RETRY.has(code) || this.now() >= deadline) { failure = code || 'INTERNAL'; break; }
        await new Promise(resolve => { const t = setTimeout(resolve, RESTORE_RETRY_MS); t.unref?.(); });
      }
    }
    if (handle && !plan.valid()) { quiet(handle.abort()); handle = null; failure ??= 'GONE'; }
    if (!handle) {
      this.restoreStats.failed++;
      this.log.warn(`[lobby] ${room.code} restored match not placed (${failure || 'gone'})`);
      if (plan.valid()) this.disposeRoom(room, 'node-restarted');
      return false;
    }
    plan.handle = handle; plan.remoteCommitted = true; plan.published = true;
    this.assignments.set(plan.spec.assignmentId, plan);
    this.restoreStats[handle.adopted ? 'adopted' : 'rebuilt']++;
    this.log.info(`[lobby] ${room.code} match #${room.matchCount} ${handle.adopted ? 'taken over' : 'restored'} on ${handle.nodeId}`);
    // its node still has them as of the checkpoint: every departed seat leaves (the node's leave finds a member already
    // gone), and an observer who went while it was being placed is removed
    for (const id of this.restoredDeparted(room, plan.spec, departed)) plan.proxy.onLeave(id);
    for (const id of plan.spec.spectators) if (!room.spectatorOf(id)) plan.proxy.removeSpectator(id);
    if (room.disposed || room.match !== plan.proxy) return true;
    // the members already back get their game channel now; the others when they return (onReconnect → resume)
    for (const id of plan.proxy.members) {
      const session = this.registry.byId(id);
      if (this.isOnline(session) && session.roomCode === room.code) plan.proxy.onReconnect(id);
    }
    this.broadcastState(room);
    return true;
  }

  /** A restored match's human seats that are no longer in it: departed before the restart, or since. */
  restoredDeparted(room, spec, departed) {
    const active = new Set(room.activeHumans().map(s => s.playerId));
    return spec.seats.filter(s => !s.isBot && (departed.includes(s.playerId) || !active.has(s.playerId))).map(s => s.playerId);
  }

  /**
   * A published match whose node restarted or was lost (RemoteGamePlatform onUnavailable): with checkpoints on, a node
   * rebuilds it from its last checkpoint instead of the room closing (restoreRemoteMatch, no take-over). @returns
   * {boolean} it is being placed again (false: the caller closes the room as before)
   */
  recoverRemote(room, plan) {
    if (!this.checkpointsOn || this.clusterClosed || room.disposed || room.match !== plan.proxy || plan.restoring && !plan.published) return false;
    const ref = this.remoteMatchRef(room);
    if (!ref) return false;
    this.assignments.delete(plan.spec.assignmentId);
    plan.proxy.ended = true; // the old actor is gone: neither a late receipt nor its release touch this room again
    const old = room.matchCtx;
    room.match = null; room.matchCtx = null;
    if (old) this.disposeMatchCtx(old);
    const departed = room.seats.filter(s => s && !s.isBot && s.left).map(s => s.playerId);
    if (this.restoreRemoteMatch(room, { ...ref, nodeId: null, nodeGeneration: null }, departed)) {
      this.log.warn(`[lobby] ${room.code} game node lost: placing match #${room.matchCount} again from its checkpoint`);
      return true;
    }
    return false;
  }

  cancelManual(room) { this.manualPending.get(room?.code)?.abort(); }
  onDisconnect(session) { this.cancelManual(this.roomOf(session)); return super.onDisconnect(session); }
  removeMember(room, playerId) { this.cancelManual(room); return super.removeMember(room, playerId); }
  disposeRoom(room, reason) { this.cancelManual(room); return super.disposeRoom(room, reason); }
  shutdown(reason) {
    this.clusterClosed = true;
    for (const plan of this.manualPending.values()) plan.abort();
    return super.shutdown(reason);
  }
}
