// rel30 HD portraits (the owner's 「来点高清立绘」; the manifest contract of hd30): chars[id] illustration(E2) / portraitHD(E2) /
// portraitBox(E2), skins[id] illustration / portraitHD / portraitBox. The 180×360 pick is unchanged; a large view tries
// the HD crop first; the seat card draws the whole illustration placed so that, with no framing, its portrait box lands
// exactly where the 180×360 lands today, and frames it across the whole illustration; a look without the fields keeps
// today's 180×360 and maths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chessPortraitSource, chessPortraitUrl, chessPortraitHdUrl, portraitChain, portraitSourceOf, isPortraitBox, chainProps } from '../../public/js/ui/assetUrls.js';
import { lookUrl, lookPortraitSource, seatPortrait, seatPortraitSource, cardOperators, cardContext } from '../../public/js/ui/seatArt.js';
import { seatSpace, defaultArt, staticBox, illustrationBox, boxRect, illustrationAround, sceneSpaceMoved } from '../../public/js/ui/seatLive.js';
import { ART_LIMITS, STATIC_ZOOM_MAX } from '../../public/js/ui/dynamicFraming.js';

const assets = JSON.parse(readFileSync(new URL('../../data/assets.json', import.meta.url), 'utf8'));
const chessList = Object.values(JSON.parse(readFileSync(new URL('../../data/chess.json', import.meta.url), 'utf8')));
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const BOXES = [[223, 478], [116, 128], [300, 200], [120, 400]];
const cssCover = (bw, bh, w, h) => { const s = Math.max(bw / w, bh / h); return { left: (bw - w * s) * 0.5, top: (bh - h * s) * 0.12, width: w * s, height: h * s }; };
const sameBox = (a, b, eps, what) => { for (const k of ['left', 'top', 'width', 'height']) assert.ok(near(a[k], b[k], eps), `${what}: ${k} ${a[k]} vs ${b[k]}`); };

/** a stub entry of the contract: an 1800 × 1700 illustration, the portrait box 720 × 1440 at (520, 110) */
const BOX = [520 / 1800, 110 / 1700, 720 / 1800, 1440 / 1700];
const HD_CHAR = { portrait: '/a/p1.png', portraitE2: '/a/p2.png', portraitHD: '/a/h1.png', portraitHDE2: '/a/h2.png',
  illustration: '/a/i1.png', illustrationE2: '/a/i2.png', portraitBox: BOX, portraitBoxE2: BOX, illustrationSize: [1800, 1700] };
/** a seat source (portraitSourceOf) of the stub: the whole 立绘 */
const WHOLE = { src: '/a/p1.png', hd: '/a/h1.png', illustration: '/a/i1.png', box: BOX, size: [1800, 1700], scene: false };

/** chessPortraitUrl before rel30 (the reference: the 180×360 pick must not change) */
function oldPortraitUrl(m, chess) {
  const str = (v) => (typeof v === 'string' && v ? v : null);
  const ap = m.skins?.[chess?.skinId]; if (ap?.charId === chess?.charId && str(ap?.portrait)) return ap.portrait;
  const chars = m.chars, id = str(chess?.assets?.portrait);
  if (id) {
    if (chars[id]) return (chess?.isGolden ? str(chars[id].portraitE2) : null) || str(chars[id].portrait);
    if (id.endsWith('_2')) { const b = chars[id.slice(0, -2)]; if (b) return str(b.portraitE2) || str(b.portrait); }
    if (id.endsWith('_1')) { const b = chars[id.slice(0, -2)]; if (b) return str(b.portrait); }
  }
  const byChar = chess?.charId ? chars[chess.charId] : null;
  return byChar ? (chess?.isGolden ? str(byChar.portraitE2) : null) || str(byChar.portrait) : null;
}

test('portraitBox: four numbers, a positive size, overlapping the picture (it may run past its edges: the contract)', () => {
  for (const ok of [BOX, [-0.05, 0.6, 0.3, 0.6], [0.8, -0.1, 0.3, 0.6]]) assert.ok(isPortraitBox(ok), JSON.stringify(ok));
  for (const bad of [null, [0, 0, 1], [0, 0, 0, 1], [1, 0, 0.2, 0.4], [-0.5, 0, 0.4, 0.8], [0, 0, 0.5, NaN], '0,0,1,1']) assert.equal(isPortraitBox(bad), false, JSON.stringify(bad));
});

test('a source takes the HD fields of the 180×360 it came from: E2 with E2, never another form\'s; illustration and box together', () => {
  assert.deepEqual(portraitSourceOf(HD_CHAR, 'portrait'), { src: '/a/p1.png', hd: '/a/h1.png', illustration: '/a/i1.png', box: BOX, size: [1800, 1700], scene: false });
  assert.deepEqual(portraitSourceOf(HD_CHAR, 'portraitE2'), { src: '/a/p2.png', hd: '/a/h2.png', illustration: '/a/i2.png', box: BOX, size: null, scene: false });
  assert.deepEqual(portraitSourceOf({ portraitE2: '/a/p2.png', portraitHD: '/a/h1.png', illustration: '/a/i1.png', portraitBox: BOX }, 'portraitE2'),
    { src: '/a/p2.png', hd: null, illustration: null, box: null, size: null, scene: false }, 'only E1 HD: the E2 portrait gets none');
  assert.equal(portraitSourceOf({ portrait: '/a/p.png', portraitHD: '/a/h.png', illustration: '/a/i.png', portraitBox: BOX, portraitScene: true }, 'portrait').scene, true);
  assert.deepEqual(portraitSourceOf({ portrait: '/a/p1.png', illustration: '/a/i1.png' }, 'portrait').illustration, null, 'no box: no illustration');
  assert.deepEqual(portraitSourceOf({ portrait: '/a/p1.png', portraitBox: BOX }, 'portrait').box, null, 'no illustration: no box');
  assert.equal(portraitSourceOf({}, 'portrait'), null);
  const m = { chars: { char_x: HD_CHAR }, skins: {} };
  assert.equal(chessPortraitHdUrl(m, { charId: 'char_x', isGolden: true }), '/a/h2.png');
  assert.equal(chessPortraitHdUrl(m, { charId: 'char_x', isGolden: false }), '/a/h1.png');
  assert.equal(chessPortraitHdUrl(m, { charId: 'char_x', assets: { portrait: 'char_x_2' } }), '/a/h2.png');
  assert.equal(chessPortraitHdUrl(m, { charId: 'char_x', assets: { portrait: 'char_x_1' } }), '/a/h1.png');
  assert.deepEqual(chainProps(portraitChain(m, [{ charId: 'char_x', isGolden: true }, { charId: 'char_x' }])),
    { src: '/a/h2.png', fallbackSrc: ['/a/p2.png', '/a/h1.png', '/a/p1.png'] }, 'HD, its 180×360, then the next record\'s');
});

test('the 180×360 pick is what it was for every chess record and look of the shipped manifest; its HD is that form\'s', () => {
  let n = 0;
  for (const c of chessList) {
    if (!c?.charId) continue;
    assert.equal(chessPortraitUrl(assets, c), oldPortraitUrl(assets, c), c.chessId);
    const src = chessPortraitSource(assets, c), e = assets.chars[c.charId];
    if (src && e && (src.src === e.portraitE2 || src.src === e.portrait)) {
      const e2 = src.src === e.portraitE2 && src.src !== e.portrait;
      assert.equal(src.hd, (e2 ? e.portraitHDE2 : e.portraitHD) ?? null, `${c.chessId}: the HD of the form picked`);
      // rel31: a scene form keeps its 立绘 for the seat card; the large views still never draw one
      if (src.illustration) assert.equal(src.illustration, e2 ? e.illustrationE2 : e.illustration, `${c.chessId}: the 立绘 of the form picked`);
      for (const u of portraitChain(assets, [c])) assert.ok(u !== e.illustration && u !== e.illustrationE2, `${c.chessId}: a large view never draws a 立绘`);
    }
    n++;
  }
  assert.ok(n > 100);
  for (const charId of Object.keys(assets.chars)) {
    for (const look of ['', 'e1', ...Object.entries(assets.skins).filter(([, s]) => s.charId === charId).map(([id]) => id)]) {
      assert.equal(lookPortraitSource(assets, charId, look)?.src ?? null, lookUrl(assets, charId, look, 'portrait'), `${charId} '${look}'`);
    }
  }
  const ctx = { ...cardContext(cardOperators(chessList)), m: assets, myId: 7, myCard: 'char_103_angel', myLook: 'e1' };
  assert.equal(seatPortraitSource({ playerId: 7 }, ctx).src, seatPortrait({ playerId: 7 }, ctx));
});

test('the seat card, HD: with no framing the illustration\'s portrait box lands exactly where the 180×360 lands today', () => {
  for (const [size, nat] of [[null, null], [null, [1800, 1700]], [[1800, 1700], null]]) {
    const sp = seatSpace(null, null, { ...WHOLE, size }, nat);
    assert.equal(sp.zoomMax, ART_LIMITS.zoomMax, 'the HD zoom limit is the stored one');
    for (const [bw, bh] of BOXES) {
      const sd = staticBox(bw, bh, sp, null), il = illustrationBox(bw, bh, sp, null);
      sameBox(sd, cssCover(bw, bh, 180, 360), 1e-6, `${bw}×${bh} the 180×360 placed = its CSS cover`);
      const boxIn = { left: il.left + BOX[0] * il.width, top: il.top + BOX[1] * il.height, width: BOX[2] * il.width, height: BOX[3] * il.height };
      sameBox(boxIn, sd, 1e-6, `${bw}×${bh} the box in the illustration = the 180×360`);
    }
  }
});

test('the seat card, HD: any framing pans the whole illustration with the box filled; the 180×360 under it stays on its box', () => {
  const sp = seatSpace(null, null, WHOLE);
  for (const [bw, bh] of BOXES) {
    for (const art of [defaultArt(bw, bh, sp), { x: 0, y: 0, zoom: 100 }, { x: 1000, y: 1000, zoom: 300 }, { x: 500, y: 150, zoom: ART_LIMITS.zoomMax }]) {
      const il = illustrationBox(bw, bh, sp, art), sd = staticBox(bw, bh, sp, art);
      assert.ok(il.left <= 1e-6 && il.top <= 1e-6 && il.left + il.width >= bw - 1e-6 && il.top + il.height >= bh - 1e-6, `${bw}×${bh} ${JSON.stringify(art)} filled`);
      sameBox({ left: il.left + BOX[0] * il.width, top: il.top + BOX[1] * il.height, width: BOX[2] * il.width, height: BOX[3] * il.height }, sd, 1e-6, 'the 180×360 on its box');
    }
  }
  // the framing reads the same before and after the illustration's size is known (the contract's 1:2 box)
  const before = seatSpace(null, null, { ...WHOLE, size: null }, null), after = sp;
  const art = { x: 420, y: 230, zoom: 260 };
  const a = illustrationBox(223, 478, before, art), b = illustrationBox(223, 478, after, art);
  sameBox(a, b, 1e-6, 'size unknown vs known');
  // a look without the fields: today's 180×360 space and zoom cap
  assert.equal(seatSpace(null, [180, 360], null).zoomMax, STATIC_ZOOM_MAX);
  assert.equal(illustrationBox(223, 478, seatSpace(null, [180, 360], null), art), null);
});

test('the seat card, HD under a 动态立绘: the illustration goes where its box matches the official crop (the live one\'s frame unchanged)', () => {
  const dyns = Object.entries(assets.skins).filter(([, s]) => s.dynamic?.frames?.portrait);
  for (const [id, s] of dyns.slice(0, 20)) {
    const crop = s.dynamic.frames.portrait;
    const ill = illustrationAround(crop, BOX), back = boxRect(ill, BOX);
    for (const k of ['x', 'y', 'width', 'height']) assert.ok(near(back[k], crop[k], 1e-6), `${id}: boxRect ∘ illustrationAround`);
    const sp = seatSpace(s.dynamic, null, WHOLE);
    assert.equal(sp.bounds, s.dynamic.bounds, 'the framing space stays the skeleton');
    for (const art of [null, { x: 480, y: 210, zoom: 620 }]) {
      const il = illustrationBox(223, 478, sp, art), sd = staticBox(223, 478, sp, art);
      sameBox({ left: il.left + BOX[0] * il.width, top: il.top + BOX[1] * il.height, width: BOX[2] * il.width, height: BOX[3] * il.height }, sd, 1e-6, `${id} ${JSON.stringify(art)}`);
    }
    // no framing: the 180×360 where its CSS cover puts it (as under the live one before)
    sameBox(staticBox(223, 478, sp, null), cssCover(223, 478, crop.width, crop.height), 1e-6, `${id} default`);
  }
});

test('a box past the 立绘\'s edge: the framing space holds both, the default still lands on the 180×360\'s place', () => {
  const box = [0.75, -0.08, 0.3, 0.6 * 1800 / 1700]; // runs past the right and the top edge (1:2 in pixels)
  const sp = seatSpace(null, null, { ...WHOLE, box });
  assert.ok(sp.bounds.x + sp.bounds.width > 1800 && sp.bounds.y + sp.bounds.height > 1700, 'the bounds take in the box');
  for (const [bw, bh] of BOXES) {
    sameBox(staticBox(bw, bh, sp, null), cssCover(bw, bh, 180, 360), 1e-6, `${bw}×${bh}`);
    const art = defaultArt(bw, bh, sp);
    sameBox(staticBox(bw, bh, sp, art), cssCover(bw, bh, 180, 360), 1.5, `${bw}×${bh} its default as a framing (no jump)`);
  }
});

test('rel31: a scene look (portraitScene) frames its whole 立绘 in the seat, scene included — exactly as a look without a scene', () => {
  const scene = { ...WHOLE, scene: true };
  const sp = seatSpace(null, null, scene), sw = seatSpace(null, null, WHOLE);
  assert.deepEqual(sp, sw, 'the same space as a non-scene look');
  assert.equal(sp.hdSrc, '/a/i1.png', 'the whole 立绘');
  assert.equal(sp.place, true);
  assert.equal(sp.zoomMax, ART_LIMITS.zoomMax);
  for (const [bw, bh] of BOXES) {
    const d = defaultArt(bw, bh, sp);
    assert.ok(d.zoom > ART_LIMITS.zoomMin, `${bw}×${bh}: the default (${d.zoom}) can zoom out`);
    sameBox(staticBox(bw, bh, sp, null), cssCover(bw, bh, 180, 360), 1e-6, `${bw}×${bh}: the default lands on the 180×360's place`);
  }
  assert.equal(seatSpace(null, null, { ...WHOLE, illustration: null, box: null }).hdSrc, '/a/h1.png', 'only a portraitHD: in the 180×360 space');
  // under a 动态立绘: its 立绘 by the box ↔ official crop match, the framing still the skeleton's
  const [, s] = Object.entries(assets.skins).find(([, x]) => x.dynamic?.frames?.portrait);
  const dsp = seatSpace(s.dynamic, null, scene);
  assert.equal(dsp.hdSrc, '/a/i1.png');
  assert.deepEqual(dsp.hd, illustrationAround(s.dynamic.frames.portrait, BOX));
  assert.equal(dsp.bounds, s.dynamic.bounds);
});

test('rel31: a scene look keeps its 立绘 in its source (the seat), the large views still draw the 180×360 / cut-out only', () => {
  // char_4244_tocka-like: E2 a scene with no portraitHDE2 (hd30 emits none where it would not be sharper)
  const tocka = { portrait: '/a/t1.png', portraitE2: '/a/t2.png', illustration: '/a/ti1.png', portraitBox: BOX, portraitHD: '/a/th1.png',
    illustrationE2: '/a/ti2.png', portraitBoxE2: BOX, illustrationSizeE2: [1800, 1700], portraitSceneE2: true };
  const e2 = portraitSourceOf(tocka, 'portraitE2');
  assert.deepEqual(e2, { src: '/a/t2.png', hd: null, illustration: '/a/ti2.png', box: BOX, size: [1800, 1700], scene: true });
  const m = { chars: { char_t: tocka }, skins: {} };
  assert.deepEqual(portraitChain(m, [{ charId: 'char_t', isGolden: true }]), ['/a/t2.png'], 'large views: the 180×360, never the 立绘');
  const sp = seatSpace(null, [180, 360], e2);
  assert.equal(sp.hdSrc, '/a/ti2.png', 'the seat: the whole 立绘');
  assert.equal(sp.place, true);
  // a scene skin with a cut-out: large views the cut-out, the seat its 立绘
  const sk = portraitSourceOf({ portrait: '/a/s.png', portraitHD: '/a/sh.png', illustration: '/a/si.png', portraitBox: BOX, portraitScene: true }, 'portrait');
  assert.deepEqual([sk.hd, sk.illustration, sk.box], ['/a/sh.png', '/a/si.png', BOX]);
  assert.equal(seatSpace(null, null, sk).hdSrc, '/a/si.png');
  const [, dyn] = Object.entries(assets.skins).find(([, x]) => x.dynamic?.frames?.portrait);
  assert.equal(seatSpace(dyn.dynamic, null, e2).hdSrc, '/a/ti2.png', 'under a 动态立绘: its 立绘 on the crop');
});

test('rel31: only a static scene look\'s frame changed space (a frame saved before rel31 is dropped there, kept elsewhere)', () => {
  const [, dyn] = Object.entries(assets.skins).find(([, x]) => x.dynamic?.frames?.portrait);
  assert.equal(sceneSpaceMoved(null, { ...WHOLE, scene: true }), true, 'a static scene look with its 立绘');
  assert.equal(sceneSpaceMoved(null, WHOLE), false, 'a look without a scene: the 立绘 already in rel30');
  assert.equal(sceneSpaceMoved(dyn.dynamic, { ...WHOLE, scene: true }), false, 'a 动态立绘: the skeleton, unchanged');
  assert.equal(sceneSpaceMoved(null, { ...WHOLE, scene: true, illustration: null, box: null }), false, 'no 立绘: the 180×360 space, unchanged');
  assert.equal(sceneSpaceMoved(null, null), false);
});
