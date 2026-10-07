// server/http/routes.js — the node:http request listener. Every response gets the security headers (common.js), then:
// (i18n-ignore-file: the error pages are bilingual by design, 中文 · English — docs/I18N.md)
//
//   * a URL longer than 4096 characters → 414; one that does not parse → 400;
//   * any method but GET / HEAD → 405 with `Allow: GET, HEAD`;
//   * GET /healthz → JSON status (protocol `version`, release `app`, uptime, the served `build`, sockets, sessions,
//     rooms, matches), never cached;
//   * everything else → the static files (static.js).
// A route that throws is logged and answers 500.

import { PROTOCOL_VERSION, APP_VERSION } from '../../shared/constants.js';
import { PERFORMANCE_UNAVAILABLE } from '../healthMetrics.js';
import { setSecurityHeaders, sendError, sendJson, splitUrl } from './common.js';

const MAX_URL_LENGTH = 4096;

/**
 * The GET /healthz body.
 * @param {{ startedAt: number, network: import('../net.js').Network, registry: import('../net.js').SessionRegistry,
 *           lobby: import('../lobby.js').Lobby }} health
 */
export function healthReport({ startedAt, network, registry, lobby, browserBuild, combatPool, trialPool, trialStartupFailed, getHealthMetrics }) {
  const combat = combatPool ? { backend: 'workers', scope: 'server-streaming', ...combatPool.stats() } : { backend: 'inline', workers: 0 };
  const ok = !combatPool || (combat.status === 'ready' && combat.ready > 0);
  const trial = trialPool ? { backend: 'workers', scope: 'bot-rehearsal', ...trialPool.stats() }
    : { backend: 'inline', scope: 'bot-rehearsal', workers: 0, status: trialStartupFailed ? 'degraded' : 'disabled' };
  return {
    ok, version: PROTOCOL_VERSION, app: APP_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    build: browserBuild,
    sockets: network.connectionCount, sessions: registry.size, ...lobby.stats(),
    maxRooms: lobby.opts.maxRooms, combat, trial,
    performance: getHealthMetrics?.()?.snapshot() ?? PERFORMANCE_UNAVAILABLE,
  };
}

/**
 * The request listener for `http.createServer`.
 * @param {{ serveStatic: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *             rawPath: string, query: string) => Promise<void>,
 *           health: Parameters<typeof healthReport>[0], log: object }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestHandler({ serveStatic, health, log }) {
  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (url.length > MAX_URL_LENGTH) { sendError(req, res, 414, '请求地址过长 · URI too long'); return; }
    const parts = splitUrl(url);
    if (!parts) { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return;
    }
    if (parts.rawPath === '/healthz') {
      const report = healthReport(health);
      sendJson(req, res, report.ok ? 200 : 503, report);
      return;
    }
    if (parts.rawPath === '/client-build') {
      sendJson(req, res, 200, { build: health.browserBuild });
      return;
    }
    await serveStatic(req, res, parts.rawPath, parts.query);
  }

  return (req, res) => {
    setSecurityHeaders(res);
    handleRequest(req, res).catch((e) => {
      log.error('[http] request failed', e);
      sendError(req, res, 500, '服务器内部错误 · Internal error');
    });
  };
}
