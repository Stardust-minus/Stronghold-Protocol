// ui/gameLogic/settings.js — settings defaults and sanitising. Re-exported from ../gameLogic.js.

import { VOICE_LANGS, sanitizeVoiceOverrides } from '../../voicePrefs.js';
import { sanitizeBgmChoice } from '../../bgmChoice.js';
export { VOICE_LANGS } from '../../voicePrefs.js';

import { clamp, isObj } from './shared.js';
import { DEFAULT_HOTKEYS, sanitizeHotkeys } from './shortcuts.js';


// ---- settings ------------------------------------------------------------------------------------------------------

/**
 * The listener's voice preference, mirrored from the shared language control (ui/languageSettings.js): 'cn' 中文
 * (`audio.voice`, the default), 'jp' 日本語 (`audio.voiceJp`), 'en' English (`audio.voiceEn`) and 'kr' 한국어
 * (`audio.voiceKr`), each falling back to the Chinese line it lacks (public/js/audio.js voiceLine). Not tied to the
 * interface language. `voiceNative` is the 本土语言 switch: an operator who has `audio.voiceNative` speaks that dub
 * unless their own override says otherwise.
 */


/**
 * The steps of 设置 →「文字大小」 (textSize): the interface text root `--t` of css/theme.css — 'sm' is the design's own
 * sizes (`--t: 1rem`), the others lift the phone's 40 px root by a floor and grow the desktop gently. Text only: the
 * layout root `1rem` (and with it the field camera, the detail card's side and the DOM fallback board) never moves.
 */
export const TEXT_SIZES = Object.freeze(['sm', 'md', 'lg', 'xl']);

/**
 * The steps of 设置 →「界面大小」 (uiScale): css/theme.css `--ui`, the factor of the match's layout root and pixel floors
 * (the lobby and the other screens never scale). 'auto' is 80 % on a phone (UI_SCALE_PHONE; the phone query of
 * css/devices.css, ui/teamLayout.js PHONE_QUERY) and 100 % elsewhere; the others are the percentage.
 */
export const UI_SCALES = Object.freeze(['auto', '70', '80', '90', '100', '110', '120']);
export const UI_SCALE_PHONE = '80';

/**
 * The step 界面大小 shows as chosen: the stored one, or what 'auto' resolves to on this device.
 * @param {string} uiScale @param {boolean} phone
 */
export function uiScaleStep(uiScale, phone) {
  if (uiScale !== 'auto' && UI_SCALES.includes(uiScale)) return uiScale;
  return phone ? UI_SCALE_PHONE : '100';
}

/** keys: the in-match shortcuts' key map (ui/gameLogic/shortcuts.js; settings → 快捷键). voiceLang: VOICE_LANGS.
 *  voiceNative: the 本土语言 switch (default off). textSize: TEXT_SIZES (css/theme.css `--t`, applied by ui/settings.js
 *  applyTextSize). uiScale: UI_SCALES (`--ui`, applied by ui/settings.js applyUiScale). ammoEnergyCount: 设置「显示弹药与能量
 *  数量」 — the rounds left / the magazine under an ammo skill's bar and a 秘术师's stored attack energies as stored/cap (render/units.js). One switch for the old 「弹药数量」
 *  (`ammoCount`, PR #552) and 「秘术师能量」 (`mysticEnergy`, PR #636); off by default: the official HUD has neither
 *  number. A profile that still has either old key `true` migrates to on; those keys are not written back.
 *  [ASSUMED] a stored boolean `ammoEnergyCount` wins over the old keys, so turning the merged switch off stays off.
 *  bondTimers: selected-unit timed bond readouts (#746), off by default. [ASSUMED] Convenience HUD absent from
 *  the official game; maintainer approved 2026-10-18. Stored with the other preferences in sp.pref.settings.
 *  combatMetrics: 设置「作战统计」 (PR #618), off by default: the official HUD has no such panel.
 *  officialFx: 设置「官方特效」 (0.3.0, render/vfx): 'full' (完整, this fork's default on every device — the owner's
 *  decision of 2026-10-16), 'auto' (完整 on a desktop, 精简 on a touch device — render/vfx/tier.js), 'off', 'lite'
 *  (精简); only shown when effects were extracted from the local client.
 *  bgmPrep / bgmCombat: the 休整期 / 作战 BGM picked in the lobby's ♫ panel (bgmChoice.js; 'official' = the mode's own
 *  music).
 *  otherSkins: 设置「显示其他玩家的皮肤」 (ported from upstream 0.3.1 onto this fork's catalogue skins, shared/skins.js),
 *  ON by default — draw the appearance another player chose instead of the operator's own model. A pure client
 *  preference (never sent): off, only this player's own pieces wear a skin.
 */
export const DEFAULT_SETTINGS = Object.freeze({ bgm: 0.6, sfx: 0.8, voice: 0.8, voiceLang: 'cn', voiceNative: false, voiceOverrides: Object.freeze({}), muted: false, damageNumbers: true, officialDamageNumbers: false, ammoEnergyCount: false, combatMetrics: false, quality: 'high', officialFx: 'full', otherSkins: true, textSize: 'sm', bondTimers: false, fullscreenWakeLock: false, uiScale: 'auto', keys: DEFAULT_HOTKEYS, bgmPrep: 'official', bgmCombat: 'official' });
const QUALITIES = ['high', 'medium', 'low'];
/** The values of 设置「官方特效」 (render/vfx/tier.js OFFICIAL_FX). Display order in the dialog is low / medium / high. */
export const OFFICIAL_FX_MODES = Object.freeze(['auto', 'off', 'lite', 'full']);

/**
 * The merged 显示弹药与能量数量 switch. A stored boolean wins. Otherwise on when either retired key was the boolean
 * true (`ammoCount` PR #552, `mysticEnergy` PR #636). Junk and a missing key stay off.
 * [ASSUMED] the new boolean wins, so a leftover old key cannot turn the switch back on.
 * @param {Record<string, any>} r
 */
function ammoEnergyCountOf(r) {
  if (typeof r.ammoEnergyCount === 'boolean') return r.ammoEnergyCount;
  return r.ammoCount === true || r.mysticEnergy === true;
}

/**
 * Sanitize persisted settings. Retired keys `ammoCount` and `mysticEnergy` are read here and never returned.
 * @param {any} raw
 * @returns {{ bgm: number, sfx: number, voice: number, voiceLang: 'cn'|'jp'|'en'|'kr', voiceNative: boolean, voiceOverrides: Record<string, string>, muted: boolean, damageNumbers: boolean, officialDamageNumbers: boolean, ammoEnergyCount: boolean, combatMetrics: boolean, quality: 'high'|'medium'|'low', officialFx: 'auto'|'off'|'lite'|'full', otherSkins: boolean,
 *   fullscreenWakeLock: boolean, bondTimers: boolean,
 *   textSize: 'sm'|'md'|'lg'|'xl', uiScale: string, keys: Record<'buy'|'refresh'|'freeze'|'levelUp'|'retreat'|'sell'|'ready', string>, bgmPrep: string, bgmCombat: string }}
 */
export function sanitizeSettings(raw) {
  const r = isObj(raw) ? raw : {};
  const vol = (v, d) => (Number.isFinite(v) ? clamp(Math.round(v * 100) / 100, 0, 1) : d);
  return {
    bgm: vol(r.bgm, DEFAULT_SETTINGS.bgm),
    sfx: vol(r.sfx, DEFAULT_SETTINGS.sfx),
    voice: vol(r.voice, DEFAULT_SETTINGS.voice),
    voiceLang: VOICE_LANGS.includes(r.voiceLang) ? r.voiceLang : DEFAULT_SETTINGS.voiceLang,
    voiceNative: r.voiceNative === true,
    voiceOverrides: sanitizeVoiceOverrides(r.voiceOverrides),
    muted: typeof r.muted === 'boolean' ? r.muted : DEFAULT_SETTINGS.muted,
    damageNumbers: typeof r.damageNumbers === 'boolean' ? r.damageNumbers : DEFAULT_SETTINGS.damageNumbers,
    officialDamageNumbers: typeof r.officialDamageNumbers === 'boolean' ? r.officialDamageNumbers : false,
    ammoEnergyCount: ammoEnergyCountOf(r),
    bondTimers: r.bondTimers === true,
    combatMetrics: typeof r.combatMetrics === 'boolean' ? r.combatMetrics : DEFAULT_SETTINGS.combatMetrics,
    fullscreenWakeLock: typeof r.fullscreenWakeLock === 'boolean' ? r.fullscreenWakeLock : DEFAULT_SETTINGS.fullscreenWakeLock,
    quality: QUALITIES.includes(r.quality) ? r.quality : DEFAULT_SETTINGS.quality,
    officialFx: OFFICIAL_FX_MODES.includes(r.officialFx) ? r.officialFx : DEFAULT_SETTINGS.officialFx,
    otherSkins: r.otherSkins !== false,
    textSize: TEXT_SIZES.includes(r.textSize) ? r.textSize : DEFAULT_SETTINGS.textSize,
    uiScale: UI_SCALES.includes(String(r.uiScale)) ? String(r.uiScale) : DEFAULT_SETTINGS.uiScale,
    keys: sanitizeHotkeys(r.keys),
    bgmPrep: sanitizeBgmChoice(r.bgmPrep),
    bgmCombat: sanitizeBgmChoice(r.bgmCombat),
  };
}
