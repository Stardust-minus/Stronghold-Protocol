import { html, Button, Modal } from './components.js';

export function experimentalOptions(input) {
  return { revivalEnabled: input?.revivalEnabled === true, disableSharedPool: input?.disableSharedPool === true };
}

export function experimentalSummary(input) {
  const options = experimentalOptions(input);
  return `复活 ${options.revivalEnabled ? '开启' : '关闭'} · 共享卡池 ${options.disableSharedPool ? '关闭' : '开启'}`;
}

export function ExperimentalSummary({ value }) {
  return html`<span class="experimental-summary">${experimentalSummary(value)}</span>`;
}

export function ExperimentalOptions({ open, value, editable = false, busy = false, onChange, onClose }) {
  const options = experimentalOptions(value);
  const change = (field, checked) => {
    if (editable && !busy) onChange?.({ ...options, [field]: checked });
  };
  return html`<${Modal} open=${open} title="实验性选项" micro="EXPERIMENTAL" ariaLabel="实验性选项" trapFocus=${true}
      class="experimental-modal" onClose=${onClose}
      actions=${html`<${Button} icon="check" onClick=${onClose}>完成<//>`}>
    <div class="experimental-options">
      <label class="experimental-option" for="experimental-revival">
        <span><strong>队友复活</strong><small>符合救援条件的队友可支付 10 生命抵消死亡，每人每局一次。</small></span>
        <input id="experimental-revival" type="checkbox" role="switch" checked=${options.revivalEnabled}
          disabled=${!editable || busy} onChange=${e => change('revivalEnabled', e.currentTarget.checked)} />
      </label>
      <label class="experimental-option" for="experimental-pool">
        <span><strong>禁用共享卡池</strong><small>每位博士使用独立卡池，不再争用同一干员库存。</small></span>
        <input id="experimental-pool" type="checkbox" role="switch" checked=${options.disableSharedPool}
          disabled=${!editable || busy} onChange=${e => change('disableSharedPool', e.currentTarget.checked)} />
      </label>
    </div>
    <p class="experimental-options__note">${editable ? '开局后不可更改' : '由房间创建者设置'}</p>
  <//>`;
}
