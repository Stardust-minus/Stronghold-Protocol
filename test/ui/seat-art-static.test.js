// rel30 (the owner, 2026-11-04: 「同盟房间名片只有动态立绘可以缩放移动，可以给静态的也加上吗」): the seat card's 调整立绘 for
// every look (ui/seatLive.js SeatArt). A static portrait is framed in its own picture; a skin with a 动态立绘 keeps its
// skeleton framing and its static portrait is placed by the same transform, so the two never disagree; no framing = the
// CSS default (cover at 50% 12%) exactly as before; the framing travels with any look of a picked operator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seatSpace, defaultArt, staticBox } from '../../public/js/ui/seatLive.js';
import { framingLayout, moveArt, pictureBounds, ART_LIMITS, STATIC_ZOOM_MAX } from '../../public/js/ui/dynamicFraming.js';
import { cardMessage } from '../../public/js/ui/playerCard.js';

const assets = JSON.parse(readFileSync(new URL('../../data/assets.json', import.meta.url), 'utf8'));
const DYN = Object.entries(assets.skins).filter(([, s]) => s.dynamic?.frames?.portrait && s.dynamic.bounds);
// seat art boxes: desktop 1280×720 (223×478), a phone in landscape (116×128), others
const BOXES = [[223, 478], [116, 128], [300, 200], [120, 400], [160, 160]];
const near = (a, b, eps) => Math.abs(a - b) <= eps;
/** CSS object-fit: cover; object-position: 50% 12% of a w × h picture in a bw × bh box */
const cssCover = (bw, bh, w, h) => { const s = Math.max(bw / w, bh / h); return { left: (bw - w * s) * 0.5, top: (bh - h * s) * 0.12, width: w * s, height: h * s }; };

test('a static picture: no space until its size is known; then its own rect, the box always filled', () => {
  assert.equal(seatSpace(null, null), null);
  assert.equal(seatSpace(null, [0, 360]), null);
  const sp = seatSpace(null, [180, 360]);
  assert.deepEqual(sp.bounds, pictureBounds(180, 360));
  assert.deepEqual(sp.pic, sp.bounds);
  assert.equal(sp.zoomMax, STATIC_ZOOM_MAX);
  for (const [bw, bh] of BOXES) {
    for (const art of [{ x: 0, y: 0, zoom: 100 }, { x: 1000, y: 1000, zoom: 100 }, { x: 500, y: 200, zoom: 300 }, { x: 120, y: 900, zoom: STATIC_ZOOM_MAX }]) {
      const b = staticBox(bw, bh, sp, art);
      assert.ok(b.left <= 1e-6 && b.top <= 1e-6 && b.left + b.width >= bw - 1e-6 && b.top + b.height >= bh - 1e-6, `${bw}×${bh} ${JSON.stringify(art)}: filled`);
      assert.ok(near(b.width / b.height, 0.5, 1e-9), 'the picture keeps its shape');
    }
  }
  assert.equal(staticBox(223, 478, sp, null), null, 'no framing: the CSS default');
});

test('starting to frame does not move a static picture: the default as a framing is the CSS cover at 50% 12%', () => {
  for (const [w, h] of [[180, 360], [360, 360], [512, 1024]]) {
    const sp = seatSpace(null, [w, h]);
    for (const [bw, bh] of BOXES) {
      const b = staticBox(bw, bh, sp, defaultArt(bw, bh, sp)), c = cssCover(bw, bh, w, h);
      for (const k of ['left', 'top', 'width', 'height']) assert.ok(near(b[k], c[k], 1), `${w}×${h} in ${bw}×${bh}: ${k} ${b[k]} vs ${c[k]}`);
    }
  }
});

test('a skin with a 动态立绘: the static portrait lands where the live one draws its crop — for its default and any framing', () => {
  assert.ok(DYN.length >= 10, `skins with a 动态立绘 and a crop: ${DYN.length}`);
  for (const [id, s] of DYN) {
    const sp = seatSpace(s.dynamic, null), crop = s.dynamic.frames.portrait;
    assert.deepEqual(sp.pic, crop, `${id}: the static picture is the crop's rect`);
    assert.equal(sp.zoomMax, ART_LIMITS.zoomMax);
    for (const [bw, bh] of BOXES) {
      for (const art of [defaultArt(bw, bh, sp), { x: 480, y: 210, zoom: 620 }, { x: 0, y: 0, zoom: 100 }, { x: 1000, y: 500, zoom: 2500 }]) {
        const l = framingLayout(bw, bh, s.dynamic.bounds, { art });
        const b = staticBox(bw, bh, sp, art);
        assert.ok(near(b.left, l.x + crop.x * l.scale, 1e-6) && near(b.top, l.y - (crop.y + crop.height) * l.scale, 1e-6)
          && near(b.width, crop.width * l.scale, 1e-6) && near(b.height, crop.height * l.scale, 1e-6), `${id} ${bw}×${bh} ${JSON.stringify(art)}`);
      }
      // and its default as a framing is the CSS cover of the picture (the static under the live one, before rel30 too) —
      // within what the stored framing can say: half a per-mille of the bounds (huge skeletons: a few px; rel27's rounding)
      const b = staticBox(bw, bh, sp, defaultArt(bw, bh, sp)), c = cssCover(bw, bh, crop.width, crop.height);
      const scale = c.width / crop.width, tol = Math.max(1.5, 0.6 * Math.max(s.dynamic.bounds.width, s.dynamic.bounds.height) / 1000 * scale);
      for (const k of ["left", "top", "width", "height"]) assert.ok(near(b[k], c[k], tol), `${id} ${bw}×${bh} default ${k}: ${b[k]} vs ${c[k]} (±${tol})`);
    }
  }
});

test('the framer\'s zoom: a static portrait up to STATIC_ZOOM_MAX, a 动态立绘 up to the stored limit', () => {
  const sp = seatSpace(null, [180, 360]);
  assert.equal(moveArt(223, 478, sp.bounds, { x: 500, y: 300, zoom: 200 }, 0, 0, 100, sp.zoomMax).zoom, STATIC_ZOOM_MAX);
  assert.equal(moveArt(223, 478, sp.bounds, { x: 500, y: 300, zoom: 200 }, 0, 0, 100).zoom, ART_LIMITS.zoomMax);
  assert.equal(moveArt(223, 478, sp.bounds, { x: 500, y: 300, zoom: 200 }, 0, 0, 0.01, sp.zoomMax).zoom, ART_LIMITS.zoomMin);
});

test('cardMessage: the framing goes with any look of a picked 名片干员 (精二 / 精一 / a skin), never without one', () => {
  const art = { x: 420, y: 310, zoom: 260 };
  for (const look of ['', 'e1', 'char_103_angel_wild_1']) {
    const m = cardMessage({ charId: 'char_103_angel', look, art });
    assert.deepEqual([m.artX, m.artY, m.artZoom], [420, 310, 260], `look '${look}'`);
  }
  const none = cardMessage({ charId: '', look: '', art });
  assert.deepEqual([none.artX, none.artY, none.artZoom], [-1, -1, -1]);
});
