// The browser side of lanes (shared/lanes.js; docs/design/network.md, Lanes): a WebSocket-compatible object that
// carries one logical socket over up to MAX_LANES real WebSockets, for net.js (`new WS(url)`).
//
// - The first lane offers [LANES_PLAIN, `new` token]. A server that selects the token opens the logical socket and
//   this object becomes OPEN; the other lanes then `join`. A server that selects anything else (an older server,
//   another proxy) gets that one plain WebSocket, passed through untouched.
// - send(): every open lane gets the frame with the same seq. A join carries this side's delivered seq; it carries
//   frames up only after the server's ack (`0|{"ack":n}`), which it answers with the kept frames after n (ReplayLog). Frames from the lanes go through a LaneMerger: onmessage
//   sees each server frame once, in order, as soon as the first copy arrives.
// - A lane that drops (network close 1006, or refused / dropped by the server with LANE_CLOSE) is replaced after a
//   backoff while the others carry the stream; a lane that has not caught up with the delivered stream for
//   LANE_STALL_MS is closed and replaced. Joins refused MAX_REFUSALS times in a row (the lanes were routed to another
//   server process) stop for this socket: it keeps the lanes it has.
// - The logical socket closes (onclose once, with the server's code) when the server closes it — any other close code
//   on a lane — when its last open lane is gone, or when its lanes can no longer deliver the stream in order
//   (LANE_GAP_CLOSE). net.js then reconnects exactly as after a plain socket's close.
import { LANES_PLAIN, MAX_LANES, LANE_CLOSE, LANE_GAP_CLOSE, LaneMerger, ReplayLog, laneToken, laneFrame, splitLaneFrame } from '../../shared/lanes.js';
import { NETQ_LATE_EDGES_MS, bucketOf } from '../../shared/netQuality.js';

/** A lane that has not delivered the latest frame for this long is replaced. */
export const LANE_STALL_MS = 8000;
const CHECK_MS = 1000;
const REJOIN = Object.freeze({ base: 1000, factor: 2, max: 15000, jitter: 0.2 });
const MAX_REFUSALS = 3;
/** A lane open this long resets its slot's rejoin backoff. */
const STABLE_MS = 30000;
/**
 * The joins wait a random [min, max) ms after the first lane opened: after a release every page reconnects at once,
 * and spreading the extra TLS handshakes / gate checks keeps that burst near the size it had with one socket.
 */
export const JOIN_DELAY_MS = Object.freeze({ min: 500, max: 3000 });

const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;
/** First-copy arrival times kept per socket (the later copies of older frames are not measured). */
const FIRST_AT_KEEP = 2048;

/**
 * What every lane socket of this page measured since the last take() (public/js/netQuality.js reports it):
 * late[i] = later copies of a server frame per NETQ_LATE_EDGES_MS bucket of their delay after the first copy, and the
 * lanes lost / replaced as stalled / refused.
 */
export const laneMetrics = {
  late: new Array(NETQ_LATE_EDGES_MS.length + 1).fill(0), lost: 0, stalled: 0, refused: 0,
  take() {
    const out = { late: this.late.slice(), lost: this.lost, stalled: this.stalled, refused: this.refused };
    this.late.fill(0); this.lost = this.stalled = this.refused = 0;
    return out;
  },
};

function bundleId(random) {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A WebSocket constructor carrying each socket over `lanes` WebSockets (1: a plain WebSocket).
 * @param {{ lanes?: number, WebSocket?: any, timers?: { setTimeout: Function, clearTimeout: Function,
 *   setInterval: Function, clearInterval: Function }, now?: () => number, random?: () => number,
 *   joinDelayMs?: { min: number, max: number }, onStats?: (stats: object) => void }} [opts]
 */
export function laneWebSocket(opts = {}) {
  const want = Math.max(1, Math.min(MAX_LANES, Math.floor(Number(opts.lanes) || 0)));
  const Impl = opts.WebSocket || globalThis.WebSocket;
  if (want <= 1) return Impl;
  const timers = opts.timers || {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms), clearInterval: (id) => globalThis.clearInterval(id),
  };
  const now = opts.now || (() => (globalThis.performance?.now ? globalThis.performance.now() : Date.now()));
  const random = opts.random || Math.random;
  const joinDelay = opts.joinDelayMs || JOIN_DELAY_MS;

  return class LaneWebSocket {
    static CONNECTING = CONNECTING;
    static OPEN = OPEN;
    static CLOSING = CLOSING;
    static CLOSED = CLOSED;

    /** @param {string} url */
    constructor(url) {
      this.url = url;
      this.readyState = CONNECTING;
      this.protocol = '';
      this.extensions = '';
      this.binaryType = 'blob';
      this.onopen = this.onmessage = this.onerror = this.onclose = null;
      /** 'lanes' | 'plain' once the first lane opened */
      this.mode = null;
      this.stats = { lanesOpened: 0, lanesLost: 0, lanesStalled: 0, refusals: 0, duplicates: 0 };
      this._id = bundleId(random);
      this._merger = new LaneMerger();
      this._log = new ReplayLog();
      /** @type {Map<number, number>} seq → when its first copy arrived */
      this._firstAt = new Map();
      this._lanes = new Set();      // open lanes
      this._connecting = new Set(); // lanes in their handshake
      this._outSeq = 0;
      this._nextIndex = 1;
      this._refusals = 0;
      this._joinable = true;
      this._rejoinTimers = new Set();
      this._attempts = 0;
      this._check = null;
      this._primary = this._open(0, 'new');
      if (!this._primary) {
        this.readyState = CLOSED;
        timers.setTimeout(() => this._emitClose({ code: 1006, reason: '', wasClean: false }), 0);
      }
    }

    get bufferedAmount() {
      if (this.mode === 'plain') return this._primary.ws.bufferedAmount;
      let best = Infinity;
      for (const lane of this._lanes) if (lane.ready && lane.ws.bufferedAmount < best) best = lane.ws.bufferedAmount;
      return best === Infinity ? 0 : best;
    }

    /** Open lanes (1 for a plain socket while it is open). */
    get laneCount() { return this.mode === 'plain' ? (this.readyState === OPEN ? 1 : 0) : this._lanes.size; }

    send(data) {
      if (this.readyState === CONNECTING) throw new Error('InvalidStateError: still connecting');
      if (this.readyState !== OPEN) return;
      if (this.mode === 'plain') { this._primary.ws.send(data); return; }
      const frame = laneFrame(++this._outSeq, String(data));
      this._log.add(this._outSeq, frame, frame.length, now());
      for (const lane of this._lanes) {
        if (!lane.ready) continue; // a join waits for the server's ack, then gets the replay first
        try { lane.ws.send(frame); } catch { /* that lane closes itself */ }
      }
    }

    close(code, reason) {
      if (this.readyState === CLOSING || this.readyState === CLOSED) return;
      if (this.mode === 'plain') { this.readyState = CLOSING; this._primary.ws.close(code, reason); return; }
      this.readyState = CLOSING;
      this._stopTimers();
      for (const lane of [...this._lanes, ...this._connecting]) this._closeLane(lane, code, reason);
      // like a browser socket, onclose comes later; the lanes' own close handshakes are not waited for
      const ev = { code: code ?? 1005, reason: reason ?? '', wasClean: true };
      timers.setTimeout(() => { if (this.readyState !== CLOSED) { this.readyState = CLOSED; this._emitClose(ev); } }, 0);
    }

    // ---- lanes ---------------------------------------------------------------------------------------------------

    _open(index, mode) {
      const token = laneToken(this._id, index, mode, this._merger.seq);
      let ws;
      try { ws = new Impl(this.url, [LANES_PLAIN, token]); } catch { return null; }
      const lane = { ws, index, token, last: 0, open: false, ours: false, ready: mode === 'new', behindSince: null, openedAt: 0 };
      this._connecting.add(lane);
      ws.onopen = () => this._laneOpen(lane);
      ws.onmessage = (ev) => this._laneMessage(lane, ev);
      ws.onerror = () => { /* followed by close */ };
      ws.onclose = (ev) => this._laneClose(lane, ev || {});
      return lane;
    }

    _closeLane(lane, code = 1000, reason = '') {
      lane.ours = true;
      this._lanes.delete(lane);
      this._connecting.delete(lane);
      try { lane.ws.close(code, reason); } catch { /* ignore */ }
    }

    _laneOpen(lane) {
      this._connecting.delete(lane);
      if (lane.ours || this.readyState === CLOSING || this.readyState === CLOSED) { this._closeLane(lane); return; }
      const lanes = lane.ws.protocol === lane.token;
      if (lane === this._primary) {
        if (!lanes) {
          // not a lanes server: this is a plain WebSocket from now on
          this.mode = 'plain';
          this.protocol = lane.ws.protocol || '';
          this.extensions = lane.ws.extensions || '';
          this.readyState = OPEN;
          lane.ws.onmessage = (ev) => this.onmessage?.(ev);
          lane.ws.onclose = (ev) => { this.readyState = CLOSED; this.onclose?.(ev); };
          lane.ws.onerror = (ev) => this.onerror?.(ev);
          this.onopen?.({ type: 'open' });
          return;
        }
        this.mode = 'lanes';
        this._addLane(lane);
        this.readyState = OPEN;
        this._check = timers.setInterval(() => this._health(), CHECK_MS);
        this.onopen?.({ type: 'open' });
        if (this.readyState === OPEN) this._later(joinDelay.min + random() * Math.max(0, joinDelay.max - joinDelay.min));
        return;
      }
      if (!lanes) { this._joinable = false; this._closeLane(lane); return; }
      this._addLane(lane);
    }

    _addLane(lane) {
      lane.open = true;
      lane.openedAt = now();
      this._lanes.add(lane);
      this._merger.addLane(lane);
      this.stats.lanesOpened++;
    }

    _laneMessage(lane, ev) {
      if (!lane.open || lane.ours || this.readyState !== OPEN) return;
      const frame = splitLaneFrame(ev?.data);
      if (!frame) { this._fail('LANE_FRAME'); return; }
      if (frame.seq === 0) { this._control(lane, frame.payload); return; }
      const before = this._merger.seq;
      const at = now();
      const first = this._firstAt.get(frame.seq);
      if (first === undefined) {
        this._firstAt.set(frame.seq, at);
        this._firstAt.delete(frame.seq - FIRST_AT_KEEP);
      } else if (first >= lane.openedAt) {
        // (a join's replay of frames another lane delivered before it opened is not a delay of this connection)
        laneMetrics.late[bucketOf(NETQ_LATE_EDGES_MS, at - first)]++;
      }
      const { deliver, fatal } = this._merger.push(lane, frame.seq, frame.payload, frame.payload.length);
      if (frame.seq <= before) this.stats.duplicates++;
      if (lane.last >= this._merger.seq) lane.behindSince = null;
      if (this._merger.seq > before) {
        for (const other of this._lanes) if (other !== lane && other.last < this._merger.seq && other.behindSince === null) other.behindSince = at;
      }
      for (const payload of deliver) {
        this.onmessage?.({ data: payload, type: 'message' });
        if (this.readyState !== OPEN) return;
      }
      if (fatal) this._fail(fatal);
    }

    /** `0|{"ack":n}` on a join: the server attached it and delivered our frames through n. */
    _control(lane, payload) {
      let msg = null;
      try { msg = JSON.parse(payload); } catch { /* ignored below */ }
      if (!msg || !Number.isSafeInteger(msg.ack) || msg.ack < 0) { this._fail('LANE_FRAME'); return; }
      this._refusals = 0; // a refused join gets no frame, only LANE_CLOSE
      if (lane.ready) return;
      try { for (const e of this._log.after(msg.ack)) lane.ws.send(e.frame); } catch { /* that lane closes itself */ }
      lane.ready = true;
    }

    _laneClose(lane, ev) {
      const wasOpen = lane.open;
      lane.open = false;
      this._connecting.delete(lane);
      this._lanes.delete(lane);
      if (this.readyState === CLOSING || this.readyState === CLOSED) return;
      if (lane === this._primary && !wasOpen && this.mode === null) {
        // the first lane never opened: this socket failed to connect
        this.readyState = CLOSED;
        this._emitClose(ev);
        return;
      }
      if (lane.ours) return;
      const laneLevel = ev.code === 1006 || ev.code === LANE_CLOSE;
      if (!laneLevel) { this._shutdown(ev); return; } // the server closed the logical socket
      // the server upgrades a join before it decides, so a refused join opens and then closes with LANE_CLOSE
      if (ev.code === LANE_CLOSE) {
        this.stats.refusals++;
        laneMetrics.refused++;
        if (++this._refusals >= MAX_REFUSALS) this._joinable = false;
      } else if (wasOpen) { this.stats.lanesLost++; laneMetrics.lost++; }
      const fatal = wasOpen ? this._merger.removeLane(lane) : this._merger.check();
      if (!this._lanes.size) { this._shutdown(ev); return; }
      if (fatal) { this._fail(fatal); return; }
      this._rejoinLater();
    }

    /** Open joins until `want` lanes are open or connecting. */
    _fill() {
      if (this.readyState !== OPEN || !this._joinable) return;
      while (this._lanes.size + this._connecting.size + this._rejoinTimers.size < want) {
        const index = this._nextIndex++;
        if (index > 99) { this._joinable = false; return; }
        if (!this._open(index, 'join')) { this._joinable = false; return; }
      }
    }

    _rejoinLater() {
      if (!this._joinable || this.readyState !== OPEN) return;
      const raw = Math.min(REJOIN.max, REJOIN.base * REJOIN.factor ** Math.min(10, this._attempts++));
      this._later(Math.max(100, Math.round(raw + raw * REJOIN.jitter * (random() * 2 - 1))));
    }

    /** _fill after `delay` ms (a pending timer counts as a lane on its way). */
    _later(delay) {
      const id = timers.setTimeout(() => { this._rejoinTimers.delete(id); this._fill(); }, delay);
      this._rejoinTimers.add(id);
    }

    _health() {
      if (this.readyState !== OPEN) return;
      const at = now();
      let stable = false;
      for (const lane of [...this._lanes]) {
        if (at - lane.openedAt >= STABLE_MS) stable = true;
        if (this._lanes.size > 1 && lane.behindSince !== null && at - lane.behindSince >= LANE_STALL_MS) {
          this.stats.lanesStalled++;
          laneMetrics.stalled++;
          this._closeLane(lane, 4000, 'lane stalled');
          const fatal = this._merger.removeLane(lane);
          if (fatal) { this._fail(fatal); return; }
          this._rejoinLater();
        }
      }
      if (stable && !this._rejoinTimers.size) this._attempts = 0;
    }

    _fail(reason) {
      this._shutdown({ code: LANE_GAP_CLOSE, reason, wasClean: false }, LANE_GAP_CLOSE, reason);
    }

    /** Close every lane and report `ev` as this socket's close. */
    _shutdown(ev, code = 1000, reason = '') {
      if (this.readyState === CLOSED) return;
      this._stopTimers();
      for (const lane of [...this._lanes, ...this._connecting]) this._closeLane(lane, code, reason);
      this.readyState = CLOSED;
      this._emitClose(ev);
    }

    _stopTimers() {
      if (this._check !== null) { timers.clearInterval(this._check); this._check = null; }
      for (const id of this._rejoinTimers) timers.clearTimeout(id);
      this._rejoinTimers.clear();
    }

    _emitClose(ev) {
      opts.onStats?.({ ...this.stats, mode: this.mode });
      this.onclose?.({ type: 'close', code: ev?.code ?? 1006, reason: ev?.reason ?? '', wasClean: !!ev?.wasClean });
    }
  };
}
