// 公开同盟 (feedback #30): the rooms of eight seats or more that their host listed (room.setListed), while they wait for
// players. The list is asked for (room.list) only while this dialog is open, every ROOM_LIST_POLL_MS on a visible page; the
// server shares one scan among its askers and never pushes it. Joining goes through the page's ordinary key join, which
// checks everything again: a row gone stale meanwhile answers with the usual refusal.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTY_COLORS, DIFFICULTY_NAMES, ROOM_LIST_MIN_CAPACITY } from '../../../shared/constants.js';
import { html, Button, DifficultyIcon, Icon, Modal, Spinner } from './components.js';
import { experimentalSummary } from './experimental.js';
import { net } from '../net.js';
import { versionLabel } from '../versions.js';
import { t } from '../../../shared/i18n.js';

/** How often an open list asks again (ms). */
export const ROOM_LIST_POLL_MS = 10_000;

function RoomRow({ row, disabled, onJoin }) {
  const bots = row.filled - row.humans;
  return html`<li class="rlist__row" style=${`--d-color:${DIFFICULTY_COLORS[row.difficulty]}`} data-testid="room-row" data-code=${row.code}>
    <span class="rlist__diff"><${DifficultyIcon} difficulty=${row.difficulty} />${t(DIFFICULTY_NAMES[row.difficulty])}</span>
    <span class="rlist__who"><b class="selectable">${row.host}</b><small title=${experimentalSummary(row.experimental)}>${experimentalSummary(row.experimental)}</small></span>
    ${row.version ? html`<span class="rlist__ver"><${Icon} name="book" />${versionLabel(row.version)}</span>` : html`<span></span>`}
    <span class="rlist__seats num" title=${t('{humans} 名博士，{bots} 名 AI', { humans: row.humans, bots })}>${row.filled}<i>/</i>${row.capacity}</span>
    <${Button} size="sm" variant="primary" class="rlist__join" disabled=${disabled} onClick=${() => onJoin(row.code)}>${t('加入同盟')}<//>
  </li>`;
}

/** @param {{ online: boolean, queued: boolean, busy: string | null, onJoin: (code: string) => void, onClose: () => void }} props */
export function RoomListDialog({ online, queued, busy, onJoin, onClose }) {
  const [rows, setRows] = useState(null);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const load = async () => {
    if (!online || inFlight.current || document.hidden) return;
    inFlight.current = true;
    try {
      const answer = await net.request('room.list');
      if (!alive.current) return;
      setRows(Array.isArray(answer?.rooms) ? answer.rooms : []);
      setFailed(false);
    } catch { if (alive.current) setFailed(true); } finally { inFlight.current = false; }
  };
  useEffect(() => {
    alive.current = true;
    load();
    const timer = setInterval(load, ROOM_LIST_POLL_MS);
    return () => { alive.current = false; clearInterval(timer); };
  }, [online]);
  return html`<${Modal} open=${true} title=${t('公开同盟')} micro="OPEN ALLIANCES" ariaLabel=${t('公开同盟')} trapFocus=${true} class="lobby-dialog rlist-dialog" onClose=${onClose}
      actions=${html`<${Button} variant="secondary" icon="refresh" disabled=${!online} onClick=${load}>${t('刷新')}<//><${Button} icon="close" onClick=${onClose}>${t('关闭')}<//>`}>
    <p class="modal__text">${t('{n} 人及以上、由创建者公开且尚未开局的同盟显示在这里。', { n: ROOM_LIST_MIN_CAPACITY })}</p>
    ${failed ? html`<p class="rlist__note" role="status"><${Icon} name="warn" />${t('列表暂时无法更新，稍后自动重试')}</p>` : null}
    ${rows === null ? html`<p class="rlist__note" role="status"><${Spinner} size="sm" />${t('正在载入同盟列表…')}</p>`
      : rows.length ? html`<ul class="rlist" data-testid="room-list">${rows.map((row) => html`<${RoomRow} key=${row.code} row=${row} disabled=${!online || queued || !!busy} onJoin=${onJoin} />`)}</ul>`
      : html`<p class="rlist__note" data-testid="room-list-empty">${t('暂时没有等待博士的公开同盟')}</p>`}
  <//>`;
}
