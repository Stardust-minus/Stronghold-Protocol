// feedback #61: the part of a 名片底图 picture the plate shows — the drag arithmetic, the stored value and the room.card field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dragNamecardY, namecardY } from '../../public/js/ui/namecards.js';
import { cardMessage } from '../../public/js/ui/playerCard.js';

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
