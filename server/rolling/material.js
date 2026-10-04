// Per-release OpenI resolver identity and redirect boundary. No asset bytes or signed URLs are logged.
import http from 'node:http';
import { RollingError, jsonResponse } from './control.js';

function get(target, pathname, method, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: target.port, path: pathname, method, headers, agent: false }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 4096) req.destroy(new RollingError('INVALID_MATERIAL_RESPONSE', 502)); else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new RollingError('MATERIAL_UNAVAILABLE', 502)));
    req.on('error', (e) => reject(e instanceof RollingError ? e : new RollingError('MATERIAL_UNAVAILABLE', 502)));
    req.end();
  });
}

export async function verifyMaterial(target, timeoutMs = 2000) {
  const response = await get(target, '/_material', 'GET', {}, timeoutMs);
  let info;
  try { info = JSON.parse(response.body.toString('utf8')); } catch { throw new RollingError('MATERIAL_IDENTITY_FAILED', 503); }
  if (response.status !== 200 || Object.keys(info).sort().join(',') !== 'manifestHash,release' || info.release !== target.materialReleaseId || info.manifestHash !== target.manifestHash) {
    throw new RollingError('MATERIAL_IDENTITY_FAILED', 503);
  }
}

export async function serveMaterial(target, req, res, rawPath, timeoutMs = 2000) {
  const fallback = () => {
    // Same manifest material release, never current/default assets. Unknown files still fail at the exact static whitelist.
    const suffix = rawPath.slice(1).split('/').map((part) => encodeURIComponent(decodeURIComponent(part))).join('/');
    res.writeHead(302, { Location: target.fallbackBase + suffix, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', Vary: 'Origin, Sec-Fetch-Mode', 'Content-Length': 0 }); res.end();
  };
  try {
    await verifyMaterial(target, timeoutMs);
    const headers = {};
    // Deliberate allowlist: no Cookie, Authorization, Proxy-Authorization, or forwarding chain survives.
    for (const name of ['origin', 'sec-fetch-mode', 'range', 'if-range']) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
    const response = await get(target, rawPath, req.method, headers, timeoutMs);
    if (response.status >= 500) { fallback(); return; }
    if (response.status === 302) {
      let url;
      try { url = new URL(response.headers.location); } catch { throw new RollingError('INVALID_MATERIAL_REDIRECT', 502); }
      const validOSS = url.origin === target.ossOrigin && url.pathname.startsWith(target.ossPathPrefix + 'assets/') ||
        url.origin === target.ossOrigin && url.pathname.startsWith(target.ossPathPrefix + 'media/');
      const fallbackUrl = new URL(target.fallbackBase);
      const validFallback = url.origin === fallbackUrl.origin && url.pathname === fallbackUrl.pathname + rawPath.slice(1);
      const segments = decodeURIComponent(url.pathname).split('/');
      if (url.username || url.password || url.hash || (!validOSS && !validFallback) || segments.some((part) => part === '.' || part === '..') || /%2f|%5c|%25/i.test(url.pathname)) {
        throw new RollingError('INVALID_MATERIAL_REDIRECT', 502);
      }
      res.writeHead(302, { Location: url.href, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', Vary: 'Origin, Sec-Fetch-Mode', 'Content-Length': 0 }); res.end(); return;
    }
    if (![400, 403, 404, 405].includes(response.status)) throw new RollingError('INVALID_MATERIAL_RESPONSE', 502);
    res.writeHead(response.status, { 'Cache-Control': 'no-store', 'Content-Length': 0, 'Access-Control-Allow-Origin': '*' }); res.end();
  } catch (e) {
    if (e.code === 'MATERIAL_UNAVAILABLE') fallback();
    else jsonResponse(res, e.status || 502, { error: e.code || 'MATERIAL_FAILED' });
  }
}
