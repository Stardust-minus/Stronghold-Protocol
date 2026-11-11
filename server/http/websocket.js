// server/http/websocket.js — the real-time side of the server:
//
//   * session wiring: SessionRegistry (reconnect tokens) → Lobby (rooms, server/lobby.js) → Network (the socket
//     protocol, server/net.js), built from the startServer() options (config.js decides which go where);
//   * WebSocket (ws) at /ws, maxPayload 64 KB (inflated size), permessage-deflate only when SP_WS_COMPRESSION=on
//     (server/wsCompression.js: the bounded preset and the per-type allowlist) → Network.handleConnection. Refused at
//     the upgrade: any other path 404; per-network socket limit for internet clients (maxConnectionsPerAddr, see net.js
//     clientAddress; local/LAN peers are exempt) 429; server full (maxConnections) or shutting down 503.
//   * lanes (server/wsLanes.js, shared/lanes.js): a browser that offers the lane subprotocol gets one logical socket
//     carried by up to 3 WebSockets; Network sees that logical socket. `lanes: false` (SP_WS_LANES=0) never selects it.

import { WebSocketServer } from 'ws';
import { Network, SessionRegistry, NET_DEFAULTS } from '../net.js';
import { createLaneHub } from '../wsLanes.js';
import { createNetQuality, loadIspTable } from '../netQuality.js';
import { Lobby } from '../lobby.js';
import { splitUrl } from './common.js';
import { netOptionsFrom, lobbyOptionsFrom } from './config.js';

/** Inbound WebSocket frame limit (DESIGN §8). */
export const WS_MAX_PAYLOAD = 64 * 1024;

/** A cap, as printed on boot ('unlimited' for 0). */
function uncapped(n) { return n > 0 ? n : 'unlimited'; }

/**
 * The session stack of one server.
 * @param {{ MatchClass?: Function, seedFn?: () => number, [option: string]: any }} opts startServer() options
 * @param {{ data: object, log: object, content?: { cs: string } | null,
 *   plugins?: ReturnType<typeof import('../plugins/roomSets.js').createRoomSets> | null,
 *   hosts?: ReturnType<typeof import('../match/host/index.js').createMatchHosts> | null,
 *   simPool?: ReturnType<typeof import('../workers/roomPool.js').createRoomWorkerPool> | null,
 *   versions?: ReturnType<typeof import('../versions.js').createVersionSets> | null,
 *   versionHosts?: ReturnType<typeof import('../match/host/index.js').createMatchHosts> | null }} deps the game data the lobby's
 *   matches use, the logger, the vanilla content (server/plugins/identity.js: welcome / room.state content, BattleSpec
 *   cs), the room sets a room's host chooses from (room.setPlugins: visual and content sets), the match hosts a room with
 *   gameplay plugins plays in (DESIGN §32.6), the official versions and their match hosts (DESIGN §35.23)
 * @returns {{ registry: SessionRegistry, lobby: Lobby, network: Network }}
 */
export function createSessionStack(opts, { data, log, combatPool = null, trialPool = null, getLoadState, getLoadDetails, onlineLimit = null, ownerFile = null,
  content = null, plugins = null, hosts = null, versions = null, versionHosts = null, simPool = null }) {
  if (opts.lobbyFactory != null && typeof opts.lobbyFactory !== 'function') throw new TypeError('invalid lobby factory');
  if (opts.getClusterLoad != null && typeof opts.getClusterLoad !== 'function') throw new TypeError('invalid cluster load provider');
  const netOptions = netOptionsFrom(opts, log);
  // a room whose match runs in a match host (DESIGN §32.6, §35.23) answers once the host has: promise answers (≤ 64 per socket)
  if ((hosts || versionHosts) && netOptions.allowAsyncHandlers === undefined) netOptions.allowAsyncHandlers = true;
  const registry = new SessionRegistry({ reconnectWindowMs: netOptions.reconnectWindowMs ?? NET_DEFAULTS.reconnectWindowMs });
  const lobbyOptions = lobbyOptionsFrom(opts, log);
  const createLobby = opts.lobbyFactory || (params => new Lobby(params));
  // Optional coordinator phase recorder (server/phaseMetrics.js); absent everywhere else.
  const metrics = opts.phaseMetrics ? { metrics: opts.phaseMetrics } : {};
  // The limits file (server/onlineLimit.js) also carries the lobby's hot-reloadable room / AI caps (Lobby.cap).
  const lobby = createLobby({ registry, log, MatchClass: opts.MatchClass, getData: () => data, seedFn: opts.seedFn, combatPool, trialPool, options: lobbyOptions,
    limits: onlineLimit, content, plugins, hosts, versions, versionHosts, simPool, ...metrics });
  // The owner file (server/ownerFile.js): the 服主 key every hello may carry and the owner's reserved names.
  // the browsers' network-quality reports (server/netQuality.js) per ISP of SP_ISP_FILE (tools/isp-table.mjs)
  const ispFile = opts.netQuality ? null : loadIspTable(opts.ispFile ?? process.env.SP_ISP_FILE, log);
  const netQuality = opts.netQuality ?? createNetQuality({ classify: ispFile.classify, province: ispFile.province });
  const network = new Network({ registry, handler: lobby, log, options: netOptions, getLoadState, getLoadDetails, getClusterLoad: opts.getClusterLoad, onlineLimit, ownerFile, netQuality, ...metrics });
  // The caps in effect, printed once when the stack is built, so the deploy log states the configuration the server is
  // actually running with (0 is no cap here). `log` is the quiet-aware logger, so a test server stays silent.
  log.info(`[http] limits: rooms ${uncapped(lobby.opts.maxRooms)} (${uncapped(lobby.opts.maxRoomsPerAddr)}/network), `
    + `matches ${uncapped(lobby.opts.maxMatchesPerAddr)}/network, `
    + `sockets ${uncapped(network.opts.maxConnections)} (${uncapped(network.opts.maxConnectionsPerAddr)}/network)`);

  lobby.network = network;
  return { registry, lobby, network };
}

/**
 * Count a socket in the traffic counters (traffic.js): its wire bytes from now until it closes, the payload of every
 * message it sends (ws.send wrapped) and receives.
 * @param {import('ws').WebSocket} ws
 * @param {import('node:http').IncomingMessage} req
 * @param {ReturnType<typeof import('./traffic.js').createTrafficCounter>} traffic
 */
function meterSocket(ws, req, traffic) {
  const socket = req.socket;
  traffic.wsOpen(socket);
  const send = ws.send;
  ws.send = function meteredSend(data, ...rest) {
    traffic.wsSent(data);
    return send.call(this, data, ...rest);
  };
  ws.on('message', (data) => traffic.wsReceived(data));
  ws.once('close', () => traffic.wsClose(socket));
}

/**
 * Serve the WebSocket endpoint /ws on `server` (its 'upgrade' event).
 * @param {import('node:http').Server} server
 * @param {{ network: Network, log: object, wsCompression?: false | object, lanes?: boolean,
 *   traffic?: ReturnType<typeof import('./traffic.js').createTrafficCounter> }} deps
 *   wsCompression: the resolved permessage-deflate options (wsCompression.js resolveWsCompression), false: none;
 *   lanes: accept the lane subprotocol (default true)
 * @returns {WebSocketServer}
 */
export function attachWebSocket(server, { network, log, wsCompression = false, traffic = null, lanes = true }) {
  const hub = createLaneHub({ enabled: lanes !== false });
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: wsCompression, clientTracking: false,
    handleProtocols: hub.handleProtocols });
  wss.on('connection', (lane, req) => {
    const ws = hub.adopt(lane);
    if (!ws) return; // a lane joined (or was refused by) its logical socket
    if (traffic) meterSocket(ws, req, traffic);
    network.handleConnection(ws, req);
  });
  wss.on('error', (e) => log.error('[ws] server error', e));

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const parts = splitUrl(req.url || '/');
    const reject = (status, text) => {
      try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { socket.destroy(); }
    };
    if (!parts || parts.rawPath !== '/ws') { reject(404, 'Not Found'); return; }
    const refused = network.admission(req);
    if (refused === 'per-address') { reject(429, 'Too Many Requests'); return; }
    if (refused) { reject(503, 'Service Unavailable'); return; }
    try {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch (e) {
      log.error('[ws] upgrade failed', e);
      socket.destroy();
    }
  });
  return wss;
}
