// ui/receiptViews.js — what the player reads about the match receipts and the identity cookie (docs/history/0.4.0.md
// §37.276; the owner, 2026-11-20: 「精简，分段分点」 — one line per fact, details behind an ⓘ): the ⓘ itself, the 已核验
// mark of a record, the line in 设置 › 其他, the export warning and the import's switch question. The logic is in
// ui/receipts.js. Styles: the rc-* rules of css/components.css.

import { html, Icon, Tooltip, confirmDialog } from './components.js';
import { t } from '../../../shared/i18n.js';
import { useReceiptVerified } from './receipts.js';

/** ⓘ — its details on hover, focus or a tap. @param {{ text: any, id?: string }} props */
export function InfoTip({ text, id }) {
  return html`<${Tooltip} tap=${true} id=${id} placement="bottom" text=${text}>
    <button type="button" class="rc-tip" aria-label=${t('详情')} aria-describedby=${id || undefined}><${Icon} name="info" /></button>
  <//>`;
}

/** 已核验 on a record whose receipt the server confirmed (nothing while it is unasked or did not verify). @param {{ rc?: string | null }} props */
export function VerifiedMark({ rc }) {
  const ok = useReceiptVerified(rc);
  return ok === 1 ? html`<em class="st-chip is-verified" data-testid="rc-verified" title=${t('服务器核对过这局的凭证')}>${t('已核验')}</em>` : null;
}

/** 设置 › 其他: what the identity cookie is (the owner's draft, split into lines; the rest behind the ⓘ). */
export function IdentityNotice() {
  return html`<section class="set-identity" aria-labelledby="set-identity-title" data-testid="identity-notice">
    <div class="set-keys__head sw-sec__head">
      <span class="sw-sec__glyph" aria-hidden="true"><${Icon} name="shield" /></span>
      <span class="set-row__label sw-sec__name" id="set-identity-title"><i>[</i> ${t('身份')} <i>]</i></span>
    </div>
    <ul class="rc-lines">
      <li>${t('浏览器会保存一个服务器签发的随机编号（cookie），用来核对战绩凭证。')}<${InfoTip} id="identity-tip"
        text=${t('导出战绩时会一并导出，导入时可以换成文件里的身份。')} /></li>
      <li>${t('不收集设备信息，服务器不保存你的战绩。')}</li>
    </ul>
  </section>`;
}

/** The export warning (the file carries the identity). @returns {Promise<boolean>} */
export const confirmExport = (dialog = confirmDialog) => dialog({
  title: t('导出战绩'), micro: 'EXPORT', okText: t('导出'),
  text: html`<ul class="rc-lines" data-testid="rc-export-warning">
    <li>${t('文件里带着你的身份。')}<${InfoTip} id="export-identity-tip" text=${t('身份是服务器签发的随机编号，用来核对战绩凭证。')} /></li>
    <li><strong>${t('不要把文件给别人：拿到的人可以换成你的身份。')}</strong></li>
  </ul>`,
});

/** The import's question: switch this browser to the file's identity? @returns {Promise<boolean>} */
export const confirmSwitch = (dialog = confirmDialog) => dialog({
  title: t('换成文件里的身份？'), micro: 'IDENTITY', okText: t('换成文件里的身份'), cancelText: t('保持现在的身份'),
  text: html`<ul class="rc-lines" data-testid="rc-switch-confirm">
    <li>${t('这份文件带着另一个身份。')}</li>
    <li>${t('换：ELO 改按文件里这个身份的对局计。')}</li>
    <li>${t('不换：记录照样导入，ELO 仍按现在的身份计。')}<${InfoTip} id="switch-identity-tip"
      text=${t('两个身份不能合并。已核验标记和规程名片奖杯两个身份都算；ELO 只算当前身份的对局。')} /></li>
  </ul>`,
});
