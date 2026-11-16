// 名片底图 (2026-10-14, the owner's decision: the room design by 雨千代chiyo had name-card art from its account service;
// here the backgrounds come from material this server already has, no new art): the four simulation loading pictures
// (assets.json ui['loading/loading_ac_*']) and the faction and organisation emblems (ui['campLogo/logo_*'], white on the
// faction's colour). A card id is `loading:<key>` or `camp:<key>`; an unknown id (an older or newer client's) shows nothing.
// `skin:<skin id>` (feedback #24, the owner's decision of 2026-10-17): an operator skin's full illustration (assets.json
// skins[id].illustration, ~4 MB — only the plates that use it load it; the picker shows the skins' half-body art).
// A collab operator's skin (its art in the collab pack, shared/collabAssets.js) is never a name card: a plate shows in
// every room the player joins, and a room without 联动干员 must not load the pack's art.
// A skin card whose skin has an official 动态立绘 (skins[id].dynamic; the owner's decisions of 2026-11-02 / 11-03) animates
// it over the static plate on screen, at any width (ui/dynamicIllustration.js cover mode on the shared renderer; still under
// reduced motion, the static picture on a failure).
// `char:<charId>_1` / `char:<charId>_2` (the owner's decision of 2026-11-16: 「名片为啥没办法选塔露拉」 — every operator, not
// only those with a 时装): an operator's own 默认 / 精二 立绘 (assets.json chars[id].illustration / illustrationE2; the picker
// shows portrait / portraitE2). The official skin id (skin_table <charId>#1 / #2) with '#' as '_', as the manifest's skin
// keys; '#' is outside room.card's bg format (shared/protocol.js isCardBg), which every server since rel28 checks, so an
// older server keeps these ids. No 精一 card: the official 精一 has a picture of its own only for char_002_amiya (skin_table
// buildinEvolveMap), not in this game. A 精二 card animates the operator's 精二 动态立绘 (chars[id].dynamicE2) like a skin card.
// 名片-only skins (NAMECARD_SKINS, the owner's decision of 2026-11-16): 阿米娅's 术师 / 近卫 skins (official charId
// char_002_amiya; tmplId char_002_amiya / char_1001_amiya2) — forms this game does not field, so never in OPERATOR_SKINS —
// are `skin:<key>` cards in 医疗阿米娅's group, their art in assets.json namecardSkins[key] (the fields of skins[key]).
// The official 名片 (display_meta_table nameCardV2Data) shows its 名片形象 in that operator's current look (默认服装 / 精二 /
// a 时装 owned); this game has no progression, so every look of every operator is open.
// The pick is kept in the browser (NAMECARD_PREF) and travels with room.card (ui/playerCard.js) so teammates see it.
// The part of a picture the plate shows (feedback #61; #129, the owner's plan of 2026-11-03: moved freely and zoomed, as the
// seat card's 调整立绘): `x` / `y` in percent and `zoom` in percent of the cover size (NAMECARD_X_PREF / NAMECARD_Y_PREF /
// NAMECARD_ZOOM_PREF, room.card bgX / bgY / bgZoom) — the picture's x% y% point sits on the plate's x% y% point and the
// picture is drawn `cover` × zoom about it, so one framing reads the same on plates of any shape (the picker's 9:2, a seat,
// 成就统计, the settlement); a faction emblem has nothing to crop. A rel28 server keeps bgY only (it ignores bgX / bgZoom):
// the plate then shows the picture centred at its normal size. Styles: --nc-x / --nc-y / --nc-z in css/screens/lobby.css.
// Styles: css/screens/lobby.css (.has-nc / .nc-layer / .nc-pick).
import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Icon } from './components.js';
import { data, useData } from '../data.js';
import { t, tName, N_ } from '../../../shared/i18n.js';
import { OPERATOR_SKINS } from '../../../shared/skins.js';
import { CARD_ROSTER } from '../../../shared/card-roster.js';
import { isCollabUrl } from '../../../shared/collabAssets.js';
import { DynamicIllustration } from './dynamicIllustration.js';
import { e2Dynamic } from './dynamicFraming.js';
import { CARD_LIMITS } from '../../../shared/protocol.js';

export const NAMECARD_PREF = 'room.namecard';
export const NAMECARD_Y_PREF = 'room.namecard.y';
export const NAMECARD_X_PREF = 'room.namecard.x';
export const NAMECARD_ZOOM_PREF = 'room.namecard.zoom';

/** A stored or received vertical position: an integer 0–100, else null (the card's default). @param {unknown} y */
export const namecardY = (y) => (Number.isInteger(y) && y >= 0 && y <= 100 ? y : null);
/** A stored or received horizontal position (#129): an integer 0–100, else null (centred). @param {unknown} x */
export const namecardX = namecardY;
/** The zoom limits (#129), in percent of the size that just covers the plate. */
export const NAMECARD_ZOOM = Object.freeze({ min: 100, max: CARD_LIMITS.bgZoomMax });
/** A stored or received zoom: an integer NAMECARD_ZOOM.min–max, else null (100). @param {unknown} z */
export const namecardZoom = (z) => (Number.isInteger(z) && z >= NAMECARD_ZOOM.min && z <= NAMECARD_ZOOM.max ? z : null);

/**
 * The default height of a card's picture (css/screens/lobby.css .nc-layer, .nc-layer--skin; a `char` card writes its own),
 * by the kind of picture (2026-11-16, chosen on contact sheets of 24 operators on the 9:2 and the seat plate): a skin's
 * 24 %; an operator's 默认 立绘 fills its canvas, the face near the top (the official half-body box — portraitBox — centred
 * at a median 20 % of the height, a skin's at 37 %): 6 %; its 精二 立绘 is a scene framed like a skin's (39 %): 26 %.
 */
export const NAMECARD_DEFAULT_Y = Object.freeze({ skin: 24, char: 6, charE2: 26, other: 50 });
const defaultY = (card) => (card?.kind === 'skin' ? NAMECARD_DEFAULT_Y.skin
  : card?.kind === 'char' ? (card.e2 ? NAMECARD_DEFAULT_Y.charE2 : NAMECARD_DEFAULT_Y.char) : NAMECARD_DEFAULT_Y.other);
/** The framing a card starts at: centred, its default height, the cover size. */
export const defaultFrame = (card) => ({ x: 50, y: defaultY(card), zoom: 100 });

/**
 * The pixels a picture of `aspect` (height / width) drawn `cover` × zoom/100 overhangs a plate of `width` × `height`,
 * across and down ([0, 0] while the picture is not measured).
 * @returns {[number, number]}
 */
export function namecardSpare({ width, height, aspect, zoom = 100 }) {
  if (!(aspect > 0) || !(width > 0) || !(height > 0)) return [0, 0];
  const s = Math.max(width, height / aspect) * (Math.max(NAMECARD_ZOOM.min, zoom) / 100);
  return [s - width, s * aspect - height];
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const follow = (v, d, spare) => (spare > 0 ? clamp(v - (d / spare) * 100, 0, 100) : v);

/**
 * The framing after dragging the picture by (dx, dy) px from `from` (#129): it follows the pointer — dragging right / down
 * shows more of its left / top; an axis with nothing to spare keeps its value. Not rounded (a drag in progress draws
 * smoothly; roundFrame before it is stored).
 * @param {{ x: number, y: number, zoom: number }} from @param {number} dx @param {number} dy
 * @param {{ width: number, height: number, aspect: number }} plate
 */
export function dragNamecard(from, dx, dy, plate) {
  const [sx, sy] = namecardSpare({ ...plate, zoom: from.zoom });
  return { x: follow(from.x, dx, sx), y: follow(from.y, dy, sy), zoom: from.zoom };
}

/** A framing with its zoom clamped to NAMECARD_ZOOM (the position stays: the zoom is about that point). */
export const zoomNamecard = (from, zoom) => ({ ...from, zoom: clamp(Number.isFinite(zoom) ? zoom : 100, NAMECARD_ZOOM.min, NAMECARD_ZOOM.max) });

/** The integers a framing is stored and sent as. */
export const roundFrame = (f) => ({ x: Math.round(clamp(f.x, 0, 100)), y: Math.round(clamp(f.y, 0, 100)),
  zoom: Math.round(clamp(f.zoom, NAMECARD_ZOOM.min, NAMECARD_ZOOM.max)) });

/**
 * The vertical position after dragging by `dy` px at the cover size (feedback #61's rule, kept for its callers).
 * @returns {number} an integer 0–100; `from` when the whole height already shows
 */
export function dragNamecardY(from, dy, { width, height, aspect }) {
  const [, spare] = namecardSpare({ width, height, aspect });
  if (!(spare > 0)) return from;
  return Math.round(follow(from, dy, spare));
}

/** The loading pictures (one per simulation difficulty). */
const LOADING = [
  { key: 'prototype', name: N_('模拟·原型') },
  { key: 'core', name: N_('模拟·核心') },
  { key: 'hard', name: N_('模拟·险境') },
  { key: 'abyss', name: N_('模拟·终极') },
];

/** The factions with an emblem in the material, each with a tint for the card behind the white emblem. */
const CAMPS = [
  { key: 'rhodes', name: N_('罗德岛'), tint: '#1f3a4a' },
  { key: 'lungmen', name: N_('龙门'), tint: '#5a2a1c' },
  { key: 'yan', name: N_('炎'), tint: '#6a1f1f' },
  { key: 'higashi', name: N_('东'), tint: '#5c2a3e' },
  { key: 'victoria', name: N_('维多利亚'), tint: '#2a3358' },
  { key: 'kazimierz', name: N_('卡西米尔'), tint: '#4a3b1c' },
  { key: 'laterano', name: N_('拉特兰'), tint: '#5a4c1e' },
  { key: 'leithanien', name: N_('莱塔尼亚'), tint: '#3c2a52' },
  { key: 'columbia', name: N_('哥伦比亚'), tint: '#1f3f58' },
  { key: 'ursus', name: N_('乌萨斯'), tint: '#3a3a3a' },
  { key: 'siracusa', name: N_('叙拉古'), tint: '#4a1e2a' },
  { key: 'iberia', name: N_('伊比利亚'), tint: '#1e3c3c' },
  { key: 'egir', name: N_('阿戈尔'), tint: '#163a4e' },
  { key: 'sargon', name: N_('萨尔贡'), tint: '#5a4418' },
  { key: 'kjerag', name: N_('谢拉格'), tint: '#2c4656' },
  { key: 'sami', name: N_('萨米'), tint: '#24443a' },
  { key: 'minos', name: N_('米诺斯'), tint: '#4e3220' },
  { key: 'bolivar', name: N_('玻利瓦尔'), tint: '#2e4a22' },
  { key: 'rim', name: N_('雷姆必拓'), tint: '#4a3420' },
];

/**
 * The organisations with an emblem (feedback #89; the official names of handbook_team_table). The client's emblem bundle
 * (spritepack/ui_camp_logo) has none for 整合运动, and those that repeat the 罗德岛 mark are left out.
 */
const ORGS = [
  { key: 'babel', name: N_('巴别塔'), tint: '#3a3026' },
  { key: 'rhine', name: N_('莱茵生命'), tint: '#1e3a4a' },
  { key: 'penguin', name: N_('企鹅物流'), tint: '#3f3a1c' },
  { key: 'blacksteel', name: N_('黑钢国际'), tint: '#2c2f33' },
  { key: 'karlan', name: N_('喀兰贸易'), tint: '#2a4050' },
  { key: 'glasgow', name: N_('格拉斯哥帮'), tint: '#3a2a2e' },
  { key: 'abyssal', name: N_('深海猎人'), tint: '#14343f' },
  { key: 'siesta', name: N_('汐斯塔'), tint: '#4a3a22' },
  { key: 'dublinn', name: N_('深池'), tint: '#2c3f2a' },
  { key: 'followers', name: N_('使徒'), tint: '#2e2a4a' },
  { key: 'lgd', name: N_('龙门近卫局'), tint: '#512a22' },
  { key: 'pinus', name: N_('红松骑士团'), tint: '#4a2420' },
  { key: 'chiave', name: N_('贾维团伙'), tint: '#2a4438' },
  { key: 'lee', name: N_('鲤氏侦探事务所'), tint: '#3f3320' },
  { key: 'rainbow', name: N_('彩虹小队'), tint: '#2c3440' },
  { key: 'student', name: N_('乌萨斯学生自治团'), tint: '#3c3c44' },
  { key: 'sui', name: N_('炎-岁'), tint: '#5a2a20' },
  { key: 'sweep', name: N_('S.W.E.E.P.'), tint: '#2a3a36' },
  { key: 'elite', name: N_('罗德岛-精英干员'), tint: '#22323e' },
  { key: 'action4', name: N_('行动组A4'), tint: '#2a3640' },
  { key: 'reserve1', name: N_('行动预备组A1'), tint: '#2a3a44' },
  { key: 'reserve4', name: N_('行动预备组A4'), tint: '#2a3a44' },
  { key: 'reserve6', name: N_('行动预备组A6'), tint: '#2a3a44' },
];

const campCard = (c) => Object.freeze({ id: `camp:${c.key}`, kind: 'camp', name: c.name, tint: c.tint, assetKey: `campLogo/logo_${c.key}` });
const ORG_IDS = new Set(ORGS.map((c) => `camp:${c.key}`));

/** Every card: { id, kind, name, assetKey, tint? }. */
export const NAMECARDS = Object.freeze([
  ...LOADING.map((c) => Object.freeze({ id: `loading:${c.key}`, kind: 'loading', name: c.name, assetKey: `loading/loading_ac_${c.key}` })),
  ...CAMPS.map(campCard),
  ...ORGS.map(campCard),
]);
const BY_ID = new Map(NAMECARDS.map((c) => [c.id, c]));

/**
 * 名片-only skins (header): { id (the manifest key: the official skin id with '@' / '#' as '_'), officialId, charId (the
 * operator of this game whose group shows it), form (the official form's 职业), name, brand }.
 */
export const NAMECARD_SKINS = Object.freeze([
  { id: 'char_002_amiya_winter_1', officialId: 'char_002_amiya@winter#1', charId: 'char_1037_amiya3', form: N_('术师'), name: N_('报童'), brand: N_('忒斯特收藏') },
  { id: 'char_002_amiya_epoque_4', officialId: 'char_002_amiya@epoque#4', charId: 'char_1037_amiya3', form: N_('术师'), name: N_('见习联结者'), brand: N_('忒斯特收藏') },
  { id: 'char_002_amiya_test_1', officialId: 'char_002_amiya@test#1', charId: 'char_1037_amiya3', form: N_('术师'), name: N_('播种者'), brand: N_('忒斯特收藏') },
  { id: 'char_1001_amiya2_sale_16', officialId: 'char_1001_amiya2@sale#16', charId: 'char_1037_amiya3', form: N_('近卫'), name: N_('于万千宇宙之中'), brand: N_('忒斯特收藏') },
  { id: 'char_1001_amiya2_casc_1', officialId: 'char_1001_amiya2@casc#1', charId: 'char_1037_amiya3', form: N_('近卫'), name: N_('触及星辰'), brand: N_('合作款') },
].map((s) => Object.freeze(s)));
/** The 职业 of an operator's own looks in a group that also has 名片-only skins (医疗阿米娅's). */
const OWN_FORM = Object.freeze({ char_1037_amiya3: N_('医疗') });

/**
 * The skins' cards: { id: 'skin:<skin id>', kind: 'skin', name, skinId, charId } — a 名片-only skin's also `only: true`
 * and its `form`.
 */
const SKIN_CARDS = new Map([
  ...OPERATOR_SKINS.map((s) => [`skin:${s.id}`, Object.freeze({ id: `skin:${s.id}`, kind: 'skin', name: s.name, skinId: s.id, charId: s.charId })]),
  ...NAMECARD_SKINS.map((s) => [`skin:${s.id}`, Object.freeze({ id: `skin:${s.id}`, kind: 'skin', name: s.name, skinId: s.id, charId: s.charId, only: true, form: s.form })]),
]);

/** The card id of an operator's own 默认 (`e2` false) or 精二 立绘 (header). */
export const charCardId = (charId, e2) => `char:${charId}_${e2 ? 2 : 1}`;
/** The operators' own cards: { id: 'char:<charId>_1|2', kind: 'char', e2, name, charId, rarity } of shared/card-roster.js. */
const CHAR_CARDS = new Map(CARD_ROSTER.flatMap((r) => [false, true].map((e2) => {
  const id = charCardId(r.charId, e2);
  return [id, Object.freeze({ id, kind: 'char', e2, name: r.name, charId: r.charId, rarity: r.rarity })];
})));

/** The card of an id, or null (unknown / empty). @param {unknown} id */
export function namecardOf(id) {
  return typeof id === 'string' ? BY_ID.get(id) || SKIN_CARDS.get(id) || CHAR_CARDS.get(id) || null : null;
}

/**
 * Whether a plate has a card to draw behind it (`.has-nc`): a known id. An id this build does not know (a newer page's)
 * leaves the plate as without one.
 */
export const hasNamecard = (id) => !!namecardOf(id);

const safeUrl = (src) => (typeof src === 'string' && src && !/["\\)]/.test(src) ? src : null);
const own = (o, k) => (o && typeof o === 'object' && typeof k === 'string' && Object.hasOwn(o, k) ? o[k] : null);
/** The art record of a skin card: skins[id], a 名片-only skin's namecardSkins[id]. */
const skinRecord = (card, m) => own(card.only ? m?.namecardSkins : m?.skins, card.skinId);

/**
 * The picture of a card in the loaded asset index, or null (a skin / an operator's look: its full illustration, `half`
 * its half-body art — only while the full one is there; never a collab one).
 */
export function namecardSrc(card, m = data.get('assets'), half = false) {
  if (card?.kind === 'skin') {
    const s = skinRecord(card, m);
    if (!safeUrl(s?.illustration) || isCollabUrl(s.illustration)) return null;
    const url = half ? s.portrait : s.illustration;
    return isCollabUrl(url) ? null : safeUrl(url);
  }
  if (card?.kind === 'char') {
    const c = own(m?.chars, card.charId);
    const full = c?.[card.e2 ? 'illustrationE2' : 'illustration'];
    if (!safeUrl(full) || isCollabUrl(full)) return null;
    const url = half ? c[card.e2 ? 'portraitE2' : 'portrait'] : full;
    return isCollabUrl(url) ? null : safeUrl(url);
  }
  return safeUrl(card && m?.ui && typeof m.ui === 'object' ? m.ui[card.assetKey] : null);
}

/**
 * The 动态立绘 of a card, or null — never a collab one (see the header): a skin card's skin's (`skins[id].dynamic`, a
 * 名片-only skin's namecardSkins[id].dynamic), a 精二 card's operator's 精二 one (chars[id].dynamicE2, ui/dynamicFraming.js
 * e2Dynamic) while its static 精二 立绘 is there.
 */
export function namecardDynamic(card, m = data.get('assets')) {
  if (card?.kind === 'char') return card.e2 && namecardSrc(card, m) ? e2Dynamic(m, card.charId) : null;
  if (card?.kind !== 'skin') return null;
  const s = skinRecord(card, m);
  const dyn = s?.dynamic;
  return dyn && typeof dyn.skel === 'string' && !isCollabUrl(dyn.skel) && !isCollabUrl(s.illustration) ? dyn : null;
}

const byRarityName = (a, b) => ((b.rarity ?? 0) - (a.rarity ?? 0)) || String(a.name).localeCompare(String(b.name), 'zh');

/**
 * The 干员立绘 section of the picker (the owner's decision of 2026-11-16): one group per operator, in the 名片干员 picker's
 * order (rarity, then name: ui/seatArt.js cardOperators) — its 默认 and 精二 立绘, then its skins (shared/skins.js order), then
 * its 名片-only skins — each only when the art index has its full picture (a missing one has no tile; an operator with
 * none has no group). Tiles: { id, label, sub?, form?, dyn }: `form` the 职业 in a group that mixes forms, `dyn` a 动态立绘.
 * @returns {{ charId: string, name: string, rarity: number, tiles: { id: string, label: string, sub?: string, form?: string, dyn: boolean }[] }[]}
 */
export function namecardArtGroups(m = data.get('assets')) {
  const groups = new Map(CARD_ROSTER.map((r) => [r.charId, { charId: r.charId, name: r.name, rarity: r.rarity, tiles: [] }]));
  const tile = (id, label, sub) => {
    const c = namecardOf(id);
    return c && namecardSrc(c, m) ? { id, label, ...(sub ? { sub } : {}), ...(c.form ? { form: c.form } : {}), dyn: !!namecardDynamic(c, m) } : null;
  };
  const add = (charId, name, x) => {
    if (!x) return;
    if (!groups.has(charId)) groups.set(charId, { charId, name, rarity: 0, tiles: [] });
    groups.get(charId).tiles.push(x);
  };
  for (const r of CARD_ROSTER) {
    add(r.charId, r.name, tile(charCardId(r.charId, false), N_('默认')));
    add(r.charId, r.name, tile(charCardId(r.charId, true), N_('精英二')));
  }
  for (const s of OPERATOR_SKINS) add(s.charId, s.charName || s.charId, tile(`skin:${s.id}`, s.name, s.brand));
  for (const s of NAMECARD_SKINS) add(s.charId, s.charId, tile(`skin:${s.id}`, s.name, s.brand));
  const out = [...groups.values()].filter((g) => g.tiles.length);
  // a group mixing forms (医疗阿米娅 and 阿米娅's 术师 / 近卫 skins) names the form of each tile
  for (const g of out) {
    if (g.tiles.some((x) => x.form) && OWN_FORM[g.charId]) g.tiles = g.tiles.map((x) => (x.form ? x : { ...x, form: OWN_FORM[g.charId] }));
  }
  return out.sort(byRarityName);
}

/** The groups and tiles a search shows: the whole group when the operator's name matches, else the tiles that do. */
export function filterArtGroups(groups, needle) {
  const q = String(needle || '').trim().toLowerCase();
  if (!q) return groups;
  const has = (...xs) => xs.some((x) => x && String(x).toLowerCase().includes(q));
  const out = [];
  for (const g of groups) {
    if (has(tName(g.name), g.name)) { out.push(g); continue; }
    const tiles = g.tiles.filter((x) => has(t(x.label), x.sub && t(x.sub), x.form && t(x.form)));
    if (tiles.length) out.push({ ...g, tiles });
  }
  return out;
}

/** A framing value in range (a drag in progress is fractional), else null. */
const inRange = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const pct = (v) => `${Math.round(v * 100) / 100}%`;

/**
 * The card behind a name plate (the room's seat cards, the 成就统计 card, the settlement plates, the draft rows): put it
 * inside a `.has-nc` element; nothing for no / an unknown card. A picture card draws in .nc-layer__pic, framed by x / y /
 * zoom (header); a faction emblem ignores them.
 * @param {{ card: string|null|undefined, y?: number|null, x?: number|null, zoom?: number|null }} props room.card bgY / bgX / bgZoom
 */
export function NameCardLayer({ card, y = null, x = null, zoom = null }) {
  useData('assets');
  const nc = namecardOf(card);
  const src = namecardSrc(nc);
  if (!nc || !src) return null;
  if (!adjustable(nc)) {
    return html`<span class=${`nc-layer nc-layer--${nc.kind}`} style=${`--nc:url("${src}")${nc.tint ? `; --nc-tint:${nc.tint}` : ''}`} aria-hidden="true"></span>`;
  }
  const py = inRange(y, 0, 100), px = inRange(x, 0, 100), z = inRange(zoom, NAMECARD_ZOOM.min, NAMECARD_ZOOM.max);
  const dyn = namecardDynamic(nc);
  // an operator's own look carries its default height (the CSS holds a skin's and the rest's)
  const shownY = py ?? (nc.kind === 'char' ? defaultY(nc) : null);
  const style = `--nc:url("${src}")${px == null ? '' : `; --nc-x:${pct(px)}`}${shownY == null ? '' : `; --nc-y:${pct(shownY)}`}${z == null || z === 100 ? '' : `; --nc-z:${z / 100}`}`;
  return html`<span class=${`nc-layer nc-layer--${nc.kind}`} style=${style} aria-hidden="true"><span class="nc-layer__pic"></span>${
    dyn ? html`<${DynamicIllustration} mode="cover" entry=${dyn} framing=${{ focusX: px ?? 50, focusY: py ?? defaultY(nc), zoom: (z ?? 100) / 100 }} />` : null}</span>`;
}

/** Whether a card has a picture to crop (a faction emblem does not). @param {any} nc */
const adjustable = (nc) => !!nc && nc.kind !== 'camp';

/** A tile whose half-body art did not load shows its name alone (no broken-image mark). */
const hideBroken = (e) => e.currentTarget.classList.add('is-broken');

const SETTLE_MS = 450;
const ZOOM_STEP = 1.25;

/**
 * 调整位置和缩放 (feedback #61, #129): a plate of the seat's shape to drag the picture around (both ways), the wheel / a pinch /
 * − + and the slider to zoom, the arrow keys (Shift: ×5) and + / − on the focused plate; 恢复默认 back to the card's
 * default. `onAdjust(frame)` gets the rounded framing when a drag ends or a zoom settles (room.card is rate-limited, so
 * not on every move), null for the default.
 */
function NameCardAdjust({ card, x = null, y = null, zoom = null, onAdjust, onDone }) {
  const nc = namecardOf(card);
  const src = namecardSrc(nc);
  const def = defaultFrame(nc);
  const [frame, setFrame] = useState({ x: namecardX(x) ?? def.x, y: namecardY(y) ?? def.y, zoom: namecardZoom(zoom) ?? def.zoom });
  const live = useRef(frame); live.current = frame;
  const report = useRef(onAdjust); report.current = onAdjust;
  const plate = useRef(null), aspect = useRef(0), drag = useRef(null), pointers = useRef(new Map()), settle = useRef(null);
  useEffect(() => {
    const img = new Image();
    img.onload = () => { if (img.naturalWidth) aspect.current = img.naturalHeight / img.naturalWidth; };
    if (src) img.src = src;
  }, [src]);
  // closed (✕, Esc, the backdrop) while a zoom is still settling: it is kept, as 完成 would
  useEffect(() => () => { if (settle.current) { clearTimeout(settle.current); settle.current = null; report.current(roundFrame(live.current)); } }, []);
  // a picture still loading counts as square, as most illustrations are: the plate never ignores the drag
  const box = () => { const r = plate.current?.getBoundingClientRect(); return { width: r?.width || 0, height: r?.height || 0, aspect: aspect.current || 1 }; };
  const commit = (f) => { clearTimeout(settle.current); settle.current = null; const out = roundFrame(f); setFrame(out); onAdjust(out); };
  const later = (f) => { setFrame(f); clearTimeout(settle.current); settle.current = setTimeout(() => commit(f), SETTLE_MS); };
  const zoomBy = (factor) => later(zoomNamecard(live.current, live.current.zoom * factor));
  const onDown = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, [e.clientX, e.clientY]);
    const pts = [...pointers.current.values()];
    drag.current = { start: live.current, x: e.clientX, y: e.clientY, dist: pts.length === 2 ? Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) : 0 };
  };
  const onMove = (e) => {
    const d = drag.current;
    if (!d || !pointers.current.has(e.pointerId) || !plate.current) return;
    pointers.current.set(e.pointerId, [e.clientX, e.clientY]);
    const pts = [...pointers.current.values()];
    d.moved = true;
    if (pts.length === 2 && d.dist > 0) setFrame(zoomNamecard(d.start, d.start.zoom * Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) / d.dist));
    else setFrame(dragNamecard(d.start, e.clientX - d.x, e.clientY - d.y, box()));
  };
  const onUp = (e) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size) { const [rest] = pointers.current.values(); drag.current = { start: live.current, x: rest[0], y: rest[1], dist: 0, moved: !!drag.current?.moved }; return; }
    // a tap is no change (room.card is rate-limited)
    if (drag.current) { const { moved } = drag.current; drag.current = null; if (moved) commit(live.current); }
  };
  const onWheel = (e) => { e.preventDefault(); zoomBy(Math.exp(-e.deltaY * 0.0015)); };
  const onKey = (e) => {
    const step = e.shiftKey ? 5 : 1;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      e.preventDefault();
      const f = live.current;
      // the arrow moves the picture the way it points (as a drag would): → shows more of its left
      later({ ...f, x: clamp(f.x + moves[e.key][0], 0, 100), y: clamp(f.y + moves[e.key][1], 0, 100) });
    } else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(ZOOM_STEP); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(1 / ZOOM_STEP); }
  };
  const z = Math.round(frame.zoom);
  return html`<div class="nc-adjust">
    <div class="nc-adjust__plate has-nc" ref=${plate} data-testid="nc-adjust-plate" tabIndex="0" role="application"
        aria-label=${t('拖动调整位置，滚轮或双指缩放')}
        onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp} onPointerCancel=${onUp} onWheel=${onWheel} onKeyDown=${onKey}>
      <${NameCardLayer} card=${card} x=${frame.x} y=${frame.y} zoom=${frame.zoom} />
      <span class="nc-adjust__hint"><${Icon} name="expand" />${t('拖动调整位置，滚轮或双指缩放')}</span>
    </div>
    <div class="nc-adjust__zoom">
      <button type="button" class="nc-adjust__btn nc-adjust__btn--sq" data-testid="nc-adjust-out" onClick=${() => zoomBy(1 / ZOOM_STEP)}
        disabled=${z <= NAMECARD_ZOOM.min} aria-label=${t('缩小')}><${Icon} name="minus" /></button>
      <input type="range" class="nc-adjust__range" data-testid="nc-adjust-zoom" min=${NAMECARD_ZOOM.min} max=${NAMECARD_ZOOM.max} step="1" value=${z}
        aria-label=${t('缩放')} onInput=${(e) => setFrame(zoomNamecard(live.current, Number(e.currentTarget.value)))}
        onChange=${(e) => commit(zoomNamecard(live.current, Number(e.currentTarget.value)))} />
      <button type="button" class="nc-adjust__btn nc-adjust__btn--sq" data-testid="nc-adjust-in" onClick=${() => zoomBy(ZOOM_STEP)}
        disabled=${z >= NAMECARD_ZOOM.max} aria-label=${t('放大')}><${Icon} name="plus" /></button>
      <b class="nc-adjust__pct num" data-testid="nc-adjust-pct">${z}%</b>
    </div>
    <div class="nc-adjust__foot">
      <button type="button" class="nc-adjust__btn" data-testid="nc-adjust-reset" onClick=${() => { clearTimeout(settle.current); settle.current = null; setFrame(def); onAdjust(null); }}>${t('恢复默认')}</button>
      <button type="button" class="nc-adjust__btn nc-adjust__btn--go" data-testid="nc-adjust-done" onClick=${() => { if (settle.current) commit(live.current); onDone(); }}>${t('完成')}</button>
    </div>
  </div>`;
}

/** The 干员立绘 groups the picker renders at once, and how many more it adds per step (NameCardPicker). */
const FIRST_GROUPS = 24, MORE_GROUPS = 48;

/** One operator's group of the picker: its name, rarity and tiles (`tile(g, x)` renders one). */
function OpGroup({ g, tile }) {
  return html`<section class="nc-pick__op" data-char=${g.charId}>
    <h5 class="nc-pick__op-name">${tName(g.name)}${g.rarity ? html`<small class=${`nc-pick__op-star r${g.rarity}`}>${g.rarity}★</small>` : null}</h5>
    ${g.tiles.map((x) => tile(g, x))}</section>`;
}

/**
 * 名片底图 picker: 不使用底图 and every card; picking a card with a picture goes on to its framing (`onAdjust`: a rounded
 * { x, y, zoom }, null for the default), any other closes it. Esc / the backdrop close it too.
 */
export function NameCardPicker({ current, y = null, x = null, zoom = null, onPick, onAdjust = null, onClose }) {
  useData('assets');
  const m = data.get('assets');
  const [q, setQ] = useState('');
  const [adjusting, setAdjusting] = useState(false);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  const pick = (id) => {
    onPick(id);
    if (onAdjust && adjustable(namecardOf(id))) setAdjusting(true);
    else onClose();
  };
  const card = (c) => html`<button key=${c.id} type="button" class=${`nc-pick__card${current === c.id ? ' is-on' : ''}`} onClick=${() => pick(c.id)} title=${t(c.name)}>
    <span class="nc-pick__art has-nc"><${NameCardLayer} card=${c.id} /><span class="nc-pick__name">${t(c.name)}</span></span>
    ${current === c.id ? html`<span class="nc-pick__on">${t('使用中')}</span>` : null}</button>`;
  // 干员立绘 (namecardArtGroups): a group per operator — 默认, 精二, its skins —, searchable by operator, skin, brand or
  // form; tiles show the half-body art (lazy). ~860 tiles: the picker opens with the first FIRST_GROUPS groups and adds
  // MORE_GROUPS a frame later until all are in (each group an OpGroup whose element is kept while its tiles and the pick
  // in it stay, so a step renders only the new groups); a group off screen is neither laid out nor painted (lobby.css
  // .nc-pick__op content-visibility). Full resolution, no paging.
  const groups = useMemo(() => namecardArtGroups(m), [m]);
  const shown = filterArtGroups(groups, q);
  const [upTo, setUpTo] = useState(FIRST_GROUPS);
  const all = upTo >= groups.length;
  useEffect(() => {
    if (adjusting || all) return undefined;
    const id = setTimeout(() => setUpTo((n) => n + MORE_GROUPS), 16);
    return () => clearTimeout(id);
  }, [upTo, adjusting, all]);
  const grid = useRef(null), scrolled = useRef(false), kept = useRef(new Map());
  // opened on an operator's look or a skin: its tile in view once every group is in (unless the list was scrolled already)
  useEffect(() => {
    const kind = namecardOf(current)?.kind;
    if (adjusting || !all || scrolled.current || (kind !== 'char' && kind !== 'skin')) return;
    scrolled.current = true;
    if (grid.current && grid.current.scrollTop > 0) return;
    grid.current?.querySelector('.nc-pick__op .nc-pick__card.is-on')?.scrollIntoView?.({ block: 'center' });
  }, [adjusting, all]);
  const artTile = (g, x) => {
    const src = namecardSrc(namecardOf(x.id), m, true), on = current === x.id;
    return html`<button key=${x.id} type="button" class=${`nc-pick__card nc-pick__card--skin${on ? ' is-on' : ''}`} data-nc=${x.id} onClick=${() => pick(x.id)}
        title=${`${tName(g.name)} · ${x.form ? `${t(x.form)} · ` : ''}${t(x.label)}`}>
      <span class="nc-pick__art nc-pick__art--skin">${src ? html`<img src=${src} alt="" loading="lazy" decoding="async" draggable=${false} onError=${hideBroken} />` : null}
        <span class="nc-pick__name">${t(x.label)}${x.sub || x.form ? html`<small>${x.form ? html`<span class="nc-pick__form">${t(x.form)}</span>` : null}${x.sub ? t(x.sub) : null}</small>` : null}</span>
        ${x.dyn ? html`<span class="nc-pick__dyn" title=${t('动态立绘')}>${t('动态立绘')}</span>` : null}</span>
      ${on ? html`<span class="nc-pick__on">${t('使用中')}</span>` : null}</button>`;
  };
  return html`<div class="nc-pick" role="presentation" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="nc-pick__panel" role="dialog" aria-modal="true" aria-label=${t('名片底图')}>
      <header class="nc-pick__head"><strong>NAME CARD</strong><span class="nc-pick__title">${t('名片底图')}</span>
        <button type="button" class="nc-pick__x" onClick=${onClose} aria-label=${t('关闭')}><${Icon} name="close" /></button></header>
      ${adjusting && namecardOf(current) ? html`<${NameCardAdjust} key=${current} card=${current} x=${x} y=${y} zoom=${zoom} onAdjust=${onAdjust} onDone=${onClose} />` : html`<div class="nc-pick__grid" ref=${grid}>
        <button type="button" class=${`nc-pick__card nc-pick__card--none${!namecardOf(current) ? ' is-on' : ''}`} onClick=${() => pick('')}>
          <span class="nc-pick__art"><${Icon} name="close" /><span class="nc-pick__name">${t('不使用底图')}</span></span></button>
        <h4 class="nc-pick__theme">${t('模拟场景')}</h4>
        ${NAMECARDS.filter((c) => c.kind === 'loading').map(card)}
        <h4 class="nc-pick__theme">${t('阵营徽记')}</h4>
        ${NAMECARDS.filter((c) => c.kind === 'camp' && !ORG_IDS.has(c.id)).map(card)}
        <h4 class="nc-pick__theme">${t('组织徽记')}</h4>
        ${NAMECARDS.filter((c) => ORG_IDS.has(c.id)).map(card)}
        <h4 class="nc-pick__theme nc-pick__theme--skins">${t('干员立绘')}
          <input type="search" class="nc-pick__search" value=${q} placeholder=${t('搜索干员或皮肤')} onInput=${(e) => setQ(e.currentTarget.value)} /></h4>
        ${shown.slice(0, upTo).map((g) => {
          // the same element while the group and its pick are the same: Preact skips it (no re-render of its tiles)
          const on = g.tiles.some((x) => x.id === current) ? current : '';
          const k = kept.current.get(g.charId);
          if (k && k.g === g && k.on === on) return k.v;
          const v = html`<${OpGroup} key=${g.charId} g=${g} tile=${artTile} />`;
          kept.current.set(g.charId, { g, on, v });
          return v;
        })}
        ${!shown.length ? html`<p class="nc-pick__empty">${t('没有匹配的干员或皮肤')}</p>` : null}
      </div>`}
      <footer class="nc-pick__foot"><small>${t('名片底图显示在同盟席位的名牌后面，同盟里的博士都能看到')}</small>
        ${!adjusting && onAdjust && adjustable(namecardOf(current)) ? html`<button type="button" class="nc-adjust__btn nc-adjust__btn--go" data-testid="nc-adjust-open" onClick=${() => setAdjusting(true)}>
          <${Icon} name="expand" />${t('调整位置和缩放')}</button>` : null}</footer>
    </div>
  </div>`;
}
