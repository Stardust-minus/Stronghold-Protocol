// Rolling updates never freeze or redirect a running match. An idle player may explicitly leave the old release.
import { useRef, useState } from '../../vendor/hooks.module.js';
import { PHASE } from '../../../shared/constants.js';
import { html, Button, confirmDialog } from './components.js';
import { store, useStore } from '../store.js';
import { net } from '../net.js';
import { releaseBase } from '../release.js';
import { toast, toastError } from './toasts.js';

export function ServerUpdateNotice() {
  const draining = useStore((s) => s.server?.draining === true);
  const active = useStore((s) => !!s.room?.inMatch || (!!s.match.public && s.match.public.phase !== PHASE.RESULT && s.match.public.phase !== PHASE.LOBBY));
  const online = useStore((s) => s.connection.status === 'online');
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  if (!draining || active) return null;
  const changeRelease = async () => {
    if (locked.current || !online) return;
    locked.current = true;
    setBusy(true);
    try {
      if (store.get().room && !await confirmDialog({ title: '进入新版本', text: '当前对局已经结束。离开这个旧版等待室，再进入新版大厅；不会影响仍在旧版进行的其他对局。', okText: '离开并进入新版' })) return;
      const state = store.get();
      if (state.room?.inMatch) { toast('对局仍在进行，不能切换版本', 'warn'); return; }
      if (state.room) await net.request('room.leave', {});
      if (store.get().room?.inMatch) return;
      globalThis.location.assign('/');
    } catch (err) { toastError(err); } finally { locked.current = false; setBusy(false); }
  };
  return html`<aside class="server-update" role="status">
    <p>此版本已停止接收新局；进行中的模拟仍会继续。</p>
    ${releaseBase() ? html`<${Button} variant="secondary" size="sm" disabled=${!online || busy} loading=${busy} onClick=${changeRelease}>进入新版本大厅<//>` : null}
  </aside>`;
}

/** Gateway totals are authenticated by the same game gate. No backend health or identity list is exposed. */
export function installReleasePresence({ fetchFn = (...args) => fetch(...args), intervalMs = 5000 } = {}) {
  if (!releaseBase()) return () => {};
  let stopped = false;
  let timer = null;
  let controller = null;
  const poll = async () => {
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 4000);
    try {
      const res = await fetchFn('/_server/presence', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!res.ok) throw new Error('presence unavailable');
      const msg = await res.json();
      if (msg.available !== true || !Number.isSafeInteger(msg.online) || msg.online < 0) throw new Error('invalid presence');
      if (!stopped) store.set({ presence: { online: msg.online, aggregate: true } });
    } catch {
      if (!stopped) store.set({ presence: null });
    } finally {
      clearTimeout(timeout);
      controller = null;
      if (!stopped) timer = setTimeout(poll, intervalMs);
    }
  };
  poll();
  return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
}
