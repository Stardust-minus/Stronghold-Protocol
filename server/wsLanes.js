// server/wsLanes.js — the server side of lanes (shared/lanes.js; docs/design/network.md, Lanes): several browser
// WebSockets presented to the rest of the server as ONE ws-like socket.
//
// createLaneHub() gives the WebSocketServer its `handleProtocols` (select the lane token when a browser offers one,
// otherwise ws's default: the first offer) and `adopt(ws)`, called for every upgraded socket:
//   * a plain socket comes back unchanged;
//   * a `new` lane comes back as a LaneBundle — the socket net.js Network / the cluster ingress handle as before;
//   * a `join` lane is attached to its open bundle (or refused with LANE_CLOSE when there is none) and adopt returns
//     null; a join to a full bundle replaces the lane heard from longest ago (one the browser already gave up).
// LaneBundle implements what those callers use of a ws socket: readyState, bufferedAmount, send(data, opts, cb),
// close, terminate, ping, the 'message' / 'pong' / 'close' events and `_socket` (cork/uncork, net.js corkTurn and the
// ingress). It never emits 'error'. Each frame is sent on every open lane with the same seq; frames from the lanes go
// through a LaneMerger, so the caller sees every browser frame once and in order.
//
// A join is answered with laneAck and the bundle's recent frames after the browser's delivered seq (ReplayLog), so a
// frame that went out while one lane was open does not wait for that lane when it is stuck.
// Lanes die alone: a lane whose queue is far behind the best lane's (`lagBytes`), or that answered nothing for a
// whole ping interval while another lane is open, is terminated, and the browser opens a new one. The bundle closes
// when its last lane has closed, when the server closes it (every lane gets that code), or when the merger reports a
// gap no open lane can fill (1011 LANE_GAP). bufferedAmount is the best open lane's, so net.js's backpressure rules
// (skip b.snap above 1 MB, terminate above 16 MB) judge the connection by the lane that works.
import { EventEmitter } from 'node:events';
import { LaneMerger, ReplayLog, MAX_LANES, LANE_CLOSE, laneAck, parseLaneToken, splitLaneBytes } from '../shared/lanes.js';

const OPEN = 1, CLOSING = 2, CLOSED = 3;
const noop = () => {};

/** Counters since start, this process (the cluster's `net` log line). */
export const laneCounters = { bundles: 0, joins: 0, refused: 0, dropped: 0, gaps: 0 };

class LaneBundle extends EventEmitter {
  /** @param {string} id @param {{ lagBytes: number, maxLanes: number }} opts */
  constructor(id, { lagBytes, maxLanes }) {
    super();
    this.id = id;
    this.readyState = OPEN;
    this.protocol = '';
    this.lagBytes = lagBytes;
    this.maxLanes = maxLanes;
    /** @type {Set<{ ws: any, last: number, waiting: boolean }>} */
    this.lanes = new Set();
    this.merger = new LaneMerger();
    /** what this bundle sent lately, replayed to a joining lane (shared/lanes.js, Joining replays) */
    this.log = new ReplayLog();
    this.outSeq = 0;
    this.closeCode = undefined;
    this.closeReason = '';
    const lanes = this.lanes, self = this;
    // One write per lane per turn (net.js corkTurn, ingress cork): cork/uncork every open lane's TCP socket.
    this._socket = {
      get destroyed() { return self.readyState !== OPEN; },
      cork() { for (const lane of lanes) { try { lane.ws._socket?.cork(); } catch { /* a destroyed lane */ } } },
      uncork() { for (const lane of lanes) { try { lane.ws._socket?.uncork(); } catch { /* a destroyed lane */ } } },
    };
  }

  /** Bytes queued on the best open lane (0 without one). */
  get bufferedAmount() {
    let best = Infinity;
    for (const lane of this.lanes) if (lane.ws.readyState === OPEN && lane.ws.bufferedAmount < best) best = lane.ws.bufferedAmount;
    return best === Infinity ? 0 : best;
  }

  get laneCount() { return this.lanes.size; }

  /**
   * @param {any} ws an OPEN server-side ws socket
   * @param {number | null} [ack] a join: the browser's delivered seq — the lane first gets laneAck(ours) and the kept
   *   frames after `ack`, then everything new
   */
  addLane(ws, ack = null) {
    const lane = { ws, last: 0, waiting: false, at: Date.now() };
    this.lanes.add(lane);
    this.merger.addLane(lane);
    ws.on('message', (data, isBinary) => this._message(lane, data, isBinary));
    ws.on('pong', () => { lane.waiting = false; lane.at = Date.now(); if (this.readyState === OPEN) this.emit('pong'); });
    ws.on('error', noop);
    ws.on('close', (code, reason) => this._laneClosed(lane, code, reason));
    if (ack === null) return;
    try {
      ws.send(laneAck(this.merger.seq));
      for (const e of this.log.after(ack)) ws.send(e.frame, e.opts);
    } catch { /* the lane closes itself */ }
  }

  /** ws.send's signature; data keeps its type (a string, or a Buffer the caller marks as text with binary: false). */
  send(data, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = undefined; }
    if (this.readyState !== OPEN) { if (cb) queueMicrotask(() => cb(new Error('WebSocket is not open'))); return; }
    const head = `${++this.outSeq}|`;
    const frame = typeof data === 'string' ? head + data : Buffer.concat([Buffer.from(head), Buffer.isBuffer(data) ? data : Buffer.from(data)]);
    let called = false;
    const done = cb ? (err) => { if (!called) { called = true; cb(err); } } : undefined;
    this.log.add(this.outSeq, frame, frame.length, Date.now(), opts);
    const best = this.bufferedAmount;
    let sent = 0;
    for (const lane of this.lanes) {
      const ws = lane.ws;
      if (ws.readyState !== OPEN) continue;
      if (this.lanes.size > 1 && ws.bufferedAmount - best > this.lagBytes) { laneCounters.dropped++; ws.terminate(); continue; }
      try { ws.send(frame, opts, done); sent++; } catch { /* the lane closes itself */ }
    }
    if (!sent && done) queueMicrotask(() => done(new Error('no open lane')));
  }

  /** The caller's heartbeat: ping every lane; a lane silent since the previous ping goes when another one is open. */
  ping() {
    if (this.readyState !== OPEN) return;
    const several = this.lanes.size > 1;
    for (const lane of this.lanes) {
      if (several && lane.waiting) { laneCounters.dropped++; lane.ws.terminate(); continue; }
      lane.waiting = true;
      try { lane.ws.ping(); } catch { /* the lane closes itself */ }
    }
  }

  close(code, reason) {
    if (this.readyState !== OPEN) return;
    this.readyState = CLOSING;
    this.closeCode = code;
    this.closeReason = reason ?? '';
    for (const lane of this.lanes) {
      try { lane.ws.close(code, reason); } catch { lane.ws.terminate(); }
    }
    if (!this.lanes.size) this._finish(code ?? 1005, this.closeReason);
  }

  terminate() {
    if (this.readyState === CLOSED) return;
    if (this.readyState === OPEN) { this.readyState = CLOSING; this.closeCode = 1006; }
    for (const lane of this.lanes) lane.ws.terminate();
    if (!this.lanes.size) this._finish(1006, '');
  }

  /**
   * A browser joins only while it has fewer lanes than it wants, so a full bundle still holds a lane the browser has
   * already given up (stalled: its close has not reached us). That one — the one heard from longest ago — makes room.
   */
  evictStalest() {
    let stalest = null;
    for (const lane of this.lanes) if (!stalest || lane.at < stalest.at) stalest = lane;
    if (stalest) { laneCounters.dropped++; stalest.ws.terminate(); }
  }

  _message(lane, data, isBinary) {
    lane.waiting = false;
    lane.at = Date.now();
    if (this.readyState !== OPEN) return;
    const frame = isBinary ? null : splitLaneBytes(data);
    if (!frame) { this.close(1002, 'LANE_FRAME'); return; }
    if (frame.seq === 0) return; // lane control: nothing the browser sends needs an answer
    const { deliver, fatal } = this.merger.push(lane, frame.seq, frame.payload, frame.payload.length);
    for (const payload of deliver) {
      this.emit('message', payload, false);
      if (this.readyState !== OPEN) return;
    }
    if (fatal) { if (fatal === 'LANE_GAP') laneCounters.gaps++; this.close(fatal === 'LANE_ORDER' ? 1002 : 1011, fatal); }
  }

  _laneClosed(lane, code, reason) {
    if (!this.lanes.delete(lane)) return;
    const fatal = this.merger.removeLane(lane);
    if (!this.lanes.size) { this._finish(this.closeCode ?? code, this.closeCode === undefined ? reason : this.closeReason); return; }
    if (fatal && this.readyState === OPEN) { laneCounters.gaps++; this.close(1011, fatal); }
  }

  _finish(code, reason) {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit('close', code, Buffer.isBuffer(reason) ? reason : Buffer.from(String(reason ?? '')));
  }
}

function refuse(ws, reason) {
  laneCounters.refused++;
  ws.on('error', noop);
  try { ws.close(LANE_CLOSE, reason); } catch { ws.terminate(); }
}

/**
 * @param {{ enabled?: boolean, maxLanes?: number, lagBytes?: number }} [opts]
 *   enabled false: never select the lane token (every browser falls back to one plain socket)
 */
export function createLaneHub({ enabled = true, maxLanes = MAX_LANES, lagBytes = 1 << 20 } = {}) {
  if (!Number.isInteger(maxLanes) || maxLanes < 1 || maxLanes > MAX_LANES) throw new RangeError('invalid maxLanes');
  /** @type {Map<string, LaneBundle>} */
  const bundles = new Map();
  return {
    enabled,
    get bundles() { return bundles.size; },
    /** WebSocketServer `handleProtocols`: the lane token when offered, else the first offer (ws's default). */
    handleProtocols(protocols) {
      if (enabled) for (const p of protocols) if (parseLaneToken(p)) return p;
      for (const p of protocols) return p;
      return false;
    },
    /** @param {any} ws a just-upgraded socket @returns {any} the socket to hand on, or null (a lane joined/refused) */
    adopt(ws) {
      const token = enabled ? parseLaneToken(ws.protocol) : null;
      if (!token) return ws;
      if (token.mode === 'new') {
        if (bundles.has(token.bundle)) { refuse(ws, 'LANE_TAKEN'); return null; }
        const bundle = new LaneBundle(token.bundle, { lagBytes, maxLanes });
        bundles.set(token.bundle, bundle);
        bundle.once('close', () => { if (bundles.get(token.bundle) === bundle) bundles.delete(token.bundle); });
        bundle.addLane(ws);
        laneCounters.bundles++;
        return bundle;
      }
      const bundle = bundles.get(token.bundle);
      if (!bundle || bundle.readyState !== OPEN) { refuse(ws, 'LANE_UNKNOWN'); return null; }
      if (bundle.laneCount >= maxLanes) bundle.evictStalest();
      bundle.addLane(ws, token.ack);
      laneCounters.joins++;
      return null;
    },
  };
}
