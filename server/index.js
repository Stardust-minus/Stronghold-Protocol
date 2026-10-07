// server/index.js — process boot; HTTP routes, static delivery and WebSocket wiring live in server/http/.
// Worker pools are process-owned loans to matches. Startup and shutdown keep diagnostics separate from readiness.
// Process-entry boot checks a pending update package before listening (server/update.js).

import http from 'node:http';
import { getData, loadData } from './data.js';
import { ROOT, listenAddress, serveDirs, makeLogger, parseTrustProxy } from './http/config.js';
import { WS_MAX_PAYLOAD, createSessionStack, attachWebSocket } from './http/websocket.js';
import { DATA_SHIM_JS, createStaticHandler } from './http/static.js';
import { createPackRegistry } from './packs.js';
import { MIME, COMPRESSIBLE, acceptsGzip, parseRange } from './http/files.js';
import { BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag } from './http/buildTag.js';
import { createRequestHandler } from './http/routes.js';
import { answerClientError } from './http/common.js';
import { lanUrls, isProcessEntry, runMain } from './http/boot.js';
import { CombatWorkerPool } from './match/combat/pool.js';
import { createHealthMetrics, serverLoadState, publicLoadDetails } from './healthMetrics.js';
import { resolveWsCompression } from './wsCompression.js';
import { parseSnapshotHz } from './match/fields.js';

export {
  ROOT, WS_MAX_PAYLOAD, DATA_SHIM_JS, MIME, COMPRESSIBLE, BUILD_INPUTS, computeBuildTag, buildTag, resetBuildTag,
  acceptsGzip, parseRange, createStaticHandler, lanUrls, parseTrustProxy,
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

/** Start one native HTTP/WS runtime, including optional fixed combat and trial pools. */
export async function startServer(opts = {}) {
  const { port, host } = listenAddress(opts);
  const log = opts.log || makeLogger(!!opts.quiet);
  const wsCompression = resolveWsCompression(opts.wsCompression ?? process.env.SP_WS_COMPRESSION ?? 'off');
  const snapshotHz = parseSnapshotHz(opts.snapshotHz ?? process.env.SP_SNAPSHOT_HZ);
  const combatWorkers = parseCombatWorkers(opts.combatWorkers ?? process.env.SP_COMBAT_WORKERS);
  const trialSetting = opts.trialWorkers ?? process.env.SP_TRIAL_WORKERS;
  const requestedTrials = parseTrialWorkers(trialSetting);
  const trialWorkers = combatWorkers && (trialSetting != null && trialSetting !== '' || String(process.env.SP_COMBAT || '').toLowerCase() === 'server')
    ? requestedTrials : 0;
  const { publicDir, dataDir, sharedDir, packsDir } = serveDirs(opts);
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
  let registry, lobby, network, packs, serveStatic, browserBuild;
  const startedAt = Date.now();
  try {
    ({ registry, lobby, network } = createSessionStack({ ...opts, snapshotHz }, {
      data, log, combatPool, trialPool,
      getLoadState: () => serverLoadState(healthMetrics?.snapshot?.()),
      getLoadDetails: () => publicLoadDetails(healthMetrics?.snapshot?.()),
    }));
    packs = createPackRegistry({ publicDir, dataDir, packsDir }, { log });
    packs.refresh(true);
    serveStatic = createStaticHandler({ publicDir, dataDir, sharedDir, packsDir, packs, log });
    browserBuild = computeBuildTag(ROOT, publicDir);
  } catch (e) {
    network?.close();
    lobby?.shutdown('boot-failed');
    await closePools();
    throw e;
  }
  const health = { startedAt, network, registry, lobby, browserBuild, combatPool, trialPool, trialStartupFailed,
    getHealthMetrics: () => healthMetrics };
  const server = http.createServer(createRequestHandler({ serveStatic, health, log }));
  server.on('clientError', answerClientError);
  const wss = attachWebSocket(server, { network, log, wsCompression });
  try {
    await new Promise((resolve, reject) => {
      const onError = e => { server.off('listening', onListening); reject(e); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  } catch (e) {
    network.close();
    lobby.shutdown('boot-failed');
    await closePools();
    throw e;
  }
  server.on('error', e => log.error('[http] server error', e));
  try {
    healthMetrics = (opts.healthMetricsFactory ?? createHealthMetrics)({ log });
    healthMetrics.start();
  } catch (e) {
    try { healthMetrics?.dispose(); } catch { /* diagnostic only */ }
    healthMetrics = null;
    try { log.warn?.(`[health] performance metrics unavailable: ${e.message}`); } catch { /* diagnostic only */ }
  }
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host === '0.0.0.0' || host === '::' ? 'localhost' : host}:${actualPort}`;
  let closing = null;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      try { healthMetrics?.dispose(); } catch (e) {
        try { log.warn?.('[health] performance disposal failed', e); } catch { /* diagnostic only */ }
      }
      try { lobby.shutdown('shutdown'); } catch (e) { log.error('[shutdown] lobby', e); }
      network.close();
      await closePools();
      await new Promise(resolve => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        setTimeout(() => { server.closeAllConnections?.(); }, 500).unref();
      });
      try { wss.close(); } catch { /* ignore */ }
    })();
    return closing;
  }
  return { port: actualPort, host, url, server, wss, lobby, network, registry, packs, combatPool, trialPool, healthMetrics, close };
}

if (isProcessEntry(import.meta.url)) runMain(startServer);
