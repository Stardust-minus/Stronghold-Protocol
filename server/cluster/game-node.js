// A private process-local game endpoint. Authentication/admission and sockets live
// here; GameHost/Match retain game ownership. No sessions or pools are created.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { GameHost } from './game-host.js';
import { createRpcAuthenticator, createRpcHandler, RpcError } from './rpc.js';
import { createTicketAuthority } from './tickets.js';
import { NET_DEFAULTS, TokenBucket, encode, sendRaw, isErrCode } from '../net.js';
import { C2S, validateC2S, normalizeServerLoad, normalizeLoadDetails } from '../../shared/protocol.js';
import { ERR, PROTOCOL_VERSION } from '../../shared/constants.js';
import { normalizeGameLoad, normalizeClusterLoad, publicGameLabel } from '../../shared/cluster-load.js';

const GAME_PATH = '/_cluster/game';
const MAX_PAYLOAD = 64 * 1024;
const id = v => typeof v === 'string' && v.length > 0 && v.length <= 128 && /^[A-Za-z0-9_-][A-Za-z0-9_.:-]*(?![\s\S])/.test(v);
const plain = v => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const int = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const validRid = v => int(v, 0, 2 ** 31);
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
const check = (value, required, optional = []) => {
  if (!plain(value) || required.some(k => !Object.hasOwn(value, k))
    || Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) throw new RpcError('BAD_REQUEST');
};
const checkAssignment = payload => {
  if (!id(payload.assignmentId)) throw new RpcError('BAD_REQUEST');
};
const checkMember = payload => {
  check(payload, ['assignmentId', 'sessionId']);
  checkAssignment(payload);
  if (!id(payload.sessionId)) throw new RpcError('BAD_REQUEST');
};
const peekRid = (data, binary) => {
  if (binary || data.length > 2048) return undefined;
  try { const rid = JSON.parse(data.toString('utf8'))?.rid; return validRid(rid) ? rid : undefined; } catch { return undefined; }
};

/**
 * Starts only this node's HTTP/WS listener and GameHost. Borrowed pools are never
 * started/closed. The coordinator must keep entry startup frames buffered until
 * its allocation commit; this node requires all human game channels first.
 */
export async function startGameNode({ host = '127.0.0.1', port = 0, nodeId, generation, build, key,
  protocol = PROTOCOL_VERSION, data, combatPool, trialPool, MatchClass, onEnd, now = Date.now, log = noopLog,
  prepareMs = 15_000, bindTimeoutMs = 5000, heartbeatMs = NET_DEFAULTS.heartbeatMs, sweepMs = 1000,
  shutdownMs = 1000, publicationMs = 20_000, ticketsAuthority, ticketIssuer = 'stronghold-cluster', ticketTtlMs = 30_000,
  futureSkewMs = 0, getLoadState, getLoadDetails, publicSlot = null, streamMarkers = false } = {}) {
  if (![nodeId, generation, build].every(id) || typeof host !== 'string' || !host || !int(port, 0, 65535)
    || !int(protocol, 1, Number.MAX_SAFE_INTEGER) || typeof now !== 'function') throw new TypeError('invalid game node');
  for (const [name, value, max] of [['bindTimeoutMs', bindTimeoutMs, 5000], ['heartbeatMs', heartbeatMs, 300_000],
    ['sweepMs', sweepMs, 30_000], ['shutdownMs', shutdownMs, 5000], ['publicationMs', publicationMs, 120_000]]) {
    if (!int(value, 1, max)) throw new RangeError(`invalid ${name}`);
  }
  if (!int(futureSkewMs, 0, 2000)) throw new RangeError('invalid futureSkewMs');
  if (!int(ticketTtlMs, 1, 30_000)) throw new RangeError('invalid admission ticket lifetime');
  if ([getLoadState, getLoadDetails].some(fn => fn !== undefined && typeof fn !== 'function')) throw new TypeError('invalid load provider');
  if (typeof streamMarkers !== 'boolean') throw new TypeError('invalid game stream markers');
  if (publicSlot !== null && publicGameLabel(publicSlot) === null) throw new TypeError('invalid public node slot');
  const authority = createRpcAuthenticator({ key, scope: nodeId, now });
  // Optional peer clock tolerance never relaxes expiry or any context field.
  const tickets = ticketsAuthority ?? createTicketAuthority({ key, issuer: ticketIssuer, now, ttlMs: ticketTtlMs, futureSkewMs });
  if (typeof tickets.verify !== 'function') throw new TypeError('invalid ticket authority');
  const gameHost = new GameHost({ data, combatPool, trialPool, MatchClass, onEnd, now, log, prepareMs, terminalControl: streamMarkers });
  const conns = new Map(), sockets = new Set(), publications = new Map();
  let stopped = false, heartbeatTimer, sweepTimer, closePromise;
  const report = operation => { try { log.error?.(`[game-node] ${operation} failed`); } catch {} };
  const time = () => {
    let value;
    try { value = now(); } catch { throw new RangeError('invalid node clock'); }
    if (!int(value, 0, Number.MAX_SAFE_INTEGER)) throw new RangeError('invalid node clock');
    return value;
  };
  time();
  const forgetPublication = assignmentId => {
    const lease = publications.get(assignmentId);
    if (lease) clearTimeout(lease.timer);
    publications.delete(assignmentId);
  };
  const expirePublication = (assignmentId, lease) => {
    if (publications.get(assignmentId) !== lease || lease.published) return;
    forgetPublication(assignmentId);
    if (gameHost.get(assignmentId)?.generation === lease.actorGeneration) gameHost.release(assignmentId);
  };
  const sweepPublications = () => {
    const at = time();
    for (const [assignmentId, lease] of publications) {
      if (!gameHost.get(assignmentId)) forgetPublication(assignmentId);
      else if (!lease.published && at >= lease.deadline) expirePublication(assignmentId, lease);
    }
  };
  const nodeReady = () => {
    if (stopped) return false;
    if (!combatPool) return true; // The isolated inline fixture is still supported.
    try { const stats = combatPool.stats(); return stats.status === 'ready' && stats.ready > 0; } catch { return false; }
  };
  const poolHealth = pool => {
    if (!pool) return { status: 'disabled', workers: 0, ready: 0 };
    try {
      const stats = pool.stats();
      if (!['new', 'starting', 'ready', 'closing', 'closed', 'degraded'].includes(stats.status)
        || !int(stats.workers, 0, 64) || !int(stats.ready, 0, stats.workers)) throw new TypeError('invalid pool statistics');
      return { status: stats.status, workers: stats.workers, ready: stats.ready };
    } catch { return { status: 'unknown', workers: 0, ready: 0 }; }
  };
  const cachedLoad = () => {
    let loadState = 'unknown', loadDetails = null;
    try { if (getLoadState) loadState = normalizeServerLoad(getLoadState()); } catch { /* cached diagnostics only */ }
    try { if (getLoadDetails) loadDetails = normalizeLoadDetails(getLoadDetails()); } catch { /* cached diagnostics only */ }
    return { loadState, loadDetails };
  };
  const publicLoad = load => {
    if (publicSlot === null) return null;
    const value = normalizeGameLoad({ label: publicGameLabel(publicSlot), status: nodeReady() ? 'ready' : 'unavailable', ...load });
    return normalizeClusterLoad({ scope: 'game', nodes: [value] });
  };
  const playersReady = handle => {
    const players = handle.seats.filter(s => !s.isBot).map(s => gameHost.member(handle.assignmentId, s.playerId)).filter(Boolean);
    return players.length > 0 && players.every(member => member.role === 'player' && member.connected);
  };
  const smallHandle = handle => handle && ({ assignmentId: handle.assignmentId, roomCode: handle.roomCode, nodeId, generation,
    actorGeneration: handle.generation, build: handle.build, protocol: handle.protocol, state: handle.state, playersReady: playersReady(handle),
    published: publications.get(handle.assignmentId)?.published === true,
    preparedAt: handle.preparedAt, expiresAt: handle.expiresAt, committedAt: handle.committedAt, endedAt: handle.endedAt });
  const memberView = (assignmentId, sessionId) => {
    const member = gameHost.member(assignmentId, sessionId);
    return member && { assignmentId, sessionId, nodeId, generation, actorGeneration: member.generation, role: member.role, connected: member.connected };
  };
  const closeMember = (assignmentId, sessionId) => {
    for (const conn of conns.values()) if (conn.assignmentId === assignmentId && conn.sessionId === sessionId) closeConn(conn, 1000, 'MEMBER_LEFT');
  };
  const guardedMember = (payload, extra = []) => {
    check(payload, ['assignmentId', 'sessionId', ...extra], ['nodeGeneration', 'actorGeneration']);
    checkAssignment(payload);
    if (!id(payload.sessionId)) throw new RpcError('BAD_REQUEST');
    if (streamMarkers || payload.nodeGeneration !== undefined || payload.actorGeneration !== undefined) {
      if (!id(payload.nodeGeneration) || !int(payload.actorGeneration, 1, Number.MAX_SAFE_INTEGER)) throw new RpcError('BAD_REQUEST');
      if (payload.nodeGeneration !== generation || gameHost.get(payload.assignmentId)?.generation !== payload.actorGeneration) {
        throw new RpcError('STALE_ASSIGNMENT');
      }
    }
  };
  const operations = {
    prepare(payload) {
      if (payload.build !== build || payload.protocol !== protocol) throw new RpcError('CONTEXT');
      if (!nodeReady()) throw new RpcError('NOT_READY');
      return smallHandle(gameHost.prepare(payload));
    },
    commit(payload) {
      check(payload, ['assignmentId']); checkAssignment(payload);
      const current = gameHost.get(payload.assignmentId);
      if (!current) throw new RpcError('STALE_ASSIGNMENT');
      if (current.state === 'prepared' && (!nodeReady() || !playersReady(current))) {
        throw new RpcError('NOT_READY');
      }
      const committed = gameHost.commit(payload.assignmentId);
      if (!publications.has(payload.assignmentId)) {
        const lease = { actorGeneration: committed.generation, published: false, deadline: committed.committedAt + publicationMs };
        publications.set(payload.assignmentId, lease);
        // This is a bounded new-allocation acknowledgement lease, not rolling /
        // drain. A retry never extends it; even a stalled wall clock cannot keep
        // an unpublished actor forever because the physical timer also fences it.
        lease.timer = setTimeout(() => expirePublication(payload.assignmentId, lease), publicationMs);
        lease.timer.unref?.();
      }
      if (streamMarkers) for (const conn of conns.values()) {
        if (conn.bound && conn.assignmentId === payload.assignmentId) control(conn, { t: 'cluster.started', assignmentId: conn.assignmentId, sessionId: conn.sessionId });
      }
      return smallHandle(committed);
    },
    publish(payload) {
      check(payload, ['assignmentId']); checkAssignment(payload);
      const assignment = gameHost.get(payload.assignmentId);
      if (!assignment) throw new RpcError('STALE_ASSIGNMENT');
      const lease = publications.get(payload.assignmentId);
      if (!lease || !['committed', 'ended'].includes(assignment.state)) throw new RpcError('WRONG_PHASE');
      lease.published = true; clearTimeout(lease.timer); lease.timer = null;
      return smallHandle(assignment);
    },
    abort(payload) {
      check(payload, ['assignmentId']); checkAssignment(payload);
      const result = gameHost.abort(payload.assignmentId);
      if (result) forgetPublication(payload.assignmentId);
      return result;
    },
    release(payload) {
      check(payload, ['assignmentId'], ['nodeGeneration', 'actorGeneration']); checkAssignment(payload);
      if (payload.nodeGeneration !== undefined || payload.actorGeneration !== undefined) {
        if (!id(payload.nodeGeneration) || !int(payload.actorGeneration, 1, Number.MAX_SAFE_INTEGER)) throw new RpcError('BAD_REQUEST');
        const actor = gameHost.get(payload.assignmentId);
        if (payload.nodeGeneration !== generation || (actor && actor.generation !== payload.actorGeneration)) throw new RpcError('STALE_ASSIGNMENT');
      }
      forgetPublication(payload.assignmentId);
      return gameHost.release(payload.assignmentId);
    },
    status(payload) {
      check(payload, [], ['assignmentId', 'sessionId', 'receipt']);
      const value = { nodeId, generation, build, protocol, ready: nodeReady(), streamMarkers, terminalControl: streamMarkers, counts: gameHost.stats(),
        publicSlot, ...cachedLoad(), health: { combat: poolHealth(combatPool), trial: poolHealth(trialPool) } };
      if (payload.assignmentId !== undefined) {
        checkAssignment(payload);
        const assignment = gameHost.get(payload.assignmentId);
        if (!assignment) throw new RpcError('STALE_ASSIGNMENT');
        Object.assign(value, smallHandle(assignment));
        if (payload.receipt !== undefined) {
          if (payload.receipt !== true || !id(payload.sessionId)) throw new RpcError('BAD_REQUEST');
          if (!gameHost.member(payload.assignmentId, payload.sessionId)) throw new RpcError('NOT_MEMBER');
          const receipt = assignment.receipt;
          value.receipt = receipt ? { assignmentId: receipt.assignmentId, actorGeneration: receipt.generation,
            summary: receipt.summary, result: Object.hasOwn(receipt.results, payload.sessionId) ? receipt.results[payload.sessionId] : null } : null;
        } else if (payload.sessionId !== undefined) throw new RpcError('BAD_REQUEST');
      } else if (payload.sessionId !== undefined || payload.receipt !== undefined) throw new RpcError('BAD_REQUEST');
      return value;
    },
    member(payload) { checkMember(payload); return memberView(payload.assignmentId, payload.sessionId); },
    addSpectator(payload) { guardedMember(payload); return gameHost.addSpectator(payload.assignmentId, payload.sessionId); },
    removeSpectator(payload) {
      guardedMember(payload);
      const guarded = payload.actorGeneration !== undefined;
      const result = guarded && !gameHost.member(payload.assignmentId, payload.sessionId) ? { ok: true }
        : gameHost.removeSpectator(payload.assignmentId, payload.sessionId);
      if (!gameHost.member(payload.assignmentId, payload.sessionId)) {
        closeMember(payload.assignmentId, payload.sessionId);
        // Membership absence is the authoritative revocation ACK, even if an
        // engine hook failed after removal. Guarded retries are idempotent.
        if (guarded) return { ok: true };
      }
      return result;
    },
    leave(payload) {
      guardedMember(payload);
      const guarded = payload.actorGeneration !== undefined;
      const result = guarded && !gameHost.member(payload.assignmentId, payload.sessionId) ? { ok: true }
        : gameHost.leave(payload.assignmentId, payload.sessionId);
      if (!gameHost.member(payload.assignmentId, payload.sessionId)) {
        closeMember(payload.assignmentId, payload.sessionId);
        if (guarded) return { ok: true };
      }
      return result;
    },
    setLoadout(payload) {
      guardedMember(payload, ['loadout']);
      return gameHost.setLoadout(payload.assignmentId, payload.sessionId, payload.loadout);
    },
  };
  const rpc = createRpcHandler({ authority, operations: Object.fromEntries(Object.entries(operations).map(([name, operation]) =>
    [name, payload => { sweepPublications(); return operation(payload); }])) });
  const server = http.createServer((req, res) => {
    if (stopped) {
      res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end('{"ok":false,"code":"CLOSED"}'); return;
    }
    void rpc(req, res).catch(() => {
      report('RPC');
      if (!res.headersSent && !res.destroyed) { res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{"ok":false,"code":"INTERNAL"}'); }
      else res.destroy();
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    // Strict equality prohibits tickets/query parameters (and alternative paths).
    if (stopped || req.url !== GAME_PATH) {
      socket.end(`HTTP/1.1 ${stopped ? '503 Service Unavailable' : '404 Not Found'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return;
    }
    try { wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws)); }
    catch { socket.destroy(); report('upgrade'); }
  });

  function detach(conn) {
    const cleanup = conn.cleanup; conn.cleanup = null;
    try { cleanup?.(); } catch { report('cleanup'); }
  }
  function closeConn(conn, code, reason) {
    if (conn.closing) return;
    conn.closing = true;
    clearTimeout(conn.bindTimer);
    conn.pending = null; conn.pendingBytes = 0;
    detach(conn); // synchronous origin fencing, without waiting for a WS close ack
    try { conn.ws.close(code, reason); } catch { conn.ws.terminate(); }
  }
  function write(conn, type, data) {
    if (stopped || conn.closing || conn.ws.readyState !== 1 || typeof data !== 'string') return false;
    const sent = sendRaw(conn.ws, data, { droppable: type === 'b.snap', compress: false });
    if (!sent && (type !== 'b.snap' || conn.ws.readyState !== 1)) closeConn(conn, 1013, 'CHANNEL_UNAVAILABLE');
    return sent;
  }
  function control(conn, message) {
    const data = encode(message);
    if (data === null) { closeConn(conn, 1013, 'CHANNEL_UNAVAILABLE'); return false; }
    return write(conn, message.t, data);
  }
  function error(conn, code, rid) {
    return control(conn, { t: 'error', code, ...(validRid(rid) ? { rid } : {}) });
  }
  function enqueue(conn, type, data) {
    if (stopped || conn.closing || conn.ws.readyState !== 1 || typeof data !== 'string') return false;
    if (conn.pending === null) return write(conn, type, data);
    const queued = conn.pendingBytes + conn.ws.bufferedAmount;
    const bytes = Buffer.byteLength(data);
    if (queued + bytes > NET_DEFAULTS.hardBufferBytes) { closeConn(conn, 1013, 'CHANNEL_UNAVAILABLE'); return false; }
    if (type === 'b.snap' && queued > NET_DEFAULTS.snapDropBytes) return false;
    conn.pending.push({ type, data }); conn.pendingBytes += bytes;
    return true;
  }
  function bind(conn, message) {
    if (!plain(message) || Object.keys(message).length !== 4
      || !['t', 'assignmentId', 'sessionId', 'ticket'].every(k => Object.hasOwn(message, k))
      || message.t !== 'cluster.bind' || !id(message.assignmentId) || !id(message.sessionId) || typeof message.ticket !== 'string') {
      error(conn, 'BAD_BIND'); closeConn(conn, 1008, 'BAD_BIND'); return;
    }
    const lease = publications.get(message.assignmentId);
    if (lease && !lease.published && time() >= lease.deadline) expirePublication(message.assignmentId, lease);
    const assignment = gameHost.get(message.assignmentId);
    const member = gameHost.member(message.assignmentId, message.sessionId);
    if (!assignment || !member || assignment.build !== build || assignment.protocol !== protocol) {
      error(conn, 'UNAUTHORIZED'); closeConn(conn, 1008, 'UNAUTHORIZED'); return;
    }
    const expected = { sessionId: message.sessionId, roomCode: assignment.roomCode, assignmentId: assignment.assignmentId,
      nodeId, role: member.role, build: assignment.build, protocol: assignment.protocol };
    if (!tickets.verify(message.ticket, expected)) { error(conn, 'UNAUTHORIZED'); closeConn(conn, 1008, 'UNAUTHORIZED'); return; }
    conn.assignmentId = assignment.assignmentId; conn.sessionId = message.sessionId;
    // onReconnect/addSpectator may synchronously produce state. The short queue
    // ensures cluster.bound precedes it, and keeps already-encoded frames intact.
    conn.pending = [];
    const cleanup = gameHost.bind(conn.assignmentId, conn.sessionId, conn.channel);
    conn.cleanup = cleanup;
    if (conn.closing) { detach(conn); return; }
    if (!control(conn, { t: 'cluster.bound', assignmentId: conn.assignmentId, sessionId: conn.sessionId })) return;
    clearTimeout(conn.bindTimer);
    conn.bound = true;
    const pending = conn.pending; conn.pending = null; conn.pendingBytes = 0;
    for (const frame of pending) if (!write(conn, frame.type, frame.data)) {
      if (conn.closing) break;
    }
    if (streamMarkers && ['committed', 'ended'].includes(assignment.state)) {
      control(conn, { t: 'cluster.started', assignmentId: conn.assignmentId, sessionId: conn.sessionId });
    }
  }
  function onFrame(conn, raw, binary) {
    if (stopped || conn.closing) return;
    const at = time(); conn.alive = true;
    if (!conn.bucket.take(at)) {
      if (at - conn.dropWindowAt >= 1000) { conn.dropWindowAt = at; conn.drops = 0; }
      if (++conn.drops > NET_DEFAULTS.abuseDropsPerSec) { closeConn(conn, 1008, 'FLOOD'); return; }
      error(conn, ERR.RATE, peekRid(raw, binary)); return;
    }
    if (binary) {
      error(conn, conn.bound ? ERR.BAD_MSG : 'BAD_BIND');
      if (!conn.bound) closeConn(conn, 1008, 'BAD_BIND');
      return;
    }
    let message;
    try { message = JSON.parse(raw.toString('utf8')); } catch {
      error(conn, conn.bound ? ERR.BAD_MSG : 'BAD_BIND');
      if (!conn.bound) closeConn(conn, 1008, 'BAD_BIND');
      return;
    }
    if (!conn.bound) { bind(conn, message); return; }
    const rid = message?.rid;
    if (!plain(message) || typeof message.t !== 'string' || !Object.hasOwn(C2S, message.t) || validateC2S(message)
      || !(message.t === 'ping' || (message.t.startsWith('g.') && message.t !== 'g.leave') || message.t === 'b.progress' || message.t === 'b.result')) {
      error(conn, ERR.BAD_MSG, rid); return;
    }
    if (message.t === 'ping') {
      const pong = { t: 'pong', c: message.c, s: at, ...(validRid(rid) ? { rid } : {}) };
      const load = cachedLoad();
      if (getLoadState) pong.loadState = load.loadState;
      if (load.loadDetails !== null) pong.loadDetails = load.loadDetails;
      const clusterLoad = publicLoad(load);
      if (clusterLoad !== null) pong.clusterLoad = clusterLoad;
      control(conn, pong); return;
    }
    if (message.t === 'g.watch' && !conn.heavy.take(at)) { error(conn, ERR.RATE, rid); return; }
    const lease = publications.get(conn.assignmentId);
    if (lease && !lease.published && at >= lease.deadline) expirePublication(conn.assignmentId, lease);
    const current = gameHost.get(conn.assignmentId);
    if (!current || current.state === 'prepared' || current.state === 'starting') {
      if (message.t !== 'b.progress' || validRid(rid)) error(conn, ERR.WRONG_PHASE, rid);
      return;
    }
    const result = gameHost.handle(conn.assignmentId, conn.sessionId, message, conn.channel);
    if (result?.error) {
      if (message.t === 'b.progress' && !validRid(rid)) return;
      error(conn, isErrCode(result.error) ? result.error : ERR.INTERNAL, rid);
    } else if (validRid(rid)) control(conn, { t: 'ok', rid });
  }
  wss.on('connection', ws => {
    if (stopped) { ws.close(1001, 'SHUTDOWN'); return; }
    let at;
    try { at = time(); } catch {
      report('clock'); ws.once('error', () => report('socket')); ws.close(1011, 'INTERNAL'); return;
    }
    const conn = { ws, bound: false, closing: false, cleanup: null, alive: true, pending: null, pendingBytes: 0,
      assignmentId: null, sessionId: null, bucket: new TokenBucket(NET_DEFAULTS.ratePerSec, NET_DEFAULTS.rateBurst, at),
      heavy: new TokenBucket(NET_DEFAULTS.heavyPerSec, NET_DEFAULTS.heavyBurst, at), dropWindowAt: at, drops: 0 };
    conn.channel = {
      send(message) { const data = encode(message); return data !== null && enqueue(conn, message?.t, data); },
      sendEncoded(type, data) { return enqueue(conn, type, data); },
      close(code, reason) { closeConn(conn, code, reason); },
    };
    conns.set(ws, conn);
    conn.bindTimer = setTimeout(() => closeConn(conn, 4002, 'BIND_TIMEOUT'), bindTimeoutMs);
    conn.bindTimer.unref?.();
    ws.on('message', (raw, binary) => {
      try { onFrame(conn, raw, binary); }
      catch { report('frame'); error(conn, ERR.INTERNAL); closeConn(conn, 1011, 'INTERNAL'); }
    });
    ws.on('pong', () => { conn.alive = true; });
    ws.on('error', () => { report('socket'); closeConn(conn, 1011, 'TRANSPORT'); });
    ws.once('close', () => {
      conn.closing = true; clearTimeout(conn.bindTimer); conn.pending = null; detach(conn); conns.delete(ws);
    });
  });
  wss.on('error', () => report('WebSocket server'));

  async function close() {
    if (closePromise) return closePromise;
    stopped = true; clearInterval(heartbeatTimer); clearInterval(sweepTimer);
    for (const assignmentId of publications.keys()) forgetPublication(assignmentId);
    gameHost.close();
    for (const conn of conns.values()) closeConn(conn, 1001, 'SHUTDOWN');
    closePromise = new Promise(resolve => {
      let remaining = 2;
      const done = () => { if (--remaining === 0) { clearTimeout(force); resolve(); } };
      const force = setTimeout(() => {
        for (const ws of wss.clients) ws.terminate();
        for (const socket of sockets) socket.destroy();
      }, shutdownMs);
      force.unref?.();
      wss.close(done);
      server.close(done);
      server.closeIdleConnections?.();
    });
    return closePromise;
  }
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
    });
  } catch { await close(); throw new RpcError('LISTEN'); }
  server.on('error', () => report('HTTP server'));
  heartbeatTimer = setInterval(() => {
    for (const conn of conns.values()) {
      if (!conn.alive) { conn.closing = true; detach(conn); conn.ws.terminate(); continue; }
      conn.alive = false;
      if (!conn.closing) { try { conn.ws.ping(); } catch { closeConn(conn, 1011, 'TRANSPORT'); } }
    }
  }, heartbeatMs);
  heartbeatTimer.unref?.();
  sweepTimer = setInterval(() => { try { gameHost.sweep(); sweepPublications(); } catch { report('sweep'); } }, sweepMs);
  sweepTimer.unref?.();
  const address = server.address();
  const hostname = address.address.includes(':') ? `[${address.address}]` : address.address;
  return { url: `http://${hostname}:${address.port}`, server, wss, gameHost, close };
}
