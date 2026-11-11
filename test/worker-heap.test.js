// server/workerHeap.js: the bounded young generation of the game's Worker isolates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WORKER_YOUNG_MB, parseWorkerYoungMb, workerResourceLimits } from '../server/workerHeap.js';
import { CombatWorkerPool } from '../server/match/combat/pool.js';
import { SimulationPool } from '../server/workers/pool.js';

const quiet = { info() {}, warn() {}, error() {} };

test('SP_WORKER_YOUNG_MB: unset is the default, 0 is V8 sizing, anything else outside 3–256 is refused', () => {
  assert.equal(DEFAULT_WORKER_YOUNG_MB, 24);
  for (const unset of [undefined, null, '']) assert.equal(parseWorkerYoungMb(unset), 24);
  assert.equal(parseWorkerYoungMb('0'), 0);
  assert.equal(parseWorkerYoungMb(' 16 '), 16);
  assert.equal(parseWorkerYoungMb(3), 3);
  assert.equal(parseWorkerYoungMb('256'), 256);
  for (const bad of ['2', '257', '1.5', '-1', 'junk', '24MB', 2.5]) assert.throws(() => parseWorkerYoungMb(bad), RangeError, String(bad));
  assert.deepEqual(workerResourceLimits(0), {});
  assert.deepEqual(workerResourceLimits(24), { maxYoungGenerationSizeMb: 24 });
});

test('combat / trial and simulation Workers start with the bounded young generation', async (t) => {
  const pool = new CombatWorkerPool({ size: 1, log: quiet });
  t.after(() => pool.close());
  await pool.start();
  assert.equal(pool.slots[0].worker.resourceLimits.maxYoungGenerationSizeMb, DEFAULT_WORKER_YOUNG_MB);
  const sim = new SimulationPool({ size: 1, data: {}, workerUrl: new URL('./fixtures/pool-worker.mjs', import.meta.url) });
  t.after(() => sim.close());
  assert.equal(await sim.submit('burn', { value: 'ok' }).promise, 'ok');
  assert.equal([...sim.slots][0].worker.resourceLimits.maxYoungGenerationSizeMb, DEFAULT_WORKER_YOUNG_MB);
});
