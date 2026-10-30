// shared/card-roster.js (feedback #62 / #99): every operator a display card can show. The file is generated: it must match
// the data, cover the 19 第一期 operators of 0.3.2 and the 协防干员 pool, and only list operators the art manifest has.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CARD_ROSTER } from '../shared/card-roster.js';
import { renderRoster } from '../tools/build-card-roster.mjs';

const json = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));

test('the file is what the data generates (node tools/build-card-roster.mjs)', () => {
  assert.equal(readFileSync(new URL('../shared/card-roster.js', import.meta.url), 'utf8'), renderRoster());
});

test('one row per operator, each with a name, a rarity and art', () => {
  const art = json('data/assets.json').chars;
  assert.equal(new Set(CARD_ROSTER.map((r) => r.charId)).size, CARD_ROSTER.length);
  for (const r of CARD_ROSTER) {
    assert.ok(art[r.charId], r.charId);
    assert.ok(r.name && r.rarity >= 1 && r.rarity <= 6, r.charId);
  }
});

test('the 协防干员 pool and every version\'s visible operators are in', () => {
  const ids = new Set(CARD_ROSTER.map((r) => r.charId));
  for (const id of json('data/backups.json').diy.ownedPool) assert.ok(ids.has(id), id);
  for (const dir of ['', 'versions/act1autochess/', 'versions/act1autochess-v1_1/', 'versions/act2autochess-v2_1/']) {
    for (const c of Object.values(json(`data/${dir}chess.json`))) {
      if (!c.isDiy && c.visible !== false) assert.ok(ids.has(c.charId), `${dir} ${c.charId}`);
    }
  }
  assert.ok(ids.has('char_1035_wisdel'), '维什戴尔 (#99)');
});
