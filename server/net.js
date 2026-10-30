// server/net.js — WebSocket session layer (DESIGN §1, §8).
//
// Responsibilities:
//   * Session objects (playerId, secret reconnect token, name, bound socket, connection state) and the
//     SessionRegistry that resolves reconnect tokens and expires sessions after the reconnect window (10 min; the
//     lobby may extend it per session via `session.resumeWindowMs` — a solo run: 24 h, see server/lobby.js).
//   * Per-connection pipeline: token-bucket rate limit (40 msg/s) → JSON decode → schema validation
//     (shared/protocol.js) → `hello`/`ping` handling → dispatch to the lobby handler → `ok`/`error`
//     reply echoing the request id (`rid`). Intents whose answer is a large state resend (`g.watch` →
//     m.field) also draw from a second, much smaller bucket (2/s, burst 6), so one socket cannot turn
//     40 tiny requests per second into hundreds of KB/s of downstream traffic.
//   * Client address per connection (`clientAddress`): the socket peer, or — when the peer is a local
//     reverse proxy (loopback / private address, e.g. `cloudflared tunnel --url http://localhost:3000`) —
//     the address it forwards (CF-Connecting-IP, X-Real-IP, rightmost X-Forwarded-For). Its `key` (IPv4
//     address or IPv6 /64) is what per-network limits count against: concurrent sockets here
//     (`maxConnectionsPerAddr`, checked at upgrade time through `admission`), rooms and running matches
//     in server/lobby.js. Local / LAN peers without a forwarding header (dev machine, tests, LAN party)
//     have no key and are never limited per address.
//   * Heartbeat (ws ping/pong every `heartbeatMs`, dead sockets terminated), hello timeout. The sockets are split
//     round-robin into ~1 s slices of the interval (HEARTBEAT_SLICE_MS), so one tick pings 1/N of them instead of
//     every socket at once; each socket is still pinged once per `heartbeatMs` and dropped after one missed interval.
//   * Send helpers that never throw, with a backpressure guard: non-critical `b.snap` frames are skipped
//     while the socket has more than 1 MB queued; a socket with more than 16 MB queued is terminated
//     (the client reconnects and receives a full state resync).
//
// Close codes used by the server (clients should NOT auto-reconnect on 4001):
//   4001 session replaced (the same token connected from another socket/tab)
//   4002 hello timeout
//   1008 abusive flooding (rate-limit drops > abuseDropsPerSec)
//   1001 server shutdown
//
// The handler object (implemented by server/lobby.js) receives:
//   onHello(session, { resumed, repeat })  after `welcome` was sent (`session.owner`: this hello carried the 服主 key,
//                                          server/ownerFile.js — decided again on every hello)
//   welcomeInfo() → object (optional)      extra fields of every `welcome` (never one of its own keys): the lobby's
//                                          `diyKitted` (0.2.0 自选编队 — which operators a DIY slot may field) and
//                                          `content` ({ vanilla: <cs> }, the server's content hash — DESIGN §32)
//   onMessage(session, msg) → { ok: true } | { error: ERR code, detail?: string } | undefined — or a Promise of one
//                                          (a room whose match runs in a match host worker, DESIGN §32.6: the reply
//                                          goes out when it settles; a rejection is INTERNAL)
//   routeGame(session, msg) → same (optional): client-side combat reports `b.progress` / `b.result` (DESIGN §14) go
//                                          straight to the running match through it; without it they reach onMessage
//   onDisconnect(session)                  the session's socket closed (session kept for the reconnect window)
//   onExpire(session)                      the session was purged (disconnected longer than the window)

import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { C2S, validateC2S, normalizeServerLoad, normalizeLoadDetails } from '../shared/protocol.js';
import { normalizeClusterLoad } from '../shared/cluster-load.js';
import { ERR, ERR_TEXT, PROTOCOL_VERSION, MATCHMAKING_VERSION } from '../shared/constants.js';
import { PLAYER_CAPACITY_VERSION } from '../shared/playerCapacity.js';
import { isCompressibleType } from './wsCompression.js';
import { negotiateStateDelta, prepareStateFrame, resetStateDelta } from './stateTransport.js';
import { moderateName } from '../shared/names.js';
import { NO_PHASES } from './phaseMetrics.js';
import { serverFullDetail } from './onlineLimit.js';
import { NAME_RESERVED } from './ownerFile.js';
export { sanitizeName } from '../shared/names.js';

/** Tunables (all overridable through the Network / SessionRegistry constructors). */
/** Every lobby heartbeat carries the same public cluster summary: normalize it at most once per this many ms. */
export const CLUSTER_LOAD_CACHE_MS = 1000;
/**
 * A connection gets the whole cluster summary (several KB uncompressed with 32 nodes) at most once per this many ms, or
 * when its ping asks for it (`full: true`: the service dialog is open, or the browser holds no lobby summary); the
 * pongs between say `clusterLoadSame: true` (the browser keeps the summary it has).
 */
export const CLUSTER_LOAD_EVERY_MS = 10_000;
/** Target spacing of heartbeat slices; at most HEARTBEAT_SLICES_MAX slices per interval (1 below ~1.5 s). */
export const HEARTBEAT_SLICE_MS = 1000;
export const HEARTBEAT_SLICES_MAX = 30;

export const NET_DEFAULTS = Object.freeze({
  ratePerSec: 40,               // token bucket refill rate
  rateBurst: 40,                // token bucket capacity
  abuseDropsPerSec: 400,        // rate-limited messages within one second before the socket is closed (1008)
  heartbeatMs: 30_000,          // ping interval; a socket that missed one full interval is terminated
  helloTimeoutMs: 30_000,       // sockets that never say hello are closed (4002)
  reconnectWindowMs: 10 * 60_000, // disconnected sessions stay resumable this long
  snapDropBytes: 1 << 20,       // skip b.snap while bufferedAmount exceeds this
  hardBufferBytes: 16 << 20,    // terminate a socket whose send queue exceeds this
  maxConnections: 0,            // concurrent sockets (0 = unlimited; enforced at upgrade time)
  maxConnectionsPerAddr: 0,     // concurrent sockets per client network key (0 = unlimited); see clientAddress
  maxSessions: 0,               // registry cap (0 = unlimited); finite caps evict oldest idle sessions first
  maxOnline: 0,                 // authenticated players admitted at once (0 = unlimited); a resume is never refused
  heavyPerSec: 2,               // refill of the bucket for resend-heavy intents (HEAVY_TYPES)
  heavyBurst: 6,
  trustProxy: 'auto',           // forwarding headers: 'auto' = from loopback/private peers only, true = always, false = never
  allowAsyncHandlers: false,    // explicit opt-in (the coordinator; a server with match hosts — http/websocket.js)
});

/**
 * Intents that also draw from the per-connection heavy bucket: g.watch (its reply is a large state resend, m.field),
 * room.loadout (a ≤ 160-entry map and ≤ 256 operator settings validated against the game data; the client debounces its
 * edits), room.ownership (a ≤ 160-id list), room.diy (≤ 8 自选 picks), room.skins (whitelisted display choices), room.spectate
 * (taking a spectator seat in a running match resends its state like a watcher's g.watch — server/lobby.js spectate) and
 * room.setPlugins (a new visual set: every member downloads its art manifest — server/plugins/visualSet.js).
 * room.skins (docs/SKINS.md) is a small `{ [charId]: skinId }` map, sent on every edit of the appearance; a changed map
 * re-broadcasts room.state to a waiting room (its seat cards wear it: room.state seats[].skins). room.card (名片干员, PR
 * #643 split 6): every accepted change re-broadcasts room.state to the room. room.rerollSetup (重刷本局): with one human a
 * start completes at once and clears that seat's 30 s cooldown, and each reroll rebuilds the opening and resends m.public
 * to every connection (server/match/match/setupVote.js, DESIGN §35.47). Any seated player may start it (#860).
 * room.proposeVersion (DESIGN §35.23) stays host-proposed: an accepted proposal by a lone human switches the room's
 * version — every page then downloads that version's data.
 */
export const HEAVY_TYPES = new Set(['g.watch', 'room.loadout', 'room.ownership', 'room.diy', 'room.skins', 'room.card', 'queue.join', 'room.spectate', 'room.setPlugins', 'room.rerollSetup', 'room.proposeVersion', 'state.resync']);

/** Close codes (see header). */
export const CLOSE = Object.freeze({ REPLACED: 4001, HELLO_TIMEOUT: 4002, POLICY: 1008, SHUTDOWN: 1001 });

const WS_OPEN = 1;
const MAX_RID = 2 ** 31;
/** Phase names of the validated message types (bounded by C2S), built once per type. */
const MESSAGE_PHASES = new Map();
const messagePhase = (t) => {
  let name = MESSAGE_PHASES.get(t);
  if (!name) { name = `ws.${t}`; MESSAGE_PHASES.set(t, name); }
  return name;
};
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

// ---------------------------------------------------------------------------------------------------
// Session & registry
// ---------------------------------------------------------------------------------------------------

/** One logical player identity; survives socket reconnects for the reconnect window. */
export class Session {
  /**
   * @param {{ playerId: string, token: string, name: string, now?: number }} init
   */
  constructor({ playerId, token, name, now = Date.now() }) {
    /** @type {string} public id, shared with other players */
    this.playerId = playerId;
    /** @type {string} secret 128-bit hex reconnect token (only ever sent to its owner) */
    this.token = token;
    /** @type {string} sanitized nickname */
    this.name = name;
    /** @type {import('ws').WebSocket | null} currently bound socket */
    this.ws = null;
    /** @type {boolean} */
    this.connected = false;
    /** @type {number | null} local first-welcome stamp of the attached client (optional, not authentication) */
    this.claimAt = null;
    /** @type {number} ms epoch of the last inbound frame / pong */
    this.lastSeen = now;
    /** @type {number | null} ms epoch when the socket was lost (null while connected) */
    this.disconnectedAt = now;
    /** @type {string | null} room code — owned and maintained by server/lobby.js */
    this.roomCode = null;
    /** @type {string | null} pending `room.closed` reason to deliver on the next resume (lobby-owned) */
    this.notice = null;
    /** @type {string[] | null} encoded frames (final m.public + m.result) to deliver on the next resume (lobby-owned) */
    this.pendingResult = null;
    /** @type {number} ms epoch of the last full match resync (lobby-owned; throttles repeated hellos) */
    this.resyncAt = -Infinity;
    /** @type {number} ms epoch of the last presence.state sent to this session (lobby-owned; in-match refresh rate) */
    this.presenceAt = -Infinity;
    /** @type {Record<string, { skill: number, module: string|null }> | null} checked operator loadout (lobby-owned, DESIGN §16) */
    this.loadout = null;
    /** @type {Readonly<Record<string, { potential: number, cultivate: number }>> | null} checked per-operator 潜能 / 练度 (lobby-owned, 0.2.2; room.loadout `ops`) */
    this.ops = null;
    /** @type {readonly string[] | null} checked not-owned chess ids (干员持有, lobby-owned, 0.2.0 补位) */
    this.notOwned = null;
    /** @type {Readonly<Record<string, { charId: string, skillIndex: number, uniEquipId: string|null }>> | null} checked 自选 picks (lobby-owned, 0.2.0 自选编队) */
    this.diy = null;
    /** @type {Readonly<Record<string, string>>} display-only skin choices (lobby-owned) */
    this.skins = Object.freeze({});
    /** @type {Readonly<{ charId?: string, avatar?: string, bg?: string, trophies?: number }> | null} display card (lobby-owned, room.card) */
    this.card = null;
    /** @type {boolean} the latest hello carried the owner's key (服主, server/ownerFile.js); decided again on every hello */
    this.owner = false;
    /** @type {string} client address of the latest connection (logging) */
    this.addr = '?';
    /** @type {string | null} per-network limit key of the latest connection (null = not limited), see clientAddress */
    this.limitKey = null;
    /** Explicit hello capability; legacy clients without it cannot enter public matchmaking. */
    this.matchmakingVersion = null;
    /** Legacy clients remain compatible with ordinary rooms, not expanded rooms. */
    this.playerCapacityVersion = null;
    /**
     * @type {number | null} lobby-owned extension of the reconnect window for this session (ms; null = the registry's
     * window). A solo run keeps its session resumable for the official `singleReconnectTime` (24 h) — see lobby.js; so
     * does a dropped co-op player while another player of its match is online (Lobby.refreshMatchWindows).
     */
    this.resumeWindowMs = null;
    /** lobby-owned: `resumeWindowMs` holds the session for its running co-op match (Lobby.refreshMatchWindows) */
    this.matchHeld = false;
  }
}

/** Random 128-bit hex token. */
export const newToken = () => randomBytes(16).toString('hex');

/** Registry of sessions by playerId and by token; purges sessions disconnected longer than the window. */
export class SessionRegistry {
  /**
   * @param {{ reconnectWindowMs?: number, maxSessions?: number, now?: () => number }} [opts]
   */
  constructor({ reconnectWindowMs = NET_DEFAULTS.reconnectWindowMs, maxSessions = NET_DEFAULTS.maxSessions, now = Date.now } = {}) {
    this.reconnectWindowMs = reconnectWindowMs;
    this.maxSessions = maxSessions;
    this.now = now;
    /** @type {Map<string, Session>} */ this.byPlayerId = new Map();
    /** @type {Map<string, Session>} */ this.byTokenMap = new Map();
  }

  get size() { return this.byPlayerId.size; }

  /**
   * Create a new session with a fresh playerId and token. Evicts the oldest idle (disconnected, roomless)
   * session when the registry is full. Returns null when full of active sessions.
   * @param {string} name
   * @returns {Session | null}
   */
  create(name) {
    if (this.maxSessions > 0 && this.byPlayerId.size >= this.maxSessions && !this.evictOne()) return null;
    let playerId;
    do playerId = 'p_' + randomBytes(5).toString('hex'); while (this.byPlayerId.has(playerId));
    let token;
    do token = newToken(); while (this.byTokenMap.has(token));
    const s = new Session({ playerId, token, name, now: this.now() });
    this.byPlayerId.set(playerId, s);
    this.byTokenMap.set(token, s);
    return s;
  }

  /** @param {unknown} token @returns {Session | null} a live (non-expired) session for this token */
  byToken(token) {
    if (typeof token !== 'string' || token.length === 0) return null;
    const s = this.byTokenMap.get(token);
    if (!s) return null;
    if (this.isExpired(s, this.now())) return null;
    return s;
  }

  /** @param {string} playerId @returns {Session | null} */
  byId(playerId) { return this.byPlayerId.get(playerId) || null; }

  /** @param {Session} s */
  remove(s) {
    if (this.byPlayerId.get(s.playerId) === s) this.byPlayerId.delete(s.playerId);
    if (this.byTokenMap.get(s.token) === s) this.byTokenMap.delete(s.token);
  }

  /**
   * The reconnect window of one session: the registry's, or the session's own `resumeWindowMs` when that is longer
   * (the lobby may only extend it, never shorten it).
   * @param {Session} s @returns {number} ms
   */
  windowOf(s) {
    const own = s.resumeWindowMs;
    return typeof own === 'number' && own > this.reconnectWindowMs ? own : this.reconnectWindowMs;
  }

  /** @param {Session} s @param {number} now */
  isExpired(s, now) {
    return !s.connected && s.disconnectedAt != null && now - s.disconnectedAt > this.windowOf(s);
  }

  /**
   * Remove and return every session whose reconnect window has elapsed.
   * @param {number} [now]
   * @returns {Session[]}
   */
  sweep(now = this.now()) {
    const out = [];
    for (const s of this.byPlayerId.values()) if (this.isExpired(s, now)) out.push(s);
    for (const s of out) this.remove(s);
    return out;
  }

  /** Evict the oldest disconnected session that is not in a room. @returns {boolean} */
  evictOne() {
    for (const s of this.byPlayerId.values()) {
      if (!s.connected && !s.roomCode) { this.remove(s); return true; }
    }
    return false;
  }

  /** @returns {IterableIterator<Session>} */
  all() { return this.byPlayerId.values(); }
}

// ---------------------------------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------------------------------

/** Classic token bucket: `burst` capacity, refilled continuously at `ratePerSec`. */
export class TokenBucket {
  /** @param {number} ratePerSec @param {number} burst @param {number} now ms */
  constructor(ratePerSec, burst, now) {
    this.rate = ratePerSec / 1000;
    this.burst = burst;
    this.tokens = burst;
    this.at = now;
  }

  /** Consume one token. @param {number} now ms @returns {boolean} false when rate-limited */
  take(now) {
    const dt = Math.max(0, now - this.at);
    this.at = now;
    this.tokens = Math.min(this.burst, this.tokens + dt * this.rate);
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------
// Send helpers (never throw)
// ---------------------------------------------------------------------------------------------------

/**
 * JSON-encode a message; returns null (and never throws) on unserializable input.
 * @param {object} msg
 * @returns {string | null}
 */
export function encode(msg) {
  try {
    const s = JSON.stringify(msg);
    return typeof s === 'string' ? s : null;
  } catch {
    return null;
  }
}

const onSendDone = (err) => { void err; }; // errors surface through the socket's 'error'/'close' events

/**
 * Backpressure since start, this process (after xinhai-ai's droppedSnapshots / slowDisconnects): b.snap frames skipped
 * on a congested socket (also an ingress / game node's own pre-bind queues) and sockets terminated past the hard
 * limit. Shown in /healthz `net`; a cluster process logs them (cluster/start.mjs).
 */
export const netCounters = { snapDropped: 0, backpressureClosed: 0 };

const corkedSockets = new WeakSet();
const uncorkTurn = (socket) => {
  corkedSockets.delete(socket);
  try { socket.uncork(); } catch { /* a destroyed socket has nothing left to flush */ }
};

/**
 * Coalesce the frames a WebSocket is sent during the current turn into one socket write: cork it now, uncork it on
 * process.nextTick (before any I/O, timer or immediate runs). Frames, their order and every sendRaw limit are unchanged:
 * ws.bufferedAmount still counts the corked bytes. A no-op for a socket that is already corked this turn. Never throws.
 * @param {any} ws
 */
export function corkTurn(ws) {
  const socket = ws?._socket;
  if (!socket || corkedSockets.has(socket) || socket.destroyed || typeof socket.cork !== 'function') return;
  try { socket.cork(); } catch { return; }
  corkedSockets.add(socket);
  process.nextTick(uncorkTurn, socket);
}

/**
 * Send an already-encoded frame. Skips when the socket is not OPEN, when `droppable` and the socket is
 * congested (> 1 MB queued), and terminates sockets whose queue exceeds 16 MB. A Buffer must hold the UTF-8
 * of a JSON text (built once for many members, e.g. cluster.terminal) and is still sent as a TEXT frame.
 * @param {import('ws').WebSocket | null | undefined} ws
 * @param {string | Buffer} data
 * @param {{ droppable?: boolean, compress?: boolean }} [opts]
 * @returns {boolean} true when the frame was queued
 */
export function sendRaw(ws, data, { droppable = false, compress = false } = {}) {
  if (!ws || ws.readyState !== WS_OPEN || (typeof data !== 'string' && !Buffer.isBuffer(data))) return false;
  try {
    const queued = ws.bufferedAmount;
    if (queued > NET_DEFAULTS.hardBufferBytes) { netCounters.backpressureClosed++; ws.terminate(); return false; }
    if (droppable && queued > NET_DEFAULTS.snapDropBytes) { netCounters.snapDropped++; return false; }
    // A Buffer would default to a binary frame: say text explicitly; string sends keep their exact options.
    ws.send(data, typeof data === 'string' ? { compress: compress === true } : { compress: compress === true, binary: false }, onSendDone);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send one already-encoded frame to many sockets with sendRaw's per-socket rules. Sockets that ride an ingress link
 * (cluster/link-server.js LinkSocket) are grouped per link into ONE fanout frame; direct sockets get their own send.
 * Each socket still receives the frame at this point of its own stream. Never throws.
 * @param {Iterable<any>} sockets @param {string | Buffer} data @param {{ droppable?: boolean, compress?: boolean }} [opts]
 * @returns {number} sockets the frame was queued for
 */
export function sendEncodedMany(sockets, data, opts = {}) {
  return sendEncodedParts([...sockets].map((ws) => ({ ws })), data, opts);
}

/**
 * Like sendEncodedMany, but socket i receives prefix_i + shared + suffix_i (a large shared middle, e.g. the final public
 * frame inside every member's cluster.terminal, is copied once per link instead of once per member). Never throws.
 * @param {{ ws: any, prefix?: Buffer, suffix?: Buffer }[]} entries @param {string | Buffer} shared
 * @param {{ droppable?: boolean, compress?: boolean }} [opts]
 */
export function sendEncodedParts(entries, shared, { droppable = false, compress = false } = {}) {
  if (typeof shared !== 'string' && !Buffer.isBuffer(shared)) return 0;
  const links = new Map();
  let sent = 0, sharedBytes = null;
  for (const { ws, prefix, suffix } of entries) {
    try {
      if (ws && ws.linked === true && ws.link && typeof ws.link.fanout === 'function') {
        if (ws.readyState !== WS_OPEN) continue;
        const queued = ws.bufferedAmount;
        if (queued > NET_DEFAULTS.hardBufferBytes) { netCounters.backpressureClosed++; ws.terminate(); continue; }
        if (droppable && queued > NET_DEFAULTS.snapDropBytes) { netCounters.snapDropped++; continue; }
        let targets = links.get(ws.link);
        if (!targets) { targets = []; links.set(ws.link, targets); }
        targets.push({ socket: ws, prefix, suffix });
        sent++;
      } else {
        const whole = prefix?.length || suffix?.length
          ? Buffer.concat([prefix || Buffer.alloc(0), (sharedBytes ??= Buffer.isBuffer(shared) ? shared : Buffer.from(shared)), suffix || Buffer.alloc(0)])
          : shared;
        if (sendRaw(ws, whole, { droppable, compress })) sent++;
      }
    } catch { /* one socket never breaks the others */ }
  }
  for (const [link, targets] of links) {
    try { link.fanout(targets, shared); } catch { /* the link drops itself */ }
  }
  return sent;
}

/** True for frames that may be skipped under backpressure (only battle snapshots). */
export const isDroppable = (msg) => !!msg && msg.t === 'b.snap';

/**
 * Encode and send one message to a socket. Never throws.
 * @param {import('ws').WebSocket | null | undefined} ws
 * @param {object} msg
 * @param {string | null} [encoded] bytes a caller already produced; must be this message when it is a state kind
 * @returns {boolean}
 */
export function send(ws, msg, encoded = null) {
  const data = encoded == null ? encode(msg) : encoded;
  if (data == null) return false;
  return sendMessage(ws, msg, data);
}

/**
 * send() for a message already encoded as `data` (a broadcast encodes once for all members). m.public / m.private go
 * out as m.state on a socket that negotiated the state-delta transport (server/stateTransport.js). Never throws.
 * @param {import('ws').WebSocket | null | undefined} ws @param {object} msg @param {string} data encode(msg)
 * @returns {boolean}
 */
export function sendMessage(ws, msg, data) {
  const frame = prepareStateFrame(ws, msg, data);
  const bytes = frame.usable === false ? encode(msg) : frame.data;
  if (bytes == null) return false;
  const queued = sendRaw(ws, bytes, { droppable: isDroppable(msg), compress: isCompressibleType(msg?.t) });
  if (queued) frame.commit();
  return queued;
}

/**
 * Send to a session's current socket (no-op while disconnected). Never throws.
 * @param {Session | null | undefined} session
 * @param {object} msg
 * @returns {boolean}
 */
export function sendSession(session, msg, encoded = null) {
  if (!session || !session.connected) return false;
  return send(session.ws, msg, encoded);
}

/**
 * sendSession for a frame already encoded with encode(): the same socket, backpressure and compression rules as
 * send(), without serializing the message again. Never throws.
 * @param {Session | null | undefined} session
 * @param {string} type the message's `t`
 * @param {string | Buffer} data the JSON text (or its UTF-8 bytes, see sendRaw)
 * @returns {boolean}
 */
export function sendSessionEncoded(session, type, data) {
  if (!session || !session.connected) return false;
  return sendRaw(session.ws, data, { droppable: type === 'b.snap', compress: isCompressibleType(type) });
}

/** @param {unknown} rid */
const validRid = (rid) => Number.isInteger(rid) && rid >= 0 && rid <= MAX_RID;

/**
 * True for a real ERR code (own property; rejects inherited names like "constructor").
 * @param {unknown} code
 * @returns {boolean}
 */
export const isErrCode = (code) => typeof code === 'string' && Object.hasOwn(ERR, code);

/**
 * Build an `error` frame.
 * @param {string} code ERR code
 * @param {unknown} [rid]
 * @param {string} [detail] developer-facing reason
 */
export function errorMsg(code, rid, detail) {
  const known = isErrCode(code);
  const m = { t: 'error', code: known ? code : ERR.INTERNAL, msg: known ? ERR_TEXT[code] || ERR_TEXT.INTERNAL : ERR_TEXT.INTERNAL };
  if (validRid(rid)) m.rid = rid;
  if (detail) m.detail = String(detail).slice(0, 120);
  return m;
}

// ---------------------------------------------------------------------------------------------------
// Client addresses (per-network limits)
// ---------------------------------------------------------------------------------------------------

/**
 * Canonical textual IP: lowercase, zone id stripped, IPv4-mapped IPv6 (`::ffff:1.2.3.4`) → IPv4.
 * @param {unknown} raw
 * @returns {string} '' when not an IP address
 */
export function normalizeIp(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().toLowerCase();
  const withPort = /^\[([^\]]+)\](?::\d+)?$/.exec(s) || /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s); // [v6]:port, v4:port
  if (withPort) s = withPort[1];
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) s = mapped[1];
  if (isIP(s) === 6) {
    const g = ipv6Groups(s);
    if (g && g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) s = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  }
  return isIP(s) ? s : '';
}

/** Expand an IPv6 address into 8 numeric groups (null when malformed). @param {string} ip */
function ipv6Groups(ip) {
  let s = ip;
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...new Array(Math.max(0, fill)).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * Loopback or private-network address (RFC 1918, link-local, CGNAT/Tailscale, IPv6 ULA / link-local).
 * @param {string} ip normalized
 */
export function isLocalIp(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a === 0;
  }
  if (isIP(ip) === 6) {
    const g = ipv6Groups(ip);
    if (!g) return false;
    if (g.every((x, i) => (i < 7 ? x === 0 : x <= 1))) return true; // ::1 and ::
    return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80;
  }
  return false;
}

/**
 * The key per-network limits count against: the IPv4 address, or the /64 prefix of an IPv6 address
 * (one subscriber typically owns a whole /64).
 * @param {string} ip normalized
 */
export function limitKeyOf(ip) {
  if (isIP(ip) !== 6) return ip;
  const g = ipv6Groups(ip);
  return g ? `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64` : ip;
}

/** The client address a trusted local proxy forwards (null when it sent none). */
function forwardedAddress(headers) {
  if (!headers) return null;
  const one = (h) => (Array.isArray(h) ? h[h.length - 1] : h);
  for (const name of ['cf-connecting-ip', 'x-real-ip']) {
    const ip = normalizeIp(one(headers[name]));
    if (ip) return ip;
  }
  const xff = one(headers['x-forwarded-for']);
  if (typeof xff === 'string') {
    // The rightmost entry was appended by the proxy nearest to us; earlier ones are client-controlled.
    const parts = xff.split(',');
    const ip = normalizeIp(parts[parts.length - 1]);
    if (ip) return ip;
  }
  return null;
}

/**
 * Resolve an upgrade request's client address and its per-network limit key.
 * Forwarding headers are honoured from loopback/private peers ('auto'), always (true) or never (false).
 * Local/private peers without a forwarded address get `key: null` (never limited per network).
 * @param {import('node:http').IncomingMessage | undefined} req
 * @param {'auto' | boolean} [trustProxy]
 * @returns {{ ip: string, key: string | null }}
 */
export function clientAddress(req, trustProxy = NET_DEFAULTS.trustProxy) {
  const peer = normalizeIp(req?.socket?.remoteAddress);
  const local = !peer || isLocalIp(peer);
  if (trustProxy === true || (trustProxy !== false && local)) {
    const fwd = forwardedAddress(req?.headers);
    if (fwd) return { ip: fwd, key: isLocalIp(fwd) ? null : limitKeyOf(fwd) };
  }
  if (local) return { ip: peer || '?', key: null };
  return { ip: peer, key: limitKeyOf(peer) };
}

// ---------------------------------------------------------------------------------------------------
// Network: per-socket pipeline
// ---------------------------------------------------------------------------------------------------

/** Per-socket state. */
class Connection {
  /** @param {import('ws').WebSocket} ws @param {{ ip: string, key: string | null }} addr @param {number} now @param {typeof NET_DEFAULTS} opts */
  constructor(ws, addr, now, opts) {
    this.ws = ws;
    this.ip = addr.ip;
    /** @type {string | null} per-network limit key (see clientAddress) */
    this.key = addr.key;
    this.openedAt = now;
    this.alive = true;
    /** @type {Session | null} */
    this.session = null;
    this.bucket = new TokenBucket(opts.ratePerSec, opts.rateBurst, now);
    this.heavy = new TokenBucket(opts.heavyPerSec, opts.heavyBurst, now);
    this.dropWindowAt = now;
    this.drops = 0;
    this.pendingHandlers = 0;
    /** true once the server initiated the close; frames still in flight are ignored */
    this.closing = false;
    /** heartbeat slice index (Network.heartbeatSlices) */
    this.slice = 0;
  }

  /** Server-initiated close (never throws). Later frames from this socket are ignored. */
  close(code, reason) {
    this.closing = true;
    try { this.ws.close(code, reason); } catch { /* ignore */ }
  }
}

/** Frames larger than this are not parsed just to echo a rid on a RATE error (CPU guard). */
const PEEK_RID_MAX_BYTES = 2048;

/** Owns every live socket; turns frames into validated messages for the handler. */
export class Network {
  /**
   * @param {{
   *   registry: SessionRegistry,
   *   handler: { onHello?: Function, onMessage: Function, onDisconnect?: Function, onExpire?: Function, welcomeInfo?: Function },
   *   log?: { info: Function, warn: Function, error: Function, debug?: Function },
   *   now?: () => number,
   *   getLoadState?: () => string,
   *   getLoadDetails?: () => unknown,
   *   getClusterLoad?: () => unknown,
   *   options?: Partial<typeof NET_DEFAULTS>,
   *   metrics?: { start: () => number, end: (name: string, t0: number, items?: number) => void },
   * }} opts
   */
  constructor({ registry, handler, log = noopLog, now = Date.now, getLoadState = null, getLoadDetails = null, getClusterLoad = null, options = {},
    metrics = NO_PHASES, onlineLimit = null, ownerFile = null }) {
    this.registry = registry;
    this.handler = handler;
    this.log = log;
    this.now = now;
    this.getLoadState = typeof getLoadState === 'function' ? getLoadState : null;
    this.getLoadDetails = typeof getLoadDetails === 'function' ? getLoadDetails : null;
    this.getClusterLoad = typeof getClusterLoad === 'function' ? getClusterLoad : null;
    this.clusterLoadCache = { at: -Infinity, value: null };
    this.opts = { ...NET_DEFAULTS, ...options };
    if (typeof this.opts.allowAsyncHandlers !== 'boolean') throw new TypeError('invalid asynchronous network handler option');
    /** @type {Map<import('ws').WebSocket, Connection>} */
    this.conns = new Map();
    /** @type {Map<string, number>} open sockets per client network key */
    this.connsPerKey = new Map();
    this.closed = false;
    /** diagnostics only (server/phaseMetrics.js): never changes a reply */
    this.metrics = metrics;
    /** @type {{ limit: () => number } | null} the online cap (server/onlineLimit.js) for NEW sessions */
    this.onlineLimit = onlineLimit;
    /** @type {{ verify: (key: unknown) => boolean, reserved: (name: unknown) => boolean } | null} the owner file (server/ownerFile.js) */
    this.ownerFile = ownerFile;
    /** first hellos of a socket since start, by outcome (/healthz reconnect.hello; helloStats) */
    this.helloCounts = { resumed: 0, fresh: 0, unknownToken: 0, inUse: 0 };
    const slices = Math.max(1, Math.min(HEARTBEAT_SLICES_MAX, Math.round(this.opts.heartbeatMs / HEARTBEAT_SLICE_MS)));
    /** @type {Set<Connection>[]} round-robin heartbeat slices; one is visited per tick */
    this.heartbeatSlices = Array.from({ length: slices }, () => new Set());
    this.heartbeatCursor = 0;
    this.heartbeatAssign = 0;
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), Math.max(1, Math.floor(this.opts.heartbeatMs / slices)));
    this.heartbeatTimer.unref?.();
    const sweepMs = Math.max(20, Math.min(15_000, Math.floor(this.opts.reconnectWindowMs / 4)));
    this.sweepTimer = setInterval(() => this.sweep(), sweepMs);
    this.sweepTimer.unref?.();
  }

  /** Number of open sockets. */
  get connectionCount() { return this.conns.size; }

  /** Number of authenticated sessions bound to a live socket (what the online cap counts). */
  get onlineCount() {
    let n = 0;
    for (const conn of this.conns.values()) {
      if (conn.session?.connected && conn.session.ws === conn.ws) n++;
    }
    return n;
  }

  /**
   * Upgrade-time admission check (server/http/websocket.js): null to accept, otherwise the reason to refuse.
   * @param {import('node:http').IncomingMessage} req
   * @returns {null | 'shutdown' | 'full' | 'per-address'}
   */
  admission(req) {
    if (this.closed) return 'shutdown';
    if (this.opts.maxConnections > 0 && this.conns.size >= this.opts.maxConnections) return 'full';
    const { key } = clientAddress(req, this.opts.trustProxy);
    const cap = this.opts.maxConnectionsPerAddr;
    if (key && cap > 0 && (this.connsPerKey.get(key) || 0) >= cap) return 'per-address';
    return null;
  }

  /**
   * Adopt a freshly upgraded socket.
   * @param {import('ws').WebSocket} ws
   * @param {import('node:http').IncomingMessage} [req]
   */
  handleConnection(ws, req) {
    if (this.closed) { try { ws.close(CLOSE.SHUTDOWN, 'server shutdown'); } catch { /* ignore */ } return; }
    const conn = new Connection(ws, clientAddress(req, this.opts.trustProxy), this.now(), this.opts);
    this.conns.set(ws, conn);
    conn.slice = this.heartbeatAssign++ % this.heartbeatSlices.length;
    this.heartbeatSlices[conn.slice].add(conn);
    if (conn.key) this.connsPerKey.set(conn.key, (this.connsPerKey.get(conn.key) || 0) + 1);
    ws.on('message', (data, isBinary) => {
      try { this.onFrame(conn, data, isBinary); } catch (e) { this.log.error('[net] frame handler crashed', e); }
    });
    ws.on('pong', () => { conn.alive = true; if (conn.session && conn.session.ws === ws) conn.session.lastSeen = this.now(); });
    ws.on('error', (e) => { this.log.debug?.('[net] socket error', e?.code || e?.message); });
    ws.on('close', () => { try { this.onClose(conn); } catch (e) { this.log.error('[net] close handler crashed', e); } });
  }

  /** @param {Connection} conn @param {object} msg */
  reply(conn, msg) { return send(conn.ws, msg); }

  /** @param {Connection} conn */
  onFrame(conn, data, isBinary) {
    // A socket we are closing (replaced by another tab, hello timeout, flooding, shutdown) may still have
    // frames in flight; acting on them could e.g. mint an orphan session from a late `hello`.
    if (conn.closing || this.closed) return;
    const now = this.now();
    conn.alive = true;
    if (conn.session && conn.session.ws === conn.ws) conn.session.lastSeen = now;

    if (!conn.bucket.take(now)) {
      if (now - conn.dropWindowAt >= 1000) { conn.dropWindowAt = now; conn.drops = 0; }
      if (++conn.drops > this.opts.abuseDropsPerSec) {
        this.log.warn(`[net] closing flooding socket ${conn.ip}`);
        conn.close(CLOSE.POLICY, 'rate limit');
        return;
      }
      this.reply(conn, errorMsg(ERR.RATE, peekRid(data, isBinary)));
      return;
    }

    if (isBinary) { this.reply(conn, errorMsg(ERR.BAD_MSG, undefined, 'binary frame')); return; }
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { this.reply(conn, errorMsg(ERR.BAD_MSG, undefined, 'invalid json')); return; }
    const rid = msg && typeof msg === 'object' ? msg.rid : undefined;
    // Own-property check first: validateC2S alone would accept inherited keys like "constructor".
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string' || !Object.hasOwn(C2S, msg.t)) {
      const t = msg && typeof msg === 'object' ? String(msg.t).slice(0, 32) : typeof msg;
      this.reply(conn, errorMsg(ERR.BAD_MSG, rid, `unknown type ${t}`));
      return;
    }
    const reason = validateC2S(msg);
    if (reason) { this.reply(conn, errorMsg(ERR.BAD_MSG, rid, reason)); return; }

    if (msg.t === 'ping') {
      const pong = { t: 'pong', c: msg.c, s: now };
      if (this.getLoadState) {
        try { pong.loadState = normalizeServerLoad(this.getLoadState()); }
        catch { pong.loadState = 'unknown'; } // diagnostics cannot interrupt heartbeat replies
      }
      if (this.getLoadDetails) {
        try {
          const details = normalizeLoadDetails(this.getLoadDetails());
          if (details !== null) pong.loadDetails = details;
        } catch { /* diagnostics cannot interrupt heartbeat replies */ }
      }
      if (this.getClusterLoad) {
        try {
          // one summary of every node per second instead of one per heartbeat (cost grew with clients × nodes)
          const cache = this.clusterLoadCache;
          if (!(now - cache.at >= 0 && now - cache.at < CLUSTER_LOAD_CACHE_MS)) {
            this.clusterLoadCache = { at: now, value: normalizeClusterLoad(this.getClusterLoad()) };
          }
          const cluster = this.clusterLoadCache.value;
          if (cluster !== null) {
            if (msg.full === true || !(now - conn.clusterLoadAt >= 0 && now - conn.clusterLoadAt < CLUSTER_LOAD_EVERY_MS)) {
              pong.clusterLoad = cluster;
              conn.clusterLoadAt = now;
            } else pong.clusterLoadSame = true;
          }
        } catch { /* diagnostics cannot interrupt heartbeat replies */ }
      }
      if (validRid(rid)) pong.rid = rid;
      this.reply(conn, pong);
      return;
    }
    if (msg.t === 'hello') {
      const t0 = this.metrics.start();
      this.onHelloMsg(conn, msg, now);
      this.metrics.end('ws.hello', t0);
      return;
    }
    if (!conn.session) { this.reply(conn, errorMsg(ERR.BAD_MSG, rid, 'hello required')); return; }
    if (HEAVY_TYPES.has(msg.t) && !conn.heavy.take(now)) { this.reply(conn, errorMsg(ERR.RATE, rid, `${msg.t} too often`)); return; }

    if (this.opts.allowAsyncHandlers && conn.pendingHandlers >= 64) { this.reply(conn, errorMsg(ERR.RATE, rid)); return; }
    const session = conn.session;
    const respond = res => {
      if (this.closed || conn.closing || conn.session !== session || session.ws !== conn.ws) return;
      if (res && res.error) {
        if (msg.t === 'b.progress' && !validRid(rid)) return;
        this.reply(conn, errorMsg(isErrCode(res.error) ? res.error : ERR.INTERNAL, rid, res.detail));
      } else if (validRid(rid)) this.reply(conn, { t: 'ok', rid });
    };
    const t0 = this.metrics.start();
    // A client that asks for a full frame (shared/stateDelta.js): dropping the baseline makes the next frame of every
    // state channel a full one; the state itself is resent by the same resync a repeated hello runs (the lobby throttles
    // it with resyncMinGapMs).
    if (msg.t === 'state.resync') {
      resetStateDelta(conn.ws);
      respond(this.handler.onMessage(conn.session, { t: 'state.resync' }) ?? { ok: true });
      this.metrics.end(messagePhase(msg.t), t0);
      return;
    }
    let res;
    try {
      // client-side combat reports (b.progress / b.result, DESIGN §14) belong to the running match like 'g.*' intents:
      // handed to the lobby's match router when the handler has one (server/lobby.js routeGame)
      if (msg.t.startsWith('b.') && typeof this.handler.routeGame === 'function') res = this.handler.routeGame(conn.session, msg);
      else res = this.handler.onMessage(conn.session, msg);
    } catch (e) {
      this.log.error(`[net] handler crashed on ${msg.t}`, e);
      res = { error: ERR.INTERNAL };
    }
    if (res && typeof res.then === 'function') {
      // an answer that has to wait — the cluster coordinator's remote starts, and (DESIGN §32.6) a room whose match runs
      // in a match host, which answers once the host has (server/lobby.js keeps each such room's messages in order):
      // sent when it settles; a rejection is INTERNAL
      if (!this.opts.allowAsyncHandlers) {
        Promise.resolve(res).catch(() => {});
        respond({ error: ERR.INTERNAL });
        return;
      }
      conn.pendingHandlers++;
      Promise.resolve(res).then(respond, (e) => { this.log.error(`[net] handler failed on ${msg.t}`, e); respond({ error: ERR.INTERNAL }); })
        .catch(() => {}).finally(() => { conn.pendingHandlers--; });
    } else respond(res);
    this.metrics.end(messagePhase(msg.t), t0); // the synchronous part only
  }

  /** @param {Connection} conn @param {any} msg @param {number} now */
  onHelloMsg(conn, msg, now) {
    const rid = msg.rid;
    if (msg.version != null && msg.version !== PROTOCOL_VERSION) {
      this.reply(conn, errorMsg(ERR.BAD_MSG, rid, `version mismatch: server ${PROTOCOL_VERSION}`));
      return;
    }
    if (msg.matchmakingVersion != null && msg.matchmakingVersion !== MATCHMAKING_VERSION) {
      this.reply(conn, errorMsg(ERR.BAD_MSG, rid, 'matchmaking version mismatch'));
      return;
    }
    // Validate before looking up a reconnect token, detaching another socket or mutating a session.
    // A legacy rejected name keeps its identity/token intact until the owner submits a valid name.
    const checked = moderateName(msg.name);
    if (!checked.ok) { this.reply(conn, errorMsg(ERR.NAME_REJECTED, rid, checked.reason)); return; }
    const name = checked.name;
    // 服主 (server/ownerFile.js): the key decides on every hello, nothing is kept without it; the owner's reserved names
    // are refused to anybody else like a rejected name (before the token lookup: the identity stays intact)
    const owner = this.isOwnerKey(msg.owner);
    if (!owner && this.nameReserved(name)) { this.reply(conn, errorMsg(ERR.NAME_REJECTED, rid, NAME_RESERVED)); return; }
    if (msg.playerCapacityVersion != null && msg.playerCapacityVersion !== PLAYER_CAPACITY_VERSION) {
      this.reply(conn, errorMsg(ERR.BAD_MSG, rid, 'player capacity version mismatch'));
      return;
    }
    // Check an existing room's capability before replacing its socket or changing any session metadata.
    const previous = conn.session || (msg.token ? this.registry.byToken(msg.token) : null);
    let admission;
    try { admission = this.handler.helloAdmission?.(previous, msg); } catch (e) {
      this.log.error('[net] hello admission crashed', e);
      this.reply(conn, errorMsg(ERR.INTERNAL, rid)); return;
    }
    if (admission?.error) {
      this.reply(conn, errorMsg(isErrCode(admission.error) ? admission.error : ERR.INTERNAL, rid, admission.detail));
      return;
    }

    let session = conn.session;
    let resumed = false;
    const repeat = !!session;
    if (!session) {
      session = msg.token ? this.registry.byToken(msg.token) : null;
      if (session) {
        if (session.connected && session.ws && session.ws !== conn.ws
          && (msg.noReplace || (Number.isFinite(msg.claimAt) && session.claimAt != null && msg.claimAt > session.claimAt))) {
          this.helloCounts.inUse++;
          this.reply(conn, errorMsg(ERR.SESSION_IN_USE, rid));
          return;
        }
        resumed = true;
        this.helloCounts.resumed++;
        if (session.ws && session.ws !== conn.ws) this.detachReplaced(session.ws);
      } else {
        // the online cap admits no NEW session while the lobby is at it; a resumed one above always comes back
        const full = this.serverFull();
        if (full) { this.reply(conn, errorMsg(ERR.SERVER_FULL, rid, full)); return; }
        // The online cap (SP_MAX_ONLINE) decides *new players only*: a token that still resolves resumed above and never
        // reaches this check, so a full server does not lock out the people already playing. "A resume is never refused"
        // holds at this layer alone — the socket cap (maxConnections, checked at the upgrade in
        // server/http/websocket.js, answering 503 before a socket exists) still applies, and the `noReplace` / claimAt
        // decision above still answers SESSION_IN_USE for a token whose session is live on another socket. This check is
        // what the player sees as 服务器已满 (ERR.SERVER_FULL).
        if (this.opts.maxOnline > 0 && this.onlineCount >= this.opts.maxOnline) {
          this.reply(conn, errorMsg(ERR.SERVER_FULL, rid, 'server full (online cap)'));
          try { conn.ws.close(CLOSE.POLICY, 'server full'); } catch { /* ignore */ }
          return;
        }
        session = this.registry.create(name);
        if (!session) { this.reply(conn, errorMsg(ERR.INTERNAL, rid, 'server full')); return; }
        // a token the registry does not know: expired past the reconnect window, or issued by another server process
        this.helloCounts[msg.token ? 'unknownToken' : 'fresh']++;
      }
      conn.session = session;
      session.ws = conn.ws;
      session.connected = true;
      session.claimAt = Number.isFinite(msg.claimAt) ? msg.claimAt : null;
      session.disconnectedAt = null;
    }
    session.name = name;
    session.owner = owner;
    session.lastSeen = now;
    session.addr = conn.ip;
    session.limitKey = conn.key;
    session.matchmakingVersion = msg.matchmakingVersion ?? null;
    session.playerCapacityVersion = msg.playerCapacityVersion ?? null;
    // m.public / m.private as m.state deltas on this socket (a repeated hello keeps its baselines); `delta` is upstream's
    // name for the same field
    negotiateStateDelta(conn.ws, msg.stateDelta ?? msg.delta);

    let extra = null;
    try { extra = this.handler.welcomeInfo?.() ?? null; } catch (e) { this.log.error('[net] welcomeInfo crashed', e); }
    // Keep the type first for bounded ingress inspection; optional metadata cannot replace identity fields.
    const welcome = { t: 'welcome', playerId: session.playerId, token: session.token, name: session.name, serverNow: now, version: PROTOCOL_VERSION, resumed };
    if (session.owner) welcome.owner = true; // the settings screen's confirmation that the key worked
    if (extra && typeof extra === 'object') for (const [key, value] of Object.entries(extra)) {
      if (!Object.hasOwn(welcome, key) && key !== '__proto__') welcome[key] = value;
    }
    if (session.aiTakeoverFrom) { welcome.takeoverFrom = session.aiTakeoverFrom; session.aiTakeoverFrom = null; }
    if (validRid(rid)) welcome.rid = rid;
    this.reply(conn, welcome);
    try {
      this.handler.onHello?.(session, { resumed, repeat });
    } catch (e) {
      this.log.error('[net] onHello crashed', e);
    }
  }

  /** The session moved to a new socket: unbind and close the old one without firing a disconnect. */
  detachReplaced(oldWs) {
    const old = this.conns.get(oldWs);
    if (old) {
      old.session = null;
      old.close(CLOSE.REPLACED, 'session replaced');
    } else {
      try { oldWs.close(CLOSE.REPLACED, 'session replaced'); } catch { /* ignore */ }
    }
  }

  /** @param {Connection} conn */
  onClose(conn) {
    this.heartbeatSlices[conn.slice]?.delete(conn);
    if (this.conns.delete(conn.ws) && conn.key) {
      const n = (this.connsPerKey.get(conn.key) || 1) - 1;
      if (n > 0) this.connsPerKey.set(conn.key, n);
      else this.connsPerKey.delete(conn.key);
    }
    const s = conn.session;
    conn.session = null;
    if (!s || s.ws !== conn.ws) return;
    s.ws = null;
    s.connected = false;
    s.disconnectedAt = this.now();
    if (this.closed) return;
    const t0 = this.metrics.start();
    try { this.handler.onDisconnect?.(s); } catch (e) { this.log.error('[net] onDisconnect crashed', e); }
    this.metrics.end('ws.close', t0);
  }

  /** Is this hello key the owner's (server/ownerFile.js)? Never throws; no owner file = nobody. */
  isOwnerKey(key) {
    if (key === undefined || key === '') return false;
    try { return this.ownerFile?.verify(key) === true; } catch { return false; }
  }

  /** A name only the owner may use (server/ownerFile.js)? Never throws. */
  nameReserved(name) {
    try { return this.ownerFile?.reserved(name) === true; } catch { return false; }
  }

  /** The SERVER_FULL detail when the online cap is set and reached (the lobby's onlineCount), else null. */
  serverFull() {
    let cap = 0;
    try { cap = this.onlineLimit?.limit() ?? 0; } catch { cap = 0; }
    if (!(cap > 0)) return null;
    let online = 0;
    try { online = Number(this.handler.onlineCount?.()) || 0; } catch { online = 0; }
    return online >= cap ? serverFullDetail(online, cap) : null;
  }

  /** One heartbeat check of a socket: ping it, or drop it when it did not answer since its previous ping. */
  heartbeatConn(conn, now) {
    try {
      if (conn.ws.linked === true) {
        // An ingress link session: the ingress pings the real browser socket and the link is pinged as a whole.
        if (!conn.closing && !conn.session && now - conn.openedAt > this.opts.helloTimeoutMs) conn.close(CLOSE.HELLO_TIMEOUT, 'hello timeout');
        return;
      }
      if (conn.closing) {
        // Closing handshake never completed within a heartbeat interval → drop the TCP connection.
        if (!conn.alive) conn.ws.terminate();
        conn.alive = false;
        return;
      }
      if (!conn.session && now - conn.openedAt > this.opts.helloTimeoutMs) {
        conn.close(CLOSE.HELLO_TIMEOUT, 'hello timeout');
        return;
      }
      if (!conn.alive) { conn.ws.terminate(); return; }
      conn.alive = false;
      conn.ws.ping();
    } catch (e) {
      this.log.debug?.('[net] heartbeat error', e?.message);
    }
  }

  /** Timer tick: the next slice only (each slice comes round once per heartbeatMs). */
  heartbeatTick() {
    const slice = this.heartbeatSlices[this.heartbeatCursor];
    this.heartbeatCursor = (this.heartbeatCursor + 1) % this.heartbeatSlices.length;
    if (!slice.size) return;
    const t0 = this.metrics.start(), now = this.now();
    for (const conn of [...slice]) this.heartbeatConn(conn, now);
    this.metrics.end('net.heartbeat', t0, slice.size);
  }

  /** Ping every socket at once; terminate the ones that did not answer since the previous heartbeat. */
  heartbeat() {
    const now = this.now();
    for (const conn of [...this.conns.values()]) this.heartbeatConn(conn, now);
  }

  /**
   * /healthz `reconnect.hello`: the first hellos of a socket since start — resumed (a known token rebound its session),
   * fresh (no token), unknownToken (a token no session has any more: a new identity), inUse (SESSION_IN_USE: the
   * token's session is live on another socket and the hello asked not to replace it).
   */
  helloStats() { return { ...this.helloCounts }; }

  /** Purge expired sessions and tell the handler. */
  sweep() {
    const t0 = this.metrics.start();
    let expired;
    try { expired = this.registry.sweep(this.now()); } catch (e) { this.log.error('[net] sweep crashed', e); return; }
    for (const s of expired) {
      try { this.handler.onExpire?.(s); } catch (e) { this.log.error('[net] onExpire crashed', e); }
    }
    this.metrics.end('net.sweep', t0, expired.length);
  }

  /**
   * Stop timers and close every socket (graceful: close frame, then terminate after 1 s).
   * @param {number} [code] @param {string} [reason]
   */
  close(code = CLOSE.SHUTDOWN, reason = 'server shutdown') {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeatTimer);
    clearInterval(this.sweepTimer);
    for (const conn of this.conns.values()) {
      conn.close(code, reason);
      const t = setTimeout(() => { try { conn.ws.terminate(); } catch { /* ignore */ } }, 1000);
      t.unref?.();
    }
  }
}

/** Best-effort rid extraction for rate-limited frames (so the client's pending request resolves). */
function peekRid(data, isBinary) {
  if (isBinary || !data || data.length > PEEK_RID_MAX_BYTES) return undefined;
  try {
    const m = JSON.parse(data.toString('utf8'));
    return m && typeof m === 'object' ? m.rid : undefined;
  } catch {
    return undefined;
  }
}
