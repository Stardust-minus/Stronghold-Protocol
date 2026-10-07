// Post-unite rescue controls. The server owns room options, eligibility and the one-use limit.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { PHASE } from '../../../shared/constants.js';
import { html, Button, Icon, MicroLabel, Tooltip, Countdown, confirmDialog } from './components.js';
import { net } from '../net.js';
import { store, useStore, serverNow } from '../store.js';
import { toast, toastError } from './toasts.js';

const UNAVAILABLE = Object.freeze({
  disabled: '本局未开启复活',
  'no-helper': '本轮无人满足未漏怪且实际参与联防的救援资格',
  'donor-lp': '本轮合格联防队友的生命值均不足 11，无法支付救援',
  'window-expired': '本次 15 秒救援窗口已结束，死亡已结算',
  'window-closed': '救援阶段已结束，死亡已结算',
  'already-used': '队友本局复活次数已用完',
  left: '队友已主动退出',
  'match-ended': '本局模拟已结束，无法救援',
});

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
  if (!target.pendingDeath) return Object.hasOwn(UNAVAILABLE, target.revivalUnavailableReason)
    ? UNAVAILABLE[target.revivalUnavailableReason] : '淘汰已结算，无法再抵消死亡';
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
