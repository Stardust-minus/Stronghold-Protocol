// Public, cached game-process measurements. Never render the internal health response.
import { normalizeLoadDetails, normalizeServerLoad } from '../../../shared/protocol.js';
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

export function ServerStatusModal({ open, online = true, state, details, onClose }) {
  const d = online ? normalizeLoadDetails(details) : null;
  const status = online ? normalizeServerLoad(state) : 'unknown';
  return html`<${Modal} open=${open} title="游戏服务开销" micro="SERVICE TELEMETRY" ariaLabel="游戏服务开销" trapFocus=${true}
      class="server-status-modal" onClose=${onClose}
      actions=${html`<${Button} icon="close" onClick=${onClose}>关闭详情<//>`}>
    <div class="server-status__heading">
      <span class=${`server-load server-load--${status}`} role="status"><i aria-hidden="true" /><span>响应压力 · ${LOAD_LABELS[status]}</span></span>
      <span class="server-status__window num">${d ? `${value(d.windowMs / 1000)}s 采样窗口` : '等待有效采样'}</span>
    </div>
    ${!d ? html`<p class="server-status__empty"><${Icon} name="info" />${online ? '采样尚未就绪或已过期，稍后会随响应回包自动更新。' : '当前未连接，开销数据暂不可用。'}</p>` : null}
    <div class="server-status__grid">${processUsageRows(d).map(row => html`<section key=${row.key} class="usage-metric">
      <span class="usage-metric__label">${row.label}</span>
      <div class="usage-metric__number num"><strong>${row.value}</strong><span>${row.unit}</span></div>
      <p>${row.note}</p>
    </section>`)}</div>
    <dl class="server-status__secondary">
      <div><dt>主线程堆</dt><dd class="num">${value(d?.heapMiB)} <small>MiB</small></dd></div>
      <div><dt>事件循环 P99</dt><dd class="num">${value(d?.p99Ms)} <small>ms</small></dd></div>
      <div><dt>回包时样本年龄</dt><dd class="num">${d ? value(d.ageMs / 1000) : '--'} <small>s</small></dd></div>
    </dl>
    <p class="server-status__note">约每 10 秒采样，随现有心跳更新。这里仅显示游戏服务的粗粒度数据，不代表整机、网络或每个战斗线程的独立负载。</p>
  <//>`;
}
