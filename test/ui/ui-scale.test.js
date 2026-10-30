// 设置 →「界面大小」 (uiScale): css/theme.css `--ui` scales the match's layout root and every pixel floor of the match CSS
// while html.sp-in-match is set — on a phone the root sits at its 40 px clamp and the floors size the HUD, so a smaller
// step shrinks the shop bar and the prep camera frames a taller board (the owner's request of 2026-10-12: buy and deploy
// with the shop open on a phone, like on a computer; 'auto' = 80 % on a phone, 100 % elsewhere). Outside a match --ui is
// 1 and every computed value is what it was. The browser check is test/ui/ui-scale.e2e.test.js.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, UI_SCALES, uiScaleStep, sanitizeSettings } from '../../public/js/ui/gameLogic.js';
import { PHONE_QUERY } from '../../public/js/ui/teamLayout.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** The argument text of every max( / min( / clamp( call in a line, parentheses balanced (nested calls included). */
function sizeCalls(line) {
  const out = [];
  for (const m of line.matchAll(/(?<![\w-])(?:max|min|clamp)\(/g)) {
    let depth = 0, j = m.index + m[0].length - 1;
    for (; j < line.length; j++) {
      if (line[j] === '(') depth++;
      else if (line[j] === ')' && --depth === 0) break;
    }
    out.push(line.slice(m.index + m[0].length, j));
  }
  return out;
}
/** The stylesheets of the match screen whose pixel floors follow --ui. */
const MATCH_CSS = ['devices.css', 'components.css', 'emotes.css', 'screens/game.css', 'screens/game-shop.css', 'screens/team.css',
  'screens/game-panels.css', 'screens/damage-board.css'].map((f) => `public/css/${f}`);

describe('界面大小: the settings value', () => {
  test('steps, default and sanitising', () => {
    assert.deepEqual([...UI_SCALES], ['auto', '70', '80', '90', '100', '110', '120']);
    assert.equal(DEFAULT_SETTINGS.uiScale, 'auto');
    assert.equal(sanitizeSettings(null).uiScale, 'auto', 'a profile saved before the setting');
    assert.equal(sanitizeSettings({ uiScale: '70' }).uiScale, '70');
    assert.equal(sanitizeSettings({ uiScale: 90 }).uiScale, '90', 'a number is read as its step');
    for (const bad of ['75', 'huge', null, 1.2, '']) assert.equal(sanitizeSettings({ uiScale: bad }).uiScale, 'auto', String(bad));
  });

  test("the step the control shows: 'auto' resolves to 80 % on a phone, 100 % elsewhere", () => {
    assert.equal(uiScaleStep('auto', true), '80');
    assert.equal(uiScaleStep('auto', false), '100');
    assert.equal(uiScaleStep('110', true), '110');
    assert.equal(uiScaleStep('bogus', false), '100');
  });
});

describe('界面大小: the CSS', () => {
  const theme = read('public/css/theme.css');

  test('theme.css: --ui is 1 by default, a step only inside a match, auto = 80 % under the phone query', () => {
    assert.match(theme, /:root \{ --ui: 1; \}/);
    for (const [step, v] of [['70', '.7'], ['80', '.8'], ['90', '.9'], ['110', '1.1'], ['120', '1.2']]) {
      assert.match(theme, new RegExp(`:root\\.sp-in-match\\[data-ui="${step}"\\] \\{ --ui: ${v.replace('.', '\\.')}; \\}`), step);
    }
    const auto = theme.match(/@media ([^{]+)\{\s*:root\.sp-in-match\[data-ui="auto"\] \{ --ui: \.8; \}/);
    assert.ok(auto, 'auto has a phone rule');
    assert.equal(auto[1].trim(), PHONE_QUERY, 'the same phone query as ui/teamLayout.js and css/devices.css');
    assert.doesNotMatch(theme.replace(/:root\.sp-in-match[^{]*\{[^}]*\}/g, ''), /--ui: (?!1;)/, 'no step outside a match');
  });

  test('the match root multiplies the unchanged clamp; the base root is untouched', () => {
    assert.match(theme, /html \{\n {2}font-size: calc\(clamp\(40px, min\(calc\(100vw \/ 19\.2\), calc\(100vh \/ 10\.8\)\), 240px\) \* var\(--sp-ui, 1\)\);/);
    assert.match(theme, /html\.sp-in-match \{\n {2}font-size: calc\(clamp\(40px, min\(calc\(100vw \/ 19\.2\), calc\(100vh \/ 10\.8\)\), 240px\) \* var\(--ui\)\);\n\}/);
    assert.match(theme, /@supports \(height: 100svh\) \{\n {2}html\.sp-in-match \{ font-size: calc\(clamp\(40px, min\(calc\(100vw \/ 19\.2\), calc\(100svh \/ 10\.8\)\), 240px\) \* var\(--ui\)\); \}\n\}/);
  });

  test('a declaration with var() and a small / dynamic / large viewport unit sits under @supports for that unit', () => {
    // A var() declaration is only checked at computed-value time: where the unit is unknown it does not fall back to an
    // earlier line but to the property's initial value (the match root at the 16 px default — the
    // owner's report of 2026-10-13: the HUD tiny on browsers without svh).
    const UNIT = /\d(?:\.\d+)?(s|d|l)v(h|w|min|max|i|b)\b/;
    const bad = [];
    const walk = (dir) => readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.css') ? [`${dir}/${e.name}`] : []);
    for (const f of walk('public/css')) {
      const src = read(f);
      const stack = [];
      let text = '';
      for (const ch of src) {
        if (ch === '{') { stack.push(text.trim()); text = ''; }
        else if (ch === '}' || ch === ';') {
          const m = UNIT.exec(text);
          if (m && text.includes('var(') && !stack.some((p) => p.startsWith('@supports') && p.includes(`${m[1]}v${m[2]}`))) {
            bad.push(`${f}: ${text.trim().slice(0, 100)}`);
          }
          if (ch === '}') stack.pop();
          text = '';
        } else text += ch;
      }
    }
    assert.deepEqual(bad, []);
  });

  test('every pixel floor of the match CSS follows --ui (a new unscaled floor would stay full size on a phone)', () => {
    const bad = [];
    let scaled = 0;
    for (const f of MATCH_CSS) {
      for (const [i, line] of read(f).split('\n').entries()) {
        if (/^\s*@/.test(line)) continue;
        scaled += (line.match(/calc\(\d+(?:\.\d+)?px \* var\(--ui\)\)/g) || []).length;
        // a px literal inside max( / min( / clamp( that is not a calc(Npx * var(--ui))
        for (const args of sizeCalls(line)) {
          if (/\d(?:\.\d+)?px/.test(args.replace(/calc\(\d+(?:\.\d+)?px \* var\(--ui\)\)/g, ''))) bad.push(`${f}:${i + 1} ${line.trim().slice(0, 120)}`);
        }
      }
    }
    assert.deepEqual(bad, []);
    assert.ok(scaled >= 170, `${scaled} scaled floors — a mass revert would fail here`);
  });

  test("the phone block's own sizes follow --ui; the invisible touch areas keep --tap-min", () => {
    const devices = read('public/css/devices.css');
    const block = devices.slice(devices.indexOf(`@media ${PHONE_QUERY} {`) + `@media ${PHONE_QUERY} {`.length);
    const body = block.slice(0, block.indexOf('\n}\n'));
    assert.match(body, /\.gm \.shopbar \.scard \{ flex: none; width: max\(1\.56rem, calc\(80px \* var\(--ui\)\)\); height: max\(2\.24rem, calc\(112px \* var\(--ui\)\)\); \}/);
    assert.match(body, /\.gm \.shopbar \{ max-width: calc\(100% - calc\(164px \* var\(--ui\)\) - \.26rem\); \}/);
    assert.doesNotMatch(body.replace(/calc\(\d+(?:\.\d+)?px \* var\(--ui\)\)/g, ''), /\d px|\dpx/, 'no plain px left in the phone block');
    assert.match(devices, /--tap-min: 44px;/);
    assert.match(devices, /width: max\(100%, var\(--tap-min\)\); height: max\(100%, var\(--tap-min\)\);/);
  });
});

describe('界面大小: applying it', () => {
  test('applyUiScale writes <html data-ui>; a change (not the boot) re-frames the field with a resize', async () => {
    const { applyUiScale } = await import('../../public/js/ui/settings.js');
    const el = { dataset: {} };
    const prev = { document: globalThis.document, raf: globalThis.requestAnimationFrame, dispatch: globalThis.dispatchEvent };
    const events = [];
    globalThis.document = { documentElement: el };
    globalThis.requestAnimationFrame = (fn) => fn();
    globalThis.dispatchEvent = (e) => events.push(e.type);
    try {
      applyUiScale('auto');
      assert.equal(el.dataset.ui, 'auto'); assert.deepEqual(events, [], 'the first application has nothing to re-frame');
      applyUiScale('70');
      assert.equal(el.dataset.ui, '70'); assert.deepEqual(events, ['resize'], 'ui/fieldHost.js re-reads the HUD bands');
      applyUiScale('70');
      assert.deepEqual(events, ['resize'], 'an unchanged step does nothing');
      applyUiScale('bogus');
      assert.equal(el.dataset.ui, 'auto', 'an unknown value is auto');
    } finally {
      for (const [k, v] of [['document', prev.document], ['requestAnimationFrame', prev.raf], ['dispatchEvent', prev.dispatch]]) {
        if (v === undefined) delete globalThis[k]; else globalThis[k] = v;
      }
    }
  });

  test('the store applies it on every change and at boot; the modal offers the six steps', () => {
    const src = read('public/js/ui/settings.js');
    assert.match(src, /applyUiScale\(s\.uiScale\);/, 'on every change');
    assert.match(src, /applyUiScale\(settingsStore\.get\(\)\.uiScale\);/, 'at module load, before the first render');
    assert.match(src, /data-testid="ui-scale"/);
    assert.match(src, /uiScaleStep\(s\.uiScale, useMedia\(PHONE_QUERY\)\)/, "the control shows what 'auto' is on this device");
    assert.ok(src.indexOf("t('界面大小')") > src.indexOf("t('文字大小')"), 'the row follows 文字大小');
  });
});
