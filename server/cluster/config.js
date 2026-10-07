// Operator-owned runtime configuration. Secret key bytes never belong in JSON,
// argv, environment examples, source, images or diagnostic messages.
import { open, constants } from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { ROOT } from '../data.js';
import { publicGameLabel } from '../../shared/cluster-load.js';

const id = value => typeof value === 'string' && value.length > 0 && value.length <= 64 && /^[A-Za-z0-9_-][A-Za-z0-9_-]*(?![\s\S])/.test(value);
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, required, optional = []) => plain(value) && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const port = value => Number.isInteger(value) && value > 0 && value <= 65535;
const privateIp = value => {
  const address = value.replace(/^\[|\]$/g, '');
  if (address === '::1') return true;
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 127 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31;
};
const bindHost = value => typeof value === 'string' && (value === '0.0.0.0' || privateIp(value));
const upstream = value => {
  try {
    const url = new URL(value);
    return typeof value === 'string' && ['http:', 'https:'].includes(url.protocol) && privateIp(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
  } catch { return false; }
};
export class ClusterConfigError extends Error {
  constructor(code) { super(code); this.name = 'ClusterConfigError'; this.code = code; }
}
const fail = code => { throw new ClusterConfigError(code); };
function externalPath(file) {
  if (typeof file !== 'string' || file.length > 4096 || file.includes('\0') || !path.isAbsolute(file) || path.normalize(file) !== file
    || file === ROOT || file.startsWith(ROOT + path.sep)) fail('INVALID_SECRET_PATH');
  return file;
}
async function protectedFile(file, maxBytes, exactBytes) {
  externalPath(file);
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat(), uid = process.getuid?.();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes || exactBytes != null && stat.size !== exactBytes
      || uid != null && stat.uid !== uid && stat.uid !== 0 || (stat.mode & 0o007) !== 0 || (stat.mode & 0o022) !== 0) fail('UNSAFE_SECRET_FILE');
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) fail('SECRET_FILE_CHANGED');
    return bytes;
  } catch (error) { if (error instanceof ClusterConfigError) throw error; fail('SECRET_FILE_UNAVAILABLE'); }
  finally { await handle?.close(); }
}
function checkNodes(nodes, withKey) {
  if (!Array.isArray(nodes) || !nodes.length || new Set(nodes.map(node => node?.nodeId)).size !== nodes.length) fail('INVALID_NODES');
  const slots = nodes.filter(node => node?.publicSlot !== undefined).map(node => node.publicSlot);
  if (new Set(slots).size !== slots.length) fail('INVALID_NODES');
  for (const node of nodes) {
    if (!exact(node, ['nodeId', 'url', ...(withKey ? ['keyFile'] : [])], withKey ? ['capacity', 'publicSlot'] : []) || !id(node.nodeId) || !upstream(node.url)
      || node.capacity !== undefined && (!Number.isSafeInteger(node.capacity) || node.capacity < 0)
      || node.publicSlot !== undefined && publicGameLabel(node.publicSlot) === null) fail('INVALID_NODES');
    if (withKey) externalPath(node.keyFile);
  }
}
export async function loadClusterConfig(file) {
  const bytes = await protectedFile(file, 64 * 1024);
  let config;
  try { config = JSON.parse(bytes.toString('utf8')); } catch { fail('INVALID_CONFIG'); }
  if (!plain(config) || !['game', 'coordinator', 'ingress'].includes(config.role) || !bindHost(config.host) || !port(config.port)) fail('INVALID_CONFIG');
  if (config.role !== 'ingress' && (typeof config.build !== 'string' || !/^[a-f0-9]{40}(?![\s\S])/.test(config.build))) fail('INVALID_BUILD');
  if (config.role === 'game') {
    if (!exact(config, ['role', 'nodeId', 'build', 'host', 'port', 'keyFile', 'coordinatorUrl'], ['combatWorkers', 'trialWorkers', 'futureSkewMs', 'publicSlot'])
      || !id(config.nodeId) || !upstream(config.coordinatorUrl)
      || config.publicSlot !== undefined && publicGameLabel(config.publicSlot) === null
      || config.combatWorkers !== undefined && (!Number.isInteger(config.combatWorkers) || config.combatWorkers < 1 || config.combatWorkers > 32)
      || config.trialWorkers !== undefined && ![0, 1, 2].includes(config.trialWorkers)
      || config.futureSkewMs !== undefined && (!Number.isInteger(config.futureSkewMs) || config.futureSkewMs < 0 || config.futureSkewMs > 2000)) fail('INVALID_CONFIG');
    const key = await protectedFile(config.keyFile, 32, 32);
    const { keyFile, ...runtime } = config;
    return { ...runtime, key };
  }
  if (config.role === 'coordinator') {
    if (!exact(config, ['role', 'build', 'host', 'port', 'privateHost', 'privatePort', 'nodes'], ['heartbeatMs', 'snapshotHz'])
      || !bindHost(config.privateHost) || !port(config.privatePort)
      || config.snapshotHz !== undefined && ![5, 10, 20].includes(config.snapshotHz)
      || config.heartbeatMs !== undefined && (!Number.isInteger(config.heartbeatMs) || config.heartbeatMs < 100 || config.heartbeatMs > 30000)) fail('INVALID_CONFIG');
    checkNodes(config.nodes, true);
    const nodes = await Promise.all(config.nodes.map(async node => { const { keyFile, ...runtime } = node; return { ...runtime, key: await protectedFile(keyFile, 32, 32) }; }));
    return { ...config, nodes };
  }
  if (!exact(config, ['role', 'host', 'port', 'coordinatorUrl', 'nodes', 'origins'], ['wsCompression', 'trustProxy'])
    || !upstream(config.coordinatorUrl) || config.wsCompression !== undefined && !['on', 'off'].includes(config.wsCompression)
    || config.trustProxy !== undefined && !['auto', true, false].includes(config.trustProxy)
    || !Array.isArray(config.origins) || !config.origins.length) fail('INVALID_CONFIG');
  for (const origin of config.origins) {
    try { const url = new URL(origin); if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) fail('INVALID_CONFIG'); }
    catch { fail('INVALID_CONFIG'); }
  }
  checkNodes(config.nodes, false);
  return config;
}
