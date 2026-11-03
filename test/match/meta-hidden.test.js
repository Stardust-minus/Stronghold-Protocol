// A unit out of sight is in the field meta (rel26, the owner's report of 2026-11-02 「联防的时候，干员有概率变成红色水滴」):
// the snapshots leave a hidden unit out (an enemy inside a DISAPPEAR segment, 凯尔希·思衡托 in flight), and Battle.fieldMeta
// left it out too — a view entered meanwhile (a watched field, 联防, a reconnect) never got that unit's 'spawn', so when it
// came back it was an unknown: render/app.js createUnknown drew it as an enemy-styled red placeholder without a panel.
// Now the meta lists it flagged `hidden: true`; the snapshots are unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CombatEngine } from '../../server/match/combat/engine.js';
import { DATA, phase } from './combat-fixtures.js';

test('fieldMeta lists a deployed unit out of sight, flagged hidden; the snapshot still leaves it out', () => {
  const engine = new CombatEngine({ ...phase('normal'), wireFrames: false }, { data: DATA });
  try {
    const f = engine.fields[0];
    const b = f.battle;
    for (let i = 0; i < 1800 && !b.enemies.some((e) => e.alive && e.deployed && !e.hidden); i++) engine.advance(1);
    const e = b.enemies.find((x) => x.alive && x.deployed && !x.hidden);
    assert.ok(e, 'an enemy on the field');
    const ally = b.allyUnits.find((u) => u.alive && u.deployed);
    assert.ok(ally, 'an operator on the field');
    e.hidden = true;
    ally.hidden = true;
    const meta = b.fieldMeta();
    const snap = b.snapshot();
    for (const u of [e, ally]) {
      const info = meta.units.find((x) => x.id === u.id);
      assert.ok(info, `${u.defId} listed`);
      assert.equal(info.hidden, true);
      assert.equal(snap.units.some((t) => t[0] === u.id), false, 'the snapshot leaves it out');
    }
    assert.ok(meta.units.filter((x) => x.id !== e.id && x.id !== ally.id).every((x) => x.hidden === undefined), 'the visible ones carry no flag');
    e.hidden = false;
    ally.hidden = false;
    assert.equal(b.fieldMeta().units.find((x) => x.id === e.id).hidden, undefined, 'back in sight: no flag');
    // the opening panel cache never lists a hidden unit (test/match/battle-start-stats.test.js)
    e.hidden = true;
    const withStats = b.fieldMeta({ includeUnitStats: true });
    if (withStats.unitStats) assert.ok(!withStats.unitStats.some((s) => s.id === e.id));
    e.hidden = false;
  } finally {
    engine.dispose?.();
  }
});
