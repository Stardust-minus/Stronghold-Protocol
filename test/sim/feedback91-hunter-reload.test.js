// 反馈 #91 「雪猎攻击缺失补弹机制」 (feedback board, 2026-10-17): the 猎手 trait of 雪猎 (chess_char_3_11, the engine's hunter
// profile — server/sim/professions.js installHunter) loaded one bullet per second after 1 s without an attack and never
// paused her attacks for it. PRTS 分支特性信息 猎手 (the 雪猎 / 莱伊 pages): "入场时持有自身子弹上限数的子弹（竖直显示于自身模型
// 右下）"; "存在子弹且攻击范围内存在目标时进行攻击，不存在子弹/子弹未满且攻击范围内无目标时进行装弹，通常情况下每次装填1颗";
// "装弹行为属于普通攻击行为，持续时间使用装填间隔，装填间隔默认为自身基础攻击间隔，不受攻速/攻击间隔变化影响". HUN-X: "子弹数量为空
// 时下次装填额外加装1发子弹". The reload is announced to the client (b.ev 'reload', its Reload clip) and the bullets travel in
// b.snap `mag` (the column at the model's lower right) — for 莱伊's own copy of the loop too (op-ray.js).
// Run: node --test test/sim/feedback91-hunter-reload.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { EV } from '../../shared/protocol.js';
import { magazineView } from '../../server/sim/snapshot.js';

const CHESS = JSON.parse(readFileSync(new URL('../../data/chess.json', import.meta.url), 'utf8'));
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e9, speed: 0, mass: 0, ...o });
const approx = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
const done = (h) => { checkInvariants(h.b); assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0])); };
const BAT = 1.6; // 雪猎's base attack time (character_table baseAttackTime)

/** 雪猎 (`id`) at (10, 3) facing RIGHT, SP frozen (no S2 cast), with a 1e9-HP dummy at (10, 5) unless `alone`. */
function snowHunter(id, { alone = false, buff = null } = {}) {
  const h = makeBattle({
    defs: { enemies: { enemy_d: dummy('enemy_d') } }, timeLimit: 300, autoFinish: false, hooks: ['attack', 'spGain'], captureNoisy: true,
    units: [{ chessId: id, row: 10, col: 3, dir: 'RIGHT' }],
  });
  const u = h.unit(id);
  h.step();
  h.b.addBuff(u, { key: 'test:noSp', flags: { noSp: true } });
  if (buff) h.b.addBuff(u, { key: 'test:buff', mods: buff });
  const e = alone ? null : h.spawn('enemy_d', { pos: [10, 5] });
  return { h, u, e };
}
const shots = (h, u) => h.hooksOf('attack').filter((c) => c.attacker === u).map((c) => c.t);
function ammoLog(h, u) {
  const log = [];
  let last = u.trait.ammo;
  h.b.on('tick', () => { if (u.trait.ammo !== last) { log.push([h.b.time, u.trait.ammo]); last = u.trait.ammo; } });
  return log;
}

test('#91 雪猎: 8 bullets at her attack interval, then each reload lasts her BASE attack time and loads one (ASPD never shortens it)', () => {
  for (const id of ['chess_char_3_11_a', 'chess_char_3_11_b']) {
    const tb = CHESS[id].trait.bb;
    assert.equal(tb.value, 8, 'the trait: 最多8发');
    const { h, u } = snowHunter(id, { buff: { aspd: 100 } });
    assert.equal(u.profile.ammoMax, 8);
    approx(u.base.bat, BAT, 'base attack time');
    const iv = u.s.interval;
    approx(iv, BAT * 100 / (u.base.aspd + 100), 'ASPD +100 halves her attack interval');
    const extra = Math.max(0, tb.extra_add ?? 0);
    assert.equal(extra, id.endsWith('_b') ? 1 : 0, 'HUN-X on the elite: one more bullet on an empty magazine');
    h.run(30);
    const ts = shots(h, u);
    for (let i = 1; i < 8; i++) approx(ts[i] - ts[i - 1], iv, `${id}: the magazine at her attack interval`, 1e-6);
    // empty: the cooldown, then a full-length reload (1.6 s whatever her ASPD) — her shots slow down
    approx(ts[8] - ts[7], iv + BAT, `${id}: cooldown + a ${BAT} s reload`, 1e-6);
    if (extra) {
      approx(ts[9] - ts[8], iv, 'HUN-X: the reload from empty loaded two — the second one at her interval', 1e-6);
      approx(ts[10] - ts[9], iv + BAT, 'then a reload again', 1e-6);
    } else {
      approx(ts[9] - ts[8], iv + BAT, 'one bullet per reload', 1e-6);
    }
    // each reload is announced with its length (display only: the Reload clip)
    const reloads = h.eventsOf(EV.RELOAD).filter((e) => e[1] === u.id);
    assert.ok(reloads.length >= 2, 'reload events');
    for (const r of reloads) assert.deepEqual(r, ['reload', u.id, BAT]);
    done(h);
  }
});

test('#91 雪猎: with nobody in range she reloads one bullet per base attack time up to 8, then stops; a deployment starts full', () => {
  const { h, u, e } = snowHunter('chess_char_3_11_a');
  const log = ammoLog(h, u);
  assert.equal(u.trait.ammo, 8, '入场时持有自身子弹上限数的子弹');
  h.run(14);
  assert.ok(u.trait.ammo < 8, 'shooting');
  h.b.kill(e, null);
  const n0 = log.length;
  h.run(20);
  const refill = log.slice(n0);
  assert.ok(refill.length >= 2);
  for (let i = 1; i < refill.length; i++) {
    approx(refill[i][0] - refill[i - 1][0], BAT, 'one bullet per 1.6 s', 1e-6);
    assert.equal(refill[i][1], refill[i - 1][1] + 1, 'one at a time');
  }
  assert.equal(u.trait.ammo, 8, 'full');
  const tFull = refill[refill.length - 1][0];
  assert.ok(h.b.time - tFull > 5, 'and nothing after that');
  // a magazine not full with an enemy in range is not reloaded: she shoots
  u.trait.ammo = 3;
  h.spawn('enemy_d', { pos: [10, 5] });
  const before = shots(h, u).length;
  h.run(3 * u.s.interval + 0.1);
  assert.equal(shots(h, u).length - before, 3, 'three shots');
  assert.equal(u.trait.ammo, 0);
  done(h);
});

test('#91 雪猎: a reload is no attack — no attack SP, no attack hook; a stun holds it', () => {
  // S1 强力击·β型 gains SP per attack (INCREASE_WHEN_ATTACK): a reload gives none
  const h = makeBattle({
    defs: { enemies: { enemy_d: dummy('enemy_d') } }, timeLimit: 120, autoFinish: false, hooks: ['attack', 'spGain'], captureNoisy: true,
    units: [{ chessId: 'chess_char_3_11_a', row: 10, col: 3, dir: 'RIGHT', skillIndex: 0 }],
  });
  const u = h.unit('chess_char_3_11_a');
  h.step();
  assert.equal(u.skill.id, 'skchr_snhunt_1');
  u.trait.ammo = 0;
  u.skill.sp = 0;
  const e = h.spawn('enemy_d', { pos: [10, 5] });
  h.run(BAT - 0.1);
  assert.equal(shots(h, u).length, 0, 'reloading: no shot');
  assert.equal(u.skill.sp, 0, 'PRTS 莱伊 "装弹行为不触发攻击回复"');
  h.run(0.2);
  assert.equal(shots(h, u).length, 1, 'the bullet came with the reload’s end: she shoots it at once');
  assert.ok(u.skill.sp > 0, 'that shot gives attack SP');
  // a stun stops the reload's clock (an action of the attack loop)
  u.trait.ammo = 0;
  h.run(u.s.interval + 0.05);   // her cooldown ends, the reload begins
  assert.equal(u.trait.reloading, true);
  h.b.applyStatus(u, 'stun', { duration: 3, source: e });
  h.run(2.5);
  assert.equal(u.trait.ammo, 0, 'stunned: no bullet');
  h.run(3);
  assert.ok(u.trait.ammo > 0 || shots(h, u).length > 1, 'after the stun the reload ends');
  done(h);
});

test('#91 the bullets travel in b.snap `mag` (雪猎 and 莱伊), never for an enemy or another branch', () => {
  const { h, u } = snowHunter('chess_char_3_11_a');
  h.run(3.3);
  const snap = h.b.snapshot();
  const row = (snap.mag || []).find((m) => m[0] === u.id);
  assert.deepEqual(row, [u.id, u.trait.ammo, 8]);
  assert.ok(u.trait.ammo < 8);
  assert.equal(magazineView({ side: 'enemy', profile: { sub: 'hunter', ammoMax: 8 }, trait: { ammo: 3 } }), null, 'an enemy: none');
  assert.equal(magazineView({ side: 'ally', profile: { sub: 'fastshot' }, trait: {} }), null, 'another branch: none');
  assert.deepEqual(magazineView({ side: 'ally', profile: { sub: 'hunter', ammoMax: 8 }, trait: { ammo: 0 } }), [0, 8], 'zero is a count');
  JSON.stringify(snap);
  done(h);
});
