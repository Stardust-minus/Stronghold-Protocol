// Coordinator-owned room assignments. The game state stays on its original node;
// health expiry prevents new allocation, never silently migrates an existing match.
import { randomBytes } from 'node:crypto';
import { MAX_SEATS, ROOM_CODE_LEN } from '../../shared/constants.js';

const identifier = v => typeof v === 'string' && v.length > 0 && v.length <= 128 && /^[A-Za-z0-9_-][A-Za-z0-9_.:-]*(?![\s\S])/.test(v);
const integer = (v, min = 0) => Number.isSafeInteger(v) && v >= min;
const room = v => typeof v === 'string' && v.length === ROOM_CODE_LEN && /^[A-Z]+(?![\s\S])/.test(v);
const sameMembers = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

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
    const node = { nodeId, generation, build, protocol, capacity, ready: false, matches: 0, prepared: 0, committed: 0, heartbeatAt: null, selectedAt: 0 };
    this.nodes.set(nodeId, node);
    // Prepared work for a dead generation is compensatable; committed rooms stay
    // identifiable as lost until their owner is explicitly released.
    for (const assignment of [...this.assignments.values()]) {
      if (assignment.nodeId === nodeId && assignment.generation !== generation && assignment.state === 'prepared') this.abort(assignment.assignmentId);
    }
    return this.nodeView(node);
  }

  heartbeat(nodeId, { generation, ready, matches }) {
    const node = this.nodes.get(nodeId);
    if (!node || node.generation !== generation) return false;
    if (typeof ready !== 'boolean' || !integer(matches)) throw new TypeError('invalid game heartbeat');
    node.ready = ready;
    node.matches = matches;
    node.heartbeatAt = this.time();
    return true;
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

  prepare({ roomCode, sessionIds, build, protocol, assignmentId = randomBytes(16).toString('hex') }) {
    if (!room(roomCode) || !identifier(build) || !identifier(assignmentId) || !integer(protocol, 1)
      || !Array.isArray(sessionIds) || sessionIds.length < 1 || sessionIds.length > MAX_SEATS
      || !sessionIds.every(identifier) || new Set(sessionIds).size !== sessionIds.length) throw new TypeError('invalid assignment');
    const now = this.time();
    this.sweep(now);
    const previous = this.assignments.get(assignmentId);
    if (previous) {
      if (previous.roomCode !== roomCode || previous.build !== build || previous.protocol !== protocol || !sameMembers(previous.sessionIds, sessionIds)) {
        throw new AllocationError('ASSIGNMENT_CONFLICT');
      }
      return this.view(previous);
    }
    if (this.closed.has(assignmentId)) throw new AllocationError('STALE_ASSIGNMENT');
    if (this.rooms.has(roomCode)) throw new AllocationError('ROOM_BUSY');
    if (sessionIds.some(id => this.sessions.has(id))) throw new AllocationError('SESSION_BUSY');
    const candidates = [...this.nodes.values()].filter(node => this.usable(node, build, protocol, now));
    const loads = new Map(candidates.map(node => [node.nodeId, this.load(node)]));
    const available = candidates.filter(node => node.capacity === 0 || loads.get(node.nodeId) < node.capacity);
    available.sort((a, b) => loads.get(a.nodeId) - loads.get(b.nodeId) || a.selectedAt - b.selectedAt || a.nodeId.localeCompare(b.nodeId));
    const node = available[0];
    if (!node) throw new AllocationError('NO_NODE');
    const assignment = { assignmentId, roomCode, sessionIds: [...sessionIds], build, protocol, nodeId: node.nodeId,
      generation: node.generation, state: 'prepared', createdAt: now, expiresAt: now + this.prepareMs, spectators: new Set() };
    node.selectedAt = ++this.sequence;
    node.prepared++;
    this.assignments.set(assignmentId, assignment);
    this.pending.set(assignmentId, assignment);
    this.rooms.set(roomCode, assignmentId);
    for (const id of sessionIds) this.sessions.set(id, assignmentId);
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
