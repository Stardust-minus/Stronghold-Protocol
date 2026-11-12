// shared/standIn.js naturalCompare: the stand-in's summon list (`tokens`) is sorted without the host's collation, so
// every browser engine sorts it the same (the consensus design §8: localeCompare reads the engine's ICU data). On the
// ids the data has, the order is the one localeCompare(…, 'en', { numeric: true }) gave — so no battle changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { naturalCompare } from '../shared/standIn.js';
import { getData } from '../server/data.js';

const icu = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });

/** Every string of a `tokens` / `displayTokens` array anywhere in the game data. */
function tokenIds(data) {
  const out = new Set();
  const seen = new Set();
  const walk = (v, depth) => {
    if (!v || typeof v !== 'object' || seen.has(v) || depth > 12) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    for (const [k, x] of Object.entries(v)) {
      if ((k === 'tokens' || k === 'displayTokens') && Array.isArray(x)) for (const id of x) if (typeof id === 'string') out.add(id);
      walk(x, depth + 1);
    }
  };
  walk(data, 0);
  return [...out];
}

test('every summon id of the data sorts as localeCompare sorted it', () => {
  const ids = tokenIds(getData());
  assert.ok(ids.length >= 30, `found ${ids.length} summon ids`);
  assert.deepEqual([...ids].sort(naturalCompare), [...ids].sort(icu));
});

test('generated ids of the data alphabet ([0-9_a-z]) compare as localeCompare does', () => {
  let s = 12345;
  const rnd = (n) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s % n; };
  const alphabet = '0123456789_abcdefghijklmnopqrstuvwxyz';
  const gen = () => {
    const parts = ['token', 'trap', 'char', 'tk'][rnd(4)];
    let id = parts;
    for (let k = rnd(4) + 1; k > 0; k--) id += (rnd(2) ? '_' : '') + (rnd(2) ? String(rnd(3000)) : alphabet[10 + rnd(27)].repeat(rnd(3) + 1));
    return id;
  };
  const ids = [...new Set(Array.from({ length: 400 }, gen))];
  for (const a of ids) for (const b of ids) {
    if (a === b) continue;
    assert.equal(Math.sign(naturalCompare(a, b)), Math.sign(icu(a, b)), `${a} vs ${b}`);
  }
});

test('digit runs compare as numbers, punctuation before digits before letters, no collation', () => {
  const sorted = ['b', 'a10', 'a2', 'a_x', 'a02', 'A1', 'a1'].sort(naturalCompare);
  assert.deepEqual(sorted, ['a_x', 'A1', 'a1', 'a2', 'a02', 'a10', 'b']);
  assert.equal(naturalCompare('x', 'x'), 0);
  assert.ok(naturalCompare('x', 'x1') < 0);
});
