// Operator appearances are display-only: never replace charId, skill/module data or combat hit timings.
// IDs below are stable manifest keys, not official skin IDs or arbitrary resource URLs.
import { SKIN_CATALOGUE } from './skin-catalogue.js';
export const OPERATOR_SKINS = SKIN_CATALOGUE;
export const SKIN_LIMITS = Object.freeze({ choices: 256 });
const byId = new Map(OPERATOR_SKINS.map(s => [s.id, s]));
const plain = v => !!v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Resolve an admitted appearance for its actual operator (not a DIY slot or the replaced operator). */
export function skinFor(charId, skinId) {
  const skin = typeof skinId === 'string' ? byId.get(skinId) : null;
  return skin && skin.charId === charId ? skin : null;
}
export const skinsFor = charId => OPERATOR_SKINS.filter(s => s.charId === charId);
export function skinIdFor(choices, charId) {
  return plain(choices) && Object.hasOwn(choices, charId) ? skinFor(charId, choices[charId])?.id ?? null : null;
}

/** Exact whitelist: own charId keys and bound skin IDs only. An empty map restores default appearances. */
export function isSkinChoices(value) {
  return plain(value) && Object.keys(value).length <= SKIN_LIMITS.choices
    && Object.entries(value).every(([charId, skinId]) => !!skinFor(charId, skinId));
}
export function cleanSkinChoices(value) {
  if (!plain(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([charId, skinId]) => !!skinFor(charId, skinId)).slice(0, SKIN_LIMITS.choices));
}
