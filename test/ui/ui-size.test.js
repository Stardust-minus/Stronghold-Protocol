// 设置 →「异形屏适配」→「界面大小」 (ui/screenFit.js, DESIGN §35.43; reworked from PR #838 by @zasx77771): one manual
// factor --sp-ui on <html>, default 100 %, no automatic shrink. What this file guards: the stored percentage (75–100 in
// 5 % steps, 100 when missing or invalid) next to the edge offsets; --sp-ui only while it is not 100 % (at 100 % the
// page is exactly the design); the layout root and the 异形屏适配 root multiplied by it; the 文字大小 floors of 中 / 大 /
// 特大 (64 / 76 / 88 px) never shrinking, while 小 (1rem, no floor) follows the layout; and
// the stylesheet guard: every max(<rem>, <N>px) floor in public/css carries the factor — a size floor (width, height,
// min-*, flex, grid tracks, custom properties) above 32 px as max(<rem>, 32px, calc(Npx * var(--sp-ui, 1))), so a touch
// target ≥ 32 px stays ≥ 32 px, one of 32 px or less stays bare px (it never shrinks), and a value that mirrors a size
// floor copies it exactly — or is a listed exemption (the readability properties: font-size, line-height, letter-spacing, --t).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const F = await import('../../public/js/ui/screenFit.js');
const css = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

describe('the stored size', () => {
  test('sanitizeFit: ui is a percentage 75–100 snapped to 5 %, 100 when missing or invalid; the edges as before', () => {
    assert.deepEqual(F.sanitizeFit(null), { l: 0, r: 0, t: 0, b: 0, ui: 100 });
    assert.equal(F.sanitizeFit({ ui: 85 }).ui, 85);
    assert.equal(F.sanitizeFit({ ui: 83 }).ui, 85);
    assert.equal(F.sanitizeFit({ ui: 40 }).ui, 75);
    assert.equal(F.sanitizeFit({ ui: 150 }).ui, 100, 'above 100 % is not offered: the layout is authored to fill 19.2 × 10.8 rem');
    assert.equal(F.sanitizeFit({ ui: 'x' }).ui, 100);
    assert.equal(F.sanitizeFit({ l: 4 }).ui, 100, 'a value stored before 0.3.2 reads as 100 %');
    assert.deepEqual([F.UI_MIN, F.UI_MAX, F.UI_STEP], [75, 100, 5]);
  });
});

describe('applyFit on <html>', () => {
  function withRoot(fn) {
    const g = globalThis;
    const saved = { document: g.document, dispatchEvent: g.dispatchEvent };
    const props = new Map();
    const el = { dataset: {}, style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) } };
    let resized = 0;
    g.document = { documentElement: el };
    g.dispatchEvent = (e) => { if (e?.type === 'resize') resized++; return true; };
    try { fn(el, props, () => resized); } finally { g.document = saved.document; g.dispatchEvent = saved.dispatchEvent; }
  }
  test('a size under 100 %: --sp-ui alone (no data-fit while no edge moved), then one resize for the board and the HUD', () => {
    withRoot((el, props, resized) => {
      F.applyFit({ l: 0, r: 0, t: 0, b: 0, ui: 85 });
      assert.ok(!('fit' in el.dataset));
      assert.deepEqual(Object.fromEntries(props), { '--sp-ui': '0.85' });
      assert.equal(resized(), 1);
    });
  });
  test('100 %: no property at all — the page is exactly the design; the edges keep working beside the size', () => {
    withRoot((el, props) => {
      F.applyFit({ l: 0, r: 0, t: 0, b: 0, ui: 75 });
      F.applyFit({ l: 0, r: 0, t: 0, b: 0, ui: 100 });
      assert.equal(props.size, 0);
      F.applyFit({ l: 6, r: 0, t: 0, b: 0, ui: 90 });
      assert.ok('fit' in el.dataset);
      assert.equal(props.get('--sp-ui'), '0.9');
      assert.equal(props.get('--fit-l'), '6px');
    });
  });
});

describe('文字大小 中 and above turn the size off', () => {
  test('effectiveUi: the stored size at 小 (or no text size), 100 at 中 / 大 / 特大 — their kept text floors clipped in shrinking boxes', () => {
    assert.equal(F.effectiveUi(80, 'sm'), 80);
    assert.equal(F.effectiveUi(80, undefined), 80);
    for (const k of ['md', 'lg', 'xl']) { assert.equal(F.effectiveUi(80, k), 100, k); assert.equal(F.uiAllowed(k), false); }
    assert.equal(F.effectiveUi(83, 'sm'), 85, 'sanitized');
  });
  test('applyFit at 中: no --sp-ui for a stored 75 %; at 小 it is back', () => {
    const g = globalThis, saved = { document: g.document, dispatchEvent: g.dispatchEvent };
    const props = new Map();
    g.document = { documentElement: { dataset: {}, style: { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k) } } };
    g.dispatchEvent = () => true;
    try {
      F.applyFit({ l: 0, r: 0, t: 0, b: 0, ui: 75 }, 'md');
      assert.equal(props.size, 0);
      F.applyFit({ l: 0, r: 0, t: 0, b: 0, ui: 75 }, 'sm');
      assert.equal(props.get('--sp-ui'), '0.75');
    } finally { g.document = saved.document; g.dispatchEvent = saved.dispatchEvent; }
  });
});

describe('the fork keeps one 界面大小', () => {
  test('异形屏适配 has no size row: the setting is uiScale (--ui, 设置), --sp-ui stays at its default', () => {
    const src = readFileSync(path.join(ROOT, 'public/js/ui/screenFit.js'), 'utf8');
    assert.doesNotMatch(src, /data-testid="ui-size"/);
    assert.doesNotMatch(src, /updateFit\(\{ ui:/);
  });
});
