import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sampleTerminalMotion, sphereLinePositions } from '../public/terminal-motion.js';

for (const phase of ['idle', 'intro', 'handoff', 'assembling', 'checking', 'error', 'auth-morph', 'success', 'entering', 'unknown']) {
  test(`camera sampling is bounded and finite for ${phase}, including late/background frames`, () => {
    for (const time of [-1, 0, .1, .7, 1.24, 10, 100000, NaN, Infinity]) {
      const pose = sampleTerminalMotion(phase, time);
      for (const key of ['x', 'y', 'zoom', 'roll', 'assembly', 'card', 'exposure']) assert.ok(Number.isFinite(pose[key]), key);
      assert.ok(pose.zoom >= .4 && pose.zoom <= 1.3);
      for (const key of ['assembly', 'card', 'exposure']) assert.ok(pose[key] >= 0 && pose[key] <= 1);
    }
  });
}
test('assembly settles at the normal 1240ms deadline and auth morph does not move the resting terminal', () => {
  const first = sampleTerminalMotion('assembling', 0), last = sampleTerminalMotion('assembling', 1.24);
  assert.equal(first.assembly, 0); assert.equal(last.assembly, 1);
  assert.equal(last.zoom, 1); assert.equal(last.roll, 0); assert.equal(last.ongoing, false);
  assert.deepEqual(sampleTerminalMotion('auth-morph', .72), sampleTerminalMotion('success', 0));
});
test('the rebuilt intro runs through its complete sequence while entry deadlines stay independent', () => {
  assert.equal(sampleTerminalMotion('intro', 3.1).ongoing, true);
  assert.equal(sampleTerminalMotion('intro', 3.4).ongoing, false);
  assert.equal(sampleTerminalMotion('handoff', .7).ongoing, false);
  const gate = readFileSync(new URL('../public/gate.js', import.meta.url), 'utf8');
  const scene = readFileSync(new URL('../public/scene.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/gate.css', import.meta.url), 'utf8');
  assert.match(gate, /introTimer = setTimeout\(\(\) => finishIntro\(false\), 3200\)/);
  assert.match(scene, /introElements\.map\(el => new CSS3DObject\(el\)\)/);
  assert.match(scene, /setSpatial\(false\); setIntroSpatial\(false\)/);
  assert.match(css, /\.progress-arm\{padding:0\}/);
  assert.match(css, /@keyframes ae-centre-lock/);
});
test('entry advances from the near camera to its final position without overshoot', () => {
  let zoom = 0, exposure = 0;
  for (let i = 0; i <= 150; i++) {
    const pose = sampleTerminalMotion('entering', i / 100);
    assert.ok(pose.zoom >= zoom); assert.ok(pose.exposure >= exposure);
    zoom = pose.zoom; exposure = pose.exposure;
  }
  assert.equal(exposure, 1); assert.equal(zoom, 1.04);
});
test('optional original sphere has an exact normalized edge format, no script or unbounded coordinates', () => {
  assert.deepEqual([...sphereLinePositions({ version: 1, positions: [0,0,0,1,0,0, 0,0,0,0,1,0, 0,0,0,0,0,1] }, 230)], [0,0,0,230,0,0, 0,0,0,0,230,0, 0,0,0,0,0,230]);
  for (const value of [null, {}, { version: 2, positions: [] }, { version: 1, positions: [] },
    { version: 1, positions: Array(18006).fill(0) }, { version: 1, positions: Array(18).fill(Infinity) },
    { version: 1, positions: Array(18).fill('1') }, { version: 1, positions: Array(18).fill(1.1) },
    { version: 1, positions: Array(19).fill(0) }]) assert.throws(() => sphereLinePositions(value));
});
test('optional artwork has cancellation, restoration, coordinated cache identity and no auth dependency', () => {
  const scene = readFileSync(new URL('../public/scene.js', import.meta.url), 'utf8');
  const gate = readFileSync(new URL('../public/gate.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');
  const build = gate.match(/body\.dataset\.build !== '([^']+)'/)[1];
  for (const asset of ['gate.css', 'gate.js', 'warmup.js', 'doctor.webp', 'rhodes.webp']) assert.ok(page.includes(`/_gate/assets/${asset}?v=${build}`));
  assert.ok(gate.includes(`/_gate/assets/scene.js?v=${build}`));
  assert.ok(scene.includes(`terminal-motion.js?v=${build}`));
  assert.ok(scene.includes(`/_gate/assets/ae-sphere.json?v=${build}`));
  assert.match(scene, /setTimeout\(\(\) => artController\.abort\(\), 2500\)/);
  assert.match(scene, /artController\.abort\(\); clearTimeout\(artDeadline\)/);
  assert.match(scene, /setSpatial\(false\)/);
  assert.match(gate, /image\.addEventListener\('error', unavailable/);
  const enter = gate.slice(gate.indexOf('  function enter('), gate.indexOf('  function busy('));
  assert.doesNotMatch(enter, /await|fetch|sphere|portrait|naturalWidth/);
  assert.match(enter, /setTimeout\(navigate, 4100\)/); assert.match(enter, /setTimeout\(navigate, 3550\)/);
});
