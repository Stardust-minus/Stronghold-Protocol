// 动态立绘 embedded where an appearance's art shows (the owner's decisions of 2026-11-02 / 11-03; ui/dynamicIllustration.js,
// ui/dynamicFraming.js, ui/dynamicStage.js): the fit of the art in a box — the preview's contain, the official avatar /
// portrait crops as CSS cover, the 名片's bounds, a seat's own framing —, the shared renderer's packing, which skins
// animate (never a collab one), and the data: every shipped 动态立绘 with its crops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { illustrationLayout, LOAD_TIMEOUT_MS } from '../../public/js/ui/dynamicIllustration.js';
import { rectLayout, seatRect, artOfRect, moveArt, cardArt, framingLayout, cropFraming, lookDynamic, dynamicOf, e2Dynamic, ART_LIMITS, dynamicFrame, frameClip, pictureBox } from '../../public/js/ui/dynamicFraming.js';
import { packPages, PAGE, MAX_STEP } from '../../public/js/ui/dynamicStage.js';
import { visibleRect, seatSpace, sceneSpaceMoved, illustrationBox, staticBox, boxRect } from '../../public/js/ui/seatLive.js';
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

test('frame: the 查看立绘 preview shows the official camera frame whole, edge to edge, centred (2026-11-16)', () => {
  const F = { x: -1118, y: -497, width: 2200, height: 2200 };
  for (const [w, h] of [[600, 400], [400, 600], [560, 560]]) {
    const l = illustrationLayout(w, h, F, 'frame');
    assert.equal(l.scale, Math.min(w, h) / 2200);
    const p = pictureBox(l, F);
    assert.ok(Math.abs(p.left + p.width / 2 - w / 2) < 1e-9 && Math.abs(p.top + p.height / 2 - h / 2) < 1e-9, 'centred');
    assert.ok(Math.abs(Math.max(p.width / w, p.height / h) - 1) < 1e-9, 'touches the box on its tighter side, nothing cut');
  }
  assert.equal(dynamicFrame({ frame: F }), F);
  for (const bad of [null, {}, { frame: { ...F, width: 0 } }, { frame: { ...F, x: NaN } }, { frame: 'x' }]) assert.equal(dynamicFrame(bad), null);
});

test('名片 framing in the official frame; crops and seat framings keep their spaces; a backdrop view draws inside the frame only', () => {
  const F = { x: -1000, y: -300, width: 2000, height: 2000 }, Bd = { x: -3700, y: -260, width: 7000, height: 2350 };
  const card = { focusX: 50, focusY: 24, zoom: 1 };
  assert.deepEqual(framingLayout(640, 140, Bd, card, F), rectLayout(640, 140, F, 50, 24, 1), 'the 名片: the frame (its static plate, the 立绘, shows about that square)');
  assert.deepEqual(framingLayout(640, 140, Bd, card), rectLayout(640, 140, Bd, 50, 24, 1), 'no frame: the bounds as before');
  const crop = { rect: { x: -80, y: 900, width: 200, height: 200 }, posX: 50, posY: 50 };
  assert.deepEqual(framingLayout(96, 96, Bd, crop, F), rectLayout(96, 96, crop.rect, 50, 50), 'a crop is a crop');
  const art = { art: { x: 500, y: 300, zoom: 400 } };
  assert.deepEqual(framingLayout(200, 300, Bd, art, F), rectLayout(200, 300, seatRect(200, 300, Bd, art.art)), 'a seat\'s stored framing: still the bounds');
  // the clip: the box ∩ the frame's square under the transform
  const l = rectLayout(400, 200, { x: -2000, y: -300, width: 4000, height: 2000 });
  const k = frameClip(400, 200, l, F), p = pictureBox(l, F);
  assert.deepEqual(k, { x: p.left, y: 0, w: p.width, h: 200 }, 'a wide box: the frame\'s columns, the full height');
  assert.deepEqual(frameClip(100, 100, rectLayout(100, 100, F), F), { x: 0, y: 0, w: 100, h: 100 }, 'the frame covering the box: all of it');
  assert.deepEqual(frameClip(100, 100, rectLayout(100, 100, { x: 5000, y: 0, width: 100, height: 100 }), F).w, 0, 'outside: nothing');
});

test('backdrop: 查看立绘 and DynamicIllustration\'s cover mode (名片, seat card) draw background / foreground in the frame; LiveArt (干员调配 cells, avatars) never', () => {
  const src = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  const ill = src('public/js/ui/dynamicIllustration.js'), stage = src('public/js/ui/dynamicStage.js');
  assert.match(ill, /export function CoverIllustration\(\{[^}]*backdrop = false[^}]*\}\)/, 'off unless asked');
  assert.match(ill, /<\$\{CoverIllustration\} \.\.\.\$\{props\} backdrop=\$\{props\.backdrop !== false\} \/>/, 'DynamicIllustration cover: on');
  assert.match(ill, /export function LiveArt[\s\S]*?<\$\{CoverIllustration\} entry=\$\{dyn\} framing=\$\{framing\} \/>/, 'LiveArt: not passed');
  assert.doesNotMatch(src('public/js/ui/avatarLive.js'), /backdrop/, 'avatars: none');
  for (const p of ['public/js/ui/namecards.js', 'public/js/ui/seatLive.js']) assert.match(src(p), /<\$\{DynamicIllustration\} mode="cover"/, `${p}: through DynamicIllustration`);
  assert.match(stage, /if \(v\.backdrop\) \{/, 'the shared renderer loads the layers only for a backdrop view');
  assert.match(stage, /backdropSprite\(P, image, frame \|\| b\)/, 'placed in the frame (the bounds without one)');
  assert.match(ill, /backdropSprite\(P, image, space\)/);
  assert.doesNotMatch(ill + stage, /sprite\.width = b\.width/, 'never stretched to the skeleton bounds again');
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

test('the 查看立绘 preview\'s markup is balanced: one root (rel27 lost the status line\'s </span>, the preview rendered as two roots and crashed 干员调配 once it loaded, feedback #168)', () => {
  const src = readFileSync(new URL('../../public/js/ui/dynamicIllustration.js', import.meta.url), 'utf8');
  for (const tag of ['div', 'span', 'label', 'select']) {
    const open = (src.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length, close = (src.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    assert.equal(open, close, `<${tag}> opened ${open}, closed ${close}`);
  }
  assert.match(src, /<span role="status">[^\n]*<\/span>\n/, 'the status line closes its span');
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
test('data: every skin with an official 动态立绘 ships it (72: 11 from PRTS, 60 from the client in rel26, 1 from the client in 0.4.0), complete', () => {
  const recs = Object.entries(assets.skins);
  const declared = recs.filter(([, r]) => r.dynamicDeclared), shipped = recs.filter(([, r]) => r.dynamic);
  assert.equal(shipped.length, 72);
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

test('data: every 动态立绘 from the client has its official camera frame, a square holding its official avatar / portrait crops', () => {
  const recs = [...Object.entries(assets.skins).map(([id, r]) => [id, r.dynamic]), ...Object.entries(assets.chars).map(([id, c]) => [id, c.dynamicE2])].filter(([, d]) => d);
  const framed = recs.filter(([, d]) => d.frame);
  // no client bundle for these two (令「方遒卷」, 望's 精二): no frame, the bounds stand in
  assert.deepEqual(recs.filter(([, d]) => !d.frame).map(([id]) => id).sort(), ['char_2023_ling_nian_12', 'char_2027_wang']);
  assert.equal(framed.length, 71 + 26);
  for (const [id, d] of framed) {
    const f = dynamicFrame(d);
    assert.ok(f && Math.abs(f.width - f.height) < 0.01 && f.width >= 1500 && f.width <= 4000, `${id}: a square of the client's size`);
    // 银灰「不融冰」 is a small bust at the foot of a tall scene: its half-body crop runs below the camera's view
    for (const c of id === 'char_172_svrash_ambienceSynesthesia_4' ? [d.frames.avatar] : [d.frames.avatar, d.frames.portrait]) {
      assert.ok(c.x >= f.x - 1 && c.x + c.width <= f.x + f.width + 1 && c.y >= f.y - 1 && c.y + c.height <= f.y + f.height + 1, `${id}: its official crops inside the camera's view`);
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

// ---- the operators' own 精二 动态立绘 (2026-11-16, the owner: 「有一部分干员精英II立绘也是动态的…例如塔露拉」) ----------------

const E2DYN = { skel: '/assets/char/dynamic/char_1012_skadi2_2/d.skel', atlas: '/assets/char/dynamic/char_1012_skadi2_2/d.atlas',
  textures: ['/assets/char/dynamic/char_1012_skadi2_2/d.webp'], pma: false, anims: { idle: 'Idle' }, animations: { Idle: 4 },
  bounds: { x: -900, y: -100, width: 1800, height: 1700 }, frames: { avatar: { x: -80, y: 900, width: 200, height: 200 }, portrait: { x: -90, y: 760, width: 180, height: 360 } } };
const SKIN_DYN = { ...E2DYN, skel: '/assets/skins/char_1012_skadi2_iteration_2/dynamic/s.skel' };
const e2m = () => ({
  chars: {
    char_1012_skadi2: { avatar: '/a1', avatarE2: '/a2', portrait: '/p1', portraitE2: '/p2', dynamicE2: E2DYN },
    char_1028_texas2: { avatar: '/t1', portrait: '/tp1', dynamicE2: { ...E2DYN } }, // no 精二 pictures: nothing to play over
    char_4247_oxi: { avatarE2: '/assets/collab/x.png', dynamicE2: { ...E2DYN } }, // a collab picture: never
  },
  skins: {
    char_1012_skadi2_iteration_2: { charId: 'char_1012_skadi2', avatar: '/sa', portrait: '/sp', illustration: '/si', dynamic: SKIN_DYN },
    char_1012_skadi2_boc_4: { charId: 'char_1012_skadi2', avatar: '/sa4', portrait: '/sp4', illustration: '/si4' }, // a static skin here
  },
});

test('精二 动态立绘: plays wherever the operator\'s own 精二 pictures show — the default card look, a 精锐 record without a skin', () => {
  const m = e2m();
  assert.equal(e2Dynamic(m, 'char_1012_skadi2'), E2DYN);
  assert.equal(e2Dynamic(m, 'char_1028_texas2'), null, 'no avatarE2 / portraitE2');
  assert.equal(e2Dynamic(m, 'char_4247_oxi'), null, 'collab');
  assert.equal(e2Dynamic(m, 'char_nope'), null);
  assert.equal(e2Dynamic(null, 'char_1012_skadi2'), null);
  // card looks (room.card look / avatarLook)
  assert.equal(lookDynamic(m, 'char_1012_skadi2', ''), E2DYN, '精二, the default look');
  assert.equal(lookDynamic(m, 'char_1012_skadi2', 'e1'), null, '精一');
  assert.equal(lookDynamic(m, 'char_1012_skadi2', 'char_1012_skadi2_iteration_2'), SKIN_DYN, 'a skin with its own');
  assert.equal(lookDynamic(m, 'char_1012_skadi2', 'char_1012_skadi2_boc_4'), null, 'a static skin: its static picture, never the 精二 one');
  assert.equal(lookDynamic(m, 'char_1012_skadi2', 'char_1013_chen2_boc_6'), E2DYN, 'not this operator\'s skin: the pictures fall back to 精二 (seatArt lookUrl)');
  assert.equal(lookDynamic({ chars: m.chars }, 'char_1012_skadi2', 'char_1012_skadi2_iteration_2'), E2DYN, 'a skin not installed: 精二 too');
  assert.equal(lookDynamic(m, '', ''), null);
  // a skins choice map (干员调配 / 自选): `elite` = the box shows the 精锐 record
  assert.equal(dynamicOf(m, 'char_1012_skadi2', {}), null, 'the 精一 / normal record: no 精二 art there');
  assert.equal(dynamicOf(m, 'char_1012_skadi2', {}, true), E2DYN, 'the 精锐 record');
  assert.equal(dynamicOf(m, 'char_1012_skadi2', { char_1012_skadi2: 'char_1012_skadi2_iteration_2' }, true), SKIN_DYN);
  assert.equal(dynamicOf(m, 'char_1012_skadi2', { char_1012_skadi2: 'char_1012_skadi2_boc_4' }, true), null, 'a static skin worn');
});

test('精二 动态立绘 in a seat: framed in its 立绘\'s space (the static 精二\'s), so a saved frame shows the same part live', () => {
  // the static 精二: an 1800 × 1700 立绘, its portrait box; the skeleton holds the same 立绘 at scale 0.8, offset
  const BOX = [520 / 1800, 110 / 1700, 720 / 1800, 1440 / 1700], size = [1800, 1700];
  const pic = { src: '/p2', hd: null, illustration: '/i2', box: BOX, size, scene: true };
  const ill = { x: -700, y: -50, width: 1800 * 0.8, height: 1700 * 0.8 };
  const crop = boxRect(ill, BOX);
  const dyn = { ...E2DYN, frames: { ...E2DYN.frames, portrait: crop } };
  const st = seatSpace(null, null, pic), e2 = seatSpace(dyn, null, pic, null, true), skin = seatSpace(dyn, null, pic);
  assert.deepEqual(skin.bounds, dyn.bounds, 'a skin: its skeleton bounds, as before');
  for (const k of ['x', 'y', 'width', 'height']) assert.ok(near(e2.bounds[k], ill[k], 1e-6), `the 立绘 in the skeleton: ${k}`);
  for (const [bw, bh] of [[223, 478], [120, 240], [300, 200]]) {
    for (const art of [null, { x: 500, y: 300, zoom: 300 }, { x: 120, y: 900, zoom: 150 }, { x: 900, y: 50, zoom: 2000 }]) {
      const a = illustrationBox(bw, bh, st, art), b = illustrationBox(bw, bh, e2, art);
      for (const k of ['left', 'top', 'width', 'height']) assert.ok(near(a[k], b[k], 1e-6), `${bw}×${bh} ${JSON.stringify(art)}: the 立绘 lands alike (${k})`);
      const s1 = staticBox(bw, bh, st, art), s2 = staticBox(bw, bh, e2, art);
      for (const k of ['left', 'top', 'width', 'height']) assert.ok(near(s1[k], s2[k], 1e-6), `${bw}×${bh}: the 180×360 alike (${k})`);
      // the live layer: framingLayout with the seat's space puts the skeleton where the 立绘 is
      if (art) {
        const l = framingLayout(bw, bh, dyn.bounds, { art, space: e2.bounds });
        assert.ok(near(l.x + ill.x * l.scale, b.left, 1e-6) && near(l.y - (ill.y + ill.height) * l.scale, b.top, 1e-6), 'live over the 立绘');
      }
    }
  }
  assert.equal(sceneSpaceMoved(dyn, pic, true), true, 'a pre-rel31 frame of the static scene 精二 is still dropped');
  assert.equal(sceneSpaceMoved(dyn, pic), false, 'a skin\'s: unchanged');
});

test('data: every 精二 动态立绘 complete, its crops inside its bounds, a framing the seat can store; only operators with 精二 pictures', () => {
  const recs = Object.entries(assets.chars).filter(([, c]) => c.dynamicE2);
  assert.equal(recs.length, 27);
  for (const [id, c] of recs) {
    const d = c.dynamicE2, dir = `/assets/char/dynamic/${id}_2/`;
    assert.ok(c.avatarE2 && c.portraitE2 && c.illustrationE2 && c.portraitBoxE2, `${id}: its static 精二`);
    assert.match(d.skel, new RegExp(`^${dir}[^/]+\\.(skel|json)$`), id);
    assert.ok(d.atlas.startsWith(dir) && d.atlas.endsWith('.atlas') && d.textures.length >= 1 && d.textures.every((u) => u.startsWith(dir) && u.endsWith('.webp')), id);
    assert.equal(typeof d.pma, 'boolean');
    assert.ok(Object.hasOwn(d.animations, d.anims.idle) && /^idle$/i.test(d.anims.idle), `${id}: a looping Idle`);
    const { avatar, portrait } = d.frames, b = d.bounds;
    assert.ok(Math.abs(avatar.width - avatar.height) < 0.01 && Math.abs(portrait.height - 2 * portrait.width) < 0.01, `${id}: shapes`);
    for (const f of [avatar, portrait]) {
      assert.ok(f.width > 20 && f.x >= b.x - 2 && f.x + f.width <= b.x + b.width + 2 && f.y >= b.y - 2 && f.y + f.height <= b.y + b.height + 2, `${id}: inside its bounds`);
    }
    for (const [w, h] of [[120, 240], [120, 290], [140, 230]]) {
      const v = visibleRect(w, h, rectLayout(w, h, portrait, 50, 12)), art = artOfRect(w, h, b, v);
      assert.ok(art.zoom >= ART_LIMITS.zoomMin && art.zoom * 2 <= ART_LIMITS.zoomMax, `${id} ${w}×${h}: ${art.zoom} %`);
    }
  }
});

test('installed: every file of every 精二 动态立绘 on disk', { skip: !existsSync(new URL('../../public/assets/char/dynamic/char_4247_oxi_2', import.meta.url)) && 'install the 精二 动态立绘 first' }, () => {
  for (const [id, c] of Object.entries(assets.chars)) {
    if (!c.dynamicE2) continue;
    for (const u of [c.dynamicE2.skel, c.dynamicE2.atlas, ...c.dynamicE2.textures]) assert.ok(statSync(new URL(`../../public${u}`, import.meta.url)).size > 0, `${id}: ${u}`);
  }
});
