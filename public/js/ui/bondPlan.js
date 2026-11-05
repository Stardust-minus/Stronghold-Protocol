// 预选盟约 (bond plan): a player names the 盟约 they mean to build (g.bondPlan) — one 主盟约 among the core faction bonds
// and up to BOND_PLAN_SUB_MAX 副盟约 among every bond with a visible member, core or add-on (the owner, 2026-11-05:
// 「允许预选副盟约」「盟约预选支持多选」, 主 1 个 + 副多选). Every player and spectator sees it: the draft order rows
// (screens/bandDraft.js) and the team panel (ui/teamPanel.js) read m.public players[].bondPlan / bondPlanSub
// (BondPlanTags: the main glyph first, ringed, then the secondary ones). Information only: it changes nothing in the match.
// It can change from 确认本局信息 until the match ends while the player is alive (「预选的盟约在局内可以二次更改」): the draft
// screen's 预选盟约 button and, in the match, the viewer's own plan in the team panel open the picker (BondPlanDialog);
// a change after the strategy draft is told to everyone (m.notice bondPlan → planNoticeText, a toast in main.js) — the
// server lets one through every BOND_PLAN_COOLDOWN_MS.
// The picker (BondPlanPicker) keeps a local selection — 主盟约 (tap again to drop it), 副盟约 (toggles, at most
// BOND_PLAN_SUB_MAX; the main one is greyed there) — that 确定 sends as one intent; 清空选择 empties it. Its cards mark
// 盟约禁用 (「在预选的时候标注本局禁用的盟约」; 本局禁用 until the owner's 「不应该显示本局禁用，可能导致歧义」) on the mode's static inactive bonds (不会激活) and on the match's drawn set
// D (N 名干员无法出现 — the briefing's grey discs, gameLogic disabledBondSets; planOffMarks), and list the other doctors
// who planned that bond. The shop (ui/shopBar.js ChessCard `plan`, shopPlanMarks / cardPlanMarks) lights the operators of
// my main bond strongly and of my secondary ones lightly, and shows the avatars of the alive teammates drawing from my
// chess pool whose plan has one of the card's bonds.
// Texts go through t() (docs/I18N.md).

import { useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon, Modal } from './components.js';
import { BondGlyph } from './gameComponents.js';
import { PHASE, BOND_PLAN_SUB_MAX } from '../../../shared/constants.js';
import { disabledBondSets, bannedPerBond, briefingBondTip } from './gameLogic.js';
import { act } from './gameActions.js';
import { data } from '../data.js';
import { t } from '../../../shared/i18n.js';

const cx = (...a) => a.flat().filter(Boolean).join(' ');

/** How many 副盟约 a plan may name (shared/constants.js BOND_PLAN_SUB_MAX). */
export const PLAN_SUB_MAX = BOND_PLAN_SUB_MAX;

/**
 * The bonds a 主盟约 may be: every core faction bond (bonds.json isCore) in data order, in every mode — the server's
 * GameData.plannableBondIds().
 * @param {any[]} bonds gd.list('bonds')
 * @returns {any[]}
 */
export function plannableBonds(bonds) {
  return (Array.isArray(bonds) ? bonds : []).filter((b) => b && b.isCore === true);
}

/**
 * The bonds a 副盟约 may be: every bond with a visible member, core or add-on, in data order (all but 绝技) — the server's
 * GameData.subPlannableBondIds().
 * @param {any[]} bonds gd.list('bonds')
 * @returns {any[]}
 */
export function subPlannableBonds(bonds) {
  return (Array.isArray(bonds) ? bonds : []).filter((b) => b && Array.isArray(b.visibleMembers) && b.visibleMembers.length > 0);
}

const CLOSED = new Set([PHASE.LOBBY, PHASE.RESULT]);

/**
 * Whether the plan can still change: from 确认本局信息 until the match ends (the server's Match.bondPlanOpen; an
 * eliminated player cannot either — the callers check that).
 * @param {any} pub m.public
 */
export function bondPlanOpen(pub) {
  return !!pub && typeof pub.phase === 'string' && !CLOSED.has(pub.phase);
}

/**
 * A player's plan from its m.public entry: the main bond (or null) and the secondary ones (never the main one).
 * @param {any} p m.public players[] entry
 * @returns {{ main: string|null, sub: string[] }}
 */
export function playerPlan(p) {
  const main = typeof p?.bondPlan === 'string' && p.bondPlan ? p.bondPlan : null;
  const sub = (Array.isArray(p?.bondPlanSub) ? p.bondPlanSub : []).filter((id, i, a) => typeof id === 'string' && id && id !== main && a.indexOf(id) === i);
  return { main, sub };
}

/** Every bond of a player's plan, the main one first. @param {any} p @returns {string[]} */
export function planIds(p) {
  const { main, sub } = playerPlan(p);
  return main ? [main, ...sub] : sub;
}

/** A bond's name in the current language (its id when the data does not know it). */
const bondName = (id) => data.lookup('bonds', id)?.name || id;

/**
 * A plan in one line: 「主 炎 · 副 精准、迅捷」 ('' for an empty plan).
 * @param {{ main: string|null, sub: string[] }} plan @param {(id: string) => string} [nameOf]
 */
export function planLine(plan, nameOf = bondName) {
  const parts = [];
  if (plan?.main) parts.push(t('主 {name}', { name: nameOf(plan.main) }));
  if (plan?.sub?.length) parts.push(t('副 {names}', { names: plan.sub.map(nameOf) }));
  return parts.join(' · ');
}

/**
 * The toast of a plan changed after the strategy draft (m.notice { kind: 'bondPlan', name, bondId, subIds }).
 * @param {any} msg @param {(id: string) => string} [nameOf]
 */
export function planNoticeText(msg, nameOf = bondName) {
  const name = typeof msg?.name === 'string' && msg.name ? msg.name : t('博士');
  const line = planLine(playerPlan({ bondPlan: msg?.bondId, bondPlanSub: msg?.subIds }), nameOf);
  return line ? t('{name} 更改了预选盟约：{plan}', { name, plan: line }) : t('{name} 清空了预选盟约', { name });
}

/**
 * Other players' plans: bondId → their names (never the viewer), main and secondary alike.
 * @param {any[]} players m.public players
 * @param {string|null} myId
 * @returns {Map<string, string[]>}
 */
export function bondPlanHolders(players, myId) {
  const out = new Map();
  for (const p of Array.isArray(players) ? players : []) {
    if (!p || p.playerId === myId) continue;
    for (const id of planIds(p)) {
      if (!out.has(id)) out.set(id, []);
      out.get(id).push(p.name || t('博士'));
    }
  }
  return out;
}

/**
 * The picker's 本局禁用 marks: bondId → { state, banned } — 'off' = the mode never activates it (标准模拟's 10), 'drawn'
 * = the match's drawn set D (its single-bond operators leave the pool; `banned` of its members cannot appear).
 * @param {any} pub m.public (drawnDisabledBonds, bannedChess) @param {any} mode config.json modes[modeId], or null
 * @param {any[]} bonds bonds.json records
 * @returns {Map<string, { state: 'off'|'drawn', banned: number }>}
 */
export function planOffMarks(pub, mode, bonds) {
  const sets = disabledBondSets(pub, Array.isArray(mode?.inactiveBondIds) ? mode.inactiveBondIds : []);
  const per = bannedPerBond(bonds, pub?.bannedChess);
  const out = new Map();
  for (const id of sets.off) out.set(id, { state: 'off', banned: per.get(id) || 0 });
  for (const id of sets.drawn) out.set(id, { state: 'drawn', banned: per.get(id) || 0 });
  return out;
}

/**
 * The teammates who draw from my chess pool: m.public poolGroups when published (an experimental / expanded room), none
 * when the room has no shared pool (experimental.disableSharedPool), else null — every teammate (an ordinary match
 * has one pool).
 * @param {any} pub @param {string|null} myId
 * @returns {Set<string>|null}
 */
export function poolMateIds(pub, myId) {
  if (pub?.experimental?.disableSharedPool === true) return new Set();
  const groups = Array.isArray(pub?.poolGroups) ? pub.poolGroups : [];
  const mine = groups.find((g) => Array.isArray(g?.playerIds) && g.playerIds.includes(myId));
  return mine ? new Set(mine.playerIds.filter((id) => id !== myId)) : null;
}

/**
 * What the shop marks: my main bond, my secondary ones, and the plans of the alive teammates in my chess pool
 * (bondId → their m.public entries). null when there is nothing to mark. `opts` are the two switches of 设置 (rel35,
 * feedback #152 「可以自由设置开关吗」): `mine` false leaves my plan out, `mates` false the teammates'.
 * @param {any} pub @param {string|null} myId @param {{ mine?: boolean, mates?: boolean }} [opts]
 * @returns {{ main: string|null, sub: Set<string>, mates: Map<string, any[]> } | null}
 */
export function shopPlanMarks(pub, myId, { mine: showMine = true, mates: showMates = true } = {}) {
  const players = Array.isArray(pub?.players) ? pub.players : [];
  const mine = showMine ? playerPlan(players.find((p) => p?.playerId === myId)) : { main: null, sub: [] };
  const pool = poolMateIds(pub, myId);
  const mates = new Map();
  for (const p of showMates ? players : []) {
    if (!p || p.playerId === myId || p.isBot || p.alive === false || (pool && !pool.has(p.playerId))) continue;
    for (const id of planIds(p)) {
      if (!mates.has(id)) mates.set(id, []);
      mates.get(id).push(p);
    }
  }
  if (!mine.main && !mine.sub.length && !mates.size) return null;
  return { main: mine.main, sub: new Set(mine.sub), mates };
}

/**
 * One operator card's marks: 'main' when its bonds hold my main bond, else 'sub' for a secondary one, else null; per
 * bond chip `of(bondId)` 'main' / 'sub' / null; the card's bonds a pool teammate planned (`mates` — which teammate does
 * not matter, the owner on feedback #152: 「不需要指出具体玩家」).
 * @param {string[]} bonds the card's bonds @param {ReturnType<typeof shopPlanMarks>} plan
 * @returns {{ level: 'main'|'sub'|null, of: (bondId: string) => 'main'|'sub'|null, mates: Set<string> } | null}
 */
export function cardPlanMarks(bonds, plan) {
  if (!plan || !Array.isArray(bonds) || !bonds.length) return null;
  const of = (b) => (plan.main && b === plan.main ? 'main' : plan.sub.has(b) ? 'sub' : null);
  const mine = bonds.map(of);
  const level = mine.includes('main') ? 'main' : mine.includes('sub') ? 'sub' : null;
  const mates = new Set(bonds.filter((b) => plan.mates.get(b)?.length));
  return level || mates.size ? { level, of, mates } : null;
}

/**
 * A player's plan: the main bond's icon (ringed) and its name unless `compact`, then the secondary icons; nothing for
 * an empty plan.
 */
export function BondPlanTags({ player, gd = null, compact = false, class: cls }) {
  const plan = playerPlan(player);
  if (!plan.main && !plan.sub.length) return null;
  const nameOf = (id) => (gd ? gd.bond?.(id) : data.lookup('bonds', id))?.name || id;
  return html`<span class=${cx('bplan', compact && 'bplan--compact', cls)} title=${t('预选盟约：{name}', { name: planLine(plan, nameOf) })}>
    ${plan.main ? html`<span class="bplan__main"><${BondGlyph} bondId=${plan.main} class="bplan__glyph" />${compact ? null : html`<span class="bplan__name">${nameOf(plan.main)}</span>`}</span>` : null}
    ${plan.sub.map((id) => html`<${BondGlyph} key=${id} bondId=${id} class="bplan__glyph bplan__sub" />`)}
  </span>`;
}

/** One bond of the picker. */
function PlanCard({ b, on, mainMark = false, dim = false, mark, who, busy, small = false, onClick }) {
  const why = !mark ? null : mark.state === 'off' ? t('不会激活') : mark.banned ? t('{n} 名干员无法出现', { n: mark.banned }) : null;
  return html`<button key=${b.bondId} type="button" role="option" aria-selected=${on ? 'true' : 'false'} data-bond=${b.bondId}
      class=${cx('bplan-card', small && 'bplan-card--sm', on && 'is-sel', mark && 'is-off', dim && 'is-dim', mainMark && 'is-main')}
      title=${mark ? briefingBondTip(b.name, mark.state, mark.banned) : b.name} disabled=${busy} aria-disabled=${dim ? 'true' : undefined} onClick=${onClick}>
    <${BondGlyph} bondId=${b.bondId} class="bplan-card__glyph" />
    <span class="bplan-card__text">
      <span class="bplan-card__name">${b.name}</span>
      ${mainMark ? html`<span class="bplan-card__role">${t('主盟约')}</span>` : null}
      ${mark ? html`<span class="bplan-card__off">${t('盟约禁用')}${why ? html`<small>${why}</small>` : null}</span>` : null}
      ${who.length ? html`<span class="bplan-card__who" title=${who.join('、')}><${Icon} name="user" />${who.join('、')}</span>` : null}
    </span>
    ${on ? html`<span class="bplan-card__mine"><${Icon} name=${small ? 'check' : 'crown'} /></span>` : null}
  </button>`;
}

/**
 * The picker: 主盟约 (the core bonds, one) and 副盟约 (every bond with a member, up to PLAN_SUB_MAX, the main one greyed),
 * each card with its 本局禁用 mark and the other doctors who planned it. A local selection, from `value`; 确定 calls
 * `onConfirm` with it, 清空选择 empties it. Mounted only while open (a reopened picker starts from the current plan).
 * @param {{ open: boolean, onClose: Function, bonds: any[], value: { main: string|null, sub: string[] },
 *   holders: Map<string, string[]>, marks: Map<string, { state: string, banned: number }>, busy: boolean,
 *   onConfirm: (plan: { main: string|null, sub: string[] }) => void }} props
 */
export function BondPlanPicker({ open, onClose, bonds, value, holders, marks, busy, onConfirm }) {
  const [main, setMain] = useState(value.main);
  const [sub, setSub] = useState(() => value.sub.filter((id) => id !== value.main).slice(0, PLAN_SUB_MAX));
  const full = sub.length >= PLAN_SUB_MAX;
  const dirty = main !== value.main || sub.join() !== value.sub.join();
  const pickMain = (id) => {
    setMain((m) => (m === id ? null : id));
    setSub((s) => s.filter((x) => x !== id));
  };
  const toggleSub = (id) => {
    if (id === main) return;
    setSub((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= PLAN_SUB_MAX ? s : [...s, id]));
  };
  return html`<${Modal} open=${open} onClose=${onClose} title=${t('预选盟约')} micro="BOND PLAN" class="bplan-dlg"
    actions=${html`
      <${Button} variant="ghost" icon="close" data-testid="bond-plan-clear" disabled=${busy || (!main && !sub.length)} onClick=${() => { setMain(null); setSub([]); }}>${t('清空选择')}<//>
      <${Button} variant="secondary" onClick=${onClose}>${t('取消')}<//>
      <${Button} variant="primary" icon="check" data-testid="bond-plan-ok" data-autofocus disabled=${busy || !dirty} loading=${busy}
        onClick=${() => onConfirm({ main, sub })}>${t('确认')}<//>`}>
    <p class="bplan-dlg__tip t-dim">${t('主盟约选 1 个核心盟约，副盟约可多选（最多 {n} 个）。所有博士都能看到，对局中也可以修改，只作沟通，不影响对局。', { n: PLAN_SUB_MAX })}</p>
    <section class="bplan-sec">
      <h4 class="bplan-sec__h"><span>${t('主盟约')}</span><small>${t('核心盟约 · 选择 1 个')}</small></h4>
      <div class="bplan-dlg__grid" role="listbox" aria-label=${t('主盟约')} data-testid="bond-plan-main">${plannableBonds(bonds).map((b) => html`<${PlanCard} key=${b.bondId}
        b=${b} on=${main === b.bondId} mark=${marks.get(b.bondId)} who=${holders.get(b.bondId) || []} busy=${busy} onClick=${() => pickMain(b.bondId)} />`)}</div>
    </section>
    <section class="bplan-sec">
      <h4 class="bplan-sec__h"><span>${t('副盟约')}</span><small class=${cx(full && 't-orange')}>${t('可多选 · {n}/{max}', { n: sub.length, max: PLAN_SUB_MAX })}</small></h4>
      <div class="bplan-dlg__grid bplan-dlg__grid--sub" role="listbox" aria-multiselectable="true" aria-label=${t('副盟约')} data-testid="bond-plan-sub">${subPlannableBonds(bonds).map((b) => {
        const on = sub.includes(b.bondId);
        const isMain = main === b.bondId;
        return html`<${PlanCard} key=${b.bondId} b=${b} small=${true} on=${on} mainMark=${isMain} dim=${isMain || (full && !on)}
          mark=${marks.get(b.bondId)} who=${holders.get(b.bondId) || []} busy=${busy} onClick=${() => toggleSub(b.bondId)} />`;
      })}</div>
    </section>
  <//>`;
}

/**
 * The picker over a match: its bonds, the viewer's plan, the others' plans and this match's 本局禁用 marks from m.public;
 * 确定 sends g.bondPlan { bondId, subIds } and closes once accepted. Nothing while closed.
 * @param {{ open: boolean, onClose: () => void, pub: any, myId: string|null, gd: any }} props gd: ui/gameComponents.js useGameData()
 */
export function BondPlanDialog({ open, onClose, pub, myId, gd }) {
  const [busy, setBusy] = useState(false);
  if (!open) return null;
  const bonds = gd?.list ? gd.list('bonds') : [];
  const mode = gd?.config?.modes?.[pub?.modeId] || null;
  const players = Array.isArray(pub?.players) ? pub.players : [];
  const value = playerPlan(players.find((p) => p?.playerId === myId));
  const confirm = async (plan) => {
    if (busy) return;
    setBusy(true);
    const ok = await act('g.bondPlan', { bondId: plan.main, subIds: plan.sub }, { sfx: 'confirm' });
    setBusy(false);
    if (ok) onClose();
  };
  return html`<${BondPlanPicker} open=${true} onClose=${onClose} bonds=${bonds} value=${value}
    holders=${bondPlanHolders(players, myId)} marks=${planOffMarks(pub, mode, bonds)} busy=${busy} onConfirm=${confirm} />`;
}
