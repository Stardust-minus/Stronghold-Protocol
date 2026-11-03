// test/local-extract-avatars.test.js — tools/local-extract/avatars.py (rel27): the official dynamic player avatars are an
// opt-in extract (--only ui/avatar_dyn), outside a plain run's expected groups; the pure helpers the sequence timing and
// the Spine layer rely on. The bundle itself needs the game client (not here).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools/local-extract');
const PY = ['python3', 'python'].find((bin) => spawnSync(bin, ['--version']).status === 0);
const ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };

function py(code) {
  const src = `import sys, json\nsys.path.insert(0, ${JSON.stringify(TOOL)})\nimport avatars as a\n${code}`;
  const r = spawnSync(PY, ['-c', src], { encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

describe('avatars.py (no UnityPy needed)', { skip: !PY && 'no python3' }, () => {
  test('--print-jobs names the opt-in ui/avatar_dyn job; a plain run does not expect its groups', () => {
    const r = spawnSync(PY, [path.join(TOOL, 'extract.py'), '--print-jobs'], { encoding: 'utf8', env: ENV });
    assert.equal(r.status, 0, r.stderr);
    const d = JSON.parse(r.stdout);
    assert.deepEqual(d.avatarDyn, { sub: 'ui/avatar_dyn', bundle: 'arts/dynavatars_0.ab', format: 'avatar-dyn', version: 1, optIn: true });
    assert.ok(!d.expectedGroups.some((g) => g.startsWith('ui/avatar_dyn')), 'setup does not ask installs to re-extract for it');
  });

  test('_curve_value: exact 0 / 1 on the 60 Hz grid of a one-sample step (the sequence clips)', () => {
    const v = py(`k=[(0.0,1.0),(12/60,1.0),(13/60,0.0)]\nprint(json.dumps([a._curve_value(k,i/60) for i in (0, 6, 12, 13, 15)]))`);
    assert.deepEqual(v.map((x) => Math.round(x * 1000) / 1000), [1, 1, 1, 0, 0]);
  });

  test('spine_duration: the last key time of one animation, across bone / slot / deform timelines', () => {
    const v = py(`s={'animations':{'loop':{'bones':{'root':{'rotate':[{'time':0},{'time':2.5}]}},'slots':{'a':{'color':[{'time':4}]}}},'x':{'bones':{'b':{'translate':[{'time':9}]}}}}}\nprint(json.dumps([a.spine_duration(s,'loop'), a.spine_duration(s,'x'), a.spine_duration(s,'none')]))`);
    assert.deepEqual(v, [4, 9, 0]);
  });
});
