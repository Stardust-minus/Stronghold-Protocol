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

test('Ram/VertexDisturb(CustomData): Ram/Disturb(CustomData) plus a vertex stage; the plain one keeps the shared mesh shader', () => {
  const v = compileMaterial({ shader: 'Torappu/Particles-L2D/Ram/VertexDisturb(CustomData)', passes: [pass('Off')], keywords: [] });
  const d = compileMaterial({ shader: 'Torappu/Particles-L2D/Ram/Disturb(CustomData)', passes: [pass('Off')], keywords: [] });
  assert.equal(v.family, 'ramDisturbCd');
  assert.equal(v.defs.vdist, true);
  assert.equal(d.defs.vdist, false);
  assert.notEqual(v.key, d.key);
  assert.equal(vertexExt('ramDisturbCd', d.defs), null);
  const ext = vertexExt('ramDisturbCd', v.defs);
  assert.match(ext.pre, /textureLod\(u_VertexDisturbTex/);
  assert.match(vertexSource('meshr', ext), /op\.xyz \+= voff;[\s\S]*vec4 wp = o2w \* op;/, 'displaced in object space, then transformed');
  const fs = fragmentSource('ramDisturbCd', v.defs);
  assert.ok(!/u_DisturbInfluenceMainUV;\n/.test(fs.split('void main')[1]) && /muv2 = muv \+ dist\.xy;/.test(fs), 'main UV pushed at full strength');
  assert.ok(!/chan4\(texture\(u_MainTex/.test(fs), 'no channel selects');
});

test('3D/MatCapTransparent compiles to the matcap family with the object-space vertex stage', () => {
  const m = compileMaterial({ shader: 'Torappu/Particles-L2D/3D/MatCapTransparent', passes: [pass('Back')], keywords: [] });
  assert.equal(m.family, 'matcap');
  assert.equal(m.fallback, false);
  assert.equal(m.state.cull, 'Back');
  assert.ok(vertexExt('matcap', m.defs));
  assert.match(vertexSource('meshr', vertexExt('matcap', m.defs)), /transpose\(inverse\(mat3\(o2w\)\)\)/);
  assert.match(fragmentSource('matcap', m.defs), /mat3\(u_V\) \* v_nrm/);
});

test('Unlit-Outline: the main pass and its shell pass (next, Cull Front, drawn first without a depth buffer)', () => {
  const m = compileMaterial({ shader: 'Torappu/Particles-L2D/Unlit-Outline', passes: [pass('Back', { zWrite: true }), pass('Front', { zWrite: true })], keywords: [], floats: { _Alpha: 0.5 } });
  assert.equal(m.family, 'outline');
  assert.equal(m.fallback, false);
  assert.equal(m.state.cull, 'Back');
  assert.equal(vertexExt('outline', m.defs), null, 'the main pass uses the shared vertex shaders');
  assert.ok(m.next && m.next.family === 'outline' && m.next.defs.shell && m.next.under);
  assert.equal(m.next.state.cull, 'Front');
  assert.notEqual(m.next.key, m.key);
  assert.equal(m.next.next, undefined);
  assert.match(vertexExt('outline', m.next.defs).post, /0\.0003/);
  assert.match(fragmentSource('outline', m.next.defs), /u_Outline_Color\.rgb, v_col\.a \* u_Alpha/);
});

test('3D/Toon: the _SunMode keyword picks the light (no keyword: Default, the scene light)', () => {
  const c = compileMaterial({ shader: 'Torappu/Particles-L2D/3D/Toon', passes: [pass('Back', { zWrite: true })], keywords: ['_SUNMODE_CUSTOM'] });
  const d = compileMaterial({ shader: 'Torappu/Particles-L2D/3D/Toon', passes: [pass('Back', { zWrite: true })], keywords: [], floats: { _SunMode: 1 } });
  assert.equal(c.family, 'toon');
  assert.equal(c.defs.sunCustom, true);
  assert.equal(d.defs.sunCustom, false, 'the variant follows the keyword');
  assert.notEqual(c.key, d.key);
  assert.match(vertexExt('toon', c.defs).post, /inverse\(u_V\)/);
  assert.match(vertexExt('toon', d.defs).post, /u_WorldSpaceLightPos0/);
  assert.deepEqual(d.vecs._LightColor0, [0, 0, 0, 1]);
});

test('Torappu/Particles/RGBsplit compiles to the rgbsplit family', () => {
  const m = compileMaterial({ shader: 'Torappu/Particles/RGBsplit', passes: [pass('Off')], keywords: [], floats: { _UseCustomData: 1 } });
  assert.equal(m.family, 'rgbsplit');
  assert.equal(m.fallback, false);
  assert.equal(vertexExt('rgbsplit', m.defs), null);
  assert.match(fragmentSource('rgbsplit', m.defs), /vec4 c1 = cd \? v_t1 : vec4\(1\.0\);/);
});

test('Multiply: the L2D shader gets its own arithmetic, the battle one keeps its', () => {
  const l = compileMaterial({ shader: 'Torappu/Particles-L2D/Multiply', passes: [pass('Off')], keywords: [] });
  const b = compileMaterial({ shader: 'Torappu/Particles/Multiply', passes: [pass('Off')], keywords: [] });
  assert.equal(l.family, 'multiply');
  assert.equal(l.defs.l2d, true);
  assert.equal(b.defs.l2d, false);
  assert.notEqual(l.key, b.key);
  assert.match(fragmentSource('multiply', l.defs), /2\.0 \* v_col \* t \* u_TintColor/);
  assert.match(fragmentSource('multiply', b.defs), /0\.299, 0\.587, 0\.114/);
});
