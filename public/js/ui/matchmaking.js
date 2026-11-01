// Public queue remains separate from solo and invite rooms; all assignments come from the server.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTIES, DIFFICULTY_NAMES, DIFFICULTY_COLORS } from '../../../shared/constants.js';
import { MAX_SEATS } from '../../../shared/constants.js';
import { PLAYER_CAPACITIES, isPlayerCapacity, roomCapacity } from '../../../shared/playerCapacity.js';
import { html, Button, Icon, MicroLabel, Modal, DifficultyIcon, useTicker } from './components.js';
import { SearchPanel, FoundPanel } from './matchFlow.js';
import { useStore, serverNow } from '../store.js';
import { net } from '../net.js';
import { queueCancellation } from '../queueCancellation.js';
import { toastError } from './toasts.js';
import { ExperimentalSummary } from './experimental.js';
import { t, N_ } from '../../../shared/i18n.js';

export const queueActive = (q) => q?.state === 'queued' || q?.state === 'offered';

export function queueCapacity(queue, experimental) {
  return isPlayerCapacity(queue?.required) ? queue.required
    : roomCapacity('coop', queue?.experimental ?? experimental);
}

/** The difficulties a queued ticket waits in (feedback #87), when they are several; an offer stands at one. */
export function queueDifficulties(q) {
  const list = q?.state === 'queued' && Array.isArray(q.difficulties) ? q.difficulties.filter((d) => DIFFICULTIES.includes(d)) : [];
  return list.length > 1 ? list : null;
}

/**
 * 多人匹配's scope (the owner, 2026-11-02; server/matchmaking.js): 人数 — 4 人同盟, 多人同盟 — and 规则 — 标准规则,
 * 实验性规则. Each keeps at least one, as the difficulties do.
 */
const SCOPE_SEATS = Object.freeze({ four: Object.freeze([MAX_SEATS]), multi: Object.freeze(PLAYER_CAPACITIES.filter((n) => n > MAX_SEATS)) });
const SCOPE_RULES = Object.freeze(['standard', 'experimental']);
export const MATCH_SCOPE_DEFAULT = Object.freeze({ seats: Object.freeze(['four']), rules: Object.freeze(['standard']) });

/** A saved `lobby.matchScope`, checked: anything unusable falls back to the default of its axis. */
export function matchScope(saved) {
  const pick = (list, known, fallback) => {
    const kept = Array.isArray(list) ? known.filter((x) => list.includes(x)) : [];
    return kept.length ? kept : [...fallback];
  };
  return { seats: pick(saved?.seats, Object.keys(SCOPE_SEATS), MATCH_SCOPE_DEFAULT.seats), rules: pick(saved?.rules, SCOPE_RULES, MATCH_SCOPE_DEFAULT.rules) };
}

/** The scope after pressing `value` of an axis: the press toggles it, and the last one of the axis stays. */
export function toggleMatchScope(scope, axis, value) {
  const list = scope[axis];
  if (list.includes(value) && list.length === 1) return scope;
  const known = axis === 'seats' ? Object.keys(SCOPE_SEATS) : SCOPE_RULES;
  return { ...scope, [axis]: known.filter((x) => (x === value ? !list.includes(x) : list.includes(x))) };
}

/** What queue.join carries for a scope. */
export function matchScopeRequest(scope) {
  return { capacities: scope.seats.flatMap((x) => SCOPE_SEATS[x]), rules: [...scope.rules] };
}

/** The lowest and highest size of 多人同盟, for its label. */
export const multiSeats = () => ({ a: SCOPE_SEATS.multi[0], b: SCOPE_SEATS.multi[SCOPE_SEATS.multi.length - 1] });

/**
 * What a queued lone ticket waits for, as the searching screens name it: `seats` (its sizes; null: one size, the
 * `{n} 人模式` of `required`) and `rules` (null: a room's party, whose room owns them). Null once an offer stands, which
 * shows the game's own size and rules.
 */
export function queueScope(q) {
  if (q?.state !== 'queued') return null;
  const sizes = Array.isArray(q.capacities) ? q.capacities.filter(isPlayerCapacity) : [];
  const multi = sizes.length > 1 || sizes.some((n) => n > MAX_SEATS);
  const seats = !multi ? null : sizes.includes(MAX_SEATS) ? t('{n} 人、多人同盟', { n: MAX_SEATS }) : t('多人同盟');
  const only = Array.isArray(q.rules) && q.rules.length === 1 ? q.rules[0] : null;
  const rules = only === 'standard' ? t('标准规则') : only === 'experimental' ? t('仅实验性规则') : q.partyRoomCode ? null : t('含实验性规则');
  return seats || rules ? { seats, rules } : null;
}

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
  maintenance: N_('服务器即将维护，匹配已暂停'),
};

export function OnlinePlayers() {
  const presence = useStore((s) => s.presence);
  const online = useStore((s) => s.connection.status === 'online');
  const available = online && Number.isInteger(presence?.online);
  return html`<span class="online-players" title=${t('按已连接的玩家会话计数，不含机器人、离线保留局和未进入的连接；不等于去重自然人数。')}>
    <${Icon} name="users" /><span>${available ? t('{online} 人在线', { online: presence.online }) : t('在线人数 —')}</span>
  </span>`;
}

export function queuePopulation(q, online, cancelling = false) {
  return online && !cancelling && q?.state === 'queued' && Number.isSafeInteger(q.waitingCount) && q.waitingCount >= 0
    ? q.waitingCount : null;
}

const MATCHING_RULES = N_('集齐后有 30 秒确认时间，全部确认后直接开局。未完成确认者不自动回队。最多等待 10 分钟，可随时取消。');
export const EXPERIMENTAL_RULES = N_('好友小队沿用房间的实验性选项。单人默认只进标准规则的对局，选择「实验性规则」后才会进入改过规则的小队，确认入场前可以看到具体规则。只有单人时一律按标准规则开局。');

export function MatchmakingPanel({ queue, difficulty, experimental, online, onJoin, joining = false, compact = false }) {
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
  const capacity = queueCapacity(queue, experimental);
  const offered = queue?.state === 'offered';
  const allocating = offered && queue.allocationPending === true;
  const seconds = queueTime(queue, serverNow());
  const population = queuePopulation(queue, online, cancelling || cancelFailed);
  const motion = online && active && !cancelling && !cancelFailed ? allocating ? 'allocating' : offered ? 'offered' : 'searching' : 'idle';
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
  return html`<section class=${`matchmaking${offered ? ' is-offered' : ''}${active ? ' is-active' : ''}${compact ? ' matchmaking--compact' : ''}`} aria-label=${t('公开多人匹配')} data-player-capacity=${capacity} data-motion=${motion}>
    <header><${Icon} name=${offered ? 'users' : 'search'} /><${MicroLabel} tone="mint">PUBLIC MATCHMAKING<//></header>
    <h2>${allocating ? t('正在创建对局') : offered ? t('队友已集结') : active ? t('正在寻找队友') : t('寻找同盟博士')}${compact && offered && Number.isInteger(queue.acceptedCount)
      ? html`<span class="matchmaking__count">${t('{acceptedCount} / {n} 已确认', { acceptedCount: queue.acceptedCount, n: capacity })}</span>` : null}</h2>
    <p>${t('{0} · {n} 名真人 · 不自动补 AI', { 0: t(DIFFICULTY_NAMES[queue?.difficulty || difficulty]), n: capacity })}${queue?.partySize > 1 ? t(' · {partySize} 人小队整体匹配', { partySize: queue.partySize }) : ''}</p>
    ${active && !offered ? html`<div class="matchmaking__population" data-testid="queue-population">
      <span>${t('本难度 · {n} 人模式等待队列', { n: capacity })}</span>
      <strong class="num">${population == null ? '—' : population}</strong><span>${t('人')}</span>
      <small>${queue?.partySize > 1 ? t('含本队 {n} 人', { n: queue.partySize }) : t('含你')}</small>
    </div>` : null}
    <div class="matchmaking__status" role="status">
      <span class="matchmaking__motion" aria-hidden="true"><i></i><i></i><i></i></span>
      ${cancelling ? t('正在确认取消，等待服务器同步…') : !online ? t('连接中断，重连后同步匹配状态') : offered
        ? allocating ? t('全员已确认，正在连接游戏节点 · {seconds} 秒', { seconds }) : queue.accepted ? t('你已确认，等待其他博士 · {seconds} 秒', { seconds }) : t('请在 {seconds} 秒内确认入场', { seconds })
        : active ? t('已等待 {0} 分 {1} 秒', { 0: Math.floor(seconds / 60), 1: String(seconds % 60).padStart(2, '0') }) : t('按人数模式和难度匹配，集齐后由每位博士确认')}
    </div>
    ${cancelFailed && active ? html`<p class="matchmaking__reason" role="status">${compact
      ? t('取消尚未确认，请重连后重试；当前为服务器最后确认的状态。')
      : t('尚未确认取消，请恢复连接后重试；下方仍显示服务器最后确认的匹配状态。')}</p>` : null}
    ${queue?.reason && REASONS[queue.reason] ? html`<p class="matchmaking__reason">${t(REASONS[queue.reason])}</p>` : null}
    ${!compact && offered && Number.isInteger(queue.acceptedCount) ? html`<p>${t('{acceptedCount} / {n} 位博士已确认', { acceptedCount: queue.acceptedCount, n: capacity })}</p>` : null}
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
      <p class="modal__text">${t('{n} 名真人按相同人数模式和难度匹配，不自动补 AI；好友小队保持整队。', { n: capacity })}</p>
      <p class="modal__text">${t(MATCHING_RULES)}</p><p class="modal__text">${t(EXPERIMENTAL_RULES)}</p>
      <p class="modal__text">${t('等待人数包含同难度、同人数模式的待匹配博士；小队保持完整，人数充足不代表已组成对局。')}</p>
    <//>` : null}
  </section>`;
}

/**
 * The queue in the hub's frame (2026-10-14: the lobby / room design by 雨千代chiyo, ui/matchFlow.js): 搜寻中 while queued
 * — the time waited, the server's waiting count, 停止搜寻 (the same cancellation as 取消匹配); the confirm step
 * (MatchmakingPanel: 确认入场 / 退出本次匹配) while an offer stands; 搜寻成功 while the game node is prepared. Every
 * state still comes from queue.state; null while not queued.
 */
export function QueueFlow({ queue, difficulty, experimental, online, party = false, class: cls = '' }) {
  useTicker(1000);
  const cancellation = useStore((s) => s.ui.queueCancel);
  if (!queueActive(queue)) return null;
  const capacity = queueCapacity(queue, experimental);
  if (queue.state === 'offered' && queue.allocationPending === true) {
    return html`<${FoundPanel} class=${cls} seats=${capacity} text=${t('全员已确认，正在连接游戏节点')} />`;
  }
  if (queue.state === 'offered') {
    return html`<div class=${`mf-offer ${cls}`}><${MatchmakingPanel} queue=${queue} difficulty=${difficulty} experimental=${experimental} online=${online} /></div>`;
  }
  const cancelling = cancellation?.ticketId === queue.ticketId && ['sending', 'recovering', 'confirming'].includes(cancellation?.status);
  const cancelFailed = cancellation?.ticketId === queue.ticketId && cancellation?.status === 'failed';
  const population = queuePopulation(queue, online, cancelling || cancelFailed);
  const d = DIFFICULTIES.includes(queue.difficulty) ? queue.difficulty : difficulty;
  const several = queueDifficulties(queue), scope = queueScope(queue);
  const diffTag = (x, label) => ({ key: several ? `diff-${x}` : 'diff', label, color: DIFFICULTY_COLORS[x], icon: html`<${DifficultyIcon} difficulty=${x} />` });
  const note = cancelling ? t('正在确认取消，等待服务器同步…')
    : !online ? t('连接中断，重连后同步匹配状态')
    : cancelFailed ? t('取消尚未确认，请重连后重试；当前为服务器最后确认的状态。')
    : queue.reason && REASONS[queue.reason] ? t(REASONS[queue.reason])
    : population == null ? (scope?.seats ? t('{scope} · 不自动补 AI', { scope: scope.seats }) : t('{n} 名真人 · 不自动补 AI', { n: capacity }))
    : several || scope?.seats ? t('所选范围最多等待 {count} 人（含你）', { count: population })
    : queue.partySize > 1 ? t('本难度等待 {count} 人（含本队 {n} 人）', { count: population, n: queue.partySize })
    : t('本难度等待 {count} 人（含你）', { count: population });
  return html`<${SearchPanel} class=${cls} elapsed=${queueTime(queue, serverNow())} stopping=${cancelling || !online}
    onStop=${() => queueCancellation.cancel(queue.ticketId)} note=${note}
    tags=${[{ key: 'mode', label: party ? t('组队匹配') : t('多人匹配'), icon: html`<${Icon} name="search" />` },
      ...(several ? several.map((x, i) => diffTag(x, population == null || !Number.isSafeInteger(queue.waitingCounts?.[i]) ? t(DIFFICULTY_NAMES[x]) : `${t(DIFFICULTY_NAMES[x])} ${queue.waitingCounts[i]}`))
        : [diffTag(d, t(DIFFICULTY_NAMES[d]))]),
      { key: 'cap', label: scope?.seats || t('{n} 人模式', { n: capacity }), icon: html`<${Icon} name="users" />` },
      ...(scope?.rules ? [{ key: 'rules', label: scope.rules, icon: html`<${Icon} name="book" />` }] : [])]} />`;
}
