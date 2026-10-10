// Offline, WS-only preparation. This never installs a vhost, reloads Nginx or changes the existing HTTP backend.
import { readFileSync, writeFileSync, mkdirSync, lstatSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const profiles = {
  formal: { name: 'ark_cluster_formal_ingress_ws', firstPort: 35401, directPrefix: '172.30.246', maxInstances: 8 },
  beta: { name: 'ark_cluster_beta_ingress_ws', firstPort: 35301, maxInstances: 2 },
};
const paths = ['/ws', '/_release/v012-alliance-20261004/ws'];
const sha = text => createHash('sha256').update(text).digest('hex');

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

export function prepareDualIngressProxy(source, { profile = 'formal', ports, ingressInstances = 2 } = {}) {
  const spec = Object.hasOwn(profiles, profile) ? profiles[profile] : null;
  if (!spec) throw new Error('Unknown cluster profile');
  if (!Number.isInteger(ingressInstances) || ingressInstances < 2 || ingressInstances > spec.maxInstances) throw new Error('Unsupported fixed ingress instance count');
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > 512 * 1024) throw new Error('Invalid vhost input');
  const profilePorts = Array.from({ length: ingressInstances }, (_, i) => spec.firstPort + i);
  ports = ports ?? profilePorts;
  if (!Array.isArray(ports) || ports.length !== ingressInstances || ports.some(p => !Number.isInteger(p) || p < 1024 || p > 65535) || new Set(ports).size !== ports.length) {
    throw new Error('Exact distinct loopback ingress ports are required');
  }
  const masked = mask(source);
  if (new RegExp('\\bupstream\\s+' + spec.name + '\\b').test(masked)) throw new Error('Dual ingress upstream already present');
  if (!/\bauth_request\s+\/[^;\s]+\s*;/.test(masked)) throw new Error('Existing private request gate is required');
  const locations = [], seen = new Set();
  const matcher = /(?:^|\n)[ \t]*location\s*=\s*(\/[^\s{]+)\s*\{/g;
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
    const body = source.slice(start, end), code = masked.slice(start, end);
    if (/\bauth_request\s+off\s*;/.test(code)) throw new Error('WebSocket gate must not be disabled');
    if (!/if\s*\(\s*\$http_origin\s*!=[^)]*\)\s*\{\s*return\s+403\s*;/.test(code)) throw new Error('Existing exact WebSocket Origin guard is required');
    if (/\bproxy_next_upstream(?:_tries)?\s/.test(code)) throw new Error('Review existing WebSocket retry policy before preparation');
    const targets = [...code.matchAll(/\bproxy_pass\s+http:\/\/([A-Za-z_][A-Za-z0-9_]*)(\/ws)?\s*;/g)];
    if (targets.length !== 1 || [...code.matchAll(/\bproxy_pass\s/g)].length !== 1) throw new Error('Expected one named WebSocket upstream');
    const target = targets[0], before = body.slice(0, target.index), indent = before.match(/(?:^|\n)([ \t]*)$/)?.[1] ?? '        ';
    const replacement = `proxy_pass http://${spec.name}${target[2] || ''};\n${indent}proxy_next_upstream error timeout;\n${indent}proxy_next_upstream_tries 2;`;
    locations.push({ path: match[1], start, end, previousUpstream: target[1], body: before + replacement + body.slice(target.index + target[0].length) });
  }
  if (!seen.has('/ws')) throw new Error('Expected exact /ws location');
  // Unknown compatibility WS routes must be reviewed instead of silently staying single-target.
  for (const match of masked.matchAll(/(?:^|\n)[ \t]*location\s+(?:=\s+|\^~\s+)?(\/[^\s{]*\/ws|\/ws)\s*\{/g)) {
    if (!seen.has(match[1])) throw new Error('Unreviewed WebSocket route: ' + match[1]);
  }
  let vhost = source;
  for (const item of [...locations].sort((a, b) => b.start - a.start)) vhost = vhost.slice(0, item.start) + item.body + vhost.slice(item.end);
  const deploymentPortsMatchProfile = ports.every((p, i) => p === profilePorts[i]);
  // Formal business traffic bypasses docker-proxy; published ports remain for management/rollback.
  // Custom ports are isolated loopback fixtures, never an approved production profile.
  const endpoints = spec.directPrefix && deploymentPortsMatchProfile
    ? ports.map((_, i) => `${spec.directPrefix}.${i + 2}:3000`) : ports.map(p => `127.0.0.1:${p}`);
  const servers = endpoints.map(endpoint => `    server ${endpoint} max_fails=1 fail_timeout=5s;`).join('\n');
  const upstream = `# New handshakes only; established WebSockets stay on their original ingress.\nupstream ${spec.name} {\n    least_conn;\n${servers}\n}\n\n`;
  const prepared = upstream + vhost;
  const services = ports.map((_, i) => i === 0 ? 'ingress' : `ingress-${String(i + 1).padStart(2, '0')}`);
  return { vhost: prepared, manifest: { activated: false, profile, ingressInstances, services,
    endpoints, publishedPorts: ports.slice(), upstreamTransport: spec.directPrefix && deploymentPortsMatchProfile ? 'container-direct' : 'loopback', upstream: spec.name,
    webSocketLocations: locations.map(({ path, previousUpstream }) => ({ path, previousUpstream })),
    sourceSha256: sha(source), preparedSha256: sha(prepared), existingHttpAuthPrivateAndMaterialPathsUnchanged: true,
    deploymentPortsMatchProfile,
    requiresReviewedActiveVhostAndApprovedGuardPolicy: true, existingSocketsMigrated: false } };
}

function main(args) {
  const opts = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--source', '--profile', '--out', '--ingress-instances'].includes(key) || !args[i + 1] || Object.hasOwn(opts, key)) throw new Error('Usage: --source reviewed-vhost.conf --profile formal|beta --out NEW_DIRECTORY [--ingress-instances 2..8]');
    opts[key] = args[i + 1];
  }
  if (!opts['--source'] || !opts['--out'] || !opts['--profile']) throw new Error('Source, profile and new output directory are required');
  const input = resolve(opts['--source']), out = resolve(opts['--out']);
  if (!lstatSync(input).isFile() || lstatSync(input).isSymbolicLink()) throw new Error('Source must be a regular non-symlink file');
  if (existsSync(out)) throw new Error('Output already exists; preparation never overwrites');
  const count = opts['--ingress-instances'] ?? '2';
  if (!/^[2-8]$/.test(count)) throw new Error('Unsupported fixed ingress instance count');
  const result = prepareDualIngressProxy(readFileSync(input, 'utf8'), { profile: opts['--profile'], ingressInstances: Number(count) });
  mkdirSync(out, { mode: 0o700 });
  writeFileSync(join(out, 'vhost.conf'), result.vhost, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(out, 'proxy-preparation.json'), JSON.stringify(result.manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(result.manifest));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
