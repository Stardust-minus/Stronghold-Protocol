// ui/experimental.js — a room's experimental options (实验性功能) and a 多人匹配 ticket's own: the rows that edit them, the
// texts that name them. Every option sits in one of the groups of shared/experimental.js EXPERIMENTAL_GROUPS (the owner,
// 2026-11-16: 「实验性功能需要拆分成多个分类」): groupRows builds a group's rows for a place — a private co-op room, a
// matchmade room (source 'matchmaking': no seat count, no 联动干员 / 调控台), a solo room (no teammates, no pools), a
// 多人匹配 ticket (source 'queue', ui/matchmaking.js: the rules of the game only, QUEUE_OPTION_KEYS) — and optionGroups
// the groups a place has. experimentalItems lists what is on, by group: the room's 实验性功能 badge and its 浮窗
// (ExperimentalBadge), 确认入场 (ui/matchOffer.js) and the ticket's summary all read it (ExperimentalDetails).
import { useEffect, useLayoutEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Icon, placeTooltip } from './components.js';
import { t, tc, tParts } from '../../../shared/i18n.js';
import { MAX_SEATS } from '../../../shared/constants.js';
import { PLAYER_CAPACITIES, isPlayerCapacity, roomCapacity } from '../../../shared/playerCapacity.js';
import { ENEMY_HP_PLAN_MAX, ENEMY_MULTIPLIERS, EXPERIMENTAL_GROUPS, canonicalEnemyHpPlan, enemyHpMulAt, isEnemyHpPlan, isEnemyMultiplier } from '../../../shared/experimental.js';
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

/**
 * A 多人匹配 ticket's own options as the page keeps them (queue.join `experimental`, server/matchmaking.js header): the
 * rules of the game only — no seat count, no 卡池编组, no 联动干员 / 调控台 — and 禁用鸭爵策略 as asked (it counts in a pool
 * above four seats only: shared/experimental.js queueOptionsAt).
 */
export function queueConfig(input) {
  const { playerCapacity, poolPlan, collabOps, console: off, disableDuckLord, ...rules } = experimentalOptions({ ...(input || {}), playerCapacity: undefined, poolPlan: undefined });
  return { ...rules, ...(input?.disableDuckLord === true ? { disableDuckLord: true } : {}) };
}

/**
 * What is on, by group (shared/experimental.js EXPERIMENTAL_GROUPS order): `{ group, key, text }` for each option that
 * differs from a standard room's. `mode` 'solo' leaves out the teammates' rules (a solo room has none to rescue or to
 * pair). A ticket's own options (queueConfig) read the same; their 禁用鸭爵策略 is named with its condition.
 * @param {any} input experimental options @param {{ mode?: string, queue?: boolean }} [opts]
 */
export function experimentalItems(input, { mode = 'coop', queue = false, omit = null } = {}) {
  const options = queue ? queueConfig(input) : experimentalOptions(input);
  const solo = mode === 'solo';
  const texts = {
    playerCapacity: !solo && options.playerCapacity ? t('{n} 人模式', { n: options.playerCapacity }) : null,
    revivalEnabled: !solo && options.revivalEnabled ? t('队友复活') : null,
    uniteHumansFirst: !solo && options.uniteHumansFirst ? t('AI 联防置后') : null,
    disableLayerCap: options.disableLayerCap ? t('禁用层数上限') : null,
    disableDuckLord: options.disableDuckLord ? (queue ? t('禁用鸭爵策略（多人同盟）') : t('禁用鸭爵策略')) : null,
    enemyHpMul: options.enemyHpMul ? t('敌人生命 ×{n}', { n: options.enemyHpMul }) : null,
    enemyHpPlan: options.enemyHpPlan ? t('敌人生命 {plan}', { plan: enemyHpPlanText(options.enemyHpPlan) }) : null,
    enemyAtkMul: options.enemyAtkMul ? t('敌人攻击 ×{n}', { n: options.enemyAtkMul }) : null,
    disableHitLimit: options.disableHitLimit ? t('禁用单次伤害上限') : null,
    disableSharedPool: !solo && options.disableSharedPool ? t('禁用共享卡池') : null,
    poolPlan: !solo && options.poolPlan ? t('手动卡池 {n} 组', { n: poolCount(options.poolPlan) }) : null,
    collabOps: options.collabOps ? t('联动干员') : null,
    console: options.console ? t('调控台') : null,
  };
  return EXPERIMENTAL_GROUPS.flatMap((group) => group.keys.filter((key) => texts[key] && !omit?.includes(key)).map((key) => ({ group: group.id, key, text: texts[key] })));
}

/** The items of experimentalItems, grouped: `[{ id, label, items }]`, only the groups that have some. */
export function experimentalByGroup(input, opts) {
  const items = experimentalItems(input, opts);
  return EXPERIMENTAL_GROUPS.map((group) => ({ id: group.id, label: group.label, items: items.filter((x) => x.group === group.id) })).filter((g) => g.items.length);
}

/** 「实验性功能：已开启 n 项」 / 「实验性功能：未开启」 (the room's badge, the ticket's summary). @param {number} n */
export const experimentalCountText = (n) => (n > 0 ? t('已开启 {n} 项', { n }) : t('未开启'));

/**
 * What is on, by group, as a list (the badge's 浮窗, 确认入场, the ticket's summary): one block per group with its items,
 * or `empty` (default 全部规则保持原样) when nothing is.
 * `omit`: option fields left out (确认入场 names the seat count elsewhere).
 * @param {{ value: any, mode?: string, queue?: boolean, omit?: string[]|null, empty?: any, class?: string, testid?: string }} props
 */
export function ExperimentalDetails({ value, mode = 'coop', queue = false, omit = null, empty = null, class: cls = '', testid = 'experimental-details' }) {
  const groups = experimentalByGroup(value, { mode, queue, omit });
  if (!groups.length) return html`<p class=${`expd expd--empty ${cls}`} data-testid=${testid}>${empty ?? t('全部规则保持原样')}</p>`;
  return html`<div class=${`expd ${cls}`} data-testid=${testid}>
    ${groups.map((g) => html`<section key=${g.id} class="expd__group" data-group=${g.id}>
      <h4 class="expd__k">${t(g.label)}</h4>
      <ul class="expd__list">${g.items.map((x) => html`<li key=${x.key} data-key=${x.key}>${x.text}</li>`)}</ul>
    </section>`)}
  </div>`;
}

/**
 * The room's 实验性功能 badge (screens/room.js, the owner 2026-11-16: 「默认房间内不再显示详细开启了什么实验性策略，而是只
 * 显示开启与否，具体信息鼠标放上去给一个浮窗查看，或点击查看」): 实验性功能 and 已开启 n 项 / 未开启; with a hover or the
 * keyboard's focus a 浮窗 lists them by group (ExperimentalDetails). A press opens the room's dialog on its first
 * experimental group (`onOpen`); on a touch screen the first tap opens the 浮窗 instead, which carries 查看全部设置.
 * Without `onOpen` (公开同盟's rows, ui/roomList.js: a room one is not in) a click or a tap pins the 浮窗 and the next one
 * closes it.
 * `queue`: a ticket's own options (多人匹配, ui/matchmaking.js) under `label`. `float`: the 浮窗 is placed in the viewport
 * (fixed, above the badge or below when there is no room: components.js placeTooltip), out of a scrolling list's clip.
 * `popId`: the 浮窗's id when several badges share a page (default `${testid}-pop`).
 * @param {{ value: any, mode?: string, queue?: boolean, label?: string|null, disabled?: boolean, onOpen?: () => void, testid?: string, class?: string,
 *   icon?: string, float?: boolean, popId?: string|null }} props
 */
export function ExperimentalBadge({ value, mode = 'coop', queue = false, label = null, disabled = false, onOpen = null, testid = 'room-experimental', class: cls = '',
  icon = 'edit', float = false, popId = null }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const box = useRef(null);
  const button = useRef(null);
  const pop = useRef(null);
  const n = experimentalItems(value, { mode, queue }).length;
  const name = label || t('实验性功能');
  const id = popId || `${testid}-pop`;
  useEffect(() => {
    if (!pinned) return undefined;
    const away = (e) => { if (!box.current?.contains(e.target)) { setPinned(false); setOpen(false); } };
    const esc = (e) => { if (e.key === 'Escape') { setPinned(false); setOpen(false); } };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc); };
  }, [pinned]);
  const touch = (e) => e?.pointerType === 'touch' || e?.pointerType === 'pen';
  const pointer = useRef(null);
  const press = () => {
    // a tap shows the list first (no hover on a touch screen); a click, Enter or a second tap opens the dialog — or, with
    // no dialog to open, pins the list and closes it again
    const tapped = pointer.current === 'touch';
    pointer.current = null;
    if ((tapped || !onOpen) && !pinned) { setPinned(true); setOpen(true); return; }
    setPinned(false); setOpen(false);
    onOpen?.();
  };
  const shown = open || pinned;
  // `float`: measured where the containing block puts left/top 0 (a dialog's backdrop filter or an opening dialog's
  // transform may hold the fixed box), then moved to the viewport point placeTooltip picks; again on a scroll or a resize
  useLayoutEffect(() => {
    if (!float || !shown) return undefined;
    const place = () => {
      const el = pop.current, at = button.current;
      if (!el || !at) return;
      el.style.left = '0px'; el.style.top = '0px';
      const origin = el.getBoundingClientRect(), r = at.getBoundingClientRect();
      const p = placeTooltip(r, { width: origin.width, height: origin.height }, { placement: 'top', vw: window.innerWidth, vh: window.innerHeight, m: 8 });
      el.style.left = `${Math.round(p.left - origin.left)}px`; el.style.top = `${Math.round(p.top - origin.top)}px`;
      el.dataset.place = p.place;
      el.style.setProperty('--expb-arrow', `${Math.round(Math.max(10, Math.min(origin.width - 10, r.left + r.width / 2 - p.left)))}px`);
    };
    place();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true); };
  }, [float, shown, n, value]);
  return html`<span class=${`expb${n ? ' is-on' : ''}${shown ? ' is-open' : ''}${float ? ' expb--float' : ''}${cls ? ` ${cls}` : ''}`} ref=${box}
      onPointerEnter=${(e) => { if (!touch(e)) setOpen(true); }} onPointerLeave=${(e) => { if (!touch(e) && !pinned) setOpen(false); }}>
    <button type="button" ref=${button} class=${`rs-exp${n ? ' is-on' : ''}`} data-testid=${testid} data-count=${n} disabled=${disabled}
        aria-haspopup="dialog" aria-expanded=${shown ? 'true' : 'false'} aria-describedby=${shown ? id : undefined}
        onPointerDown=${(e) => { pointer.current = touch(e) ? 'touch' : 'mouse'; }} onFocus=${(e) => { if (focusVisible(e.currentTarget)) setOpen(true); }} onBlur=${() => { if (!pinned) setOpen(false); }}
        onClick=${press}>
      <${Icon} name=${icon} /><span><b>${name}</b><small>${experimentalCountText(n)}</small></span>
    </button>
    ${shown ? html`<div class=${`expb__pop${float ? ' expb__pop--float' : ''}`} ref=${pop} role="tooltip" id=${id} data-testid=${`${testid}-pop`}>
      <header class="expb__head"><b>${name}</b><span class="num">${experimentalCountText(n)}</span></header>
      <${ExperimentalDetails} value=${value} mode=${mode} queue=${queue} empty=${queue ? t('尚未开启任何功能') : null} />
      ${pinned && onOpen && !disabled ? html`<button type="button" class="expb__more" data-testid=${`${testid}-open`} onClick=${() => { setPinned(false); setOpen(false); onOpen(); }}>
        <${Icon} name="edit" />${queue ? t('设置') : t('查看全部设置')}</button>` : null}
    </div>` : null}
  </span>`;
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

/**
 * A setter for the room's options: the whole object goes to the server, and only from a host who may change it. A
 * ticket's (source 'queue') keeps its own form (queueConfig) and goes to the page's state.
 */
function optionsEditor({ value, editable, busy, onChange, source = 'private' }) {
  const options = source === 'queue' ? queueConfig(value) : experimentalOptions(value), locked = !editable || busy;
  return { options, locked, send: next => { if (!locked) onChange?.(next); } };
}

/** 扩展同盟人数 and its seat count. The pool layout cannot outlive a seat count: a new one starts from the automatic rule. */
export function capacityRows({ value, mode = 'coop', source = 'private', seats = [], ...rest }) {
  const { options, locked, send } = optionsEditor({ value, source, ...rest });
  const capacity = roomCapacity(mode, options);
  const setCapacity = next => {
    if (locked || mode !== 'coop' || source !== 'private' || !isPlayerCapacity(next)) return;
    const { playerCapacity, poolPlan, disableDuckLord, ...rules } = options;
    send({ ...rules, ...(next === MAX_SEATS ? {} : { playerCapacity: next, ...(disableDuckLord ? { disableDuckLord } : {}) }),
      ...(poolPlan ? { poolPlan: autoPoolPlan(next, { seats }) } : {}) });
  };
  if (mode !== 'coop' || source !== 'private') return null;
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

/**
 * 禁用鸭爵策略: expanded co-op rooms only; a ticket (source 'queue') that also waits for 多人同盟 (`multi`), where it counts
 * in those sizes only.
 */
export function duckLordRow({ value, mode = 'coop', source = 'private', multi = false, ...rest }) {
  const { options, locked, send } = optionsEditor({ value, source, ...rest });
  if (mode !== 'coop' || (source === 'queue' ? !multi : roomCapacity(mode, options) <= MAX_SEATS)) return null;
  return switchRow({ id: 'experimental-ducklord', title: t('禁用鸭爵策略'), checked: options.disableDuckLord === true,
    note: source === 'queue' ? t('只在多人同盟中生效：本局无法选择鸭爵策略；不影响其他策略。') : t('勾选后，本局无法选择鸭爵策略；不影响其他策略。'),
    disabled: locked, onChange: (on) => {
      if (source !== 'queue') { send({ ...options, disableDuckLord: on }); return; }
      const { disableDuckLord, ...rules } = options;
      send(on ? { ...rules, disableDuckLord: true } : rules);
    } });
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

/** The battle rules' rows by option (ruleRows, groupRows); a solo room has no teammate to rescue or to pair. */
function ruleRowMap({ value, mode = 'coop', source = 'private', ...rest }) {
  const { options, locked, send } = optionsEditor({ value, source, ...rest });
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
  return {
    revival: mode === 'solo' ? null : switchRow({ id: 'experimental-revival', title: t('队友复活'), note: t('队友生命耗尽时，任意存活队友可支付 10 生命抵消这次死亡（自己至少要有 11 生命），每人每局最多被救一次。AI 队友会立即自动救援真人队友。'), checked: options.revivalEnabled,
      disabled: locked, onChange: on => send({ ...options, revivalEnabled: on }) }),
    layerCap: switchRow({ id: 'experimental-layer-cap', title: t('禁用层数上限'), note: t('盟约层数不再停在 999 层。'), checked: options.disableLayerCap === true,
      disabled: locked, onChange: on => send({ ...options, disableLayerCap: on }) }),
    hitLimit: switchRow({ id: 'experimental-hit-limit', title: t('禁用单次伤害上限'), note: t('对敌方领袖的单次伤害达到 30 万及以上时不再被取消。'), checked: options.disableHitLimit === true,
      disabled: locked, onChange: on => send({ ...options, disableHitLimit: on }) }),
    enemyHp: [multiplier('enemyHpMul', 'experimental-enemy-hp', t('敌人生命倍率'), t('全部敌人的生命上限，包含敌方领袖的共享生命值。'), !!plan),
      switchRow({ id: 'experimental-enemy-hp-plan', title: t('按回合设置敌人生命倍率'), note: t('从指定回合起改用新的倍率，前期不加血、后期再加，难度循序渐进。'), checked: !!plan,
      disabled: locked, onChange: setPlan, testid: 'experimental-enemy-hp-plan-switch' }),
      plan ? planEditor() : null],
    enemyAtk: multiplier('enemyAtkMul', 'experimental-enemy-atk', t('敌人攻击倍率'), t('全部敌人的攻击力，包含敌方领袖。')),
    unite: mode === 'solo' ? null : switchRow({ id: 'experimental-unite-humans', title: t('AI 联防置后'), note: t('联防先按原有排序从真人博士中挑选，AI 队友和 AI 托管中的博士排在所有真人之后。'),
      checked: options.uniteHumansFirst === true, disabled: locked, onChange: on => send({ ...options, uniteHumansFirst: on }) }),
    collab: collabRow({ value, source, ...rest }),
    console: consoleRow({ value, source, ...rest }),
  };
}

/** Every battle rule's row, in the order of the former single 规则 page (tests; the groups: groupRows). */
export function ruleRows(props) {
  const r = ruleRowMap(props);
  return [r.revival, r.layerCap, r.hitLimit, ...r.enemyHp, r.enemyAtk, r.unite, r.collab, r.console];
}

/**
 * The rows of one group (shared/experimental.js EXPERIMENTAL_GROUPS) in a place (the header): `props` as the rows' —
 * `value`, `mode`, `source` ('private' | 'matchmaking' | 'queue'), `seats`, `editable`, `busy`, `onChange`, and for a
 * ticket `multi` (it also waits for 多人同盟). Null entries are rows the place does not have.
 * @param {string} id @param {any} props
 */
export function groupRows(id, props) {
  if (id === 'seats') return capacityRows(props);
  if (id === 'pools') return props.mode === 'solo' ? null : poolRows(props);
  if (id === 'bonds') return [ruleRowMap(props).layerCap, duckLordRow(props)];
  const r = ruleRowMap(props);
  if (id === 'team') return [r.revival, r.unite];
  if (id === 'enemy') return [...r.enemyHp, r.enemyAtk, r.hitLimit];
  if (id === 'special') return [r.collab, r.console];
  return null;
}

/**
 * The groups of a place and the rows of the one shown (the room's dialog, 多人匹配's options): a rail of groups — each
 * group's name and how many of its options are on — beside the group's rows; a narrow screen turns the rail into a row of
 * chips above them (css/screens/experimental.css). `after(group)`: what follows a group's rows (the room's pool editor);
 * `focus`: the shown group's tab takes the dialog's first focus (a dialog without tabs of its own).
 * No hooks: a dialog calls it as a function, so its rows are part of the dialog's tree.
 * @param {{ groups: string[], group: string, onGroup: (id: string) => void, counts?: Record<string, number>, rows: any,
 *   after?: ((id: string) => any) | null, label?: string, focus?: boolean }} props
 */
export function ExperimentalPanel({ groups, group, onGroup, counts = {}, rows, after = null, label = '', focus = false }) {
  const shown = groups.includes(group) ? group : groups[0];
  return html`<div class="expp" data-testid="experimental-panel">
    <div class="expp__rail" role="tablist" aria-label=${label || t('实验性功能')} aria-orientation="vertical">
      ${groups.map((id) => {
        const on = id === shown, n = counts[id] || 0;
        return html`<button key=${id} type="button" role="tab" id=${`expp-tab-${id}`} aria-selected=${on ? 'true' : 'false'} aria-controls="expp-rows"
            data-autofocus=${focus && on ? true : undefined} class=${`expp__tab${on ? ' is-on' : ''}${n ? ' is-set' : ''}`} data-testid=${`exp-group-${id}`} onClick=${() => onGroup(id)}>
          <span class="expp__name">${t(GROUP_LABEL[id])}</span>${n ? html`<b class="expp__n num" title=${t('已开启 {n} 项', { n })}>${n}</b>` : null}</button>`;
      })}
    </div>
    <div class="expp__body">
      <div class="expp__rows rset__rows" id="expp-rows" role="tabpanel" aria-labelledby=${`expp-tab-${shown}`} data-group=${shown}>${shown ? groupRows(shown, rows) : null}</div>
      ${after && shown ? after(shown) : null}
    </div>
  </div>`;
}
const GROUP_LABEL = Object.fromEntries(EXPERIMENTAL_GROUPS.map((g) => [g.id, g.label]));

/** The keyboard's focus (not a click's, not a dialog handing it back): the 浮窗 opens for it. */
function focusVisible(el) {
  try { return !!el?.matches?.(':focus-visible'); } catch { return false; }
}

const present = (rows) => (Array.isArray(rows) ? rows.flat(Infinity) : [rows]).some(Boolean);
/** The groups a place has (groupRows not empty), in order. @param {any} props */
export const optionGroups = (props) => EXPERIMENTAL_GROUPS.filter((g) => present(groupRows(g.id, props))).map((g) => g.id);

/** 禁用共享卡池 and 手动指定卡池编组. The plan names every seat's pool, so it stands in for the first; it starts from the automatic rule. */
export function poolRows({ value, seats = [], ...rest }) {
  const { options, locked, send } = optionsEditor({ value, ...rest });
  const manual = !!options.poolPlan;
  const setManual = on => {
    const { poolPlan, ...rules } = options;
    send(on ? { ...rules, disableSharedPool: false, poolPlan: autoPoolPlan(roomCapacity('coop', options), { seats, independent: options.disableSharedPool }) } : rules);
  };
  if (rest.source === 'queue') {
    return [switchRow({ id: 'experimental-pool', title: t('禁用共享卡池'), note: t('每位博士使用独立卡池，不再争用同一干员库存。'), checked: options.disableSharedPool,
      disabled: locked, onChange: on => send({ ...options, disableSharedPool: on }) })];
  }
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
