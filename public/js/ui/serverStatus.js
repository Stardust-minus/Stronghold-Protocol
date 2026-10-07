// Public cached measurements only; lobby lists the cluster, a match shows its owner.
import { normalizeLoadDetails, normalizeServerLoad } from '../../../shared/protocol.js';
import { scopedClusterLoad } from '../serviceTelemetry.js';
export { scopedClusterLoad, loadSummary } from '../serviceTelemetry.js';
import { html, Button, Modal, Icon } from './components.js';

export const LOAD_LABELS = Object.freeze({ unknown: '未知', normal: '正常', busy: '繁忙', overloaded: '拥堵' });
const value = n => Number.isFinite(n) ? String(Math.round(n * 10) / 10) : '--';

export function processUsageRows(input) {
  const d = normalizeLoadDetails(input);
  return [
    { key: 'cpu', label: '进程 CPU', value: value(d?.cpuPercent), unit: '%', note: '所有游戏线程合计；100% 相当于占用一个 CPU 核' },
    { key: 'rss', label: '常驻内存', value: value(d?.rssMiB), unit: 'MiB', note: '游戏进程的实际驻留内存，包括战斗线程' },
    { key: 'elu', label: '主线程活跃度', value: value(d?.eluPercent), unit: '%', note: '调度与消息处理的活跃时间占比，不是整机 CPU' },
    { key: 'p95', label: '事件循环 P95', value: value(d?.p95Ms), unit: 'ms', note: '近期窗口的第 95 百分位等待，不是网络延迟' },
  ];
}

function LoadBadge({ state, status = 'ready' }) {
  const text = status === 'unavailable' ? '离线' : status === 'unknown' ? '未知' : LOAD_LABELS[state];
  return html`<span class=${`server-load server-load--${status === 'ready' ? state : 'unknown'}`}><i aria-hidden="true" />${text}</span>`;
}

export function ServerStatusModal({ open, online = true, state, details, clusterLoad, scope = 'cluster', onClose }) {
  const load = online ? scopedClusterLoad(clusterLoad, scope) : null;
  // A control-plane sample must never masquerade as the active game's measurements.
  const wrongScope = clusterLoad != null && !load;
  const d = online && !wrongScope ? normalizeLoadDetails(details) : null;
  const status = online && !wrongScope ? normalizeServerLoad(state) : 'unknown';
  const title = load?.scope === 'cluster' ? '对战集群' : load?.scope === 'game' ? load.nodes[0].label.replace('game-', '对战 ') : '游戏服务开销';
  return html`<${Modal} open=${open} title=${title} micro="SERVICE STATUS" ariaLabel=${title} trapFocus=${true}
      class=${`server-status-modal${load?.scope === 'cluster' ? ' server-status-modal--cluster' : ''}`} onClose=${onClose}
      actions=${html`<${Button} icon="close" onClick=${onClose}>关闭<//>`}>
    ${load?.scope === 'cluster' ? html`
      <div class="server-status__heading"><span>${load.nodes.filter(n => n.status === 'ready').length} / ${load.nodes.length} 节点就绪</span><span class="server-status__window">自动更新</span></div>
      <div class="server-status__table-wrap"><table class="server-status__table">
        <thead><tr><th>节点</th><th>状态</th><th title="100% 相当于一个 CPU 核，包含战斗线程">CPU %</th><th>内存 MiB</th><th title="主线程活跃时间占比">主线程 %</th><th>P95 ms</th></tr></thead>
        <tbody>${load.nodes.map(node => html`<tr key=${node.label}><th scope="row">${node.label.replace('game-', '对战 ')}</th>
          <td><${LoadBadge} state=${node.loadState} status=${node.status} /></td>
          <td class="num">${value(node.loadDetails?.cpuPercent)}</td><td class="num">${value(node.loadDetails?.rssMiB)}</td>
          <td class="num">${value(node.loadDetails?.eluPercent)}</td><td class="num">${value(node.loadDetails?.p95Ms)}</td></tr>`)}</tbody>
      </table></div>` : html`
      <div class="server-status__heading"><${LoadBadge} state=${load?.nodes[0]?.loadState ?? status} status=${load?.nodes[0]?.status ?? 'ready'} />
        <span class="server-status__window num">${(load?.nodes[0]?.loadDetails ?? d) ? '自动更新' : '等待采样'}</span></div>
      <dl class="server-status__metrics">${processUsageRows(load?.nodes[0]?.loadDetails ?? d).map(row => html`<div key=${row.key} title=${row.note}>
        <dt>${row.label}</dt><dd class="num">${row.value}<small>${row.unit}</small></dd></div>`)}</dl>`}
    ${!online ? html`<p class="server-status__empty"><${Icon} name="wifiOff" />未连接</p>` : wrongScope ? html`<p class="server-status__empty">等待当前对战节点响应</p>` : null}
    <p class="server-status__note">进程 CPU：100% = 1 核 · 每 10 秒采样</p>
  <//>`;
}
