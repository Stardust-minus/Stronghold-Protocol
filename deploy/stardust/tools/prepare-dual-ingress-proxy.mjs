// Offline, WS-only preparation. This never installs a vhost or reloads Nginx. Existing HTTP backends change only
// with --topology local, which exactly retargets the known WG coordinator/ingress addresses to the co-located stack.
import { readFileSync, writeFileSync, mkdirSync, lstatSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const profiles = {
  formal: { name: 'ark_cluster_formal_ingress_ws', firstPort: 35401, directPrefix: '172.30.246', maxInstances: 8,
    // WG-less co-located stack from cluster-local-stack.py; mirrors cluster-profile.py (core bridge, coordinator .2:3000).
    local: { project: 'ark-cluster-formal-local', corePrefix: '172.30.245', coordinatorPort: 35400, maxInstances: 16,
      backends: [
        // Required. Known: the WG coordinator publication and the earlier hand-edited loopback publication.
        { upstream: 'ark_proto_game_backend', required: true, known: ['10.253.79.2:35400', '127.0.0.1:35400'] },
        // Optional. Known: WG edge ingress-01 and the first ingress of either local layout.
        { upstream: 'ark_proto_ingress_backend', required: false, known: ['172.30.246.2:3000', '172.30.245.31:3000', '172.30.245.51:3000'] },
      ] } },
  beta: { name: 'ark_cluster_beta_ingress_ws', firstPort: 35301, maxInstances: 2 },
};
const paths = ['/ws', '/_release/v012-alliance-20261004/ws'];
const TLS_LISTEN_BACKLOGS = [4096];
const SUMMARY_FIELDS = ['activated', 'build', 'composeSha256', 'coordinatorPort', 'coreBundle', 'coreComposeSha256', 'gameNodes',
  'hostManagerLeases', 'imageId', 'ingress', 'manifestSha256', 'prepared', 'profile', 'project', 'sourceKind', 'version'];
// Present only when cluster-local-stack.py ran with --online-limit-dir (the cap directory it mounts into the coordinator).
const OPTIONAL_SUMMARY_FIELDS = ['onlineLimitDir'];
const sha = text => createHash('sha256').update(text).digest('hex');
const service = i => i === 0 ? 'ingress' : `ingress-${String(i + 1).padStart(2, '0')}`;
const exactKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys);
// Python json.dumps(sort_keys=True, indent=2) of an ASCII summary; refuses duplicate keys and hand edits.
const sortedJson = value => Array.isArray(value) ? value.map(sortedJson) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedJson(value[key])])) : value;

// Keep offsets while ignoring braces/directives in quoted strings and comments.
function mask(text) {
  let quote = '', comment = false, escaped = false, result = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (comment) { result += c === '\n' ? '\n' : ' '; if (c === '\n') comment = false; continue; }
    if (quote) {
      result += c === '\n' ? '\n' : ' ';
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '#' ) { comment = true; result += ' '; }
    else if (c === '"' || c === "'") { quote = c; result += ' '; }
    else result += c;
  }
  if (quote) throw new Error('Unterminated quoted Nginx value');
  return result;
}

// Multi-connection lanes (docs/DEPLOY.md「多连接」): every connection of one lanes group hashes to the same ingress, read
// from its Sec-WebSocket-Protocol token sp.lanes1.<22 base64url>.…; anything else spreads by request id. `legacy`: the
// earlier least_conn block, recognised only so re-preparation can replace it.
function upstreamBlock(name, endpoints, legacy = false) {
  const servers = endpoints.map(endpoint => `    server ${endpoint} max_fails=1 fail_timeout=5s;`).join('\n');
  const head = '# New handshakes only; established WebSockets stay on their original ingress.\n';
  if (legacy) return `${head}upstream ${name} {\n    least_conn;\n${servers}\n}\n\n`;
  return '# Multi-connection lanes (docs/DEPLOY.md「多连接」): every connection of one lanes group\n'
    + '# (Sec-WebSocket-Protocol sp.lanes1.<group>.…) hashes to the same ingress; anything else spreads by request id.\n'
    + `map $http_sec_websocket_protocol $${name}_route {\n    "~sp\\.lanes1\\.([A-Za-z0-9_-]{22})\\." $1;\n    default $request_id;\n}\n`
    + `${head}upstream ${name} {\n    hash $${name}_route;\n${servers}\n}\n\n`;
}

function wgEndpoints(spec, count) {
  return Array.from({ length: count }, (_, i) => spec.directPrefix ? `${spec.directPrefix}.${i + 2}:3000` : `127.0.0.1:${spec.firstPort + i}`);
}

// Mirrors cluster-profile.py local_ingress_ip/local_ingress_host_port: behind sixteen games .31../35401.. (max 8),
// behind thirty-two .51../35451.. (max 16; port == coordinator + address suffix).
function localLayout(local, gameNodes, count) {
  const base = gameNodes <= 16 ? 30 : 50;
  return Array.from({ length: count }, (_, i) => ({ service: service(i), container_ip: `${local.corePrefix}.${base + i + 1}`,
    host_port: gameNodes <= 16 ? local.coordinatorPort + 1 + i : local.coordinatorPort + base + i + 1 }));
}
const localMax = (local, gameNodes) => gameNodes <= 16 ? 8 : local.maxInstances;

function parseStackSummary(text, local) {
  if (typeof text !== 'string' || !text || Buffer.byteLength(text) > 64 * 1024) throw new Error('Local topology requires the stack summary');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Invalid local stack summary'); }
  const optional = value && typeof value === 'object' ? OPTIONAL_SUMMARY_FIELDS.filter(key => Object.hasOwn(value, key)) : [];
  if (!exactKeys(value, [...SUMMARY_FIELDS, ...optional].sort()) || text !== JSON.stringify(sortedJson(value), null, 2) + '\n'
    || (optional.includes('onlineLimitDir') && (typeof value.onlineLimitDir !== 'string' || !value.onlineLimitDir.startsWith('/')))
    || value.version !== 1 || value.profile !== 'formal' || value.project !== local.project || value.prepared !== true
    || value.activated !== false || value.hostManagerLeases !== false || value.coordinatorPort !== local.coordinatorPort
    || ![16, 32].includes(value.gameNodes) || !['commit', 'tree'].includes(value.sourceKind)
    || ![value.composeSha256, value.coreComposeSha256, value.manifestSha256].every(x => /^[a-f0-9]{64}$/.test(x))
    || !/^[a-f0-9]{40}$/.test(value.build) || !/^sha256:[a-f0-9]{64}$/.test(value.imageId)
    || typeof value.coreBundle !== 'string' || !value.coreBundle.startsWith('/')) throw new Error('Unexpected local stack summary');
  const rows = value.ingress;
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > localMax(local, value.gameNodes)) throw new Error('Unsupported fixed local ingress instance count');
  const expected = localLayout(local, value.gameNodes, rows.length);
  rows.forEach((row, i) => {
    if (!exactKeys(row, ['container_ip', 'host_port', 'service']) || row.service !== expected[i].service
      || row.container_ip !== expected[i].container_ip || row.host_port !== expected[i].host_port) throw new Error('Local ingress outside the fixed core bridge layout');
  });
  return { value, rows: expected, sha256: sha(text) };
}

// Exactly one known (or already-target) server address in one named upstream; keepalive and parameters are kept.
function backendRetarget(source, masked, { upstream, required, known }, target) {
  const blocks = [...masked.matchAll(new RegExp(`(?:^|[\\s;{}])upstream\\s+${upstream}\\s*\\{`, 'g'))];
  if (!blocks.length) { if (required) throw new Error('Expected upstream ' + upstream); return null; }
  if (blocks.length !== 1) throw new Error('Duplicate upstream ' + upstream);
  const start = blocks[0].index + blocks[0][0].length, end = masked.indexOf('}', start);
  if (end < 0 || masked.slice(start, end).includes('{')) throw new Error('Unclosed upstream ' + upstream);
  const servers = [...masked.slice(start, end).matchAll(/(^|[\s;])(server\s+)([^\s;]+)[^;]*;/g)];
  if (servers.length !== 1) throw new Error('Expected exactly one server in upstream ' + upstream);
  const [, lead, keyword, address] = servers[0], at = start + servers[0].index + lead.length + keyword.length;
  if (source.slice(at, at + address.length) !== address) throw new Error('Unexpected upstream server spelling');
  if (address !== target && !known.includes(address)) throw new Error('Unknown ' + upstream + ' server refused');
  return { upstream, previous: address, target, changed: address !== target, edit: { start: at, end: at + address.length, text: target } };
}

// Only the one IPv4 and one IPv6 `listen ... 443 ssl;`; already-tuned is accepted unchanged, other 443 options refuse.
function tlsListenEdits(source, masked, backlog) {
  const result = { backlog, reuseport: true, rewritten: [], unchanged: [] }, edits = [], seen = new Map();
  for (const match of masked.matchAll(/(^|[\s;{}])(listen\s+([^;]*);)/g)) {
    const address = match[3].trim().split(/\s+/)[0];
    if (!/(?:^|:)443$/.test(address)) continue;
    const start = match.index + match[1].length, directive = source.slice(start, start + match[2].length);
    if (!['443', '[::]:443'].includes(address) || seen.has(address)) throw new Error('Unreviewed TLS listen refused');
    seen.set(address, true);
    const tuned = `listen ${address} ssl reuseport backlog=${backlog};`;
    if (directive === tuned) { result.unchanged.push(address); continue; }
    if (directive !== `listen ${address} ssl;`) throw new Error('Conflicting TLS listen options refused');
    edits.push({ start, end: start + directive.length, text: tuned }); result.rewritten.push(address);
  }
  if (seen.size !== 2) throw new Error('Expected exactly one IPv4 and one IPv6 TLS listen');
  return { result, edits };
}

export function prepareDualIngressProxy(source, { profile = 'formal', ports, ingressInstances, topology = 'wg', stackSummary,
  tlsListenBacklog, replacePrepared = false } = {}) {
  const spec = Object.hasOwn(profiles, profile) ? profiles[profile] : null;
  if (!spec) throw new Error('Unknown cluster profile');
  if (topology !== 'wg' && topology !== 'local') throw new Error('Unknown proxy topology');
  if (topology === 'local' && !spec.local) throw new Error('Local topology is Formal-only');
  if (typeof replacePrepared !== 'boolean') throw new Error('Invalid replace-prepared flag');
  if (tlsListenBacklog !== undefined && tlsListenBacklog !== null && !TLS_LISTEN_BACKLOGS.includes(tlsListenBacklog)) throw new Error('Unsupported fixed TLS listen backlog');
  if ((topology === 'local') !== (stackSummary !== undefined)) throw new Error('A stack summary belongs to the local topology only');
  const summary = topology === 'local' ? parseStackSummary(stackSummary, spec.local) : null;
  if (summary && ports !== undefined) throw new Error('Local topology publishes only the fixed stack ports');
  ingressInstances ??= summary ? summary.rows.length : 2;
  const maximum = summary ? localMax(spec.local, summary.value.gameNodes) : spec.maxInstances;
  if (!Number.isInteger(ingressInstances) || ingressInstances < 2 || ingressInstances > maximum
    || (summary && ingressInstances !== summary.rows.length)) throw new Error('Unsupported fixed ingress instance count');
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > 512 * 1024) throw new Error('Invalid vhost input');
  const profilePorts = summary ? summary.rows.map(row => row.host_port) : Array.from({ length: ingressInstances }, (_, i) => spec.firstPort + i);
  ports = ports ?? profilePorts;
  if (!Array.isArray(ports) || ports.length !== ingressInstances || ports.some(p => !Number.isInteger(p) || p < 1024 || p > 65535) || new Set(ports).size !== ports.length) {
    throw new Error('Exact distinct loopback ingress ports are required');
  }
  // Re-preparation replaces ONLY an exact earlier generator block at the head: WG form, or (local only) either local layout.
  let previous = null, previousBlock = '';
  if (replacePrepared) {
    const forms = [];
    for (let n = 2; n <= spec.maxInstances; n++) forms.push({ topology: 'wg', endpoints: wgEndpoints(spec, n) });
    if (summary) for (const gameNodes of [16, 32]) for (let n = 2; n <= localMax(spec.local, gameNodes); n++) {
      forms.push({ topology: 'local', gameNodes, endpoints: localLayout(spec.local, gameNodes, n).map(row => `${row.container_ip}:3000`) });
    }
    // either the current block or the earlier least_conn one (before lanes)
    for (const form of forms) for (const legacy of [false, true]) {
      const block = upstreamBlock(spec.name, form.endpoints, legacy);
      if (!previous && source.startsWith(block)) { previous = form; previousBlock = block; }
    }
    if (!previous) throw new Error('Replace-prepared requires an exact earlier generator upstream');
  }
  const base = source.slice(previousBlock.length);
  const masked = mask(base);
  if (new RegExp('\\bupstream\\s+' + spec.name + '\\b').test(masked)) throw new Error('Dual ingress upstream already present');
  if (!/\bauth_request\s+\/[^;\s]+\s*;/.test(masked)) throw new Error('Existing private request gate is required');
  const locations = [], seen = new Set(), edits = [];
  const matcher = /(?:^|\n)[ \t]*location\s*=\s*(\/[^\s{]+)\s*\{/g;
  const preparedPass = new RegExp(`\\bproxy_pass\\s+http://${spec.name}(?:/ws)?;\\n([ \\t]*)proxy_next_upstream error timeout;\\n\\1proxy_next_upstream_tries 2;`, 'g');
  for (const match of masked.matchAll(matcher)) {
    if (!paths.includes(match[1])) continue;
    if (seen.has(match[1])) throw new Error('Duplicate WebSocket location');
    seen.add(match[1]);
    const start = match.index + match[0].length;
    let end = start, depth = 1;
    for (; end < masked.length; end++) {
      if (masked[end] === '{') depth++;
      if (masked[end] === '}' && --depth === 0) break;
    }
    if (depth) throw new Error('Unclosed WebSocket location');
    const body = base.slice(start, end), code = masked.slice(start, end);
    if (/\bauth_request\s+off\s*;/.test(code)) throw new Error('WebSocket gate must not be disabled');
    if (!/if\s*\(\s*\$http_origin\s*!=[^)]*\)\s*\{\s*return\s+403\s*;/.test(code)) throw new Error('Existing exact WebSocket Origin guard is required');
    if (previous) {
      // Every location of an earlier output already carries the exact generated pass/retry triple; keep it byte-for-byte.
      const prepared = [...code.matchAll(preparedPass)];
      const indent = prepared.length === 1 ? code.slice(0, prepared[0].index).match(/(?:^|\n)([ \t]*)$/)?.[1] : undefined;
      if (prepared.length !== 1 || indent !== prepared[0][1] || [...code.matchAll(/\bproxy_pass\s/g)].length !== 1
        || [...code.matchAll(/\bproxy_next_upstream(?:_tries)?\s/g)].length !== 2) throw new Error('Earlier WebSocket preparation changed');
      locations.push({ path: match[1], previousUpstream: spec.name });
      continue;
    }
    if (/\bproxy_next_upstream(?:_tries)?\s/.test(code)) throw new Error('Review existing WebSocket retry policy before preparation');
    const targets = [...code.matchAll(/\bproxy_pass\s+http:\/\/([A-Za-z_][A-Za-z0-9_]*)(\/ws)?\s*;/g)];
    if (targets.length !== 1 || [...code.matchAll(/\bproxy_pass\s/g)].length !== 1) throw new Error('Expected one named WebSocket upstream');
    if (targets[0][1] === spec.name) throw new Error('WebSocket location already targets the dual ingress upstream');
    const target = targets[0], before = body.slice(0, target.index), indent = before.match(/(?:^|\n)([ \t]*)$/)?.[1] ?? '        ';
    const replacement = `proxy_pass http://${spec.name}${target[2] || ''};\n${indent}proxy_next_upstream error timeout;\n${indent}proxy_next_upstream_tries 2;`;
    locations.push({ path: match[1], previousUpstream: target[1] });
    edits.push({ start: start + target.index, end: start + target.index + target[0].length, text: replacement });
  }
  if (!seen.has('/ws')) throw new Error('Expected exact /ws location');
  // Unknown compatibility WS routes must be reviewed instead of silently staying single-target.
  for (const match of masked.matchAll(/(?:^|\n)[ \t]*location\s+(?:=\s+|\^~\s+)?(\/[^\s{]*\/ws|\/ws)\s*\{/g)) {
    if (!seen.has(match[1])) throw new Error('Unreviewed WebSocket route: ' + match[1]);
  }
  // Local HTTP backends: the coordinator's and first ingress' fixed core-bridge listeners, bypassing docker-proxy.
  const retargets = summary ? spec.local.backends.map(backend => backendRetarget(base, masked, backend,
    backend.upstream === 'ark_proto_game_backend' ? `${spec.local.corePrefix}.2:3000` : `${summary.rows[0].container_ip}:3000`)).filter(Boolean) : [];
  for (const row of retargets) if (row.changed) edits.push(row.edit);
  const tls = tlsListenBacklog ? tlsListenEdits(base, masked, tlsListenBacklog) : null;
  if (tls) edits.push(...tls.edits);
  let vhost = base, limit = Infinity;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    if (edit.end > limit) throw new Error('Overlapping vhost edits refused');
    vhost = vhost.slice(0, edit.start) + edit.text + vhost.slice(edit.end); limit = edit.start;
  }
  const deploymentPortsMatchProfile = ports.every((p, i) => p === profilePorts[i]);
  // Formal business traffic bypasses docker-proxy; published ports remain for management/rollback.
  // Custom ports are isolated loopback fixtures, never an approved production profile.
  const direct = summary || (spec.directPrefix && deploymentPortsMatchProfile);
  const endpoints = summary ? summary.rows.map(row => `${row.container_ip}:3000`)
    : direct ? wgEndpoints(spec, ingressInstances) : ports.map(p => `127.0.0.1:${p}`);
  const prepared = upstreamBlock(spec.name, endpoints) + vhost;
  const services = summary ? summary.rows.map(row => row.service) : ports.map((_, i) => service(i));
  return { vhost: prepared, manifest: { activated: false, profile, topology, ingressInstances, services,
    endpoints, publishedPorts: ports.slice(), upstreamTransport: direct ? 'container-direct' : 'loopback', upstream: spec.name,
    webSocketLocations: locations.map(({ path, previousUpstream }) => ({ path, previousUpstream })),
    sourceSha256: sha(source), preparedSha256: sha(prepared),
    existingHttpAuthPrivateAndMaterialPathsUnchanged: !retargets.some(row => row.changed),
    backendRetargets: retargets.map(({ upstream, previous: from, target, changed }) => ({ upstream, previous: from, target, changed })),
    ...(summary ? { stackSummary: { sha256: summary.sha256, project: summary.value.project, gameNodes: summary.value.gameNodes,
      composeSha256: summary.value.composeSha256 } } : {}),
    tlsListen: tls ? tls.result : null,
    replacedPreparedUpstream: previous ? { topology: previous.topology, endpoints: previous.endpoints } : null,
    deploymentPortsMatchProfile,
    requiresReviewedActiveVhostAndApprovedGuardPolicy: true, existingSocketsMigrated: false } };
}

function regularFile(path, label) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(label + ' must be a regular non-symlink file');
  return path;
}

function main(args) {
  const usage = 'Usage: --source reviewed-vhost.conf --profile formal|beta --out NEW_DIRECTORY [--ingress-instances 2..8]'
    + ' [--topology wg|local --stack-summary STACK/stack-summary.json] [--tls-listen-backlog 4096] [--replace-prepared]';
  const values = ['--source', '--profile', '--out', '--ingress-instances', '--topology', '--stack-summary', '--tls-listen-backlog'];
  const opts = {};
  for (let i = 0; i < args.length;) {
    const key = args[i];
    if (Object.hasOwn(opts, key)) throw new Error(usage);
    if (key === '--replace-prepared') { opts[key] = true; i += 1; continue; }
    if (!values.includes(key) || !args[i + 1]) throw new Error(usage);
    opts[key] = args[i + 1]; i += 2;
  }
  if (!opts['--source'] || !opts['--out'] || !opts['--profile']) throw new Error('Source, profile and new output directory are required');
  const input = regularFile(resolve(opts['--source']), 'Source'), out = resolve(opts['--out']);
  if (existsSync(out)) throw new Error('Output already exists; preparation never overwrites');
  const count = opts['--ingress-instances'];
  if (count !== undefined && !/^(?:[2-9]|1[0-6])$/.test(count)) throw new Error('Unsupported fixed ingress instance count');
  const topology = opts['--topology'] ?? 'wg';
  if (!['wg', 'local'].includes(topology)) throw new Error(usage);
  const backlog = opts['--tls-listen-backlog'];
  if (backlog !== undefined && !TLS_LISTEN_BACKLOGS.map(String).includes(backlog)) throw new Error('Unsupported fixed TLS listen backlog');
  const summaryFile = opts['--stack-summary'] === undefined ? undefined : regularFile(resolve(opts['--stack-summary']), 'Stack summary');
  if (summaryFile && lstatSync(summaryFile).size > 64 * 1024) throw new Error('Stack summary size bound exceeded');
  const result = prepareDualIngressProxy(readFileSync(input, 'utf8'), { profile: opts['--profile'],
    ingressInstances: count === undefined ? undefined : Number(count), topology,
    stackSummary: summaryFile === undefined ? undefined : readFileSync(summaryFile, 'utf8'),
    tlsListenBacklog: backlog === undefined ? undefined : Number(backlog), replacePrepared: opts['--replace-prepared'] === true });
  mkdirSync(out, { mode: 0o700 });
  writeFileSync(join(out, 'vhost.conf'), result.vhost, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(out, 'proxy-preparation.json'), JSON.stringify(result.manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(result.manifest));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
