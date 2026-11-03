// Coordinator-owned room assignments. The game state stays on its original node;
// health expiry prevents new allocation, never silently migrates an existing match.
import { randomBytes } from 'node:crypto';
import { ROOM_CODE_LEN } from '../../shared/constants.js';
import { EXPERIMENTAL_DEFAULTS, experimentalOptions, sameExperimental } from '../../shared/experimental.js';
import { roomCapacity } from '../../shared/playerCapacity.js';

const identifier = v => typeof v === 'string' && v.length > 0 && v.length <= 128 && /^[A-Za-z0-9_-][A-Za-z0-9_.:-]*(?![\s\S])/.test(v);
const integer = (v, min = 0) => Number.isSafeInteger(v) && v >= min;
const room = v => typeof v === 'string' && v.length === ROOM_CODE_LEN && /^[A-Z]+(?![\s\S])/.test(v);
const sameMembers = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);
const versionId = v => typeof v === 'string' && v.length > 0 && v.length <= 64 && /^[A-Za-z0-9_@.-]+(?![\s\S])/.test(v);

/**
 * Another official version's match runs in a version host — a child process with that version's data and its own
 * combat Workers — on its game node (server/cluster/game-runtime.js). Placement weighs that host as this many matches
 * [ASSUMED, NOTES-ckpt.md]: a version match goes to a node that already runs its version's host unless that node is
 * busier than another by more than this, and a node running version hosts takes default matches as if it ran this many
 * more per host. A node runs at most its reported `versionHostLimit` hosts at once (a host with no match left does not
 * count: the node stops an idle one to make room).
 */
export const VERSION_HOST_WEIGHT = 4;

export class AllocationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AllocationError';
    this.code = code;
  }
}

export class ClusterDirectory {
  constructor({ now = Date.now, heartbeatMs = 30_000, prepareMs = 15_000, tombstoneMs = 60_000 } = {}) {
    if (typeof now !== 'function') throw new TypeError('invalid cluster clock');
    for (const [name, value] of Object.entries({ heartbeatMs, prepareMs, tombstoneMs })) {
      if (!integer(value, 1) || value > 300_000) throw new RangeError(`invalid ${name}`);
    }
    this.now = now;
    this.heartbeatMs = heartbeatMs;
    this.prepareMs = prepareMs;
    this.tombstoneMs = tombstoneMs;
    this.nodes = new Map();
    this.assignments = new Map();
    this.pending = new Map();
    this.rooms = new Map();
    this.sessions = new Map();
    this.closed = new Map();
    this.sequence = 0;
  }

  time() {
    const value = this.now();
    if (!integer(value)) throw new RangeError('invalid cluster clock value');
    return value;
  }

  register({ nodeId, generation, build, protocol, capacity = 0 }) {
    if (![nodeId, generation, build].every(identifier) || !integer(protocol, 1) || !integer(capacity)) {
      throw new TypeError('invalid game node');
    }
    const previous = this.nodes.get(nodeId);
    if (previous && previous.generation === generation) {
      if (previous.build !== build || previous.protocol !== protocol || previous.capacity !== capacity) throw new AllocationError('NODE_CONFLICT');
      return this.nodeView(previous);
    }
    const node = { nodeId, generation, build, protocol, capacity, ready: false, matches: 0, prepared: 0, committed: 0, heartbeatAt: null, selectedAt: 0,
      // the other official versions it can run, its version hosts' matches (heartbeat), the version assignments placed on it
      versions: new Set(), versionHosts: new Map(), versionHostLimit: 0, versionAssigned: new Map() };
    this.nodes.set(nodeId, node);
    // Prepared work for a dead generation is compensatable; committed rooms stay
    // identifiable as lost until their owner is explicitly released.
    for (const assignment of [...this.assignments.values()]) {
      if (assignment.nodeId === nodeId && assignment.generation !== generation && assignment.state === 'prepared') this.abort(assignment.assignmentId);
    }
    return this.nodeView(node);
  }

  heartbeat(nodeId, { generation, ready, matches, versions = [], versionHosts = [], versionHostLimit = 0 }) {
    const node = this.nodes.get(nodeId);
    if (!node || node.generation !== generation) return false;
    if (typeof ready !== 'boolean' || !integer(matches)) throw new TypeError('invalid game heartbeat');
    // a node of a release before rel26 reports none of these: it runs 第二期下半 alone
    const hosts = Array.isArray(versionHosts) ? versionHosts.filter(h => h && versionId(h.id) && integer(h.matches)).slice(0, 16) : [];
    node.versions = new Set(Array.isArray(versions) ? versions.filter(versionId).slice(0, 16) : []);
    node.versionHosts = new Map(hosts.map(h => [h.id, h.matches]));
    node.versionHostLimit = integer(versionHostLimit) ? Math.min(versionHostLimit, 16) : 0;
    node.ready = ready;
    node.matches = matches;
    node.heartbeatAt = this.time();
    return true;
  }

  /** The versions whose host is busy on a node: reported with matches, or holding an assignment placed here. */
  busyVersions(node) {
    const busy = new Set([...node.versionHosts].filter(([, n]) => n > 0).map(([id]) => id));
    for (const [id, n] of node.versionAssigned) if (n > 0) busy.add(id);
    return busy;
  }

  disable(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    node.ready = false;
    return true;
  }

  nodeView(node) {
    return Object.freeze({ nodeId: node.nodeId, generation: node.generation, build: node.build, protocol: node.protocol,
      capacity: node.capacity, ready: node.ready, matches: node.matches, heartbeatAt: node.heartbeatAt });
  }

  usable(node, build, protocol, now) {
    return node.ready && node.build === build && node.protocol === protocol && node.heartbeatAt !== null
      && now >= node.heartbeatAt && now - node.heartbeatAt < this.heartbeatMs;
  }

  load(node) {
    // Allocation only scans nodes, not all live rooms. Heartbeats can lag commits;
    // the reported and coordinator-owned running counts must not be added twice.
    return Math.max(node.committed, node.matches) + node.prepared;
  }

  /**
   * Reserve a node for an assignment: the least loaded usable one, or — `nodeId` (a restored match taken over where it
   * still runs, server/cluster/platform.js restore) — exactly that node when it is usable (NO_NODE otherwise).
   * `departed`: roster seats a restored match no longer holds (they left it before the restart, as detachPlayer did):
   * they stay in its roster but claim no session — that session may already belong to another assignment.
   */
  prepare({ roomCode, sessionIds, build, protocol, mode = 'coop', experimental = EXPERIMENTAL_DEFAULTS, assignmentId = randomBytes(16).toString('hex'), nodeId = null,
    departed = [], version = null }) {
    // Explicit coordinator admission: validate the approved room policy, not a
    // caller-supplied bare capacity. Bind that immutable policy to this nonce.
    const options = experimentalOptions(experimental), capacity = roomCapacity(mode, options);
    if (!['solo', 'coop'].includes(mode) || !room(roomCode) || !identifier(build) || !identifier(assignmentId) || !integer(protocol, 1)
      || !Array.isArray(sessionIds) || sessionIds.length < 1 || sessionIds.length > capacity
      || !sessionIds.every(identifier) || new Set(sessionIds).size !== sessionIds.length
      || !Array.isArray(departed) || !departed.every(id => sessionIds.includes(id)) || new Set(departed).size >= sessionIds.length
      || (version !== null && !versionId(version))) throw new TypeError('invalid assignment');
    const claimed = sessionIds.filter(id => !departed.includes(id));
    const now = this.time();
    this.sweep(now);
    const previous = this.assignments.get(assignmentId);
    if (previous) {
      if (previous.roomCode !== roomCode || previous.build !== build || previous.protocol !== protocol
        || previous.mode !== mode || !sameExperimental(previous.experimental, options) || !sameMembers(previous.sessionIds, sessionIds)) {
        throw new AllocationError('ASSIGNMENT_CONFLICT');
      }
      return this.view(previous);
    }
    if (this.closed.has(assignmentId)) throw new AllocationError('STALE_ASSIGNMENT');
    if (this.rooms.has(roomCode)) throw new AllocationError('ROOM_BUSY');
    if (claimed.some(id => this.sessions.has(id))) throw new AllocationError('SESSION_BUSY');
    // another official version (VERSION_HOST_WEIGHT): only nodes that run it, and have room for its host (a match taken
    // over where it runs is exempt: it is there)
    const candidates = [...this.nodes.values()].filter(node => this.usable(node, build, protocol, now) && (nodeId === null || node.nodeId === nodeId)
      && (version === null || nodeId !== null || (node.versions.has(version)
        && (this.busyVersions(node).has(version) || this.busyVersions(node).size < node.versionHostLimit))));
    const loads = new Map(candidates.map(node => [node.nodeId, this.load(node)]));
    // (a match taken over where it runs is already part of that node's load)
    const available = candidates.filter(node => nodeId !== null || node.capacity === 0 || loads.get(node.nodeId) < node.capacity);
    const score = new Map(available.map(node => {
      const busy = this.busyVersions(node);
      return [node.nodeId, loads.get(node.nodeId) + (version === null ? VERSION_HOST_WEIGHT * busy.size : busy.has(version) ? 0 : VERSION_HOST_WEIGHT)];
    }));
    available.sort((a, b) => score.get(a.nodeId) - score.get(b.nodeId) || a.selectedAt - b.selectedAt || a.nodeId.localeCompare(b.nodeId));
    const node = available[0];
    if (!node) throw new AllocationError('NO_NODE');
    const assignment = { assignmentId, roomCode, sessionIds: [...sessionIds], build, protocol, mode, experimental: options, nodeId: node.nodeId,
      generation: node.generation, state: 'prepared', createdAt: now, expiresAt: now + this.prepareMs, spectators: new Set(), version };
    node.selectedAt = ++this.sequence;
    node.prepared++;
    if (version !== null) node.versionAssigned.set(version, (node.versionAssigned.get(version) ?? 0) + 1);
    this.assignments.set(assignmentId, assignment);
    this.pending.set(assignmentId, assignment);
    this.rooms.set(roomCode, assignmentId);
    for (const id of claimed) this.sessions.set(id, assignmentId);
    return this.view(assignment);
  }

  commit(assignmentId) {
    this.sweep();
    const assignment = this.assignments.get(assignmentId);
    if (!assignment) throw new AllocationError('STALE_ASSIGNMENT');
    if (assignment.state === 'committed') return this.view(assignment);
    const node = this.nodes.get(assignment.nodeId);
    if (!node || node.generation !== assignment.generation || !this.usable(node, assignment.build, assignment.protocol, this.time())) {
      this.abort(assignmentId);
      throw new AllocationError('NODE_UNAVAILABLE');
    }
    node.prepared--;
    node.committed++;
    assignment.state = 'committed';
    this.pending.delete(assignmentId);
    assignment.expiresAt = null;
    return this.view(assignment);
  }

  attachSpectator(assignmentId, sessionId) {
    if (!identifier(sessionId)) throw new TypeError('invalid spectator');
    const assignment = this.assignments.get(assignmentId);
    if (!assignment || assignment.state !== 'committed' || !this.ownerAvailable(assignment)) throw new AllocationError('STALE_ASSIGNMENT');
    const current = this.sessions.get(sessionId);
    if (current && current !== assignmentId) throw new AllocationError('SESSION_BUSY');
    if (assignment.sessionIds.includes(sessionId)) throw new AllocationError('ROLE_CONFLICT');
    assignment.spectators.add(sessionId);
    this.sessions.set(sessionId, assignmentId);
    return this.view(assignment);
  }

  /** An AI seat became a session's (ClusterLobby.transferRemoteSeat): one of the assignment's players from now on. */
  attachPlayer(assignmentId, sessionId) {
    if (!identifier(sessionId)) throw new TypeError('invalid player');
    const assignment = this.assignments.get(assignmentId);
    if (!assignment || assignment.state !== 'committed') throw new AllocationError('STALE_ASSIGNMENT');
    const current = this.sessions.get(sessionId);
    if (current && current !== assignmentId) throw new AllocationError('SESSION_BUSY');
    if (!assignment.sessionIds.includes(sessionId)) assignment.sessionIds.push(sessionId);
    this.sessions.set(sessionId, assignmentId);
    return this.view(assignment);
  }

  detachSpectator(assignmentId, sessionId) {
    const assignment = this.assignments.get(assignmentId);
    if (!assignment?.spectators.delete(sessionId)) return false;
    if (this.sessions.get(sessionId) === assignmentId) this.sessions.delete(sessionId);
    return true;
  }

  detachPlayer(assignmentId, sessionId) {
    const assignment = this.assignments.get(assignmentId);
    if (!assignment || assignment.state !== 'committed' || !assignment.sessionIds.includes(sessionId)
      || this.sessions.get(sessionId) !== assignmentId) return false;
    // Keep the original seat roster for the assignment's audit/idempotency key.
    // Release only this identity, never the remaining teammates' room owner.
    this.sessions.delete(sessionId);
    return true;
  }

  abort(assignmentId) {
    const assignment = this.assignments.get(assignmentId);
    if (!assignment || assignment.state !== 'prepared') return false;
    this.remove(assignment);
    return true;
  }

  release(assignmentId) {
    const assignment = this.assignments.get(assignmentId);
    if (!assignment) return false;
    this.remove(assignment);
    return true;
  }

  remove(assignment) {
    const node = this.nodes.get(assignment.nodeId);
    if (node?.generation === assignment.generation) {
      if (assignment.state === 'prepared') node.prepared--;
      else node.committed--;
      if (assignment.version) node.versionAssigned.set(assignment.version, Math.max(0, (node.versionAssigned.get(assignment.version) ?? 0) - 1));
    }
    this.assignments.delete(assignment.assignmentId);
    this.pending.delete(assignment.assignmentId);
    if (this.rooms.get(assignment.roomCode) === assignment.assignmentId) this.rooms.delete(assignment.roomCode);
    for (const id of [...assignment.sessionIds, ...assignment.spectators]) {
      if (this.sessions.get(id) === assignment.assignmentId) this.sessions.delete(id);
    }
    this.closed.set(assignment.assignmentId, this.time() + this.tombstoneMs);
  }

  ownerAvailable(assignment) {
    return this.nodes.get(assignment.nodeId)?.generation === assignment.generation;
  }

  view(assignment) {
    return Object.freeze({ assignmentId: assignment.assignmentId, roomCode: assignment.roomCode,
      sessionIds: Object.freeze([...assignment.sessionIds]), spectatorIds: Object.freeze([...assignment.spectators]),
      nodeId: assignment.nodeId, generation: assignment.generation, build: assignment.build, protocol: assignment.protocol,
      mode: assignment.mode, experimental: assignment.experimental, ...(assignment.version ? { version: assignment.version } : {}),
      state: assignment.state, createdAt: assignment.createdAt, expiresAt: assignment.expiresAt,
      ownerAvailable: this.ownerAvailable(assignment) });
  }

  byRoom(roomCode) {
    const assignment = this.assignments.get(this.rooms.get(roomCode));
    return assignment?.state === 'committed' ? this.view(assignment) : null;
  }

  bySession(sessionId) {
    const assignment = this.assignments.get(this.sessions.get(sessionId));
    return assignment?.state === 'committed' ? this.view(assignment) : null;
  }

  sweep(now = this.time()) {
    for (const assignment of [...this.pending.values()]) {
      if (assignment.expiresAt <= now) this.remove(assignment);
    }
    for (const [id, until] of this.closed) if (until <= now) this.closed.delete(id);
  }
}
