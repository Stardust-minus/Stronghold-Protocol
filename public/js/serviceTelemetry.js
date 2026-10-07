import { normalizeClusterLoad, publicGameLabel } from '../../shared/cluster-load.js';
import { t, N_ } from '../../shared/i18n.js';

// Site display names only; wire labels, allocation IDs and routes remain unchanged.
const GAME_NODE_NAMES = Object.freeze([
  N_('罗德岛'), N_('企鹅物流'), N_('莱茵生命'), N_('黑钢国际'),
  N_('喀兰贸易'), N_('龙门'), N_('卡西米尔'), N_('乌萨斯'),
  N_('炎'), N_('拉特兰'), N_('萨尔贡'), N_('哥伦比亚'),
  N_('叙拉古'), N_('萨米'), N_('伊比利亚'), N_('卡兹戴尔'),
]);

export function gameDisplayName(label) {
  if (typeof label !== 'string') return null;
  const slot = Number(label.slice('game-'.length));
  if (publicGameLabel(slot) !== label) return null;
  return GAME_NODE_NAMES[slot - 1] ? t(GAME_NODE_NAMES[slot - 1]) : t('对战 {slot}', { slot: label.slice('game-'.length) });
}

export function scopedClusterLoad(input, scope = 'cluster') {
  const load = normalizeClusterLoad(input);
  return load?.scope === scope ? load : null;
}

export function loadSummary(input) {
  const load = normalizeClusterLoad(input);
  if (!load) return null;
  if (load.scope === 'game') {
    const node = load.nodes[0];
    return { caption: gameDisplayName(node.label), state: node.status === 'ready' ? node.loadState : 'unknown' };
  }
  const ready = load.nodes.filter(n => n.status === 'ready');
  const state = ready.length !== load.nodes.length || ready.some(n => n.loadState === 'unknown') ? 'unknown'
    : ready.some(n => n.loadState === 'overloaded') ? 'overloaded'
      : ready.some(n => n.loadState === 'busy') ? 'busy' : 'normal';
  return { caption: t('集群 {n}/{n2}', { n: ready.length, n2: load.nodes.length }), state };
}
