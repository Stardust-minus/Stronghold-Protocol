// server/index.js — process boot; HTTP routes, static delivery and WebSocket wiring live in server/http/.
// Worker pools are process-owned loans to matches. Startup and shutdown keep diagnostics separate from readiness.
// Process-entry boot checks a pending update package before listening (server/update.js).
// The default dual-stack bind may fall back to IPv4; explicit hosts remain literal.
// Art under public/assets and public/fonts is served with content-hash URLs once the background index is ready
// (http/assetIndex.js, http/assetViews.js; SP_ASSET_INDEX=0: off); GET /healthz?traffic=1 adds the traffic counters
// (http/traffic.js) for a local client.
// Plugins (DESIGN §32, docs/PLUGINS.md): the registry, the vanilla content hash, the visual and content sets, the room
// policy, the match hosts of rooms with gameplay plugins and the plugin studio are wired in startServer below
// (server/plugins/, server/match/host/, server/studio/); SP_CSP=off drops the site-wide Content-Security-Policy.
// Official versions (DESIGN §35.23; versions.js): each enabled one's cs, data, manifest and data directory; their matches run
// in match hosts of their own (match/host/, kind 'version'), forked on the first match of one, never at boot.

import http from 'node:http';
import path from 'node:path';
import { getData, loadData } from './data.js';
import { getBotStrategy } from './match/botStrategies.js';
import { noteLlmIgnored, releaseIgnoresExternalAi, validateExternalConfig } from './match/llmGate.js';
import { ROOT, listenAddress, bindCandidates, serveDirs, makeLogger, parseTrustProxy, assetIndexOptionsFrom, versionsFrom, parseRoomCode } from './http/config.js';
import { WS_MAX_PAYLOAD, createSessionStack, attachWebSocket } from './http/websocket.js';
import { siteCsp } from './http/csp.js';
import { DATA_SHIM_JS, createStaticHandler } from './http/static.js';
import { createPluginRegistry } from './plugins/registry.js';
import { computeVanillaContent } from './plugins/identity.js';
import { createVisualSets } from './plugins/visualSet.js';
import { createContentSets } from './plugins/contentSets.js';
import { createPluginPolicy } from './plugins/policy.js';
import { createRoomSets } from './plugins/roomSets.js';
import { createMatchHosts } from './match/host/index.js';
import { createVersionSets } from './versions.js';
import { versionById } from '../shared/versions.js';
import { t } from '../shared/i18n.js';
import { createTrustedRuntime } from './plugins/trustedRuntime.js';
import { trustedHostAllowed } from './plugins/trusted.js';
import { createStudio } from './studio/index.js';
import { MIME, COMPRESSIBLE, acceptsGzip, pickEncoding, parseRange } from './http/files.js';
import { BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag } from './http/buildTag.js';
import { createRequestHandler } from './http/routes.js';
import { createTrafficCounter } from './http/traffic.js';
import { createAssetIndex } from './http/assetIndex.js';
import { createManifestViews } from './http/assetViews.js';
import { answerClientError } from './http/common.js';
import { createEventLoopMonitor } from './health/eventLoop.js';
import { createRoomWorkerPool } from './workers/roomPool.js';
import { lanUrls, displayHost, isProcessEntry, runMain } from './http/boot.js';
import { CombatWorkerPool } from './match/combat/pool.js';
import { createHealthMetrics, serverLoadState, publicLoadDetails } from './healthMetrics.js';
import { resolveWsCompression } from './wsCompression.js';
import { createOnlineLimit } from './onlineLimit.js';
import { createOwnerFile } from './ownerFile.js';
import { parseSnapshotHz } from './match/fields.js';
import { createPersistence } from './persist/index.js';

export {
  ROOT, WS_MAX_PAYLOAD, DATA_SHIM_JS, MIME, COMPRESSIBLE, BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag,
  acceptsGzip, pickEncoding, parseRange, createStaticHandler, lanUrls, parseTrustProxy,
};

/** Zero retains the synchronous backend; malformed pool configuration fails before listening. */
export function parseCombatWorkers(value) {
  if (value == null || value === '') return 0;
  if (typeof value !== 'number' && typeof value !== 'string') throw new RangeError('SP_COMBAT_WORKERS must be an integer from 0 to 32');
  const s = String(value).trim();
  if (!/^(0|[1-9]\d*)$/.test(s) || Number(s) > 32) throw new RangeError('SP_COMBAT_WORKERS must be an integer from 0 to 32');
  return Number(s);
}

export function parseTrialWorkers(value) {
  if (value == null || value === '') return 1;
  if (typeof value !== 'number' && typeof value !== 'string') throw new RangeError('SP_TRIAL_WORKERS must be an integer from 0 to 2');
  const s = String(value).trim();
  if (!/^[0-2]$/.test(s)) throw new RangeError('SP_TRIAL_WORKERS must be an integer from 0 to 2');
  return Number(s);
}

/**
 * Build and start the HTTP + WebSocket server.
 * @param {{
 *   port?: number, host?: string, quiet?: boolean, log?: object,
 *   publicDir?: string, dataDir?: string, sharedDir?: string, packsDir?: string, pluginsDir?: string,
 *   MatchClass?: Function, seedFn?: () => number,
 *   lobbyGraceMs?: number, reconnectWindowMs?: number, heartbeatMs?: number, helloTimeoutMs?: number,
 *   ratePerSec?: number, rateBurst?: number, maxConnections?: number, maxRooms?: number,
 *   maxConnectionsPerAddr?: number, maxRoomsPerAddr?: number, maxMatchesPerAddr?: number, resyncMinGapMs?: number,
 *   heavyPerSec?: number, heavyBurst?: number, trustProxy?: 'auto' | boolean, soloReconnectWindowMs?: number,
 *   versionVoteMs?: number, versionRetryMs?: number,
 *   roomCode?: string | null,
 *   assetIndex?: boolean | { cacheFile?: string | null, delayMs?: number }, studio?: boolean,
 *   matchHost?: object, versions?: { enabled?: 'all' | string[], default?: string, maxHosts?: number },
 * }} [opts]
 *   client: 'build' or 'source' — which page `/` is (default SP_CLIENT; http/static.js clientModeFromEnv);
 *   assetIndex: the content-hash index (default on; false or SP_ASSET_INDEX=0: off — config.js assetIndexOptionsFrom);
 *   studio: the plugin studio at /studio/ (default on for this machine and the local network — SP_STUDIO=local|off;
 *   false: none);
 *   matchHost: options of the match hosts (server/match/host/index.js — watchdogMs, matchOptions …; tests) — the
 *   version hosts' too; versions: the official versions this server offers (http/config.js versionsFrom; DESIGN §35.23);
 *   versionVoteMs / versionRetryMs: the version vote's answer window and the guard after a declined or expired vote (tests;
 *   server/lobby.js header "Official versions")
 *   roomCode: a fixed alliance key for every new room (--room-code; four letters or digits — config.js parseRoomCode);
 * @returns {Promise<{ port: number, host: string, url: string, server: http.Server, wss: import('ws').WebSocketServer,
 *                     lobby: import('./lobby.js').Lobby, network: import('./net.js').Network,
 *                     registry: import('./net.js').SessionRegistry, packs: ReturnType<typeof createPluginRegistry>,
 *                     content: import('./plugins/identity.js').VanillaContent, visual: ReturnType<typeof createVisualSets>,
 *                     contents: ReturnType<typeof createContentSets>, hosts: ReturnType<typeof createMatchHosts>,
 *                     versions: ReturnType<typeof createVersionSets>, versionHosts: ReturnType<typeof createMatchHosts> | null,
 *                     traffic: ReturnType<typeof createTrafficCounter>, assetIndex: ReturnType<typeof createAssetIndex> | null,
 *                     views: ReturnType<typeof createManifestViews> | null, studio: ReturnType<typeof createStudio> | null,
 *                     close: () => Promise<void> }>}
 */
export async function startServer(opts = {}) {
  // A release ignores external-AI settings (one log line) and keeps the built-in bot (§35.66).
  // An unknown strategy id still fails here, before data is loaded or the port is opened.
  const log = opts.log || makeLogger(!!opts.quiet);
  if (releaseIgnoresExternalAi()) noteLlmIgnored(log);
  try {
    const strategy = getBotStrategy(process.env.SP_BOT_STRATEGY);
    if (strategy.id === 'external') validateExternalConfig();
  } catch (cause) {
    throw new Error(`Invalid SP_BOT_STRATEGY: ${cause.message}. Unset SP_BOT_STRATEGY to use the original bot (legacy).`, { cause });
  }
  const { port, host } = listenAddress(opts);
  const wsCompression = resolveWsCompression(opts.wsCompression ?? process.env.SP_WS_COMPRESSION ?? 'off');
  const snapshotHz = parseSnapshotHz(opts.snapshotHz ?? process.env.SP_SNAPSHOT_HZ);
  const combatWorkers = parseCombatWorkers(opts.combatWorkers ?? process.env.SP_COMBAT_WORKERS);
  const trialSetting = opts.trialWorkers ?? process.env.SP_TRIAL_WORKERS;
  const requestedTrials = parseTrialWorkers(trialSetting);
  const trialWorkers = combatWorkers && (trialSetting != null && trialSetting !== '' || String(process.env.SP_COMBAT || '').toLowerCase() === 'server')
    ? requestedTrials : 0;
  const { publicDir, dataDir, sharedDir, packsDir, pluginsDir } = serveDirs(opts);
  const simDir = path.join(ROOT, 'server', 'sim');

  // The process-wide singleton serves the default data dir; a custom dir (tests) gets its own copy.
  const data = opts.dataDir ? loadData(dataDir, { log }) : getData({ dir: dataDir, log });
  const combatPool = combatWorkers ? new CombatWorkerPool({ size: combatWorkers, data, log }) : null;
  let trialPool = null, trialStartupFailed = false, healthMetrics = null;
  const closePools = () => Promise.all([trialPool?.close(), combatPool?.close()]);
  if (combatPool) {
    try { await combatPool.start(); } catch (e) { await closePools(); throw e; }
    log.info(`[combat] fixed worker pool ready (${combatWorkers} workers; server streaming only)`);
  }
  if (trialWorkers) {
    try {
      trialPool = new CombatWorkerPool({ role: 'trial', size: trialWorkers, data, log });
      await trialPool.start();
      log.info(`[trial] dedicated rehearsal pool ready (${trialWorkers} workers)`);
    } catch (e) {
      try { await trialPool?.close(); } catch (closeError) { await combatPool?.close(); throw closeError; }
      trialPool = null;
      trialStartupFailed = true;
      log.warn?.(`[trial] worker startup failed; rehearsal stays inline: ${e.message}`);
    }
  }
  const scriptMode = process.env.SP_PLUGIN_SCRIPTS;
  let registry, lobby, network, packs, serveStatic, browserBuild, assetIndex = null, views = null;
  let content = null, visual = null, contents = null, hosts = null, studio = null, trustedRuntime = null, persistence = null;
  let versions = null, versionHosts = null, simPool = null, eventLoop = null;
  const startedAt = Date.now();
  // The online cap and the lobby's room / AI caps (server/onlineLimit.js): a JSON file re-read while the server runs; none = no cap.
  const onlineLimit = createOnlineLimit({ file: opts.onlineLimitFile ?? process.env.SP_ONLINE_LIMIT_FILE ?? null, log });
  // The owner (服主) mark (server/ownerFile.js): the owner key's hash and reserved names, re-read while the server runs; none = off.
  const ownerFile = createOwnerFile({ file: opts.ownerFile ?? process.env.SP_OWNER_FILE ?? null, log });
  await ownerFile.refresh(); // the first read before any hello: reserved names hold from the start (never rejects)
  try {
    // the vanilla content hash `cs` (DESIGN §32): the bytes of the served sim, shared code and game data, read once now —
    // like the data the matches use and the build tag below
    content = computeVanillaContent({ simDir, sharedDir, dataDir, shim: DATA_SHIM_JS, log });
    log.info(`[content] vanilla ${content.cs.slice(0, 16)} (${Object.keys(content.simFiles).length} code files, ${Object.keys(content.data).length} data files)`);
    // language packs and plugins (docs/PACKS.md, docs/PLUGINS.md): scanned now — the start log names them — and again
    // whenever their folders change
    packs = createPluginRegistry({ publicDir, dataDir, packsDir, pluginsDir }, { log, scriptHost: host, scriptMode });
    packs.refresh(true);
    // the content hashes of the art (built in the background once listening) and the manifests served with them
    const indexOptions = assetIndexOptionsFrom(opts, publicDir);
    assetIndex = indexOptions ? createAssetIndex({ publicDir, log, ...indexOptions }) : null;
    views = createManifestViews({ dataDir, index: assetIndex, log });
    // the visual sets of the cosmetic plugins (DESIGN §32 P1a): what a room's host switches on, served at /vs/ and /p/
    visual = createVisualSets({ registry: packs, log });
    // the server owner's policy (plugins/config.json), the content sets of the gameplay plugins (served at /cs/<cs16>/…),
    // what a room's plugins make of both, and the match hosts a room with gameplay plugins plays in (DESIGN §32.6)
    const policy = createPluginPolicy({ pluginsDir, log });
    contents = createContentSets({ registry: packs, vanillaData: data, log, maxSets: () => policy.get().maxSets });
    const roomSets = createRoomSets({ registry: packs, visual, contents, policy });
    // a child process per content set; SP_MATCH_HOST=worker asks for a worker thread instead (match/host/index.js header:
    // an out-of-memory abort in a worker thread ends the whole server)
    const transport = String(process.env.SP_MATCH_HOST || '').trim().toLowerCase() === 'worker' ? 'worker' : 'process';
    hosts = createMatchHosts({ contents, log, options: { transport, maxWorkers: Math.max(1, policy.get().maxSets), ...(opts.matchHost || {}) } });
    // the official versions (DESIGN §35.23, M1): which ones (the option, else SP_VERSIONS …), their content, and — only
    // when one beyond 第二期下半 is enabled — the match hosts their rooms play in (counted apart from the plugin hosts)
    const versionCfg = versionsFrom(opts, log);
    versions = createVersionSets({ enabled: versionCfg.enabled, defaultId: versionCfg.default, dataDir, vanilla: content, defaultData: data, log });
    // (the test options of matchHost apply to both pools, but never the version pool's kind or its own SP_MAX_VERSION_HOSTS)
    versionHosts = versions.nonDefault.length
      ? createMatchHosts({ contents: versions, log, options: { transport, ...(opts.matchHost || {}), kind: 'version', maxWorkers: Math.max(1, versionCfg.maxHosts) } })
      : null;
    log.info(`[versions] enabled: ${versions.ids.map((id) => `${id} (${t(/** @type {any} */ (versionById(id)).label)}${id === versions.defaultId ? ', default' : ''})`).join(', ')}`);
    simPool = createRoomWorkerPool({ data });
    ({ registry, lobby, network } = createSessionStack({ ...opts, snapshotHz }, {
      data, log, combatPool, trialPool, onlineLimit, ownerFile, content, plugins: roomSets, hosts, versions, versionHosts, simPool,
      getLoadState: () => serverLoadState(healthMetrics?.snapshot?.()),
      getLoadDetails: () => publicLoadDetails(healthMetrics?.snapshot?.()),
    }));
    // Main-thread event-loop delay sampling (server/health/eventLoop.js): opt-in with SP_LOOP_SAMPLE=1, no worker pool involved, and a
    // LOCAL log line per window (`[loop] p50=… p95=… p99=… max=… cpu=… mem=… rooms=… humans=… phase=…`) — deliberately not
    // part of /healthz. This is what tells an operator whether a stall is the rehearsal / battle slice or something else.
    eventLoop = createEventLoopMonitor({
      log,
      windowMs: opts.loopSample?.windowMs,
      counts: () => {
        const s = lobby.stats();
        const phases = new Set();
        let rehearsals = 0;
        for (const room of lobby.rooms.values()) {
          if (room.match?.phase) phases.add(room.match.phase);
          rehearsals += room.match?._rehearsalTasks?.size || 0;
        }
        return { rooms: s.rooms, matches: s.matches, humans: s.humans, spectators: s.spectators,
          phase: [...phases].sort().join('+') || 'idle', rehearsals };
      },
    });
    serveStatic = createStaticHandler({ publicDir, dataDir, sharedDir, simDir, packsDir, pluginsDir, packs, content, log, metrics: opts.phaseMetrics,
      assetIndex, views, visual, contents, versions, ...(opts.client ? { client: opts.client } : {}) });
    // the plugin studio (DESIGN §32.9): its page and API for this machine and the local network; it watches plugins/ only
    // once it is used (hot reload), and rooms whose host is the author or alone follow a plugin's changes by themselves
    studio = opts.studio === false ? null : createStudio({ publicDir, pluginsDir, dataDir, registry: packs, lobby, sessions: registry, log, fetch: opts.fetch });
    trustedRuntime = await createTrustedRuntime({ registry: packs, log });
    lobby.trustedRuntime = trustedRuntime;
    browserBuild = computeBuildTag(ROOT, { publicDir, servedVersionDirs: versions.servedDirs() });
    // checkpoints (SP_REDIS_URL, server/persist/): the saved lobby and its matches come back before the server listens
    persistence = await createPersistence({ opts, registry, lobby, log });
  } catch (e) {
    await persistence?.close();
    network?.close();
    lobby?.shutdown('boot-failed');
    try { hosts?.close(); } catch { /* boot already failed */ }
    try { versionHosts?.close(); } catch { /* boot already failed */ }
    eventLoop?.close();
    await simPool?.close();
    studio?.close();
    await trustedRuntime?.close();
    onlineLimit.close();
    ownerFile.close();
    assetIndex?.close();
    await closePools();
    throw e;
  }
  const traffic = createTrafficCounter();
  const health = { startedAt, network, registry, lobby, content, browserBuild, combatPool, trialPool, trialStartupFailed,
    getHealthMetrics: () => healthMetrics, traffic, assetIndex, views, trusted: trustedRuntime?.health, versions, versionHosts,
    persistence: persistence ? () => persistence.snapshot() : null };
  const server = http.createServer(createRequestHandler({ serveStatic, csp: process.env.SP_CSP === 'off' ? null : siteCsp(publicDir), health, log,
    trustProxy: network.opts.trustProxy, studio, trustedRuntime }));
  server.on('clientError', answerClientError);
  const wss = attachWebSocket(server, { network, log, wsCompression, traffic });

  // The address actually bound. The default may fall back to IPv4; the returned host and url follow that.
  let boundHost;
  try {
    // A host with IPv6 switched off refuses '::'. Fall back to IPv4 rather than not booting. Only the default is
    // retried: an explicit HOST is literal (server/http/config.js bindCandidates).
    let bound = null;
    let lastError = null;
    const candidates = bindCandidates(host);
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      try {
        await new Promise((resolve, reject) => {
          const onError = (e) => { server.off('listening', onListening); reject(e); };
          const onListening = () => { server.off('error', onError); resolve(); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, candidate);
        });
        bound = candidate;
        break;
      } catch (e) {
        lastError = e;
        const retry = ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EINVAL'].includes(e.code) && i < candidates.length - 1;
        if (!retry) break;
        log.warn(`[boot] cannot bind ${candidate} (${e.code}) — falling back to IPv4 only`);
      }
    }
    if (bound === null) throw lastError;
    boundHost = bound;
    // Check the kernel's address too: aliases/DNS and bind fallback cannot weaken the owner gate.
    const actual = server.address();
    const scriptHost = actual && typeof actual === 'object' ? actual.address : '';
    packs.setScriptHost(scriptHost);
    const testGate = lobby.setTestHost(scriptHost);
    if (testGate.warn) log.warn(`[test-mode] ${testGate.warn}`);
    else if (testGate.enabled) log.info('[test-mode] test rooms enabled');
    if (!trustedHostAllowed(scriptHost, scriptMode)) {
      lobby.trustedRuntime = null;
      await trustedRuntime?.close();
    }
  } catch (e) {
    await persistence?.close();
    network.close(); // stop heartbeat/sweep timers of the half-built server
    lobby.shutdown('boot-failed');
    onlineLimit.close();
    ownerFile.close();
    versionHosts?.close();
    assetIndex?.close();
    try { hosts?.close(); } catch { /* boot already failed */ }
    studio?.close();
    eventLoop?.close();
    await simPool?.close();
    await trustedRuntime?.close();
    await closePools();
    throw e;
  }
  server.on('error', e => log.error('[http] server error', e));
  assetIndex?.start();
  try {
    healthMetrics = (opts.healthMetricsFactory ?? createHealthMetrics)(opts.phaseMetrics ? { log, phases: opts.phaseMetrics } : { log });
    healthMetrics.start();
  } catch (e) {
    try { healthMetrics?.dispose(); } catch { /* diagnostic only */ }
    healthMetrics = null;
    try { log.warn?.(`[health] performance metrics unavailable: ${e.message}`); } catch { /* diagnostic only */ }
  }
  // started only once the server is listening: the first window then reports real counts, not a half-built hall
  eventLoop?.start();

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${displayHost(boundHost)}:${actualPort}`;
  let closing = null;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      try { healthMetrics?.dispose(); } catch (e) {
        try { log.warn?.('[health] performance disposal failed', e); } catch { /* diagnostic only */ }
      }
      // the last checkpoints first: then the rooms close quietly, their players are coming back (server/persist/)
      try { await persistence?.shutdown(); } catch (e) { log.error('[shutdown] checkpoints', e); }
      try { lobby.shutdown('shutdown'); } catch (e) { log.error('[shutdown] lobby', e); }
      try { hosts.close(); } catch (e) { log.error('[shutdown] match hosts', e); }
      try { versionHosts?.close(); } catch (e) { log.error('[shutdown] version hosts', e); }
      // after the lobby: every room is gone, so no rehearsal can still be waiting on a thread
      try { await simPool?.close(); } catch (e) { log.error('[shutdown] simulation pool', e); }
      eventLoop?.close();
      network.close();
      onlineLimit.close();
      ownerFile.close();
      assetIndex?.close();
      studio?.close();
      await trustedRuntime?.close();
      await closePools();
      await new Promise(resolve => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        setTimeout(() => { server.closeAllConnections?.(); }, 500).unref();
      });
      try { wss.close(); } catch { /* ignore */ }
      await persistence?.close();
    })();
    return closing;
  }
  return { port: actualPort, host: boundHost, url, server, wss, lobby, network, registry, packs, content, visual, contents, hosts, versions, versionHosts, combatPool, trialPool,
    healthMetrics, traffic, assetIndex, views, studio, persistence, eventLoop, simPool, close };
}

/**
 * The `--room-code ABCD` / `--room-code=ABCD` argument of this process entry, or null when it is absent. The value is
 * read once at startup and lives only in this server instance: there is no environment variable and nothing is
 * persisted, so stopping the server and starting it again without the argument is random again. A missing or invalid
 * value throws (the boot helper reports it and exits) instead of silently starting random.
 * @param {string[]} [argv]
 * @returns {string | null}
 */
export function roomCodeFromArgv(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--room-code') {
      const v = argv[i + 1];
      if (v == null || v.startsWith('-') || !v.trim()) throw new RangeError('--room-code needs 4 letters or digits');
      return parseRoomCode(v);
    }
    if (a.startsWith('--room-code=')) {
      const v = a.slice('--room-code='.length);
      if (!v.trim()) throw new RangeError('--room-code needs 4 letters or digits');
      return parseRoomCode(v);
    }
  }
  return null;
}

// `node server/index.js` / npm start: listen, print the banner, stop on SIGINT / SIGTERM (http/boot.js).
if (isProcessEntry(import.meta.url)) runMain(() => startServer({ roomCode: roomCodeFromArgv() }));
