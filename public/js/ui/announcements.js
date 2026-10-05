// Versioned lobby notices. Optional data: never part of game readiness or the public asset routes.
import { html, Button, Icon, Modal, Spinner } from './components.js';

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

/** Presentation only: the lobby owns optional loading, so this UI component adds no in-match data dependency. */
export function AnnouncementBoard({ status = 'idle', value, onRetry, onClose }) {
  const entries = status === 'ready' ? parseAnnouncements(value) : null;
  const loading = status === 'idle' || status === 'loading';
  return html`<${Modal} open=${true} title="公告板" micro="BULLETIN BOARD" ariaLabel="大厅公告板" trapFocus=${true}
      class="announcement-board lobby-dialog" onClose=${onClose}
      actions=${html`<${Button} icon="close" onClick=${onClose} data-autofocus>关闭公告<//>`}>
    ${loading ? html`<div class="announcement-state" role="status"><${Spinner} label="LOADING" /><p>正在读取公告…</p></div>`
      : entries === null ? html`<div class="announcement-state" role="status">
        <${Icon} name="warn" /><h3>暂时无法显示公告</h3>
        <p>${status === 'ready' ? '公告内容格式有误，请稍后再试。' : '公告未能加载，其他大厅功能仍可正常使用。'}</p>
        <${Button} icon="refresh" onClick=${onRetry}>重试公告<//>
      </div>`
      : !entries.length ? html`<div class="announcement-state" role="status"><${Icon} name="info" /><h3>暂无公告</h3><p>新的公告会在这里显示。</p></div>`
      : html`<div class="announcement-list">${entries.map((entry, i) => html`<article key=${i} class="announcement-entry">
        <header><h3>${entry.title}</h3>${entry.date ? html`<span class="announcement-date num">${entry.date}</span>` : null}</header>
        ${entry.paragraphs.map((text, j) => html`<p key=${j}>${text}</p>`)}
      </article>`)}</div>`}
  <//>`;
}
