// Bounded "every N layers" rewards (2026-11-04: a 调控台 room with the layer cap lifted set 维多利亚 to ~1e8 layers; its
// ~4 000 000 hammers — each grant re-entering payHammers through onGain / onMerge — held game-08's main thread for good):
// with the cap lifted the milestones stop at 999 layers' (shared/constants.js milestonesDue), one payment and the calls it
// re-enters share one budget, a capped room is unchanged, and the console sets at most testLayersMax layers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { milestonesDue, BOND_LAYER_CAP } from '../shared/constants.js';
import { EXPERIMENTAL_DEFAULTS } from '../shared/experimental.js';
import { testLayersMax, TEST_LAYERS_UNCAPPED_MAX } from '../shared/testMode.js';
import { payHammers, registerMeta as coreRegisterMeta } from '../server/sim/content/bonds/core.js';
import { registerMeta as addonRegisterMeta } from '../server/sim/content/bonds/addon/meta.js';
import { createRegistry } from '../server/match/effectsMeta.js';
import { explainTestDetail } from '../public/js/ui/testAudit.js';
import { makeMatch, DATA, give, legalTileFor } from './match/harness.js';

const UNCAPPED = Object.freeze({ ...EXPERIMENTAL_DEFAULTS, disableLayerCap: true });
const HAMMERS = 'bond:victoria:hammers';

test('milestonesDue: floor(layers / step); with the cap lifted never past 999 layers\'', () => {
  assert.equal(BOND_LAYER_CAP, 999);
  for (const [layers, step, want] of [[0, 25, 0], [24, 25, 0], [51, 25, 2], [999, 25, 39], [1e8, 25, 4e6], [75, 0, 0], [-5, 25, 0]]) {
    assert.equal(milestonesDue(layers, step), want, `${layers}/${step}`);
  }
  assert.equal(milestonesDue(1e8, 25, true), 39);
  assert.equal(milestonesDue(1e8, 10, true), 99);
  assert.equal(milestonesDue(1e8, 100, true), 9);
  assert.equal(milestonesDue(51, 25, true), 2, 'below the ceiling an uncapped room pays as a capped one');
});

/** A solo match with only the core bond meta and three 维多利亚 on the board (bonds_core.test.js's hammer test). */
function victoria(t, experimental) {
  const reg = createRegistry({ content: false });
  coreRegisterMeta(reg);
  const h = makeMatch({ mode: 'solo', seed: 5, registry: reg, fake: true, experimental }).start();
  t.after(() => h.m.dispose());
  h.toPrep(1);
  const ps = h.ps('p_0');
  for (const p of [...ps.board.values(), ...ps.hand.filter(Boolean)]) if (p.kind === 'chess') ps.returnCopies(p);
  ps.board.clear(); ps.hand.fill(null); ps.temp.fill(null);
  ps.recompute();
  for (const id of ['chess_char_1_06_a', 'chess_char_2_05_a', 'chess_char_3_08_a']) give(h.m, ps, id, 'board', legalTileFor(h.m, ps, id));
  assert.equal(ps.bonds.victoriaShip.active, true);
  return { h, ps };
}

test('维多利亚 at 1e8 layers with the cap lifted: 39 milestones at once, quickly, and no later hook pays more', (t) => {
  const { h, ps } = victoria(t, UNCAPPED);
  assert.equal(h.m.disableLayerCap, true);
  const started = performance.now();
  assert.equal(ps.addLayers('victoriaShip', 1e8), 1e8);
  assert.equal(ps.layers.victoriaShip, 1e8, 'the layers themselves stay uncapped');
  assert.equal(ps.counters[HAMMERS], 39);
  h.m.dispatch(ps, 'onPrepStart', { round: h.m.round });
  h.m.dispatch(ps, 'onPrepEnd', { round: h.m.round });
  ps.addLayers('victoriaShip', 1e8);
  assert.equal(ps.counters[HAMMERS], 39);
  assert.ok(performance.now() - started < 5000, `${Math.round(performance.now() - started)} ms`);
});

test('a capped room is unchanged: 1e8 layers stop at 999 and pay 39', (t) => {
  const { h, ps } = victoria(t, undefined);
  assert.equal(h.m.disableLayerCap, false);
  assert.equal(ps.addLayers('victoriaShip', 1e8), 999);
  assert.equal(ps.counters[HAMMERS], 39);
});

test('payHammers: one payment and every call its grants re-enter share one budget of 100 milestones', () => {
  const run = (playerId, gd, counters, log) => {
    const ctx = {
      gd, playerId, layerCapOff: false, data: DATA, bondActive: (id) => id === 'victoriaShip', layers: () => 1e8,
      counter: (k) => counters[k] ?? 0, setCounter: (k, v) => { counters[k] = v; },
      rollItem: () => 'item', toast() {},
      // like grantItem → onGain → bond:victoriaShip hammers: a fresh ctx of the same player re-enters at once
      grantItem: () => { log.push(playerId); log.depth = (log.depth ?? 0) + 1; if (log.depth < 6) run(playerId, gd, counters, log); log.depth--; return true; },
    };
    return payHammers(ctx);
  };
  const gd = {}, counters = {}, log = [];
  run('p', gd, counters, log);
  assert.equal(counters[HAMMERS], 100, 'one budget for the chain (it used to be up to 100 per nested call)');
  assert.equal(log.length, 100);
  run('p', gd, counters, log);
  assert.equal(counters[HAMMERS], 200, 'the next payment brings its own budget');
  // another player's payment inside this one has its own
  const other = {};
  const ctx = { gd, playerId: 'q', layerCapOff: false, data: DATA, bondActive: () => true, layers: () => 1e8, rollItem: () => 'item', toast() {},
    counter: (k) => other[k] ?? 0, setCounter: (k, v) => { other[k] = v; },
    grantItem: () => { if (!ctx.inner) { ctx.inner = true; run('p', gd, counters, []); } return true; } };
  payHammers(ctx);
  assert.equal(other[HAMMERS], 100);
  assert.equal(counters[HAMMERS], 300);
});

test('远见 / 奇迹 funds with the cap lifted stop at 999 layers\' too; capped, the formula is unchanged', () => {
  const reg = createRegistry({ content: false });
  addonRegisterMeta(reg);
  for (const [bondId, uncapped, want] of [['visiShip', true, 99 * 2], ['miraShip', true, 9 * 20], ['visiShip', false, 1e7 * 2]]) {
    const counters = {}, funds = [];
    const ctx = { layerCapOff: uncapped, data: DATA, phase: 'PREP', round: 3, bondActive: () => true, layers: () => 1e8,
      counter: (k) => counters[k] ?? 0, setCounter: (k, v) => { counters[k] = v; }, addFunds: (n) => funds.push(n),
      addPendingFunds: (n) => funds.push(n), toast() {}, chessRecord: () => null };
    reg.get(`bond:${bondId}`).onLayers(ctx, { bondId });
    assert.deepEqual(funds, [want], `${bondId} uncapped=${uncapped}`);
  }
});

function consoleMatch(t, experimental) {
  const h = makeMatch({ mode: 'solo', experimental: { ...experimental, console: true } });
  t.after(() => h.m.dispose());
  h.start(); h.toPrep();
  h.cmd = (cmd, args = {}) => h.m.handle('p_0', { t: 'g.test', cmd, args });
  return h;
}

test('调控台: bond layers up to the room cap, 99 999 with it lifted; the refusal names the maximum', (t) => {
  assert.equal(testLayersMax(false), 999);
  assert.equal(testLayersMax(true), TEST_LAYERS_UNCAPPED_MAX);
  assert.equal(TEST_LAYERS_UNCAPPED_MAX, 99_999);
  const capped = consoleMatch(t, EXPERIMENTAL_DEFAULTS);
  const over = capped.cmd('bond', { id: 'victoriaShip', count: 6, layers: 1000 });
  assert.equal(over.error, 'BAD_TARGET');
  assert.equal(over.detail, 'layersMax|{"max":999}');
  assert.equal(explainTestDetail(over.detail), '层数最多 999');
  assert.deepEqual(capped.cmd('bond', { id: 'victoriaShip', count: 6, layers: 999 }), { ok: true });
  assert.equal(capped.ps('p_0').counters[HAMMERS], 39);

  const free = consoleMatch(t, UNCAPPED);
  const started = performance.now();
  const huge = free.cmd('bond', { id: 'victoriaShip', count: 6, layers: 100_000_000 });
  assert.equal(huge.error, 'BAD_TARGET');
  assert.equal(huge.detail, 'layersMax|{"max":99999}');
  assert.equal(free.ps('p_0').layers.victoriaShip ?? 0, 0, 'nothing applied');
  assert.deepEqual(free.cmd('bond', { id: 'victoriaShip', count: 6, layers: 99_999 }), { ok: true });
  assert.equal(free.ps('p_0').layers.victoriaShip, 99_999);
  assert.equal(free.ps('p_0').counters[HAMMERS], 39, 'the hammers stop at 999 layers\'');
  assert.ok(performance.now() - started < 5000);
  // a count-only change of a bond already past the maximum is still allowed (no layers added)
  free.ps('p_0').layers.victoriaShip = 200_000;
  assert.deepEqual(free.cmd('bond', { id: 'victoriaShip', count: 5, layers: 200_000 }), { ok: true });
});
