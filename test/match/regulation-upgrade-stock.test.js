// test/match/regulation-upgrade-stock.test.js — 白铁's prep-start trait (规程 garrison_84_a/_b, SERVER_UPGRADE_SELF_EQUIP:
// 「进入休整期时使自身携带的装备变为精锐版本」) upgrades a carried normal item even when the shared equipment stock is full,
// and the copy the golden takes past the cap is a debt (PlayerState.upgradeItem overdraw), so the stock is never over its
// cap without one (server/match/invariants.js). It used to rewrite the id in place: a full 源石溶剂 (cap 4) went to 5 held
// with no debt — reported from the owner's RL runs with a minimal repro, 2026-11-16. 整备 still waits for a free copy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadData } from '../../server/data.js';
import { setGameData } from '../../server/sim/content/support/index.js';
import { SharedPool } from '../../server/match/pool.js';
import { createRegistry } from '../../server/match/effectsMeta.js';
import { collectViolations } from '../../server/match/invariants.js';
import { makeMatch, give, giveItem, legalTileFor } from './harness.js';

const QUIET = { warn() {}, info() {}, error() {} };
const data = loadData(fileURLToPath(new URL('../../data/versions/act3autochess-v3_1', import.meta.url)), { log: QUIET });
before(() => setGameData(data));
after(() => setGameData(null));
const BAITIE = 'chess_char_4_15_a', SOLVENT = 'chess_item_1_05_e_a', SOLVENT_G = 'chess_item_1_05_e_b';

/** Co-op, 2 seats: p_0's 白铁 carries one normal 源石溶剂 (its own g.equip); p_1 holds a golden one (2 copies) and,
 * with `full`, one more normal — 4 of 4. Then the next prep starts and the trait runs. */
function run(full) {
  const h = makeMatch({ data, mode: 'coop', humans: 2, bots: 0, fake: true, seed: 137, registry: createRegistry() }).start();
  const m = h.m;
  m.disabledBonds = []; m.bannedChess = []; m.pool = new SharedPool(m.gd);
  h.toPrep(1);
  const p0 = h.ps('p_0'), p1 = h.ps('p_1');
  const stock = p0.itemPool;
  const baitie = give(m, p0, BAITIE, 'board', legalTileFor(m, p0, BAITIE));
  const item = giveItem(m, p0, SOLVENT, 'temp');
  assert.equal(p0.equip(item.uid, baitie.uid).ok, true);
  giveItem(m, p1, SOLVENT_G, 'temp');
  if (full) giveItem(m, p1, SOLVENT, 'temp');
  const before = { held: stock.held(SOLVENT), left: stock.left(SOLVENT), debt: stock.debtOf(SOLVENT) };
  h.toPrep(2);
  const now = [...p0.hand, ...p0.temp].find((p) => p && p.uid === item.uid);
  const out = { before, upgraded: now?.id === SOLVENT_G, held: stock.held(SOLVENT), debt: stock.debtOf(SOLVENT),
    violations: collectViolations(m).filter((v) => v.includes('chess_item_1_05')) };
  m.dispose();
  return out;
}

test('白铁 upgrades past a full shared stock as a debt; with a free copy, no debt', () => {
  const full = run(true);
  assert.deepEqual(full.before, { held: 4, left: 0, debt: 0 });
  assert.equal(full.upgraded, true, 'the trait still upgrades (it takes no second shop copy)');
  assert.equal(full.held, 5);
  assert.equal(full.debt, 1, 'the copy past the cap is owed');
  assert.deepEqual(full.violations, []);
  const room = run(false);
  assert.deepEqual(room.before, { held: 3, left: 1, debt: 0 });
  assert.equal(room.upgraded, true);
  assert.equal(room.held, 4);
  assert.equal(room.debt, 0);
  assert.deepEqual(room.violations, []);
});
