// node --test test/render/vfx-dynfx-shaders.test.js
// The 动态立绘 scenes' L2D shader families (render/vfx, DESIGN §33): which family and variant a client shader compiles
// to, the drawing pass state, and the families' own vertex stages. The arithmetic is drawn and measured in
// vfx-dynfx-shaders.browser.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileMaterial } from '../../public/js/render/vfx/materials.js';
import { fragmentSource, vertexSource, vertexExt } from '../../public/js/render/vfx/glsl.js';

const pass = (cull, extra = {}) => ({ blend: ['SrcAlpha', 'OneMinusSrcAlpha', 'Zero', 'OneMinusSrcAlpha'], blendOp: 'Add', zTest: 'LessEqual', zWrite: false, cull, colorMask: 15, ...extra });
const KINDS = ['quad', 'mesh', 'meshr', 'strip'];

test('GrabPass / GrabPassOnce: the drawing pass after the grab, the custom-data keyword, the named grab', () => {
  const passes = [pass('Off', { blend: ['One', 'Zero', 'One', 'Zero'], zTest: 'Disabled' }), pass('Back', { blend: ['One', 'Zero', 'One', 'Zero'] })];
  const g = compileMaterial({ shader: 'Torappu/Particles-L2D/Disturb/Disturb GrabPass', passes, floats: { _CUSTOMDATA: 1 }, keywords: [] });
  assert.equal(g.family, 'grab');
  assert.equal(g.fallback, false);
  assert.equal(g.state.cull, 'Back', 'the state of the pass after GrabPass #0');
  assert.equal(g.state.zTest, 'lequal');
  assert.equal(g.defs.cvs, false, 'the variant follows the keyword, not the saved toggle');
  assert.equal(g.defs.once, false);
  const o = compileMaterial({ shader: 'Torappu/Particles-L2D/Disturb/Disturb GrabPassOnce', passes, keywords: ['_CUSTOMDATA_ON'] });
  assert.equal(o.family, 'grab');
  assert.equal(o.defs.cvs, true);
  assert.equal(o.defs.once, true, 'a named GrabPass is grabbed once per render');
  assert.deepEqual(o.keywords, ['_CUSTOMDATA_ON']);
  const ext = vertexExt('grab', g.defs);
  assert.ok(ext && /v_scr2/.test(ext.post), 'grab has its own vertex stage (screen step of the moved vertex)');
  for (const k of KINDS) assert.match(vertexSource(k, ext), /mat4 o2w/);
  assert.match(vertexSource('meshr', ext), /vec4 op = vec4\(a_pos, 1\.0\)/, 'a MeshRenderer works in its mesh space');
  assert.match(vertexSource('mesh', ext), /mat4 o2w = mat4\(1\.0\)/, 'particle meshes arrive in world space');
  assert.equal(vertexSource('meshr'), vertexSource('mesh'), 'families without a vertex stage share the mesh shader');
  assert.match(fragmentSource('grab', o.defs), /in vec4 v_scr2;/);
  assert.match(fragmentSource('grab', o.defs), /nOff = v_t1\.xy; iScale = v_t1\.zw; mOff = v_t2\.xy; mI = v_t2\.z;/);
});
