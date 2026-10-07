// Public queue remains separate from solo and invite rooms; all assignments come from the server.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTY_NAMES } from '../../../shared/constants.js';
import { html, Button, Icon, MicroLabel, Modal, useTicker } from './components.js';
import { useStore, serverNow } from '../store.js';
import { net } from '../net.js';
import { queueCancellation } from '../queueCancellation.js';
import { toastError } from './toasts.js';
import { ExperimentalSummary } from './experimental.js';
import { t, N_ } from '../../../shared/i18n.js';

export const queueActive = (q) => q?.state === 'queued' || q?.state === 'offered';

export function queueTime(q, now) {
  if (q?.state === 'offered') return Math.max(0, Math.ceil(((q.deadline || 0) - now) / 1000));
  return Math.max(0, Math.floor((now - (q?.joinedAt || now)) / 1000));
}

const REASONS = {
  cancelled: N_('已取消匹配'), disconnected: N_('连接中断，本次匹配已取消'), timeout: N_('确认超时，已返回匹配入口'),
  confirmation_timeout: N_('确认时间已结束，未确认的博士已退出本次匹配'), unavailable: N_('匹配条件或可用容量已变化，请重新匹配'),
  shutdown: N_('匹配服务已停止'),
  expired: N_('等待时间已满，请重新加入匹配'), offer_timeout: N_('有人未及时确认，继续等待队友'),
  declined: N_('队友取消了确认，继续等待'), peer_cancelled: N_('队友取消了确认，继续等待'),
  peer_disconnected: N_('队友连接中断，继续等待'), capacity: N_('房间容量暂满，请稍后重试'),
  allocation_failed: N_('本次分配未完成，继续等待；原好友队伍保留'),
  allocation_timeout: N_('游戏节点准备超时，继续等待；原好友队伍保留'),
  unconfirmed: N_('你或同队成员未完成确认，已退出本次匹配；请重新开始匹配'),
};

export function OnlinePlayers() {
  const presence = useStore((s) => s.presence);
  const online = useStore((s) => s.connection.status === 'online');
  const available = online && Number.isInteger(presence?.online);
  return html`<span class="online-players" title=${t('按已连接的玩家会话计数，不含机器人、离线保留局和未进入的连接；不等于去重自然人数。')}>
    <${Icon} name="users" /><span>${available ? t('{online} 人在线', { online: presence.online }) : t('在线人数 —')}</span>
  </span>`;
}

const MATCHING_RULES = N_('集齐后有 30 秒确认时间，全部确认后直接开局。未完成确认者不自动回队。最多等待 10 分钟，可随时取消。');
const EXPERIMENTAL_RULES = N_('好友小队沿用房间的实验性选项，单人匹配跟随所加入房间。四名单人组局时，复活和禁用共享卡池默认关闭。');

export function MatchmakingPanel({ queue, difficulty, online, onJoin, joining = false, compact = false }) {
  useTicker(1000);
  const [busy, setBusy] = useState(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const cancellation = useStore((s) => s.ui.queueCancel);
  const cancelling = cancellation?.ticketId === queue?.ticketId && ['sending', 'recovering', 'confirming'].includes(cancellation?.status);
  const cancelFailed = cancellation?.ticketId === queue?.ticketId && cancellation?.status === 'failed';
  const active = queueActive(queue);
  const offered = queue?.state === 'offered';
  const allocating = offered && queue.allocationPending === true;
  const seconds = queueTime(queue, serverNow());
  const act = async (kind) => {
    if (!online || inFlight.current || cancelling || !queue?.ticketId || (kind === 'accept' && (queue.accepted || seconds === 0))) return;
    if (kind === 'cancel') { queueCancellation.cancel(queue.ticketId); return; }
    inFlight.current = true;
    setBusy(kind);
    try {
      const fields = { ticketId: queue.ticketId };
      if (kind === 'accept') {
        fields.offerId = queue.offerId;
      }
      await net.request(`queue.${kind}`, fields);
    } catch (err) { toastError(err); } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  return html`<section class=${`matchmaking${offered ? ' is-offered' : ''}${active ? ' is-active' : ''}${compact ? ' matchmaking--compact' : ''}`} aria-label=${t('公开多人匹配')}>
    <header><${Icon} name=${offered ? 'users' : 'search'} /><${MicroLabel} tone="mint">PUBLIC MATCHMAKING<//></header>
    <h2>${allocating ? t('正在创建对局') : offered ? t('队友已集结') : active ? t('正在寻找队友') : t('寻找同盟博士')}${compact && offered && Number.isInteger(queue.acceptedCount)
      ? html`<span class="matchmaking__count">${t('{acceptedCount} / 4 已确认', { acceptedCount: queue.acceptedCount })}</span>` : null}</h2>
    <p>${t('{0} · 4 名真人 · 不自动补 AI', { 0: t(DIFFICULTY_NAMES[queue?.difficulty || difficulty]) })}${queue?.partySize > 1 ? t(' · {partySize} 人小队整体匹配', { partySize: queue.partySize }) : ''}</p>
    <div class="matchmaking__status" role="status">
      ${cancelling ? t('正在确认取消，等待服务器同步…') : !online ? t('连接中断，重连后同步匹配状态') : offered
        ? allocating ? t('全员已确认，正在连接游戏节点 · {seconds} 秒', { seconds }) : queue.accepted ? t('你已确认，等待其他博士 · {seconds} 秒', { seconds }) : t('请在 {seconds} 秒内确认入场', { seconds })
        : active ? t('已等待 {0} 分 {1} 秒', { 0: Math.floor(seconds / 60), 1: String(seconds % 60).padStart(2, '0') }) : t('按难度匹配，集齐后由每位博士确认')}
    </div>
    ${cancelFailed && active ? html`<p class="matchmaking__reason" role="status">${compact
      ? t('取消尚未确认，请重连后重试；当前为服务器最后确认的状态。')
      : t('尚未确认取消，请恢复连接后重试；下方仍显示服务器最后确认的匹配状态。')}</p>` : null}
    ${queue?.reason && REASONS[queue.reason] ? html`<p class="matchmaking__reason">${t(REASONS[queue.reason])}</p>` : null}
    ${!compact && offered && Number.isInteger(queue.acceptedCount) ? html`<p>${t('{acceptedCount} / 4 位博士已确认', { acceptedCount: queue.acceptedCount })}</p>` : null}
    ${offered ? html`<div class="matchmaking__options"><${ExperimentalSummary} value=${queue.experimental} /></div>` : null}
    <div class="matchmaking__actions">
      ${active ? html`
        ${offered && !queue.accepted ? html`
          <${Button} variant="primary" size="lg" disabled=${!online || !!busy || cancelling || seconds === 0}
            loading=${busy === 'accept'} onClick=${() => act('accept')}>${t('确认入场')}<//>
        ` : null}
        <${Button} variant="secondary" size="lg" disabled=${!online || !!busy || cancelling} loading=${cancelling}
          onClick=${() => act('cancel')}>${cancelFailed ? t('重试取消') : offered ? t('退出本次匹配') : t('取消匹配')}<//>
      ` : html`<${Button} variant="primary" size="lg" block=${true} icon="search" disabled=${!online || joining}
          loading=${joining} onClick=${onJoin}>${t('开始多人匹配')}<//>`}
      ${compact ? html`<${Button} variant="ghost" size="sm" icon="info" class="matchmaking__help"
        onClick=${() => setRulesOpen(true)}>${offered ? t('完整规则') : t('匹配说明')}<//>` : null}
    </div>
    ${compact ? null : html`<small>${t(MATCHING_RULES)}</small>`}
    ${compact && rulesOpen ? html`<${Modal} open=${true} title=${t('多人匹配规则')} micro="MATCHMAKING RULES"
        ariaLabel=${t('多人匹配规则')} trapFocus=${true} class="lobby-dialog" onClose=${() => setRulesOpen(false)}
        actions=${html`<${Button} icon="close" onClick=${() => setRulesOpen(false)}>${t('关闭说明')}<//>`}>
      <p class="modal__text">${t('4 名真人按相同难度匹配，不自动补 AI；好友小队保持整队。')}</p>
      <p class="modal__text">${t(MATCHING_RULES)}</p><p class="modal__text">${t(EXPERIMENTAL_RULES)}</p>
    <//>` : null}
  </section>`;
}
