// Display-only appearance editing; import/export belongs to the parent operator preset toolbar.
import { useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon, MicroLabel, Modal, Fragment } from './components.js';
import { Img } from './gameComponents.js';
import { chessPortraitUrl } from './assetUrls.js';
import { skinsFor, skinIdFor } from '../../../shared/skins.js';
import { appearanceEntry } from './skinAssets.js';
import { setSkinChoice } from './skinsModel.js';
import { t, N_ } from '../../../shared/i18n.js';
import { DynamicIllustration } from './dynamicIllustration.js';

const syncLabels = { idle: N_('未连接'), pending: N_('等待同步'), sending: N_('正在同步'), synced: N_('外观已同步'), locked: N_('下一局生效'), error: N_('同步失败') };

export function SkinPicker({ m, charId, record, choices = {}, sync = 'idle', onChange, locked = false }) {
  const [preview, setPreview] = useState(false);
  const appearance = appearanceEntry(m, charId, skinIdFor(choices, charId));
  const illustration = appearance?.illustration;
  const [dynamic, setDynamic] = useState(true);
  const skins = skinsFor(charId);
  const selected = skinIdFor(choices, charId);
  const defaultArt = chessPortraitUrl(m, { ...record, skinId: null });
  return html`<${Fragment}>
    <section class="lo-sec lo-sec--skins" aria-label=${t('干员外观')} data-testid="skin-picker">
      <header class="lo-sec__head">
        <h3>${t('外观')}<${MicroLabel}>APPEARANCE<//></h3>
        <span class="lo-skin-sync" role="status" data-testid="skin-sync">${t(syncLabels[sync] || syncLabels.idle)}</span>
      </header>
      <div class="lo-skins" role="radiogroup" aria-label=${t('选择干员外观')}>
        ${[{ id: null, name: t('默认外观'), brand: t('随普通／精锐状态显示'), art: defaultArt }, ...skins.map(s => ({ ...s, art: appearanceEntry(m, charId, s.id)?.portrait }))].map(s => {
          const artEntry = appearanceEntry(m, charId, s.id);
          const available = s.id == null || !!artEntry?.spine?.front;
          const on = selected === s.id;
          return html`<button key=${s.id || 'default'} type="button" role="radio" aria-checked=${on ? 'true' : 'false'} data-skin=${s.id || 'default'}
              class=${`lo-skin${on ? ' is-on' : ''}`} disabled=${!available} onClick=${() => onChange(setSkinChoice(choices, charId, s.id))}>
            <span class="lo-skin__art"><${Img} src=${s.art} fallbackSrc=${defaultArt} fallback=${html`<span class="t-dim">${t('暂无预览')}</span>`} /></span>
            <span class="lo-skin__name">${t(s.name)}</span>
            <span class="lo-skin__brand">${available ? t(s.brand) : t('素材未安装')}</span>
            ${artEntry?.dynamic ? html`<span class="lo-skin__dynamic">${t('动态立绘')}</span>` : artEntry?.dynamicDeclared ? html`<span class="lo-skin__dynamic">${t('动态立绘待补 · 静态预览')}</span>` : null}
            ${artEntry?.backUnavailable ? html`<span class="lo-skin__brand">${artEntry.battleModelKind === 'unified' ? t('统一战斗模型，正背面共用') : t('背面模型暂缺，使用本套正面')}</span>` : null}
            ${on ? html`<span class="lo-skin__mark"><${Icon} name="check" />${t('已选择')}</span>` : null}
          </button>`;
        })}
      </div>
      <p class="lo-skin__note">${!skins.length ? t('当前干员暂无已收录时装。') : t('仅改变头像、立绘和战斗本体，不改变属性、技能或伤害。')}
        ${locked ? t('本局外观已锁定，修改将在下一局生效。') : ''}</p>
      <div class="lo-skin__tools">
        ${illustration ? html`<${Button} variant="secondary" size="sm" data-testid="skins-preview" onClick=${() => setPreview(true)}>${t('查看立绘')}<//>` : null}
      </div>
    </section>
    ${preview ? html`<${Modal} open=${true} onClose=${() => setPreview(false)} title=${t(skins.find(s => s.id === selected)?.name || N_('干员立绘'))} micro="OPERATOR ARTWORK"
        actions=${html`<${Button} variant="secondary" onClick=${() => setPreview(false)}>${t('关闭')}<//>`}>
      ${appearance?.dynamic ? html`<div class="lo-dynamic-switch"><${Button} variant="ghost" size="sm" data-testid="dynamic-toggle" onClick=${() => setDynamic(!dynamic)}>${dynamic ? t('切换静态立绘') : t('切换动态立绘')}<//></div>` : null}
      ${dynamic && appearance?.dynamic ? html`<${DynamicIllustration} entry=${appearance.dynamic} staticSrc=${illustration || defaultArt} />`
        : html`<div class="lo-skin-preview"><${Img} src=${illustration} fallbackSrc=${defaultArt} fallback=${html`<p>${t('立绘暂时无法载入')}</p>`} /></div>`}
    <//>` : null}
  <//>`;
}
