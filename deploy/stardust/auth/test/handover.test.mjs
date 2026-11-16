// The gate's last frame is the game's loading screen (2026-11-16): login.html #game-handover copies the game page's
// first frame (public/index.html #boot, css/theme.css .boot) — the same rows, root scale, colours and hex, the hex at rest
// and the label's row unseen (the game fades its own label in) — and gate.js shows it before every navigation to the
// game, not to an edge page, without moving the navigation's time: the page swap does not show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const script = read('../public/gate.js'), page = read('../public/login.html'), css = read('../public/gate.css');
const theme = read('../../../../public/css/theme.css'), index = read('../../../../public/index.html');
const squash = value => value.replace(/\s+/g, '');
const rule = (source, selector) => squash(source.match(new RegExp(`(?:^|[}\\n])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] || '');

test('the cover has the rows of the game\'s loading screen', () => {
  assert.match(index, /<div class="boot__inner">\s*<div class="boot__hex"><\/div>\s*<div class="boot__text">STRONGHOLD PROTOCOL<\/div>\s*<div id="boot-err" class="boot__err"><\/div>\s*<\/div>/);
  assert.match(page, /<div id="game-handover" class="game-handover" hidden aria-hidden="true"><div class="handover-inner"><div class="handover-mark"><\/div><div class="handover-label">STRONGHOLD PROTOCOL<\/div><div class="handover-err"><\/div><\/div><\/div>/);
});

test('the cover is drawn at the game\'s scale, in its colours, with its hex', () => {
  // the game's rem at --sp-ui 1 (its first frame, before the app sets 界面大小) is the cover's --r, svh variant included
  const roots = [...theme.matchAll(/html \{\s*font-size: calc\((clamp\(40px, min\(calc\(100vw \/ 19\.2\), calc\(100s?vh \/ 10\.8\)\), 240px\)) \* var\(--sp-ui, 1\)\);/g)].map(m => squash(m[1]));
  assert.equal(roots.length, 2);
  for (const root of roots) assert.ok(squash(css).includes(`--r:${root}`), root);
  assert.match(theme, /--bg-0: #0c0f0e;/);
  assert.match(theme, /--mint-500: #4ed8af;/);
  const boot = rule(theme, '.boot'), hex = rule(theme, '.boot__hex'), inner = rule(theme, '.boot__inner'), text = rule(theme, '.boot__text'), err = rule(theme, '.boot__err');
  assert.match(boot, /background:var\(--bg-0\)/);
  assert.match(boot, /place-items:center/);
  const cover = rule(css, '.game-handover'), mark = rule(css, '.handover-mark');
  assert.match(cover, /background:#0c0f0e/);
  assert.match(cover, /place-items:center/);
  assert.match(cover, /position:fixed;inset:0/);
  const rem = (decl, value) => assert.ok(decl.includes(value), value);
  // every size of the game's screen, in --r
  const size = (from, prop) => from.match(new RegExp(`${prop}:([.0-9]+)rem`))[1];
  rem(rule(css, '.handover-inner'), `gap:calc(${size(inner, 'gap')}*var(--r))`);
  rem(mark, `width:calc(${size(hex, 'width')}*var(--r))`);
  rem(mark, `height:calc(${size(hex, 'height')}*var(--r))`);
  rem(rule(css, '.handover-label'), `font-size:calc(${size(text, 'font-size')}*var(--r))`);
  rem(rule(css, '.handover-err'), `font-size:calc(${size(err, 'font-size')}*var(--r))`);
  // the label's row is as tall as the game's (body line-height 1.5) and unseen
  assert.match(rule(theme, 'body'), /line-height:1\.5/);
  assert.match(rule(css, '.handover-label'), /line-height:1\.5/);
  assert.match(rule(css, '.handover-label'), /visibility:hidden/);
  assert.match(hex, /border:2pxsolidvar\(--mint-500\)/);
  assert.match(mark, /border:2pxsolid#4ed8af/);
  for (const prop of ['clip-path', 'background']) assert.equal(mark.match(new RegExp(`${prop}:([^;]+)`))[1], hex.match(new RegExp(`${prop}:([^;]+)`))[1], prop);
  // the game's hex starts its spin from rest, as the cover's ends (no delay, no offset); its label fades in
  assert.match(hex, /animation:boot-spin1\.4slinearinfinite/);
  assert.match(text, /animation:boot-label-in/);
  assert.match(theme, /@keyframes boot-label-in \{ from \{ opacity: 0; \} \}/);
  assert.match(css, /@keyframes handover-mark\{from\{[^}]*\}to\{opacity:1;transform:none\}\}/);
});

test('gate.js shows the cover before the game\'s navigation (not an edge page\'s), at the same time as before', () => {
  const navigate = script.slice(script.indexOf('  function navigate('), script.indexOf('  function enter('));
  assert.ok(navigate.indexOf("showHandover(motion.matches ? 'instant' : 'fast')") < navigate.indexOf('location.assign(target)'));
  assert.match(navigate, /catch \{\s*navigation = false;\s*if \(handover\) \{ handover\.hidden = true; delete body\.dataset\.handover; \}/, 'a navigation that throws takes it down again');
  const show = script.slice(script.indexOf('  function showHandover('), script.indexOf('  function navigate('));
  assert.match(show, /edgePage\(new URL\(gameLink\(destination\), location\.origin\)\.pathname\)\) return/);
  const enter = script.slice(script.indexOf('  function enter('), script.indexOf('  function busy('));
  assert.match(enter, /setTimeout\(navigate, 3550\)/, 'the navigation keeps its time');
  assert.match(enter, /setTimeout\(navigate, 4100\)/);
  const at = Number(enter.match(/showHandover\('on'\); \} catch \{\} \} \}, (\d+)\)/)[1]);
  const fade = Number(css.match(/body\[data-handover='on'\] \.game-handover\{animation:handover-in ([.0-9]+)s/)[1]) * 1000;
  assert.ok(at > 2050 + 1000 && at + fade <= 3550, `the cover fades in after the portal and is in by the navigation (${at} + ${fade})`);
  assert.match(css, /body\[data-handover='fast'\] \.game-handover\{animation:handover-in/);
  assert.match(css, /body\[data-handover='instant'\] \.game-handover\{opacity:1\}/);
  assert.match(css, /\.game-handover\[hidden\]\{display:none\}/);
  assert.match(css, /\.game-handover\{[^}]*z-index:60;[^}]*pointer-events:none/);
});
