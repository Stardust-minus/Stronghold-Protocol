// feedback #111 「阵亡之后可以出模拟中断结算的界面吗」: a human knocked out while the match goes on gets its 个人战报 at
// once — m.private `out` (server/match/results.js buildOutResult), built before its board returns to the pool — and the
// match's m.result at the end is unchanged (screens/settle.js OutReport, ui/downedPlate.js 前往结算).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { makeMatch, give, legalTileFor, chessOfTier } from './harness.js';

const leakOut = (b) => (b.round !== 2 ? {} : b.kind === 'unite' ? { survivors: { p_1: 10 } } : { leaks: { p_1: 10 } });

test('an eliminated human gets its 个人战报 at once: m.private `out` with its lineup of that moment and the end\'s rounds, trophies and reward', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 2, seed: 80, fake: true, script: leakOut }).start();
  const m = h.m;
  h.toPrep(1);
  const ps = h.ps('p_1');
  const chessId = chessOfTier(1)[0];
  give(m, ps, chessId, 'board', legalTileFor(m, ps, chessId));
  ps.lp = 5;
  assert.equal(ps.privateView().out, undefined, 'nothing while alive');
  h.drive(() => m.phase === PHASE.PREP && m.round === 3);
  assert.equal(ps.alive, false);
  assert.equal(ps.board.size, 0, 'its board went back to the pool');
  h.flushAll();
  const out = h.lastTo('p_1', 'm.private')?.out;
  assert.ok(out, 'm.private carries the report');
  assert.deepEqual([out.provisional, out.victory, out.reason, out.roundsPassed, out.players.length], [true, false, 'eliminated', 1, 1]);
  const row = out.players[0];
  assert.deepEqual([row.playerId, row.alive, row.victory, row.roundsPassed, row.eliminatedRound, row.title], ['p_1', false, false, 1, 2, null]);
  assert.deepEqual(row.lineup.map((x) => x.id), [chessId], 'the lineup it had when it fell');
  assert.ok(Number.isFinite(row.reward) && Number.isFinite(row.trophies));
  // the teammate plays on and gets none
  assert.equal(h.ps('p_0').privateView().out, undefined);
  // the match's own result: the same rounds, trophies and reward for that row (its lineup there is the empty board)
  h.m.onLeave('p_0');
  const end = h.ended.players.find((p) => p.playerId === 'p_1');
  assert.deepEqual([end.roundsPassed, end.trophies, end.reward, end.eliminatedRound], [row.roundsPassed, row.trophies, row.reward, row.eliminatedRound]);
  assert.deepEqual(end.lineup, []);
  m.dispose();
});

test('no 个人战报 for an AI seat, nor once the match is over', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 1, bots: 1, seed: 7, fake: true }).start();
  const m = h.m;
  h.toPrep(1);
  const bot = h.ps('ai_0');
  m._finalizeDeath(bot, { notify: false, reason: 'no-helper' });
  assert.equal(bot.outResult, undefined);
  m.ended = true;
  const me = h.ps('p_0');
  m._finalizeDeath(me, { notify: false, reason: 'match-ended' });
  assert.equal(me.outResult, undefined);
  m.dispose();
});
