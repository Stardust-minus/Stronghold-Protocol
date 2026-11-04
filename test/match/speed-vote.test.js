// 战斗 2 倍速 (server/match/match/speedVote.js): the standing vote of the connected humans, its count, when it takes
// effect (a battle's start, never during one) and what a checkpoint restore does with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PHASE, ERR, SPEED_VOTE_MULT } from '../../shared/constants.js';
import { validateC2S } from '../../shared/protocol.js';
import { canSnapshot, snapshotMatch, restoreMatch, MATCH_FIELDS } from '../../server/match/snapshot.js';
import { createRngFromState } from '../../server/sim/rng.js';
import { speedVoteState, battleSpeedScale } from '../../public/js/ui/matchStatus.js';
import { phaseTotalSeconds } from '../../public/js/ui/gameLogic/phases.js';
import { rerollNeed } from '../../server/match/match/setupVote.js';
import { makeMatch } from './harness.js';

const fake = (o = {}) => makeMatch({ mode: 'coop', seed: 65, fake: true, script: () => ({ duration: 4 }), ...o }).start();
/** A vote past the 300 ms burst guard. */
const vote = (h, id, agree) => { h.sched.advance(301); return h.m.handle(id, { t: 'g.speedVote', agree }); };
const counted = (m) => { const v = m.speedVoteView(); return [v.voters, v.need, v.agreed.length, v.next]; };

test('protocol: g.speedVote { agree }', () => {
  assert.equal(validateC2S({ t: 'g.speedVote', agree: true }), null);
  for (const msg of [{ t: 'g.speedVote' }, { t: 'g.speedVote', agree: 1 }]) assert.notEqual(validateC2S(msg), null, JSON.stringify(msg));
});

test('the bar is ceil(¾ × connected humans), a lone human passes it alone', (t) => {
  for (const [n, need] of [[1, 1], [2, 2], [3, 3], [4, 3]]) {
    const h = fake({ humans: n });
    t.after(() => h.m.dispose());
    assert.equal(h.m.speedVoteView().need, need, `${n} humans`);
    assert.equal(h.m.speedVoteView().next, false);
  }
  assert.deepEqual([8, 20].map(rerollNeed), [6, 15]);
  const h = fake({ humans: 1, bots: 3 });
  t.after(() => h.m.dispose());
  assert.equal(vote(h, 'p_0', true).ok, true);
  assert.deepEqual(counted(h.m), [1, 1, 1, true]);
});

test('AI seats are no voters; an offline vote neither counts nor blocks and counts again on return; a left one is gone', (t) => {
  const withAi = fake({ humans: 3, bots: 1 });
  t.after(() => withAi.m.dispose());
  assert.equal(withAi.m.speedVoteView().voters, 3);
  const h = fake({ humans: 4 });
  t.after(() => h.m.dispose());
  const m = h.m;
  for (const id of ['p_0', 'p_1', 'p_2']) vote(h, id, true);
  assert.deepEqual(counted(m), [4, 3, 3, true]);
  m.onDisconnect('p_0');
  assert.deepEqual(counted(m), [3, 3, 2, false]);
  m.onDisconnect('p_3'); // both voters left agree
  assert.deepEqual(counted(m), [2, 2, 2, true]);
  m.onReconnect('p_0');
  m.onReconnect('p_3');
  assert.deepEqual(counted(m), [4, 3, 3, true]);
  m.onLeave('p_1');
  assert.deepEqual(counted(m), [3, 3, 2, false]);
});

test('spectators, AI seats and offline seats have no vote; a repeat is a no-op; a burst is refused', (t) => {
  const h = fake({ humans: 2, bots: 1, spectators: ['viewer'] });
  t.after(() => h.m.dispose());
  const m = h.m;
  assert.equal(vote(h, 'ai_0', true).error, ERR.NOT_IN_ROOM);
  assert.ok(vote(h, 'viewer', true).error);
  m.onDisconnect('p_1');
  assert.equal(m.setSpeedVote(h.ps('p_1'), true).error, ERR.NOT_IN_ROOM);
  m.onReconnect('p_1');
  assert.equal(vote(h, 'p_0', true).ok, true);
  assert.equal(m.handle('p_0', { t: 'g.speedVote', agree: true }).ok, true);
  assert.equal(m.handle('p_0', { t: 'g.speedVote', agree: false }).error, ERR.RATE);
  assert.deepEqual(m.speedVoteView().agreed, ['p_0']);
});

test('an eliminated human is no voter while one still in the match is online (feedback #130); then the eliminated vote', (t) => {
  // the report: a 4-player match, 2 eliminated, 1 left — 3 confirmations were still needed for the last one standing
  const h = fake({ humans: 4 });
  t.after(() => h.m.dispose());
  const m = h.m;
  m.onLeave('p_3');
  h.ps('p_1').alive = false;
  h.ps('p_2').alive = false;
  assert.deepEqual(counted(m), [1, 1, 0, false]);
  assert.deepEqual(m.speedVoteView().ids, ['p_0']);
  assert.equal(vote(h, 'p_1', true).ok, true, 'the eliminated keep the switch');
  assert.deepEqual(counted(m), [1, 1, 0, false], 'but it does not count');
  vote(h, 'p_0', true);
  assert.deepEqual(counted(m), [1, 1, 1, true], 'the one standing alone passes it');
  // nobody still in the match online (the AI plays for p_0): the eliminated connected doctors vote [ASSUMED]
  m.onDisconnect('p_0');
  assert.deepEqual(m.speedVoteView().ids, ['p_1', 'p_2']);
  assert.deepEqual(counted(m), [2, 2, 1, false]);
  vote(h, 'p_2', true);
  assert.deepEqual(counted(m), [2, 2, 2, true]);
  m.onReconnect('p_0');
  assert.deepEqual(m.speedVoteView().ids, ['p_0']);
  h.ps('p_1').alive = true;
  h.ps('p_2').alive = true;
});

test('a vote takes effect when the next battle starts, a running battle keeps its speed, falling short restores the next one', (t) => {
  const h = fake({ humans: 2, bots: 1, instant: false });
  t.after(() => h.m.dispose());
  const m = h.m;
  h.runToPhase(PHASE.PREP, 1);
  const base = m.baseGameSpeed;
  vote(h, 'p_0', true);
  vote(h, 'p_1', true);
  assert.equal(m.gameSpeed, base, 'a vote alone changes nothing');
  assert.equal(m.speedVoteView().on, false);
  h.runToPhase(PHASE.COMBAT, 1);
  assert.equal(m.gameSpeed, base * SPEED_VOTE_MULT);
  assert.deepEqual([m.speedVoteView().on, m.speedVoteView().speed], [true, base * SPEED_VOTE_MULT]);
  const limit = m.wave.timeLimit;
  assert.equal(m.deadline - m.sched.now(), Math.round((limit / m.gameSpeed) * 1000), 'the countdown is the sped-up one');
  m._speedVoteAt.clear();
  assert.equal(m.handle('p_0', { t: 'g.speedVote', agree: false }).ok, true);
  assert.equal(m.gameSpeed, base * SPEED_VOTE_MULT, 'the running battle keeps its speed');
  assert.deepEqual([m.speedVoteView().on, m.speedVoteView().next], [true, false]);
  h.runToPhase(PHASE.PREP, 2);
  assert.equal(m.gameSpeed, base * SPEED_VOTE_MULT, 'prep leaves it alone: the next battle decides');
  h.runToPhase(PHASE.COMBAT, 2);
  assert.equal(m.gameSpeed, base);
  assert.equal(m.speedVoteView().on, false);
});

test('a replica is told the battle speed in b.start', (t) => {
  const h = fake({ humans: 2, bots: 1, instant: false, clientCombat: true });
  t.after(() => h.m.dispose());
  h.runToPhase(PHASE.PREP, 1);
  vote(h, 'p_0', true);
  vote(h, 'p_1', true);
  h.runToPhase(PHASE.COMBAT, 1);
  assert.equal(h.lastTo('p_0', 'b.start').speed, h.m.baseGameSpeed * SPEED_VOTE_MULT);
});

test('the speed stays under the ceiling', (t) => {
  const h = fake({ humans: 1 });
  t.after(() => h.m.dispose());
  h.m.baseGameSpeed = 150;
  h.m.gameSpeed = 150;
  vote(h, 'p_0', true);
  h.m._applySpeedVote();
  assert.equal(h.m.gameSpeed, 200);
});

test('every battle start applies the vote before its fields are built; a 联防 does not recount (feedback #137)', () => {
  const src = (f) => readFileSync(new URL(`../../server/match/match/${f}`, import.meta.url), 'utf8');
  assert.ok(src('combat.js').includes('  startCombat() {\n    this._applySpeedVote();'));
  assert.ok(src('bossRounds.js').includes('  startFinalAssault(hidden) {\n    this._applySpeedVote();'));
  assert.equal(src('unitePhase.js').includes('this._applySpeedVote()'), false, 'the 联防 keeps the round\'s speed');
});

/**
 * feedback #137 (planned by the owner, 2026-11-04): 「联防前退出，当次2倍速失效」 — 2 倍速 passed in a 4-player room, one
 * voter left before the 联防, the 联防 ran at 1× and the next battle at 2× again. From the wave's start to the 联防 settle
 * the speed stays; the next round's battle counts the votes as usual. p_0 leaks (the 联防 is fought by p_1 – p_3).
 */
function uniteRoom(t, o = {}) {
  const h = makeMatch({ mode: 'coop', humans: 4, seed: 3702, fake: true, instant: false, ...o,
    script: (b) => (b.kind === 'normal' ? { leaks: { p_0: 3 }, duration: 4 } : { duration: 4 }) }).start();
  t.after(() => h.m.dispose());
  h.toPrep(1);
  for (const id of ['p_1', 'p_2', 'p_3']) vote(h, id, true); // 3 of 4: the bar (3) is met
  return h;
}
for (const clientCombat of [false, true]) {
  for (const how of ['onLeave', 'onDisconnect']) {
    test(`feedback #137 (${clientCombat ? 'client-side combat' : 'server-run'}): a voter who ${how === 'onLeave' ? 'quits' : 'goes offline'} during the battle does not take the 联防 off 2 倍速`, (t) => {
      const h = uniteRoom(t, { clientCombat });
      const m = h.m, fast = m.baseGameSpeed * SPEED_VOTE_MULT;
      h.drive(() => m.phase === PHASE.COMBAT);
      assert.equal(m.gameSpeed, fast);
      m[how]('p_3');
      assert.deepEqual(counted(m), [3, 3, 2, false], 'the votes as they stand fall short');
      h.drive(() => m.phase === PHASE.UNITE);
      assert.deepEqual(m.unitePlan.helpers.map((p) => p.playerId).includes('p_1'), true);
      assert.equal(m.gameSpeed, fast, 'the 联防 continues the round at 2 倍速');
      assert.deepEqual([m.speedVoteView().on, m.speedVoteView().speed], [true, fast]);
      if (clientCombat) assert.equal(h.lastTo('p_1', 'b.start').speed, fast, 'the 联防 replica runs at it');
      else assert.equal(m.deadline - m.sched.now(), Math.round((m.uniteTimeLimit() / fast) * 1000), 'the 联防 countdown is the sped-up one');
      h.drive(() => m.phase === PHASE.SETTLE || m.phase === PHASE.PREP);
      assert.equal(m.gameSpeed, fast, 'the settle leaves it alone');
      h.drive(() => m.phase === PHASE.COMBAT && m.round === 2);
      assert.equal(m.gameSpeed, m.baseGameSpeed, 'the next battle counts the votes as usual: 2 of 3 is short');
      assert.equal(m.speedVoteView().on, false);
    });
  }
}

test('feedback #137: votes that pass during the battle do not speed up its 联防; the next round\'s battle starts at 2 倍速', (t) => {
  const h = makeMatch({ mode: 'coop', humans: 4, seed: 3702, fake: true, instant: false,
    script: (b) => (b.kind === 'normal' ? { leaks: { p_0: 3 }, duration: 4 } : { duration: 4 }) }).start();
  t.after(() => h.m.dispose());
  const m = h.m;
  h.toPrep(1);
  h.drive(() => m.phase === PHASE.COMBAT);
  assert.equal(m.gameSpeed, m.baseGameSpeed);
  for (const id of ['p_1', 'p_2', 'p_3']) vote(h, id, true);
  assert.equal(m.speedVoteView().next, true);
  h.drive(() => m.phase === PHASE.UNITE);
  assert.equal(m.gameSpeed, m.baseGameSpeed, 'the round keeps the speed its battle started with');
  h.drive(() => m.phase === PHASE.COMBAT && m.round === 2);
  assert.equal(m.gameSpeed, m.baseGameSpeed * SPEED_VOTE_MULT);
});

test('a checkpoint restore drops the votes and goes back to the base speed', (t) => {
  for (const k of ['_speedVotes', '_speedVoteAt', 'gameSpeed']) assert.ok(MATCH_FIELDS.transient.includes(k), k);
  assert.ok(MATCH_FIELDS.derived.includes('baseGameSpeed'));
  const h = fake({ humans: 2, bots: 1 });
  t.after(() => h.m.dispose());
  h.runToPhase(PHASE.PREP, 1);
  vote(h, 'p_0', true);
  vote(h, 'p_1', true);
  h.m._applySpeedVote();
  assert.ok(h.m.gameSpeed > h.m.baseGameSpeed);
  h.run(() => canSnapshot(h.m) || h.m.phase !== PHASE.PREP);
  assert.ok(canSnapshot(h.m));
  const doc = JSON.parse(JSON.stringify(snapshotMatch(h.m)));
  const r = makeMatch({ mode: 'coop', seats: doc.seats, seed: doc.seed, fake: true });
  t.after(() => r.m.dispose());
  assert.equal(restoreMatch(r.m, doc, { createRngFromState }), true);
  assert.equal(r.m.gameSpeed, r.m.baseGameSpeed);
  assert.deepEqual(r.m.publicView().speedVote.agreed, []);
});

test('m.public carries the count', (t) => {
  const h = fake({ humans: 2 });
  t.after(() => h.m.dispose());
  vote(h, 'p_1', true);
  assert.deepEqual(h.m.publicView().speedVote, { agreed: ['p_1'], voters: 2, ids: ['p_0', 'p_1'], need: 2, next: false, on: false, speed: h.m.baseGameSpeed });
});

test('client: what the switch shows', () => {
  const pub = (phase, v) => ({ phase, speedVote: { agreed: ['a'], need: 2, next: false, on: false, ...v } });
  assert.deepEqual(speedVoteState(pub('PREP', {}), 'a'), { status: 'idle', mine: true, count: 1, need: 2, voter: true });
  // rel29: `ids` names the voters (an eliminated doctor is none); a rel28 server sends none: everyone votes
  assert.equal(speedVoteState(pub('PREP', { ids: ['b'] }), 'a').voter, false);
  assert.equal(speedVoteState(pub('PREP', { ids: ['a', 'b'] }), 'a').voter, true);
  assert.equal(speedVoteState(pub('PREP', { next: true }), 'b').status, 'next');
  assert.equal(speedVoteState(pub('PREP', { next: true }), 'b').mine, false);
  assert.equal(speedVoteState(pub('COMBAT', { on: true, next: true }), 'a').status, 'on');
  assert.equal(speedVoteState(pub('COMBAT', { on: true }), 'a').status, 'ending');
  // outside a battle `on` is the last battle: what the votes decide now is the next one
  assert.equal(speedVoteState(pub('PREP', { on: true }), 'a').status, 'idle');
  assert.equal(speedVoteState(pub('INFO_CHECK', {}), 'a'), null);
  assert.equal(speedVoteState(pub('RESULT', {}), 'a'), null);
  assert.equal(speedVoteState({ phase: 'PREP' }, 'a'), null);
});

test('client: the countdown gauge and the overtime rate follow the battle speed', () => {
  const config = { modes: { m: { rounds: { 3: { combatTimeLimit: 30, levelMaxPlayTime: 120 } } } } };
  const pub = (phase, on) => ({ phase, modeId: 'm', round: 3, speedVote: { on } });
  assert.equal(phaseTotalSeconds(pub('COMBAT', false), config), 30);
  assert.equal(phaseTotalSeconds(pub('COMBAT', true), config), 15);
  assert.equal(phaseTotalSeconds(pub('UNITE', true), config), 15);
  assert.equal(phaseTotalSeconds(pub('FINAL_ASSAULT', false), config), 120);
  assert.equal(phaseTotalSeconds(pub('FINAL_ASSAULT', true), config), 60);
  assert.equal(battleSpeedScale(pub('FINAL_ASSAULT', true)), SPEED_VOTE_MULT);
  assert.equal(battleSpeedScale(pub('PREP', true)), 1);
});
