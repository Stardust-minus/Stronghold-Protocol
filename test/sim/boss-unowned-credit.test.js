// §37.278 — 无来源 damage to a shared Boss pool that no player owns. In the hidden round (boss_8 假想敌：胄 on
// act2autochess_m04 涨潮控制) a 斩胄之剑 / 破胄之锤 brought down by 【瘫痪】 becomes a ground unit; on a 深水 tile it takes
// the 【水蚀】 tick (40/s 无来源 true damage, no unit deals it), and every damage it takes passes on to 胄 as 无来源 HP loss
// credited to the attacker — here nobody. The pool takes it like any other hit; it is credited to no player (PRTS:
// 无来源) and counted in the pool's `unowned`, so Σ byPlayer + unowned = maxHp − hp on every pool. Built directly, no seed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeBattle, chessRec } from '../helpers/battleHarness.js';
import { hasGeneratedData } from '../../server/sim/simdata.js';
import { terrainAt } from '../../server/sim/content/devices.js';
import { BLADE_TRANSFER } from '../../server/sim/content/bosses.js';
import { SharedBossPool } from '../../server/match/finalAssault.js';
import { LocalBossPool, ReplayBossPool } from '../../server/sim/spec.js';

const REAL = { skip: !hasGeneratedData() };
const E = JSON.parse(fs.readFileSync(new URL('../../data/enemies.json', import.meta.url), 'utf8'));
const W = JSON.parse(fs.readFileSync(new URL('../../data/waves.json', import.meta.url), 'utf8'));
const sum = (values) => [...values].reduce((s, v) => s + v, 0);
const approx = (a, b, msg) => assert.ok(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)), `${msg} ${a} ≈ ${b}`);

test('SharedBossPool / LocalBossPool / ReplayBossPool: a hit with no player is counted in unowned, never in byPlayer', () => {
  const hits = [];
  const pools = {
    shared: new SharedBossPool(1000, { onHit: (pid, a) => hits.push([pid, a]) }),
    local: new LocalBossPool(1000),
    replay: new ReplayBossPool(1000),
  };
  for (const [name, p] of Object.entries(pools)) {
    const by = () => (p.byPlayer instanceof Map ? Object.fromEntries(p.byPlayer) : { ...p.byPlayer });
    assert.equal(p.unowned, 0, name);
    assert.equal(p.damage('p_0', 300), 300);
    assert.equal(p.damage(null, 52), 52);
    assert.equal(p.damage(undefined, 48), 48);
    assert.deepEqual(by(), { p_0: 300 }, `${name}: the unowned hits credit no player`);
    assert.equal(p.unowned, 100, name);
    assert.equal(p.damage(null, 5000), 600, `${name}: the last hit takes the rest`);
    assert.equal(p.unowned, 700, `${name}: counted as dealt, not as asked`);
    assert.equal(p.hp, 0);
    assert.equal(p.damage(null, 10), 0);
    assert.equal(sum(Object.values(by())) + p.unowned, p.maxHp - p.hp, `${name}: Σ byPlayer + unowned = the pool's drop`);
  }
  assert.deepEqual(hits, [['p_0', 300], [null, 52], [undefined, 48], [null, 600]], 'onHit still sees each hit (owner none)');
});

test('hidden boss_8: 深水 on a downed 斩胄之剑 passes on to 胄 as unowned pool damage; byPlayer and the per-player tally stay as they were', REAL, () => {
  const key = 'enemy_9014_acstma', H08 = 'act1autochess_h08_01';
  const sk = E[key].skills.find((s) => s.prefabKey === '1');
  const tpl = W[H08];
  const origin = tpl.extraRoutes[tpl.branches.left_hand_origin[0][0].routeIndex];
  const pool = new SharedBossPool(1e7);
  const BIG = [];
  for (let dr = -12; dr <= 12; dr++) for (let dc = -20; dc <= 20; dc++) BIG.push([dr, dc]);
  const wall = chessRec({ id: 't_wall', profession: 'TANK', stats: { atk: 0, maxHp: 1e7, blockCnt: 3 }, rangeGrid: [[0, 0]], skill: null });
  const gun = chessRec({ id: 't_gun', profession: 'SNIPER', projectile: 'none', stats: { atk: 5000, maxHp: 1e7, blockCnt: 0 }, rangeGrid: BIG, skill: null });
  const noAtk = () => ({ trait: { noAttack: true } });
  const h = makeBattle({ stageId: 'act2autochess_m04', kind: 'hidden', sharedBoss: pool, seed: 7, autoFinish: false, timeLimit: 600,
    defs: { chess: { t_wall: wall, t_gun: gun } }, kits: { t_wall: noAtk, t_gun: noAtk },
    units: [{ chessId: 't_wall', row: 12, col: 3 }, { chessId: 't_gun', row: 9, col: 4 }],
    setup: (b) => { b.opts.templateId = H08; } });
  h.step();
  const boss = h.spawn('enemy_9013_acstmk_2', { pos: [3, 10], routeIndex: 0, mods: { speedMul: 0 }, tag: 'boss' });
  boss.profile.noAttack = true;
  const p = h.spawn(key, { pos: origin.start, routeIndex: 0, mods: { speedMul: 0 }, tag: 'part' });
  h.run(sk.initCooldown + 0.1);                                              // 出击模式
  const g = h.unit('t_gun');
  for (let i = 0; i < sk.bb.max_hit_cnt; i++) h.b.dealDamage(g, p, { amount: 1, type: 'true' });
  assert.equal(p.motion, 'WALK', '【瘫痪】: a ground unit');
  const owned = Object.fromEntries(pool.byPlayer), ownedSum = sum(pool.byPlayer.values());
  assert.ok(ownedSum > 0 && pool.unowned === 0, 'the operator\'s hits are owned');
  const tally = h.result().perPlayer.p1.bossDamage;
  approx(tally, ownedSum, 'the per-player tally');
  // the downed blade on a 深水 tile of the boss field (the dive can end anywhere on it)
  const [r, c] = [4, 6];
  assert.equal(terrainAt(h.b, r, c), 'deepsea');
  p.x = c; p.y = r;
  const passed = [];
  h.b.on('hpChanged', (ctx) => { if (ctx.target === boss && ctx.delta < 0) passed.push({ credit: ctx.credit, lost: -ctx.delta }); }, { priority: -1e9 });
  const hp0 = pool.hp;
  h.run(3.5);
  assert.ok(p.alive && p.motion === 'WALK', 'still 瘫痪');
  assert.ok(passed.length >= 3, `the 【水蚀】 ticks passed on (${passed.length})`);
  for (const x of passed) {
    assert.equal(x.credit, null, '无来源, credited to nobody');
    approx(x.lost, 40 * sk.bb.damage_scale * BLADE_TRANSFER, '等量 of the ×damage_scale tick');
  }
  approx(pool.unowned, hp0 - pool.hp, 'unowned grows by exactly the pool\'s drop');
  approx(pool.unowned, sum(passed.map((x) => x.lost)), 'and by exactly the passed-on HP');
  assert.deepEqual(Object.fromEntries(pool.byPlayer), owned, 'byPlayer does not change');
  approx(h.result().perPlayer.p1.bossDamage, tally, 'the per-player tally does not change');
  approx(sum(pool.byPlayer.values()) + pool.unowned, pool.maxHp - pool.hp, 'Σ byPlayer + unowned = the pool\'s drop');
});
