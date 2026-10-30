// Server side of the state-delta transport (shared/stateDelta.js; after xinhai-ai/Stronghold-Protocol 2abc60f).
//
// Baselines live per socket: the browser's socket in a single process (server/net.js), the per-member game channel
// on a cluster game node (cluster/game-node.js; the ingress relays m.state untouched). A new socket starts from full
// frames, so a reconnect or a channel switch needs no reset message. A baseline moves only after the frame was queued
// (commit), and the transport is reliable and ordered, so the browser's baseline is always the one a delta names.
// Encoding is shared per message object: a broadcast parses its JSON once, and members whose last frame was the same
// snapshot share one delta string.
import { diffState, isStateKind, STATE_DELTA_VERSION } from '../shared/stateDelta.js';

/** @type {WeakMap<object, Map<string, Snapshot>>} socket → kind → last committed snapshot */
const sockets = new WeakMap();
/** @type {WeakMap<object, Snapshot>} message object → its snapshot */
const snapshots = new WeakMap();
let sequence = 0;
const noop = () => {};
// Terminal phases stay plain m.public: the cluster ingress drops those by type (only the coordinator's receipt
// delivers a result), which it could not do inside a delta.
const TERMINAL_PHASES = new Set(['RESULT', 'ENDED']);
// `{"t":"m.state","kind":"m.private","seq":<n>,"full":` + `}`, with room for a long seq
const FULL_OVERHEAD = 64;

/** Frames and bytes by encoding, for /metrics. */
export const stateDeltaStats = { full: 0, delta: 0, fullBytes: 0, deltaBytes: 0, plainBytesAvoided: 0 };

/**
 * @typedef {{ encoded: string, bytes: number, seq: number, kind: string, view: any, full: string | null,
 *   transitions: WeakMap<Snapshot, { data: string, bytes: number } | null> }} Snapshot
 */

/** hello.stateDelta (browser) or cluster.bind stateDelta (ingress): enable for this socket, or disable. */
export function negotiateStateDelta(ws, version) {
  if (!ws || typeof ws !== 'object') return;
  if (version === STATE_DELTA_VERSION) { if (!sockets.has(ws)) sockets.set(ws, new Map()); }
  else sockets.delete(ws);
}

/** @returns {boolean} */
export const stateDeltaEnabled = (ws) => !!ws && typeof ws === 'object' && sockets.has(ws);

/**
 * The bytes to queue for `msg` (already encoded as `encoded`) on `ws`, and commit() to call once they were queued.
 * Plain `encoded` for a socket without the transport and for any other message.
 * @returns {{ data: string, commit: () => void, usable?: false }}
 */
export function prepareStateFrame(ws, msg, encoded) {
  const states = ws && typeof ws === 'object' ? sockets.get(ws) : undefined;
  const kind = msg?.t;
  if (!states || !isStateKind(kind) || typeof encoded !== 'string'
    || (kind === 'm.public' && TERMINAL_PHASES.has(msg.phase))) return { data: encoded, commit: noop };
  let snapshot = snapshots.get(msg);
  // The encoding, not the (mutable) game object, is the immutable baseline.
  if (!snapshot || snapshot.encoded !== encoded) {
    let view = null;
    // Bytes a caller pre-encoded can be anything: they are no baseline, and the caller encodes the frame itself (usable).
    try { view = JSON.parse(encoded); } catch { /* below */ }
    if (view === null || typeof view !== 'object' || Array.isArray(view)) return { data: encoded, commit: noop, usable: false };
    snapshot = { encoded, bytes: Buffer.byteLength(encoded), seq: ++sequence, kind, view, full: null, transitions: new WeakMap() };
    snapshots.set(msg, snapshot);
  }
  const previous = states.get(kind);
  /** @type {{ data: string, bytes: number } | null | undefined} */
  let delta = null;
  if (previous && previous !== snapshot) {
    delta = snapshot.transitions.get(previous);
    if (delta === undefined) {
      const patch = diffState(previous.view, snapshot.view);
      const data = patch && JSON.stringify({ t: 'm.state', kind, seq: snapshot.seq, base: previous.seq, patch });
      // UTF-8 bytes, not string length; a large change goes out full.
      const bytes = data ? Buffer.byteLength(data) : Infinity;
      delta = bytes < snapshot.bytes + FULL_OVERHEAD ? { data, bytes } : null;
      snapshot.transitions.set(previous, delta);
    }
  }
  const data = delta?.data ?? (snapshot.full ??= `{"t":"m.state","kind":"${kind}","seq":${snapshot.seq},"full":${encoded}}`);
  return {
    data,
    commit() {
      states.set(kind, snapshot);
      if (delta) { stateDeltaStats.delta++; stateDeltaStats.deltaBytes += delta.bytes; stateDeltaStats.plainBytesAvoided += snapshot.bytes; }
      else { stateDeltaStats.full++; stateDeltaStats.fullBytes += snapshot.bytes; }
    },
  };
}

/** The negotiated version, for an internal identity handover on the same socket (server/aiTakeover.js). */
export const stateDeltaVersion = (ws) => (stateDeltaEnabled(ws) ? STATE_DELTA_VERSION : undefined);

/** Forget the baselines of a socket (a client that asked for a full resync): the next frame of every kind is a full one. */
export function resetStateDelta(ws) { if (ws && typeof ws === 'object') sockets.get(ws)?.clear(); }
