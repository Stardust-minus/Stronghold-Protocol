// Low-rate coordinator adapter. It reserves one node per entire match, prepares
// player channels before start, and never carries battle snapshots/events.
import { randomBytes, createHash } from 'node:crypto';
import { ClusterDirectory, AllocationError } from './directory.js';
import { createTicketAuthority } from './tickets.js';
import { createRpcAuthenticator, createRpcClient } from './rpc.js';
import { normalizeClusterLoad, normalizeGameLoad, publicGameLabel, MAX_PUBLIC_GAME_NODES } from '../../shared/cluster-load.js';

const safeId = v => typeof v === 'string' && v.length > 0 && v.length <= 128 && /^[A-Za-z0-9_-][A-Za-z0-9_.:-]*(?![\s\S])/.test(v);
const cancelled = () => new AllocationError('CANCELLED');
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
  constructor({ nodes, build, protocol, sendControl, onUnavailable = () => {}, onPublished = () => {}, requireStreamMarkers = false,
    now = Date.now, directory, allocationMs = 5000, pollMs = 50, loadTtlMs = 5000 }) {
    if (!Array.isArray(nodes) || !nodes.length || !safeId(build) || !Number.isSafeInteger(protocol) || protocol < 1
      || typeof sendControl !== 'function' || typeof onUnavailable !== 'function' || typeof onPublished !== 'function'
      || typeof requireStreamMarkers !== 'boolean' || typeof now !== 'function') throw new TypeError('invalid game platform');
    if (!Number.isSafeInteger(allocationMs) || allocationMs < 1 || allocationMs > 6000
      || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1000
      || !Number.isSafeInteger(loadTtlMs) || loadTtlMs < 1 || loadTtlMs > 30_000) throw new RangeError('invalid allocation deadline');
    this.build = build;
    this.protocol = protocol;
    this.sendControl = sendControl;
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
    this.nodes.set(node.nodeId, { ...descriptor, tickets, client, generation: null });
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
        node.generation = status.generation;
        this.directory.heartbeat(node.nodeId, { generation: status.generation, ready: status.ready, matches: status.counts.matches });
        this.cacheLoad(node, status);
      } catch { this.directory.disable(node.nodeId); this.cacheLoad(node, null); }
    }));
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
    if (typeof isCurrent !== 'function' || !input || input.build !== this.build || input.protocol !== this.protocol
      || !Array.isArray(input.seats) || !Array.isArray(input.spectators ?? [])) throw new TypeError('invalid remote match');
    if (signal?.aborted) throw cancelled();
    const spec = structuredClone({ ...input, assignmentId: input.assignmentId ?? randomBytes(16).toString('hex'), spectators: input.spectators ?? [] });
    const assignment = this.directory.prepare({ assignmentId: spec.assignmentId, roomCode: spec.roomCode,
      sessionIds: spec.seats.filter(s => !s.isBot).map(s => s.playerId), build: this.build, protocol: this.protocol });
    if (this.contexts.has(spec.assignmentId)) throw new AllocationError('ASSIGNMENT_CONFLICT');
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
    const timer = setTimeout(onAbort, this.allocationMs);
    timer.unref?.();
    try {
      ctx.remoteCreated = true; // A timed-out reply may still have created the actor.
      const prepared = await node.client.call('prepare', spec, { signal: controller.signal });
      if (!this.valid(ctx) || !this.peerIdentity(ctx, prepared) || prepared.state !== 'prepared'
        || !Number.isSafeInteger(prepared.actorGeneration) || prepared.actorGeneration < 1) throw cancelled();
      ctx.actorGeneration = prepared.actorGeneration;
      for (const id of ctx.members.keys()) if (!this.control(ctx, 'cluster.prepare', id) && ctx.members.get(id) === 'player') throw new AllocationError('PLAYER_OFFLINE');
      while (true) {
        if (!this.valid(ctx)) throw cancelled();
        const status = await node.client.call('status', { assignmentId: spec.assignmentId }, { signal: controller.signal });
        if (!this.peerIdentity(ctx, status) || status.state !== 'prepared') throw new AllocationError('NODE_IDENTITY');
        if (status.playersReady === true) break;
        await pause(this.pollMs, controller.signal);
      }
      if (!this.valid(ctx)) throw cancelled();
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
      throw e;
    } finally { clearTimeout(timer); }
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

  peer(assignmentId, method, sessionId, loadout) {
    const ctx = this.contexts.get(assignmentId);
    if (!ctx) return Promise.reject(new AllocationError('STALE_ASSIGNMENT'));
    ctx.pendingMembers ??= new Set();
    if (ctx.pendingMembers.has(sessionId)) return Promise.reject(new AllocationError('MEMBER_BUSY'));
    ctx.pendingMembers.add(sessionId);
    return this.memberOperation(assignmentId, method, sessionId, loadout).finally(() => ctx.pendingMembers.delete(sessionId));
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

  async memberOperation(assignmentId, method, sessionId, loadout) {
    const ctx = this.contexts.get(assignmentId);
    if (!ctx || ctx.state !== 'published' || !safeId(sessionId)
      || !['leave', 'removeSpectator', 'addSpectator', 'setLoadout'].includes(method)) throw new AllocationError('STALE_ASSIGNMENT');
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
    if (role !== 'player') throw new AllocationError('NOT_MEMBER');
    return ctx.node.client.call(method, { ...this.memberPayload(ctx, sessionId), loadout });
  }

  /** Only validated, bounded terminal frames may use the low-rate control path. */
  deliverEnd(assignmentId, { lastPublic, results }, memberIds) {
    const ctx = this.contexts.get(assignmentId);
    if (!ctx || ctx.state !== 'published' || ctx.terminal) return false;
    ctx.terminal = true;
    for (const sessionId of memberIds) {
      if (ctx.revokedMembers.has(sessionId) || !Object.hasOwn(results, sessionId)) continue;
      if (!ctx.members.has(sessionId)) {
        // A receipt may beat an in-flight addSpectator reply. The lobby's current
        // seat, directory reservation AND node's personal receipt must all agree.
        if (!ctx.pendingMembers?.has(sessionId) || this.directory.bySession(sessionId)?.assignmentId !== assignmentId) continue;
        ctx.members.set(sessionId, 'spectator');
        try { this.control(ctx, 'cluster.prepare', sessionId); } catch {}
      }
      try { this.sendControl(sessionId, { t: 'cluster.terminal', assignmentId, sessionId, lastPublic, result: results[sessionId] }); }
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
    try { await ctx.node.client.call('release', { assignmentId, nodeGeneration: ctx.generation, actorGeneration: ctx.actorGeneration }); return true; }
    catch { return false; }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.contexts.keys()].map(id => this.release(id)));
    for (const node of this.nodes.values()) node.client.close();
  }
}
