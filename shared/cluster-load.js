// Bounded public diagnostics, separate from internal node/routing identities.
import { normalizeServerLoad, normalizeLoadDetails } from './protocol.js';

export const MAX_PUBLIC_GAME_NODES = 256;
const statuses = new Set(['ready', 'unavailable', 'unknown']);
const plain = value => value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;

export function publicGameLabel(slot) {
  return Number.isSafeInteger(slot) && slot >= 1 && slot <= MAX_PUBLIC_GAME_NODES
    ? `game-${String(slot).padStart(2, '0')}` : null;
}

function safeLabel(value) {
  if (typeof value !== 'string') return false;
  const match = /^game-([0-9]{2,3})(?![\s\S])/.exec(value);
  return !!match && publicGameLabel(Number(match[1])) === value;
}

/** Whitelisted measurements only; incomplete pressure samples remain unknown. */
export function normalizeGameLoad(value) {
  try {
    if (!plain(value) || !safeLabel(value.label)) return null;
    const status = statuses.has(value.status) ? value.status : 'unknown';
    const loadDetails = status === 'ready' ? normalizeLoadDetails(value.loadDetails) : null;
    const loadState = loadDetails && loadDetails.eluPercent !== null && loadDetails.p95Ms !== null
      ? normalizeServerLoad(value.loadState) : 'unknown';
    return { label: value.label, status, loadState, loadDetails };
  } catch { return null; }
}

/** No internal IDs, addresses, epochs, tickets or extra fields survive projection. */
export function normalizeClusterLoad(value) {
  try {
    if (!plain(value) || !['cluster', 'game'].includes(value.scope) || !Array.isArray(value.nodes)
      || !value.nodes.length || value.nodes.length > MAX_PUBLIC_GAME_NODES
      || value.scope === 'game' && value.nodes.length !== 1) return null;
    const nodes = value.nodes.map(normalizeGameLoad);
    if (nodes.some(node => node === null) || new Set(nodes.map(node => node.label)).size !== nodes.length) return null;
    return { scope: value.scope, nodes };
  } catch { return null; }
}
