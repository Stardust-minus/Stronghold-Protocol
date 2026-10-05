import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const script = readFileSync(new URL('../public/gate.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');

test('only the intro defaults off; the control no longer disables the rest of the interface', () => {
  assert.match(script, /let introEnabled = false/);
  assert.match(script, /localStorage\.getItem\('ark\.prts\.intro'\)/);
  assert.match(script, /saved === null && localStorage\.getItem\('ark\.prts\.animations'\) === '1'/);
  const control = page.match(/<input id="intro-enabled"[^>]*>/)?.[0];
  assert.ok(control);
  assert.doesNotMatch(control, /\bchecked\b/);
  assert.match(page, /播放片头动画/);
  assert.match(page, /其他动效保留/);
  assert.doesNotMatch(page, /播放片头与进入动画/);
  const build = script.match(/body\.dataset\.build !== '([^']+)'/)?.[1];
  assert.ok(build);
  assert.ok(page.includes(`data-build="${build}"`));
  assert.ok(page.includes(`/_gate/assets/gate.js?v=${build}`), 'the old one-hour cached script cannot suppress the restored transitions');
});

test('freshly authorized entry keeps morph, success and entering transitions when the intro is off', () => {
  const enter = script.slice(script.indexOf('  function enter('), script.indexOf('  function busy('));
  assert.doesNotMatch(enter, /introEnabled|!animations/);
  assert.match(enter, /if \(motion\.matches\) \{ finishIntro\(true\); navigate\(\); return; \}/);
  assert.ok(enter.indexOf('setTimeout(navigate, 4100)') < enter.indexOf("setPhase('auth-morph')"));
  for (const phase of ['auth-morph', 'success', 'entering']) assert.ok(enter.includes(`setPhase('${phase}')`));
  assert.match(script, /fetch\('\/_gate\/profile', \{ method: 'POST'/);
  assert.match(script, /if \(rejectCallsign\(result, statusMessage\)\) return/);
});

test('skipping the intro still assembles the terminal and loads the existing optional graphics', () => {
  assert.match(script, /else if \(introEnabled && !motion\.matches\) startIntro\(\);\s*else assembleTerminal\(\);/);
  assert.match(script, /setPhase\(motion\.matches \? 'idle' : 'assembling'\)/);
  const load = script.slice(script.indexOf('  function loadScene('), script.indexOf('  queueMicrotask(maybeAutoEnter);', script.indexOf('  function loadScene(')));
  assert.doesNotMatch(load, /introEnabled|animations/);
  assert.ok(load.indexOf('if (motion.matches || scene') < load.indexOf("import('/_gate/assets/scene.js')"));
  assert.match(load, /if \(motion\.matches \|\| navigation\) return/);
});

test('the intro preference can change without disposing the scene used by other animations', () => {
  const toggle = script.slice(script.indexOf("  introToggle?.addEventListener('change'"), script.indexOf('  const initialError'));
  assert.match(toggle, /localStorage\.setItem\('ark\.prts\.intro', introEnabled \? '1' : '0'\)/);
  assert.doesNotMatch(toggle, /dispose|restorePlane/);
  assert.match(toggle, /else \{ finishIntro\(true\); assembleTerminal\(\); \}/);
});
