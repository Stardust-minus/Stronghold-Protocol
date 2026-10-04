// Public queue remains separate from solo and invite rooms; all assignments come from the server.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTY_NAMES } from '../../../shared/constants.js';
import { html, Button, Icon, MicroLabel, useTicker } from './components.js';
import { useStore, serverNow } from '../store.js';
import { net } from '../net.js';
import { toastError } from './toasts.js';

export const queueActive = (q) => q?.state === 'queued' || q?.state === 'offered';

export function queueTime(q, now) {
  if (q?.state === 'offered') return Math.max(0, Math.ceil(((q.deadline || 0) - now) / 1000));
  return Math.max(0, Math.floor((now - (q?.joinedAt || now)) / 1000));
}

const REASONS = {
  cancelled: '已取消匹配', disconnected: '连接中断，本次匹配已取消', timeout: '确认超时，已返回匹配入口',
  confirmation_timeout: '确认时间已结束，未确认的博士已退出本次匹配', unavailable: '匹配条件或可用容量已变化，请重新匹配',
  updating: '服务器正在更新，请进入新版大厅', shutdown: '匹配服务已停止',
  expired: '等待时间已满，请重新加入匹配', offer_timeout: '有人未及时确认，继续等待队友',
  declined: '队友取消了确认，继续等待', peer_cancelled: '队友取消了确认，继续等待',
  peer_disconnected: '队友连接中断，继续等待', capacity: '房间容量暂满，请稍后重试',
  draining: '服务器正在滚动更新，暂不接收新匹配', maintenance: '服务器正在更新，暂不接收新匹配',
};

export function OnlinePlayers() {
  const presence = useStore((s) => s.presence);
  const online = useStore((s) => s.connection.status === 'online');
  const available = online && Number.isInteger(presence?.online);
  return html`<span class="online-players" title="按已连接的玩家会话计数，不含机器人、离线保留局和未进入的连接；不等于去重自然人数。">
    <${Icon} name="users" /><span>${available ? `${presence.online} 人在线` : '在线人数 —'}</span>
  </span>`;
}

export function MatchmakingPanel({ queue, difficulty, online, onJoin, joining = false, accepting = true }) {
  useTicker(1000);
  const [busy, setBusy] = useState(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const active = queueActive(queue);
  const offered = queue?.state === 'offered';
  const seconds = queueTime(queue, serverNow());
  const act = async (kind) => {
    if (!online || inFlight.current || !queue?.ticketId) return;
    inFlight.current = true;
    setBusy(kind);
    try {
      const fields = { ticketId: queue.ticketId };
      if (kind === 'accept') fields.offerId = queue.offerId;
      await net.request(`queue.${kind}`, fields);
    } catch (err) { toastError(err); } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  return html`<section class=${`matchmaking${offered ? ' is-offered' : ''}`} aria-label="公开多人匹配">
    <header><${Icon} name=${offered ? 'users' : 'search'} /><${MicroLabel} tone="mint">PUBLIC MATCHMAKING<//></header>
    <h2>${offered ? '队友已集结' : active ? '正在寻找队友' : '寻找同盟博士'}</h2>
    <p>${DIFFICULTY_NAMES[queue?.difficulty || difficulty]} · 4 名真人 · 不自动补 AI</p>
    <div class="matchmaking__status" role="status">
      ${!online ? '连接中断，重连后同步匹配状态' : !accepting ? '此版本停止接收匹配，请进入新版大厅' : offered
        ? queue.accepted ? `你已确认，等待其他博士 · ${seconds} 秒` : `请在 ${seconds} 秒内确认入场`
        : active ? `已等待 ${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒` : '按难度匹配，集齐后由每位博士确认'}
    </div>
    ${queue?.reason && REASONS[queue.reason] ? html`<p class="matchmaking__reason">${REASONS[queue.reason]}</p>` : null}
    ${offered && Number.isInteger(queue.acceptedCount) ? html`<p>${queue.acceptedCount} / 4 位博士已确认</p>` : null}
    <div class="matchmaking__actions">
      ${active ? html`
        ${offered ? html`<${Button} variant="primary" size="lg" disabled=${!online || !!busy || queue.accepted || seconds === 0}
          loading=${busy === 'accept'} onClick=${() => act('accept')}>${queue.accepted ? '已确认入场' : '确认入场'}<//>` : null}
        <${Button} variant="secondary" size="lg" disabled=${!online || !!busy} loading=${busy === 'cancel'}
          onClick=${() => act('cancel')}>${offered ? '拒绝并退出' : '取消匹配'}<//>
      ` : html`<${Button} variant="primary" size="lg" block=${true} icon="search" disabled=${!online || joining || !accepting}
          loading=${joining} onClick=${onJoin}>开始多人匹配<//>`}
    </div>
    <small>集齐后有 30 秒确认时间；全部确认后进入等待室，投票并准备开局。最多等待 10 分钟，可随时取消。</small>
  </section>`;
}
