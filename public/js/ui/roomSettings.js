// 同盟设置 (a solo room: 模拟设置): every option of the room in one dialog, opened from ⚙ on 同盟 and from the footer's
// 实验性选项 on 规则. Three pages: 同盟 (who plays: version, seats, AI seats, the list), 规则 (the battle), 卡池 (the card
// pools and their manual groups, ui/poolEditor.js); a solo room has its one page, without tabs. A tab with a dot differs
// from a new room. The host edits; everybody else reads the same pages. What changes goes to the server at once: nothing
// here waits for 完成, which only closes the dialog.

import { html, Button, Icon, Modal, Tooltip } from './components.js';
import { capacityRows, duckLordRow, experimentalOptions, poolRows, ruleRows, switchRow } from './experimental.js';
import { PoolEditor } from './poolEditor.js';
import { MAX_SEATS } from '../../../shared/constants.js';
import { roomCapacity } from '../../../shared/playerCapacity.js';
import { t, N_ } from '../../../shared/i18n.js';

/** The pages of a room's dialog, in order. */
export const settingsPages = (room) => (room?.mode === 'solo' ? ['sim'] : ['alliance', 'rules', 'pools']);

/** The page a press opens: `page` when this room has it, else its first. */
export function settingsPage(room, page) {
  const pages = settingsPages(room);
  return pages.includes(page) ? page : pages[0];
}

/** Which pages differ from a new room's defaults (a dot on their tab). */
export function changedPages(room) {
  const options = experimentalOptions(room?.experimental);
  return {
    alliance: roomCapacity('coop', options) > MAX_SEATS || !!options.disableDuckLord || room?.listed === true || room?.aiTakeoverEnabled === true || room?.aiPicksLast === false,
    rules: options.revivalEnabled || !!options.disableLayerCap || !!options.disableHitLimit || !!options.enemyHpMul || !!options.enemyAtkMul,
    pools: options.disableSharedPool || !!options.poolPlan,
  };
}

/** The taken seats of a room, for the automatic rule the pool layouts start from. */
export const takenSeats = (room) => (room?.seats || []).flatMap((seat, index) => (seat ? [index] : []));

const TABS = { alliance: N_('同盟'), rules: N_('规则'), pools: N_('卡池') };

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
  const pages = settingsPages(room);
  const changed = changedPages(room);
  const lock = !!busy;
  const rows = { value: room.experimental, mode: room.mode, source: room.source, seats: takenSeats(room), editable, busy: lock, onChange: onExperimental };
  const options = experimentalOptions(room.experimental);
  const toggle = (option, id, label, note, onToggle, testid) => (option ? switchRow({ id, title: label, note, testid, checked: option.on, disabled: !option.editable || lock,
    onChange: (on) => { if (option.editable) onToggle(on); } }) : null);
  return html`<${Modal} open=${true} title=${title} micro=${solo ? 'SIMULATION SETTINGS' : 'ALLIANCE SETTINGS'} ariaLabel=${title} trapFocus=${true} class=${`room-settings-modal${solo ? ' is-solo' : ''}`} onClose=${onClose}
      actions=${html`<p class="rset__note">${editable ? t('开局后不可更改') : t('由房间创建者设置')}</p><${Button} icon="check" onClick=${onClose}>${t('完成')}<//>`}>
    ${solo ? null : html`<div class="rset__tabs" role="tablist" aria-label=${title}>
      ${pages.map((id) => html`<button key=${id} type="button" role="tab" data-autofocus=${page === id ? true : undefined} id=${`rset-tab-${id}`} aria-selected=${page === id ? 'true' : 'false'} aria-controls="rset-page"
          class=${`rset__tab${page === id ? ' is-on' : ''}`} data-testid=${`room-settings-${id}`} onClick=${() => onPage(id)}>
        ${t(TABS[id])}${changed[id] ? html`<i class="rset__dot" title=${t('已更改')}></i>` : null}</button>`)}
    </div>`}
    <div class=${`rset__page rset__page--${page}`} id="rset-page" role=${solo ? undefined : 'tabpanel'} aria-labelledby=${solo ? undefined : `rset-tab-${page}`}>
      ${page === 'sim' ? html`<div class="rset__rows">
        ${toggle(soloOption, 'room-solo-unlimited', t('不限时'), t('关闭本局休整与机变的计时。官方为休整期每轮 300 秒、机变 150 秒。'), onSoloUnlimited, 'room-solo-unlimited')}
        ${ruleRows(rows)}
      </div>` : null}
      ${page === 'alliance' ? html`<div class="rset__rows">
        ${version ? html`<${VersionRow} version=${version} />` : null}
        ${capacityRows(rows)}
        ${toggle(aiLast, 'room-ai-last', t('AI 队友最后选择'), t('策略与机变轮选时，所有博士先于 AI 队友选择'), onAiLast, 'room-ai-last')}
        ${toggle(takeover, 'room-ai-takeover', t('允许观战者接替 AI'), t('默认关闭。开启后，观战者可在休整期经在座博士投票接替 AI；接替后的数据不计入个人统计或奖励。'), onAiTakeover, 'room-ai-takeover')}
        ${toggle(listed, 'room-opt-listed', t('公开到同盟列表'), t('其他博士可在「公开同盟」中看到并直接加入；满员或开局时不显示'), onListed, 'room-opt-listed')}
        ${duckLordRow(rows)}
      </div>` : null}
      ${page === 'rules' ? html`<div class="rset__rows">${ruleRows(rows)}</div>` : null}
      ${page === 'pools' ? html`
        <div class="rset__rows">${poolRows(rows)}</div>
        ${options.poolPlan ? html`<${PoolEditor} plan=${options.poolPlan} seats=${room.seats} hostId=${room.hostId} myId=${myId} editable=${editable} busy=${lock}
          onPlan=${(poolPlan) => onExperimental({ ...options, poolPlan })} />` : html`<p class="rset__empty">${t('未开启时按开局人数自动分组。')}</p>`}` : null}
    </div>
  <//>`;
}
