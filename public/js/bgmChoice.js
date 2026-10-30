// In-game BGM picks (the owner's request of 2026-10-15): 休整期 and 作战 each play the mode's own music by default
// ('official': audio.js bgmKeyFor / combatTrackFor), the 上海Major pause BGM, one of the mode's other tracks
// (data/assets.json `audio.bgm`) or 自选曲 — a file the player chose, kept in this browser like the lobby music
// (ui/lobbyMusic.js `matchMusic`, IndexedDB; nothing is hosted for it). The picks live in settings bgmPrep / bgmCombat
// and are personal — other players keep their own music. A pick that does not load, and 自选曲 without a file, play
// the official music (audio.js _startBgm). 联防 / 最终攻势 / 隐秘核心 keep their own tracks.

import { N_ } from '../../shared/i18n.js';

/**
 * The 上海Major pause BGM, offered beside 官方 (the owner's request of 2026-10-15). It is no official file and not in
 * the manifest: a host provides it itself (production: a route to a pinned copy); where it is missing the pick 404s
 * and the official track plays.
 */
export const MAJOR_BGM_URL = '/assets/audio/bgm/sp_major_pause.mp3';

/** The tracks a player may pick: id, name (msgid), the track ({ intro?, loop }), out of `audio.bgm` but 上海Major. */
export const BGM_TRACKS = Object.freeze([
  { id: 'major', name: N_('上海Major暂停BGM'), of: () => ({ loop: MAJOR_BGM_URL }) },
  { id: 'prep', name: N_('卫戍协议 · 休整'), of: (b) => b?.prep },
  { id: 'fearless', name: N_('无畏者'), of: (b) => b?.combatAlts?.[1] },
  { id: 'knight', name: N_('骑士之日'), of: (b) => b?.combatAlts?.[0] },
  // the 上半期's own (feedback #45; official levels of 2025-11: rounds 1–7 bat_act35side_01, 8–13 bat_act35side_02)
  { id: 'shahai', name: N_('沙海流金'), of: (b) => b?.firstHalf?.combat?.[0] },
  { id: 'chengshi', name: N_('城市觉醒'), of: (b) => b?.firstHalf?.combat?.[1] },
  { id: 'prep1', name: N_('卫戍协议 · 休整（上半期）'), of: (b) => b?.firstHalf?.prep },
  { id: 'unite', name: N_('联防'), of: (b) => b?.unite },
  { id: 'lobby', name: N_('卫戍协议 · 大厅'), of: (b) => b?.lobby },
]);

/** Every valid value of settings bgmPrep / bgmCombat. */
export const BGM_CHOICES = Object.freeze(['official', ...BGM_TRACKS.map((t) => t.id), 'custom']);

/** @param {any} v @returns {string} a valid pick ('official' for anything else) */
export const sanitizeBgmChoice = (v) => (BGM_CHOICES.includes(v) ? v : 'official');

/**
 * Which pick a BGM key follows: 'prep' (休整期 and the other prep-like phases) or 'combat' (a normal 作战, the round's own
 * `combat:<i>` too); null for the lobby, 联防 and the boss phases.
 * @param {string|null} key audio.js bgmKeyFor
 * @returns {'prep'|'combat'|null}
 */
export function bgmChoiceKind(key) {
  if (key === 'prep') return 'prep';
  if (key === 'combat' || (typeof key === 'string' && key.startsWith('combat:'))) return 'combat';
  return null;
}

/**
 * The picked track for a BGM key, or null when the official one plays (no pick, an unknown one, a track the manifest
 * lacks, 自选曲 without a file, or a pick that failed to load this page — `failed`, by its `choice`).
 * @param {any} manifest data/assets.json
 * @param {string|null} key audio.js bgmKeyFor
 * @param {{ prep?: string, combat?: string }|null} choices
 * @param {Set<string>|null} [failed]
 * @param {{ prep?: string|null, combat?: string|null }|null} [local] the object URLs of the player's own files
 * @returns {{ intro: string|null, loop: string, choice: string, local?: true }|null} `choice`: the pick's id, a file's URL
 */
export function pickedBgm(manifest, key, choices, failed = null, local = null) {
  const kind = bgmChoiceKind(key);
  const id = kind ? sanitizeBgmChoice(choices?.[kind]) : 'official';
  if (id === 'official') return null;
  if (id === 'custom') {
    const url = local?.[kind];
    return typeof url === 'string' && url && !failed?.has(url) ? { intro: null, loop: url, choice: url, local: true } : null;
  }
  if (failed?.has(id)) return null;
  const track = BGM_TRACKS.find((t) => t.id === id)?.of(manifest?.audio?.bgm);
  if (!track || typeof track.loop !== 'string') return null;
  return { intro: typeof track.intro === 'string' ? track.intro : null, loop: track.loop, choice: id };
}
