// 「轮到你选」 (ui/turnPopup.js, css/screens/game-panels.css .sptp): the official effectChoose sprites it draws, the
// wiring in screens/game.js (the shared draft's own turn and a solo draft as it opens — the maintainer's decision of
// 2026-10-22 —, with the 轮到你 sound, once the art is in, never with reduced motion; after the round plate and the 机变阶段
// banner, at most TURN_CUE_PLATE_WAIT_MS / TURN_CUE_WAIT_MS after each mounts — §35.18's leftover) and the stylesheet's rules. In a browser: test/ui/turn-popup.e2e.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const P = await import('../../public/js/ui/turnPopup.js');

test('the official effectChoose sprites, all in the asset list; no drawn stand-ins; not ready without them', () => {
  const ui = JSON.parse(read('data/assets.json')).ui;
  const js = read('public/js/ui/turnPopup.js');
  const keys = js.match(/const ART = \[([^\]]+)\]/)[1].match(/'([A-Za-z_0-9/]+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual(keys.sort(), ['effectChoose/bg_circle', 'effectChoose/bottom', 'effectChoose/plus', 'effectChoose/square_1', 'effectChoose/square_2']);
  for (const k of keys) assert.ok(k in ui, k);
  for (const m of js.matchAll(/k="([^"]+)"/g)) assert.ok(keys.includes(m[1]), m[1]);
  assert.doesNotMatch(js, /<svg/, 'no drawn mark');
  assert.equal(P.turnPopupArtReady(), false, 'in Node (no Image) it never turns ready');
  assert.equal(P.TURN_POPUP_MS, 1200);
});

test('ui/choiceOverlay.js: the disc on each turn of mine in a shared draft (a concurrent one too), once the art is in, never with reduced motion', () => {
  // this fork shows it from the 机变 overlay (its own turn logic: turnPopupDue, draftMyTurn); the match screen only plays the sound
  const c = read('public/js/ui/choiceOverlay.js');
  assert.match(c, /import \{ TurnPopup, preloadTurnPopupArt, turnPopupArtReady \} from '\.\/turnPopup\.js';/);
  assert.match(c, /useEffect\(\(\) => \{ preloadTurnPopupArt\(\); \}, \[\]\);/);
  assert.match(c, /if \(due && turnPopupArtReady\(\) && !reducedMotion\(\)\) setTurnPop\(\(k\) => k \+ 1\);/);
  assert.match(c, /<\$\{TurnPopup\} key=\$\{turnPop\} onDone=\$\{\(\) => setTurnPop\(0\)\} \/>/);
  assert.match(c, /return !!sp && !solo && !personal && draftMyTurn\(sp, myId\) && sp\.pickOf\.get\(myId\) == null;/);
  const g = read('public/js/screens/game.js');
  assert.match(g, /if \(spMine\) audio\.sfx\('yourTurn'\);/);
  assert.doesNotMatch(g, /<\$\{TurnPopup\}/, 'one disc, not two');
});

test('the wait is bounded: it covers the 机变阶段 banner (1.5 s + its 0.26 s close), the whole cue ≤ 3 s; the round plate before it (1.7 s + 0.28 s)', () => {
  const g = read('public/js/screens/game.js');
  const c = read('public/js/ui/components.js');
  const banner = Number(g.match(/<\$\{PhaseBanner\}[^>]*duration=\$\{banner\.duration \|\| (\d+)\}/)[1]);
  const close = Number(c.match(/setTimeout\(\(\) => \{ setGone\(true\); onDone\?\.\(\); \}, duration \+ (\d+)\)/)[1]);
  assert.deepEqual([banner, close], [1500, 260]);
  // the SP_DRAFT banner keeps the default length (phases.js gives it no duration of its own)
  assert.match(read('public/js/ui/gameLogic/phases.js'), /case PHASE\.SP_DRAFT: return \{ title: t\('机变阶段'\), micro: 'CONTINGENCY', tone: 'gold', sub: t\('依次选择机变'\) \};/);
  assert.ok(P.TURN_CUE_WAIT_MS >= banner + close, `${P.TURN_CUE_WAIT_MS} ms covers the banner`);
  assert.ok(P.TURN_CUE_WAIT_MS + P.TURN_POPUP_MS <= 3000, 'banner, then disc, all within 3 s');
  // the round plate still up from ROUND_START (the server's ROUND_START is 2 s, the plate 1.7 s + its 0.28 s leave):
  // its own bound covers it, so a turn that comes under a late plate waits for it, then for the banner
  const mp = read('public/js/ui/matchPopups.js');
  const plate = Number(mp.match(/export const ROUND_POPUP_MS = (\d+);/)[1]);
  const leave = Number(mp.match(/const LEAVE_MS = (\d+);/)[1]);
  assert.match(mp, /export function RoundPopup\([^)]*\) \{\n\s+const leaving = useTimedLeave\(ROUND_POPUP_MS, onDone\);/);
  assert.ok(P.TURN_CUE_PLATE_WAIT_MS >= plate + leave, `${P.TURN_CUE_PLATE_WAIT_MS} ms covers the round plate (${plate} + ${leave})`);
  assert.ok(P.TURN_CUE_PLATE_WAIT_MS + P.TURN_CUE_WAIT_MS + P.TURN_POPUP_MS <= 5000, 'plate, banner, then disc, all within 5 s');
  assert.match(read('public/js/ui/turnPopup.js'), /\[ASSUMED\][^\n]*\n[^\n]*order plate → banner → disc and the wait's bounds/);
});

test('the stylesheet: every keyframe it uses is defined, no clicks caught, reduced motion hides it, the project\'s rules', () => {
  const css = read('public/css/screens/game-panels.css');
  const block = css.slice(css.indexOf('.sptp {'), css.indexOf('.sptp { display: none; }') + 30);
  const used = new Set([...block.matchAll(/animation:\s*([^;]+);/g)].map((m) => m[1].trim().split(/\s+/)[0]));
  assert.ok(used.size >= 4, [...used].join(','));
  for (const n of used) assert.match(block, new RegExp(`@keyframes ${n} \\{`), n);
  assert.match(block, /\.sptp \{[^}]*pointer-events: none;/);
  assert.match(block, /@media \(prefers-reduced-motion: reduce\) \{\n\s+\.sptp \{ display: none; \}/);
  assert.doesNotMatch(block, /!important|:has\(|--t\s*:/);
});
