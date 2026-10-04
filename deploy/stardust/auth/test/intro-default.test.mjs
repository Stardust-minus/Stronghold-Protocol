import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const script = readFileSync(new URL('../public/gate.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');

test('intro preference defaults off and the optional control is not prechecked', () => {
  assert.match(script, /let animations = false/);
  assert.match(script, /localStorage\.getItem\('ark\.prts\.animations'\) === '1'/);
  const control = page.match(/<input id="intro-enabled"[^>]*>/)?.[0];
  assert.ok(control);
  assert.doesNotMatch(control, /\bchecked\b/);
  assert.match(page, /默认关闭/);
});

test('authorized navigation skips the optional transition before starting any animation deadline', () => {
  const enter = script.slice(script.indexOf('  function enter('), script.indexOf('  function busy('));
  const immediate = enter.indexOf('if (!animations || motion.matches) { finishIntro(true); navigate(); return; }');
  assert.ok(immediate > enter.indexOf('applyIdentity(name)'));
  assert.ok(immediate < enter.indexOf('setTimeout(navigate, 4100)'));
  assert.match(script, /fetch\('\/_gate\/profile', \{ method: 'POST'/);
  assert.match(script, /if \(rejectCallsign\(result, statusMessage\)\) return/);
});

test('graphics are lazy and cannot be downloaded automatically while intro is disabled', () => {
  const load = script.slice(script.indexOf('  function loadScene('), script.indexOf('  queueMicrotask(maybeAutoEnter);', script.indexOf('  function loadScene(')));
  assert.ok(load.indexOf('if (!animations || motion.matches') < load.indexOf("import('/_gate/assets/scene.js')"));
  const intro = script.slice(script.indexOf('  function startIntro('), script.indexOf("  animationToggle?.addEventListener('change'"));
  assert.match(intro, /if \(!animations \|\| motion\.matches/);
  assert.match(script, /localStorage\.setItem\('ark\.prts\.animations', animations \? '1' : '0'\)/);
});
