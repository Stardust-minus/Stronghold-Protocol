// 观战 flicker (the owner's report of 2026-10-15): the server sends a scouted prep board again on every change of the
// watched player's (Match._notifyPrepScouts: a move, a purchase, an effect), and each copy rebuilt every view — all their
// operators vanished and faded in on each of their actions. render/app.js enterBattle now keeps the views whose UnitInfo
// is unchanged but for the tile; screens/game.js keeps the camera (and an open pen). The browser check: a spectator
// following a human who moves a piece every 0.7 s (the renderer's unit count no longer drops to 0).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

test('render/app.js enterBattle: the same scouted board sent again keeps the unchanged pieces\' views', () => {
  const app = read('public/js/render/app.js');
  const body = app.slice(app.indexOf('function enterBattle(meta)'), app.indexOf('function addInfo(u)'));
  assert.match(body, /const rescout = meta\.prep === true && mode === 'battle' && !!battleMeta\?\.prep\s*&& battleMeta\.fieldId === \(meta\.fieldId \?\? null\)/);
  assert.match(body, /if \(rescout\) \{[\s\S]*?looks\.get\(id\) !== v\._look\) dropView\(id\);\s*\} else clearViews\(\);/);
  assert.match(body, /if \(info && battleMeta\.prep\) info\._look = scoutLook\(u\);/);
  assert.match(app, /v\._look = info\._look \|\| null;/);
  assert.match(app, /function scoutLook\(u\) \{\s*try \{ return JSON\.stringify\(\{ \.\.\.u, x: undefined, y: undefined \}\); \}/);
});

test('screens/game.js: a scouted board sent again keeps the camera', () => {
  const game = read('public/js/screens/game.js');
  assert.match(game, /const rescout = !!field\.prep && !!enteredFieldRef\.current\?\.prep && enteredFieldRef\.current\.fieldId === field\.fieldId;\s*enteredFieldRef\.current = field;/);
  // (0.3.0: a lone 联防 helper starts on its own half — helperHalf — instead of 全景)
  assert.match(game, /if \(!rescout\) \{[^}]*?setLayer\(helperHalf \|\| 'ALL'\);/);
});

test('a scouted board starts no skill loops (feedback #95: 琳琅诗怀雅 S2 on a teammate\'s bench)', () => {
  const src = readFileSync(new URL('../../public/js/render/app.js', import.meta.url), 'utf8');
  assert.match(src, /if \(!battleMeta\?\.prep\) wiring\.sync\(views\.values\(\)\);/);
});

test('a scouted board runs on the prep clock, not the battle\'s (the owner\'s report of 2026-11-02: 二倍速 while watching in prep)', () => {
  const src = read('public/js/render/app.js');
  assert.match(src, /const battleClock = \(\) => mode === 'battle' && !battleMeta\?\.prep;/);
  assert.match(src, /animRate: \(\) => \(battleClock\(\) \? interp\.rate : 1\),/);
  assert.match(src, /timeScale: \(\) => \(opts\.playbackTime \? 1 : battleClock\(\) \? interp\.rate : 1\),/);
  // and nothing else reads the battle clock for animation
  assert.equal((src.match(/mode === 'battle' \? interp\.rate/g) || []).length, 0);
});
