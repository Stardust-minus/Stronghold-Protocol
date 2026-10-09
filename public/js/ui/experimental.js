import { html, Button, Modal } from './components.js';
import { t, tc } from '../../../shared/i18n.js';
import { MAX_SEATS } from '../../../shared/constants.js';
import { PLAYER_CAPACITIES, isPlayerCapacity, roomCapacity } from '../../../shared/playerCapacity.js';

export function experimentalOptions(input) {
  const capacity = roomCapacity('coop', input);
  return { revivalEnabled: input?.revivalEnabled === true, disableSharedPool: input?.disableSharedPool === true,
    ...(capacity === MAX_SEATS ? {} : { playerCapacity: capacity }) };
}

export function experimentalSummary(input) {
  const options = experimentalOptions(input);
  const summary = t('复活 {0} · 共享卡池 {1}', { 0: options.revivalEnabled ? t('开启') : tc('toggle', '关闭'), 1: options.disableSharedPool ? tc('toggle', '关闭') : t('开启') });
  return options.playerCapacity ? t('{rules} · {n} 人模式', { rules: summary, n: options.playerCapacity }) : summary;
}

export function ExperimentalSummary({ value }) {
  return html`<span class="experimental-summary">${experimentalSummary(value)}</span>`;
}

export function ExperimentalOptions({ open, value, mode = 'coop', source = 'private', editable = false, busy = false, onChange, onClose }) {
  const options = experimentalOptions(value);
  const capacity = roomCapacity(mode, options);
  const change = (field, checked) => {
    if (editable && !busy) onChange?.({ ...options, [field]: checked });
  };
  const setCapacity = next => {
    if (!editable || busy || mode !== 'coop' || source === 'matchmaking' || !isPlayerCapacity(next)) return;
    const { playerCapacity, ...rules } = options;
    onChange?.(next === MAX_SEATS ? rules : { ...rules, playerCapacity: next });
  };
  return html`<${Modal} open=${open} title=${t('实验性选项')} micro="EXPERIMENTAL" ariaLabel=${t('实验性选项')} trapFocus=${true}
      class="experimental-modal" onClose=${onClose}
      actions=${html`<${Button} icon="check" onClick=${onClose}>${t('完成')}<//>`}>
    <div class="experimental-options">
      <label class="experimental-option" for="experimental-revival">
        <span><strong>${t('队友复活')}</strong><small>${t('符合救援条件的队友可支付 10 生命抵消死亡，每人每局一次。')}</small></span>
        <input id="experimental-revival" type="checkbox" role="switch" checked=${options.revivalEnabled}
          disabled=${!editable || busy} onChange=${e => change('revivalEnabled', e.currentTarget.checked)} />
      </label>
      <label class="experimental-option" for="experimental-pool">
        <span><strong>${t('禁用共享卡池')}</strong><small>${t('每位博士使用独立卡池，不再争用同一干员库存。')}</small></span>
        <input id="experimental-pool" type="checkbox" role="switch" checked=${options.disableSharedPool}
          disabled=${!editable || busy} onChange=${e => change('disableSharedPool', e.currentTarget.checked)} />
      </label>
      ${mode === 'coop' && source !== 'matchmaking' ? html`<label class="experimental-option" for="experimental-multiplayer">
        <span><strong>${t('扩展同盟人数')}</strong><small>${t('可直接开局，或整队匹配相同人数模式的房间。所有成员需更新页面，人数较多时等待与演算时间可能增加。')}</small></span>
        <input id="experimental-multiplayer" type="checkbox" role="switch" checked=${capacity > MAX_SEATS}
          disabled=${!editable || busy} onChange=${e => setCapacity(e.currentTarget.checked ? 8 : MAX_SEATS)} />
      </label>` : null}
      ${mode === 'coop' && source !== 'matchmaking' && capacity > MAX_SEATS ? html`<label class="experimental-capacity" for="experimental-capacity">
        <span>${t('同盟人数模式')}</span>
        <select id="experimental-capacity" value=${capacity} disabled=${!editable || busy} onChange=${e => setCapacity(Number(e.currentTarget.value))}>
          ${PLAYER_CAPACITIES.map(n => html`<option key=${n} value=${n}>${t('{n} 人', { n })}</option>`)}
        </select>
      </label>` : null}
    </div>
    <p class="experimental-options__note">${editable ? t('开局后不可更改') : t('由房间创建者设置')}</p>
  <//>`;
}
