// 名片底图 (2026-10-14, the owner's decision: the room design by 雨千代chiyo had name-card art from its account service;
// here the backgrounds come from material this server already has, no new art): the four simulation loading pictures
// (assets.json ui['loading/loading_ac_*']) and the faction and organisation emblems (ui['campLogo/logo_*'], white on the
// faction's colour). A card id is `loading:<key>` or `camp:<key>`; an unknown id (an older or newer client's) shows nothing.
// `skin:<skin id>` (feedback #24, the owner's decision of 2026-10-17): an operator skin's full illustration (assets.json
// skins[id].illustration, ~4 MB — only the plates that use it load it; the picker shows the skins' half-body art).
// The pick is kept in the browser (NAMECARD_PREF) and travels with room.card (ui/playerCard.js) so teammates see it.
// The part of a picture the plate shows (feedback #61): dragged up and down in the picker, `y` in percent (NAMECARD_Y_PREF,
// room.card bgY); a faction emblem has nothing to crop. Styles: --nc-y in css/screens/lobby.css.
// Styles: css/screens/lobby.css (.has-nc / .nc-layer / .nc-pick).
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Icon } from './components.js';
import { data, useData } from '../data.js';
import { t, N_ } from '../../../shared/i18n.js';
import { OPERATOR_SKINS } from '../../../shared/skins.js';

export const NAMECARD_PREF = 'room.namecard';
export const NAMECARD_Y_PREF = 'room.namecard.y';

/** A stored or received vertical position: an integer 0–100, else null (the card's default). @param {unknown} y */
export const namecardY = (y) => (Number.isInteger(y) && y >= 0 && y <= 100 ? y : null);

/** The default position of a card (css/screens/lobby.css .nc-layer, .nc-layer--skin). */
const defaultY = (card) => (card?.kind === 'skin' ? 24 : 50);

/**
 * The position after dragging a picture of `aspect` (height / width) by `dy` px in a plate of `width` × `height` drawn
 * `background-size: cover`: the picture follows the pointer (dragging down shows more of its top).
 * @returns {number} an integer 0–100; `from` when the whole height already shows
 */
export function dragNamecardY(from, dy, { width, height, aspect }) {
  const spare = width * aspect - height;
  if (!(spare > 0)) return from;
  return Math.max(0, Math.min(100, Math.round(from - (dy / spare) * 100)));
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
    return safeUrl(half ? s?.portrait : s?.illustration);
  }
  return safeUrl(card && m?.ui && typeof m.ui === 'object' ? m.ui[card.assetKey] : null);
}

/**
 * The card behind a name plate (the room's seat cards, the 成就统计 card, the top bar's chip): put it inside a
 * `.has-nc` element; nothing for no / an unknown card.
 * @param {{ card: string|null|undefined, y?: number|null }} props `y`: room.card bgY
 */
export function NameCardLayer({ card, y = null }) {
  useData('assets');
  const nc = namecardOf(card);
  const src = namecardSrc(nc);
  if (!nc || !src) return null;
  const pos = namecardY(y);
  return html`<span class=${`nc-layer nc-layer--${nc.kind}`} style=${`--nc:url("${src}")${nc.tint ? `; --nc-tint:${nc.tint}` : ''}${pos == null ? '' : `; --nc-y:${pos}%`}`} aria-hidden="true"></span>`;
}

/** Whether a card has a picture to crop (a faction emblem does not). @param {any} nc */
const adjustable = (nc) => !!nc && nc.kind !== 'camp';

/** 调整显示范围 (feedback #61): a plate to drag up and down and the same as a slider, for a keyboard. */
function NameCardAdjust({ card, y, onAdjust, onDone }) {
  const nc = namecardOf(card);
  const src = namecardSrc(nc);
  const [pos, setPos] = useState(namecardY(y) ?? defaultY(nc));
  const plate = useRef(null);
  const aspect = useRef(0);
  const drag = useRef(null);
  useEffect(() => {
    const img = new Image();
    img.onload = () => { if (img.naturalWidth) aspect.current = img.naturalHeight / img.naturalWidth; };
    if (src) img.src = src;
  }, [src]);
  const onDown = (e) => { drag.current = { at: e.clientY, from: pos }; e.currentTarget.setPointerCapture?.(e.pointerId); };
  const onMove = (e) => {
    if (!drag.current || !plate.current) return;
    const { width, height } = plate.current.getBoundingClientRect();
    setPos(dragNamecardY(drag.current.from, e.clientY - drag.current.at, { width, height, aspect: aspect.current }));
  };
  const onUp = () => { if (drag.current) { drag.current = null; onAdjust(pos); } };
  return html`<div class="nc-adjust">
    <div class="nc-adjust__plate has-nc" ref=${plate} data-testid="nc-adjust-plate" onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp} onPointerCancel=${onUp}>
      <${NameCardLayer} card=${card} y=${pos} />
      <span class="nc-adjust__hint">${t('上下拖动调整显示范围')}</span>
    </div>
    <input type="range" class="nc-adjust__range" min="0" max="100" step="1" value=${pos} aria-label=${t('调整显示范围')}
      onInput=${(e) => setPos(Number(e.currentTarget.value))} onChange=${(e) => onAdjust(Number(e.currentTarget.value))} />
    <div class="nc-adjust__foot">
      <button type="button" class="nc-adjust__btn" onClick=${() => { setPos(defaultY(nc)); onAdjust(null); }}>${t('恢复默认')}</button>
      <button type="button" class="nc-adjust__btn nc-adjust__btn--go" data-testid="nc-adjust-done" onClick=${onDone}>${t('完成')}</button>
    </div>
  </div>`;
}

/**
 * 名片底图 picker: 不使用底图 and every card; picking a card with a picture goes on to its position (`onAdjust`), any
 * other closes it. Esc / the backdrop close it too.
 */
export function NameCardPicker({ current, y = null, onPick, onAdjust = null, onClose }) {
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
  const skins = OPERATOR_SKINS.filter((s) => m?.skins?.[s.id]?.illustration)
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
      ${adjusting && namecardOf(current) ? html`<${NameCardAdjust} key=${current} card=${current} y=${y} onAdjust=${onAdjust} onDone=${onClose} />` : html`<div class="nc-pick__grid">
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
        ${!adjusting && onAdjust && adjustable(namecardOf(current)) ? html`<button type="button" class="nc-adjust__btn" data-testid="nc-adjust-open" onClick=${() => setAdjusting(true)}>${t('调整显示范围')}</button>` : null}</footer>
    </div>
  </div>`;
}
