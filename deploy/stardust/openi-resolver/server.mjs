import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_ORIGIN = 'https://openi.pcl.ac.cn';
const OSS_ORIGIN = 'https://obs.cn-south-222.ai.pcl.cn';
const FALLBACK_ORIGIN = 'https://ark-asset.hanabi-ai.cn:25442';
const DATASET = 'Stardust_minus/arknight_assets';
const DEFAULT_MANIFEST = '/run/config/openi-assets.json';
export const MAX_MANIFEST_ENTRIES = 100000;
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/;
const EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'atlas', 'skel', 'obj', 'mtl', 'json',
  'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav']);
const QUERY_KEYS = new Set(['AWSAccessKeyId', 'Expires', 'Signature', 'response-content-disposition']);

export class ResolverError extends Error {
  constructor(code) { super(code); this.name = 'ResolverError'; this.code = code; }
}
const fail = (code) => { throw new ResolverError(code); };
const integer = (value, min, max, code = 'CONFIG') => {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(code);
  return value;
};
function keys(object, expected) {
  if (!object || typeof object !== 'object' || Array.isArray(object) ||
    Object.keys(object).length !== expected.length || expected.some(key => !Object.hasOwn(object, key))) fail('CONFIG');
}
function safeRelative(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 2048 && path.split('/').every(segment =>
    /^[A-Za-z0-9_\[\]-][A-Za-z0-9_.\[\]-]*$/.test(segment) && !segment.endsWith('.'));
}
const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');
function publicPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || !safeRelative(path.slice(1))) return false;
  const [namespace, ...segments] = path.slice(1).split('/');
  if (!segments.length || !['assets', 'media'].includes(namespace)) return false;
  return namespace === 'media' || EXTENSIONS.has(segments.at(-1).split('.').at(-1));
}
// Inspect the raw origin-form target before decoding: URL() would normalize traversal away.
export function requestPath(target) {
  if (typeof target !== 'string' || target.length > 8192 || CONTROLS.test(target) || target.includes('#')) return null;
  const path = target.split('?', 1)[0];
  if (/%(?:2f|5c)/i.test(path)) return null;
  try {
    const decoded = decodeURIComponent(path);
    return publicPath(decoded) ? decoded : null;
  } catch { return null; }
}

export function validateManifest(manifest) {
  const reuse = !!manifest && Object.hasOwn(manifest, 'mirrorReleases');
  keys(manifest, ['schemaVersion', 'release', 'dataset', 'apiOrigin', 'ossOrigin', 'ossPathPrefix', 'fallbackBase', 'entries',
    ...(reuse ? ['mirrorReleases'] : [])]);
  const approved = reuse ? manifest.mirrorReleases : null;
  if (reuse && (!Array.isArray(approved) || approved.length < 1 || approved.length > 2 ||
    approved.some(id => typeof id !== 'string' || !ID.test(id)) || new Set(approved).size !== approved.length)) fail('CONFIG');
  if (manifest.schemaVersion !== 1 || typeof manifest.release !== 'string' || !ID.test(manifest.release) ||
    manifest.dataset !== DATASET || manifest.apiOrigin !== API_ORIGIN || manifest.ossOrigin !== OSS_ORIGIN ||
    manifest.fallbackBase !== `${FALLBACK_ORIGIN}/releases/${manifest.release}` ||
    typeof manifest.ossPathPrefix !== 'string' || !manifest.ossPathPrefix.startsWith('/') ||
    !manifest.ossPathPrefix.endsWith('/') || !safeRelative(manifest.ossPathPrefix.slice(1, -1)) ||
    manifest.ossPathPrefix.split('/').length !== 4 || !Array.isArray(manifest.entries) ||
    manifest.entries.length === 0 || manifest.entries.length > MAX_MANIFEST_ENTRIES) fail('CONFIG');
  const entries = new Map(), files = new Map();
  let mirror;
  const used = new Set();
  for (const entry of manifest.entries) {
    keys(entry, ['requestPath', 'fileName', 'bytes', 'sha256', 'mime']);
    if (!publicPath(entry.requestPath) || !safeRelative(entry.fileName) ||
      !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      typeof entry.mime !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(entry.mime) ||
      entry.mime.length > 128 || entries.has(entry.requestPath)) fail('CONFIG');
    const [root, release, namespace, ...rest] = entry.fileName.split('/');
    if (root !== 'releases' || !ID.test(release) || !rest.length || !['assets', 'media'].includes(namespace) ||
      (namespace === 'assets' && !publicPath('/assets/' + rest.join('/'))) ||
      (namespace === 'media' && (!entry.mime.startsWith('audio/') || EXTENSIONS.has(rest.at(-1).split('.').at(-1)))) ||
      (entry.requestPath.startsWith('/media/') && (namespace !== 'media' || !entry.mime.startsWith('audio/'))) ||
      (reuse ? !approved.includes(release) : mirror && mirror !== release)) fail('CONFIG');
    mirror = release;
    used.add(release);
    const existing = files.get(entry.fileName);
    if (existing && ['bytes', 'sha256', 'mime'].some(key => existing[key] !== entry[key])) fail('CONFIG');
    const copy = Object.freeze({ ...entry });
    entries.set(copy.requestPath, copy);
    files.set(copy.fileName, copy);
  }
  if (reuse && (used.size !== approved.length || approved.some(id => !used.has(id)))) fail('CONFIG');
  return Object.freeze({ ...manifest, ...(reuse ? { mirrorReleases: Object.freeze([...approved]) } : {}), entries, files });
}

// Preserve the exact signed URL bytes; parsing is only for validation, never reserialization.
export function validateDestination(location, fileName, manifest, now = Date.now(), skewMs = 30000) {
  if (typeof location !== 'string' || location.length > 8192 || /[\s\u0000-\u001f\u007f-\u009f]/.test(location) ||
    location.includes('#')) fail('DESTINATION');
  const parts = /^https:\/\/([^/]+)(\/[^?#]*)(\?[^#]+)$/.exec(location);
  if (!parts || ![manifest.ossOrigin.slice(8), manifest.ossOrigin.slice(8) + ':443'].includes(parts[1]) ||
    /%(?:2f|5c)/i.test(parts[2])) fail('DESTINATION');
  let url, pathname;
  try { url = new URL(location); pathname = decodeURIComponent(parts[2]); } catch { fail('DESTINATION'); }
  if (url.origin !== manifest.ossOrigin || url.username || url.password || url.hash ||
    pathname !== manifest.ossPathPrefix + fileName || !safeRelative(pathname.slice(1))) fail('DESTINATION');
  const query = new Map();
  for (const pair of parts[3].slice(1).split('&')) {
    const at = pair.indexOf('=');
    if (at < 1) fail('DESTINATION');
    let key, value;
    try {
      key = decodeURIComponent(pair.slice(0, at).replaceAll('+', ' '));
      value = decodeURIComponent(pair.slice(at + 1).replaceAll('+', ' '));
    } catch { fail('DESTINATION'); }
    if (!QUERY_KEYS.has(key) || query.has(key) || !value || CONTROLS.test(value)) fail('DESTINATION');
    query.set(key, value);
  }
  if (!query.has('AWSAccessKeyId') || !query.has('Signature') || !/^[1-9]\d{0,12}$/.test(query.get('Expires') || '')) fail('DESTINATION');
  const expiresAt = Number(query.get('Expires')) * 1000;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now + skewMs) fail('DESTINATION');
  return { url: location, expiresAt };
}

function jitter(key, bound) {
  let hash = 2166136261;
  for (const char of key) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash % (bound + 1);
}
function retryAfter(value, now) {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Math.min(Number(value) * 1000, Number.MAX_SAFE_INTEGER - now);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}
function cancelBody(response) {
  try { void response?.body?.cancel().catch(() => {}); } catch { /* No body is inspected or logged. */ }
}

export default class OpenIResolver {
  #config; #fetch; #clock; #options; #rows = new Map(); #queue = []; #active = 0;
  #running = new Set(); #timers = new Set(); #timerAPI; #shutdown = new AbortController(); #closed = false; #blockedUntil = 0;
  #prewarmStarted = false; #prewarmActive = 0; #prewarmTimer = null; #warmHeap = [];
  #stats = { hits: 0, misses: 0, refreshes: 0, failures: 0, fallbacks: 0, apiRequests: 0 };

  constructor({ manifest, fetchImpl = globalThis.fetch, clock = Date.now, concurrency = 4, maxQueue = 128,
    timeoutMs = 5000, queueTimeoutMs = timeoutMs, skewMs = 30000, refreshMarginMs = 120000,
    refreshJitterMs = 30000, maxRetries = 1, retryBaseMs = 250, maxRetryDelayMs = 2000,
    failureBaseMs = 1000, maxFailureDelayMs = 30000, prewarm = false, prewarmConcurrency = 2,
    timers = { setTimeout, clearTimeout } } = {}) {
    this.#config = validateManifest(manifest);
    if (typeof fetchImpl !== 'function' || typeof clock !== 'function' || typeof prewarm !== 'boolean' ||
      typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function') fail('CONFIG');
    this.#fetch = fetchImpl; this.#clock = clock; this.#timerAPI = timers;
    this.#options = { concurrency: integer(concurrency, 1, 4), maxQueue: integer(maxQueue, 0, 128),
      timeoutMs: integer(timeoutMs, 1, 5000), queueTimeoutMs: integer(queueTimeoutMs, 1, 5000),
      skewMs: integer(skewMs, 30000, 60000), refreshMarginMs: integer(refreshMarginMs, 0, 300000),
      refreshJitterMs: integer(refreshJitterMs, 0, 60000), maxRetries: integer(maxRetries, 0, 1),
      retryBaseMs: integer(retryBaseMs, 1, 2000), maxRetryDelayMs: integer(maxRetryDelayMs, 1, 2000),
      failureBaseMs: integer(failureBaseMs, 1, 30000), maxFailureDelayMs: integer(maxFailureDelayMs, 1, 60000),
      prewarm, prewarmConcurrency: integer(prewarmConcurrency, 1, 2) };
    if (maxRetryDelayMs < retryBaseMs || maxFailureDelayMs < failureBaseMs ||
      (prewarm && concurrency - prewarmConcurrency < 2)) fail('CONFIG');
  }

  #valid(value) { return value && value.expiresAt > this.#clock() + this.#options.skewMs; }
  health() {
    let cache = 0;
    for (const row of this.#rows.values()) if (this.#valid(row.value)) cache++;
    return { ...this.#stats, cache,
      active: this.#active, queued: this.#queue.length, entries: this.#config.entries.size, files: this.#config.files.size,
      prewarmEnabled: this.#options.prewarm, prewarmActive: this.#prewarmActive,
      prewarmCompleted: cache, prewarmRemaining: this.#config.files.size - cache, warmComplete: cache === this.#config.files.size };
  }
  #row(fileName) {
    let row = this.#rows.get(fileName);
    if (!row) {
      row = { value: null, pending: null, retryAt: 0, failures: 0, prewarmAt: 0, warmItem: null };
      this.#rows.set(fileName, row);
    }
    return row;
  }

  // Explicit lifecycle: construction/import never fetches. startServer calls this only after listen succeeds.
  startPrewarm() {
    if (!this.#options.prewarm || this.#prewarmStarted || this.#closed) return;
    this.#prewarmStarted = true;
    for (const fileName of this.#config.files.keys()) this.#planWarm(fileName, this.#row(fileName));
    this.#wakePrewarm();
  }
  // Indexed min-heap: at most one deadline per known file, removed while its singleflight is pending.
  #warmSwap(a, b) {
    [this.#warmHeap[a], this.#warmHeap[b]] = [this.#warmHeap[b], this.#warmHeap[a]];
    this.#warmHeap[a].index = a; this.#warmHeap[b].index = b;
  }
  #warmUp(index) {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.#warmHeap[parent].due <= this.#warmHeap[index].due) break;
      this.#warmSwap(parent, index); index = parent;
    }
    return index;
  }
  #warmDown(index) {
    for (;;) {
      const left = index * 2 + 1, right = left + 1;
      let next = index;
      if (left < this.#warmHeap.length && this.#warmHeap[left].due < this.#warmHeap[next].due) next = left;
      if (right < this.#warmHeap.length && this.#warmHeap[right].due < this.#warmHeap[next].due) next = right;
      if (next === index) break;
      this.#warmSwap(index, next); index = next;
    }
  }
  #removeWarm(row) {
    const item = row.warmItem;
    if (!item || item.index < 0) return;
    const index = item.index, last = this.#warmHeap.pop();
    item.index = -1;
    if (last !== item) {
      this.#warmHeap[index] = last; last.index = index;
      this.#warmDown(this.#warmUp(index));
    }
  }
  #planWarm(fileName, row) {
    if (!this.#prewarmStarted || this.#closed || row.pending) return;
    const item = row.warmItem ||= { fileName, row, index: -1, due: 0 };
    this.#removeWarm(row);
    item.due = Math.max(row.retryAt, row.prewarmAt);
    item.index = this.#warmHeap.length; this.#warmHeap.push(item); this.#warmUp(item.index);
  }
  #wakePrewarm() {
    if (this.#prewarmTimer !== null) { this.#clear(this.#prewarmTimer); this.#prewarmTimer = null; }
    if (!this.#prewarmStarted || this.#closed || this.#queue.length || !this.#warmHeap.length ||
      this.#active >= this.#options.concurrency || this.#prewarmActive >= this.#options.prewarmConcurrency) return;
    const delay = Math.max(0, Math.max(this.#warmHeap[0].due, this.#blockedUntil) - this.#clock());
    // Cap distant Retry-After timers to Node's timer range, checking the absolute deadline again on wake.
    this.#prewarmTimer = this.#timer(() => { this.#prewarmTimer = null; this.#pumpPrewarm(); }, Math.min(delay, 2147483647));
    this.#prewarmTimer?.unref?.();
  }
  #pumpPrewarm() {
    while (!this.#closed && !this.#queue.length && this.#active < this.#options.concurrency &&
      this.#prewarmActive < this.#options.prewarmConcurrency && this.#warmHeap.length &&
      this.#clock() >= this.#blockedUntil && this.#warmHeap[0].due <= this.#clock()) {
      const { fileName, row } = this.#warmHeap[0];
      this.#schedule(fileName, row, true);
    }
    this.#wakePrewarm();
  }
  #fallback(entry) {
    this.#stats.fallbacks++;
    return { status: 302, location: this.#config.fallbackBase + encodePath(entry.requestPath), fallback: true };
  }
  async resolve(target, method = 'GET') {
    const entry = this.#config.entries.get(requestPath(target));
    if (!entry) return { status: 404 };
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) return { status: 405 };
    if (method === 'OPTIONS') return { status: 204 };
    if (method === 'HEAD' || this.#closed) return this.#fallback(entry);
    const row = this.#row(entry.fileName);
    if (this.#valid(row.value)) {
      this.#stats.hits++;
      if (this.#clock() >= row.value.refreshAt) this.#schedule(entry.fileName, row);
      return { status: 302, location: row.value.url, fallback: false };
    }
    this.#stats.misses++;
    await this.#schedule(entry.fileName, row);
    return this.#valid(row.value) ? { status: 302, location: row.value.url, fallback: false } : this.#fallback(entry);
  }

  #timer(callback, delay) {
    const timer = this.#timerAPI.setTimeout(() => { this.#timers.delete(timer); callback(); }, delay);
    this.#timers.add(timer);
    return timer;
  }
  #clear(timer) { this.#timerAPI.clearTimeout(timer); this.#timers.delete(timer); }
  #schedule(fileName, row, background = false) {
    if (row.pending) return row.pending;
    if (this.#closed || this.#clock() < Math.max(row.retryAt, this.#blockedUntil)) return Promise.resolve(null);
    this.#removeWarm(row);
    let settle;
    row.pending = new Promise(resolve => { settle = resolve; });
    const pending = row.pending;
    const task = { fileName, row, settle, background, done: false, timer: null };
    if (this.#active < this.#options.concurrency) this.#start(task);
    else if (!background && this.#queue.length < this.#options.maxQueue) {
      this.#queue.push(task);
      task.timer = this.#timer(() => {
        this.#queue.splice(this.#queue.indexOf(task), 1);
        this.#finish(task, null);
      }, this.#options.queueTimeoutMs);
    } else this.#finish(task, null);
    this.#wakePrewarm();
    return pending;
  }
  #finish(task, value) {
    if (task.done) return;
    task.done = true;
    if (task.timer !== null) this.#clear(task.timer);
    if (value && !this.#closed) {
      task.row.value = { ...value, refreshAt: value.expiresAt - this.#options.skewMs - this.#options.refreshMarginMs -
        jitter(task.fileName, this.#options.refreshJitterMs) };
      // A valid but unusually short/reused capability can already be refresh-due: never busy-spin on it.
      task.row.prewarmAt = Math.max(task.row.value.refreshAt, this.#clock() + 1000);
      task.row.failures = 0; task.row.retryAt = 0;
    } else if (!this.#closed) {
      this.#stats.failures++; task.row.failures++;
      task.row.retryAt = this.#clock() + Math.min(this.#options.maxFailureDelayMs,
        this.#options.failureBaseMs * 2 ** Math.min(task.row.failures - 1, 16) + jitter(task.fileName, 250));
    }
    task.row.pending = null;
    task.settle(value);
    this.#planWarm(task.fileName, task.row);
    this.#wakePrewarm();
  }
  #start(task) {
    if (task.timer !== null) this.#clear(task.timer);
    this.#active++;
    if (task.background) this.#prewarmActive++;
    if (task.row.value) this.#stats.refreshes++;
    const work = this.#run(task);
    this.#running.add(work);
    void work.then(() => this.#running.delete(work), () => this.#running.delete(work));
  }
  async #run(task) {
    try {
      if (this.#clock() < this.#blockedUntil || this.#closed) fail('UNAVAILABLE');
      this.#finish(task, await this.#download(task.fileName));
    } catch { this.#finish(task, null); }
    finally {
      this.#active--;
      if (task.background) this.#prewarmActive--;
      // Foreground jobs always drain first; background jobs never occupy this bounded queue.
      while (!this.#closed && this.#active < this.#options.concurrency && this.#queue.length) this.#start(this.#queue.shift());
      this.#wakePrewarm();
    }
  }
  async #pause(delay) {
    if (this.#closed) fail('CLOSED');
    let timer, abort;
    try {
      await new Promise((done, reject) => {
        abort = () => reject(new ResolverError('CLOSED'));
        this.#shutdown.signal.addEventListener('abort', abort, { once: true });
        timer = this.#timer(done, delay);
      });
    } finally { this.#clear(timer); this.#shutdown.signal.removeEventListener('abort', abort); }
  }
  async #request(fileName) {
    if (this.#closed) fail('CLOSED');
    const controller = new AbortController();
    const stop = () => controller.abort(new ResolverError('CLOSED'));
    this.#shutdown.signal.addEventListener('abort', stop, { once: true });
    const timer = this.#timer(() => controller.abort(new ResolverError('TIMEOUT')), this.#options.timeoutMs);
    const url = new URL('/api/v1/dataset/file', this.#config.apiOrigin);
    url.search = new URLSearchParams({ dataset_name: this.#config.dataset, file_name: fileName, parent_dir: '' }).toString();
    let abort;
    try {
      const aborted = new Promise((_, reject) => {
        abort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', abort, { once: true });
      });
      const fetched = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        this.#stats.apiRequests++;
        return this.#fetch(url.href, {
          method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal,
          headers: { Accept: '*/*' },
        });
      }).then(response => {
        if (controller.signal.aborted) { cancelBody(response); throw controller.signal.reason; }
        return response;
      });
      return await Promise.race([fetched, aborted]);
    } finally {
      this.#clear(timer);
      controller.signal.removeEventListener('abort', abort);
      this.#shutdown.signal.removeEventListener('abort', stop);
    }
  }
  async #download(fileName) {
    for (let attempt = 0; ; attempt++) {
      if (this.#closed || this.#clock() < this.#blockedUntil) fail('UNAVAILABLE');
      let response, delay = Math.min(this.#options.maxRetryDelayMs,
        this.#options.retryBaseMs * 2 ** attempt + jitter(fileName, this.#options.retryBaseMs));
      try {
        response = await this.#request(fileName);
        if (response.status === 301) return validateDestination(response.headers.get('location'), fileName,
          this.#config, this.#clock(), this.#options.skewMs);
        if (response.status === 429) {
          delay = Math.max(delay, retryAfter(response.headers.get('retry-after'), this.#clock()));
          this.#blockedUntil = Math.max(this.#blockedUntil, this.#clock() + delay);
        } else if (![500, 502, 503, 504].includes(response.status)) fail('RESPONSE');
      } catch (error) {
        if (this.#closed || (error instanceof ResolverError && !['TIMEOUT'].includes(error.code))) throw error;
      } finally { cancelBody(response); }
      if (attempt >= this.#options.maxRetries || delay > this.#options.maxRetryDelayMs) fail('UNAVAILABLE');
      await this.#pause(delay);
    }
  }
  async close() {
    this.#closed = true;
    this.#shutdown.abort(new ResolverError('CLOSED'));
    for (const task of this.#queue.splice(0)) this.#finish(task, null);
    for (const timer of this.#timers) this.#clear(timer);
    this.#prewarmTimer = null; this.#warmHeap.length = 0;
    await Promise.allSettled([...this.#running]);
    this.#rows.clear();
  }
}

export { OpenIResolver };

const loopback = (address) => address === '::1' || address === '::ffff:127.0.0.1' || /^127\./.test(address || '');
const commonHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
function send(response, method, status, headers = {}, body = '') {
  response.writeHead(status, { ...commonHeaders, ...headers, 'Content-Length': Buffer.byteLength(body) });
  response.end(method === 'HEAD' ? undefined : body);
}
export async function startServer(options = {}) {
  const { manifestPath = process.env.ASSET_MANIFEST || DEFAULT_MANIFEST,
    host = process.env.HOST || '127.0.0.1', port = process.env.PORT === undefined ? 3000 : Number(process.env.PORT),
    manifest: supplied, prewarm: suppliedPrewarm, ...resolverOptions } = options;
  let prewarm = suppliedPrewarm;
  if (prewarm === undefined) {
    if (process.env.PREWARM !== undefined && !['0', '1'].includes(process.env.PREWARM)) fail('CONFIG');
    prewarm = process.env.PREWARM === '1';
  }
  if (typeof host !== 'string' || !isIP(host) || (options.port === undefined && process.env.PORT !== undefined &&
    !/^[1-9]\d{0,4}$/.test(process.env.PORT))) fail('CONFIG');
  integer(port, options.port === 0 ? 0 : 1, 65535);
  let manifest = supplied;
  if (!manifest) {
    try {
      const bytes = await readFile(manifestPath);
      if (bytes.length > MAX_MANIFEST_BYTES) fail('CONFIG');
      manifest = JSON.parse(bytes.toString('utf8'));
    } catch { fail('CONFIG'); }
  }
  const resolver = new OpenIResolver({ manifest, ...resolverOptions, prewarm });
  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 15000, keepAliveTimeout: 5000 },
    (request, response) => {
      void (async () => {
        if (request.url.split('?', 1)[0] === '/healthz') {
          if (!loopback(request.socket.remoteAddress)) return send(response, request.method, 404);
          if (!['GET', 'HEAD'].includes(request.method)) return send(response, request.method, 405, { Allow: 'GET, HEAD' });
          return send(response, request.method, 200, { 'Content-Type': 'application/json' }, JSON.stringify(resolver.health()));
        }
        const headers = { 'Access-Control-Allow-Origin': '*', Vary: 'Origin, Sec-Fetch-Mode' };
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return send(response, request.method, 405,
          { ...headers, Allow: 'GET, HEAD, OPTIONS' });
        const result = await resolver.resolve(request.url, request.method);
        if (result.location) {
          headers.Location = result.location;
          if (!result.fallback) {
            // OBS omits ACAO without Origin and does not send Vary. Isolate browser cache entries for display-only
            // images and CORS readers, including old clients, without changing any signed field or object bytes.
            // The approved Signature V2 origin accepts this fixed cache-only parameter (verified by live probes).
            const cors = request.headers['sec-fetch-mode'] === 'cors' || !!request.headers.origin;
            headers.Location += cors ? '&sp_request=cors' : '&sp_request=display';
          }
        }
        if (result.status === 204) Object.assign(headers, {
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Range, If-Range, If-None-Match, If-Modified-Since',
        });
        send(response, request.method, result.status, headers);
      })().catch(() => { if (!response.headersSent) send(response, request.method, 500); else response.destroy(); });
    });
  server.on('clientError', (_, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  server.on('connect', (_, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 405 Method Not Allowed\r\nAllow: GET, HEAD, OPTIONS\r\n' +
      'Cache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  server.on('close', () => { void resolver.close(); });
  try {
    await new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.removeListener('error', reject); done(); });
    });
  } catch { await resolver.close(); fail('LISTEN'); }
  resolver.startPrewarm();
  let closing;
  return { server, resolver, close() {
    closing ||= (async () => {
      const stopped = new Promise((done, reject) => server.close(error =>
        error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(new ResolverError('CLOSE')) : done()));
      await resolver.close();
      server.closeAllConnections();
      await stopped;
    })();
    return closing;
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().then(app => {
    process.stdout.write(JSON.stringify({ event: 'openi_resolver_started', port: app.server.address().port }) + '\n');
    const stop = () => { void app.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  }).catch(() => {
    process.stderr.write(JSON.stringify({ event: 'openi_resolver_start_failed' }) + '\n');
    process.exitCode = 1;
  });
}
