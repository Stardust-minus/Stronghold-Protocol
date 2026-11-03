// 动态立绘 embedded where an appearance's art shows (the owner's decisions of 2026-11-02 / 11-03; ui/dynamicIllustration.js,
// ui/dynamicFraming.js, ui/dynamicStage.js): the fit of the art in a box — the preview's contain, the official avatar /
// portrait crops as CSS cover, the 名片's bounds, a seat's own framing —, the shared renderer's packing, which skins
// animate (never a collab one), and the data: every shipped 动态立绘 with its crops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { illustrationLayout, LOAD_TIMEOUT_MS } from '../../public/js/ui/dynamicIllustration.js';
import { rectLayout, seatRect, artOfRect, moveArt, cardArt, framingLayout, cropFraming, lookDynamic, ART_LIMITS } from '../../public/js/ui/dynamicFraming.js';
import { packPages, PAGE, MAX_STEP } from '../../public/js/ui/dynamicStage.js';
import { visibleRect } from '../../public/js/ui/seatLive.js';
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

/** where a skeleton point (X, Y up) lands for a layout l (pixi-spine y-down) */
const at = (l, X, Y) => [l.x + X * l.scale, l.y - Y * l.scale];
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('a crop as CSS cover: the rect fills the box and sits at object-position posX% posY% — as the static picture under it', () => {
  const R = { x: -90, y: 700, width: 160, height: 320 }; // a 1:2 portrait crop, y-up
  for (const [w, h, px, py] of [[160, 320, 50, 12], [130, 162, 50, 12], [120, 140, 50, 6], [64, 64, 50, 50], [300, 200, 50, 50]]) {
    const l = rectLayout(w, h, R, px, py);
    assert.ok(near(l.scale, Math.max(w / R.width, h / R.height)), `${w}×${h}: cover scale`);
    const [x0, yTop] = at(l, R.x, R.y + R.height), [x1, yBot] = at(l, R.x + R.width, R.y);
    const freeX = w - R.width * l.scale, freeY = h - R.height * l.scale;
    assert.ok(near(x0, freeX * px / 100) && near(x1 - x0, R.width * l.scale), `${w}×${h}: x as object-position ${px}%`);
    assert.ok(near(yTop, freeY * py / 100) && near(yBot - yTop, R.height * l.scale), `${w}×${h}: y as object-position ${py}%`);
    assert.ok(x0 <= 1e-6 && x1 >= w - 1e-6 && yTop <= 1e-6 && yBot >= h - 1e-6, 'no gap');
  }
  // the 名片: the whole bounds at its y, as rel26's cover (illustrationLayout)
  for (const focus of [0, 24, 50, 100]) {
    const a = framingLayout(640, 140, B, { focusY: focus }), b = illustrationLayout(640, 140, B, 'cover', focus);
    assert.ok(near(a.scale, b.scale) && near(a.x, b.x) && near(a.y, b.y), `focus ${focus}`);
  }
});

test('every skin\'s portrait crop is a framing the seat can store (its zoom within the limits)', () => {
  for (const [id, r] of Object.entries(assets.skins)) {
    const f = r.dynamic?.frames?.portrait; if (!f) continue;
    for (const [w, h] of [[120, 240], [120, 290], [140, 230]]) {
      const v = visibleRect(w, h, rectLayout(w, h, f, 50, 12)), art = artOfRect(w, h, r.dynamic.bounds, v);
      assert.ok(art.zoom >= ART_LIMITS.zoomMin && art.zoom * 2 <= ART_LIMITS.zoomMax, `${id} ${w}×${h}: ${art.zoom} %`);
    }
  }
});

test('a seat\'s framing: zoom sets the height shown, the box stays filled and inside the bounds, the same on every width', () => {
  const b = { x: -900, y: -180, width: 1900, height: 1350 };
  for (const [w, h] of [[120, 240], [180, 300], [90, 220]]) {
    for (const art of [{ x: 500, y: 500, zoom: 100 }, { x: 500, y: 200, zoom: 300 }, { x: 0, y: 0, zoom: 600 }, { x: 1000, y: 1000, zoom: 250 }, { x: 300, y: 150, zoom: 2500 }]) {
      const r = seatRect(w, h, b, art);
      assert.ok(near(r.width / r.height, w / h, 1e-9), 'the box\'s aspect');
      assert.ok(r.x >= b.x - 1e-6 && r.x + r.width <= b.x + b.width + 1e-6 && r.y >= b.y - 1e-6 && r.y + r.height <= b.y + b.height + 1e-6, `${w}×${h} ${JSON.stringify(art)}: inside`);
      if (r.width < b.width - 1e-6) assert.ok(near(r.height, b.height * 100 / art.zoom, 1e-6), 'zoom = the height shown');
    }
  }
  // two boxes of one aspect, different sizes, show the same rect (what the owner set is what the room sees)
  const art = { x: 420, y: 310, zoom: 260 };
  assert.deepEqual(seatRect(120, 240, b, art), seatRect(180, 360, b, art));
});

test('framing round trip: the art of a shown rect shows it again; a drag moves the picture with the pointer; zoom is clamped', () => {
  const b = { x: -900, y: -180, width: 1900, height: 1350 };
  const [w, h] = [150, 300];
  const art = { x: 450, y: 300, zoom: 280 };
  const r = seatRect(w, h, b, art), back = artOfRect(w, h, b, r);
  assert.ok(Math.abs(back.x - art.x) <= 1 && Math.abs(back.y - art.y) <= 1 && Math.abs(back.zoom - art.zoom) <= 1, JSON.stringify(back));
  // the default framing (the portrait crop) as an art triple: visibleRect of its layout
  const crop = { x: -85, y: 700, width: 157, height: 314 };
  const l = rectLayout(w, h, crop, 50, 12), v = visibleRect(w, h, l);
  assert.ok(near(v.width, crop.width, 1e-6) && near(v.x, crop.x, 1e-6), 'the crop fills the width of a 1:2 box');
  const moved = moveArt(w, h, b, art, 30, 0);
  assert.ok(moved.x < art.x, 'dragging right shows what is left of it');
  assert.ok(moveArt(w, h, b, art, 0, 30).y < art.y, 'dragging down shows what is above');
  assert.equal(moveArt(w, h, b, art, 0, 0, 100).zoom, ART_LIMITS.zoomMax);
  assert.equal(moveArt(w, h, b, art, 0, 0, 0.01).zoom, ART_LIMITS.zoomMin);
});

test('cardArt: all three fields in range or none', () => {
  assert.deepEqual(cardArt({ artX: 0, artY: 1000, artZoom: 100 }), { x: 0, y: 1000, zoom: 100 });
  assert.deepEqual(cardArt({ artX: 5, artY: 5, artZoom: 2500 }), { x: 5, y: 5, zoom: 2500 });
  for (const c of [{}, { artX: 1, artY: 2 }, { artX: -1, artY: 5, artZoom: 200 }, { artX: 5, artY: 5, artZoom: 99 }, { artX: 5, artY: 5, artZoom: 2501 },
    { artX: 1.5, artY: 5, artZoom: 200 }, { artX: '5', artY: 5, artZoom: 200 }, null]) assert.equal(cardArt(c), null, JSON.stringify(c));
});

test('pixi-spine\'s stale clip (夕「青玉砚」): a setup clip the Idle replaces at t = 0 by a mesh is not the setup attachment any more', async () => {
  const { fixStaleClips } = await import('../../public/js/ui/dynamicStage.js');
  const clip = { type: 6, endSlot: null }, mesh = { type: 2 };
  const atts = { 'eye2': clip, 'eye': mesh, 'arm': mesh, 'armclip': clip };
  const slots = [{ name: 'Xi_R_EyeWhite', attachmentName: 'eye2' }, { name: 'other', attachmentName: 'arm' }, { name: 'late', attachmentName: 'armclip' }];
  const data = {
    slots, defaultSkin: { getAttachment: (i, n) => atts[n] || null },
    animations: [{ name: 'Idle', timelines: [
      { slotIndex: 0, frames: [0], attachmentNames: ['eye'] }, // the stale clip: fixed
      { slotIndex: 1, frames: [0], attachmentNames: ['armclip'] }, // a mesh set up, a clip in the Idle: left
      { slotIndex: 2, frames: [0.5], attachmentNames: ['arm'] }, // the clip shows until 0.5 s: left
    ] }],
  };
  assert.deepEqual(fixStaleClips(data, 'Idle'), ['Xi_R_EyeWhite']);
  assert.deepEqual(slots.map((s) => s.attachmentName), ['eye', 'arm', 'armclip']);
  assert.deepEqual(fixStaleClips(data, 'Idle'), [], 'idempotent');
});

test('the shared renderer: views packed into pages, none overlapping, none larger than a page; frames advance by real time', () => {
  const sizes = [[480, 960], [200, 200], [200, 200], [120, 240], ...Array.from({ length: 40 }, () => [96, 96]), [5000, 300]].map(([w, h]) => ({ w, h }));
  const pages = packPages(sizes, PAGE);
  const seen = new Set();
  for (const p of pages) {
    assert.ok(p.w <= PAGE && p.h <= PAGE);
    for (const c of p.cells) {
      seen.add(c.index);
      assert.ok(c.x + c.w <= PAGE && c.y + c.h <= PAGE);
      for (const d of p.cells) if (d !== c) assert.ok(c.x + c.w <= d.x || d.x + d.w <= c.x || c.y + c.h <= d.y || d.y + d.h <= c.y, 'no overlap');
    }
  }
  assert.equal(seen.size, sizes.length, 'every view placed once');
  assert.equal(pages.length, 1, 'a page of 44 cells and one wide box');
  assert.equal(packPages(Array.from({ length: 5 }, () => ({ w: 3000, h: 3000 })), PAGE).length, 5, 'pages split when full');
  assert.ok(MAX_STEP >= 0.1 && MAX_STEP <= 0.5, 'only a hidden-tab jump is clamped, not the frame rate');
  assert.ok(LOAD_TIMEOUT_MS > 0);
});

test('no cap, no slow-device fallback, no fps or DPR limit, and always animated — reduced motion not honoured (the owner\'s decisions)', () => {
  const src = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  const ill = src('public/js/ui/dynamicIllustration.js'), stage = src('public/js/ui/dynamicStage.js'), ava = src('public/js/ui/avatarLive.js');
  for (const [name, s] of [['dynamicIllustration', ill], ['dynamicStage', stage], ['avatarLive', ava]]) {
    assert.doesNotMatch(s, /liveCap|slowDevice|saveData|SLOW_FRAME_MS|maxFPS|Math\.min\([^)]*devicePixelRatio|matchMedia\?\.\('\(prefers-reduced-motion/, name);
  }
  assert.equal((stage.match(/new P\.Renderer\(/g) || []).length, 1, 'one renderer');
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
  // a card look's / a worn skin's record: the skin of that operator only, never a collab one
  assert.equal(lookDynamic(m, 'char_a', 'a_1'), null, 'not a skin of shared/skins.js (format only here)');
  assert.equal(lookDynamic(m, 'char_a', ''), null);
  assert.equal(lookDynamic(m, 'char_a', 'e1'), null);
  assert.equal(cropFraming(null, 'avatar'), null);
  assert.deepEqual(cropFraming({ frames: { avatar: { x: 1, y: 2, width: 3, height: 3 } } }, 'avatar', 50, 12), { rect: { x: 1, y: 2, width: 3, height: 3 }, posX: 50, posY: 12 });
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
  // the official avatar / portrait crops (matched offline, rel27): every one, inside the bounds, square / 1:2
  for (const [id, r] of shipped) {
    const { avatar, portrait } = r.dynamic.frames, b = r.dynamic.bounds;
    assert.ok(Math.abs(avatar.width - avatar.height) < 0.01 && Math.abs(portrait.height - 2 * portrait.width) < 0.01, `${id}: shapes`);
    for (const f of [avatar, portrait]) {
      assert.ok(f.width > 20 && f.x >= b.x - 2 && f.x + f.width <= b.x + b.width + 2 && f.y >= b.y - 2 && f.y + f.height <= b.y + b.height + 2, `${id}: inside its bounds`);
    }
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

const STAGE = '/root/projects/rel27-20261103/dynava/stage/assets/local/ui/avatar_dyn';
test('official dynamic avatars: the spine layer framed as its 180 box (the static picture), sequences as they ship', { skip: !existsSync(STAGE) && 'the staged avatars (fork dynava)' }, async () => {
  const { spineLayerEntry, validDescriptor, avatarDescriptorUrl } = await import('../../public/js/ui/avatarLive.js');
  assert.equal(avatarDescriptorUrl('avatar_def_01'), null, 'only avatar_dyn_*');
  let spines = 0, sequences = 0;
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const id = `avatar_dyn_0${n}`;
    const d = validDescriptor(JSON.parse(readFileSync(`${STAGE}/${id}/avatar.json`, 'utf8')));
    assert.ok(d, `${id}: a v1 descriptor`);
    const spine = d.layers.find((l) => l.kind === 'spine'), seq = d.layers.find((l) => l.kind === 'sequence');
    if (spine) {
      spines++;
      const { entry, framing } = spineLayerEntry(d, spine);
      assert.match(entry.skel, /\.json$/, `${id}: a JSON skeleton (dynamicStage acquireSpine)`);
      assert.deepEqual(framing.rect, { x: -d.box[0] / 2 - spine.offset[0], y: -d.box[1] / 2 - spine.offset[1], width: d.box[0], height: d.box[1] });
      assert.equal(entry.anims.idle, spine.animation);
      // in a square slot the whole box fills it: the box's corners on the slot's
      const l = rectLayout(150, 150, framing.rect);
      assert.ok(near(l.scale, 150 / d.box[0]) && near(l.x + framing.rect.x * l.scale, 0) && near(l.y - (framing.rect.y + framing.rect.height) * l.scale, 0), id);
    }
    if (seq) { sequences++; assert.match(seq.src, /\.webp$/); }
  }
  assert.deepEqual([spines, sequences], [6, 2]);
});
