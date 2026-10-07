// Versioned lobby notices. Optional data: never part of game readiness or the public asset routes.
import { html, Button, Icon, Modal, Spinner } from './components.js';
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { loadPref, savePref } from '../store.js';
import { t } from '../../../shared/i18n.js';

/** Validate the whole editorial list; never silently truncate or turn malformed content into an empty board. */
export function parseAnnouncements(value) {
  if (!Array.isArray(value) || value.length > 50) return null;
  const entries = [];
  let chars = 0;
  for (const entry of value) {
    if (!entry || typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 120
      || (entry.date != null && (typeof entry.date !== 'string' || !entry.date.trim() || entry.date.length > 40))
      || !Array.isArray(entry.paragraphs) || !entry.paragraphs.length || entry.paragraphs.length > 40
      || entry.paragraphs.some(p => typeof p !== 'string' || !p.trim() || p.length > 10000)) return null;
    chars += entry.title.length + (entry.date?.length || 0) + entry.paragraphs.reduce((n, p) => n + p.length, 0);
    if (chars > 200000) return null;
    entries.push({ title: entry.title.trim(), date: entry.date?.trim() || '', paragraphs: [...entry.paragraphs] });
  }
  return entries;
}

let dismissedInPage = null;

/** Content identity, independent of the browser build and editorial object key order. */
export async function announcementRevision(value, crypto = globalThis.crypto) {
  const entries = parseAnnouncements(value);
  if (!entries?.length) return null;
  const text = JSON.stringify(entries);
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return 'ann1:' + [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
  } catch {
    // Compatibility identity only, not a security hash. No network dependency on optional crypto.
    let a = 2166136261, b = 0x9e3779b9;
    for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b ^ text.charCodeAt(i), 2246822519); }
    return `ann1:${text.length.toString(16)}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
  }
}

export function announcementDismissed(revision) {
  return !!revision && revision === (dismissedInPage ?? loadPref('announcements.dismissed', null));
}

export function dismissAnnouncement(revision) {
  if (typeof revision !== 'string' || !revision.startsWith('ann1:')) return;
  dismissedInPage = revision;
  savePref('announcements.dismissed', revision);
}

/** Presentation only: the lobby owns optional loading, so this UI component adds no in-match data dependency. */
export function AnnouncementBoard({ status = 'idle', value, onRetry, onClose }) {
  const entries = status === 'ready' ? parseAnnouncements(value) : null;
  const loading = status === 'idle' || status === 'loading';
  const scrollRef = useRef(null);
  const [scroll, setScroll] = useState({ more: true, scrollable: true, percent: 0 });
  const measure = () => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const next = { more: max > 2 && el.scrollTop < max - 2, scrollable: max > 2, percent: max > 2 ? Math.round(Math.min(1, el.scrollTop / max) * 100) : 100 };
    setScroll(prev => prev.more === next.more && prev.scrollable === next.scrollable && prev.percent === next.percent ? prev : next);
  };
  useEffect(() => {
    measure();
    const el = scrollRef.current;
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (el) { observer?.observe(el); if (el.firstElementChild) observer?.observe(el.firstElementChild); }
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [status, value]);
  return html`<${Modal} open=${true} title=${t('公告板')} micro="BULLETIN BOARD" ariaLabel=${t('大厅公告板')} trapFocus=${true}
      closeOnBackdrop=${false} class="announcement-board lobby-dialog" onClose=${onClose}
      actions=${html`<${Button} icon="close" onClick=${onClose} data-autofocus>${t('关闭公告')}<//>`}>
    ${loading ? html`<div class="announcement-state" role="status"><${Spinner} label="LOADING" /><p>${t('正在读取公告…')}</p></div>`
      : entries === null ? html`<div class="announcement-state" role="status">
        <${Icon} name="warn" /><h3>${t('暂时无法显示公告')}</h3>
        <p>${status === 'ready' ? t('公告内容格式有误，请稍后再试。') : t('公告未能加载，其他大厅功能仍可正常使用。')}</p>
        <${Button} icon="refresh" onClick=${onRetry}>${t('重试公告')}<//>
      </div>`
      : !entries.length ? html`<div class="announcement-state" role="status"><${Icon} name="info" /><h3>${t('暂无公告')}</h3><p>${t('新的公告会在这里显示。')}</p></div>`
      : html`<div ref=${scrollRef} class="announcement-scroll" role="region" aria-label=${t('公告内容，可滚动')} tabindex="0" onScroll=${measure}>
        <div class="announcement-list">${entries.map((entry, i) => html`<article key=${i} class="announcement-entry">
          <header><h3>${entry.title}</h3>${entry.date ? html`<span class="announcement-date num">${entry.date}</span>` : null}</header>
          ${entry.paragraphs.map((text, j) => html`<p key=${j}>${text}</p>`)}
        </article>`)}</div>
      </div>`}
    ${entries?.length ? html`<div class=${`announcement-reading${scroll.more ? ' has-more' : ''}`}>
      <div class="announcement-reading__track" role="progressbar" aria-label=${t('公告阅读位置')} aria-valuemin="0" aria-valuemax="100" aria-valuenow=${scroll.percent}>
        <i style=${`transform:scaleX(${scroll.percent / 100})`} />
      </div><span>${scroll.more ? html`<${Icon} name="chevronRight" />${t('向下滑动查看剩余公告')}` : scroll.scrollable ? t('已到公告末尾') : t('内容已完整显示')}</span>
    </div>` : null}
  <//>`;
}
