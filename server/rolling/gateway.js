// Stable, gate-internal release router. Activation changes NEW routing only, never a live tunnel.
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { RollingError, releaseId, readPrivateJson, writePrivateJson, startControl, controlRequest, jsonResponse } from './control.js';
import { verifyMaterial, serveMaterial } from './material.js';

const MOUNTS = ['assets', 'media', 'fonts', 'vendor'];
const CODE_PATH = /^\/(?:js|css|data|shared|sim)\//;
const nop = { info() {}, error() {} };
const LIMITS = { maxTunnels: 2048, maxTunnelsPerAddress: 64, maxHttp: 512, handshakeMs: 5000, httpMs: 15000, maxBufferedBytes: 1024 * 1024, stalledMs: 30000 };

function origin(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== value || url.username || url.password) throw new RollingError('INVALID_ORIGIN', 400);
  return url;
}

/** Only operator-provided manifest entries, never a URL/port from an HTTP client. */
function validateRelease(input, options) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RollingError('INVALID_MANIFEST', 400);
  const id = releaseId(input.id);
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new RollingError('INVALID_BACKEND_PORT', 400);
  if (typeof input.controlSocket !== 'string' || !input.controlSocket.startsWith('/') || Buffer.byteLength(input.controlSocket) > 100) throw new RollingError('INVALID_CONTROL_SOCKET', 400);
  const staticRoutes = {};
  let assetResolver = null;
  if (input.localStatic !== true) {
    const target = input.assetResolver;
    if (!target || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535 || !/^[a-f0-9]{64}$/.test(target.manifestHash)) throw new RollingError('INVALID_ASSET_RESOLVER', 400);
    const materialReleaseId = releaseId(target.materialReleaseId);
    const mirrorReleaseId = releaseId(target.mirrorReleaseId);
    const oss = origin(target.ossOrigin);
    const fallback = new URL(target.fallbackBase);
    if (oss.protocol !== 'https:' || !options.staticOrigins.has(oss.origin) || fallback.protocol !== 'https:' || !options.staticOrigins.has(fallback.origin) ||
        fallback.username || fallback.password || fallback.search || fallback.hash || !fallback.pathname.endsWith(`/${materialReleaseId}/`) ||
        /%|\\|\/\./.test(fallback.pathname) || typeof target.ossPathPrefix !== 'string' || !target.ossPathPrefix.startsWith('/') ||
        !target.ossPathPrefix.endsWith(`/${mirrorReleaseId}/`) || /%|\\|\/\.|[\x00-\x20]/.test(target.ossPathPrefix)) throw new RollingError('INVALID_ASSET_RESOLVER', 400);
    assetResolver = Object.freeze({ port: target.port, materialReleaseId, mirrorReleaseId, manifestHash: target.manifestHash, ossOrigin: oss.origin, ossPathPrefix: target.ossPathPrefix, fallbackBase: fallback.href });
  }
  if (input.localStatic === true) {
    if (!options.allowLocalStatic || (input.staticRoutes != null && Object.keys(input.staticRoutes).length)) throw new RollingError('LOCAL_STATIC_DISABLED', 400);
  } else {
    for (const mount of ['fonts', 'vendor']) {
      const route = input.staticRoutes?.[mount];
      const materialReleaseId = releaseId(route?.materialReleaseId);
      const url = new URL(route?.redirectBase);
      if (url.protocol !== 'https:' || !options.staticOrigins.has(url.origin) || url.username || url.password || url.search || url.hash ||
          !url.pathname.endsWith(`/${mount}/`) || !url.pathname.split('/').includes(materialReleaseId) || /%|\\|\/\./.test(url.pathname)) {
        throw new RollingError('INVALID_STATIC_ROUTE', 400);
      }
      staticRoutes[mount] = Object.freeze({ materialReleaseId, redirectBase: url.href });
    }
  }
  return Object.freeze({ id, port: input.port, controlSocket: input.controlSocket, localStatic: input.localStatic === true, assetResolver, staticRoutes: Object.freeze(staticRoutes) });
}

function canonical(entry) { return JSON.stringify(entry); }
function parsePath(raw) {
  if (typeof raw !== 'string' || raw.length > 4096 || !raw.startsWith('/') || raw.startsWith('//') || /[#\x00-\x20\x7f\\]/.test(raw)) throw new RollingError('INVALID_PATH', 400);
  const q = raw.indexOf('?');
  const rawPath = q < 0 ? raw : raw.slice(0, q);
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { throw new RollingError('INVALID_PATH', 400); }
  // No nested encodings or escaped separators: reject before any URL normalizer can collapse traversal.
  if (/%|\\|[\x00-\x20\x7f]/.test(decoded) || /%2f|%5c/i.test(rawPath) || decoded.includes('//') || decoded.split('/').some((s) => s === '.' || s === '..' || s.startsWith('.'))) {
    throw new RollingError('INVALID_PATH', 400);
  }
  return { path: decoded, rawPath, query: q < 0 ? '' : raw.slice(q) };
}
function safeQuery(query, keys) {
  const output = new URLSearchParams();
  const input = new URLSearchParams(query);
  for (const key of keys) {
    const values = input.getAll(key);
    if (values.length === 1 && /^[A-Za-z0-9_-]{1,64}$/.test(values[0])) output.set(key, values[0]);
  }
  const text = output.toString(); return text ? `?${text}` : '';
}
function allowedPath(pathname) {
  return pathname === '/' || pathname === '/index.html' || pathname === '/data.js' || pathname === '/client-build' || pathname === '/favicon.ico' || CODE_PATH.test(pathname) || MOUNTS.some((m) => pathname.startsWith(`/${m}/`));
}
function headersWithoutHop(headers) {
  const blocked = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
  for (const field of String(headers.connection || '').split(',')) blocked.add(field.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name)));
}
function socketError(socket, status) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} Denied\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`);
}

export async function startGateway(opts) {
  if (!opts || !Array.isArray(opts.publicOrigins) || !opts.publicOrigins.length) throw new RollingError('PUBLIC_ORIGINS_REQUIRED', 400);
  const publicOrigins = new Map(opts.publicOrigins.map((value) => { const url = origin(value); return [url.host, url.origin]; }));
  if (publicOrigins.size !== opts.publicOrigins.length) throw new RollingError('DUPLICATE_PUBLIC_HOST', 400);
  const options = { allowLocalStatic: opts.allowLocalStatic === true, staticOrigins: new Set(opts.staticOrigins || []) };
  for (const value of options.staticOrigins) origin(value);
  const limits = { ...LIMITS, ...opts.limits };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new RollingError('INVALID_LIMITS', 400);
  const trustedProxyAddresses = new Set(opts.trustedProxyAddresses ?? []); // Explicit, never all RFC1918 peers.
  for (const value of trustedProxyAddresses) if (!net.isIP(value)) throw new RollingError('INVALID_PROXY_ADDRESS', 400);
  const log = opts.log || nop;
  const releases = new Map();
  const retired = new Set();
  const busy = new Set();
  const tunnels = new Map();
  const httpCounts = new Map();
  const byAddress = new Map();
  let active;
  let ready = false;
  let closing = false;
  let serial = Promise.resolve();
  let control;
  const stateFile = opts.stateFile;
  if (!stateFile) throw new RollingError('STATE_FILE_REQUIRED', 400);

  function add(entries) {
    if (!Array.isArray(entries) || !entries.length || entries.length > 128) throw new RollingError('INVALID_MANIFEST', 400);
    const validated = entries.map((entry) => validateRelease(entry, options));
    if (new Set(validated.map((r) => r.id)).size !== validated.length) throw new RollingError('DUPLICATE_RELEASE', 400);
    for (const entry of validated) {
      const previous = releases.get(entry.id);
      if (previous && canonical(previous) !== canonical(entry)) throw new RollingError('IMMUTABLE_RELEASE_CHANGED', 409);
      for (const other of releases.values()) if (entry.id !== other.id && (entry.port === other.port || entry.controlSocket === other.controlSocket)) throw new RollingError('BACKEND_TARGET_REUSED', 409);
      for (const other of validated) if (entry.id !== other.id && (entry.port === other.port || entry.controlSocket === other.controlSocket)) throw new RollingError('BACKEND_TARGET_REUSED', 409);
    }
    for (const entry of validated) releases.set(entry.id, entry);
  }
  try {
    const state = await readPrivateJson(stateFile);
    if (state.schema !== 1 || !Array.isArray(state.retired)) throw new RollingError('INVALID_STATE');
    add(state.releases); active = releaseId(state.active);
    for (const id of state.retired) retired.add(releaseId(id));
  } catch (e) { if (e.code !== 'ENOENT') throw e; active = releaseId(opts.activeReleaseId); }
  add(opts.registryFile ? (await readPrivateJson(opts.registryFile)).releases : opts.releases);
  if (!releases.has(active) || retired.has(active) || [...retired].some((id) => !releases.has(id))) throw new RollingError('INVALID_ACTIVE_RELEASE');

  async function persist(nextActive = active, nextRetired = retired) {
    await writePrivateJson(stateFile, { schema: 1, active: nextActive, retired: [...nextRetired], releases: [...releases.values()] });
  }
  function entry(id) {
    releaseId(id);
    if (!releases.has(id)) throw new RollingError('UNKNOWN_RELEASE', 404);
    if (retired.has(id)) throw new RollingError('RETIRED_RELEASE', 410);
    if (busy.has(id)) throw new RollingError('RELEASE_TRANSITION', 503);
    return releases.get(id);
  }
  async function statusOf(id) {
    const backend = releases.get(id);
    const status = await controlRequest(backend.controlSocket, { op: 'status' });
    if (status.releaseId !== id || status.ok !== true) throw new RollingError('BACKEND_IDENTITY_OR_HEALTH_FAILED', 503);
    for (const field of ['rooms', 'matches', 'retainedSessions', 'queued', 'online']) {
      if (!Number.isSafeInteger(status[field]) || status[field] < 0) throw new RollingError('INVALID_BACKEND_STATUS', 503);
    }
    if (typeof status.draining !== 'boolean' || typeof status.canRetire !== 'boolean') throw new RollingError('INVALID_BACKEND_STATUS', 503);
    return status;
  }
  async function health(id) {
    const status = await statusOf(id);
    const backend = releases.get(id);
    if (backend.assetResolver) await verifyMaterial(backend.assetResolver, limits.handshakeMs);
    await new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port: backend.port, path: '/healthz', agent: false }, (res) => {
        const chunks = []; let size = 0;
        res.on('data', (chunk) => { size += chunk.length; if (size > 8192) req.destroy(new RollingError('INVALID_BACKEND_HEALTH', 503)); else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (res.statusCode !== 200 || value.ok !== true || value.releaseId !== id) throw new RollingError('BACKEND_PORT_IDENTITY_FAILED', 503);
            resolve();
          } catch { reject(new RollingError('BACKEND_PORT_IDENTITY_FAILED', 503)); }
        });
      });
      req.setTimeout(limits.handshakeMs, () => req.destroy(new RollingError('BACKEND_HEALTH_TIMEOUT', 503)));
      req.on('error', reject);
    });
    return status;
  }
  async function validateStandbys() {
    for (const id of releases.keys()) {
      if (id === active || retired.has(id)) continue;
      let status;
      try { status = await statusOf(id); }
      catch (e) {
        // Fully unavailable historical targets remain pinned failures, never aliases to active.
        if (['ENOENT', 'ECONNREFUSED'].includes(e.code)) continue;
        throw e;
      }
      if (!status.draining) throw new RollingError('STANDBY_MUST_DRAIN');
    }
  }
  const drain = (id, value, current = active) => controlRequest(releases.get(id).controlSocket, { op: 'drain', draining: value, currentReleaseId: current });
  async function command(input) {
    if (closing) throw new RollingError('GATEWAY_CLOSING', 503);
    if (!ready) throw new RollingError('GATEWAY_NOT_READY', 503);
    if (input.op === 'status') {
      return { activeReleaseId: active, releases: await Promise.all([...releases.keys()].map(async (id) => {
        let status;
        if (!retired.has(id)) { try { status = await statusOf(id); } catch { status = { unavailable: true }; } }
        return { id, retired: retired.has(id), tunnels: tunnels.get(id)?.size || 0, http: httpCounts.get(id) || 0, ...status };
      })) };
    }
    if (input.op === 'reload') {
      if (!opts.registryFile) throw new RollingError('REGISTRY_FILE_REQUIRED');
      const snapshot = new Map(releases);
      try { add((await readPrivateJson(opts.registryFile)).releases); await validateStandbys(); await persist(); }
      catch (e) { releases.clear(); for (const [id, value] of snapshot) releases.set(id, value); throw e; }
      return { activeReleaseId: active, registered: [...releases.keys()] };
    }
    const id = releaseId(input.releaseId); entry(id);
    if (input.op === 'activate' || input.op === 'rollback') {
      await health(id);
      // Draining cancels old queue admission, not gameplay. Failures may leave admission drained;
      // never pretend this is a distributed transaction or silently kill/undo running matches.
      if (id !== active) await drain(active, true, id);
      await drain(id, false, id);
      try { await persist(id); }
      catch (e) { await drain(id, true, active).catch(() => {}); throw e; }
      const previous = active; active = id; presenceCache = null;
      log.info({ event: 'rolling.activate', previous, current: id });
      return { activeReleaseId: active, previousReleaseId: previous };
    }
    if (input.op === 'drain') {
      if (typeof input.draining !== 'boolean') throw new RollingError('INVALID_DRAIN', 400);
      if (!input.draining && id !== active) throw new RollingError('ONLY_ACTIVE_MAY_ACCEPT');
      await drain(id, input.draining); presenceCache = null;
      return statusOf(id);
    }
    if (input.op === 'retire') {
      if (id === active) throw new RollingError('CANNOT_RETIRE_ACTIVE');
      busy.add(id); // Fence all new HTTP/upgrade/bootstrap admissions while taking the proof.
      try {
        if ((tunnels.get(id)?.size || 0) || (httpCounts.get(id) || 0)) throw new RollingError('RELEASE_HAS_CONNECTIONS');
        const status = await statusOf(id);
        if (!status.draining || !status.canRetire || ['rooms', 'matches', 'retainedSessions', 'queued', 'online'].some((key) => status[key] !== 0)) throw new RollingError('RELEASE_HAS_STATE');
        const nextRetired = new Set([...retired, id]); await persist(active, nextRetired);
        retired.add(id); presenceCache = null;
        return { retiredReleaseId: id, backendStopped: false };
      } finally { busy.delete(id); }
    }
    throw new RollingError('UNKNOWN_COMMAND', 400);
  }
  const dispatch = (input) => {
    const result = serial.then(() => command(input)); serial = result.catch(() => {}); return result;
  };

  function client(req) {
    const peer = req.socket.remoteAddress;
    const forwarded = req.headers['x-real-ip'];
    return trustedProxyAddresses.has(peer) && typeof forwarded === 'string' && net.isIP(forwarded) ? forwarded : peer;
  }
  function vetted(req, websocket = false, publicMaterial = false) {
    const host = req.headers.host;
    const publicOrigin = publicOrigins.get(host);
    if (!publicOrigin) throw new RollingError('HOST_DENIED', 403);
    if (req.headers.origin != null && !opts.publicOrigins.includes(req.headers.origin)) {
      if (!publicMaterial) throw new RollingError('ORIGIN_DENIED', 403);
      // Only a registered release's public material mounts use CORS*. Business/WS origins stay exact.
      try { if (req.headers.origin !== 'null') origin(req.headers.origin); }
      catch { throw new RollingError('ORIGIN_DENIED', 403); }
    }
    if (websocket && (req.headers.origin !== publicOrigin || req.headers.upgrade?.toLowerCase() !== 'websocket')) throw new RollingError('ORIGIN_REQUIRED', 403);
    return publicOrigin;
  }
  function upstreamHeaders(req, publicOrigin, websocket = false) {
    const headers = headersWithoutHop(req.headers);
    // Gate cookies are not a game credential. Never leak them to a backend/static resolver.
    for (const key of Object.keys(headers)) if (/^(?:x-|forwarded$|cf-connecting-ip$|true-client-ip$|cookie$|authorization$)/i.test(key)) delete headers[key];
    headers.host = req.headers.host;
    headers['x-real-ip'] = client(req);
    headers['x-forwarded-for'] = client(req);
    headers['x-forwarded-host'] = req.headers.host;
    headers['x-forwarded-proto'] = new URL(publicOrigin).protocol.slice(0, -1);
    if (websocket) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
    return headers;
  }
  function releaseRoute(parsed) {
    const match = /^\/_release\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})(\/.*)?$/.exec(parsed.path);
    if (!match) throw new RollingError('NOT_FOUND', 404);
    const backend = entry(match[1]);
    const prefix = `/_release/${backend.id}`;
    if (parsed.rawPath !== prefix && !parsed.rawPath.startsWith(prefix + '/')) throw new RollingError('INVALID_PATH', 400);
    const sourceSuffix = match[2] || '';
    let suffix = sourceSuffix;
    let rawPath = parsed.rawPath.slice(prefix.length) || '/';
    let proxyPrefix = prefix;
    if (sourceSuffix.startsWith('/public/')) {
      suffix = sourceSuffix.slice('/public'.length);
      if (!(suffix === '/' || suffix === '/index.html' || suffix === '/favicon.ico' || /^\/(?:js|css|assets|media|fonts|vendor)\//.test(suffix))) throw new RollingError('NOT_FOUND', 404);
      rawPath = rawPath.slice('/public'.length); proxyPrefix += '/public';
    } else if (sourceSuffix.startsWith('/server/sim/')) {
      suffix = sourceSuffix.slice('/server'.length); rawPath = rawPath.slice('/server'.length); proxyPrefix += '/server';
    } else if (sourceSuffix === '/server/data.js') {
      suffix = '/data.js'; rawPath = '/data.js'; proxyPrefix += '/server';
    }
    return { backend, prefix, suffix, sourceSuffix, proxyPrefix, path: rawPath, query: parsed.query };
  }

  let presenceCache = null; let presencePending = null;
  async function presence() {
    if (presenceCache && Date.now() - presenceCache.serverNow < 1000) return presenceCache;
    if (presencePending) return presencePending;
    presencePending = (async () => {
      let online = 0, queued = 0, available = true;
      await Promise.all([...releases.keys()].filter((id) => !retired.has(id)).map(async (id) => {
        try { const status = await statusOf(id); online += status.online; queued += status.queued; }
        catch { available = false; }
      }));
      // No session ids, tokens, rooms, origins, health details, or backend topology are exposed.
      presenceCache = { online, queued, available, scope: 'all-releases', serverNow: Date.now() };
      return presenceCache;
    })().finally(() => { presencePending = null; });
    return presencePending;
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) jsonResponse(res, e instanceof RollingError ? e.status : 502, { error: e instanceof RollingError ? e.code : 'RELEASE_UNAVAILABLE' });
      else res.destroy();
    });
  });
  const connections = new Set();
  server.on('connection', (socket) => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  server.maxConnections = limits.maxTunnels + limits.maxHttp;
  server.headersTimeout = 10000; server.requestTimeout = 15000; server.keepAliveTimeout = 5000;
  async function handle(req, res) {
    if (closing) throw new RollingError('GATEWAY_CLOSING', 503);
    if (!publicOrigins.has(req.headers.host)) throw new RollingError('HOST_DENIED', 403);
    const parsed = parsePath(req.url);
    const route = parsed.path === '/' || parsed.path === '/_server/presence' ? null : releaseRoute(parsed);
    const publicMaterial = !!route && MOUNTS.some((mount) => route.suffix.startsWith(`/${mount}/`));
    const publicOrigin = vetted(req, false, publicMaterial);
    if (req.method === 'OPTIONS' && publicMaterial) {
      const wantedMethod = req.headers['access-control-request-method'];
      const allowedHeaders = new Set(['range', 'if-range', 'if-none-match', 'if-modified-since']);
      const wantedHeaders = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      if (wantedMethod != null && !['GET', 'HEAD'].includes(wantedMethod)) throw new RollingError('METHOD_DENIED', 405);
      if (wantedHeaders.some(value => !allowedHeaders.has(value))) throw new RollingError('HEADER_DENIED', 403);
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, If-Range, If-None-Match, If-Modified-Since',
        'Access-Control-Max-Age': '3600', 'Cache-Control': 'no-store', 'Content-Length': 0 });
      res.end(); return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new RollingError('METHOD_DENIED', 405);
    if (parsed.path === '/') {
      res.writeHead(302, { Location: `/_release/${active}/public/${safeQuery(parsed.query, ['room'])}`, 'Cache-Control': 'no-store', 'Content-Length': 0 }); res.end(); return;
    }
    if (parsed.path === '/_server/presence') { jsonResponse(res, 200, await presence()); return; }
    const { backend, prefix, suffix } = route;
    if (['', '/', '/public', '/index.html'].includes(route.sourceSuffix)) { res.writeHead(302, { Location: `${prefix}/public/${safeQuery(parsed.query, ['room'])}`, 'Cache-Control': 'no-store', 'Content-Length': 0 }); res.end(); return; }
    if ([...httpCounts.values()].reduce((a, b) => a + b, 0) >= limits.maxHttp) throw new RollingError('HTTP_CAPACITY', 503);
    httpCounts.set(backend.id, (httpCounts.get(backend.id) || 0) + 1);
    let finished = false;
    const complete = () => { if (finished) return; finished = true; httpCounts.set(backend.id, httpCounts.get(backend.id) - 1); };
    res.once('close', complete); res.once('finish', complete);
    if (suffix === '/_bootstrap') {
      const status = await statusOf(backend.id);
      jsonResponse(res, 200, { releaseId: backend.id, releaseBase: `${prefix}/public/`, wsPath: `${prefix}/ws`, currentReleaseId: active, currentReleaseBase: `/_release/${active}/public/`, draining: status.draining }); return;
    }
    if (!allowedPath(suffix)) throw new RollingError('NOT_FOUND', 404);
    const mount = MOUNTS.find((key) => suffix.startsWith(`/${key}/`));
    if (mount && !backend.localStatic) {
      if (mount === 'assets' || mount === 'media') { await serveMaterial(backend.assetResolver, req, res, route.path, limits.handshakeMs); return; }
      const base = backend.staticRoutes[mount].redirectBase;
      const rest = suffix.slice(mount.length + 2).split('/').map(encodeURIComponent).join('/');
      res.writeHead(302, { Location: base + rest + safeQuery(parsed.query, ['v', 'sp_request']), 'Cache-Control': 'no-store', 'Content-Length': 0 }); res.end(); return;
    }
    const upstream = http.request({ hostname: '127.0.0.1', port: backend.port, path: route.path + route.query, method: req.method, headers: upstreamHeaders(req, publicOrigin), agent: false }, (incoming) => {
      const headers = headersWithoutHop(incoming.headers);
      delete headers['set-cookie'];
      if (headers.location) {
        // Backend redirects may not escape this release or supply an upstream-controlled origin.
        try {
          const loc = new URL(headers.location, 'http://backend' + route.path);
          if (loc.origin !== 'http://backend' || !allowedPath(parsePath(loc.pathname).path)) throw new Error();
          headers.location = route.proxyPrefix + loc.pathname + loc.search;
        } catch { incoming.destroy(); jsonResponse(res, 502, { error: 'INVALID_BACKEND_REDIRECT' }); return; }
      }
      res.writeHead(incoming.statusCode, headers);
      incoming.on('error', () => res.destroy()); incoming.pipe(res);
    });
    upstream.setTimeout(limits.httpMs, () => upstream.destroy(new RollingError('RELEASE_TIMEOUT', 504)));
    upstream.on('error', () => { if (!res.headersSent) jsonResponse(res, 502, { error: 'RELEASE_UNAVAILABLE' }); else res.destroy(); });
    res.once('close', () => upstream.destroy()); upstream.end();
  }

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    let route; let address; let publicOrigin;
    try {
      if (closing) throw new RollingError('GATEWAY_CLOSING', 503);
      publicOrigin = vetted(req, true); route = releaseRoute(parsePath(req.url));
      if (req.method !== 'GET' || route.suffix !== '/ws' || route.query) throw new RollingError('NOT_FOUND', 404);
      address = client(req);
      if ([...tunnels.values()].reduce((n, set) => n + set.size, 0) >= limits.maxTunnels || (byAddress.get(address) || 0) >= limits.maxTunnelsPerAddress) throw new RollingError('WS_CAPACITY', 429);
    } catch (e) { socketError(socket, e.status || 400); return; }
    const id = route.backend.id;
    const set = tunnels.get(id) || new Set(); tunnels.set(id, set);
    const tunnel = { socket, backend: null, upstream: null, lastProgress: Date.now() };
    set.add(tunnel); byAddress.set(address, (byAddress.get(address) || 0) + 1);
    let done = false;
    const cleanup = () => {
      if (done) return; done = true;
      set.delete(tunnel); byAddress.set(address, byAddress.get(address) - 1); if (!byAddress.get(address)) byAddress.delete(address);
      tunnel.backend?.destroy(); tunnel.upstream?.destroy(); socket.destroy();
    };
    socket.once('close', cleanup);
    const upstream = http.request({ hostname: '127.0.0.1', port: route.backend.port, path: '/ws', method: 'GET', headers: upstreamHeaders(req, publicOrigin, true), agent: false });
    tunnel.upstream = upstream;
    const timeout = setTimeout(() => { socketError(socket, 504); upstream.destroy(); }, limits.handshakeMs); timeout.unref();
    upstream.once('upgrade', (response, backendSocket, backendHead) => {
      clearTimeout(timeout);
      if (done || response.statusCode !== 101) { backendSocket.destroy(); cleanup(); return; }
      tunnel.backend = backendSocket;
      backendSocket.on('error', cleanup); backendSocket.once('close', cleanup);
      const headers = headersWithoutHop(response.headers);
      delete headers['set-cookie'];
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' + Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join('') + '\r\n');
      if (backendHead.length) socket.write(backendHead);
      if (head.length) backendSocket.write(head);
      socket.on('data', () => { tunnel.lastProgress = Date.now(); });
      backendSocket.on('data', () => { tunnel.lastProgress = Date.now(); });
      socket.pipe(backendSocket); backendSocket.pipe(socket);
    });
    upstream.once('response', (response) => { clearTimeout(timeout); response.resume(); socketError(socket, response.statusCode === 429 ? 429 : 502); });
    upstream.once('error', () => { clearTimeout(timeout); socketError(socket, 502); });
    upstream.end();
  });
  // Native pipe backpressure bounds queues; also terminate slow consumers rather than retain memory indefinitely.
  const pressureTimer = setInterval(() => {
    for (const set of tunnels.values()) for (const tunnel of set) {
      const queued = Math.max(tunnel.socket.writableLength, tunnel.backend?.writableLength || 0);
      if (queued > limits.maxBufferedBytes || (queued && Date.now() - tunnel.lastProgress > limits.stalledMs)) {
        tunnel.socket.destroy(); tunnel.backend?.destroy(); tunnel.upstream?.destroy();
      }
    }
  }, 1000); pressureTimer.unref();
  server.on('clientError', (_e, socket) => socketError(socket, 400));
  try {
    // Claim the private listener before writing shared routing state; a second gateway must not alter it.
    control = await startControl(opts.controlSocket, dispatch);
    await health(active); await validateStandbys(); await persist();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(opts.port ?? 0, '127.0.0.1', resolve); });
    ready = true;
  } catch (e) {
    clearInterval(pressureTimer); await control?.close(); server.close(); throw e;
  }
  let closePromise;
  async function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      clearInterval(pressureTimer);
      await serial; await control.close();
      const done = new Promise((resolve) => server.close(resolve));
      for (const socket of connections) socket.destroy();
      for (const set of tunnels.values()) for (const tunnel of set) { tunnel.backend?.destroy(); tunnel.upstream?.destroy(); }
      await done;
      // Deliberately no backend shutdown: clients can reconnect to their pinned release after gateway restart.
    })();
    return closePromise;
  }
  return { server, port: server.address().port, control, close };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const config = await readPrivateJson(process.env.SP_ROLLING_CONFIG);
    const gateway = await startGateway({ ...config, log: { info: (value) => console.log(JSON.stringify(value)) } });
    console.log(JSON.stringify({ event: 'rolling.listening', port: gateway.port }));
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => gateway.close().then(() => process.exit(0), () => process.exit(1)));
  } catch (e) { console.error(JSON.stringify({ event: 'rolling.boot_failed', error: e instanceof RollingError ? e.code : 'BOOT_FAILED' })); process.exitCode = 1; }
}
