import { normalizeClusterLoad } from '../../shared/cluster-load.js';

export function scopedClusterLoad(input, scope = 'cluster') {
  const load = normalizeClusterLoad(input);
  return load?.scope === scope ? load : null;
}

export function loadSummary(input) {
  const load = normalizeClusterLoad(input);
  if (!load) return null;
  if (load.scope === 'game') {
    const node = load.nodes[0];
    return { caption: node.label.replace('game-', '对战 '), state: node.status === 'ready' ? node.loadState : 'unknown' };
  }
  const ready = load.nodes.filter(n => n.status === 'ready');
  const state = ready.length !== load.nodes.length || ready.some(n => n.loadState === 'unknown') ? 'unknown'
    : ready.some(n => n.loadState === 'overloaded') ? 'overloaded'
      : ready.some(n => n.loadState === 'busy') ? 'busy' : 'normal';
  return { caption: `集群 ${ready.length}/${load.nodes.length}`, state };
}
