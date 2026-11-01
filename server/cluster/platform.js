// Low-rate coordinator adapter. It reserves one node per entire match, prepares
// player channels before start, and never carries battle snapshots/events.
// A node that comes back with a new generation (restart), or answers no status for
// nodeLostMs, cannot continue its published matches: they are retired at once through
// onUnavailable (NODE_RESTARTED / NODE_LOST) instead of staying "in match" forever. A
// release the lost node could not acknowledge is re-sent once it answers again with the
// same generation (a new generation has no such actor).
import { randomBytes, createHash } from 'node:crypto';
import { ClusterDirectory, AllocationError } from './directory.js';
import { createTicketAuthority } from './tickets.js';
import { createRpcAuthenticator, createRpcClient, PREPARE_MAX_BYTES } from './rpc.js';
import { normalizeClusterLoad, normalizeGameLoad, publicGameLabel, MAX_PUBLIC_GAME_NODES } from '../../shared/cluster-load.js';
import { copyAssignmentSpec, GameHostError } from './game-host.js';
import { NO_PHASES } from '../phaseMetrics.js';

const safeId = v => typeof v === 'string' && v.length > 0 && v.length <= 128 && /^[A-Za-z0-9_-][A-Za-z0-9_.:-]*(?![\s\S])/.test(v);
const cancelled = () => new AllocationError('CANCELLED');
// Releases a lost node could not acknowledge, kept per node until it answers again (bounded).
const MAX_ORPHANS = 1024;
const TRANSPORT_CODES = new Set(['TRANSPORT', 'TIMEOUT', 'BAD_REPLY', 'CLOSED']);
function pause(ms, signal) {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const finish = error => { clearTimeout(timer); signal.removeEventListener('abort', abort); if (error) reject(error); else resolve(); };
    const abort = () => finish(cancelled());
    const timer = setTimeout(() => finish(), ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export class RemoteGamePlatform {
  constructor({ nodes, build, protocol, sendControl, sendControlEncoded = null, sendControlParts = null, onUnavailable = () => {}, onPublished = () => {},
    requireStreamMarkers = false, now = Date.now, directory, allocationMs = 5000, pollMs = 50, loadTtlMs = 5000, nodeLostMs = 15_000,
    metrics = NO_PHASES }) {
    if (!Array.isArray(nodes) || !nodes.length || !safeId(build) || !Number.isSafeInteger(protocol) || protocol < 1
      || typeof sendControl !== 'function' || typeof onUnavailable !== 'function' || typeof onPublished !== 'function'
      || typeof requireStreamMarkers !== 'boolean' || typeof now !== 'function'
      || (sendControlEncoded !== null && typeof sendControlEncoded !== 'function')
      || (sendControlParts !== null && typeof sendControlParts !== 'function')) throw new TypeError('invalid game platform');
    if (!Number.isSafeInteger(allocationMs) || allocationMs < 1 || allocationMs > 6000
      || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1000
      || !Number.isSafeInteger(loadTtlMs) || loadTtlMs < 1 || loadTtlMs > 30_000
      || !Number.isSafeInteger(nodeLostMs) || nodeLostMs < 1 || nodeLostMs > 300_000) throw new RangeError('invalid allocation deadline');
    this.build = build;
    this.protocol = protocol;
    this.sendControl = sendControl;
    /** (sessionId, type, encodedFrame) → boolean: the same ordered control path for a frame already encoded */
    this.sendControlEncoded = sendControlEncoded;
    /** ([{ sessionId, prefix, suffix }], shared, type): member i gets prefix_i + shared + suffix_i on its control path */
    this.sendControlParts = sendControlParts;
    this.nodeLostMs = nodeLostMs;
    this.metrics = metrics;
    this.onUnavailable = onUnavailable;
    this.onPublished = onPublished;
    this.requireStreamMarkers = requireStreamMarkers;
    this.now = now;
    this.directory = directory || new ClusterDirectory({ now });
    this.allocationMs = allocationMs;
    this.pollMs = pollMs;
    this.loadTtlMs = loadTtlMs;
    this.nodes = new Map();
    this.contexts = new Map();
    this.closed = false;
    try {
      for (const node of nodes) {
        if (this.nodes.has(node.nodeId)) throw new TypeError('duplicate platform node');
        this.addNode(node);
      }
    } catch (e) { for (const node of this.nodes.values()) node.client.close(); throw e; }
  }

  nodeConfiguration(node) {
    if (!safeId(node?.nodeId) || !Buffer.isBuffer(node.key) || node.key.length < 32
      || !Number.isSafeInteger(node.capacity ?? 0) || (node.capacity ?? 0) < 0) throw new TypeError('invalid platform node');
    const url = node.url == null ? null : new URL(node.url);
    if (!node.client && !url || url && (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || !['/', '/_cluster/rpc'].includes(url.pathname))) throw new TypeError('invalid node control URL');
    const existing = this.nodes.get(node.nodeId);
    if (node.publicSlot !== undefined && publicGameLabel(node.publicSlot) === null) throw new TypeError('invalid public node slot');
    const slots = new Set([...this.nodes.values()].filter(peer => peer !== existing).map(peer => peer.publicSlot));
    let publicSlot = node.publicSlot ?? existing?.publicSlot ?? null;
    if (publicSlot === null && !existing) {
      // The diagnostics inventory is bounded, never the game-node/player count.
      for (let slot = 1; slot <= MAX_PUBLIC_GAME_NODES; slot++) if (!slots.has(slot)) { publicSlot = slot; break; }
    }
    if (publicSlot !== null && slots.has(publicSlot)) throw new TypeError('duplicate public node slot');
    const descriptor = { nodeId: node.nodeId, url: url?.toString() ?? null, capacity: node.capacity ?? 0, publicSlot,
      keyFingerprint: createHash('sha256').update(node.key).digest('hex') };
    if (existing && (existing.url !== descriptor.url || existing.capacity !== descriptor.capacity || existing.publicSlot !== descriptor.publicSlot
      || existing.keyFingerprint !== descriptor.keyFingerprint || node.client && node.client !== existing.client)) throw new AllocationError('NODE_CONFIG_CONFLICT');
    return descriptor;
  }

  addNode(node) {
    if (this.closed) throw new AllocationError('PLATFORM_CLOSED');
    const descriptor = this.nodeConfiguration(node);
    if (this.nodes.has(node.nodeId)) return false;
    const tickets = createTicketAuthority({ key: node.key, now: this.now });
    const client = node.client || createRpcClient({ url: node.url,
      authority: createRpcAuthenticator({ key: node.key, scope: node.nodeId, now: this.now }) });
    if (typeof client.call !== 'function' || typeof client.close !== 'function') throw new TypeError('invalid node transport');
    let addedAt = null;
    try { addedAt = this.now(); } catch { /* the loss deadline then starts at the first answer */ }
    this.nodes.set(node.nodeId, { ...descriptor, tickets, client, generation: null, answeredAt: null, addedAt, orphans: new Map(), releasingOrphans: false });
    // It remains ineligible until a fresh authenticated identity/health response.
    return true;
  }

  async refresh() {
    if (this.closed) throw new AllocationError('PLATFORM_CLOSED');
    await Promise.all([...this.nodes.values()].map(async node => {
      try {
        const status = await node.client.call('status', {});
        if (status.nodeId !== node.nodeId || !safeId(status.generation) || status.build !== this.build || status.protocol !== this.protocol
          || typeof status.ready !== 'boolean' || (this.requireStreamMarkers && (status.streamMarkers !== true || status.terminalControl !== true))
          || !Number.isSafeInteger(status.counts?.matches) || status.counts.matches < 0) throw new AllocationError('NODE_IDENTITY');
        this.directory.register({ nodeId: node.nodeId, generation: status.generation, build: this.build, protocol: this.protocol, capacity: node.capacity });
        const previous = node.generation;
        node.generation = status.generation;
        node.answeredAt = this.now();
        this.directory.heartbeat(node.nodeId, { generation: status.generation, ready: status.ready, matches: status.counts.matches });
        this.cacheLoad(node, status);
        if (previous !== null && previous !== status.generation) {
          // A new process: every actor of the old generation is gone, and so are its pending releases.
          node.orphans.clear();
          this.retireNode(node, 'NODE_RESTARTED');
        } else this.releaseOrphans(node);
      } catch {
        this.directory.disable(node.nodeId); this.cacheLoad(node, null);
        let at;
        try { at = this.now(); } catch { return; }
        const since = node.answeredAt ?? node.addedAt;
        if (Number.isSafeInteger(at) && Number.isSafeInteger(since) && at - since >= this.nodeLostMs) this.retireNode(node, 'NODE_LOST');
      }
    }));
  }

  /**
   * Retire the published matches this node can no longer run: a restarted node's old-generation actors, or every
   * actor of a node lost for nodeLostMs. The lobby closes the room (onUnavailable) BEFORE the release's terminate
   * markers, exactly as for a failed publication; no result is invented. Preparations fail on their own epochs.
   */
  retireNode(node, reason) {
    for (const ctx of [...this.contexts.values()]) {
      // A delivered terminal receipt already ended the room; its lobby release follows on its own.
      if (ctx.node !== node || ctx.state !== 'published' || ctx.retiring || ctx.terminal
        || (reason === 'NODE_RESTARTED' && ctx.generation === node.generation)) continue;
      ctx.retiring = true;
      void (async () => {
        try {
          await this.onUnavailable(Object.freeze({ assignmentId: ctx.spec.assignmentId, roomCode: ctx.spec.roomCode,
            nodeId: node.nodeId, reason }));
        } catch { /* the owner still gets the explicit release */ }
        await this.release(ctx.spec.assignmentId);
      })();
    }
  }

  /** Re-send releases a lost node missed, now that it answers with the same generation. */
  releaseOrphans(node) {
    if (!node.orphans.size || node.releasingOrphans) return;
    node.releasingOrphans = true;
    const pending = [...node.orphans.values()];
    void Promise.all(pending.map(async payload => {
      try { await node.client.call('release', payload); node.orphans.delete(payload.assignmentId); }
      catch (error) { if (!TRANSPORT_CODES.has(error?.code)) node.orphans.delete(payload.assignmentId); }
    })).finally(() => { node.releasingOrphans = false; });
  }

  cacheLoad(node, value) {
    try {
      const receivedAt = this.now(), label = publicGameLabel(node.publicSlot);
      if (!label || !Number.isSafeInteger(receivedAt) || receivedAt < 0) { node.telemetry = null; return; }
      const projected = value && normalizeGameLoad({ label, status: value.ready ? 'ready' : 'unavailable',
        loadState: value.loadState, loadDetails: value.loadDetails });
      const complete = value && Object.hasOwn(value, 'loadState') && Object.hasOwn(value, 'loadDetails')
        && ['unknown', 'normal', 'busy', 'overloaded'].includes(value.loadState)
        && (value.publicSlot == null || value.publicSlot === node.publicSlot)
        && (value.loadDetails === null && value.loadState === 'unknown' || projected?.loadDetails !== null);
      node.telemetry = { receivedAt, value: projected && (complete || !value.ready) ? projected
        : { label, status: value === null ? 'unavailable' : 'unknown', loadState: 'unknown', loadDetails: null } };
    } catch { node.telemetry = null; }
  }

  /** Reads only the existing authenticated heartbeat cache; never performs RPC. */
  publicLoad() {
    let at;
    try { at = this.now(); } catch { at = null; }
    const nodes = [];
    for (const node of this.nodes.values()) {
      const label = publicGameLabel(node.publicSlot);
      if (label === null) continue;
      const cached = node.telemetry, elapsed = cached && Number.isSafeInteger(at) ? at - cached.receivedAt : -1;
      if (this.closed || !cached || elapsed < 0 || elapsed > this.loadTtlMs) {
        nodes.push({ label, status: 'unknown', loadState: 'unknown', loadDetails: null }); continue;
      }
      const value = cached.value, details = value.loadDetails;
      const loadDetails = details && details.ageMs + elapsed <= 30_000 ? { ...details, ageMs: details.ageMs + elapsed } : null;
      nodes.push({ label, status: value.status, loadState: loadDetails ? value.loadState : 'unknown', loadDetails });
    }
    return normalizeClusterLoad({ scope: 'cluster', nodes });
  }

  valid(ctx) {
    try { return !this.closed && this.contexts.get(ctx.spec.assignmentId) === ctx && ctx.state !== 'aborted'
      && !ctx.controller.signal.aborted && (['committed', 'published'].includes(ctx.state) || ctx.isCurrent()); } catch { return false; }
  }

  peerIdentity(ctx, value) {
    return value?.assignmentId === ctx.spec.assignmentId && value.roomCode === ctx.spec.roomCode
      && value.build === this.build && value.protocol === this.protocol && value.generation === ctx.generation
      && (ctx.actorGeneration == null || value.actorGeneration === ctx.actorGeneration);
  }

  control(ctx, type, sessionId) {
    const role = ctx.members.get(sessionId);
    if (!role) throw new AllocationError('NOT_MEMBER');
    const base = { t: type, assignmentId: ctx.spec.assignmentId };
    if (type === 'cluster.prepare') {
      const claims = { sessionId, roomCode: ctx.spec.roomCode, assignmentId: ctx.spec.assignmentId,
        nodeId: ctx.node.nodeId, role, build: this.build, protocol: this.protocol };
      Object.assign(base, claims, { ticket: ctx.node.tickets.issue(claims), published: ctx.state === 'published' });
    }
    // Private ingress control frame; the ingress consumes it, never forwards a
    // credential or internal routing command to ordinary browser listeners.
    return this.sendControl(sessionId, base) === true;
  }

  async prepare(input, { signal, isCurrent = () => true } = {}) {
    if (this.closed) throw new AllocationError('PLATFORM_CLOSED');
    if (typeof isCurrent !== 'function') throw new TypeError('invalid remote match');
    if (signal?.aborted) throw cancelled();
    let spec;
    try { spec = copyAssignmentSpec(input, randomBytes(16).toString('hex')); }
    catch (error) {
      if (error instanceof GameHostError && error.code === 'INVALID_SPEC') throw new TypeError('invalid remote match');
      throw error;
    }
    if (spec.build !== this.build || spec.protocol !== this.protocol) throw new TypeError('invalid remote match');
    // The actual RPC envelope has a 32-hex-character nonce. Check the bounded
    // prepare-only budget BEFORE any reservation, ingress ticket or actor side effect.
    if (Buffer.byteLength(JSON.stringify({ id: '0'.repeat(32), op: 'prepare', payload: spec })) > PREPARE_MAX_BYTES) throw new AllocationError('TOO_LARGE');
    if (this.contexts.has(spec.assignmentId)) throw new AllocationError('ASSIGNMENT_CONFLICT');
    const assignment = this.directory.prepare({ assignmentId: spec.assignmentId, roomCode: spec.roomCode,
      sessionIds: spec.seats.filter(s => !s.isBot).map(s => s.playerId), build: this.build, protocol: this.protocol,
      mode: spec.mode, experimental: spec.experimental });
    const node = this.nodes.get(assignment.nodeId);
    const controller = new AbortController();
    const ctx = { spec, node, generation: assignment.generation, controller, isCurrent, state: 'preparing',
      remoteCreated: false, cleanup: null, revokedMembers: new Map(), removals: new Map(), terminal: false,
      members: new Map(spec.seats.filter(s => !s.isBot).map(s => [s.playerId, 'player'])) };
    for (const id of spec.spectators) {
      if (ctx.members.has(id)) { this.directory.abort(spec.assignmentId); throw new AllocationError('ROLE_CONFLICT'); }
      ctx.members.set(id, 'spectator');
    }
    this.contexts.set(spec.assignmentId, ctx);
    const onAbort = () => { controller.abort(); this.abortContext(ctx); };
    signal?.addEventListener('abort', onAbort, { once: true });
    ctx.detachSignal = () => signal?.removeEventListener('abort', onAbort);
    // Diagnostics only: the step a failure stopped at, and how many players had bound when the node last answered.
    ctx.step = 'node-prepare'; ctx.playersConnected = null; ctx.timedOut = false;
    const timer = setTimeout(() => { ctx.timedOut = true; onAbort(); }, this.allocationMs);
    timer.unref?.();
    try {
      ctx.remoteCreated = true; // A timed-out reply may still have created the actor.
      const prepared = await node.client.call('prepare', spec, { signal: controller.signal });
      if (!this.valid(ctx) || !this.peerIdentity(ctx, prepared) || prepared.state !== 'prepared'
        || !Number.isSafeInteger(prepared.actorGeneration) || prepared.actorGeneration < 1) throw cancelled();
      ctx.actorGeneration = prepared.actorGeneration;
      ctx.step = 'route';
      for (const id of ctx.members.keys()) if (!this.control(ctx, 'cluster.prepare', id) && ctx.members.get(id) === 'player') throw new AllocationError('PLAYER_OFFLINE');
      ctx.step = 'bind';
      while (true) {
        if (!this.valid(ctx)) throw cancelled();
        const status = await node.client.call('status', { assignmentId: spec.assignmentId }, { signal: controller.signal });
        if (!this.peerIdentity(ctx, status) || status.state !== 'prepared') throw new AllocationError('NODE_IDENTITY');
        if (Number.isSafeInteger(status.playersConnected)) ctx.playersConnected = status.playersConnected;
        if (status.playersReady === true) break;
        await pause(this.pollMs, controller.signal);
      }
      if (!this.valid(ctx)) throw cancelled();
      ctx.step = 'node-commit';
      const started = await node.client.call('commit', { assignmentId: spec.assignmentId }, { signal: controller.signal });
      if (!this.valid(ctx) || !this.peerIdentity(ctx, started) || started.state !== 'committed') throw new AllocationError('START_FAILED');
      ctx.state = 'prepared';
      return Object.freeze({ assignmentId: spec.assignmentId, nodeId: node.nodeId, generation: ctx.generation,
        commit: () => {
          if (!this.valid(ctx) || !['prepared', 'committed'].includes(ctx.state)) throw cancelled();
          const view = this.directory.commit(spec.assignmentId);
          if (!view.ownerAvailable) throw new AllocationError('NODE_UNAVAILABLE');
          for (const [id, role] of ctx.members) if (role === 'spectator') this.directory.attachSpectator(spec.assignmentId, id);
          ctx.state = 'committed';
          return view;
        },
        publish: () => {
          if (ctx.state !== 'committed' || !this.valid(ctx)) return false;
          ctx.state = 'published';
          ctx.detachSignal();
          for (const id of ctx.members.keys()) {
            try { this.control(ctx, 'cluster.commit', id); } catch { /* a disconnected member resumes by its assignment */ }
          }
          // Confirmation has no battle data. Failure is observable and bounded;
          // the node's unpublished lease remains responsible for self-cleanup.
          ctx.publication = this.confirmPublication(ctx);
          return true;
        },
        abort: () => this.abortContext(ctx) });
    } catch (e) {
      await this.abortContext(ctx);
      // This allocation's own deadline aborted whichever step was waiting (an RPC, the poll pause, the validity check):
      // name it, so the lobby can tell an unbound player from an internal fault. A specific allocation error stays.
      const error = ctx.timedOut && !(e instanceof AllocationError && e.code !== 'CANCELLED') ? new AllocationError('TIMEOUT') : e;
      if (error && typeof error === 'object') {
        try { Object.assign(error, { step: ctx.step, playersConnected: ctx.playersConnected }); } catch { /* frozen: no diagnostics */ }
      }
      throw error;
    } finally { clearTimeout(timer); }
  }

  /**
   * A match back after a restart (docs/DEPLOY.md「断点续玩」; ClusterLobby.restoreRemoteMatch): `adopt` { nodeId,
   * nodeGeneration } — its node never restarted, so the actor (input.assignmentId) still runs there: take it over as it
   * is (status); else a node rebuilds it, as the new assignment input.assignmentId, from the checkpoint `checkpointId`
   * (`restore`; a new id: an old actor that still runs somewhere can never write over the new one's checkpoint). Either
   * way the assignment is published at once (no channel to wait for: each member binds as it comes back, through
   * resume). Throws an AllocationError / RPC error code: NO_NODE, NOT_READY or a transport code (the caller may retry),
   * STALE_ASSIGNMENT (adopt: the actor is gone), NO_CHECKPOINT, RESTORE_REFUSED, CONTEXT (it cannot come back).
   * `departed`: its human seats that had left it (revoked, as before the restart): they claim no session in the
   * directory — another match may hold it by now — and get no game channel; the caller sends their leave once it is back.
   * @param {object} input assignment DTO with its assignmentId, the current build / protocol and spectators
   * @param {{ adopt?: { nodeId: string, nodeGeneration: string } | null, checkpointId?: string, departed?: string[] }} [opts]
   */
  async restore(input, { adopt = null, checkpointId = null, departed = [] } = {}) {
    if (this.closed) throw new AllocationError('PLATFORM_CLOSED');
    let spec;
    try { spec = copyAssignmentSpec(input); }
    catch (error) { if (error instanceof GameHostError && error.code === 'INVALID_SPEC') throw new TypeError('invalid remote match', { cause: error }); throw error; }
    if (spec.build !== this.build || spec.protocol !== this.protocol) throw new TypeError('invalid remote match');
    if (this.contexts.has(spec.assignmentId)) throw new AllocationError('ASSIGNMENT_CONFLICT');
    const adopting = !!adopt && this.nodes.get(adopt.nodeId)?.generation === adopt.nodeGeneration;
    // a node that has not answered yet may still run it: ask again (a configured node that is gone is NODE_LOST later)
    if (adopt && !adopting) throw new AllocationError(this.nodes.has(adopt.nodeId) && this.nodes.get(adopt.nodeId).generation === null ? 'NOT_READY' : 'STALE_ASSIGNMENT');
    if (!adopting && !safeId(checkpointId)) throw new TypeError('invalid checkpoint');
    const humans = spec.seats.filter(s => !s.isBot).map(s => s.playerId);
    if (!Array.isArray(departed) || !departed.every(id => humans.includes(id))) throw new TypeError('invalid remote match');
    const assignment = this.directory.prepare({ assignmentId: spec.assignmentId, roomCode: spec.roomCode,
      sessionIds: humans, departed, build: this.build, protocol: this.protocol,
      mode: spec.mode, experimental: spec.experimental, nodeId: adopting ? adopt.nodeId : null });
    const node = this.nodes.get(assignment.nodeId);
    const ctx = { spec, node, generation: assignment.generation, controller: new AbortController(), isCurrent: () => true, state: 'preparing',
      remoteCreated: false, cleanup: null, revokedMembers: new Map(departed.map(id => [id, 'player'])), removals: new Map(), terminal: false, restored: true,
      members: new Map(humans.filter(id => !departed.includes(id)).map(id => [id, 'player'])) };
    for (const id of spec.spectators) if (!ctx.members.has(id) && !ctx.revokedMembers.has(id)) ctx.members.set(id, 'spectator');
    this.contexts.set(spec.assignmentId, ctx);
    try {
      let value;
      if (adopting) {
        value = await node.client.call('status', { assignmentId: spec.assignmentId });
        if (value?.state !== 'committed') throw new AllocationError('STALE_ASSIGNMENT');
      } else {
        ctx.remoteCreated = true;
        value = await node.client.call('restore', { assignmentId: spec.assignmentId, checkpointId, roomCode: spec.roomCode, build: this.build,
          protocol: this.protocol, spectators: [...spec.spectators] });
        if (value?.state !== 'committed') throw new AllocationError('RESTORE_REFUSED');
      }
      if (!this.valid(ctx) || value.assignmentId !== spec.assignmentId || value.roomCode !== spec.roomCode || value.build !== this.build
        || value.protocol !== this.protocol || value.generation !== ctx.generation
        || !Number.isSafeInteger(value.actorGeneration) || value.actorGeneration < 1) throw new AllocationError('NODE_IDENTITY');
      ctx.actorGeneration = value.actorGeneration;
      this.directory.commit(spec.assignmentId);
      for (const [id, role] of ctx.members) if (role === 'spectator') this.directory.attachSpectator(spec.assignmentId, id);
      ctx.state = 'published';
      ctx.publication = this.confirmPublication(ctx);
      return Object.freeze({ assignmentId: spec.assignmentId, nodeId: node.nodeId, generation: ctx.generation, adopted: adopting,
        commit: () => true, publish: () => true, abort: () => this.release(spec.assignmentId) });
    } catch (e) {
      await this.abortContext(ctx);
      throw e;
    }
  }

  async confirmPublication(ctx) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (ctx.state !== 'published' || this.closed) return false;
      try {
        const value = await ctx.node.client.call('publish', { assignmentId: ctx.spec.assignmentId });
        if (!this.peerIdentity(ctx, value) || value.published !== true) throw new AllocationError('NODE_IDENTITY');
        await this.onPublished(ctx.spec.assignmentId);
        return true;
      } catch (e) {
        if (attempt === 2 || !['TRANSPORT', 'TIMEOUT', 'BAD_REPLY'].includes(e?.code)) break;
        try { await pause(attempt ? 500 : 100, ctx.controller.signal); } catch { return false; }
      }
    }
    if (ctx.state === 'published' && !this.closed) {
      try {
        await this.onUnavailable(Object.freeze({ assignmentId: ctx.spec.assignmentId, roomCode: ctx.spec.roomCode,
          nodeId: ctx.node.nodeId, reason: 'PUBLICATION_FAILED' }));
      } catch { /* owner still gets explicit release; never fake a match result */ }
      await this.release(ctx.spec.assignmentId);
    }
    return false;
  }

  abortContext(ctx) {
    if (ctx.state === 'published') return Promise.resolve(false);
    if (ctx.cleanup) return ctx.cleanup;
    ctx.state = 'aborted';
    ctx.controller.abort();
    ctx.detachSignal?.();
    if (this.contexts.get(ctx.spec.assignmentId) === ctx) this.contexts.delete(ctx.spec.assignmentId);
    this.directory.release(ctx.spec.assignmentId);
    for (const id of ctx.members.keys()) {
      try { this.control(ctx, 'cluster.abort', id); } catch { /* dead ingress */ }
    }
    // Do not reuse the cancelled work signal: compensation must still be sent.
    ctx.cleanup = ctx.remoteCreated
      ? ctx.node.client.call('release', { assignmentId: ctx.spec.assignmentId }).then(() => true, () => false)
      : Promise.resolve(true);
    return ctx.cleanup;
  }

  resume(assignmentId, sessionId) {
    const ctx = this.contexts.get(assignmentId);
    const route = this.directory.bySession(sessionId);
    if (!ctx || ctx.state !== 'published' || !ctx.members.has(sessionId) || ctx.pendingMembers?.has(sessionId)
      || !route?.ownerAvailable || route.assignmentId !== assignmentId) return false;
    return this.control(ctx, 'cluster.prepare', sessionId);
  }

  assignmentInfo(assignmentId) {
    const ctx = this.contexts.get(assignmentId);
    if (!ctx || ctx.state === 'aborted' || !Number.isSafeInteger(ctx.actorGeneration)) return null;
    return Object.freeze({ assignmentId, roomCode: ctx.spec.roomCode, nodeId: ctx.node.nodeId, generation: ctx.generation,
      actorGeneration: ctx.actorGeneration, build: this.build, protocol: this.protocol, state: ctx.state });
  }

  peer(assignmentId, method, sessionId, loadout, ops = undefined) {
    const ctx = this.contexts.get(assignmentId);
    if (!ctx) return Promise.reject(new AllocationError('STALE_ASSIGNMENT'));
    ctx.pendingMembers ??= new Set();
    if (ctx.pendingMembers.has(sessionId)) return Promise.reject(new AllocationError('MEMBER_BUSY'));
    ctx.pendingMembers.add(sessionId);
    return this.memberOperation(assignmentId, method, sessionId, loadout, ops).finally(() => ctx.pendingMembers.delete(sessionId));
  }

  /** The node made an AI seat a human's (ClusterLobby.transferRemoteSeat): from now on `sessionId` is routed as its player. */
  attachPlayer(assignmentId, sessionId) {
    const ctx = this.contexts.get(assignmentId);
    if (!ctx || ctx.state !== 'published') throw new AllocationError('STALE_ASSIGNMENT');
    this.directory.attachPlayer(assignmentId, sessionId);
    ctx.members.set(sessionId, 'player');
  }

  memberPayload(ctx, sessionId) {
    return { assignmentId: ctx.spec.assignmentId, sessionId, nodeGeneration: ctx.generation, actorGeneration: ctx.actorGeneration };
  }

  /** Synchronous fail-closed fence, including an admission/loadout still in flight. */
  revoke(assignmentId, sessionId) {
    const ctx = this.contexts.get(assignmentId);
    if (!ctx || ctx.state !== 'published' || !safeId(sessionId)) return false;
    const role = ctx.members.get(sessionId) ?? ctx.revokedMembers.get(sessionId) ?? 'spectator';
    ctx.revokedMembers.set(sessionId, role);
    if (role === 'player') this.directory.detachPlayer(assignmentId, sessionId);
    else this.directory.detachSpectator(assignmentId, sessionId);
    ctx.members.delete(sessionId);
    try { this.sendControl(sessionId, { t: 'cluster.detach', assignmentId }); } catch { /* offline member cannot resume */ }
    return true;
  }

  removeRemote(ctx, method, sessionId) {
    const existing = ctx.removals.get(sessionId);
    if (existing) return existing;
    // Fixed node + actor epochs: compensation must never act on a new owner,
    // another room, or a replacement incarnation. Never disable an entire node.
    const payload = this.memberPayload(ctx, sessionId);
    const work = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (this.contexts.get(ctx.spec.assignmentId) !== ctx || ctx.state !== 'published' || this.closed) return { error: 'WRONG_PHASE' };
        try {
          const result = await ctx.node.client.call(method, payload, { signal: ctx.controller.signal });
          if (result?.ok === true) return { ok: true };
          throw new AllocationError(result?.error ?? 'BAD_REPLY');
        } catch (error) {
          if (attempt === 2 || !['TRANSPORT', 'TIMEOUT', 'BAD_REPLY', 'INTERNAL'].includes(error?.code)) break;
          try { await pause(attempt ? 75 : 25, ctx.controller.signal); } catch { break; }
        }
      }
      // Local access is already revoked. If the remote role cannot be confirmed
      // absent, retire ONLY this assignment, rather than leave a stale capability.
      if (this.contexts.get(ctx.spec.assignmentId) === ctx && ctx.state === 'published') {
        try { await this.onUnavailable(Object.freeze({ assignmentId: ctx.spec.assignmentId, roomCode: ctx.spec.roomCode,
          nodeId: ctx.node.nodeId, reason: 'REVOCATION_FAILED' })); } catch {}
        await this.release(ctx.spec.assignmentId);
      }
      return { error: 'INTERNAL' };
    })();
    ctx.removals.set(sessionId, work);
    const done = () => { if (ctx.removals.get(sessionId) === work) ctx.removals.delete(sessionId); };
    work.then(done, done);
    return work;
  }

  async memberOperation(assignmentId, method, sessionId, loadout, ops = undefined) {
    const ctx = this.contexts.get(assignmentId);
    if (!ctx || ctx.state !== 'published' || !safeId(sessionId)
      || !['leave', 'removeSpectator', 'addSpectator', 'setLoadout', 'setSkins', 'requestSetupReroll', 'cancelSetupReroll', 'aiSeat', 'transferAiSeat'].includes(method)) throw new AllocationError('STALE_ASSIGNMENT');
    const removing = ['leave', 'removeSpectator'].includes(method);
    const role = ctx.members.get(sessionId) ?? (removing ? ctx.revokedMembers.get(sessionId) : undefined);
    if (removing) {
      if (!role || (method === 'removeSpectator' && role !== 'spectator')) throw new AllocationError('NOT_MEMBER');
      this.revoke(assignmentId, sessionId); // BEFORE RPC, even if ownership/transport is unavailable.
      return this.removeRemote(ctx, method, sessionId);
    }
    const owner = this.directory.byRoom(ctx.spec.roomCode);
    if (!owner?.ownerAvailable || owner.assignmentId !== assignmentId) throw new AllocationError('NODE_UNAVAILABLE');
    if (method === 'addSpectator') {
      if (role === 'player') throw new AllocationError('ROLE_CONFLICT');
      if (role === 'spectator') { this.control(ctx, 'cluster.prepare', sessionId); return { ok: true }; }
      if (ctx.removals.has(sessionId)) throw new AllocationError('MEMBER_BUSY');
      ctx.revokedMembers.delete(sessionId); // A new explicit admission, after old compensation settled.
      this.directory.attachSpectator(assignmentId, sessionId);
      let result;
      try { result = await ctx.node.client.call(method, this.memberPayload(ctx, sessionId)); }
      catch (e) {
        this.revoke(assignmentId, sessionId);
        await this.removeRemote(ctx, 'removeSpectator', sessionId); // The failed reply may have dispatched.
        throw e;
      }
      // A real end receipt can overtake this successful role reply. deliverEnd
      // already authenticated/ordered that member's result; do not rebind an old
      // actor after its terminal marker (or undo a legitimate lobby spectator).
      if (ctx.terminal && result?.ok === true && !ctx.revokedMembers.has(sessionId)) return result;
      if (result?.ok !== true || ctx.revokedMembers.has(sessionId) || this.contexts.get(assignmentId) !== ctx || ctx.state !== 'published') {
        this.revoke(assignmentId, sessionId);
        await this.removeRemote(ctx, 'removeSpectator', sessionId);
        return result?.error ? result : { error: 'WRONG_PHASE' };
      }
      ctx.members.set(sessionId, 'spectator');
      this.control(ctx, 'cluster.prepare', sessionId);
      return result;
    }
    if (method === 'aiSeat' || method === 'transferAiSeat') {
      if (role !== 'spectator') throw new AllocationError('NOT_MEMBER');
      const payload = { ...this.memberPayload(ctx, sessionId), ...loadout };
      // A lost reply may have gone through: the node answers a repeat of the same transfer OK (GameHost.transferAiSeat).
      for (let attempt = 0; ; attempt++) {
        try { return await ctx.node.client.call(method, payload, { signal: ctx.controller.signal }); }
        catch (error) {
          if (attempt === 2 || !['TRANSPORT', 'TIMEOUT', 'BAD_REPLY'].includes(error?.code)) throw error;
          await pause(attempt ? 75 : 25, ctx.controller.signal);
        }
      }
    }
    if (role !== 'player') throw new AllocationError('NOT_MEMBER');
    const setupField = method === 'requestSetupReroll' ? 'setupRevision' : method === 'cancelSetupReroll' ? 'voteId' : null;
    if (setupField) {
      if (!Number.isInteger(loadout) || loadout < (setupField === 'voteId' ? 1 : 0) || loadout > 2 ** 31) throw new AllocationError('BAD_REQUEST');
      return ctx.node.client.call(method, { ...this.memberPayload(ctx, sessionId), [setupField]: loadout });
    }
    return ctx.node.client.call(method, { ...this.memberPayload(ctx, sessionId),
      ...(method === 'setSkins' ? { choices: loadout } : { loadout, ...(ops === undefined ? {} : { ops }) }) });
  }

  /**
   * Only validated, bounded terminal frames may use the low-rate control path. `lastPublic` (or null) and each
   * `results` value are the JSON texts the lobby validated: every member's cluster.terminal frame is spliced from
   * them, byte-identical to encoding { t, assignmentId, sessionId, lastPublic, result }, never re-serialized per
   * member. With sendControlEncoded the shared final public frame is UTF-8 encoded once for all members; with
   * sendControlParts it is handed over once (one copy per ingress link). A member's own control frames sent here
   * (a late observer's cluster.prepare) still precede its terminal frame.
   * @param {string} assignmentId
   * @param {{ lastPublic: string | null, results: Map<string, string> }} end
   * @param {Iterable<string>} memberIds
   */
  deliverEnd(assignmentId, { lastPublic, results }, memberIds) {
    const ctx = this.contexts.get(assignmentId);
    if (!ctx || ctx.state !== 'published' || ctx.terminal) return false;
    ctx.terminal = true;
    const head = `{"t":"cluster.terminal","assignmentId":${JSON.stringify(assignmentId)},"sessionId":`;
    const tail = `,"lastPublic":${lastPublic ?? 'null'},"result":`;
    let tailBytes = null;
    const parts = [];
    for (const sessionId of memberIds) {
      if (ctx.revokedMembers.has(sessionId) || !results.has(sessionId)) continue;
      if (!ctx.members.has(sessionId)) {
        // A receipt may beat an in-flight addSpectator reply. The lobby's current
        // seat, directory reservation AND node's personal receipt must all agree.
        if (!ctx.pendingMembers?.has(sessionId) || this.directory.bySession(sessionId)?.assignmentId !== assignmentId) continue;
        ctx.members.set(sessionId, 'spectator');
        try { this.control(ctx, 'cluster.prepare', sessionId); } catch {}
      }
      if (this.sendControlParts) {
        parts.push({ sessionId, prefix: Buffer.from(`${head}${JSON.stringify(sessionId)},"lastPublic":`), suffix: Buffer.from(`,"result":${results.get(sessionId)}}`) });
        continue;
      }
      try {
        if (this.sendControlEncoded) {
          tailBytes ??= Buffer.from(tail);
          this.sendControlEncoded(sessionId, 'cluster.terminal', Buffer.concat([Buffer.from(head + JSON.stringify(sessionId)), tailBytes,
            Buffer.from(`${results.get(sessionId)}}`)]));
        } else this.sendControl(sessionId, JSON.parse(`${head}${JSON.stringify(sessionId)}${tail}${results.get(sessionId)}}`));
      } catch { /* offline/slow members get their own lobby replay on reconnect */ }
    }
    if (parts.length) {
      try { this.sendControlParts(parts, Buffer.from(lastPublic ?? 'null'), 'cluster.terminal'); }
      catch { /* offline/slow members get their own lobby replay on reconnect */ }
    }
    return true;
  }

  async release(assignmentId) {
    const ctx = this.contexts.get(assignmentId);
    if (!ctx) return false;
    ctx.state = 'aborted';
    ctx.controller.abort();
    ctx.detachSignal?.();
    this.contexts.delete(assignmentId);
    this.directory.release(assignmentId);
    for (const id of ctx.members.keys()) {
      try { this.control(ctx, ctx.terminal ? 'cluster.terminate' : 'cluster.abort', id); } catch { /* dead ingress */ }
    }
    const payload = { assignmentId, nodeGeneration: ctx.generation, actorGeneration: ctx.actorGeneration };
    try { await ctx.node.client.call('release', payload); return true; }
    catch (error) {
      // An unreachable node of the same generation may still run the actor: release it when it answers again.
      if (TRANSPORT_CODES.has(error?.code) && !this.closed && ctx.node.generation === ctx.generation && Number.isSafeInteger(ctx.actorGeneration)
        && ctx.node.orphans.size < MAX_ORPHANS) ctx.node.orphans.set(assignmentId, payload);
      return false;
    }
  }

  /** `release: false` (a coordinator that saved its state, server/persist/): leave every actor running on its node. */
  async close({ release = true } = {}) {
    if (this.closed) return;
    this.closed = true;
    if (release) await Promise.all([...this.contexts.keys()].map(id => this.release(id)));
    for (const node of this.nodes.values()) node.client.close();
  }
}
