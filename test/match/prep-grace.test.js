// PREP_INTENT_GRACE_MS (server/match/match/common.js): a timed PREP ends its grace after the published deadline; the
// countdown players see (m.public.deadline) is unchanged, and an intent sent just before it ran out still counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { PREP_INTENT_GRACE_MS } from '../../server/match/Match.js';
import { makeMatch } from './harness.js';

test('the default PREP grace is 1.5 s, the option at most 5 s', () => {
  assert.equal(PREP_INTENT_GRACE_MS, 1500);
  assert.equal(makeMatch({ mode: 'coop', humans: 2, prepGraceMs: 60_000 }).m.prepGraceMs, 5000, 'bounded');
});

test('a co-op PREP takes intents until its published deadline + prepGraceMs, then ends', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 12, fake: true, prepGraceMs: 1500 }).start();
  h.toPrep(1);
  const { m } = h;
  const published = m.deadline;
  assert.ok(published > h.sched.now(), 'co-op prep is timed');
  assert.equal(Math.round((published - h.sched.now()) / 1000), m.gd.prepTime(1), 'the countdown is the full prep time');
  h.sched.advance(published - h.sched.now() + 1000);
  assert.equal(m.phase, PHASE.PREP, 'still PREP 1 s past the published deadline');
  assert.equal(m.deadline, published, 'the published deadline did not move');
  assert.deepEqual(m.handle('p_0', { t: 'g.refresh' }).ok, true, 'an intent in the grace is accepted');
  h.sched.advance(600);
  assert.notEqual(m.phase, PHASE.PREP, 'PREP ended after the grace');
});

test('prepGraceMs 0 ends PREP at the published deadline', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 12, fake: true, prepGraceMs: 0 }).start();
  h.toPrep(1);
  const { m } = h;
  h.sched.advance(m.deadline - h.sched.now() + 1);
  assert.notEqual(m.phase, PHASE.PREP);
});
