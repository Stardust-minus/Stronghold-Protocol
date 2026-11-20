// 同盟设置 (a solo room: 模拟设置): every option of the room in one dialog, opened from ⚙ on 同盟 and from the footer's
// 实验性功能 badge. A co-op room has two tabs: 同盟 (who plays: version, AI seats, the list) and 实验性功能, whose options
// are split by group (the owner, 2026-11-16: 「实验性功能需要拆分成多个分类，目前单个大项下的选项太多了」; shared/
// experimental.js EXPERIMENTAL_GROUPS, ui/experimental.js ExperimentalPanel): 同盟人数, 队友协作, 盟约与策略, 敌人, 卡池 (with
// the manual groups, ui/poolEditor.js) and 特殊功能 — a rail of groups, each with the count of what is on, beside the
// group's rows. A solo room has no tabs: its 不限时 on top, then its groups (no teammates, no pools). `page` is 'alliance'
// or the group shown. A tab or a group with a dot / a count differs from a new room. The host edits; everybody else
// reads the same pages. What changes goes to the server at once: nothing here waits for 完成, which only closes the dialog.

import { html, Button, Icon, Modal, Tooltip } from './components.js';
import { ExperimentalPanel, experimentalItems, experimentalOptions, optionGroups, switchRow } from './experimental.js';
import { PoolEditor } from './poolEditor.js';
import { t } from '../../../shared/i18n.js';

/** What the rows of a room's groups read (ui/experimental.js groupRows). */
const rowProps = (room, rest = {}) => ({ value: room?.experimental, mode: room?.mode, source: room?.source, seats: takenSeats(room),
  // ELO's reminder shows the host's own panel for the room (ui/eloPanel.js)
  difficulty: room?.difficulty ?? null, roomCode: room?.code ?? null, ...rest });

/** The experimental groups a room has, in order (a matchmade room: no seat count, no 特殊功能; a solo room: no teammates, no pools). */
export const roomGroups = (room) => optionGroups(rowProps(room));

/** The pages of a room's dialog, in order: 同盟 (co-op) and each experimental group. */
export const settingsPages = (room) => (room?.mode === 'solo' ? roomGroups(room) : ['alliance', ...roomGroups(room)]);

/**
 * The page a press opens: `page` when this room has it; 'experimental' (the footer's badge; 'rules' / 'sim' of older
 * callers) its first group with something on, else its first group; anything else the first page.
 */
export function settingsPage(room, page) {
  const pages = settingsPages(room);
  if (pages.includes(page)) return page;
  const groups = roomGroups(room);
  if (page === 'experimental' || page === 'rules' || page === 'sim' || page === 'pools' || room?.mode === 'solo') {
    const counts = groupCounts(room);
    return groups.find((g) => counts[g] > 0) || groups[0] || pages[0];
  }
  return pages[0];
}

/** How many options of each group are on (the rail's counts). */
export function groupCounts(room) {
  const counts = {};
  for (const x of experimentalItems(room?.experimental, { mode: room?.mode })) counts[x.group] = (counts[x.group] || 0) + 1;
  return counts;
}

/** Which pages differ from a new room's defaults: 同盟 (a dot on its tab) and each group (its count). */
export function changedPages(room) {
  const counts = groupCounts(room);
  const out = { alliance: room?.listed === true || room?.aiTakeoverEnabled === true || room?.aiPicksLast === false };
  for (const g of roomGroups(room)) out[g] = (counts[g] || 0) > 0;
  return out;
}

/** The taken seats of a room, for the automatic rule the pool layouts start from. */
export const takenSeats = (room) => (room?.seats || []).flatMap((seat, index) => (seat ? [index] : []));

function VersionRow({ version }) {
  return html`<div class="experimental-option rset__version" data-testid="room-opt-version">
    <span><strong>${t('版本')}</strong><small>${version.editable ? t('发起切换版本') : t('由创建者发起')}</small></span>
    <${Tooltip} text=${version.why}>
      <button type="button" class="rset__ver" disabled=${version.disabled} onClick=${version.onOpen}><${Icon} name="book" />${version.label}</button>
    <//>
  </div>`;
}

/**
 * @param {{ page: string|null, onPage: (page: string) => void, room: any, myId: any, editable: boolean, busy: any,
 *   version?: any, aiLast?: any, takeover?: any, listed?: any, soloOption?: any, onExperimental: Function, onAiLast: Function,
 *   onListed: Function, onAiTakeover: Function, onSoloUnlimited: Function, onClose: Function }} props
 */
export function RoomSettings({ page, onPage, room, myId, editable, busy, version = null, aiLast = null, takeover = null, listed = null, soloOption = null,
  onExperimental, onAiLast, onListed, onAiTakeover, onSoloUnlimited, onClose }) {
  if (!page) return null;
  const solo = room.mode === 'solo';
  const title = solo ? t('模拟设置') : t('同盟设置');
  const shown = settingsPage(room, page);
  const groups = roomGroups(room);
  const changed = changedPages(room);
  const counts = groupCounts(room);
  const lock = !!busy;
  const rows = rowProps(room, { editable, busy: lock, onChange: onExperimental });
  const options = experimentalOptions(room.experimental);
  const total = experimentalItems(room.experimental, { mode: room.mode }).length;
  const toggle = (option, id, label, note, onToggle, testid) => (option ? switchRow({ id, title: label, note, testid, checked: option.on, disabled: !option.editable || lock,
    onChange: (on) => { if (option.editable) onToggle(on); } }) : null);
  const onAlliance = shown === 'alliance';
  const tab = (id, label, dot, selected, go) => html`<button key=${id} type="button" role="tab" data-autofocus=${selected ? true : undefined} id=${`rset-tab-${id}`}
      aria-selected=${selected ? 'true' : 'false'} aria-controls="rset-page" class=${`rset__tab${selected ? ' is-on' : ''}`} data-testid=${`room-settings-${id}`} onClick=${go}>
    ${label}${dot}</button>`;
  // 卡池's manual groups: the editor under the group's rows
  const after = (g) => (g !== 'pools' ? null : options.poolPlan
    ? html`<${PoolEditor} plan=${options.poolPlan} seats=${room.seats} hostId=${room.hostId} myId=${myId} editable=${editable} busy=${lock}
        onPlan=${(poolPlan) => onExperimental({ ...options, poolPlan })} />`
    : html`<p class="rset__empty">${t('未开启时按开局人数自动分组。')}</p>`);
  return html`<${Modal} open=${true} title=${title} micro=${solo ? 'SIMULATION SETTINGS' : 'ALLIANCE SETTINGS'} ariaLabel=${title} trapFocus=${true} class=${`room-settings-modal${solo ? ' is-solo' : ''}`} onClose=${onClose}
      actions=${html`<p class="rset__note">${editable ? t('开局后不可更改') : t('由房间创建者设置')}</p><${Button} icon="check" onClick=${onClose}>${t('完成')}<//>`}>
    ${solo ? null : html`<div class="rset__tabs" role="tablist" aria-label=${title}>
      ${tab('alliance', t('同盟'), changed.alliance ? html`<i class="rset__dot" title=${t('已更改')}></i>` : null, onAlliance, () => onPage('alliance'))}
      ${tab('experimental', t('实验性功能'), total ? html`<span class="rset__count num" title=${t('已开启 {n} 项', { n: total })}>${total}</span>` : null, !onAlliance,
        () => onPage(settingsPage(room, 'experimental')))}
    </div>`}
    <div class=${`rset__page rset__page--${onAlliance ? 'alliance' : 'experimental'}`} id="rset-page" role=${solo ? undefined : 'tabpanel'} aria-labelledby=${solo ? undefined : `rset-tab-${onAlliance ? 'alliance' : 'experimental'}`}>
      ${onAlliance ? html`<div class="rset__rows">
        ${version ? html`<${VersionRow} version=${version} />` : null}
        ${toggle(aiLast, 'room-ai-last', t('AI 队友最后选择'), t('策略与机变轮选时，所有博士先于 AI 队友选择'), onAiLast, 'room-ai-last')}
        ${toggle(takeover, 'room-ai-takeover', t('允许观战者接替 AI'), t('默认关闭。开启后，观战者可在休整期经在座博士投票接替 AI；接替后的数据不计入个人统计或奖励。'), onAiTakeover, 'room-ai-takeover')}
        ${toggle(listed, 'room-opt-listed', t('公开到同盟列表'), t('其他博士可在「公开同盟」中看到并直接加入；满员或开局时不显示'), onListed, 'room-opt-listed')}
      </div>` : html`
        ${solo && soloOption ? html`<div class="rset__rows rset__rows--top">${toggle(soloOption, 'room-solo-unlimited', t('不限时'), t('关闭本局休整与机变的计时。官方为休整期每轮 300 秒、机变 150 秒。'), onSoloUnlimited, 'room-solo-unlimited')}</div>` : null}
        ${ExperimentalPanel({ groups, group: shown, onGroup: onPage, counts, rows, after, label: title, focus: solo })}`}
    </div>
  <//>`;
}
