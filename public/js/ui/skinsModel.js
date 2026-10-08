// Display-only operator choices, persisted separately from skill/module and DIY gameplay configuration.
import { cleanSkinChoices, skinFor } from '../../../shared/skins.js';
import { N_ } from '../../../shared/i18n.js';
export const SKINS_PREF = 'skins';
export const SKINS_VERSION = 1;
export const SKINS_IMPORT_MAX_BYTES = 256 * 1024;
export const SKINS_EXPORT_KIND = 'stronghold.skins';
export const parseStoredSkins = raw => cleanSkinChoices(raw?.v === SKINS_VERSION ? raw.choices : null);
export const toStoredSkins = choices => ({ v: SKINS_VERSION, choices: cleanSkinChoices(choices) });
export function setSkinChoice(choices, charId, skinId) {
  if (skinId != null && !skinFor(charId, skinId)) return choices;
  const next = cleanSkinChoices(choices);
  delete next[charId];
  if (skinId != null) next[charId] = skinId;
  return next;
}
export function serializeSkins(choices) {
  return JSON.stringify({ kind: SKINS_EXPORT_KIND, ...toStoredSkins(choices) }, null, 2);
}
export function parseSkinImport(input) {
  let raw = input;
  if (typeof raw === 'string') {
    if (raw.length > SKINS_IMPORT_MAX_BYTES) return { ok: false, error: N_('内容过长，无法导入') };
    try { raw = JSON.parse(raw); } catch { return { ok: false, error: N_('无法识别的内容') }; }
  }
  if (!raw || raw.kind !== SKINS_EXPORT_KIND || raw.v !== SKINS_VERSION || !raw.choices || typeof raw.choices !== 'object' || Array.isArray(raw.choices)) {
    return { ok: false, error: N_('这不是当前版本的干员外观配置') };
  }
  const choices = cleanSkinChoices(raw.choices);
  const asked = Object.keys(raw.choices).length, kept = Object.keys(choices).length;
  if (asked && !kept) return { ok: false, error: N_('这份配置没有当前版本可用的时装，未做任何改动') };
  return { ok: true, choices, dropped: asked - kept };
}
