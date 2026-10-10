import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hudBands } from '../../public/js/ui/fieldHost.js';

const read = file => readFileSync(new URL('../../' + file, import.meta.url), 'utf8');

function withHud(row, run) {
  const saved = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
  globalThis.document = {
    documentElement: {},
    querySelector: selector => selector === '.gm__hud' ? { getBoundingClientRect: () => ({ top: 0 }) }
      : selector === '.gm__hud > .shopbar .shopbar__row' && row ? { getBoundingClientRect: () => row } : null,
    querySelectorAll: () => [],
  };
  globalThis.getComputedStyle = () => ({ fontSize: '40px' });
  try { run(); } finally { Object.assign(globalThis, saved); }
}

test('phone prep camera reserves the readable shop row, but combat keeps its own camera', () => {
  withHud({ top: 222, height: 130 }, () => {
    for (const kind of ['prep', 'bossPrep']) assert.equal(hudBands(kind, { width: 640, height: 360 }).bottom, 138);
    assert.equal(hudBands('normal', { width: 640, height: 360 }), null);
  });
});

test('absent or unlaid-out shop rows retain the rem fallback, and the height budget stays bounded', () => {
  for (const row of [null, { top: 0, height: 0 }]) withHud(row, () => {
    assert.equal(hudBands('prep', { width: 640, height: 360 }).bottom, 108.60000000000001);
  });
  withHud({ top: 0, height: 400 }, () => {
    assert.equal(hudBands('prep', { width: 640, height: 360 }).bottom, 144);
    assert.ok(hudBands('prep', { width: 640, height: 360 }, { shop: false }).bottom < 138);
  });
});

test('mobile offers have their own size floor and scrolling, without changing the global layout root', () => {
  const css = read('public/css/devices.css');
  assert.match(css, /\.gm \.shopbar \.scard \{ flex: none; width: max\(1\.56rem, 80px\); height: max\(2\.24rem, 112px\); \}/);
  assert.match(css, /\.gm \.shopbar__cards, \.gm \.shopbar__rwcards \{[^}]*overflow-x: auto;[^}]*touch-action: pan-x;/);
  assert.match(css, /\.gm \.shopbar__row \{ max-width: 100%; min-width: 0;/);
  assert.match(read('public/css/theme.css'), /font-size: clamp\(40px, min\(calc\(100vw \/ 19\.2\), calc\(100svh \/ 10\.8\)\), 240px\);/);
});

test('phone lobby never hides the existing online-session count', () => {
  const css = read('public/css/devices.css') + read('public/css/screens/lobby.css');
  assert.doesNotMatch(css, /[^{}]*\.online-players[^{}]*\{[^}]*display:\s*none/);
  assert.match(css, /\.lobby-screen \.online-players \{ display: inline-flex; position: absolute; top: 100%; left: 16px;/);
});
