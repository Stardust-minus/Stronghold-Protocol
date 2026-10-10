import test from 'node:test';
import assert from 'node:assert/strict';
import { queuePopulation } from '../../public/js/ui/matchmaking.js';

for (const count of [0, 1, 6, 20, 120]) {
  test(`waiting population ${count} is shown exactly, not capped to target capacity`, () => {
    assert.equal(queuePopulation({ state: 'queued', required: 4, waitingCount: count }, true), count);
  });
}
test('missing, invalid and non-current population stays unknown rather than fabricated zero', () => {
  for (const count of [undefined, null, -1, 1.5, '6', Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(queuePopulation({ state: 'queued', waitingCount: count }, true), null);
  }
  for (const state of ['idle', 'offered', 'matched']) assert.equal(queuePopulation({ state, waitingCount: 6 }, true), null);
  assert.equal(queuePopulation({ state: 'queued', waitingCount: 6 }, false), null);
  assert.equal(queuePopulation({ state: 'queued', waitingCount: 6 }, true, true), null);
});
