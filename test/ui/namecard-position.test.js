// feedback #61 / #129: the part of a 名片底图 picture the plate shows — moved both ways and zoomed (#129, rel29) — the drag
// arithmetic, the stored values and the room.card fields; the 动态立绘 over a skin card framed by the same rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dragNamecardY, namecardY, namecardX, namecardZoom, NAMECARD_ZOOM, namecardSpare, dragNamecard, zoomNamecard, roundFrame,
  defaultFrame, namecardOf } from '../../public/js/ui/namecards.js';
import { cardMessage, cardStore, setCardBackground, setCardBackgroundFrame } from '../../public/js/ui/playerCard.js';
import { framingLayout } from '../../public/js/ui/dynamicFraming.js';
import { CARD_LIMITS } from '../../shared/protocol.js';

test('the picture follows the pointer and stops at its edges', () => {
  // 600 × 186 plate, a picture as tall as wide: 414 px to spare
  const plate = { width: 600, height: 186, aspect: 1 };
  assert.equal(dragNamecardY(50, 0, plate), 50);
  assert.equal(dragNamecardY(50, 207, plate), 0, 'dragged down: the top of the picture shows');
  assert.equal(dragNamecardY(50, -207, plate), 100);
  assert.equal(dragNamecardY(50, 10000, plate), 0);
  assert.equal(dragNamecardY(50, -10000, plate), 100);
});

test('a picture no taller than the plate, or not measured yet, stays where it is', () => {
  assert.equal(dragNamecardY(30, 50, { width: 600, height: 186, aspect: 0.3 }), 30);
  assert.equal(dragNamecardY(30, 50, { width: 600, height: 186, aspect: 0 }), 30);
});

test('only an integer 0–100 is a position; 0 is one', () => {
  assert.equal(namecardY(0), 0);
  assert.equal(namecardY(100), 100);
  for (const bad of [-1, 101, 1.5, '30', null, undefined]) assert.equal(namecardY(bad), null);
});

test('cardMessage: the position goes with its background, -1 otherwise', () => {
  assert.equal(cardMessage({ bg: 'loading:core', bgY: 30 }).bgY, 30);
  assert.equal(cardMessage({ bg: 'loading:core', bgY: 0 }).bgY, 0);
  assert.equal(cardMessage({ bg: 'loading:core' }).bgY, -1);
  assert.equal(cardMessage({ bg: '', bgY: 30 }).bgY, -1);
  assert.equal(cardMessage({ bg: 'no such card', bgY: 30 }).bgY, -1);
});

test('#129: x and zoom — an integer position 0–100, a zoom NAMECARD_ZOOM (the protocol\'s limit); anything else is the default', () => {
  assert.deepEqual([NAMECARD_ZOOM.min, NAMECARD_ZOOM.max], [100, CARD_LIMITS.bgZoomMax]);
  assert.equal(namecardX(0), 0);
  assert.equal(namecardX(100), 100);
  for (const bad of [-1, 101, 1.5, '30', null, undefined]) assert.equal(namecardX(bad), null);
  assert.equal(namecardZoom(100), 100);
  assert.equal(namecardZoom(NAMECARD_ZOOM.max), NAMECARD_ZOOM.max);
  for (const bad of [-1, 0, 99, NAMECARD_ZOOM.max + 1, 150.5, '200', null]) assert.equal(namecardZoom(bad), null);
  assert.deepEqual(defaultFrame(namecardOf('skin:char_103_angel_wild_1')), { x: 50, y: 24, zoom: 100 });
  assert.deepEqual(defaultFrame(namecardOf('loading:core')), { x: 50, y: 50, zoom: 100 });
});

test('#129: the overhang of a cover picture × zoom — what a drag can move across and down', () => {
  // a square picture on the picker\'s 600 × 133 plate: as wide as the plate at 100 %
  assert.deepEqual(namecardSpare({ width: 600, height: 133, aspect: 1 }), [0, 467]);
  assert.deepEqual(namecardSpare({ width: 600, height: 133, aspect: 1, zoom: 200 }), [600, 1067]);
  // a picture far wider than the plate: as tall as it, the width to spare
  assert.deepEqual(namecardSpare({ width: 600, height: 133, aspect: 0.1 }).map(Math.round), [730, 0]);
  assert.deepEqual(namecardSpare({ width: 600, height: 133, aspect: 0 }), [0, 0], 'not measured: nothing to move');
});

test('#129: the picture follows the pointer both ways (right / down shows more of its left / top) and stops at its edges', () => {
  const plate = { width: 600, height: 133, aspect: 1 };
  const at = (f, dx, dy) => dragNamecard(f, dx, dy, plate);
  assert.deepEqual(at({ x: 50, y: 24, zoom: 100 }, 300, 0), { x: 50, y: 24, zoom: 100 }, 'at 100 % a square picture has no width to spare');
  assert.deepEqual(at({ x: 50, y: 24, zoom: 200 }, 300, 0), { x: 0, y: 24, zoom: 200 }, 'dragged right by half its overhang: its left edge');
  assert.deepEqual(at({ x: 50, y: 24, zoom: 200 }, -150, 0), { x: 75, y: 24, zoom: 200 });
  assert.deepEqual(at({ x: 50, y: 24, zoom: 200 }, -100000, 100000), { x: 100, y: 0, zoom: 200 }, 'clamped');
  const d = at({ x: 50, y: 50, zoom: 200 }, -7, 0);
  assert.ok(!Number.isInteger(d.x), 'a drag in progress is not rounded (smooth)');
  assert.deepEqual(roundFrame(d), { x: 51, y: 50, zoom: 200 });
  assert.deepEqual(roundFrame({ x: -3, y: 140, zoom: 9999 }), { x: 0, y: 100, zoom: NAMECARD_ZOOM.max });
  assert.deepEqual(zoomNamecard({ x: 10, y: 20, zoom: 200 }, 50), { x: 10, y: 20, zoom: 100 }, 'the zoom is about the position: it stays');
  assert.deepEqual(zoomNamecard({ x: 10, y: 20, zoom: 200 }, 1e6), { x: 10, y: 20, zoom: NAMECARD_ZOOM.max });
  // feedback #61's vertical rule is the same arithmetic at 100 %
  assert.equal(dragNamecardY(50, 207, { width: 600, height: 186, aspect: 1 }), 0);
});

test('#129: cardMessage sends the framing with its background (-1 each for the default or none)', () => {
  assert.deepEqual((({ bgX, bgY, bgZoom }) => [bgX, bgY, bgZoom])(cardMessage({ bg: 'skin:char_103_angel_wild_1', bgX: 80, bgY: 30, bgZoom: 250 })), [80, 30, 250]);
  assert.deepEqual((({ bgX, bgZoom }) => [bgX, bgZoom])(cardMessage({ bg: 'loading:core', bgX: 0, bgZoom: 100 })), [0, 100]);
  assert.deepEqual((({ bgX, bgZoom }) => [bgX, bgZoom])(cardMessage({ bg: 'loading:core' })), [-1, -1]);
  assert.deepEqual((({ bgX, bgZoom }) => [bgX, bgZoom])(cardMessage({ bg: '', bgX: 80, bgZoom: 250 })), [-1, -1]);
  assert.deepEqual((({ bgX, bgZoom }) => [bgX, bgZoom])(cardMessage({ bg: 'loading:core', bgX: 101, bgZoom: 99 })), [-1, -1]);
});

test('#129: the store keeps the framing; another background starts at its default framing', () => {
  setCardBackground('skin:char_103_angel_wild_1');
  setCardBackgroundFrame({ x: 80, y: 30, zoom: 250 });
  assert.deepEqual((({ bgX, bgY, bgZoom }) => [bgX, bgY, bgZoom])(cardStore.get()), [80, 30, 250]);
  setCardBackground('skin:char_103_angel_wild_1');
  assert.equal(cardStore.get().bgZoom, 250, 'the same background again keeps it');
  setCardBackgroundFrame({ x: 80, y: 30, zoom: 99 });
  assert.equal(cardStore.get().bgZoom, null, 'an out-of-range zoom is the default');
  setCardBackgroundFrame({ x: 80, y: 30, zoom: 250 });
  setCardBackground('loading:core');
  assert.deepEqual((({ bgX, bgY, bgZoom }) => [bgX, bgY, bgZoom])(cardStore.get()), [null, null, null]);
  setCardBackgroundFrame({ x: 5, y: 6, zoom: 300 });
  setCardBackgroundFrame(null);
  assert.deepEqual((({ bgX, bgY, bgZoom }) => [bgX, bgY, bgZoom])(cardStore.get()), [null, null, null], 'null: the default');
  setCardBackground('');
});

test('#129: a skin card\'s 动态立绘 follows the static plate\'s rule — the bounds\' x% y% point on the box\'s, cover × zoom', () => {
  const B = { x: -800, y: -10, width: 1800, height: 2000 }; // y-up skeleton bounds
  const at = (l, X, Y) => [l.x + X * l.scale, l.y - Y * l.scale];
  const near = (a, b) => Math.abs(a - b) <= 1e-6;
  for (const [w, h] of [[600, 133], [226, 50], [320, 120]]) {
    for (const [fx, fy, zoom] of [[50, 24, 1], [0, 0, 2], [100, 100, 4], [20, 70, 2.5]]) {
      const l = framingLayout(w, h, B, { focusX: fx, focusY: fy, zoom });
      assert.ok(near(l.scale, Math.max(w / B.width, h / B.height) * zoom), `${w}×${h} ${fx}/${fy}/${zoom}: cover × zoom`);
      const [sx, sy] = at(l, B.x + B.width * fx / 100, B.y + B.height - B.height * fy / 100);
      assert.ok(near(sx, w * fx / 100) && near(sy, h * fy / 100), `${w}×${h} ${fx}/${fy}/${zoom}: the point stays on the box's`);
      const [x0, yTop] = at(l, B.x, B.y + B.height), [x1, yBot] = at(l, B.x + B.width, B.y);
      assert.ok(x0 <= 1e-6 && x1 >= w - 1e-6 && yTop <= 1e-6 && yBot >= h - 1e-6, 'the box stays filled');
    }
  }
});
