// Fork rule: 联防 stays on the match's original map, including terrain and devices.
// The escaped templates still supply the re-entry wave, not a replacement board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE, GEO } from '../../shared/constants.js';
import { Battle } from '../../server/sim/Battle.js';
import { createBattleFromSpec } from '../../server/sim/spec.js';
import { DataSource, normalizeStage } from '../../server/sim/simdata.js';
import { FakeBattle } from './fakeBattle.js';
import { DATA, makeMatch, give, chessOfTier, legalTileFor, checkInvariants } from './harness.js';

class NoFinish extends Battle {
  constructor(opts) { super({ ...opts, autoFinish: false }); }
}

function scenario({ helpers, clientCombat, stageId }) {
  const h = makeMatch({
    mode: 'coop', humans: helpers + 1, seed: 7100 + helpers, fake: true, clientCombat,
    script: (b) => b.kind === 'normal' ? { leaks: { p_0: 3 } } : {},
  }).start();
  const m = h.m;
  h.toPrep(1);
  h.setStage(stageId);
  const ranged = chessOfTier(1, (c) => c.position === 'RANGED').filter((id) => m.pool.has(id));
  for (let i = 1; i <= helpers; i++) {
    const ps = h.ps(`p_${i}`), id = ranged[i];
    give(m, ps, id, 'board', legalTileFor(m, ps, id));
  }
  h.drive(() => m.phase === PHASE.UNITE);
  const opts = clientCombat ? m.fields[0].spec : FakeBattle.instances.find((b) => b.kind === 'unite').opts;
  const battle = clientCombat
    ? createBattleFromSpec(opts, new DataSource(DATA, null), { BattleClass: NoFinish })
    : new NoFinish({ ...opts, data: m.ds, logger: { warn() {}, error() {}, info() {}, debug() {} } });
  return { h, m, opts, battle };
}

for (const helpers of [1, 2]) {
  for (const clientCombat of [false, true]) {
    test(`联防 retains original walls and fences: ${helpers} helper(s), ${clientCombat ? 'client spec' : 'server battle'}`, () => {
      const { h, m, opts, battle } = scenario({ helpers, clientCombat, stageId: 'act1autochess_m01' });
      try {
        assert.equal(opts.stageId, m.stageId);
        assert.equal(battle.stageId, 'act1autochess_m01');
        assert.deepEqual(opts.rect, GEO.UNITE_RECT);
        assert.deepEqual(battle.stage.rows, m.stage.rows);
        assert.equal(battle.grid.groundPassable(9, 5), false, 'the original obstacle still blocks, not just a drawn prop');
        assert.equal(battle.stage.rows[10][3], 'b', 'the original fence remains');
        m.handle('p_0', { t: 'g.watch', fieldId: 'u' });
        const shownStage = clientCombat ? h.lastTo('p_0', 'b.start')?.spec?.stageId : h.lastTo('p_0', 'm.field')?.stageId;
        assert.equal(shownStage, m.stageId, 'watcher draws the same map as the sim');
        assert.deepEqual(opts.players.map((p) => p.colOffset), helpers === 2 ? [8, 0] : [0]);
        battle.step();
        for (const ps of m.unitePlan.helpers) {
          const [r, c] = [...ps.board.keys()][0].split(',').map(Number);
          const off = opts.players.find((p) => p.playerId === ps.playerId).colOffset;
          const unit = battle.allyUnits.find((u) => u.ownerId === ps.playerId && u.kind === 'op');
          assert.ok(unit, 'the carried helper is deployed');
          assert.deepEqual([unit.tileR, unit.tileC], [r, c + off]);
        }
        assert.equal(battle.errorCount, 0);
        checkInvariants(m);
      } finally { m.dispose(); }
    });
  }
}

for (const stageId of ['act1autochess_m02', 'act2autochess_m01', 'act2autochess_m02', 'act2autochess_m03']) {
  test(`联防 retains the original map's device/terrain records: ${stageId}`, () => {
    const { m, opts, battle } = scenario({ helpers: 2, clientCombat: false, stageId });
    try {
      assert.equal(opts.stageId, stageId);
      assert.deepEqual(battle.stage.devices, normalizeStage(stageId, m.stage).devices, 'all original device definitions retained after sim normalization');
      assert.deepEqual(battle.stage.special, m.stage.special);
      battle.step();
      const crates = m.stage.devices.filter((d) => d.active && d.role === 'crate' && d.pos[0] >= GEO.UNITE_RECT.r0 && d.pos[0] <= GEO.UNITE_RECT.r1);
      assert.deepEqual(battle.allyUnits.filter((u) => u.kind === 'device' && u.obstacleKind === 'crate').map((u) => [u.tileR, u.tileC]).sort(), crates.map((d) => d.pos).sort(), 'original active crates are real sim obstacles');
      assert.equal(battle.errorCount, 0);
      assert.equal(battle.fieldMeta().stageId, stageId);
    } finally { m.dispose(); }
  });
}
