// Opt-in assembly: one global Lobby and a separate authenticated terminal-event
// listener. High-frequency game data goes directly from nodes to ingress sockets.
// /healthz `performance.phases` carries this process's per-phase timings (server/phaseMetrics.js).
// Opt-in `ingresses` (per-ingress link keys) also accepts authenticated ingress links on the private listener
// (link-server.js): each carries all browser sessions of one ingress instead of one WebSocket per browser.
import http from 'node:http';
import { startServer } from '../index.js';
import { sendEncodedParts, sendSession, sendSessionEncoded } from '../net.js';
import { isCompressibleType } from '../wsCompression.js';
import { createLinkServer } from './link-server.js';
import { createPhaseMetrics } from '../phaseMetrics.js';
import { PROTOCOL_VERSION } from '../../shared/constants.js';
import { ClusterLobby } from './lobby.js';
import { RemoteGamePlatform } from './platform.js';
import { createRpcAuthenticator, createRpcHandler } from './rpc.js';
import { createReceiptSink } from './receipts.js';

/**
 * With `receiptWorker` (opt-in, off by default), receipts at least this large are verified/parsed by one receipt
 * Worker instead of the coordinator main thread. Off keeps the coordinator at zero WorkerThreads, the contract the
 * managed core profile's thread check enforces (deploy/stardust/tools/cluster-host-manager.py); the single parse and
 * the spliced terminal frames apply either way.
 */
export const RECEIPT_OFF_THREAD_BYTES = 128 * 1024;

/** room.closed reason for a match its game node can no longer run (public/js/main.js CLOSE_REASON). */
export const closeReasonFor = reason => (reason === 'NODE_RESTARTED' ? 'node-restarted' : 'node-unavailable');

export async function startCoordinator({ nodes, build, protocol = PROTOCOL_VERSION, privateHost = '127.0.0.1', privatePort = 0,
  heartbeatMs = 1500, nodeLostMs = 15_000, receiptWorker = false, ingresses = [], ...options } = {}) {
  if (!Number.isSafeInteger(privatePort) || privatePort < 0 || privatePort > 65535 || typeof privateHost !== 'string' || !privateHost
    || !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 100 || heartbeatMs > 30_000 || typeof receiptWorker !== 'boolean'
    || !Array.isArray(ingresses)) throw new TypeError('invalid coordinator listener');
  let app, sink, privateServer, timer, links = null, stopped = false, closing;
  const privateSockets = new Set(), handlers = new Map();
  const phases = createPhaseMetrics();
  let platform;
  try {
    platform = new RemoteGamePlatform({ nodes, build, protocol, requireStreamMarkers: true, nodeLostMs, metrics: phases,
      loadTtlMs: Math.max(5000, Math.min(30_000, heartbeatMs * 3)),
      sendControl: (playerId, message) => app ? sendSession(app.registry.byId(playerId), message) : false,
      sendControlEncoded: (playerId, type, frame) => app ? sendSessionEncoded(app.registry.byId(playerId), type, frame) : false,
      sendControlParts: (parts, shared, type) => {
        if (!app) return 0;
        const entries = [];
        for (const { sessionId, prefix, suffix } of parts) {
          const session = app.registry.byId(sessionId);
          if (session?.connected) entries.push({ ws: session.ws, prefix, suffix });
        }
        return sendEncodedParts(entries, shared, { compress: isCompressibleType(type) });
      },
      onPublished: assignmentId => sink?.flush(assignmentId),
      onUnavailable: info => {
        // Losing the node is not victory/defeat and cannot manufacture a result.
        // Drop only this assignment's room, leaving all other nodes/rooms intact —
        // unless checkpoints are kept: then another node rebuilds the match (ClusterLobby.recoverRemote).
        const room = app?.lobby.getRoom(info.roomCode);
        const plan = app?.lobby.assignments.get(info.assignmentId);
        if (!plan || room !== plan.room) return;
        if (['NODE_RESTARTED', 'NODE_LOST'].includes(info.reason) && app.lobby.recoverRemote(room, plan)) return;
        app.lobby.disposeRoom(room, closeReasonFor(info.reason));
      } });
  } catch (e) { phases.dispose(); throw e; }
  try {
    await platform.refresh();
    app = await startServer({ ...options, host: options.host ?? '127.0.0.1', combatWorkers: 0, trialWorkers: 0,
      snapshotHz: options.snapshotHz ?? 10, wsCompression: 'off', allowAsyncHandlers: true, phaseMetrics: phases,
      getClusterLoad: () => platform.publicLoad(),
      // versionPlacement: where another official version's match runs (ClusterLobby; SP_VERSION_PLACEMENT otherwise)
      lobbyFactory: params => new ClusterLobby({ ...params, platform, ...(options.versionPlacement ? { versionPlacement: options.versionPlacement } : {}) }) });
    sink = createReceiptSink({ platform, lobby: app.lobby, offThreadBytes: receiptWorker ? RECEIPT_OFF_THREAD_BYTES : 0, metrics: phases });
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
    if (ingresses.length) links = createLinkServer({ network: app.network, ingresses });
    // Only the authenticated link path upgrades here; anything else is closed as before (no upgrade listener).
    privateServer.on('upgrade', (req, socket, head) => { if (stopped || !links?.handleUpgrade(req, socket, head)) socket.destroy(); });
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
    clearInterval(timer); sink?.close(); links?.close();
    await app?.close(); await platform.close(); phases.dispose();
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
      await app.close();
      await links?.close(); // after the sessions' own close frames are queued on their links
      // saved state (server/persist/): the matches keep running on their nodes for the restarted coordinator to take over
      await platform.close({ release: !app.lobby.closingQuietly });
      for (const socket of privateSockets) socket.destroy();
      await new Promise(resolve => privateServer.close(resolve));
      phases.dispose();
    })();
    return closing;
  };
  const address = privateServer.address(), hostname = address.address.includes(':') ? `[${address.address}]` : address.address;
  return { ...app, platform, receiptSink: sink, privateServer, privateUrl: `http://${hostname}:${address.port}`, linkServer: links, addNodes, close };
}
