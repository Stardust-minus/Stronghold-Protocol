// 名片 (2026-10-14, the owner's decision; the room design by 雨千代chiyo): what a doctor shows on the room's seat card —
// 名片干员 (an operator's art, ui/seatArt.js CARD_PREF), 头像 (an operator's official avatar, AVATAR_PREF), 名片底图
// (ui/namecards.js NAMECARD_PREF) and the trophy level (ui/trophies.js) of the cumulative trophies this browser's 统计数据
// recorded (ui/stats.js); the looks of the portrait and the avatar (精二 / 精一 / a skin: CARD_LOOK_PREF, AVATAR_LOOK_PREF;
// feedback #9 / #24). All kept in the browser;
// sent as room.card where the server takes it (shared/protocol.js) so teammates see the same card. The trophy count is
// the player's own claim — display only, the server just bounds it — and a server without room.card (an older build)
// leaves the card visible to its owner only.
import { useEffect } from '../../vendor/hooks.module.js';
import { createStore, loadPref, savePref, useStore, shallowEqual } from '../store.js';
import { useData } from '../data.js';
import { peekStatsRecords, selfRowOf } from './stats.js';
import { CARD_PREF, cardAvatarUrl } from './seatArt.js';
import { NAMECARD_PREF, namecardOf } from './namecards.js';
import { C2S } from '../../../shared/protocol.js';

/** The server takes room.card (this build's protocol): teammates then see one's card. */
export const CARD_SYNC = !!C2S && Object.hasOwn(C2S, 'room.card');

const str = (v) => (typeof v === 'string' ? v : '');

/** The cumulative trophies of a stats envelope's records (each settled match's own row; ui/stats.js). */
export function trophyTotal(records) {
  let n = 0;
  for (const rec of Array.isArray(records) ? records : []) {
    const v = selfRowOf(rec)?.trophies;
    if (Number.isSafeInteger(v) && v > 0) n += v;
  }
  return n;
}

/** 头像: the operator whose official avatar stands for the player ('' = none: the strategy icon / the name's glyph). */
export const AVATAR_PREF = 'room.avatar';
/** The looks ('' 精二, 'e1' 精一, a skin id) of the 名片干员 and of the 头像 operator. */
export const CARD_LOOK_PREF = 'room.card.look';
export const AVATAR_LOOK_PREF = 'room.avatar.look';

export const cardStore = createStore({
  charId: str(loadPref(CARD_PREF, '')),
  avatar: str(loadPref(AVATAR_PREF, '')),
  bg: str(loadPref(NAMECARD_PREF, '')),
  look: str(loadPref(CARD_LOOK_PREF, '')),
  avatarLook: str(loadPref(AVATAR_LOOK_PREF, '')),
  trophies: null, // read from the stats on first use
});

/** Re-read the trophy total (a match just ended, stats were imported). */
export function refreshTrophies() {
  let n;
  try { n = trophyTotal(peekStatsRecords()); } catch { n = 0; }
  if (cardStore.get().trophies !== n) cardStore.set({ trophies: n });
}

/** @param {string} charId '' = 默认 (chosen from the player id) */
export function setCardOperator(charId) {
  if (str(charId) !== cardStore.get().charId) setCardLook('');
  savePref(CARD_PREF, str(charId)); cardStore.set({ charId: str(charId) });
}
/** @param {string} charId '' = none */
export function setCardAvatar(charId) {
  if (str(charId) !== cardStore.get().avatar) setAvatarLook('');
  savePref(AVATAR_PREF, str(charId)); cardStore.set({ avatar: str(charId) });
}
/** @param {string} look '' 精二 / 'e1' 精一 / a skin id of the 名片干员 */
export function setCardLook(look) { savePref(CARD_LOOK_PREF, str(look)); cardStore.set({ look: str(look) }); }
/** @param {string} look '' / 'e1' / a skin id of the 头像 operator */
export function setAvatarLook(look) { savePref(AVATAR_LOOK_PREF, str(look)); cardStore.set({ avatarLook: str(look) }); }
/** @param {string} bg '' = none */
export function setCardBackground(bg) { const id = namecardOf(bg) ? bg : ''; savePref(NAMECARD_PREF, id); cardStore.set({ bg: id }); }

/** One's card, the trophies re-read when a component that shows it mounts. */
export function useMyCard() {
  useEffect(() => { refreshTrophies(); }, []);
  return useStore((s) => s, shallowEqual, cardStore);
}

/** The room.card message of a card: empty fields as '' (the server drops them), trophies bounded. */
export function cardMessage(card) {
  const trophies = Number.isSafeInteger(card?.trophies) ? Math.max(0, Math.min(1_000_000, card.trophies)) : 0;
  const charId = str(card?.charId), avatar = str(card?.avatar);
  return { charId, avatar, bg: namecardOf(card?.bg) ? card.bg : '', trophies,
    look: charId ? str(card?.look) : '', avatarLook: avatar ? str(card?.avatarLook) : '' };
}

/**
 * The official avatar a player picked: one's own pick (this browser), else their seat card's (room.state seats[].card,
 * what the server showed the room); null when none, unknown or before the data loads.
 * @param {any} playerId
 */
export function useCardAvatar(playerId) {
  useData('assets');
  const self = useStore((s) => playerId != null && s.me?.playerId === playerId);
  const mine = useStore((c) => `${c.avatar}|${c.avatarLook}`, Object.is, cardStore);
  const seat = useStore((s) => {
    const card = Array.isArray(s.room?.seats) ? s.room.seats.find((x) => x && x.playerId === playerId)?.card : null;
    return card && typeof card === 'object' ? `${str(card.avatar)}|${str(card.avatarLook)}` : '|';
  });
  const [id, look] = (self ? mine : seat).split('|');
  return cardAvatarUrl(id, undefined, look);
}
