// Local listening preference, shared by roster and DIY details; deliberately absent from room.loadout.
import { html } from './components.js';
import { useSettings, updateSettings } from './settings.js';
import { t } from '../../../shared/i18n.js';

const VOICE_LANG_NAMES = { cn: '中文', jp: '日本語', en: 'English' }; // i18n-ignore

export function OperatorVoice({ charId }) {
  const settings = useSettings();
  if (!charId) return null;
  const value = settings.voiceOverrides[charId] || '';
  const change = (lang) => {
    const voiceOverrides = { ...settings.voiceOverrides };
    if (lang) voiceOverrides[charId] = lang;
    else delete voiceOverrides[charId];
    updateSettings({ voiceOverrides });
  };
  return html`<label class="lo-voice" data-voice-char=${charId}>
    <span>${t('此干员语音')}</span>
    <span class="lo-select"><select aria-label=${t('此干员语音')} value=${value} onChange=${(e) => change(e.currentTarget.value)}>
      <option value="">${t('跟随全局')}</option><option value="cn">${VOICE_LANG_NAMES.cn}</option><option value="jp">${VOICE_LANG_NAMES.jp}</option><option value="en">${VOICE_LANG_NAMES.en}</option>
    </select></span>
    <small>${t('部分干员暂无英语配音；所选配音缺失或无法载入时，使用中文配音。')}</small>
  </label>`;
}
