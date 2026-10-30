// Feedback #40 「飞行单位怪物移动速度异常：法抗飞机飞行速度异常的快」 — the flyer with the high arts resistance is 法术大师A1
// (enemy_1041_lazerd, RES 65). Verdict: not a bug, it matches the official data. enemy_database gives it moveSpeed 1.5
// (A2 0.8, 妖怪 and 寒霜 0.9) and its own description says 「飞行速度非常快」; every official level has moveMultiplier 0.5,
// so it flies 0.75 tiles/s, the fastest of the regular flyers, and 终极 adds its official ×1.15 from R3.
// Pinned here so a later change to the movement or the data shows up: the sim moves a flyer at moveSpeed × MOVE_SCALE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle } from '../helpers/battleHarness.js';
import { hasGeneratedData, getDefaultSource } from '../../server/sim/simdata.js';
import { MOVE_SCALE } from '../../server/sim/constants.js';

const FLY_ROUTE = 2;   // battleHarness flatRoutes: fly low
const skip = !hasGeneratedData() && 'needs the built data';

/** Tiles per second an enemy actually covers along a straight fly route. */
function flown(key) {
  const h = makeBattle({ seed: 1, autoFinish: false, timeLimit: 60, units: [] });
  h.step();
  const e = h.spawn(key, { routeIndex: FLY_ROUTE, mods: { hpMul: 1e4, atkMul: 0 } });
  const t0 = h.b.time;
  let moved = 0;
  for (let i = 0; i < 300 && e.alive; i++) {
    const { x, y } = e;
    h.step();
    moved += Math.hypot(e.x - x, e.y - y);
  }
  return { motion: e.motion, tilesPerSec: moved / (h.b.time - t0) };
}

test('法术大师A1: official moveSpeed 1.5, the fastest regular flyer (#40)', { skip }, () => {
  const speed = (key) => getDefaultSource().rawEnemy(key).stats.moveSpeed;
  assert.equal(speed('enemy_1041_lazerd'), 1.5);
  assert.equal(speed('enemy_1041_lazerd_2'), 0.8);
  assert.equal(speed('enemy_1005_yokai'), 0.9);
  assert.equal(speed('enemy_1042_frostd'), 0.9);
});

for (const [key, moveSpeed] of [['enemy_1041_lazerd', 1.5], ['enemy_1041_lazerd_2', 0.8], ['enemy_1005_yokai', 0.9]]) {
  test(`${key} flies moveSpeed × MOVE_SCALE (#40)`, { skip }, () => {
    const { motion, tilesPerSec } = flown(key);
    assert.equal(motion, 'FLY');
    assert.ok(Math.abs(tilesPerSec - moveSpeed * MOVE_SCALE) < 0.01, `${tilesPerSec} tiles/s`);
  });
}
