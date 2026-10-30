// 名片干员: the portrait a doctor shows on the room's seat card (screens/room.js) — the operator the player picked
// (room.card; room.state seats[].card.charId), else one of the 5★/6★ operators chosen by the player id, the same on
// every client. Its art (`look`, feedback #9 / #24): '' the 精二 art, 'e1' the 精一 art, or a skin of that operator
// (lookUrl, lookOptions); the 头像 the same (`avatarLook`).
// The pick's store and the seat helpers below it (PR #643 split 6) stay for ui/loadoutSync.js installCardSync and for
// screens that read a plain charId; this fork's seat cards use seatPortrait and the richer seats[].card.
import { chessPortraitUrl } from './assetUrls.js';
import { data } from '../data.js';
import { N_ } from '../../../shared/i18n.js';
import { createStore, loadPref, savePref } from '../store.js';
import { ownerSkin } from './skins.js';
import { CARD_ROSTER } from '../../../shared/card-roster.js';
import { isOfficialAvatar } from '../../../shared/protocol.js';

/** FNV-1a of a string (the portrait pick: the same operator for a player on every client). */
function hash32(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** 名片干员: the player's own pick (localStorage; sent as room.card where the server knows it). */
export const CARD_PREF = 'room.card';

/** The store field of the pick (ui/loadoutSync.js installCardSync `key`) and its sync state field. */
export const CARD_KEY = 'card';
export const CARD_SYNC_KEY = 'cardSync';

/** A stored pick as the store holds it: a charId string, '' for none (默认). */
export function parseStoredCard(v) {
  return typeof v === 'string' ? v : '';
}

/** This browser's pick and its sync state (survives room / match resets like ui/skins.js' store). */
export const cardStore = createStore({ [CARD_KEY]: parseStoredCard(loadPref(CARD_PREF, '')), [CARD_SYNC_KEY]: 'idle' });

/**
 * Pick the 名片干员 ('' = 默认): persisted at once, the sync engine sends it.
 * @param {string} charId
 */
export function setCard(charId) {
  const next = parseStoredCard(charId);
  try { savePref(CARD_PREF, next); } catch { /* private mode: the session keeps it */ }
  cardStore.set({ [CARD_KEY]: next });
}

/** The operators of shared/card-roster.js as records of the art lookups (assetUrls.js): `roster`, the elite art. */
const ROSTER_RECORDS = CARD_ROSTER.map((r) => Object.freeze({ ...r, isGolden: true, roster: true }));

/**
 * The operators a seat card can show: one record per charId of the data on screen (the elite form for its E2 art), then
 * the rest of the roster (feedback #62: the 协防干员 pool, the other versions' operators), which the default portrait
 * never draws from (`roster`); 6★ first.
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
  for (const r of ROSTER_RECORDS) if (!by.has(r.charId)) by.set(r.charId, r);
  return [...by.values()].sort((a, b) => ((b.rarity ?? 0) - (a.rarity ?? 0)) || String(a.name).localeCompare(String(b.name), 'zh'));
}

const str = (v) => (typeof v === 'string' && v ? v : null);

/**
 * An operator's art of a card look from the art manifest alone (the lobby never downloads the operators' data):
 * `kind` 'avatar' | 'portrait'; look '' = its 精二 art when it has one (else 精一), 'e1' = 精一, a skin id = that skin's
 * art (only a skin of this operator); null when unknown.
 * @param {any} m the art manifest @param {string} charId @param {string} [look] @param {'avatar'|'portrait'} [kind]
 */
export function lookUrl(m, charId, look = '', kind = 'avatar') {
  if (typeof charId !== 'string' || !m) return null;
  if (look && look !== 'e1') {
    const s = m.skins && typeof m.skins === 'object' && Object.hasOwn(m.skins, look) ? m.skins[look] : null;
    if (s && s.charId === charId && str(s[kind])) return s[kind];
  }
  const chars = typeof m.chars === 'object' ? m.chars : null;
  const c = chars && Object.hasOwn(chars, charId) ? chars[charId] : null;
  if (!c) return null;
  return (look === 'e1' ? null : str(c[`${kind}E2`])) || str(c[kind]);
}

/**
 * The looks an operator offers on a card: [{ id, name, src }] — 精二 ('' — only when the art has an E2 form), 精一 ('e1';
 * '' when there is no E2 form, the default then) and each skin in the manifest; one entry = nothing to choose.
 * @param {any} m @param {string} charId @param {'avatar'|'portrait'} kind
 */
export function lookOptions(m, charId, kind) {
  const chars = m && typeof m.chars === 'object' ? m.chars : null;
  const c = typeof charId === 'string' && chars && Object.hasOwn(chars, charId) ? chars[charId] : null;
  if (!c) return [];
  const e2 = str(c[`${kind}E2`]);
  const out = e2 ? [{ id: '', name: N_('精英二'), src: e2 }, { id: 'e1', name: N_('精英一'), src: str(c[kind]) }]
    : [{ id: '', name: N_('精英一'), src: str(c[kind]) }];
  const skins = m.skins && typeof m.skins === 'object' ? m.skins : {};
  for (const [id, s] of Object.entries(skins)) if (s && s.charId === charId && str(s[kind])) out.push({ id, name: s.name || id, src: s[kind], skin: true });
  return out;
}

/**
 * 头像: the official avatar of an operator (room.card avatar) in its look (avatarLook: '' its elite (E2) avatar when
 * the art has one, as the card operators' golden form; 'e1'; a skin); null when unknown.
 * @param {string} charId @param {any} [m] the art manifest @param {string} [look]
 */
export function cardAvatarUrl(charId, m = data.get('assets'), look = '') {
  return isOfficialAvatar(charId) ? str(m?.ui?.[`playerAvatar/${charId}`]) : lookUrl(m, charId, look, 'avatar');
}

/** The groups of the official player avatars (id prefixes of display_meta_table), the 头像 picker's order. */
const OFFICIAL_AVATAR_GROUPS = Object.freeze([
  { key: 'activity', title: N_('活动头像') }, { key: 'special', title: N_('特殊头像') }, { key: 'def', title: N_('基础头像') }, { key: 'dyn', title: N_('动态头像') },
]);

/**
 * The official player avatars of the art manifest (feedback #100), by group: [{ key, title, items: [{ id, src }] }].
 * @param {any} m the art manifest
 */
export function officialAvatars(m) {
  const ui = m?.ui && typeof m.ui === 'object' ? m.ui : {};
  const ids = Object.keys(ui).filter((k) => k.startsWith('playerAvatar/')).map((k) => k.slice('playerAvatar/'.length))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return OFFICIAL_AVATAR_GROUPS.map((g) => ({ ...g, items: ids.filter((id) => id.startsWith(`avatar_${g.key}_`)).map((id) => ({ id, src: ui[`playerAvatar/${id}`] })) }))
    .filter((g) => g.items.length);
}

/**
 * The seat card's portrait: the operator the player picked (room.state seats[].card, or one's own pick), else one of
 * the 5★/6★ operators chosen by the player id — the same on every client (null before the data loads).
 * @param {any} seat room.state seat @param {{ pool: any[], byChar: Map<string, any>, m: any, myId: any, myCard: string, myLook?: string }} ctx
 */
export function seatPortrait(seat, { pool, byChar, m, myId, myCard, myLook = '' }) {
  if (!seat || seat.playerId == null) return null;
  // seats[].card is { charId, bg, trophies } (ui/playerCard.js); a bare string is the design's original form
  const pick = (seat.playerId === myId && myCard) || (typeof seat.card === 'string' ? seat.card : seat.card?.charId);
  const rec = pick && byChar ? byChar.get(pick) : null;
  const mine = seat.playerId === myId && myCard;
  const look = mine ? myLook : typeof seat.card?.look === 'string' ? seat.card.look : '';
  if (rec) return (look && lookUrl(m, rec.charId, look, 'portrait')) || chessPortraitUrl(m, rec);
  if (!Array.isArray(pool) || !pool.length) return null;
  return chessPortraitUrl(m, pool[hash32(seat.playerId) % pool.length]);
}

/**
 * What the seat cards draw from: the pickable operators by charId and the default pool (5★/6★, by charId so every
 * client orders it the same).
 * @param {any[]} list cardOperators()
 */
export function cardContext(list) {
  return {
    byChar: new Map(list.map((c) => [c.charId, c])),
    pool: list.filter((c) => (c.rarity ?? 0) >= 5 && !c.roster).sort((a, b) => (a.charId < b.charId ? -1 : a.charId > b.charId ? 1 : 0)),
  };
}

/**
 * The operator on a seat card: the player's pick (one's own seat shows the local pick at once, the others the server's
 * seats[].card), else one of the pool chosen by the player id [ASSUMED, see the header]. null for an empty seat, a bot,
 * or before the data loads.
 * @param {any} seat room.state seat
 * @param {{ byChar: Map<string, any>, pool: any[] }} ctx cardContext()
 * @param {{ myId?: any, myCard?: string }} [own]
 * @returns {{ chess: any, picked: boolean } | null}
 */
export function seatOperator(seat, { byChar, pool }, { myId, myCard } = {}) {
  if (!seat || seat.playerId == null || seat.isBot) return null;
  const pick = (seat.playerId === myId ? myCard : typeof seat.card === 'string' ? seat.card : seat.card?.charId) || '';
  const rec = pick && byChar ? byChar.get(pick) : null;
  if (rec) return { chess: rec, picked: true };
  if (!Array.isArray(pool) || !pool.length) return null;
  return { chess: pool[hash32(seat.playerId) % pool.length], picked: false };
}

/**
 * The outfit a seat card's operator wears (docs/SKINS.md; the maintainer's decision 4 of 2026-10-21), by the rule of
 * every owner-aware card (ui/skins.js ownerSkin): one's own card wears this browser's choice at once (`localSkins`),
 * another doctor's the choice that seat published — `players` holds `{ playerId, skins }`: the room's seats
 * (room.state seats[].skins) or a match's public players — unless 「显示其他玩家的皮肤」 is off. null = the default art;
 * a skinId the local manifest does not hold (an appearance plugin this page lacks) also draws the default
 * (ui/assetUrls.js chessPortraitUrl falls back).
 * @param {any} seat a seat or player record (`playerId`, `isBot`)
 * @param {string | null | undefined} charId the operator the card shows (seatOperator)
 * @param {{ myId?: any, localSkins?: Record<string, string>, players?: any[], otherSkins?: boolean }} ctx
 * @returns {string | null}
 */
export function seatCardSkin(seat, charId, { myId = null, localSkins = {}, players = [], otherSkins = true } = {}) {
  if (!seat || seat.isBot || seat.playerId == null || !charId) return null;
  if (seat.playerId === myId) return ownerSkin(charId, { localSkins });
  return ownerSkin(charId, { ownerId: seat.playerId, myId, players: Array.isArray(players) ? players.filter(Boolean) : [], otherSkins });
}

/**
 * The picture a seat card draws: the first of `srcs` — the outfit's portrait, then the operator's default portrait — that
 * has not failed to load in this card (`failed`); null when none is left, and the card shows its avatar frame (§35.18's
 * leftover: an outfit file that failed went straight to the frame).
 * @param {(string | null | undefined)[]} srcs in order of preference
 * @param {readonly string[]} [failed]
 * @returns {string | null}
 */
export function seatArtSrc(srcs, failed = []) {
  for (const src of Array.isArray(srcs) ? srcs : []) if (src && !failed.includes(src)) return src;
  return null;
}
