// The early buffer of a field the view does not show yet (screens/game.js onEv → game/early.js trimEarly): bounded
// without ever losing a spawn — the owner's report of 2026-11-02, 「联防的时候，干员有概率变成红色水滴」: a busy 联防 entered
// late lost its opening spawns to the old cut of the oldest tuples, and those operators had no UnitInfo (render/app.js
// createUnknown: an enemy-styled red placeholder, no panel).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keepEarly, trimEarly, EARLY_MAX } from '../../public/js/screens/game/early.js';

const spawn = (id) => ['spawn', { id, kind: 'op', side: 'ally', defId: `char_${id}` }];

test('trimEarly: a busy field keeps every spawn and the latest status / skill per unit', () => {
  const buf = [spawn(1), spawn(2), spawn(3)];
  for (let i = 0; i < 4000; i++) buf.push(['status', 1 + (i % 3), 'stun', i % 2], ['skill', 1 + (i % 3), i % 2]);
  buf.push(spawn(4), ['die', 9]);
  assert.ok(buf.every(keepEarly));
  trimEarly(buf);
  assert.ok(buf.length <= EARLY_MAX, `bounded (${buf.length})`);
  assert.deepEqual(buf.filter((x) => x[0] === 'spawn').map((x) => x[1].id), [1, 2, 3, 4], 'every spawn kept, in order');
  assert.equal(buf[0][0], 'spawn', 'the opening spawns stay first');
  // the last status of each (unit, status) and the last skill of each unit survive the compaction
  for (const id of [1, 2, 3]) {
    assert.equal(buf.filter((x) => x[0] === 'status' && x[1] === id).length, 1);
    assert.equal(buf.filter((x) => x[0] === 'skill' && x[1] === id).length, 1);
  }
  assert.deepEqual(buf.at(-1), ['die', 9]);
});

test('trimEarly: past the cap after compaction the oldest non-spawn tuples go, never a spawn', () => {
  const buf = [];
  for (let i = 0; i < 1000; i++) buf.push(spawn(i));
  for (let i = 0; i < 1000; i++) buf.push(['die', i], ['deploy', i]);
  trimEarly(buf, 1500);
  assert.equal(buf.length, 1500);
  assert.equal(buf.filter((x) => x[0] === 'spawn').length, 1000);
  assert.deepEqual(buf.at(-1), ['deploy', 999], 'the newest tuples stay');
  const small = [spawn(1), ['die', 1]];
  assert.equal(trimEarly(small, 1500), small);
  assert.equal(small.length, 2, 'under the cap: untouched');
});

test('screens/game.js buffers through trimEarly (no cut of the oldest tuples)', () => {
  const src = readFileSync(new URL('../../public/js/screens/game.js', import.meta.url), 'utf8');
  assert.match(src, /for \(const e of msg\.ev\) if \(keepEarly\(e\)\) buf\.push\(e\);\s*trimEarly\(buf\);/);
  assert.doesNotMatch(src, /buf\.splice\(0, buf\.length - 1500\)/);
});
