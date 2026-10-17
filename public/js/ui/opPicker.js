// 干员选择器 (2026-10-14): the room's 名片干员 picker and the 头像 picker (the room's own seat plate, 统计数据's card) —
// search, rarity, the operators' avatars; the first tile clears the pick.
// 项目 5 (个性化, 2026-10-16): both pickers can also choose *which art* of that operator is shown — 精一 / 精二 / one of
// the operator's own skins (`variants`); the tile previews the selected variant and 确定 commits operator + variant.
import { useState } from '../../vendor/hooks.module.js';
import { html, Icon, Modal } from './components.js';
import { chessAvatarUrl } from './assetUrls.js';
import { cardAvatarUrl, cardSkins } from './seatArt.js';
import { CARD_SYNC } from './playerCard.js';
import { t } from '../../../shared/i18n.js';

/**
 * @param {{ title: any, micro: string, current: string, list: any[], m: any, faceOf?: (c: any, variant: string) => (string | null),
 *   autoLabel: any, autoTitle?: string, autoIcon?: string, note?: any, variant?: string, variants?: boolean,
 *   onPick: (charId: string, variant?: string) => void, onClose: Function }} props
 *   `list`: ui/seatArt.js cardOperators; `faceOf`: a tile's picture (default the record's avatar); `current` '' = the
 *   first tile (autoLabel), which picks ''. With `variants`, the tiles select (the modal stays open) and 确定 commits
 *   the operator together with the variant; without it a tile commits at once, as before.
 */
export function OperatorPicker({ title, micro, current, list, m, faceOf = (c) => chessAvatarUrl(m, c), autoLabel, autoTitle, autoIcon = 'refresh',
  note = null, variant = '', variants = false, onPick, onClose }) {
  const [q, setQ] = useState('');
  const [star, setStar] = useState(0);
  const [sel, setSel] = useState(current);
  const [art, setArt] = useState(variant === 'e2' ? '' : variant);
  const needle = q.trim().toLowerCase();
  const shown = list.filter((c) => (!star || c.rarity === star) && (!needle || String(c.name || '').toLowerCase().includes(needle)
    || String(c.appellation || '').toLowerCase().includes(needle)));
  const skins = variants && sel ? cardSkins(sel, m) : [];
  const chips = sel ? [['e1', t('精一')], ['', t('精二')], ...skins.map((s) => [`skin:${s.id}`, s.name])] : [];
  const pickTile = (charId) => {
    if (!variants || !charId) { onPick(charId); return; }
    setSel(charId);
    setArt(charId === current && variant !== 'e2' ? variant : '');
  };
  return html`<${Modal} open=${true} title=${title} micro=${micro} onClose=${onClose} width="min(9.6rem, 94vw)" class="cardpick">
    <div class="cardpick__bar">
      <label class="cardpick__search"><${Icon} name="search" /><input type="search" value=${q} placeholder=${t('搜索干员')} onInput=${(e) => setQ(e.currentTarget.value)} /></label>
      <div class="cardpick__stars" role="radiogroup" aria-label=${t('稀有度')}>
        ${[[0, t('全部')], [6, '6★'], [5, '5★'], [4, '4★']].map(([v, label]) => html`<button key=${v} type="button" role="radio" aria-checked=${star === v ? 'true' : 'false'}
          class=${star === v ? 'is-on' : ''} onClick=${() => setStar(v)}>${label}</button>`)}
      </div>
    </div>
    ${chips.length ? html`<div class="cardpick__variants" role="radiogroup" aria-label=${t('立绘样式')}>
      ${chips.map(([v, label]) => html`<button key=${v || 'e2'} type="button" role="radio" aria-checked=${art === v ? 'true' : 'false'}
        class=${`cardpick__variant${art === v ? ' is-on' : ''}`} title=${label} onClick=${() => setArt(v)}>${label}</button>`)}
    </div>` : null}
    <div class="cardpick__grid">
      <button type="button" class=${`cardpick__op cardpick__op--auto${!sel ? ' is-on' : ''}`} onClick=${() => onPick('')} title=${autoTitle}>
        <span class="cardpick__img"><${Icon} name=${autoIcon} /></span><span class="cardpick__name">${autoLabel}</span></button>
      ${shown.map((c) => html`<button key=${c.charId} type="button" class=${`cardpick__op${sel === c.charId ? ' is-on' : ''}`} onClick=${() => pickTile(c.charId)} title=${c.name}>
        <span class="cardpick__img"><img src=${faceOf(c, sel === c.charId ? art : '')} alt="" loading="lazy" draggable=${false} /></span>
        <span class="cardpick__name">${c.name}</span>${c.rarity ? html`<span class=${`cardpick__star r${c.rarity}`}>${c.rarity}★</span>` : null}</button>`)}
    </div>
    ${note ? html`<p class="cardpick__note"><${Icon} name="info" />${note}</p>` : null}
    ${variants && sel ? html`<div class="cardpick__foot"><button type="button" class="cardpick__ok" onClick=${() => onPick(sel, art)}>${t('确定')}</button></div>` : null}
  <//>`;
}

/**
 * The 头像 picker: an operator's official avatar stands for the doctor (room.card avatar); 默认 = none (the strategy icon,
 * else the name's first letter). 项目 5: the same picker chooses 精一 / 精二 / a skin of that operator (room.card face).
 * @param {{ current: string, list: any[], m: any, variant?: string, onPick: (charId: string, variant?: string) => void, onClose: Function }} props
 */
export function AvatarPicker({ current, list, m, variant = '', onPick, onClose }) {
  return html`<${OperatorPicker} title=${t('头像')} micro="AVATAR" current=${current} list=${list} m=${m} variant=${variant} variants=${true}
    faceOf=${(c, v) => cardAvatarUrl(c.charId, m, v) || chessAvatarUrl(m, c)}
    autoLabel=${t('默认')} autoTitle=${t('不使用头像：显示策略图标或名字首字')} autoIcon="user"
    note=${CARD_SYNC ? t('选择后，同盟里的博士都会看到这个头像') : t('目前只有你自己看得到；服务器下次更新后，同盟里的其他博士也能看到你的选择')}
    onPick=${onPick} onClose=${onClose} />`;
}
