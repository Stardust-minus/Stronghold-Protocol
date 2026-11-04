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
import { NAMECARD_PREF, NAMECARD_Y_PREF, NAMECARD_X_PREF, NAMECARD_ZOOM_PREF, namecardOf, namecardY, namecardX, namecardZoom } from './namecards.js';
import { C2S } from '../../../shared/protocol.js';
import { cardArt } from './dynamicFraming.js';

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
/**
 * How the seat card frames the 名片干员 (rel27: a 动态立绘; rel30: every look): "x,y,zoom,space" (ui/dynamicFraming.js
 * ART_LIMITS; space = ART_SPACE, absent before rel31 — older builds read the first three), '' = the default.
 */
export const CARD_ART_PREF = 'room.card.art';
/** The space mark of a frame saved since rel31, when a static scene look's frame moved into its whole 立绘 (ui/seatLive.js sceneSpaceMoved). */
export const ART_SPACE = 31;
const parseArt = (v) => { const [x, y, zoom] = String(v ?? '').split(',').map(Number); return cardArt({ artX: x, artY: y, artZoom: zoom }); };
const parseArtSpace = (v) => { const s = Number(String(v ?? '').split(',')[3]); return Number.isSafeInteger(s) && s > 0 ? s : 0; };

export const cardStore = createStore({
  charId: str(loadPref(CARD_PREF, '')),
  avatar: str(loadPref(AVATAR_PREF, '')),
  bg: str(loadPref(NAMECARD_PREF, '')),
  bgY: namecardY(loadPref(NAMECARD_Y_PREF, null)),
  bgX: namecardX(loadPref(NAMECARD_X_PREF, null)),
  bgZoom: namecardZoom(loadPref(NAMECARD_ZOOM_PREF, null)),
  look: str(loadPref(CARD_LOOK_PREF, '')),
  avatarLook: str(loadPref(AVATAR_LOOK_PREF, '')),
  art: parseArt(loadPref(CARD_ART_PREF, '')),
  artSpace: parseArtSpace(loadPref(CARD_ART_PREF, '')),
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
  if (str(charId) !== cardStore.get().charId) { setCardLook(''); setCardArt(null); }
  savePref(CARD_PREF, str(charId)); cardStore.set({ charId: str(charId) });
}
/** @param {string} charId '' = none */
export function setCardAvatar(charId) {
  if (str(charId) !== cardStore.get().avatar) setAvatarLook('');
  savePref(AVATAR_PREF, str(charId)); cardStore.set({ avatar: str(charId) });
}
/** @param {string} look '' 精二 / 'e1' 精一 / a skin id of the 名片干员 (another look starts at its portrait crop) */
export function setCardLook(look) {
  if (str(look) !== cardStore.get().look) setCardArt(null);
  savePref(CARD_LOOK_PREF, str(look)); cardStore.set({ look: str(look) });
}
/** @param {{ x: number, y: number, zoom: number }|null} art the seat card's framing of the look (ui/seatLive.js); null = the default */
export function setCardArt(art) {
  const a = art ? cardArt({ artX: art.x, artY: art.y, artZoom: art.zoom }) : null;
  savePref(CARD_ART_PREF, a ? `${a.x},${a.y},${a.zoom},${ART_SPACE}` : ''); cardStore.set({ art: a, artSpace: a ? ART_SPACE : 0 });
}
/** @param {string} look '' / 'e1' / a skin id of the 头像 operator */
export function setAvatarLook(look) { savePref(AVATAR_LOOK_PREF, str(look)); cardStore.set({ avatarLook: str(look) }); }
/**
 * The background's framing (feedback #61, #129: ui/namecards.js): { x, y, zoom } in percent, each null / out of range =
 * the card's default; null = all three back to it.
 * @param {{ x?: number|null, y?: number|null, zoom?: number|null }|null} frame
 */
export function setCardBackgroundFrame(frame) {
  const x = namecardX(frame?.x), y = namecardY(frame?.y), z = namecardZoom(frame?.zoom);
  savePref(NAMECARD_X_PREF, x); savePref(NAMECARD_Y_PREF, y); savePref(NAMECARD_ZOOM_PREF, z);
  cardStore.set({ bgX: x, bgY: y, bgZoom: z });
}
/** @param {string} bg '' = none (another background starts at its default framing) */
export function setCardBackground(bg) {
  const id = namecardOf(bg) ? bg : '';
  if (id !== cardStore.get().bg) setCardBackgroundFrame(null);
  savePref(NAMECARD_PREF, id); cardStore.set({ bg: id });
}

/** One's card, the trophies re-read when a component that shows it mounts. */
export function useMyCard() {
  useEffect(() => { refreshTrophies(); }, []);
  return useStore((s) => s, shallowEqual, cardStore);
}

/** The room.card message of a card: empty fields as '' (the server drops them), trophies bounded. */
export function cardMessage(card) {
  const trophies = Number.isSafeInteger(card?.trophies) ? Math.max(0, Math.min(1_000_000, card.trophies)) : 0;
  const charId = str(card?.charId), avatar = str(card?.avatar);
  const bg = namecardOf(card?.bg) ? card.bg : '';
  const look = charId ? str(card?.look) : '';
  // the seat framing goes with a picked 名片干员, whatever its look (rel30; rel27–29: a skin look only)
  const art = charId && card?.art ? cardArt({ artX: card.art.x, artY: card.art.y, artZoom: card.art.zoom }) : null;
  return { charId, avatar, bg, bgY: bg ? namecardY(card?.bgY) ?? -1 : -1, bgX: bg ? namecardX(card?.bgX) ?? -1 : -1,
    bgZoom: bg ? namecardZoom(card?.bgZoom) ?? -1 : -1, trophies,
    look, avatarLook: avatar ? str(card?.avatarLook) : '', artX: art?.x ?? -1, artY: art?.y ?? -1, artZoom: art?.zoom ?? -1 };
}

/**
 * The official avatar a player picked: one's own pick (this browser), else their seat card's (room.state seats[].card,
 * what the server showed the room); null when none, unknown or before the data loads.
 * @param {any} playerId
 */
export function useCardAvatar(playerId) {
  const [id, look] = useCardAvatarPick(playerId);
  return cardAvatarUrl(id, undefined, look);
}

/** The 头像 a player picked as [avatar id, look] (one's own pick, else their seat card's); ['', ''] when none. */
export function useCardAvatarPick(playerId) {
  useData('assets');
  const self = useStore((s) => playerId != null && s.me?.playerId === playerId);
  const mine = useStore((c) => `${c.avatar}|${c.avatarLook}`, Object.is, cardStore);
  const seat = useStore((s) => {
    const card = Array.isArray(s.room?.seats) ? s.room.seats.find((x) => x && x.playerId === playerId)?.card : null;
    return card && typeof card === 'object' ? `${str(card.avatar)}|${str(card.avatarLook)}` : '|';
  });
  return (self ? mine : seat).split('|');
}
