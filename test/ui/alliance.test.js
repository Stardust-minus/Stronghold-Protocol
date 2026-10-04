import test from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { revivalReason, RevivalVote } from '../../public/js/ui/revival.js';
import { partyQueueReason } from '../../public/js/screens/room.js';
import { queueActive, queueTime } from '../../public/js/ui/matchmaking.js';
import { watchTarget } from '../../public/js/ui/gameLogic.js';
import { PlayerAvatar } from '../../public/js/ui/gameComponents.js';

const fixture = () => ({
  phase: PHASE.SETTLE, round: 2,
  revival: { enabled: true, windowOpen: true, deadline: 16000, eligible: ['p1'], cost: 10, matchId: 'm1', round: 2 },
  players: [{ playerId: 'p1', alive: true, lp: 11, left: false }, { playerId: 'p2', alive: false, lp: 0, left: false, revived: false, pendingDeath: true }],
});

test('revival UI requires at least11 to pay10 and actual authoritative helper eligibility', () => {
  const pub = fixture();
  assert.equal(revivalReason(pub, 'p1', 'p2', true, 1000), null);
  for (const lp of [9, 10]) {
    pub.players[0].lp = lp;
    assert.match(revivalReason(pub, 'p1', 'p2', true, 1000), /至少需要 11/);
  }
  pub.players[0].lp = 11;
  pub.revival.eligible = [];
  assert.match(revivalReason(pub, 'p1', 'p2', true, 1000), /参与联防/);
});

test('revival UI rejects already used, departed, alive and self targets', () => {
  const pub = fixture();
  pub.players[1].revived = true;
  assert.match(revivalReason(pub, 'p1', 'p2', true, 1000), /次数已用完/);
  pub.players[1].revived = false;
  pub.players[1].left = true;
  assert.match(revivalReason(pub, 'p1', 'p2', true, 1000), /退出/);
  pub.players[1].left = false;
  pub.players[1].pendingDeath = false;
  assert.match(revivalReason(pub, 'p1', 'p2', true, 1000), /淘汰已结算/);
  pub.players[1].pendingDeath = true;
  pub.players[1].alive = true;
  assert.match(revivalReason(pub, 'p1', 'p2', true, 1000), /死亡/);
  assert.match(revivalReason(pub, 'p1', 'p1', true, 1000), /队友/);
});

test('revival UI disables expiry, wrong phase, dead donor, disabled rule and lost transport', () => {
  const pub = fixture();
  assert.match(revivalReason(pub, 'p1', 'p2', false, 1000), /连接中断/);
  assert.match(revivalReason(pub, 'p1', 'p2', true, 16000), /窗口/);
  pub.phase = PHASE.FINAL_ASSAULT;
  assert.match(revivalReason(pub, 'p1', 'p2', true, 1000), /窗口/);
  pub.phase = PHASE.SETTLE;
  pub.players[0].alive = false;
  assert.match(revivalReason(pub, 'p1', 'p2', true, 1000), /存活/);
  pub.revival.enabled = false;
  assert.match(revivalReason(pub, 'p1', 'p2', true, 1000), /未开启/);
});

test('pending death is displayed as awaiting rescue, not finalized elimination', () => {
  const pub = fixture(), target = pub.players[1];
  assert.match(watchTarget(target, pub, 'p1').reason, /等待救援/);
  assert.ok(!PlayerAvatar({ player: target }).props.class.includes('is-dead'));
  target.pendingDeath = false;
  assert.match(watchTarget(target, pub, 'p1').reason, /已被淘汰/);
  assert.ok(PlayerAvatar({ player: target }).props.class.includes('is-dead'));
});

test('party matching hints require a waiting coop, host, online humans and no AI', () => {
  const room = { mode: 'coop', hostId: 'p1', inMatch: false, seats: [{ playerId: 'p1', connected: true }, { playerId: 'p2', connected: true }] };
  assert.equal(partyQueueReason(room, 'p1'), null);
  assert.match(partyQueueReason(room, 'p2'), /创建者/);
  assert.match(partyQueueReason(room, 'p1', false), /连接中断/);
  assert.match(partyQueueReason({ ...room, inMatch: true }, 'p1'), /等待/);
  assert.match(partyQueueReason({ ...room, mode: 'solo' }, 'p1'), /等待/);
  assert.match(partyQueueReason({ ...room, seats: [...room.seats, { playerId: 'bot', isBot: true }] }, 'p1'), /移除 AI/);
  assert.match(partyQueueReason({ ...room, seats: [...room.seats, { playerId: 'p3', connected: false }] }, 'p1'), /所有队友/);
});

test('revival ballot displays server threshold and disables a lone human', () => {
  const textOf = node => node == null ? '' : Array.isArray(node) ? node.map(textOf).join('') : typeof node !== 'object' ? String(node) : textOf(node.props?.children);
  const room = { mode: 'coop', inMatch: false, seats: [{ playerId: 'p1' }, { playerId: 'p2' }, { playerId: 'p3' }], revival: { yes: 2, required: 2, enabled: true } };
  assert.match(textOf(RevivalVote({ room, myId: 'p1', online: true })), /2 \/ 2 票赞成/);
  const single = { ...room, seats: [{ playerId: 'p1' }, { playerId: 'bot', isBot: true }], revival: { yes: 0, required: 2, enabled: false } };
  const view = RevivalVote({ room: single, myId: 'p1', online: true });
  assert.match(textOf(view), /暂无可救援队友/);
  const buttons = [];
  const visit = node => { if (Array.isArray(node)) return node.forEach(visit); if (node?.props) { if (node.props.onClick) buttons.push(node); visit(node.props.children); } };
  visit(view);
  assert.equal(buttons.length, 2);
  assert.ok(buttons.every(node => node.props.disabled));
});

test('queue UI distinguishes pending vs allocated and clamps clocks', () => {
  assert.equal(queueActive({ state: 'queued' }), true);
  assert.equal(queueActive({ state: 'offered' }), true);
  assert.equal(queueActive({ state: 'matched' }), false);
  assert.equal(queueActive(null), false);
  assert.equal(queueTime({ state: 'queued', joinedAt: 1000 }, 3200), 2);
  assert.equal(queueTime({ state: 'queued', joinedAt: 9000 }, 3200), 0);
  assert.equal(queueTime({ state: 'offered', deadline: 6000 }, 3200), 3);
  assert.equal(queueTime({ state: 'offered', deadline: 3000 }, 3200), 0);
});
