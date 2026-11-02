import { html } from './components.js';
import { t, tc } from '../../../shared/i18n.js';
import { MAX_SEATS } from '../../../shared/constants.js';
import { PLAYER_CAPACITIES, isPlayerCapacity, roomCapacity } from '../../../shared/playerCapacity.js';
import { ENEMY_MULTIPLIERS, isEnemyMultiplier } from '../../../shared/experimental.js';
import { autoPoolPlan, canonicalPoolPlan, isPoolPlan, poolCount } from '../../../shared/poolPlan.js';
import { confirmCollab } from './collab.js';

/** A room's enemy multiplier as the page shows it: 1 when it has none. */
const enemyMul = value => (isEnemyMultiplier(value) ? value : 1);

export function experimentalOptions(input) {
  const capacity = roomCapacity('coop', input);
  const plan = isPoolPlan(input?.poolPlan, capacity) ? canonicalPoolPlan(input.poolPlan) : null;
  return { revivalEnabled: input?.revivalEnabled === true, disableSharedPool: !plan && input?.disableSharedPool === true,
    ...(capacity > MAX_SEATS && input?.disableDuckLord === true ? { disableDuckLord: true } : {}),
    ...(input?.disableLayerCap === true ? { disableLayerCap: true } : {}),
    ...(input?.disableHitLimit === true ? { disableHitLimit: true } : {}),
    ...(enemyMul(input?.enemyHpMul) !== 1 ? { enemyHpMul: input.enemyHpMul } : {}),
    ...(enemyMul(input?.enemyAtkMul) !== 1 ? { enemyAtkMul: input.enemyAtkMul } : {}),
    ...(capacity === MAX_SEATS ? {} : { playerCapacity: capacity }),
    ...(plan ? { poolPlan: plan } : {}),
    ...(input?.collabOps === true ? { collabOps: true } : {}) };
}

/** Whether any option differs from a standard room's (the room's 实验性选项 button is then marked). */
export function experimentalChanged(input) {
  const options = experimentalOptions(input);
  return options.revivalEnabled || options.disableSharedPool || !!options.disableDuckLord || !!options.disableLayerCap || !!options.disableHitLimit || !!options.enemyHpMul || !!options.enemyAtkMul || !!options.playerCapacity || !!options.poolPlan || !!options.collabOps;
}

export function experimentalSummary(input) {
  const options = experimentalOptions(input);
  const summary = t('复活 {0} · 共享卡池 {1}', { 0: options.revivalEnabled ? t('开启') : tc('toggle', '关闭'), 1: options.disableSharedPool ? tc('toggle', '关闭') : t('开启') });
  const rules = [summary, options.disableDuckLord && t('禁用鸭爵策略'), options.disableLayerCap && t('禁用层数上限'), options.disableHitLimit && t('禁用单次伤害上限'),
    options.enemyHpMul && t('敌人生命 ×{n}', { n: options.enemyHpMul }), options.enemyAtkMul && t('敌人攻击 ×{n}', { n: options.enemyAtkMul }),
    options.poolPlan && t('手动卡池 {n} 组', { n: poolCount(options.poolPlan) }), options.collabOps && t('联动干员')].filter(Boolean).join(' · ');
  return options.playerCapacity ? t('{rules} · {n} 人模式', { rules, n: options.playerCapacity }) : rules;
}

export function ExperimentalSummary({ value }) {
  return html`<span class="experimental-summary">${experimentalSummary(value)}</span>`;
}

/** One switch of the settings dialog (ui/roomSettings.js): off unless the room or the rule says otherwise. */
export function switchRow({ id, title, note, checked, disabled, onChange, testid }) {
  return html`<label class="experimental-option" for=${id}>
    <span><strong>${title}</strong>${note ? html`<small>${note}</small>` : null}</span>
    <input id=${id} type="checkbox" role="switch" data-testid=${testid} checked=${checked} disabled=${disabled} onChange=${e => onChange(e.currentTarget.checked, e)} />
  </label>`;
}

/** A setter for the room's options: the whole object goes to the server, and only from a host who may change it. */
function optionsEditor({ value, editable, busy, onChange }) {
  const options = experimentalOptions(value), locked = !editable || busy;
  return { options, locked, send: next => { if (!locked) onChange?.(next); } };
}

/** 扩展同盟人数 and its seat count. The pool layout cannot outlive a seat count: a new one starts from the automatic rule. */
export function capacityRows({ value, mode = 'coop', source = 'private', seats = [], ...rest }) {
  const { options, locked, send } = optionsEditor({ value, ...rest });
  const capacity = roomCapacity(mode, options);
  const setCapacity = next => {
    if (locked || mode !== 'coop' || source === 'matchmaking' || !isPlayerCapacity(next)) return;
    const { playerCapacity, poolPlan, disableDuckLord, ...rules } = options;
    send({ ...rules, ...(next === MAX_SEATS ? {} : { playerCapacity: next, ...(disableDuckLord ? { disableDuckLord } : {}) }),
      ...(poolPlan ? { poolPlan: autoPoolPlan(next, { seats }) } : {}) });
  };
  if (mode !== 'coop' || source === 'matchmaking') return null;
  return [
    switchRow({ id: 'experimental-multiplayer', title: t('扩展同盟人数'), note: t('可直接开局，或整队匹配相同人数模式的房间。所有成员需更新页面，人数较多时等待与演算时间可能增加。'),
      checked: capacity > MAX_SEATS, disabled: locked, onChange: on => setCapacity(on ? 8 : MAX_SEATS) }),
    capacity > MAX_SEATS ? html`<label class="experimental-capacity" for="experimental-capacity">
      <span>${t('同盟人数模式')}</span>
      <select id="experimental-capacity" value=${capacity} disabled=${locked} onChange=${e => setCapacity(Number(e.currentTarget.value))}>
        ${PLAYER_CAPACITIES.map(n => html`<option key=${n} value=${n}>${t('{n} 人', { n })}</option>`)}
      </select>
    </label>` : null,
  ];
}

/** 禁用鸭爵策略: expanded co-op rooms only. */
export function duckLordRow({ value, mode = 'coop', ...rest }) {
  const { options, locked, send } = optionsEditor({ value, ...rest });
  if (mode !== 'coop' || roomCapacity(mode, options) <= MAX_SEATS) return null;
  return switchRow({ id: 'experimental-ducklord', title: t('禁用鸭爵策略'), note: t('勾选后，本局无法选择鸭爵策略；不影响其他策略。'), checked: options.disableDuckLord === true,
    disabled: locked, onChange: on => send({ ...options, disableDuckLord: on }) });
}

/**
 * 联动干员 (shared/experimental.js isCollabRoom): a private room only. Off → on asks the host to confirm the copyright
 * warning first (ui/collab.js, a 5 s hold): the switch stays off until then, and on a cancel; on → off at once.
 */
export function collabRow({ value, source = 'private', ...rest }) {
  const { options, locked, send } = optionsEditor({ value, ...rest });
  if (source !== 'private') return null;
  const on = options.collabOps === true;
  return switchRow({ id: 'experimental-collab', testid: 'experimental-collab', title: t('联动干员'), checked: on, disabled: locked,
    note: t('开启后，本房间所有博士可在自选编队中选用联动干员。开启前需确认版权风险提示。'),
    onChange: (next, e) => {
      if (!next) { const { collabOps, ...rules } = options; send(rules); return; }
      if (e?.currentTarget) e.currentTarget.checked = on; // off until the warning is confirmed
      confirmCollab().then((ok) => { if (ok) send({ ...options, collabOps: true }); });
    } });
}

/** The battle rules: 规则 in a co-op room, the single page of a solo room (no teammate to rescue there). */
export function ruleRows({ value, mode = 'coop', source = 'private', ...rest }) {
  const { options, locked, send } = optionsEditor({ value, ...rest });
  const setEnemyMul = (field, next) => {
    if (!isEnemyMultiplier(next)) return;
    const { [field]: previous, ...rules } = options;
    send(next === 1 ? rules : { ...rules, [field]: next });
  };
  const multiplier = (field, id, title, note) => html`<label class="experimental-option" for=${id}>
    <span><strong>${title}</strong><small>${note}</small></span>
    <select id=${id} value=${enemyMul(options[field])} disabled=${locked} onChange=${e => setEnemyMul(field, Number(e.currentTarget.value))}>
      ${ENEMY_MULTIPLIERS.map(n => html`<option key=${n} value=${n}>×${n}</option>`)}
    </select>
  </label>`;
  return [
    mode === 'solo' ? null : switchRow({ id: 'experimental-revival', title: t('队友复活'), note: t('符合救援条件的队友可支付 10 生命抵消死亡，每人每局一次。'), checked: options.revivalEnabled,
      disabled: locked, onChange: on => send({ ...options, revivalEnabled: on }) }),
    switchRow({ id: 'experimental-layer-cap', title: t('禁用层数上限'), note: t('盟约层数不再停在 999 层。'), checked: options.disableLayerCap === true,
      disabled: locked, onChange: on => send({ ...options, disableLayerCap: on }) }),
    switchRow({ id: 'experimental-hit-limit', title: t('禁用单次伤害上限'), note: t('对敌方领袖的单次伤害达到 30 万及以上时不再被取消。'), checked: options.disableHitLimit === true,
      disabled: locked, onChange: on => send({ ...options, disableHitLimit: on }) }),
    multiplier('enemyHpMul', 'experimental-enemy-hp', t('敌人生命倍率'), t('全部敌人的生命上限，包含敌方领袖的共享生命值。')),
    multiplier('enemyAtkMul', 'experimental-enemy-atk', t('敌人攻击倍率'), t('全部敌人的攻击力，包含敌方领袖。')),
    collabRow({ value, source, ...rest }),
  ];
}

/** 禁用共享卡池 and 手动指定卡池编组. The plan names every seat's pool, so it stands in for the first; it starts from the automatic rule. */
export function poolRows({ value, seats = [], ...rest }) {
  const { options, locked, send } = optionsEditor({ value, ...rest });
  const manual = !!options.poolPlan;
  const setManual = on => {
    const { poolPlan, ...rules } = options;
    send(on ? { ...rules, disableSharedPool: false, poolPlan: autoPoolPlan(roomCapacity('coop', options), { seats, independent: options.disableSharedPool }) } : rules);
  };
  return [
    switchRow({ id: 'experimental-pool', title: t('禁用共享卡池'), note: manual ? t('已由手动编组决定。') : t('每位博士使用独立卡池，不再争用同一干员库存。'), checked: options.disableSharedPool,
      disabled: locked || manual, onChange: on => send({ ...options, disableSharedPool: on }) }),
    switchRow({ id: 'experimental-pools-manual', title: t('手动指定卡池编组'), note: t('由创建者决定一共几个卡池、每个卡池包含哪些席位。'), checked: manual, disabled: locked, onChange: setManual }),
  ];
}
