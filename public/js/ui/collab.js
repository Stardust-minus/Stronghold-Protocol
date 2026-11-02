// 联动干员 (the owner's decision of 2026-11-02; shared/experimental.js isCollabRoom): the copyright warning the host of a
// private room confirms before the switch goes on — a dialog whose confirm button stays disabled for COLLAB_HOLD_SECONDS
// (components.js confirmDialog `hold`) — and the notice every player of such a room sees (the room view, the 自选 picker),
// with no wait. Styles: css/components.css (collab-*).

import { html, Icon, confirmDialog } from './components.js';
import { t } from '../../../shared/i18n.js';

/** Seconds the warning's confirm button stays disabled. */
export const COLLAB_HOLD_SECONDS = 5;

/** The warning's body. */
export function CollabWarning() {
  return html`<div class="collab-warn" data-testid="collab-warning">
    <p class="collab-warn__lead"><${Icon} name="warn" />${t('联动干员涉及版权风险')}</p>
    <p class="modal__text">${t('联动干员来自其他作品的联动，其形象、语音与模型的版权属于各自的权利方。')}</p>
    <p class="modal__text">${t('开启后，本房间所有博士都可以在自选编队中选用联动干员，房间里的页面会下载联动素材。')}</p>
    <p class="collab-warn__key">${t('启用即表示你知悉并接受相应的版权风险：版权风险由启用和使用联动干员的玩家自行承担。')}</p>
  </div>`;
}

/**
 * Ask the host to confirm the warning: resolves true only after the hold and a press on 开启.
 * @param {(opts: any) => Promise<boolean>} [dialog] the confirm dialog (tests)
 */
export function confirmCollab(dialog = confirmDialog) {
  return dialog({ title: t('开启联动干员'), micro: 'COPYRIGHT WARNING', danger: true, hold: COLLAB_HOLD_SECONDS, class: 'collab-dialog',
    text: html`<${CollabWarning} />`, okText: t('我已知悉风险，开启'), cancelText: t('不开启') });
}

/**
 * The notice of a room with 联动干员 on (everybody in it; no wait). `compact`: the one-line form of the 自选 picker.
 * @param {{ compact?: boolean }} props
 */
export function CollabNotice({ compact = false }) {
  return html`<div class=${`collab-notice${compact ? ' is-compact' : ''}`} role="note" data-testid="collab-notice">
    <${Icon} name="warn" class="collab-notice__icon" />
    <span><strong>${t('本房间已开启联动干员')}</strong>
      <small>${t('所有博士可在自选编队中选用联动干员。其素材的版权属于各自的权利方，版权风险由使用的玩家自行承担。')}</small></span>
  </div>`;
}
