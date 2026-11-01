// Feedback #11 (2026-10-16, 「x键的售出有卡顿……连续摁会售出其他干员」): after an X sale the server pulls a 临时区 piece into
// the freed bench slot (the one just sold, under the mouse), so a second X there sold the newcomer. ui/gameLogic/shortcuts.js
// staleHotkeySale drops an X on the same spot until the pointer moves; screens/game.js keeps the last sale's spot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pieceSpot, staleHotkeySale } from '../../public/js/ui/gameLogic/shortcuts.js';

test('pieceSpot names the board tile or the bench slot', () => {
  assert.equal(pieceSpot({ area: 'board', row: 2, col: 5 }), 'b:2,5');
  assert.equal(pieceSpot({ area: 'hand', idx: 5 }), 'hand:5');
  assert.equal(pieceSpot({ area: 'temp', idx: 0 }), 'temp:0');
  assert.equal(pieceSpot(null), null);
});

test('a second X on the refilled slot with the mouse still is stale; a move or another spot is not', () => {
  const last = { spot: 'hand:5', x: 400, y: 600 };
  assert.equal(staleHotkeySale(null, 'hand:5', { x: 400, y: 600 }), false, 'the first sale');
  assert.equal(staleHotkeySale(last, 'hand:5', { x: 400, y: 600 }), true, 'same slot, mouse still');
  assert.equal(staleHotkeySale(last, 'hand:5', { x: 402, y: 599 }), true, 'a jitter of a couple of pixels');
  assert.equal(staleHotkeySale(last, 'hand:5', { x: 420, y: 600 }), false, 'the mouse moved');
  assert.equal(staleHotkeySale(last, 'hand:4', { x: 400, y: 600 }), false, 'another slot');
  assert.equal(staleHotkeySale(last, null, { x: 400, y: 600 }), false);
});

test('feedback #98: after selling the selection, X with the mouse still on another piece is stale; a move is not', () => {
  const last = { spot: 'b:3,4', x: 400, y: 600, selected: true };
  assert.equal(staleHotkeySale(last, 'hand:2', { x: 400, y: 600 }), true, 'the piece under the resting mouse is not sold');
  assert.equal(staleHotkeySale(last, 'hand:2', { x: 402, y: 599 }), true);
  assert.equal(staleHotkeySale(last, 'hand:2', { x: 420, y: 600 }), false, 'the mouse moved: a new choice');
  assert.equal(staleHotkeySale(last, null, { x: 400, y: 600 }), false);
});

test('feedback #98: a selected piece is sold at once, whatever the last sale left', () => {
  const src = readFileSync(new URL('../../public/js/screens/game.js', import.meta.url), 'utf8');
  assert.match(src, /const uid = L\.sel \? L\.sel\.uid : pointer \? L\.view\?\.pieceAtClientPoint/);
  assert.match(src, /if \(!L\.sel && pointer && staleHotkeySale\(lastSale, spot, pointer\)\)/);
  assert.match(src, /lastSale = pointer \? \{ spot, x: pointer\.x, y: pointer\.y, selected: !!L\.sel \} : null/);
});

test('the game screen checks the guard before a hotkey sale and records the spot', () => {
  const src = readFileSync(new URL('../../public/js/screens/game.js', import.meta.url), 'utf8');
  const at = src.indexOf("act === 'sell' && available?.sell != null");
  assert.ok(at > 0);
  const block = src.slice(at, at + 500);
  assert.match(block, /staleHotkeySale\(lastSale, spot, pointer\)/);
  assert.ok(block.indexOf('lastSale = {') < block.indexOf('await sellOwnPiece(uid)'), 'the spot is kept before the sale is sent');
});
