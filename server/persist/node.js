// server/persist/node.js — a game node's match checkpoints (docs/DEPLOY.md「断点续玩」, cluster): every committed actor
// of the node's GameHost is checkpointed at its match's safe points and every `saveMs`, under its assignment id; the
// checkpoint is deleted once the actor ends or is released for good. After a restart the coordinator asks a node to
// `restore` an assignment (server/cluster/game-node.js): the node reads the checkpoint here and the GameHost rebuilds
// the actor from it (GameHost.restore). A node never restores anything on its own — the coordinator decides which
// rooms came back. A store that is not answering (yet) at that read is no lost checkpoint: the node answers NOT_READY
// and the coordinator asks again (server/cluster/lobby.js RESTORE_RETRY, for RESTORE_WAIT_MS).
//
// The envelope: { v, kind: 'cluster', assignmentId, roomCode, nodeId, spec (the assignment DTO the actor was prepared
// with), left (players that departed), match (server/match/snapshot.js) }. Nothing here touches a running match beyond
// the synchronous capture; a store that is down only skips checkpoints.
// Another official version's actor (spec.version; its match runs in a version host of this node, server/cluster/
// game-host.js) is checkpointed by that host: it posts the match's snapshot at each safe point and when asked (every
// round and the shutdown: MatchProxy.checkpoint), and the envelope wraps the host's JSON as it is. Its spec names the
// version, so a release whose nodes do not run other versions refuses such a checkpoint (INVALID_SPEC) instead of
// rebuilding it on the wrong data.

import { snapshotMatch } from '../match/snapshot.js';
import { SAVE_MS } from './persister.js';
import { TRANSIENT_FAILURES } from './store.js';

/** How long a rebuilt actor keeps the checkpoint it came from (> the node's 20 s publication lease). */
const SUPERSEDE_MS = 30_000;

/** Envelope version (the match document has its own, SNAPSHOT_VERSION). */
export const NODE_CHECKPOINT_VERSION = 1;

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

export class NodeCheckpoints {
  /**
   * @param {{ store: import('./store.js').CheckpointStore, gameHost: import('../cluster/game-host.js').GameHost,
   *   nodeId: string, log?: object, saveMs?: number }} opts
   */
  constructor({ store, gameHost, nodeId, log = noopLog, saveMs = SAVE_MS }) {
    this.store = store;
    this.gameHost = gameHost;
    this.nodeId = nodeId;
    this.log = log;
    this.saveMs = Math.max(1000, Number(saveMs) || SAVE_MS);
    /**
     * assignment id → the last checkpoint written (`pending`: its write)
     * @type {Map<string, { json: string | null, ctx: object, ok: boolean, pending: Promise<boolean> | null }>}
     */
    this.written = new Map();
    /**
     * a rebuilt actor's assignment id → the checkpoint it came from, deleted by a later round once the new actor has
     * written its own and outlived its publication lease (a restore whose reply was lost is released and retried from it)
     * @type {Map<string, { id: string, at: number }>}
     */
    this.supersedes = new Map();
    this.timer = null;
    this.closed = false;
    this.busy = null;
    this.counts = { captures: 0, captureSkips: 0, deleted: 0, restores: 0, restoreFailures: 0 };
    gameHost.onCheckpoint = (ctx, match, reason) => this.capture(ctx, reason);
  }

  /** Checkpoint one actor now (never throws). @returns {Promise<boolean> | null} its write, null when skipped */
  capture(ctx, reason = 'tick') {
    if (this.closed || !ctx?.match || ctx.state !== 'committed' || !ctx.live || ctx.disposed) return null;
    // a hosted actor (the header): the latest checkpoint its version host posted, wrapped as it is
    const hosted = ctx.match.hosted === true ? ctx.match.lastCheckpoint : null;
    const doc = ctx.match.hosted === true ? null : snapshotMatch(ctx.match);
    if (!doc && typeof hosted?.json !== 'string') { this.counts.captureSkips++; return null; }
    const id = ctx.spec.assignmentId;
    const left = [...ctx.members].filter(([, m]) => m.role === 'player' && m.left).map(([pid]) => pid);
    const head = { v: NODE_CHECKPOINT_VERSION, kind: 'cluster', assignmentId: id, roomCode: ctx.spec.roomCode,
      nodeId: this.nodeId, reason, spec: ctx.spec, left };
    const json = doc ? JSON.stringify({ ...head, match: doc }) : `${JSON.stringify(head).slice(0, -1)},"match":${hosted.json}}`;
    const prev = this.written.get(id);
    if (prev && prev.ctx === ctx && prev.json === json) return null;
    const rec = { json, ctx, ok: false, pending: null };
    this.written.set(id, rec);
    this.counts.captures++;
    rec.pending = this.store.saveCheckpoint(id, json).then((ok) => { if (ok) rec.ok = true; return ok; });
    return rec.pending;
  }

  /** One periodic round: every committed actor, then the checkpoints of actors that ended or were released. */
  async tick(reason = 'tick') {
    if (this.busy) { if (reason === 'tick') return; await this.busy; }
    const run = (async () => {
      const writes = [];
      // hosted actors: their hosts post a checkpoint each (or nothing, past their last safe point); capture follows it
      for (const ctx of this.gameHost.contexts.values()) {
        if (ctx.match?.hosted !== true || ctx.state !== 'committed' || !ctx.live || ctx.disposed || typeof ctx.match.checkpoint !== 'function') continue;
        writes.push((async () => {
          try { await ctx.match.checkpoint(reason); } catch { /* the host is gone: the last checkpoint stays */ }
          return this.written.get(ctx.spec.assignmentId)?.pending ?? null;
        })());
      }
      for (const ctx of this.gameHost.contexts.values()) {
        if (ctx.match?.hosted === true) continue;
        // an actor past its last safe point (a battle) is not captured again: the write that safe point started still
        // lands before the round ends (a shutdown closes the store next; see persister.js flush)
        const w = this.capture(ctx, reason) ?? this.written.get(ctx.spec?.assignmentId)?.pending;
        if (w) writes.push(w);
      }
      await Promise.all(writes);
      if (reason === 'shutdown') return;
      for (const [id, old] of [...this.supersedes]) {
        const ctx = this.gameHost.contexts.get(id), rec = this.written.get(id);
        if (!ctx || ctx.state === 'ended') { this.supersedes.delete(id); continue; }
        if (!rec?.ok || rec.ctx !== ctx || Date.now() - old.at < SUPERSEDE_MS) continue;
        this.supersedes.delete(id);
        if (await this.store.deleteCheckpoint(old.id)) this.counts.deleted++;
      }
      for (const [id, rec] of [...this.written]) {
        const ctx = this.gameHost.contexts.get(id);
        if (ctx === rec.ctx && ctx.state !== 'ended') continue;
        this.written.delete(id);
        // a new incarnation of the id on this node writes its own; an actor that ended or was released is done
        if (ctx && ctx !== rec.ctx && ctx.state !== 'ended') continue;
        if (await this.store.deleteCheckpoint(id)) this.counts.deleted++;
      }
    })();
    this.busy = run;
    try { await run; } finally { if (this.busy === run) this.busy = null; }
  }

  start() {
    if (this.timer || this.closed) return this;
    this.timer = setInterval(() => { this.tick('tick').catch(() => {}); }, this.saveMs);
    this.timer.unref?.();
    return this;
  }

  /**
   * The checkpoint `checkpointId` the coordinator wants back (game-node `restore`) as the new assignment `assignmentId`
   * (whose own first checkpoint then replaces it), or null. Rejects with code NOT_READY while the store is not answering
   * (store.js TRANSIENT_FAILURES): the checkpoint may well be there, the coordinator asks again.
   * @returns {Promise<{ spec: object, left: string[], match: object } | null>}
   */
  async load(checkpointId, assignmentId = checkpointId) {
    const loaded = await this.store.loadCheckpoint(checkpointId);
    if (!loaded.ok && TRANSIENT_FAILURES.has(loaded.error)) {
      this.log.warn?.(`[persist] checkpoint ${checkpointId.slice(0, 8)}: the store is not answering (${loaded.error}); the coordinator asks again`);
      throw Object.assign(new Error('checkpoint store not answering'), { code: 'NOT_READY' });
    }
    const cp = loaded.value;
    if (!cp || cp.v !== NODE_CHECKPOINT_VERSION || cp.kind !== 'cluster' || cp.assignmentId !== checkpointId
      || !cp.spec || typeof cp.spec !== 'object' || !cp.match || !Array.isArray(cp.left)) {
      this.counts.restoreFailures++;
      this.log.warn?.(`[persist] checkpoint ${checkpointId.slice(0, 8)} ${loaded.ok ? 'missing or unusable' : 'unreadable'}`);
      return null;
    }
    this.counts.restores++;
    if (assignmentId !== checkpointId) this.supersedes.set(assignmentId, { id: checkpointId, at: Date.now() });
    return { spec: cp.spec, left: cp.left.filter((id) => typeof id === 'string'), match: cp.match,
      reason: typeof cp.reason === 'string' ? cp.reason : null };
  }

  /** The last round before the node stops: every committed actor's checkpoint, nothing deleted. */
  async shutdown() {
    if (this.closed) return;
    clearInterval(this.timer);
    this.timer = null;
    try { await this.tick('shutdown'); } catch { /* the store may be gone too */ }
    this.closed = true;
    if (this.gameHost.onCheckpoint) this.gameHost.onCheckpoint = null;
  }

  snapshot() { return { enabled: true, saveMs: this.saveMs, ...this.counts, store: this.store.snapshot() }; }
}
