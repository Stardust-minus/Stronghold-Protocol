// 作战统计的手机端比例 (GitHub #817): the panel is ported at its desktop sizes (12–16 px text, 340 px wide),
// but theme.css clamps the layout root `1rem` at 40 px on a phone, where the in-match HUD text is 6–7 px — the card took
// 40 % of an 844 × 390 screen at twice the HUD's size. What this file guards: a short touch-screen override exists in
// screens/game.css, it is the HUD's proportion (9–12 px text, 24 px thumbs, 36 px touch rows, 300 px wide), it keeps
// 文字大小 working (every font-size still reads --t), and it wins the cascade — it must come after the coarse-pointer
// 44 px touch rule, not before. Desktop and tablet sizes stay the original ones.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unscaled } from '../helpers/uiSize.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CSS = unscaled(readFileSync(path.join(ROOT, 'public/css/screens/game.css'), 'utf8'));

const PHONE = '@media (max-height: 600px) and (pointer: coarse), (max-height: 600px) and (any-pointer: coarse) {';

/** The body of the block whose brace opens at `open` (the character before it is '{'), by brace matching. */
function blockAt(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error('unbalanced braces');
}

const at = CSS.indexOf(PHONE);
const phone = at < 0 ? '' : blockAt(CSS, CSS.indexOf('{', at));

describe('作战统计 on short touch screens: the HUD proportion', () => {
  test('a phone override exists and targets short coarse-pointer screens (not tablets, not a mouse window)', () => {
    assert.ok(at >= 0, 'the (max-height: 600px) coarse-pointer media block is missing');
    assert.match(PHONE, /\(pointer: coarse\)/);
    assert.match(PHONE, /\(any-pointer: coarse\)/, 'the fallback for browsers that report only any-pointer');
  });

  test('every font-size in the block still reads --t, so 设置 → 文字大小 lifts the card', () => {
    const sizes = [...phone.matchAll(/font-size:([^;}]*)/g)].map((m) => m[1]);
    assert.ok(sizes.length >= 7, `expected the block to size its text, found ${sizes.length}`);
    for (const value of sizes) assert.match(value, /var\(--t\)/, `font-size:${value.trim()} must read --t`);
  });

  test('the override wins the cascade: it comes after the coarse-pointer 44 px rule and the ≤460 px layout block', () => {
    const coarse = CSS.indexOf('@media (pointer: coarse), (any-pointer: coarse) {');
    const short = CSS.indexOf('@media (max-height: 460px) {');
    assert.ok(coarse >= 0 && short >= 0);
    assert.ok(at > CSS.indexOf('.combat-metrics__close, .combat-metrics__scopes button { min-height: 44px; }'),
      'after the 44 px touch minimum, or min-height would win');
    assert.ok(at > CSS.indexOf('.combat-metrics__micro { display: none; }'),
      'after the ≤460 px block, whose padding-top would otherwise win');
  });

});
