// Private WS ingress behind the existing TLS/password/Origin gate. One browser
// socket carries lobby control and its assigned node's direct game stream.
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { NET_DEFAULTS, TokenBucket, clientAddress, encode, sendRaw, errorMsg, CLOSE } from '../net.js';
import { C2S, validateC2S } from '../../shared/protocol.js';
import { ERR } from '../../shared/constants.js';
import { isCompressibleType, resolveWsCompression } from '../wsCompression.js';

const safeId = v => typeof v === 'string' && v.length > 0 && v.length <= 128 && /^[A-Za-z0-9_-][A-Za-z0-9_.:-]*(?![\s\S])/.test(v);
const typeOf = raw => /^\s*\{\s*"t"\s*:\s*"([A-Za-z0-9_.-]{1,64})"/.exec(raw.slice(0, 256))?.[1] ?? null;
const gameIntent = t => (t.startsWith('g.') && t !== 'g.leave') || t === 'b.progress' || t === 'b.result';
const plain = v => !!v && Object.getPrototypeOf(v) === Object.prototype;
const validRid = v => Number.isInteger(v) && v >= 0 && v <= 2 ** 31;
function targetUrl(value, path) {
  const url = new URL(value);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !['/', path].includes(url.pathname)) throw new TypeError('invalid ingress upstream');
  url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:';
  url.pathname = path;
  return url.toString();
}

export async function startIngress({ host = '127.0.0.1', port = 0, coordinatorUrl, nodes, origins,
  wsCompression = 'on', trustProxy = 'auto', now = Date.now, heartbeatMs = NET_DEFAULTS.heartbeatMs,
  connectMs = 5000, replacementGraceMs = 2000, shutdownMs = 1000 } = {}) {
  if (typeof host !== 'string' || !host || !Number.isInteger(port) || port < 0 || port > 65535 || typeof now !== 'function'
    || !Array.isArray(nodes) || !Array.isArray(origins) || !origins.length) throw new TypeError('invalid ingress');
  for (const n of [heartbeatMs, connectMs, replacementGraceMs, shutdownMs]) if (!Number.isSafeInteger(n) || n < 1 || n > 300_000) throw new RangeError('invalid ingress deadline');
  const allowedOrigins = new Set(origins.map(origin => {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || origin !== url.origin) throw new TypeError('invalid ingress Origin');
    return origin;
  }));
  const clock = () => { const at = now(); if (!Number.isSafeInteger(at) || at < 0) throw new RangeError('invalid ingress clock'); return at; };
  clock();
  const controlUrl = targetUrl(coordinatorUrl, '/ws'), gameUrls = new Map();
  for (const node of nodes) {
    if (!safeId(node.nodeId) || gameUrls.has(node.nodeId)) throw new TypeError('invalid ingress node');
    gameUrls.set(node.nodeId, targetUrl(node.url, '/_cluster/game'));
  }
  const wss = new WebSocketServer({ noServer: true, clientTracking: true, maxPayload: 64 * 1024, perMessageDeflate: resolveWsCompression(wsCompression) });
  const peers = new Set(), sockets = new Set();
  let stopped = false, heartbeatTimer, closePromise;
  const server = http.createServer((req, res) => {
    // Dynamic/private HTTP stays behind the original gate and coordinator; this
    // listener exposes neither health/control RPC nor arbitrary HTTP proxying.
    res.writeHead(404, { 'cache-control': 'no-store' }); res.end();
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    if (stopped || req.url !== '/ws' || !allowedOrigins.has(req.headers.origin)) {
      socket.end(`HTTP/1.1 ${stopped ? '503 Service Unavailable' : req.url !== '/ws' ? '404 Not Found' : '403 Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return;
    }
    try { wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)); } catch { socket.destroy(); }
  });

  function closeGame(game) {
    if (!game) return;
    game.expectedClose = true; clearTimeout(game.timer);
    game.pending = []; game.pendingBytes = 0;
    try { game.socket.close(); } catch { game.socket.terminate(); }
  }
  function closePeer(peer, code = 4000, reason = 'CONNECTION_UNAVAILABLE', { handoff = false } = {}) {
    if (peer.closing) return;
    peer.closing = true; peer.handoff = handoff;
    clearTimeout(peer.controlTimer);
    try { peer.client.close(code, reason); } catch { peer.client.terminate(); }
    try { peer.control?.close(); } catch { peer.control?.terminate(); }
    if (handoff) {
      peer.handoffTimer = setTimeout(() => { closeGame(peer.game); closeGame(peer.previousGame); peers.delete(peer); }, replacementGraceMs);
      peer.handoffTimer.unref?.();
    } else { closeGame(peer.game); closeGame(peer.previousGame); }
  }
  function outward(peer, raw, type = typeOf(raw)) {
    if (peer.closing) return false;
    const ok = sendRaw(peer.client, raw, { droppable: type === 'b.snap', compress: isCompressibleType(type) });
    if (!ok && (type !== 'b.snap' || peer.client.readyState !== 1)) closePeer(peer, 1013, 'BACKPRESSURE');
    return ok;
  }
  function inward(socket, raw) {
    return sendRaw(socket, raw, { compress: false });
  }
  function flush(peer, game) {
    if (!game.bound || !game.started || !game.published || game.terminal || peer.game !== game || peer.closing) return;
    const frames = game.pending; game.pending = []; game.pendingBytes = 0;
    for (const frame of frames) if (!outward(peer, frame.raw, frame.type) && peer.closing) break;
    const deferred = peer.matchedPending; peer.matchedPending = []; peer.matchedBytes = 0;
    for (const raw of deferred) if (!outward(peer, raw, 'queue.state') && peer.closing) break;
  }
  function gameFrame(peer, game, raw, binary) {
    if (peer.game !== game || game.terminal || peer.closing) return;
    if (binary) { closePeer(peer, 1011, 'INVALID_GAME_FRAME'); return; }
    const text = raw.toString(), type = typeOf(text);
    // Only authenticated coordinator terminal receipts deliver results. Even a
    // late/replayed node end frame must not duplicate or overtake that receipt.
    if (type === 'm.result') return;
    if (type === 'm.public') {
      let frame;
      try { frame = JSON.parse(text); } catch { closePeer(peer, 1011, 'INVALID_GAME_FRAME'); return; }
      if (['RESULT', 'ENDED'].includes(frame.phase)) return;
    }
    if (type === 'cluster.bound') {
      let message;
      try { message = JSON.parse(text); } catch { closePeer(peer, 1011, 'INVALID_GAME_FRAME'); return; }
      if (message.assignmentId !== game.assignmentId || message.sessionId !== peer.playerId) { closePeer(peer, 1011, 'INVALID_GAME_BIND'); return; }
      game.bound = true; clearTimeout(game.timer);
      closeGame(peer.previousGame); peer.previousGame = null;
      flush(peer, game); return;
    }
    if (type === 'cluster.started') {
      let message;
      try { message = JSON.parse(text); } catch { closePeer(peer, 1011, 'INVALID_GAME_FRAME'); return; }
      if (message.assignmentId !== game.assignmentId || message.sessionId !== peer.playerId) { closePeer(peer, 1011, 'INVALID_GAME_BIND'); return; }
      game.started = true; flush(peer, game); return;
    }
    if (type?.startsWith('cluster.')) { closePeer(peer, 1011, 'INVALID_GAME_FRAME'); return; }
    if (game.published && game.bound && game.started) { outward(peer, text, type); return; }
    const bytes = Buffer.byteLength(text);
    if (game.pendingBytes + bytes > NET_DEFAULTS.hardBufferBytes) { closePeer(peer, 1013, 'BACKPRESSURE'); return; }
    if (type === 'b.snap' && game.pendingBytes > NET_DEFAULTS.snapDropBytes) return;
    game.pending.push({ raw: text, type }); game.pendingBytes += bytes;
  }
  function route(peer, message) {
    if (!plain(message) || !safeId(message.assignmentId)) { closePeer(peer, 1011, 'INVALID_ROUTE'); return; }
    if (message.t === 'cluster.prepare') {
      const url = gameUrls.get(message.nodeId);
      if (!url || message.sessionId !== peer.playerId || typeof message.ticket !== 'string' || message.ticket.length > 4096
        || typeof message.published !== 'boolean') { closePeer(peer, 1011, 'INVALID_ROUTE'); return; }
      // Keep the old game channel until the new one binds: replacing the same
      // session must not briefly trigger disconnected-player autoplay.
      closeGame(peer.previousGame); peer.previousGame = peer.game;
      const socket = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: connectMs, maxPayload: NET_DEFAULTS.hardBufferBytes });
      const game = { socket, assignmentId: message.assignmentId, bound: false, started: false, published: message.published,
        pending: [], pendingBytes: 0, expectedClose: false, terminal: false };
      peer.game = game;
      socket.on('open', () => inward(socket, JSON.stringify({ t: 'cluster.bind', assignmentId: message.assignmentId, sessionId: peer.playerId, ticket: message.ticket })));
      socket.on('message', (raw, binary) => gameFrame(peer, game, raw, binary));
      socket.on('error', () => { if (!game.expectedClose && peer.game === game) closePeer(peer); });
      socket.on('close', (code, reason) => {
        clearTimeout(game.timer);
        if (game.expectedClose || peer.game !== game || peer.closing) return;
        const replaced = code === 1000 && reason.toString() === 'game channel replaced';
        if (replaced) closePeer(peer, CLOSE.REPLACED, 'SESSION_REPLACED');
        else if (code === 1000 && reason.toString() === 'MEMBER_LEFT') { peer.game = null; closeGame(peer.previousGame); peer.previousGame = null; }
        else if (code === 1001 && reason.toString() === 'game assignment released') {
          // Node release can overtake terminal/abort on the independent control
          // transport. Keep only this fenced route until that ordered marker;
          // game intents fall back to the live control channel meanwhile. Never
          // use a timeout to decide that the reliable terminal frame was lost.
          game.bound = false; game.pending = []; game.pendingBytes = 0;
          closeGame(peer.previousGame); peer.previousGame = null;
        } else {
          game.timer = setTimeout(() => { if (!game.expectedClose && peer.game === game) closePeer(peer); }, 100);
          game.timer.unref?.();
        }
      });
      game.timer = setTimeout(() => { if (!game.bound && peer.game === game) closePeer(peer); }, connectMs);
      game.timer.unref?.();
      return;
    }
    const game = peer.game;
    if (!game || game.assignmentId !== message.assignmentId) return; // late abort/commit cannot touch a new match
    if (message.t === 'cluster.terminal') {
      if (message.sessionId !== peer.playerId || !plain(message.result) || message.result.t !== 'm.result'
        || (message.lastPublic !== null && (!plain(message.lastPublic) || message.lastPublic.t !== 'm.public'))
        || Object.keys(message).some(key => !['t', 'assignmentId', 'sessionId', 'lastPublic', 'result'].includes(key))) {
        closePeer(peer, 1011, 'INVALID_ROUTE'); return;
      }
      if (game.terminal) return; // Exact-once per live channel/assignment; hello replay remains intentional.
      game.terminal = true;
      game.pending = []; game.pendingBytes = 0;
      peer.matchedPending = []; peer.matchedBytes = 0;
      for (const frame of [message.lastPublic, message.result]) if (frame && !outward(peer, encode(frame), frame.t)) return;
    } else if (message.t === 'cluster.commit') { game.published = true; flush(peer, game); }
    else if (message.t === 'cluster.abort' || message.t === 'cluster.detach' || message.t === 'cluster.terminate') {
      closeGame(game); closeGame(peer.previousGame); peer.game = peer.previousGame = null;
      peer.matchedPending = []; peer.matchedBytes = 0;
    } else closePeer(peer, 1011, 'INVALID_ROUTE');
  }

  wss.on('connection', (client, req) => {
    let at;
    try { at = clock(); } catch { client.on('error', () => {}); client.close(1011, 'CLOCK_UNAVAILABLE'); return; }
    const peer = { client, control: null, controlReady: false, controlPending: [], controlBytes: 0, playerId: null,
      game: null, previousGame: null, matchedPending: [], matchedBytes: 0, closing: false, handoff: false, alive: true,
      bucket: new TokenBucket(NET_DEFAULTS.ratePerSec, NET_DEFAULTS.rateBurst, at),
      heavy: new TokenBucket(NET_DEFAULTS.heavyPerSec, NET_DEFAULTS.heavyBurst, at), dropWindowAt: at, drops: 0 };
    peers.add(peer);
    const address = clientAddress(req, trustProxy);
    const headers = { origin: req.headers.origin, 'x-real-ip': address.ip, 'x-forwarded-for': address.ip,
      'x-forwarded-proto': new URL(req.headers.origin).protocol.slice(0, -1) };
    const control = new WebSocket(controlUrl, { headers, perMessageDeflate: false, handshakeTimeout: connectMs, maxPayload: NET_DEFAULTS.hardBufferBytes });
    peer.control = control;
    peer.controlTimer = setTimeout(() => { if (!peer.controlReady) closePeer(peer); }, connectMs); peer.controlTimer.unref?.();
    control.on('open', () => {
      if (peer.closing) return;
      peer.controlReady = true; clearTimeout(peer.controlTimer);
      const frames = peer.controlPending; peer.controlPending = []; peer.controlBytes = 0;
      for (const raw of frames) if (!inward(control, raw)) { closePeer(peer); break; }
    });
    control.on('message', (raw, binary) => {
      if (peer.closing) return;
      if (binary) { closePeer(peer, 1011, 'INVALID_CONTROL_FRAME'); return; }
      const text = raw.toString(), type = typeOf(text);
      if (type === 'welcome') {
        let welcome;
        try { welcome = JSON.parse(text); } catch { closePeer(peer, 1011, 'INVALID_CONTROL_FRAME'); return; }
        if (!safeId(welcome.playerId) || (peer.playerId && peer.playerId !== welcome.playerId)) { closePeer(peer, 1011, 'INVALID_IDENTITY'); return; }
        peer.playerId = welcome.playerId;
      }
      if (type?.startsWith('cluster.')) {
        const limit = type === 'cluster.terminal' ? 2 * 1024 * 1024 + 1024 : 8192;
        if (Buffer.byteLength(text) > limit) { closePeer(peer, 1011, 'INVALID_ROUTE'); return; }
        try { route(peer, JSON.parse(text)); } catch { closePeer(peer, 1011, 'INVALID_ROUTE'); }
        return;
      }
      // A late lobby heartbeat cannot replace the running game's load/latency sample.
      if (type === 'pong' && peer.game?.bound && peer.game.started && peer.game.published) return;
      if (type === 'queue.state' && peer.game && !peer.game.started) {
        let message;
        try { message = JSON.parse(text); } catch { closePeer(peer, 1011, 'INVALID_CONTROL_FRAME'); return; }
        if (message.state === 'matched') {
          const bytes = Buffer.byteLength(text);
          if (peer.matchedBytes + bytes > NET_DEFAULTS.hardBufferBytes) { closePeer(peer, 1013, 'BACKPRESSURE'); return; }
          peer.matchedPending.push(text); peer.matchedBytes += bytes; return;
        }
      }
      outward(peer, text, type);
    });
    control.on('error', () => { if (!peer.closing) closePeer(peer); });
    control.on('close', (code) => {
      if (peer.closing) return;
      if (code === CLOSE.REPLACED) closePeer(peer, code, 'SESSION_REPLACED', { handoff: true });
      else closePeer(peer, code === CLOSE.HELLO_TIMEOUT ? code : 4000, 'CONTROL_UNAVAILABLE');
    });
    const onClientFrame = (raw, binary) => {
      if (peer.closing) return;
      const at = clock(); peer.alive = true;
      if (!peer.bucket.take(at)) {
        if (at - peer.dropWindowAt >= 1000) { peer.dropWindowAt = at; peer.drops = 0; }
        if (++peer.drops > NET_DEFAULTS.abuseDropsPerSec) closePeer(peer, CLOSE.POLICY, 'RATE_LIMIT');
        else outward(peer, encode(errorMsg(ERR.RATE)));
        return;
      }
      let message;
      try { if (binary) throw new Error(); message = JSON.parse(raw.toString()); } catch { outward(peer, encode(errorMsg(ERR.BAD_MSG))); return; }
      const rid = message?.rid;
      if (!plain(message) || typeof message.t !== 'string' || !Object.hasOwn(C2S, message.t) || validateC2S(message)) {
        outward(peer, encode(errorMsg(ERR.BAD_MSG, validRid(rid) ? rid : undefined))); return;
      }
      if (['g.watch', 'room.loadout', 'queue.join', 'room.spectate'].includes(message.t) && !peer.heavy.take(at)) {
        outward(peer, encode(errorMsg(ERR.RATE, rid))); return;
      }
      const text = raw.toString();
      const game = peer.game;
      if (game?.bound && game.started && game.published && (gameIntent(message.t) || message.t === 'ping')) {
        if (!inward(game.socket, text)) closePeer(peer);
      } else if (peer.controlReady) {
        if (!inward(control, text)) closePeer(peer);
      } else {
        const bytes = Buffer.byteLength(text);
        if (peer.controlBytes + bytes > NET_DEFAULTS.snapDropBytes) { closePeer(peer, 1013, 'BACKPRESSURE'); return; }
        peer.controlPending.push(text); peer.controlBytes += bytes;
      }
    };
    client.on('message', (raw, binary) => { try { onClientFrame(raw, binary); } catch { closePeer(peer, 1011, 'FRAME_UNAVAILABLE'); } });
    client.on('pong', () => { peer.alive = true; });
    client.on('error', () => closePeer(peer));
    client.on('close', () => {
      if (!peer.closing) closePeer(peer);
      if (!peer.handoff) { clearTimeout(peer.handoffTimer); peers.delete(peer); }
    });
  });
  wss.on('error', () => {});
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(); }); }); }
  catch (e) { wss.close(); server.close(); throw new Error('ingress listen failed'); }
  server.on('error', () => {});
  heartbeatTimer = setInterval(() => {
    for (const peer of peers) {
      if (peer.closing) continue;
      if (!peer.alive) { closePeer(peer); peer.client.terminate(); continue; }
      peer.alive = false; try { peer.client.ping(); } catch { closePeer(peer); }
    }
  }, heartbeatMs); heartbeatTimer.unref?.();
  const addRoutes = configured => {
    if (stopped || !Array.isArray(configured)) throw new TypeError('invalid route extension');
    const next = new Map();
    for (const node of configured) {
      if (!safeId(node.nodeId) || next.has(node.nodeId)) throw new TypeError('invalid route extension');
      const url = targetUrl(node.url, '/_cluster/game');
      if (gameUrls.has(node.nodeId) && gameUrls.get(node.nodeId) !== url) throw new TypeError('live route identity cannot change');
      next.set(node.nodeId, url);
    }
    if ([...gameUrls.keys()].some(id => !next.has(id))) throw new TypeError('live route removal requires a separate lifecycle operation');
    const added = [];
    for (const [id, url] of next) if (!gameUrls.has(id)) { gameUrls.set(id, url); added.push(id); }
    return Object.freeze(added);
  };
  const close = () => {
    if (closePromise) return closePromise;
    stopped = true; clearInterval(heartbeatTimer);
    for (const peer of peers) { clearTimeout(peer.handoffTimer); peer.handoff = false; closePeer(peer, 1001, 'SHUTDOWN'); closeGame(peer.game); closeGame(peer.previousGame); }
    closePromise = new Promise(resolve => {
      let pending = 2;
      const done = () => { if (--pending === 0) { clearTimeout(force); resolve(); } };
      const force = setTimeout(() => { for (const peer of peers) { peer.client.terminate(); peer.control?.terminate(); peer.game?.socket.terminate(); peer.previousGame?.socket.terminate(); } for (const socket of sockets) socket.destroy(); }, shutdownMs);
      force.unref?.(); wss.close(done); server.close(done);
    });
    return closePromise;
  };
  const address = server.address(), hostname = address.address.includes(':') ? `[${address.address}]` : address.address;
  return { url: `http://${hostname}:${address.port}`, server, wss, addRoutes, close };
}
