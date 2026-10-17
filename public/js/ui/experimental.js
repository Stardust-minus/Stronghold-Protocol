import { html, Button, Modal } from './components.js';
import { t, tc } from '../../../shared/i18n.js';
import { MAX_SEATS } from '../../../shared/constants.js';
import { EXPERIMENTAL_OPTIONAL, EXPERIMENTAL_OPTIONAL_DEFAULTS, optionalValue } from '../../../shared/experimental.js';
import { PLAYER_CAPACITIES, isPlayerCapacity, roomCapacity } from '../../../shared/playerCapacity.js';

export function experimentalOptions(input) {
  const capacity = roomCapacity('coop', input);
  return { revivalEnabled: input?.revivalEnabled === true, disableSharedPool: input?.disableSharedPool === true,
    ...(capacity > MAX_SEATS && input?.disableDuckLord === true ? { disableDuckLord: true } : {}),
    ...(capacity === MAX_SEATS ? {} : { playerCapacity: capacity }),
    // Only the switches that differ from their own default (策略阶段看特训敌人 is on unless turned off)
    ...EXPERIMENTAL_OPTIONAL.reduce((out, key) => {
      const next = optionalValue(input ?? {}, key);
      if (next !== EXPERIMENTAL_OPTIONAL_DEFAULTS[key]) out[key] = next;
      return out;
    }, {}) };
}

/** Whether any option differs from a standard room's (the room's 实验性选项 button is then marked). */
export function experimentalChanged(input) {
  const options = experimentalOptions(input);
  return options.revivalEnabled || options.disableSharedPool || !!options.disableDuckLord || !!options.playerCapacity
    || EXPERIMENTAL_OPTIONAL.some(key => options[key] !== undefined);
}

export function experimentalSummary(input) {
  const options = experimentalOptions(input);
  const summary = t('复活 {0} · 共享卡池 {1}', { 0: options.revivalEnabled ? t('开启') : tc('toggle', '关闭'), 1: options.disableSharedPool ? tc('toggle', '关闭') : t('开启') });
  let rules = options.disableDuckLord ? `${summary} · ${t('禁用鸭爵策略')}` : summary;
  if (options.briefingSpecialEnemies === false) rules = `${rules} · ${t('策略阶段不看特训敌人')}`;
  if (options.luckConsole) rules = `${rules} · ${t('测试插件')}`;
  return options.playerCapacity ? t('{rules} · {n} 人模式', { rules, n: options.playerCapacity }) : rules;
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
    if (next === MAX_SEATS) {
      const { disableDuckLord, ...ordinary } = rules;
      onChange?.(ordinary);
    } else onChange?.({ ...rules, playerCapacity: next });
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
      ${mode === 'coop' && capacity > MAX_SEATS ? html`<label class="experimental-option" for="experimental-ducklord">
        <span><strong>${t('禁用鸭爵策略')}</strong><small>${t('勾选后，本局无法选择鸭爵策略；不影响其他策略。')}</small></span>
        <input id="experimental-ducklord" type="checkbox" checked=${options.disableDuckLord === true}
          disabled=${!editable || busy} onChange=${e => change('disableDuckLord', e.currentTarget.checked)} />
      </label>` : null}
      ${source !== 'matchmaking' ? html`<label class="experimental-option" for="experimental-briefing-enemies">
        <span><strong>${t('策略阶段看特训敌人')}</strong><small>${t('默认开启：选择策略时打开「本局信息」也能看到本局的特训敌人（准备阶段的简报本来就显示它）；取消勾选就只看简报。')}</small></span>
        <input id="experimental-briefing-enemies" type="checkbox" role="switch" checked=${optionalValue(value ?? {}, 'briefingSpecialEnemies')}
          disabled=${!editable || busy} onChange=${e => change('briefingSpecialEnemies', e.currentTarget.checked)} />
      </label>` : null}
      ${source !== 'matchmaking' ? html`<label class="experimental-option" for="experimental-luck-console">
        <span><strong>${t('Luck 测试插件')}</strong><small>${t('开局后允许打开 Luck 测试面板（改资金、回合、地图、盟约层数等）；不勾选则完全不加载。')}</small></span>
        <input id="experimental-luck-console" type="checkbox" role="switch" checked=${options.luckConsole === true}
          disabled=${!editable || busy} onChange=${e => change('luckConsole', e.currentTarget.checked)} />
      </label>` : null}
    </div>
    <p class="experimental-options__note">${editable ? t('开局后不可更改') : t('由房间创建者设置')}</p>
  <//>`;
}
