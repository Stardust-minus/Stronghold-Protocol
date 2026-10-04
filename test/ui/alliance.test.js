import test from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { revivalReason } from '../../public/js/ui/revival.js';
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
