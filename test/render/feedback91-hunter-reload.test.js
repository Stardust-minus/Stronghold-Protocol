// 反馈 #91 「雪猎攻击缺失补弹机制」, client side: a 猎手's bullets (b.snap `mag` [[id, bullets, magazine]], sim snapshot.js
// magazineView) are carried by render/interp.js and drawn by render/units.js as the column at the model's lower right
// (PRTS 分支特性信息 猎手 "竖直显示于自身模型右下"), and a reload (b.ev ['reload', id, seconds]) plays the skeleton's Reload
// clips over its length (render/spine.js reload: 雪猎's Reload_Begin / Loop / End; 莱伊's Skill_2_Reload_* while S2 runs).
// The sim side is test/sim/feedback91-hunter-reload.test.js. Headless fake PIXI (test/render/fakepixi.js).
// Run: node --test test/render/feedback91-hunter-reload.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakePixi, fakeViewCtx } from './fakepixi.js';
import { presetCamera } from '../../public/js/render/projection.js';
import { SnapshotBuffer, normalizeSnapshot, COSMETIC_EVENTS } from '../../public/js/render/interp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const assets = JSON.parse(readFileSync(path.join(ROOT, 'data/assets.json'), 'utf8'));

let fake, SpineActor, UnitView, MAG_PIPS, COLORS;
before(async () => {
  fake = installFakePixi();
  ({ SpineActor } = await import('../../public/js/render/spine.js'));
  ({ UnitView, MAG_PIPS } = await import('../../public/js/render/units.js'));
  ({ COLORS } = await import('../../public/js/render/style.js'));
});
after(() => fake.restore());

const cam = () => presetCamera('normal', { width: 1280, height: 720 });
const tuple = (id) => [id, 5, 10, 1000, 1000, 0, 0, 0, 0];
const sample = (o = {}) => ({ x: 5, y: 10, hp: 1000, maxHp: 1000, sp: 0, spMax: 10, flags: 0, anim: 0, vx: 0, vy: 0, ...o });
const frames = (v, n = 3) => { for (let i = 0; i < n; i++) v.update(0.02, cam(), i * 0.02); };

/** An actor of a real operator's Front model, recording every clip set / queued. */
function actor(charId, skillIndex = null) {
  const entry = assets.chars[charId].spine.front;
  const a = new SpineActor({ animations: Object.keys(entry.animations).map((name) => ({ name })) }, entry);
  if (skillIndex != null) a.setSkillIndex(skillIndex);
  a.log = [];
  const st = a.spine.state;
  const set = st.setAnimation, add = st.addAnimation;
  st.setAnimation = (i, name, loop) => { a.log.push(['set', name, !!loop]); const e = set(i, name, loop); a.lastSet = e; return e; };
  st.addAnimation = (i, name, loop) => { a.log.push(['queue', name, !!loop]); const e = add(i, name, loop); a.lastQueued = e; return e; };
  return a;
}
const run = (a, s, dt = 1 / 60) => { for (let t = 0; t < s - 1e-9; t += dt) a.update(dt); };

test('interp: `mag` rides beside the tuples like `ammo` (whole numbers, 0 ≤ bullets ≤ magazine), from the older snapshot', () => {
  const s = normalizeSnapshot({ t: 0, units: [tuple(1), tuple(2)], mag: [[1, 0, 8], [2, 9, 8], [3, 1, 8], [2, 1.5, 8]] });
  assert.deepEqual([...s.mag], [[1, [0, 8]]], 'zero is a count; over the magazine, unknown ids and fractions are dropped');
  const b = new SnapshotBuffer();
  b.push({ t: 0, units: [tuple(1)], mag: [[1, 5, 8]] });
  b.push({ t: 1, units: [tuple(1)], mag: [[1, 4, 8]] });
  b.push({ t: 2, units: [tuple(1)] });
  assert.deepEqual(b.sample(0.5).get(1).mag, [5, 8], 'the older snapshot');
  assert.deepEqual(b.sample(1.5).get(1).mag, [4, 8]);
  assert.equal(b.sample(2).get(1).mag, null, 'a snapshot without it clears it');
  assert.ok(COSMETIC_EVENTS.has('reload'), 'a late reload clip may be dropped');
});

test('UnitView: a column of bullet cells at the model\'s lower right, lit from the bottom for the bullets in the magazine', () => {
  const v = new UnitView(fakeViewCtx(fake.P, { cam }), { id: 1, side: 'ally', kind: 'op', defId: 'char_4211_snhunt', tier: 3, x: 5, y: 10, maxHp: 1000, dir: 'RIGHT' });
  try {
    v.sync(sample({ mag: [5, 8] }));
    frames(v);
    const r = v._magPips;
    assert.ok(r && r.root.visible);
    assert.equal(r.lit.length, 8, 'one cell per bullet the magazine holds');
    assert.deepEqual(r.lit.map((d) => d.alpha), [1, 1, 1, 1, 1, MAG_PIPS.dim, MAG_PIPS.dim, MAG_PIPS.dim]);
    assert.ok(r.lit.every((d) => d.tint === COLORS.ammo) && r.back.every((d) => d.tint === COLORS.hpBack));
    for (let i = 1; i < 8; i++) {
      assert.ok(r.lit[i].position.y < r.lit[i - 1].position.y, 'a vertical column, the first bullet at the bottom');
      assert.equal(r.lit[i].position.x, r.lit[0].position.x);
    }
    assert.ok(r.lit[0].position.x > v._footX, 'right of the model\'s feet');
    // the model's lower part: the lowest bullet at the feet at most; the HUD bars sit under the feet (rel26, #113 ui2), so the
    // column never reaches the HP bar
    assert.ok(r.lit[0].position.y <= v._footY, 'at the model\'s lower part');
    assert.ok(r.lit[0].position.y < v.hpBg.position.y, 'above the HP bar under the feet');
    v.sync(sample({ mag: [0, 8] }));
    frames(v);
    assert.ok(r.lit.every((d) => d.alpha === MAG_PIPS.dim), 'an empty magazine');
    v.sync(sample({}));
    frames(v);
    assert.equal(r.root.visible, false, 'no readout: hidden');
  } finally { v.destroy(); }
});

test('SpineActor.reload: 雪猎 plays Reload_Begin, Reload_Loop over the reload (one loop per reload), then Reload_End and Idle', () => {
  const a = actor('char_4211_snhunt');
  const loopDur = a.dur('Reload_Loop');
  assert.ok(loopDur > 0 && a.has('Reload_Begin') && a.has('Reload_End'));
  assert.equal(a.reload(1.6), true);
  assert.deepEqual(a.log, [['set', 'Reload_Begin', false], ['queue', 'Reload_Loop', true]]);
  const lead = a.dur('Reload_Begin');
  assert.ok(Math.abs(a.lastQueued.timeScale - loopDur / (1.6 - lead)) < 1e-9, 'the loop fills the rest of the reload');
  a.log.length = 0;
  // a reload right after it: the loop goes on (no second Begin)
  run(a, 1.6);
  assert.equal(a.reload(1.6), true);
  assert.deepEqual(a.log, [['set', 'Reload_Loop', true]]);
  a.log.length = 0;
  run(a, 1.6 + 0.2);
  assert.deepEqual(a.log, [['set', 'Reload_End', false], ['queue', 'Idle', true]], 'over: its End, then the resting state');
  assert.equal(a.mode, 'base');
  // an attack cuts a reload (the bullet came with the reload's end)
  a.reload(1.6);
  a.log.length = 0;
  a.attack(1.6);
  assert.equal(a.mode, 'attack');
  assert.equal(a.log[0][1], 'Attack_Loop');
  // a stun, a death: no reload clip
  const b = actor('char_4211_snhunt');
  b.setBase('stun');
  assert.equal(b.reload(1.6), false);
  b.setBase('idle');
  b.die();
  assert.equal(b.reload(1.6), false);
});

test('SpineActor.reload: a skill\'s own Reload set while it runs (莱伊 S2 Skill_2_Reload_*), the plain one otherwise; no Reload clip = no change', () => {
  const a = actor('char_4117_ray', 1);
  a.setSkill(true);
  a.log.length = 0;
  assert.equal(a.reload(1.6), true);
  assert.deepEqual(a.log.map((x) => x[1]), ['Skill_2_Reload_Begin', 'Skill_2_Reload_Loop']);
  const b = actor('char_4117_ray', 1);
  b.log.length = 0;
  b.reload(1.6);
  assert.deepEqual(b.log.map((x) => x[1]), ['Reload_Begin', 'Reload_Loop']);
  const c = actor('char_003_kalts');
  c.log.length = 0;
  assert.equal(c.reload(1.6), false, 'a skeleton without Reload_Loop keeps its pose');
  assert.deepEqual(c.log, []);
});
