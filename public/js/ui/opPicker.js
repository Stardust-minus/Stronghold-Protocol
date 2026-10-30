// 干员选择器 (2026-10-14): the room's 名片干员 picker and the 头像 picker (the room's own seat plate, 统计数据's card) —
// search, rarity, the operators' avatars; the first tile clears the pick. `looks` (feedback #9 / #24): the picked
// operator's art to show — 精二 / 精一 / its skins (ui/seatArt.js lookOptions) — in a row above the grid. The 头像 picker has
// a second tab, the official player avatars (feedback #100, ui/seatArt.js officialAvatars).
import { useState } from '../../vendor/hooks.module.js';
import { html, Icon, Modal } from './components.js';
import { chessAvatarUrl } from './assetUrls.js';
import { cardAvatarUrl, lookOptions, officialAvatars } from './seatArt.js';
import { CARD_SYNC } from './playerCard.js';
import { t, tName } from '../../../shared/i18n.js';
import { isOfficialAvatar } from '../../../shared/protocol.js';

/**
 * @param {{ title: any, micro: string, current: string, list: any[], m: any, faceOf?: (c: any) => (string | null),
 *   autoLabel: any, autoTitle?: string, autoIcon?: string, note?: any, onPick: (charId: string) => void, onClose: Function,
 *   looks?: null | { kind: 'avatar'|'portrait', current: string, onLook: (look: string) => void }, tabs?: any, body?: any }} props
 *   `list`: ui/seatArt.js cardOperators; `faceOf`: a tile's picture (default the record's avatar); `current` '' = the
 *   first tile (autoLabel), which picks ''. `tabs`: a row above everything; `body`: replaces the search and the grid.
 */
export function OperatorPicker({ title, micro, current, list, m, faceOf = (c) => chessAvatarUrl(m, c), autoLabel, autoTitle, autoIcon = 'refresh',
  note = null, onPick, onClose, looks = null, tabs = null, body = null }) {
  const [q, setQ] = useState('');
  const [star, setStar] = useState(0);
  const needle = q.trim().toLowerCase();
  // (a roster record's name is the Chinese one: tName gives it the language's, as the overlay does for the chess records')
  const nameOf = (c) => (c.roster ? tName(c.name) : c.name);
  const shown = list.filter((c) => (!star || c.rarity === star) && (!needle || String(nameOf(c) || '').toLowerCase().includes(needle)
    || String(c.appellation || '').toLowerCase().includes(needle)));
  return html`<${Modal} open=${true} title=${title} micro=${micro} onClose=${onClose} width="min(9.6rem, 94vw)" class="cardpick">
    ${tabs}
    ${body || html`<div class="cardpick__bar">
      <label class="cardpick__search"><${Icon} name="search" /><input type="search" value=${q} placeholder=${t('搜索干员')} onInput=${(e) => setQ(e.currentTarget.value)} /></label>
      <div class="cardpick__stars" role="radiogroup" aria-label=${t('稀有度')}>
        ${[[0, t('全部')], [6, '6★'], [5, '5★'], [4, '4★']].map(([v, label]) => html`<button key=${v} type="button" role="radio" aria-checked=${star === v ? 'true' : 'false'}
          class=${star === v ? 'is-on' : ''} onClick=${() => setStar(v)}>${label}</button>`)}
      </div>
    </div>
    ${looks ? html`<${LookBar} m=${m} charId=${current} looks=${looks} />` : null}
    <div class="cardpick__grid">
      <button type="button" class=${`cardpick__op cardpick__op--auto${!current ? ' is-on' : ''}`} onClick=${() => onPick('')} title=${autoTitle}>
        <span class="cardpick__img"><${Icon} name=${autoIcon} /></span><span class="cardpick__name">${autoLabel}</span></button>
      ${shown.map((c) => html`<button key=${c.charId} type="button" class=${`cardpick__op${current === c.charId ? ' is-on' : ''}`} onClick=${() => onPick(c.charId)} title=${nameOf(c)}>
        <span class="cardpick__img"><img src=${faceOf(c)} alt="" loading="lazy" draggable=${false} /></span>
        <span class="cardpick__name">${nameOf(c)}</span>${c.rarity ? html`<span class=${`cardpick__star r${c.rarity}`}>${c.rarity}★</span>` : null}</button>`)}
    </div>`}
    ${note ? html`<p class="cardpick__note"><${Icon} name="info" />${note}</p>` : null}
  <//>`;
}

/** The picked operator's looks (精二 / 精一 / skins): nothing when it has only one. */
function LookBar({ m, charId, looks }) {
  const opts = charId ? lookOptions(m, charId, looks.kind) : [];
  if (opts.length < 2) return null;
  const on = opts.some((o) => o.id === looks.current) ? looks.current : '';
  return html`<div class="cardpick__looks" role="radiogroup" aria-label=${t('外观')}>
    <span class="cardpick__looks-label">${t('外观')}</span>
    ${opts.map((o) => html`<button key=${o.id || 'e2'} type="button" role="radio" aria-checked=${on === o.id ? 'true' : 'false'}
      class=${`cardpick__look${on === o.id ? ' is-on' : ''}${looks.kind === 'portrait' ? ' is-tall' : ''}`} title=${t(o.name)} onClick=${() => looks.onLook(o.id)}>
      <span class="cardpick__img">${o.src ? html`<img src=${o.src} alt="" loading="lazy" draggable=${false} />` : null}</span>
      <span class="cardpick__name">${t(o.name)}</span></button>`)}
  </div>`;
}

/**
 * The 头像 picker: an operator's official avatar stands for the doctor (room.card avatar); 默认 = none (the strategy icon,
 * else the name's first letter).
 * @param {{ current: string, list: any[], m: any, onPick: (charId: string) => void, onClose: Function, looks?: any }} props
 */
export function AvatarPicker({ current, list, m, onPick, onClose, looks = null }) {
  const groups = officialAvatars(m);
  const [official, setOfficial] = useState(isOfficialAvatar(current));
  const tab = (on, label, set) => html`<button type="button" role="tab" aria-selected=${on ? 'true' : 'false'} class=${on ? 'is-on' : ''} onClick=${() => setOfficial(set)}>${label}</button>`;
  const tabs = groups.length ? html`<div class="cardpick__tabs" role="tablist">${tab(!official, t('干员'), false)}${tab(official, t('官方头像'), true)}</div>` : null;
  const body = official && groups.length ? html`<div class="cardpick__grid cardpick__grid--official">
    ${groups.map((g) => html`<h4 key=${g.key} class="cardpick__group">${t(g.title)}</h4>
      ${g.items.map((a) => html`<button key=${a.id} type="button" class=${`cardpick__op${current === a.id ? ' is-on' : ''}`} data-avatar=${a.id} aria-label=${t('官方头像')} onClick=${() => onPick(a.id)}>
        <span class="cardpick__img"><img src=${a.src} alt="" loading="lazy" draggable=${false} /></span></button>`)}`)}
  </div>` : null;
  return html`<${OperatorPicker} title=${t('头像')} micro="AVATAR" current=${current} list=${list} m=${m} faceOf=${(c) => cardAvatarUrl(c.charId, m)} looks=${official ? null : looks} tabs=${tabs} body=${body}
    autoLabel=${t('默认')} autoTitle=${t('不使用头像：显示策略图标或名字首字')} autoIcon="user"
    note=${CARD_SYNC ? t('选择后，同盟里的博士都会看到这个头像') : t('目前只有你自己看得到；服务器下次更新后，同盟里的其他博士也能看到你的选择')}
    onPick=${onPick} onClose=${onClose} />`;
}
