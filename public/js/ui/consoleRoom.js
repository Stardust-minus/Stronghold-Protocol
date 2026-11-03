// 调控台 (feedback #125, the owner's decisions of 2026-11-03; shared/experimental.js isConsoleRoom): the warning the host of a
// private room confirms before the switch goes on — a dialog whose confirm button stays disabled for CONSOLE_HOLD_SECONDS
// (components.js confirmDialog `hold`), as 联动干员's (ui/collab.js) — and the notice every player of such a room sees, with
// no wait. The console itself is ui/testConsole.js. Styles: the collab-* rules of css/components.css.

import { html, Icon, confirmDialog } from './components.js';
import { t } from '../../../shared/i18n.js';

/** Seconds the warning's confirm button stays disabled. */
export const CONSOLE_HOLD_SECONDS = 5;

/** The warning's body. */
export function ConsoleWarning() {
  return html`<div class="collab-warn" data-testid="console-warning">
    <p class="collab-warn__lead"><${Icon} name="warn" />${t('调控台可能破坏游戏体验')}</p>
    <p class="modal__text">${t('开启后，本房间的每位博士都可以在对局中使用调控台：调用干员、装备，修改盟约层数，为下一场作战添加敌人。')}</p>
    <p class="modal__text">${t('跳过回合、阶段与暂停计时等影响整局的指令，只有在对局中没有其他博士（其余都是 AI）时可用。')}</p>
    <p class="collab-warn__key">${t('开启调控台的对局按测试对局处理：不计入战绩、成就与对局记录，也不获得任何奖励。')}</p>
  </div>`;
}

/**
 * Ask the host to confirm the warning: resolves true only after the hold and a press on 开启.
 * @param {(opts: any) => Promise<boolean>} [dialog] the confirm dialog (tests)
 */
export function confirmConsole(dialog = confirmDialog) {
  return dialog({ title: t('开启调控台'), micro: 'CONSOLE WARNING', danger: true, hold: CONSOLE_HOLD_SECONDS, class: 'collab-dialog',
    text: html`<${ConsoleWarning} />`, okText: t('我已知悉，开启'), cancelText: t('不开启') });
}

/** The notice of a room with the 调控台 on (everybody in it; no wait). */
export function ConsoleNotice() {
  return html`<div class="collab-notice" role="note" data-testid="console-notice">
    <${Icon} name="warn" class="collab-notice__icon" />
    <span><strong>${t('本房间已开启调控台')}</strong>
      <small>${t('对局中每位博士都可以使用调控台，可能破坏正常的游戏体验；本房间的对局不计入战绩、成就与对局记录。')}</small></span>
  </div>`;
}
