// 名片干员: the portrait a doctor shows on the room's seat card (screens/room.js) — the operator the player picked
// (room.card; room.state seats[].card.charId), else one of the 5★/6★ operators chosen by the player id, the same on
// every client.
// 项目 5 (个性化, 2026-10-16): the pick also carries a *variant* — '' / 'e2' = 精二 (the default art), 'e1' = 精一,
// 'skin:<skinId>' = one of that operator's own skins (room.card.art for this portrait, room.card.face for the avatar).
// An unresolvable variant falls back to 精二, so an older manifest or a stale skin id never breaks a seat.
import { chessPortraitUrl } from './assetUrls.js';
import { data } from '../data.js';

/** FNV-1a of a string (the portrait pick: the same operator for a player on every client). */
function hash32(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** 名片干员: the player's own pick (localStorage; sent as room.card where the server knows it). */
export const CARD_PREF = 'room.card';

/** The art variant of a card field: '' and 'e2' both mean 精二, 'e1' 精一, 'skin:<id>' that skin. */
export const CARD_VARIANTS = Object.freeze(['', 'e1', 'e2']);
/** Whether a value is a card art variant (the same grammar shared/protocol.js isCardVariant takes). */
export const isCardVariant = (v) => v === '' || v === 'e1' || v === 'e2'
  || (typeof v === 'string' && /^skin:[A-Za-z0-9_]+$/.test(v));

/**
 * The operators a seat card can show: one record per charId (the elite form for its E2 art), 6★ first.
 * @param {any[]} chessList chess.json records
 * @returns {any[]}
 */
export function cardOperators(chessList) {
  const by = new Map();
  for (const c of Array.isArray(chessList) ? chessList : []) {
    if (!c || c.isDiy || c.visible === false || typeof c.charId !== 'string') continue;
    const prev = by.get(c.charId);
    if (!prev || (c.isGolden && !prev.isGolden)) by.set(c.charId, c);
  }
  return [...by.values()].sort((a, b) => ((b.rarity ?? 0) - (a.rarity ?? 0)) || String(a.name).localeCompare(String(b.name), 'zh'));
}

/**
 * The art manifest's URL for a card variant: a skin's own art when the variant names one *of this operator*, else the
 * operator's own art — 精一 falls back to 精二 (and to the plain key) when the manifest has no separate 精一 art.
 * @param {string} charId @param {any} m the art manifest @param {'avatar'|'portrait'} kind @param {string} variant
 * @returns {string|null}
 */
function artUrl(charId, m, kind, variant) {
  const chars = m && typeof m.chars === 'object' ? m.chars : null;
  const c = typeof charId === 'string' && chars && Object.hasOwn(chars, charId) ? chars[charId] : null;
  if (!c) return null;
  const v = typeof variant === 'string' ? variant : '';
  const url = (x, keys) => { for (const k of keys) if (typeof x?.[k] === 'string' && x[k]) return x[k]; return null; };
  if (v.startsWith('skin:')) {
    const skins = m && typeof m.skins === 'object' ? m.skins : null;
    const s = skins ? skins[v.slice(5)] : null;
    return s && s.charId === charId ? url(s, kind === 'avatar' ? ['avatar'] : ['portrait', 'illustration']) : null;
  }
  if (kind === 'avatar') return v === 'e1' ? url(c, ['avatar', 'avatarE2']) : url(c, ['avatarE2', 'avatar']);
  return v === 'e1' ? url(c, ['portrait_1', 'portrait', 'portraitE2']) : url(c, ['portrait_2', 'portraitE2', 'portrait']);
}

/**
 * 头像: the official avatar of an operator (room.card avatar) — the art its variant asks for (项目 5), from the art
 * manifest alone (the lobby never downloads the operators' data); null when unknown.
 * @param {string} charId @param {any} [m] the art manifest @param {string} [variant] '' / 'e1' / 'e2' / 'skin:<id>'
 */
export function cardAvatarUrl(charId, m = data.get('assets'), variant = '') {
  return artUrl(charId, m, 'avatar', variant);
}

/**
 * 名片干员: the stand-up portrait of an operator for a card variant (项目 5) — the seat card's own art path; null when
 * the manifest does not know the operator.
 * @param {string} charId @param {any} [m] the art manifest @param {string} [variant] '' / 'e1' / 'e2' / 'skin:<id>'
 */
export function cardPortraitUrl(charId, m = data.get('assets'), variant = '') {
  return artUrl(charId, m, 'portrait', variant);
}

/**
 * The skins an operator owns (the card picker lists them): [{ id, name, brand }], sorted by name; [] when none.
 * @param {string} charId @param {any} [m] the art manifest
 */
export function cardSkins(charId, m = data.get('assets')) {
  const skins = m && typeof m.skins === 'object' ? m.skins : null;
  if (!skins || typeof charId !== 'string' || !charId) return [];
  const out = [];
  for (const [id, s] of Object.entries(skins)) {
    if (s && s.charId === charId) out.push({ id, name: typeof s.name === 'string' && s.name ? s.name : id, brand: typeof s.brand === 'string' ? s.brand : '' });
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
}

/**
 * The seat card's portrait: the operator the player picked (room.state seats[].card, or one's own pick), else one of
 * the 5★/6★ operators chosen by the player id — the same on every client (null before the data loads).
 * @param {any} seat room.state seat
 * @param {{ pool: any[], byChar: Map<string, any>, m: any, myId: any, myCard: string, variant?: string }} ctx
 */
export function seatPortrait(seat, { pool, byChar, m, myId, myCard, variant }) {
  if (!seat || seat.playerId == null) return null;
  // seats[].card is { charId, avatar, art, face, bg, trophies } (ui/playerCard.js); a bare string is the design's original form
  const card = seat.card && typeof seat.card === 'object' ? seat.card : null;
  const pick = (seat.playerId === myId && myCard) || (typeof seat.card === 'string' ? seat.card : card?.charId);
  const rec = pick && byChar ? byChar.get(pick) : null;
  // 项目 5: one's own variant comes from the local pick, a teammate's from their seat card
  const wanted = typeof variant === 'string' && variant ? variant : (typeof card?.art === 'string' ? card.art : '');
  if (rec) {
    if (wanted) {
      const one = cardPortraitUrl(pick, m, wanted);
      if (one) return one;
    }
    return chessPortraitUrl(m, rec);
  }
  // a bare chess id from the fallback pool: the operator's record already carries its own art
  if (!Array.isArray(pool) || !pool.length) return null;
  return chessPortraitUrl(m, pool[hash32(seat.playerId) % pool.length]);
}
