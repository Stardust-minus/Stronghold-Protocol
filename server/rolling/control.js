// Private HTTP-over-UDS administration. Never attach this handler to the game/gateway TCP listener.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export class RollingError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}

export function releaseId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new RollingError('INVALID_RELEASE', 400);
  return value;
}

/** Parent must already exist, be owned by this uid, non-symlinked and accessible only to its owner. */
export async function privatePath(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || Buffer.byteLength(filename) > 100) {
    throw new RollingError('INVALID_PRIVATE_PATH', 400);
  }
  const parent = path.dirname(filename);
  const stat = await fs.lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) ||
      (process.getuid && stat.uid !== process.getuid()) || await fs.realpath(parent) !== parent) {
    throw new RollingError('PRIVATE_DIRECTORY_REQUIRED', 400);
  }
  return filename;
}

export async function readPrivateJson(filename) {
  await privatePath(filename);
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) ||
      (process.getuid && stat.uid !== process.getuid()) || stat.size > 256 * 1024) {
    throw new RollingError('INVALID_PRIVATE_FILE', 400);
  }
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}

/** Durable replace: restrictive new file, fsync, same-directory rename, fsync directory. */
export async function writePrivateJson(filename, value) {
  await privatePath(filename);
  try { await readPrivateJson(filename); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`;
  let file;
  try {
    file = await fs.open(temp, 'wx', 0o600);
    await file.writeFile(JSON.stringify(value) + '\n');
    await file.sync();
    await file.close(); file = null;
    await fs.rename(temp, filename);
    const directory = await fs.open(path.dirname(filename), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await file?.close();
    await fs.unlink(temp).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  }
}

export function jsonResponse(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

export async function startControl(socketPath, dispatch) {
  await privatePath(socketPath);
  // Never unlink somebody else's listener, including an apparently stale socket.
  try { await fs.lstat(socketPath); throw new RollingError('CONTROL_PATH_EXISTS'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.origin != null || req.headers['transfer-encoding'] || req.url !== '/control' || req.method !== 'POST') {
        throw new RollingError('CONTROL_REQUEST_DENIED', 403);
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) throw new RollingError('CONTROL_BODY_TOO_LARGE', 413);
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new RollingError('INVALID_JSON', 400); }
      if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.op !== 'string') throw new RollingError('INVALID_COMMAND', 400);
      jsonResponse(res, 200, await dispatch(input));
    } catch (e) { if (!res.headersSent && !res.destroyed) jsonResponse(res, e.status || 500, { error: e instanceof RollingError ? e.code : 'CONTROL_FAILED' }); }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.setTimeout(5000, () => socket.destroy()); });
  server.on('upgrade', (_req, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await fs.chmod(socketPath, 0o600);
  const inode = (await fs.lstat(socketPath)).ino;
  let closing;
  return { server, socketPath, close() {
    if (closing) return closing;
    closing = (async () => {
      const done = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await done;
      try { if ((await fs.lstat(socketPath)).ino === inode) await fs.unlink(socketPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    })();
    return closing;
  } };
}

export function controlRequest(socketPath, input, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(input);
    const req = http.request({ socketPath, path: '/control', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (chunk) => { size += chunk.length; if (size > 64 * 1024) req.destroy(new RollingError('CONTROL_REPLY_TOO_LARGE')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200) reject(new RollingError(value.error || 'CONTROL_FAILED', res.statusCode));
          else resolve(value);
        } catch { reject(new RollingError('INVALID_CONTROL_REPLY', 502)); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new RollingError('CONTROL_TIMEOUT', 504)));
    req.on('error', reject); req.end(body);
  });
}
