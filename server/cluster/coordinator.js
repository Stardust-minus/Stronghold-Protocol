// Opt-in assembly: one global Lobby and a separate authenticated terminal-event
// listener. High-frequency game data goes directly from nodes to ingress sockets.
import http from 'node:http';
import { startServer } from '../index.js';
import { sendSession } from '../net.js';
import { PROTOCOL_VERSION } from '../../shared/constants.js';
import { ClusterLobby } from './lobby.js';
import { RemoteGamePlatform } from './platform.js';
import { createRpcAuthenticator, createRpcHandler } from './rpc.js';
import { createReceiptSink } from './receipts.js';

export async function startCoordinator({ nodes, build, protocol = PROTOCOL_VERSION, privateHost = '127.0.0.1', privatePort = 0,
  heartbeatMs = 1500, ...options } = {}) {
  if (!Number.isSafeInteger(privatePort) || privatePort < 0 || privatePort > 65535 || typeof privateHost !== 'string' || !privateHost
    || !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 100 || heartbeatMs > 30_000) throw new TypeError('invalid coordinator listener');
  let app, sink, privateServer, timer, stopped = false, closing;
  const privateSockets = new Set(), handlers = new Map();
  const platform = new RemoteGamePlatform({ nodes, build, protocol, requireStreamMarkers: true,
    loadTtlMs: Math.max(5000, Math.min(30_000, heartbeatMs * 3)),
    sendControl: (playerId, message) => app ? sendSession(app.registry.byId(playerId), message) : false,
    onPublished: assignmentId => sink?.flush(assignmentId),
    onUnavailable: info => {
      // Losing the node is not victory/defeat and cannot manufacture a result.
      // Drop only this assignment's room, leaving all other nodes/rooms intact.
      const room = app?.lobby.getRoom(info.roomCode);
      const plan = app?.lobby.assignments.get(info.assignmentId);
      if (plan && room === plan.room) app.lobby.disposeRoom(room, 'node-unavailable');
    } });
  try {
    await platform.refresh();
    app = await startServer({ ...options, host: options.host ?? '127.0.0.1', combatWorkers: 0, trialWorkers: 0,
      snapshotHz: options.snapshotHz ?? 10, wsCompression: 'off', allowAsyncHandlers: true,
      getClusterLoad: () => platform.publicLoad(),
      lobbyFactory: params => new ClusterLobby({ ...params, platform }) });
    sink = createReceiptSink({ platform, lobby: app.lobby });
    for (const node of nodes) handlers.set(node.nodeId, createRpcHandler({
      authority: createRpcAuthenticator({ key: node.key, scope: node.nodeId }), operations: sink.opsForNode(node.nodeId) }));
    privateServer = http.createServer((req, res) => {
      const handler = handlers.get(req.headers['x-ark-cluster-scope']);
      if (stopped || !handler) {
        res.writeHead(stopped ? 503 : 401, { 'cache-control': 'no-store', 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, code: stopped ? 'CLOSED' : 'UNAUTHORIZED' })); req.resume(); return;
      }
      void handler(req, res).catch(() => { if (!res.headersSent && !res.destroyed) { res.writeHead(500); res.end(); } else res.destroy(); });
    });
    privateServer.on('connection', socket => { privateSockets.add(socket); socket.once('close', () => privateSockets.delete(socket)); });
    await new Promise((resolve, reject) => {
      privateServer.once('error', reject);
      privateServer.listen(privatePort, privateHost, () => { privateServer.removeListener('error', reject); resolve(); });
    });
    privateServer.on('error', () => {});
    let polling = false;
    timer = setInterval(() => {
      try { sink.sweep(); } catch { /* transient event cleanup must not interrupt games */ }
      if (stopped || polling) return;
      polling = true;
      platform.refresh().catch(() => {}).finally(() => { polling = false; });
    }, heartbeatMs);
    timer.unref?.();
  } catch (e) {
    clearInterval(timer); sink?.close();
    await app?.close(); await platform.close();
    if (privateServer) { for (const socket of privateSockets) socket.destroy(); await new Promise(resolve => privateServer.close(resolve)); }
    throw e;
  }
  const addNodes = async configured => {
    if (stopped || !Array.isArray(configured) || new Set(configured.map(node => node.nodeId)).size !== configured.length) throw new TypeError('invalid node extension');
    const ids = new Set(configured.map(node => node.nodeId));
    const slots = configured.filter(node => node.publicSlot !== undefined).map(node => node.publicSlot);
    if (new Set(slots).size !== slots.length) throw new TypeError('duplicate public node slot');
    if ([...platform.nodes.keys()].some(id => !ids.has(id))) throw new TypeError('live node removal requires a separate lifecycle operation');
    for (const node of configured) platform.nodeConfiguration(node); // Preflight all immutable URL/key identities.
    const added = [];
    for (const node of configured) {
      if (platform.nodes.has(node.nodeId)) continue;
      handlers.set(node.nodeId, createRpcHandler({ authority: createRpcAuthenticator({ key: node.key, scope: node.nodeId }), operations: sink.opsForNode(node.nodeId) }));
      try { if (platform.addNode(node)) added.push(node.nodeId); }
      catch (error) { handlers.delete(node.nodeId); throw error; }
    }
    await platform.refresh();
    return Object.freeze(added);
  };
  const close = () => {
    if (closing) return closing;
    stopped = true; clearInterval(timer); sink.close();
    closing = (async () => {
      await app.close(); await platform.close();
      for (const socket of privateSockets) socket.destroy();
      await new Promise(resolve => privateServer.close(resolve));
    })();
    return closing;
  };
  const address = privateServer.address(), hostname = address.address.includes(':') ? `[${address.address}]` : address.address;
  return { ...app, platform, receiptSink: sink, privateServer, privateUrl: `http://${hostname}:${address.port}`, addNodes, close };
}
