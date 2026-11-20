// Coordinator end of the ingress link (link.js). Each OPEN becomes a LinkSocket: a stand-in with the WebSocket surface
// net.js Network/Session use (readyState, bufferedAmount, send, close, terminate, 'message'/'close' events), handed to the
// unchanged Network.handleConnection after the same admission check an upgrade gets. Browser liveness stays with the
// ingress that holds the real socket (Network skips pings for `linked` sockets); this side only pings the link. A
// malformed frame, a missed link pong or a link send queue above LINK_HARD_BYTES drops the link and closes every
// session on it, exactly like losing those sockets. Per-session order is the link's order; connIds are never reused.
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { ABNORMAL, LINK_PATH, MAX_LINK_FRAME, OP, createLinkAuthenticator, decodeFrame, encodeClose, encodeData, encodeFanout } from './link.js';
import { ID_COOKIE } from '../../shared/receipts.js';

const OPEN = 1, CLOSING = 2, CLOSED = 3;
/** A link whose unsent queue exceeds this is not being read: drop it (the direct path's per-socket bound is 16 MiB). */
export const LINK_HARD_BYTES = 64 * 1024 * 1024;

/** The coordinator-side stand-in for one browser session's control socket. */
export class LinkSocket extends EventEmitter {
  constructor(link, connId) {
    super();
    this.link = link;
    this.connId = connId;
    this.readyState = OPEN;
    /** Bytes of this session's frames still queued on the link (per-session backpressure, net.js sendRaw bounds). */
    this.pending = 0;
    /** Heartbeats for linked sessions live on the ingress (net.js heartbeatConn). */
    this.linked = true;
    /** Like the direct private control socket: never compressed, no subprotocol. */
    this.extensions = '';
    this.protocol = '';
  }
  get bufferedAmount() { return this.pending; }
  send(data, options, callback) {
    const done = typeof options === 'function' ? options : callback;
    if (this.readyState !== OPEN) { done?.(new Error('link socket not open')); return; }
    const frame = encodeData(this.connId, data);
    // Larger than any link message may be: only this session fails (its direct socket would have), not the link.
    if (frame.length > MAX_LINK_FRAME) { this.terminate(); done?.(new Error('frame too large')); return; }
    this.link.write(frame, [this], done);
  }
  close(code = 1000, reason = '') {
    if (this.readyState !== OPEN) return;
    this.readyState = CLOSING;
    this.link.write(encodeClose(this.connId, code, reason), []);
    this.link.release(this, code, reason);
  }
  terminate() {
    if (this.readyState === CLOSED) return;
    const open = this.readyState === OPEN;
    this.readyState = CLOSING;
    if (open) this.link.write(encodeClose(this.connId, ABNORMAL, ''), []);
    this.link.release(this, ABNORMAL, '');
  }
  ping() {}
  pong() {}
}

class CoordinatorLink {
  constructor(server, ws, scope, remoteAddress) {
    Object.assign(this, { server, ws, scope, remoteAddress, conns: new Map(), maxOpened: 0, alive: true, closed: false });
    ws.on('message', (data, isBinary) => {
      this.alive = true;
      try { this.receive(data, isBinary); } catch { this.fail(); }
    });
    ws.on('pong', () => { this.alive = true; });
    ws.on('error', () => this.fail());
    ws.on('close', () => this.fail());
  }
  write(frame, sockets, done) {
    if (this.closed) { done?.(new Error('link closed')); return; }
    for (const socket of sockets) socket.pending += frame.length;
    this.ws.send(frame, { binary: true }, error => {
      for (const socket of sockets) socket.pending -= frame.length;
      done?.(error);
    });
    if (this.ws.bufferedAmount > this.server.hardBytes) this.fail();
  }
  /** One frame for many sessions: target i gets prefix_i + shared + suffix_i (link.js FANOUT). */
  fanout(targets, shared) {
    const live = targets.filter(target => target.socket.readyState === OPEN && target.socket.link === this);
    if (!live.length || this.closed) return 0;
    const sharedBytes = Buffer.isBuffer(shared) ? shared : Buffer.from(shared, 'utf8');
    for (let i = 0; i < live.length; i += 4096) {
      const chunk = live.slice(i, i + 4096);
      const frame = encodeFanout(chunk.map(t => ({ connId: t.socket.connId, prefix: t.prefix, suffix: t.suffix })), sharedBytes);
      if (frame.length > MAX_LINK_FRAME) {
        // Too many large per-session parts for one message: the same bytes, one DATA frame per session.
        for (const t of chunk) t.socket.send(t.prefix || t.suffix ? Buffer.concat([t.prefix ?? Buffer.alloc(0), sharedBytes, t.suffix ?? Buffer.alloc(0)]) : sharedBytes);
        continue;
      }
      const sizes = chunk.map(t => sharedBytes.length + (t.prefix?.length ?? 0) + (t.suffix?.length ?? 0));
      chunk.forEach((t, k) => { t.socket.pending += sizes[k]; });
      if (this.closed) return 0;
      this.ws.send(frame, { binary: true }, () => chunk.forEach((t, k) => { t.socket.pending -= sizes[k]; }));
    }
    if (this.ws.bufferedAmount > this.server.hardBytes) this.fail();
    return live.length;
  }
  receive(data, isBinary) {
    if (this.closed) return;
    if (!isBinary) throw new Error('text frame');
    const message = decodeFrame(Buffer.isBuffer(data) ? data : Buffer.concat(data), 'ingress');
    if (message.op === OP.OPEN) {
      if (message.connId <= this.maxOpened) throw new Error('connId reuse');
      this.maxOpened = message.connId;
      this.server.open(this, message.connId, message.info);
      return;
    }
    if (message.connId > this.maxOpened) throw new Error('unopened connId');
    const socket = this.conns.get(message.connId);
    if (!socket) return; // closed here already: a late frame of that session
    if (message.op === OP.DATA) { if (socket.readyState === OPEN) socket.emit('message', message.data, false); return; }
    // OP.CLOSE from the ingress: the browser side is gone.
    this.conns.delete(message.connId);
    if (socket.readyState !== CLOSED) { socket.readyState = CLOSED; socket.emit('close', message.code, Buffer.from(message.reason)); }
  }
  release(socket, code, reason) {
    if (this.conns.get(socket.connId) === socket) this.conns.delete(socket.connId);
    setImmediate(() => {
      if (socket.readyState === CLOSED) return;
      socket.readyState = CLOSED;
      socket.emit('close', code, Buffer.from(String(reason ?? '')));
    });
  }
  fail() {
    if (this.closed) return;
    this.closed = true;
    this.server.links.delete(this);
    try { this.ws.terminate(); } catch { /* already gone */ }
    const sockets = [...this.conns.values()];
    this.conns.clear();
    for (const socket of sockets) {
      if (socket.readyState === CLOSED) continue;
      socket.readyState = CLOSED;
      socket.emit('close', ABNORMAL, Buffer.alloc(0));
    }
  }
}

/**
 * @param {{ network: import('../net.js').Network, ingresses: { ingressId: string, key: Buffer }[], now?: () => number,
 *   pingMs?: number, maxLinksPerIngress?: number, hardBytes?: number }} options
 */
export function createLinkServer({ network, ingresses, now = Date.now, pingMs = 10_000, maxLinksPerIngress = 2, hardBytes = LINK_HARD_BYTES }) {
  if (!network || typeof network.handleConnection !== 'function' || !Array.isArray(ingresses) || !ingresses.length
    || new Set(ingresses.map(i => i?.ingressId)).size !== ingresses.length) throw new TypeError('invalid link server');
  if (!Number.isSafeInteger(pingMs) || pingMs < 100 || pingMs > 60_000 || !Number.isSafeInteger(maxLinksPerIngress)
    || maxLinksPerIngress < 1 || maxLinksPerIngress > 4) throw new RangeError('invalid link server limits');
  const authorities = new Map(ingresses.map(({ ingressId, key }) => [ingressId, createLinkAuthenticator({ key, scope: ingressId, now })]));
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_LINK_FRAME, perMessageDeflate: false, clientTracking: false });
  wss.on('headers', (headers, req) => { if (req.linkProof) headers.push(`X-Ark-Cluster-Link-Proof: ${req.linkProof}`); });
  wss.on('error', () => {});
  const server = { links: new Set(), hardBytes, closed: false,
    open(link, connId, info) {
      // The same facts, and so the same clientAddress/admission result, as the direct path's upgrade headers.
      const req = { url: '/ws', socket: { remoteAddress: link.remoteAddress },
        headers: { origin: info.origin, 'x-real-ip': info.ip, 'x-forwarded-for': info.ip, 'x-forwarded-proto': info.proto,
          // the identity cookie the ingress forwarded (server/identity.js), as the direct path's Cookie header
          ...(info.id ? { cookie: `${info.proto === 'https' ? ID_COOKIE.secure : ID_COOKIE.plain}=${info.id}` } : {}) } };
      if (server.closed || network.admission(req)) { link.ws.send(encodeClose(connId, ABNORMAL, 'REFUSED'), { binary: true }); return; }
      const socket = new LinkSocket(link, connId);
      link.conns.set(connId, socket);
      network.handleConnection(socket, req);
    } };
  const refuse = (socket, status) => {
    try { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { socket.destroy(); }
  };
  const timer = setInterval(() => {
    for (const link of [...server.links]) {
      if (!link.alive) { link.fail(); continue; }
      link.alive = false;
      try { link.ws.ping(); } catch { link.fail(); }
    }
  }, pingMs);
  timer.unref?.();
  return {
    /** @returns {boolean} whether this upgrade was the link path (answered either way) */
    handleUpgrade(req, socket, head) {
      if (req.url !== LINK_PATH) return false;
      socket.on('error', () => {});
      const scope = req.headers['x-ark-cluster-scope'];
      const authority = typeof scope === 'string' ? authorities.get(scope) : undefined;
      const nonce = authority?.verify(req.headers) ?? null;
      if (!nonce) { refuse(socket, '401 Unauthorized'); return true; }
      if (server.closed || [...server.links].filter(link => link.scope === scope).length >= maxLinksPerIngress) {
        refuse(socket, '503 Service Unavailable'); return true;
      }
      req.linkProof = authority.proof(nonce);
      try {
        wss.handleUpgrade(req, socket, head, ws => {
          if (server.closed) { ws.terminate(); return; }
          server.links.add(new CoordinatorLink(server, ws, scope, socket.remoteAddress));
        });
      } catch { socket.destroy(); }
      return true;
    },
    stats: () => ({ links: server.links.size, sessions: [...server.links].reduce((n, link) => n + link.conns.size, 0) }),
    /** Stop accepting; let each link flush what is queued, then close it (its sessions see the link end). */
    close(flushMs = 500) {
      server.closed = true;
      clearInterval(timer);
      return Promise.all([...server.links].map(link => new Promise(resolve => {
        const timeout = setTimeout(() => { link.fail(); resolve(); }, flushMs);
        timeout.unref?.();
        link.ws.once('close', () => { clearTimeout(timeout); link.fail(); resolve(); });
        try { link.ws.close(1001, 'SHUTDOWN'); } catch { clearTimeout(timeout); link.fail(); resolve(); }
      })));
    },
  };
}
