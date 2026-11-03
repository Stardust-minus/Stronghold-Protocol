// 动态立绘 embedded where an appearance's art shows (the owner's decision of 2026-11-02; ui/dynamicIllustration.js): the
// fit of the art in a box, the live-renderer cap and its slots, the static-only devices, and which 名片 skins animate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { illustrationLayout, liveCap, slowDevice, dynamicSlots, LOAD_TIMEOUT_MS, SLOW_FRAME_MS } from '../../public/js/ui/dynamicIllustration.js';
import { namecardDynamic, namecardOf } from '../../public/js/ui/namecards.js';
import { readFileSync, existsSync, statSync } from 'node:fs';

const B = { x: -800, y: -10, width: 1800, height: 2000 };
/** The screen y of the art line at `f` (0 top … 1 bottom) in a layout (pixi-spine y-down: top −(b.y+h)). */
const lineY = (l, f) => l.y + (-(B.y + B.height) + f * B.height) * l.scale;
const lineX = (l, f) => l.x + (B.x + f * B.width) * l.scale;

test('contain: the whole art, centred, at 94 % (the 查看立绘 preview as before)', () => {
  const l = illustrationLayout(600, 400, B, 'contain');
  assert.equal(l.scale, Math.min(600 / 1800, 400 / 2000) * 0.94);
  assert.ok(Math.abs(lineY(l, 0.5) - 200) < 1e-9 && Math.abs(lineX(l, 0.5) - 300) < 1e-9, 'centred');
});

test('cover: fills the box; the focus line of the art sits on the same line of the box (background-position-y)', () => {
  for (const [w, h] of [[640, 140], [130, 162], [300, 900]]) {
    for (const focus of [0, 12, 24, 50, 100]) {
      const l = illustrationLayout(w, h, B, 'cover', focus);
      assert.equal(l.scale, Math.max(w / 1800, h / 2000));
      assert.ok(Math.abs(lineY(l, focus / 100) - (focus / 100) * h) < 1e-6, `${w}×${h} @${focus}%`);
      assert.ok(Math.abs(lineX(l, 0.5) - w / 2) < 1e-9);
      assert.ok(lineY(l, 0) <= 1e-6 && lineY(l, 1) >= h - 1e-6 && lineX(l, 0) <= 1e-6 && lineX(l, 1) >= w - 1e-6, 'no gap');
    }
  }
});

test('the cap: 4 live renderers, 2 on a coarse pointer or a ≤ 4 GB device', () => {
  const g = (coarse, deviceMemory) => ({ matchMedia: (q) => ({ matches: coarse && q === '(pointer: coarse)' }), navigator: { deviceMemory } });
  assert.equal(liveCap(g(false, 8)), 4);
  assert.equal(liveCap(g(false, undefined)), 4);
  assert.equal(liveCap(g(true, 8)), 2);
  assert.equal(liveCap(g(false, 4)), 2);
  assert.equal(liveCap({}), 4);
});

test('static-only devices: data saver, ≤ 2 cores, ≤ 2 GB', () => {
  assert.equal(slowDevice({ navigator: { hardwareConcurrency: 8, deviceMemory: 8 } }), false);
  assert.equal(slowDevice({ navigator: {} }), false);
  assert.equal(slowDevice({ navigator: { connection: { saveData: true } } }), true);
  assert.equal(slowDevice({ navigator: { hardwareConcurrency: 2 } }), true);
  assert.equal(slowDevice({ navigator: { deviceMemory: 2 } }), true);
  assert.ok(LOAD_TIMEOUT_MS > 0 && SLOW_FRAME_MS > 33);
});

test('slots: past the cap one waits; a closing one hands its slot on; a release of a waiting one frees nothing', () => {
  dynamicSlots.reset();
  const granted = [];
  const tok = (n) => ({ n, grant: () => granted.push(n) });
  const t = [1, 2, 3, 4, 5, 6].map(tok);
  assert.deepEqual(t.map((x) => dynamicSlots.request(x)), [true, true, true, true, false, false]);
  assert.equal(dynamicSlots.live, 4); assert.equal(dynamicSlots.waiting, 2);
  assert.equal(dynamicSlots.request(t[0]), true, 'asking again keeps the slot');
  dynamicSlots.release(t[5]);
  assert.deepEqual([dynamicSlots.live, dynamicSlots.waiting, granted], [4, 1, []], 'a waiting one leaving frees no slot');
  dynamicSlots.release(t[1]);
  assert.deepEqual([dynamicSlots.live, dynamicSlots.waiting, granted], [4, 0, [5]], 'the waiting one gets the slot');
  for (const x of t) dynamicSlots.release(x);
  assert.deepEqual([dynamicSlots.live, dynamicSlots.waiting], [0, 0]);
  dynamicSlots.reset();
});

test('名片: a skin card animates its skin\'s 动态立绘; never a collab one, never another kind of card', () => {
  const dyn = { skel: '/assets/skins/a_1/dynamic/d.skel', atlas: '/assets/skins/a_1/dynamic/d.atlas', textures: ['/assets/skins/a_1/dynamic/d.png'] };
  const m = { skins: {
    a_1: { charId: 'char_a', illustration: '/assets/skins/a_1/illustration.png', dynamic: dyn },
    b_1: { charId: 'char_b', illustration: '/assets/skins/b_1/illustration.png' },
    c_1: { charId: 'char_c', illustration: '/assets/collab/skins/c_1/illustration.png', dynamic: { ...dyn, skel: '/assets/collab/skins/c_1/dynamic/d.skel' } },
  }, ui: { 'loading/loading_ac_1': '/assets/ui/l.png' } };
  assert.equal(namecardDynamic({ kind: 'skin', skinId: 'a_1' }, m), dyn);
  assert.equal(namecardDynamic({ kind: 'skin', skinId: 'b_1' }, m), null, 'no dynamic art');
  assert.equal(namecardDynamic({ kind: 'skin', skinId: 'c_1' }, m), null, 'collab');
  assert.equal(namecardDynamic({ kind: 'skin', skinId: 'zz' }, m), null);
  assert.equal(namecardDynamic(namecardOf('loading:loading_ac_1'), m), null);
});

const assets = JSON.parse(readFileSync(new URL('../../data/assets.json', import.meta.url), 'utf8'));
test('data: every skin with an official 动态立绘 ships it (71: 11 from PRTS, 60 from the client in rel26), complete', () => {
  const recs = Object.entries(assets.skins);
  const declared = recs.filter(([, r]) => r.dynamicDeclared), shipped = recs.filter(([, r]) => r.dynamic);
  assert.equal(shipped.length, 71);
  assert.deepEqual(declared.map(([id]) => id).sort(), shipped.map(([id]) => id).sort(), 'nothing declared and missing (动态立绘待补 no more)');
  for (const [id, r] of shipped) {
    const d = r.dynamic;
    assert.match(d.skel, new RegExp(`^/assets/skins/${id}/dynamic/[^/]+\\.(skel|json)$`), id);
    assert.match(d.atlas, new RegExp(`^/assets/skins/${id}/dynamic/[^/]+\\.atlas$`), id);
    assert.ok(d.textures.length >= 1 && d.textures.every((u) => u.startsWith(`/assets/skins/${id}/dynamic/`)), id);
    assert.ok(d.bounds.width > 0 && d.bounds.height > 0, id);
    assert.ok(Object.hasOwn(d.animations, d.anims.idle), `${id}: its idle clip is one of its clips`);
    assert.ok(Object.keys(d.animations).some((n) => /^idle$/i.test(n)), `${id}: a looping Idle (never only the intro)`);
  }
});

test('installed: every file of every shipped 动态立绘 on disk', { skip: !existsSync(new URL('../../public/assets/skins/char_1045_svash2_sale_20/dynamic', import.meta.url)) && 'install the dynamic illustrations first' }, () => {
  for (const [id, r] of Object.entries(assets.skins)) {
    if (!r.dynamic) continue;
    for (const u of [r.dynamic.skel, r.dynamic.atlas, ...r.dynamic.textures, r.dynamic.background, r.dynamic.foreground].filter(Boolean)) {
      assert.ok(statSync(new URL(`../../public${u}`, import.meta.url)).size > 0, `${id}: ${u}`);
    }
  }
});
