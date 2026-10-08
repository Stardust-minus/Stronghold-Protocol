import { html, Button } from './components.js';
import { copyText } from './clipboard.js';
import { toast } from './toasts.js';
import { t } from '../../../shared/i18n.js';

export const FEEDBACK_GROUP = '815818430';

export async function copyFeedbackGroup(copy = copyText, notify = toast) {
  let copied = false;
  try { copied = await copy(FEEDBACK_GROUP); } catch { /* manual copy remains available */ }
  notify(copied ? t('已复制反馈群号 {group}', { group: FEEDBACK_GROUP }) : t('复制失败，请手动复制'), copied ? 'success' : 'warn');
  return copied;
}

export function LobbyFeedback() {
  return html`<${Button} class="lobby-feedback num selectable" variant="secondary" size="sm" icon="copy"
    title=${t('反馈 QQ 群：{group}，点击复制群号', { group: FEEDBACK_GROUP })}
    aria-label=${t('反馈 QQ 群：{group}，点击复制群号', { group: FEEDBACK_GROUP })}
    onClick=${() => copyFeedbackGroup()}>${FEEDBACK_GROUP}<//>`;
}
