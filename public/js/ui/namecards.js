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
// The pick is kept in the browser (NAMECARD_PREF) and travels with room.card (ui/playerCard.js) so teammates see it.
// The part of a picture the plate shows (feedback #61; #129, the owner's plan of 2026-11-03: moved freely and zoomed, as the
// seat card's 调整立绘): `x` / `y` in percent and `zoom` in percent of the cover size (NAMECARD_X_PREF / NAMECARD_Y_PREF /
// NAMECARD_ZOOM_PREF, room.card bgX / bgY / bgZoom) — the picture's x% y% point sits on the plate's x% y% point and the
// picture is drawn `cover` × zoom about it, so one framing reads the same on plates of any shape (the picker's 9:2, a seat,
// 成就统计, the settlement); a faction emblem has nothing to crop. A rel28 server keeps bgY only (it ignores bgX / bgZoom):
// the plate then shows the picture centred at its normal size. Styles: --nc-x / --nc-y / --nc-z in css/screens/lobby.css.
// Styles: css/screens/lobby.css (.has-nc / .nc-layer / .nc-pick).
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Icon } from './components.js';
import { data, useData } from '../data.js';
import { t, N_ } from '../../../shared/i18n.js';
import { OPERATOR_SKINS } from '../../../shared/skins.js';
import { isCollabUrl } from '../../../shared/collabAssets.js';
import { DynamicIllustration } from './dynamicIllustration.js';
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

/** The default position of a card (css/screens/lobby.css .nc-layer, .nc-layer--skin). */
const defaultY = (card) => (card?.kind === 'skin' ? 24 : 50);
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
/** The skins' cards: { id: 'skin:<skin id>', kind: 'skin', name, skinId, charId }. */
const SKIN_CARDS = new Map(OPERATOR_SKINS.map((s) => [`skin:${s.id}`, Object.freeze({ id: `skin:${s.id}`, kind: 'skin', name: s.name, skinId: s.id, charId: s.charId })]));

/** The card of an id, or null (unknown / empty). @param {unknown} id */
export function namecardOf(id) {
  return typeof id === 'string' ? BY_ID.get(id) || SKIN_CARDS.get(id) || null : null;
}

const safeUrl = (src) => (typeof src === 'string' && src && !/["\\)]/.test(src) ? src : null);

/** The picture of a card in the loaded asset index, or null (a skin: its full illustration, `half` its half-body art). */
export function namecardSrc(card, m = data.get('assets'), half = false) {
  if (card?.kind === 'skin') {
    const s = m?.skins && typeof m.skins === 'object' && Object.hasOwn(m.skins, card.skinId) ? m.skins[card.skinId] : null;
    const url = half ? s?.portrait : s?.illustration;
    return isCollabUrl(url) ? null : safeUrl(url);
  }
  return safeUrl(card && m?.ui && typeof m.ui === 'object' ? m.ui[card.assetKey] : null);
}

/** The 动态立绘 of a skin card's skin (`skins[id].dynamic`), or null — never a collab one (see the header). */
export function namecardDynamic(card, m = data.get('assets')) {
  if (card?.kind !== 'skin') return null;
  const s = m?.skins && typeof m.skins === 'object' && Object.hasOwn(m.skins, card.skinId) ? m.skins[card.skinId] : null;
  const dyn = s?.dynamic;
  return dyn && typeof dyn.skel === 'string' && !isCollabUrl(dyn.skel) && !isCollabUrl(s.illustration) ? dyn : null;
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
  const style = `--nc:url("${src}")${px == null ? '' : `; --nc-x:${pct(px)}`}${py == null ? '' : `; --nc-y:${pct(py)}`}${z == null || z === 100 ? '' : `; --nc-z:${z / 100}`}`;
  return html`<span class=${`nc-layer nc-layer--${nc.kind}`} style=${style} aria-hidden="true"><span class="nc-layer__pic"></span>${
    dyn ? html`<${DynamicIllustration} mode="cover" entry=${dyn} framing=${{ focusX: px ?? 50, focusY: py ?? defaultY(nc), zoom: (z ?? 100) / 100 }} />` : null}</span>`;
}

/** Whether a card has a picture to crop (a faction emblem does not). @param {any} nc */
const adjustable = (nc) => !!nc && nc.kind !== 'camp';

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
  // the skins in the art index, searchable by skin, brand or operator name; tiles show the half-body art (lazy)
  const needle = q.trim().toLowerCase();
  const charName = (s) => String(s.charName || '');
  const skins = OPERATOR_SKINS.filter((s) => m?.skins?.[s.id]?.illustration && !isCollabUrl(m.skins[s.id].illustration))
    .filter((s) => !needle || [t(s.name), t(s.brand || ''), charName(s)].some((x) => x.toLowerCase().includes(needle)));
  const skinCard = (s) => { const id = `skin:${s.id}`, src = namecardSrc(namecardOf(id), m, true);
    return html`<button key=${id} type="button" class=${`nc-pick__card nc-pick__card--skin${current === id ? ' is-on' : ''}`} onClick=${() => pick(id)} title=${`${charName(s)} · ${t(s.name)}`}>
      <span class="nc-pick__art nc-pick__art--skin">${src ? html`<img src=${src} alt="" loading="lazy" draggable=${false} />` : null}
        <span class="nc-pick__name">${t(s.name)}<small>${charName(s)}</small></span></span>
      ${current === id ? html`<span class="nc-pick__on">${t('使用中')}</span>` : null}</button>`; };
  return html`<div class="nc-pick" role="presentation" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="nc-pick__panel" role="dialog" aria-modal="true" aria-label=${t('名片底图')}>
      <header class="nc-pick__head"><strong>NAME CARD</strong><span class="nc-pick__title">${t('名片底图')}</span>
        <button type="button" class="nc-pick__x" onClick=${onClose} aria-label=${t('关闭')}><${Icon} name="close" /></button></header>
      ${adjusting && namecardOf(current) ? html`<${NameCardAdjust} key=${current} card=${current} x=${x} y=${y} zoom=${zoom} onAdjust=${onAdjust} onDone=${onClose} />` : html`<div class="nc-pick__grid">
        <button type="button" class=${`nc-pick__card nc-pick__card--none${!namecardOf(current) ? ' is-on' : ''}`} onClick=${() => pick('')}>
          <span class="nc-pick__art"><${Icon} name="close" /><span class="nc-pick__name">${t('不使用底图')}</span></span></button>
        <h4 class="nc-pick__theme">${t('模拟场景')}</h4>
        ${NAMECARDS.filter((c) => c.kind === 'loading').map(card)}
        <h4 class="nc-pick__theme">${t('阵营徽记')}</h4>
        ${NAMECARDS.filter((c) => c.kind === 'camp' && !ORG_IDS.has(c.id)).map(card)}
        <h4 class="nc-pick__theme">${t('组织徽记')}</h4>
        ${NAMECARDS.filter((c) => ORG_IDS.has(c.id)).map(card)}
        <h4 class="nc-pick__theme nc-pick__theme--skins">${t('干员皮肤立绘')}
          <input type="search" class="nc-pick__search" value=${q} placeholder=${t('搜索皮肤或干员')} onInput=${(e) => setQ(e.currentTarget.value)} /></h4>
        ${skins.map(skinCard)}
      </div>`}
      <footer class="nc-pick__foot"><small>${t('名片底图显示在同盟席位的名牌后面，同盟里的博士都能看到')}</small>
        ${!adjusting && onAdjust && adjustable(namecardOf(current)) ? html`<button type="button" class="nc-adjust__btn nc-adjust__btn--go" data-testid="nc-adjust-open" onClick=${() => setAdjusting(true)}>
          <${Icon} name="expand" />${t('调整位置和缩放')}</button>` : null}</footer>
    </div>
  </div>`;
}
