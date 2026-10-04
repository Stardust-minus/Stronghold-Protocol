// Pregame vote and post-unite rescue controls. The server owns votes, eligibility and the one-use limit.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { PHASE } from '../../../shared/constants.js';
import { html, Button, Icon, MicroLabel, Tooltip, Countdown, confirmDialog } from './components.js';
import { net } from '../net.js';
import { store, useStore, serverNow } from '../store.js';
import { toast, toastError } from './toasts.js';

export function RevivalVote({ room, myId, online, busy, onVote }) {
  if (room?.mode !== 'coop' || !room.revival) return null;
  const mine = room.seats?.find((s) => s?.playerId === myId);
  const vote = mine?.revivalVote;
  const humans = room.seats?.filter(s => s && !s.isBot).length || 0;
  const required = room.revival.required;
  const locked = !online || !!busy || !mine || room.inMatch || humans < 2;
  return html`<section class="revival-vote" aria-label="队友复活投票">
    <div class="revival-vote__title"><${Icon} name="plus" /><strong>队友复活</strong><${MicroLabel}>RESCUE PROTOCOL<//></div>
    <p class="revival-vote__rules">本轮未漏怪且参与联防、生命不少于 <b>11</b> 的队友，可支付 <b>10</b> 生命抵消一人死亡，令其恢复至 <b>1</b> 生命。每人每局仅一次。</p>
    <div class="revival-vote__actions">
      <span class=${room.revival.enabled ? 't-mint' : 't-lo'} role="status">${humans < 2 ? '暂无可救援队友' : `${room.revival.yes} / ${required} 票赞成 · ${room.revival.enabled ? '开局将启用' : '尚未启用'}`}</span>
      <${Button} size="sm" variant=${vote === true ? 'primary' : 'secondary'} active=${vote === true}
        disabled=${locked} onClick=${() => onVote(true)} aria-pressed=${String(vote === true)}>赞成开启<//>
      <${Button} size="sm" variant="secondary" active=${vote === false}
        disabled=${locked} onClick=${() => onVote(false)} aria-pressed=${String(vote === false)}>保持关闭<//>
    </div>
    <small>每位真人一票，需严格多数赞成（2 人需 2 票、3 人需 2 票、4 人需 3 票）；AI 不计票，开局锁定。获救者保留干员与原有状态，不重置资源。</small>
  </section>`;
}

/** A UI hint only: every predicate is independently rechecked by the authority. */
export function revivalReason(pub, myId, targetId, online = true, now = serverNow()) {
  const rule = pub?.revival;
  const me = pub?.players?.find((p) => p.playerId === myId);
  const target = pub?.players?.find((p) => p.playerId === targetId);
  if (!rule?.enabled) return '本局未开启复活';
  if (!online) return '连接中断，等待重连';
  if (!target || target.playerId === myId || target.alive !== false) return '只能复活已死亡的队友';
  if (target.left) return '队友已主动退出';
  if (target.revived) return '本局复活次数已用完';
  if (!target.pendingDeath) return '淘汰已结算，无法再抵消死亡';
  if (pub.phase !== PHASE.SETTLE || !rule.windowOpen || !(rule.deadline > now)) return '等待联防结算后的救援窗口';
  if (!me?.alive || me.left || me.isBot) return '只有存活玩家可以提供救援';
  if (!(me.lp >= 11)) return '至少需要 11 点生命值（支付 10 点）';
  if (!rule.eligible?.includes(myId)) return '仅限本轮未漏怪且实际参与联防的队友';
  return null;
}

export function RevivalNotice({ pub }) {
  if (!pub?.revival?.enabled || !pub.revival.windowOpen) return null;
  return html`<div class="team-rescue" role="status">
    <strong><${Icon} name="plus" /> 联防救援窗口</strong>
    <${Countdown} deadline=${pub.revival.deadline} size="sm" gauge=${false} label="救援剩余" />
    <small>符合资格且至少 11 生命，可支付 10 点救援</small>
  </div>`;
}

export function ReviveAction({ pub, myId, target }) {
  const online = useStore((s) => s.connection.status === 'online');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  if (!pub?.revival?.enabled || target.alive !== false || target.playerId === myId) return null;
  const reason = revivalReason(pub, myId, target.playerId, online);
  const revive = async () => {
    if (inFlight.current || reason) return;
    inFlight.current = true;
    setBusy(true);
    const round = pub.round;
    const matchId = pub.revival.matchId;
    try {
      const me = pub.players.find((p) => p.playerId === myId);
      const confirmed = await confirmDialog({
        title: `复活 ${target.name || '队友'}`,
        text: `支付你自己的 10 点生命值，抵消队友本次死亡，将其恢复至 1 点生命；干员、装备与其他状态完整保留，不重置资源。每人每局最多获救一次。支付后你将剩余 ${me.lp - 10} 点生命。`,
        okText: '支付 10 生命复活',
      });
      if (!confirmed) return;
      const current = store.get();
      const latest = current.match.public;
      const invalid = latest?.revival?.matchId !== matchId || latest?.round !== round
        ? '救援窗口已经变更' : revivalReason(latest, myId, target.playerId, current.connection.status === 'online');
      if (invalid) { toast(invalid, 'warn'); return; }
      await net.request('g.revive', { playerId: target.playerId, round, matchId });
    } catch (err) { toastError(err); } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return html`<div class="team-rescue-action">
    <${Tooltip} text=${reason || '至少持有 11 生命，支付 10 点抵消队友死亡'}>
      <${Button} variant="secondary" size="sm" icon="plus" disabled=${!!reason || busy} loading=${busy} onClick=${revive}>
        ${target.revived ? '复活已用' : '复活 · −10'}
      <//>
    <//>
    ${reason ? html`<small>${reason}</small>` : null}
  </div>`;
}
