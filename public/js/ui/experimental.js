import { html } from './components.js';
import { t, tc, tParts } from '../../../shared/i18n.js';
import { MAX_SEATS } from '../../../shared/constants.js';
import { PLAYER_CAPACITIES, isPlayerCapacity, roomCapacity } from '../../../shared/playerCapacity.js';
import { ENEMY_HP_PLAN_MAX, ENEMY_MULTIPLIERS, canonicalEnemyHpPlan, enemyHpMulAt, isEnemyHpPlan, isEnemyMultiplier } from '../../../shared/experimental.js';
import { autoPoolPlan, canonicalPoolPlan, isPoolPlan, poolCount } from '../../../shared/poolPlan.js';
import { confirmCollab } from './collab.js';
import { confirmConsole } from './consoleRoom.js';

/** A room's enemy multiplier as the page shows it: 1 when it has none. */
const enemyMul = value => (isEnemyMultiplier(value) ? value : 1);
/**
 * The HP rule of the page's options (shared/experimental.js hpOption): a by-round plan (feedback #118) replaces the single
 * multiplier; a plan of one multiplier throughout is that multiplier.
 */
function hpRule(input) {
  const plan = canonicalEnemyHpPlan(input?.enemyHpPlan);
  if (plan) return { enemyHpPlan: plan.map(([from, mul]) => [from, mul]) };
  const flat = isEnemyHpPlan(input?.enemyHpPlan) ? input.enemyHpPlan[0][1] : enemyMul(input?.enemyHpMul);
  return flat !== 1 ? { enemyHpMul: flat } : {};
}
/** The last round the plan editor offers (co-op's last round 14, a hidden leader's 15). */
const PLAN_ROUND_UI_MAX = 15;
/** The multiplier `steps` places above `mul` in ENEMY_MULTIPLIERS (clamped). */
const stepUp = (mul, steps) => ENEMY_MULTIPLIERS[Math.min(ENEMY_MULTIPLIERS.length - 1, Math.max(0, ENEMY_MULTIPLIERS.indexOf(enemyMul(mul)) + steps))];
/**
 * A plan's segments as text: 「1–5回合 ×1 / 6–8回合 ×1.5 / 9回合起 ×2.5」 (the player's own wording in feedback #118).
 * @param {readonly (readonly number[])[]} plan
 */
export function enemyHpPlanText(plan) {
  return plan.map(([from, mul], i) => {
    const next = plan[i + 1];
    if (!next) return t('{a}回合起 ×{m}', { a: from, m: mul });
    return next[0] - 1 === from ? t('{a}回合 ×{m}', { a: from, m: mul }) : t('{a}–{b}回合 ×{m}', { a: from, b: next[0] - 1, m: mul });
  }).join(' / ');
}

export function experimentalOptions(input) {
  const capacity = roomCapacity('coop', input);
  const plan = isPoolPlan(input?.poolPlan, capacity) ? canonicalPoolPlan(input.poolPlan) : null;
  return { revivalEnabled: input?.revivalEnabled === true, disableSharedPool: !plan && input?.disableSharedPool === true,
    ...(capacity > MAX_SEATS && input?.disableDuckLord === true ? { disableDuckLord: true } : {}),
    ...(input?.disableLayerCap === true ? { disableLayerCap: true } : {}),
    ...(input?.disableHitLimit === true ? { disableHitLimit: true } : {}),
    ...hpRule(input),
    ...(enemyMul(input?.enemyAtkMul) !== 1 ? { enemyAtkMul: input.enemyAtkMul } : {}),
    ...(capacity === MAX_SEATS ? {} : { playerCapacity: capacity }),
    ...(plan ? { poolPlan: plan } : {}),
    ...(input?.collabOps === true ? { collabOps: true } : {}),
    ...(input?.console === true ? { console: true } : {}),
    ...(input?.uniteHumansFirst === true ? { uniteHumansFirst: true } : {}) };
}

/** Whether any option differs from a standard room's (the room's 实验性选项 button is then marked). */
export function experimentalChanged(input) {
  const options = experimentalOptions(input);
  return options.revivalEnabled || options.disableSharedPool || !!options.disableDuckLord || !!options.disableLayerCap || !!options.disableHitLimit || !!options.enemyHpMul || !!options.enemyHpPlan || !!options.enemyAtkMul || !!options.playerCapacity || !!options.poolPlan || !!options.collabOps || !!options.console || !!options.uniteHumansFirst;
}

export function experimentalSummary(input) {
  const options = experimentalOptions(input);
  const summary = t('复活 {0} · 共享卡池 {1}', { 0: options.revivalEnabled ? t('开启') : tc('toggle', '关闭'), 1: options.disableSharedPool ? tc('toggle', '关闭') : t('开启') });
  const rules = [summary, options.disableDuckLord && t('禁用鸭爵策略'), options.disableLayerCap && t('禁用层数上限'), options.disableHitLimit && t('禁用单次伤害上限'),
    options.enemyHpMul && t('敌人生命 ×{n}', { n: options.enemyHpMul }), options.enemyHpPlan && t('敌人生命 {plan}', { plan: enemyHpPlanText(options.enemyHpPlan) }), options.enemyAtkMul && t('敌人攻击 ×{n}', { n: options.enemyAtkMul }),
    options.poolPlan && t('手动卡池 {n} 组', { n: poolCount(options.poolPlan) }), options.uniteHumansFirst && t('AI 联防置后'), options.collabOps && t('联动干员'), options.console && t('调控台')].filter(Boolean).join(' · ');
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

/**
 * 调控台 (shared/experimental.js isConsoleRoom): a private room only, solo or co-op. Off → on asks the host to confirm the
 * warning first (ui/consoleRoom.js, a 5 s hold), as 联动干员; on → off at once.
 */
export function consoleRow({ value, source = 'private', ...rest }) {
  const { options, locked, send } = optionsEditor({ value, ...rest });
  if (source !== 'private') return null;
  const on = options.console === true;
  return switchRow({ id: 'experimental-console', testid: 'experimental-console', title: t('调控台'), checked: on, disabled: locked,
    note: t('开启后，本房间所有博士可在对局中调用干员、装备、盟约层数与敌人。对局不计入战绩与成就。开启前需确认提示。'),
    onChange: (next, e) => {
      if (!next) { const { console: off, ...rules } = options; send(rules); return; }
      if (e?.currentTarget) e.currentTarget.checked = on; // off until the warning is confirmed
      confirmConsole().then((ok) => { if (ok) send({ ...options, console: true }); });
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
  const multiplier = (field, id, title, note, disabled = false) => html`<label class="experimental-option" for=${id}>
    <span><strong>${title}</strong><small>${note}</small></span>
    <select id=${id} value=${enemyMul(options[field])} disabled=${locked || disabled} onChange=${e => setEnemyMul(field, Number(e.currentTarget.value))}>
      ${ENEMY_MULTIPLIERS.map(n => html`<option key=${n} value=${n}>×${n}</option>`)}
    </select>
  </label>`;
  // 敌人生命倍率 by round (feedback #118): the plan replaces the single multiplier; a plan left with one segment is that one
  const plan = options.enemyHpPlan || null;
  const sendPlan = next => { const { enemyHpMul, enemyHpPlan, ...rules } = options; send({ ...rules, ...hpRule({ enemyHpPlan: next }) }); };
  const setPlan = on => {
    if (!on) { const { enemyHpPlan, ...rules } = options; send({ ...rules, ...hpRule({ enemyHpMul: plan ? plan[0][1] : options.enemyHpMul }) }); return; }
    const base = enemyMul(options.enemyHpMul); // the player's example from ×1: 1–5 ×1, 6–8 ×1.5, 9 on ×2.5
    sendPlan([[1, base], [6, stepUp(base, 2)], [9, stepUp(base, 4)]]);
  };
  const planEditor = () => {
    const segs = plan.map(([from, mul]) => [from, mul]);
    const put = (i, seg) => sendPlan(segs.map((s, j) => (j === i ? seg : s)));
    const rounds = i => { const lo = segs[i - 1][0] + 1, hi = i + 1 < segs.length ? segs[i + 1][0] - 1 : PLAN_ROUND_UI_MAX; const out = []; for (let r = lo; r <= hi; r++) out.push(r); return out; };
    const last = segs[segs.length - 1];
    return html`<div class="experimental-plan" data-testid="experimental-enemy-hp-plan">
      ${segs.map(([from, mul], i) => html`<div class="experimental-plan__row" key=${i} data-testid="experimental-enemy-hp-seg">
        ${i === 0 ? html`<span class="experimental-plan__from">${t('第 {n} 回合起', { n: 1 })}</span>`
          : html`<label class="experimental-plan__from">${tParts('第 {n} 回合起', { n: html`<select aria-label=${t('起始回合')} data-testid="experimental-enemy-hp-from" value=${from} disabled=${locked}
              onChange=${e => put(i, [Number(e.currentTarget.value), mul])}>${rounds(i).map(r => html`<option key=${r} value=${r}>${r}</option>`)}</select>` })}</label>`}
        <select aria-label=${t('敌人生命倍率')} data-testid="experimental-enemy-hp-mul" value=${mul} disabled=${locked} onChange=${e => put(i, [from, Number(e.currentTarget.value)])}>
          ${ENEMY_MULTIPLIERS.map(n => html`<option key=${n} value=${n}>×${n}</option>`)}
        </select>
        ${i === 0 ? html`<span class="experimental-plan__gap"></span>` : html`<button type="button" class="experimental-plan__del" data-testid="experimental-enemy-hp-del" disabled=${locked}
          title=${t('删除此阶段')} aria-label=${t('删除此阶段')} onClick=${() => sendPlan(segs.filter((_, j) => j !== i))}>×</button>`}
      </div>`)}
      ${segs.length < ENEMY_HP_PLAN_MAX && last[0] < PLAN_ROUND_UI_MAX ? html`<button type="button" class="experimental-plan__add" data-testid="experimental-enemy-hp-add" disabled=${locked}
        onClick=${() => sendPlan([...segs, [last[0] + 1, stepUp(last[1], 1)]])}>${t('添加阶段')}</button>` : null}
    </div>`;
  };
  return [
    mode === 'solo' ? null : switchRow({ id: 'experimental-revival', title: t('队友复活'), note: t('队友生命耗尽时，任意存活队友可支付 10 生命抵消这次死亡（自己至少要有 11 生命），每人每局最多被救一次。'), checked: options.revivalEnabled,
      disabled: locked, onChange: on => send({ ...options, revivalEnabled: on }) }),
    switchRow({ id: 'experimental-layer-cap', title: t('禁用层数上限'), note: t('盟约层数不再停在 999 层。'), checked: options.disableLayerCap === true,
      disabled: locked, onChange: on => send({ ...options, disableLayerCap: on }) }),
    switchRow({ id: 'experimental-hit-limit', title: t('禁用单次伤害上限'), note: t('对敌方领袖的单次伤害达到 30 万及以上时不再被取消。'), checked: options.disableHitLimit === true,
      disabled: locked, onChange: on => send({ ...options, disableHitLimit: on }) }),
    multiplier('enemyHpMul', 'experimental-enemy-hp', t('敌人生命倍率'), t('全部敌人的生命上限，包含敌方领袖的共享生命值。'), !!plan),
    switchRow({ id: 'experimental-enemy-hp-plan', title: t('按回合设置敌人生命倍率'), note: t('从指定回合起改用新的倍率，前期不加血、后期再加，难度循序渐进。'), checked: !!plan,
      disabled: locked, onChange: setPlan, testid: 'experimental-enemy-hp-plan-switch' }),
    plan ? planEditor() : null,
    multiplier('enemyAtkMul', 'experimental-enemy-atk', t('敌人攻击倍率'), t('全部敌人的攻击力，包含敌方领袖。')),
    mode === 'solo' ? null : switchRow({ id: 'experimental-unite-humans', title: t('AI 联防置后'), note: t('联防先按原有排序从真人博士中挑选，AI 队友和 AI 托管中的博士排在所有真人之后。'),
      checked: options.uniteHumansFirst === true, disabled: locked, onChange: on => send({ ...options, uniteHumansFirst: on }) }),
    collabRow({ value, source, ...rest }),
    consoleRow({ value, source, ...rest }),
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

/**
 * The enemy multipliers of the match's round, for the enemy detail's preview (screens/game.js): a by-round plan's segment
 * of `round` (feedback #118), else the room's single ones; null when none.
 * @param {any} experimental the match's options (m.public experimental) @param {number} round
 */
export function roundEnemyMul(experimental, round) {
  if (!experimental) return null;
  const hp = enemyHpMulAt(experimental, round), atk = enemyMul(experimental.enemyAtkMul);
  return hp === 1 && atk === 1 ? null : { ...(hp !== 1 ? { enemyHpMul: hp } : {}), ...(atk !== 1 ? { enemyAtkMul: atk } : {}) };
}
