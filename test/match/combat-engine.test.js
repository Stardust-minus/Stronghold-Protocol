import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CombatEngine, MAX_ADVANCE_TICKS } from '../../server/match/combat/engine.js';
import { FieldRunner, emptyPerPlayer } from '../../server/match/fields.js';
import { SharedBossPool } from '../../server/match/finalAssault.js';
import { GameData } from '../../server/match/gamedata.js';
import { createBattleFromSpec } from '../../server/sim/spec.js';
import { TICK } from '../../server/sim/constants.js';
import { combatData } from '../../server/match/combat/data.js';
import { gameData } from '../../server/sim/content/support/index.js';
import { DATA, QUIET, phase } from './combat-fixtures.js';

function reference(input, BattleClass) {
  const boss = input.boss && { ...input.boss };
  const pool = boss && new SharedBossPool(boss.maxHp);
  const effects = [];
  if (pool) {
    pool.hp = boss.hp;
    pool.onHit = (playerId, amount) => effects.push({ type: 'bossDamage', playerId, amount });
  }
  const lp = (amount) => {
    if (!Number.isFinite(amount) || amount <= 0) return;
    boss.teamLp = Math.max(0, boss.teamLp - amount);
    effects.push({ type: 'lpLoss', amount });
  };
  const fields = input.specs.map((s) => {
    const battle = createBattleFromSpec(s, combatData(DATA), { sharedBoss: pool, BattleClass, logger: QUIET });
    if (boss) {
      battle.on('enemyLeak', (ctx) => lp(Number.isFinite(ctx?.enemy?.lpr) && ctx.enemy.lpr >= 0 ? ctx.enemy.lpr : 1));
      battle.on('lpLoss', (ctx) => lp(Number(ctx?.amount)));
    }
    return { fieldId: s.fieldId, kind: s.kind, players: s.players.map((p) => p.playerId), battle };
  });
  const runner = new FieldRunner({
    markPublic() {}, reportError(label, e) { throw new Error(`${label}: ${e}`); }, watchersOf() { return []; },
  }, fields, {
    onDone() {}, onTick: boss ? (r) => {
      const due = GameData.prototype.bossOvertimeDue.call(boss, r.time);
      if (due > boss.overtimeApplied) { const loss = due - boss.overtimeApplied; boss.overtimeApplied = due; lp(loss); }
      if (boss.teamLp <= 0 && pool.hp > 0) r.forceAll('forced');
    } : null,
  });
  return { runner, fields, boss, pool, effects };
}

for (const kind of ['normal', 'unite', 'boss', 'hidden']) {
  test(`real ${kind}: full engine results equal the original FieldRunner`, () => {
    const input = phase(kind);
    const e = new CombatEngine(input, { data: DATA, log: QUIET });
    const r = reference(input);
    const effects = [];
    let out = e.state({ snapshotFields: input.specs.map((s) => s.fieldId) });
    assert.equal(out.frames.length, input.specs.length);
    while (!out.done) {
      out = e.advance(30);
      effects.push(...out.effects);
      for (let n = 0; n < 30 && !r.runner.done; n++) { r.runner._tick(); r.runner._checkDone(); }
    }
    assert.deepEqual(out.fields.map((f) => f.result), r.fields.map((f) => r.runner.resultOf(f)));
    assert.deepEqual(effects, r.effects);
    assert.equal(out.ticks, r.runner.ticks);
    assert.equal(out.frames.filter((f) => !!f.snapshot && !!f.meta).length >= input.specs.length, true);
    for (const field of out.fields) {
      assert.ok(Array.isArray(field.errors));
      assert.ok(Object.values(field.result.perPlayer).every((p) => Array.isArray(p.unitStats)));
    }
    if (kind === 'unite') assert.equal(out.fields[0].result.unspawned.length, 1);
    if (r.pool) {
      assert.equal(out.boss.hp, r.pool.hp);
      assert.deepEqual(out.boss.byPlayer, [...r.pool.byPlayer]);
      assert.equal(out.boss.teamLp, r.boss.teamLp);
      assert.ok(effects.some((x) => x.type === 'bossDamage'), 'real units damage the shared boss');
    }
    assert.deepEqual(e.state().effects, [], 'effects are consumed once, never replayed by state');
    e.dispose();
  });
}

// Scripted ordering probes expose effects/snapshots at the exact tick boundary, independently of real kits.
class ProbeBattle {
  constructor(opts) {
    this.opts = opts;
    this.fieldId = opts.fieldId;
    this.kind = opts.kind;
    this.sharedBoss = opts.sharedBoss;
    this.time = 0;
    this.tickCount = 0;
    this.finished = false;
    this.hooks = new Map();
    this.errors = [];
  }
  on(name, fn) { this.hooks.set(name, fn); return name; }
  off(name) { this.hooks.delete(name); }
  step() {
    this.time = ++this.tickCount * TICK;
    const flags = this.opts.flags;
    if (flags.leak) this.hooks.get('lpLoss')?.({ amount: flags.leak });
    if (flags.hit) this.sharedBoss.damage(this.opts.players[0].playerId, flags.hit);
    if (flags.end || this.sharedBoss?.hp <= 0) this.forceEnd('cleared');
  }
  forceEnd(reason) { this.finished = true; this.reason = reason; }
  result() { return { reason: this.reason, time: this.time, errors: 0, perPlayer: Object.fromEntries(this.opts.players.map((p) => [p.playerId, emptyPerPlayer()])), unspawned: [{ enemyKey: 'pending' }] }; }
  snapshot() { return { fieldId: this.fieldId, t: this.time, hp: this.sharedBoss?.hp, units: [{ id: this.tickCount }] }; }
  fieldMeta() { return { fieldId: this.fieldId, units: [{ id: this.tickCount, state: this.finished ? 'ended' : 'live' }] }; }
  drainEvents() { return [{ t: this.time }]; }
}

function probe(flags, boss = null) {
  return {
    boss,
    specs: flags.map((f, i) => ({ fieldId: `f${i}`, kind: boss ? 'boss' : 'normal', flags: f, players: [{ playerId: `p${i}` }], spawns: [] })),
  };
}
const smallBoss = { maxHp: 10, hp: 10, teamLp: 1, overtimeApplied: 0, combatTimeScale: 1 / 30, bossOvertimeAfterReal: 0, bossOvertimeDrainReal: 1 };

test('same tick: all fields step after LP zero; later kill beats force; overtime still runs after kill', () => {
  const input = probe([{ leak: 1 }, { hit: 10 }], smallBoss);
  const e = new CombatEngine(input, { BattleClass: ProbeBattle, log: QUIET });
  const r = reference(input, ProbeBattle);
  const out = e.advance(1);
  r.runner._tick(); r.runner._checkDone();
  assert.deepEqual(out.effects, r.effects);
  assert.deepEqual(out.effects.map((x) => x.type), ['lpLoss', 'bossDamage', 'lpLoss']);
  assert.equal(out.boss.hp, 0);
  assert.equal(out.boss.teamLp, 0);
  assert.equal(out.boss.overtimeApplied, 1);
  assert.deepEqual(out.fields.map((f) => f.tickCount), [1, 1]);
  assert.equal(out.fields[0].live, true, 'FieldRunner does not retroactively finish the earlier field at pool zero');
  assert.equal(out.fields[1].result.reason, 'cleared');
  assert.equal(e.advance(1).done, true);
  e.dispose();
});

test('same tick: emit every 3 ticks precedes overtime; forced finals refresh snapshot and meta for all fields', () => {
  const input = probe([{}, {}], { ...smallBoss, combatTimeScale: 0.1, teamLp: 1 });
  const e = new CombatEngine(input, { BattleClass: ProbeBattle, log: QUIET });
  assert.equal(e.advance(2, { snapshotFields: ['f0'] }).frames.length, 0);
  const out = e.advance(1, { snapshotFields: ['f0'] });
  assert.equal(out.done, true);
  assert.equal(out.frames[0].meta.units[0].state, 'live', 'ordinary streaming emit comes before onTick');
  for (const id of ['f0', 'f1']) {
    const frame = out.frames.filter((f) => f.fieldId === id).at(-1);
    assert.equal(frame.meta.units[0].state, 'ended');
    assert.equal(frame.snapshot.t, 3 * TICK);
  }
  assert.equal(out.effects[0].amount, 1);
  assert.deepEqual(e.state().effects, []);
  e.dispose();
});

test('state returns fresh matching meta/snapshot without advancing or consuming cadence; forceField affects only target', () => {
  const e = new CombatEngine(probe([{}, {}]), { BattleClass: ProbeBattle, log: QUIET });
  const init = e.state({ snapshotFields: ['f0', 'f1'] });
  e.advance(2);
  const state = e.state({ snapshotFields: ['f0'] });
  assert.equal(state.ticks, 2);
  assert.equal(state.frames[0].snapshot.units[0].id, state.frames[0].meta.units[0].id);
  assert.equal(init.frames[0].snapshot.units[0].id, 0, 'old DTO is immutable by later commands');
  const force = e.forceField('f0', 'forced');
  assert.equal(force.fields[0].live, false);
  assert.equal(force.fields[1].live, true);
  assert.ok(force.frames.some((f) => f.fieldId === 'f0' && f.meta.units[0].state === 'ended'));
  assert.equal(e.forceField('f0').done, false);
  assert.equal(e.forceAll().done, true);
  assert.deepEqual(e.forceAll().effects, []);
  e.dispose();
  e.dispose();
  assert.throws(() => e.state(), /disposed/);
});

test('constructor and step failures retain synthetic results and diagnostic records separately', () => {
  class Broken extends ProbeBattle {
    constructor(opts) { super(opts); if (opts.fieldId === 'f0') throw new Error('constructor diagnostic'); }
    step() { this.errors.push({ label: 'kit', who: 'u', message: 'retained kit error' }); throw new Error('step diagnostic'); }
    forceEnd() { throw new Error('force diagnostic'); }
  }
  const e = new CombatEngine(probe([{}, {}]), { BattleClass: Broken, log: QUIET });
  const out = e.advance(1);
  assert.equal(out.done, true);
  assert.ok(out.fields.every((f) => f.result.synthetic === true));
  assert.ok(out.fields[0].errors.some((x) => x.message === 'constructor diagnostic'));
  assert.ok(out.fields[1].errors.some((x) => x.message === 'retained kit error'));
  assert.ok(out.fields[1].errors.some((x) => x.message === 'step diagnostic'));
  assert.ok(out.fields[1].errors.some((x) => x.message === 'force diagnostic'));
  e.dispose();
});

test('overtime formula is exactly GameData.bossOvertimeDue, including nonintegral drain', () => {
  const settings = { ...smallBoss, teamLp: 100, combatTimeScale: 1.7, bossOvertimeAfterReal: 0.17, bossOvertimeDrainReal: 0.25 };
  const e = new CombatEngine(probe([{}], settings), { BattleClass: ProbeBattle, log: QUIET });
  for (let i = 0; i < 8; i++) {
    const out = e.advance(17);
    assert.equal(out.boss.overtimeApplied, GameData.prototype.bossOvertimeDue.call(settings, out.time));
  }
  e.dispose();
});

test('one data source per thread; mismatch and unbounded advancement are rejected', () => {
  const e = new CombatEngine(probe([{}]), { data: DATA, BattleClass: ProbeBattle, log: QUIET });
  assert.equal(gameData(), DATA);
  assert.equal(combatData(DATA), combatData(DATA));
  assert.throws(() => combatData({ ...DATA }), /cannot change/);
  assert.throws(() => e.advance(MAX_ADVANCE_TICKS + 1), /ticks/);
  assert.throws(() => e.advance(Infinity), /ticks/);
  assert.throws(() => e.advance(-1), /ticks/);
  e.dispose();
});
