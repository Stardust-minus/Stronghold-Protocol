// shared/lanes.js — one logical WebSocket carried by several ("lanes"; docs/design/network.md, Lanes).
//
// Why: a WebSocket is one TCP connection, and TCP hands nothing to the page behind a lost segment until that segment
// is resent — one round trip at best, a retransmission timeout (200 ms and more) when the loss is the last segment of
// a burst or the resend is lost too. At the 10–20 % loss of a player's last mile in the evening peak that stalls the
// whole stream every few seconds. Every frame goes out on two or three connections instead, and the receiver takes
// whichever copy comes first: a frame is late only when it is late on all of them.
//
// Negotiation: a browser offers the subprotocols [LANES_PLAIN, laneToken(...)]. A server that knows lanes selects the
// lane token (server/wsLanes.js); any other server selects the first offer — the ws library's default — and the
// socket is a plain WebSocket exactly as before. Token: `sp.lanes1.<bundle>.<lane>.<new|join>`, bundle = 22 base64url
// characters (128 random bits) naming the logical socket; `new` opens it, `join` adds a lane to an open one.
//
// Frames: on a lane every text frame is `<seq>|<payload>`. Each direction numbers its logical frames from 1 and sends
// frame n with the same seq on every lane open at that moment, so each lane carries an increasing, gap-free run of
// seqs from the moment it opened. The receiver (LaneMerger) delivers every seq exactly once and in order.
//
// Joining replays: a frame sent while only one lane was open (the first seconds, or after a lane died) exists on that
// lane alone, and when that TCP connection is stuck in retransmission backoff everything behind it waits, whatever the
// other lanes bring. So a join carries the browser's delivered seq in its token (`….join.<seq>`); the server answers
// on the new lane with the control frame `0|{"ack":<its delivered seq>}` and then the frames after the browser's seq
// it still keeps, before anything new; the browser, on that ack, sends the new lane its kept frames after the
// server's seq before anything new. Both keep the last REPLAY_MS / REPLAY_BYTES of what they sent. seq 0 is only ever
// such a control frame and is never delivered.

/** The first (plain) subprotocol offer: what a server without lanes selects. */
export const LANES_PLAIN = 'sp.plain';
/** Lanes per logical socket, the one that opened it included. */
export const MAX_LANES = 3;
/** Close code of a lane refused or dropped by the server while its logical socket goes on (unknown/full bundle). */
export const LANE_CLOSE = 4003;
/** Close code of a logical socket whose lanes can no longer deliver its stream in order (a seq no open lane holds). */
export const LANE_GAP_CLOSE = 4004;

const TOKEN_RE = /^sp\.lanes1\.([A-Za-z0-9_-]{22})\.([0-9]{1,2})\.(?:(new)|join\.([0-9]{1,15}))$/;
/** What each side keeps of its sent frames for a joining lane's replay. */
export const REPLAY_MS = 10_000;
export const REPLAY_BYTES = 128 * 1024;
/** Longest seq prefix (digits) a frame may carry; Number.MAX_SAFE_INTEGER has 16 digits. */
const MAX_SEQ_DIGITS = 15;

/**
 * @param {string} bundle 22 base64url chars @param {number} index @param {'new'|'join'} mode
 * @param {number} [ack] a join: the joining side's delivered seq (what the replay starts after)
 */
export function laneToken(bundle, index, mode, ack = 0) {
  return mode === 'new' ? `sp.lanes1.${bundle}.${index}.new` : `sp.lanes1.${bundle}.${index}.join.${Math.max(0, Math.floor(ack))}`;
}

/** @param {unknown} token @returns {{ bundle: string, index: number, mode: 'new'|'join', ack: number } | null} */
export function parseLaneToken(token) {
  const m = typeof token === 'string' ? TOKEN_RE.exec(token) : null;
  return m ? { bundle: m[1], index: Number(m[2]), mode: m[3] ? 'new' : 'join', ack: m[3] ? 0 : Number(m[4]) } : null;
}

/** The control frame a server sends first on a joined lane. @param {number} ack */
export function laneAck(ack) { return `0|{"ack":${Math.max(0, Math.floor(ack))}}`; }

/**
 * A sender's record of its recent frames, for a joining lane's replay: the last REPLAY_MS and at most REPLAY_BYTES.
 * Frames are whatever the sender passes to its lanes (string or bytes) with their send options.
 */
export class ReplayLog {
  constructor({ ms = REPLAY_MS, bytes = REPLAY_BYTES } = {}) { this.ms = ms; this.max = bytes; this.list = []; this.bytes = 0; }
  /** @param {number} seq @param {any} frame @param {number} size @param {number} at @param {any} [opts] */
  add(seq, frame, size, at, opts) {
    this.list.push({ seq, frame, size, at, opts });
    this.bytes += size;
    while (this.list.length && (this.bytes > this.max || at - this.list[0].at > this.ms)) this.bytes -= this.list.shift().size;
  }
  /** Frames after `seq`, oldest first. @param {number} seq */
  after(seq) {
    let i = this.list.length;
    while (i > 0 && this.list[i - 1].seq > seq) i--;
    return this.list.slice(i);
  }
}

/** @param {number} seq @param {string} payload */
export function laneFrame(seq, payload) { return `${seq}|${payload}`; }

/**
 * Split a lane text frame. @param {unknown} text
 * @returns {{ seq: number, payload: string } | null} null when it is not `<seq>|…` (seq 0: a control frame)
 */
export function splitLaneFrame(text) {
  if (typeof text !== 'string') return null;
  const bar = text.slice(0, MAX_SEQ_DIGITS + 1).indexOf('|');
  if (bar < 1) return null;
  let seq = 0;
  for (let i = 0; i < bar; i++) {
    const c = text.charCodeAt(i);
    if (c < 48 || c > 57) return null;
    seq = seq * 10 + (c - 48);
  }
  return { seq, payload: text.slice(bar + 1) };
}

/**
 * Split a lane frame received as UTF-8 bytes (ws on Node). The payload is a view of the same memory.
 * @param {Uint8Array} bytes @returns {{ seq: number, payload: Uint8Array } | null}
 */
export function splitLaneBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  const end = Math.min(bytes.length, MAX_SEQ_DIGITS + 1);
  let seq = 0, i = 0;
  for (; i < end; i++) {
    const c = bytes[i];
    if (c === 124) break; // '|'
    if (c < 48 || c > 57) return null;
    seq = seq * 10 + (c - 48);
  }
  if (i === 0 || i === end) return null;
  return { seq, payload: bytes.subarray(i + 1) };
}

const NONE = Object.freeze([]);

/**
 * In-order, exactly-once delivery of one direction of a logical socket from its lanes.
 *
 * A lane is any object; the merger keeps `lane.last` (the highest seq it carried). A copy at or below the delivered
 * seq is a duplicate. A seq beyond the next one waits (a lane opened later starts mid-stream, and an older lane may
 * still bring the frames before it). The wait is hopeless once every open lane has carried a seq past the next one —
 * each lane's run is gap-free, so none of them will ever bring it: push / removeLane then report LANE_GAP, and the
 * logical socket must close (its peer restarts from a fresh socket, as after any disconnect).
 */
export class LaneMerger {
  /** @param {{ maxPending?: number, maxPendingBytes?: number }} [opts] */
  constructor({ maxPending = 1024, maxPendingBytes = 8 << 20 } = {}) {
    /** highest seq delivered */
    this.seq = 0;
    /** @type {Map<number, { payload: any, size: number }>} */
    this.pending = new Map();
    this.pendingBytes = 0;
    this.maxPending = maxPending;
    this.maxPendingBytes = maxPendingBytes;
    /** @type {Set<any>} open lanes */
    this.lanes = new Set();
  }

  /** @param {any} lane */
  addLane(lane) { lane.last = 0; this.lanes.add(lane); }

  /** A lane closed. @param {any} lane @returns {string | null} 'LANE_GAP' when the stream can no longer continue */
  removeLane(lane) { this.lanes.delete(lane); return this.check(); }

  /**
   * One frame from a lane. @param {any} lane @param {number} seq @param {any} payload @param {number} [size]
   * @returns {{ deliver: any[], fatal: string | null }} payloads to hand on now, in order; fatal: close the socket
   */
  push(lane, seq, payload, size = 0) {
    if (!(seq > (lane.last || 0))) return { deliver: NONE, fatal: 'LANE_ORDER' };
    lane.last = seq;
    if (seq <= this.seq) return { deliver: NONE, fatal: this.check() };
    if (seq > this.seq + 1) {
      if (!this.pending.has(seq)) {
        this.pending.set(seq, { payload, size });
        this.pendingBytes += size;
        if (this.pending.size > this.maxPending || this.pendingBytes > this.maxPendingBytes) return { deliver: NONE, fatal: 'LANE_BACKLOG' };
      }
      return { deliver: NONE, fatal: this.check() };
    }
    const deliver = [payload];
    this.seq = seq;
    for (let next = this.pending.get(this.seq + 1); next; next = this.pending.get(this.seq + 1)) {
      this.pending.delete(++this.seq);
      this.pendingBytes -= next.size;
      deliver.push(next.payload);
    }
    return { deliver, fatal: this.check() };
  }

  /** @returns {string | null} 'LANE_GAP' when a frame waits for a seq that no open lane can still bring */
  check() {
    if (!this.pending.size) return null;
    const need = this.seq + 1;
    for (const lane of this.lanes) if ((lane.last || 0) < need) return null;
    return 'LANE_GAP';
  }
}
