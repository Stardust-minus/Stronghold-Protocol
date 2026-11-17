// RENDER_E2E=1 node --test test/render/vfx-dynfx-shaders.browser.test.js
// The 动态立绘 scenes' L2D shader families drawn by the real render/vfx (materials.js → glsl.js → gl.js) in Chrome's
// WebGL2, measured against the formulas worked out here on the CPU for inputs simple enough to predict exactly
// (one-texel textures, a linear background, an orthographic camera).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gpuArgs } from '../../tools/perfbench.mjs';
import { CHROME, hasChrome } from '../e2e/client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const enabled = process.env.RENDER_E2E === '1' && hasChrome();
const W = 64, H = 64, HW = 2, HH = 2;   // canvas px; the orthographic camera's half extents (Unity units)

/** In the page: draw a background (r = u, g = v, b = 0.5) and then the items through FxGL; returns the RGBA pixels. */
async function pageRender(spec) {
  const { FxGL } = await import('/js/render/vfx/gl.js');
  const { compileMaterial } = await import('/js/render/vfx/materials.js');
  const { MESH_STRIDE, QUAD_STRIDE } = await import('/js/render/vfx/geom.js');
  const cv = document.createElement('canvas');
  cv.width = spec.W; cv.height = spec.H;
  const gl = cv.getContext('webgl2', { alpha: true, premultipliedAlpha: false, antialias: false, depth: !!spec.depth, preserveDrawingBuffer: true });
  const tex = new Map(Object.entries(spec.textures || {}).map(([k, t]) => [k, { image: new ImageData(new Uint8ClampedArray(t.data), t.w, t.h), info: { wrapU: t.wrap || 'repeat', wrapV: t.wrap || 'repeat', filter: 'bilinear', mips: 1 } }]));
  const meshes = new Map(Object.entries(spec.meshes || {}));
  const glr = new FxGL(gl, { texture: (k) => tex.get(k) || null, mesh: (k) => meshes.get(k) || null });
  const bg = glr._link(`#version 300 es
layout(location=0) in vec2 p; out vec2 uv; void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`, `#version 300 es
precision highp float; in vec2 uv; out vec4 o; void main() { o = vec4(uv, 0.5, 1.0); }`);
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.viewport(0, 0, spec.W, spec.H);
  gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
  gl.useProgram(bg); gl.drawArrays(gl.TRIANGLES, 0, 6); gl.bindVertexArray(null);
  // Unity camera at z = −10 looking +z; orthographic, half extents hw × hh, clip z = view depth / 100
  const vp = new Float32Array([1 / spec.hw, 0, 0, 0, 0, 1 / spec.hh, 0, 0, 0, 0, 0.01, 0, 0, 0, 0.1, 1]);
  const fd = { nq: 0, nm: 0, ns: 0, ni: 0, quad: new Float32Array(QUAD_STRIDE * 8), mesh: new Float32Array(MESH_STRIDE * 8) };
  const items = [];
  for (const it of spec.items) {
    const mat = compileMaterial(it.mat);
    const I = it.inst || {};
    const tail = [...(I.color || [1, 1, 1, 1]), ...(I.uvr || [0, 0, 1, 1]), ...(I.t0 || [0, 0]), ...(I.t1 || [0, 0, 0, 0]), ...(I.t2 || [0, 0, 0, 0])];
    if (it.kind === 'quad') {
      fd.quad.set([...(I.center || [0, 0, 0]), ...(I.ax || [2, 0, 0]), ...(I.ay || [0, -2, 0]), ...tail], fd.nq * QUAD_STRIDE);
      items.push({ kind: 'quad', part: 'ps', mat, first: fd.nq++, count: 1, ov: null });
    } else {
      const m = I.m || [1, 0, 0, 0, 1, 0, 0, 0, 1];
      fd.mesh.set([...(I.center || [0, 0, 0]), ...m, ...tail], fd.nm * MESH_STRIDE);
      items.push({ kind: 'mesh', part: it.part || 'mesh', mat, meshKey: it.mesh, submesh: 0, first: fd.nm++, count: 1, ov: null });
    }
  }
  glr.upload(fd);
  glr.draw(items, { vp, cam: [0, 0, -10], time: spec.time || 0, half: false, pass: 1 });
  const px = new Uint8Array(spec.W * spec.H * 4);
  gl.readPixels(0, 0, spec.W, spec.H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return { px: [...px] };
}

/** One-texel texture of a colour (bytes). */
const tex1 = (c) => ({ w: 1, h: 1, data: c });
/** A unit quad mesh in z = 0 (Unity front face: clockwise on screen), normals −z. */
const QUAD_MESH = { positions: [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], normals: [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1], uv0: [0, 0, 1, 0, 1, 1, 0, 1], colors: null, submeshes: [[0, 2, 1, 0, 3, 2]] };
const px = (r, x, y) => r.px.slice((y * W + x) * 4, (y * W + x) * 4 + 4);
/** The background's colour at GL uv (u, v): (u, v, 0.5) as 8-bit, before filtering. */
const bgAt = (u, v) => [u * 255, v * 255];

let page = null, browser = null, srv = null;
async function setup(t) {
  if (page) return page;
  srv = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost').pathname;
    if (url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>dyn fx shaders</title>'); return; }
    const rel = url.startsWith('/shared/') ? url.slice(1) : `public${url}`;
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(`${ROOT}${path.sep}`) || !file.endsWith('.js')) { res.writeHead(404); res.end(); return; }
    try { res.setHeader('Content-Type', 'application/javascript'); res.end(readFileSync(file)); } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { default: puppeteer } = await import('puppeteer-core');
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: [...gpuArgs(), '--enable-unsafe-swiftshader'] });
  page = await browser.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (/\[fx\]/.test(m.text())) page.errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${srv.address().port}/`);
  await page.evaluate(`window.__render = ${pageRender.toString()}`);
  return page;
}
test.after(async () => { await browser?.close(); await new Promise((r) => (srv ? srv.close(r) : r())); });
const render = async (t, spec) => {
  const p = await setup(t);
  const r = await p.evaluate((s) => window.__render(s), { W, H, hw: HW, hh: HH, ...spec });
  assert.deepEqual(p.errors, []);
  return r;
};

const grabMat = (floats, extra = {}) => ({
  shader: 'Torappu/Particles-L2D/Disturb/Disturb GrabPass', keywords: [], queue: 3000,
  passes: [{ blend: ['One', 'Zero', 'One', 'Zero'], blendOp: 'Add', zTest: 'Disabled', zWrite: false, cull: 'Off', colorMask: 15 },
    { blend: ['One', 'Zero', 'One', 'Zero'], blendOp: 'Add', zTest: 'Disabled', zWrite: false, cull: 'Back', colorMask: 15 }],
  floats: { _Mask: 0, _ShowMask: 0, _ShowNoise: 0, _PolarCoord: 0, _PolarRadius: 1, _MaskIntensity: 1, _DisturbInvert: 0, ...floats },
  colors: { _NoiseSpeed: [0, 0, 0, 0], _MaskSpeed: [0, 0, 0, 0], _DisturbDir: [0, 0, 0, 0], _DisturbCenter: [0, 0, 0, 0], _DisturbDirUV: [0, 0, 0, 0], _DisturbCenterUV: [0.5, 0.5, 0, 0], _ParticleSystemPositionWS: [0, 0, 0, 0], ...(extra.colors || {}) },
  textures: { _DisturTex: { tex: 'white', st: [1, 1, 0, 0] }, _MaskTex: { tex: null, st: [1, 1, 0, 0], default: 'black' } },
  ...extra.top,
});

test('Disturb GrabPass: the picture under it, moved by each direction mode and the custom data', {
  skip: !enabled && 'set RENDER_E2E=1 (needs Chrome)', timeout: 120000,
}, async (t) => {
  const textures = { white: tex1([255, 255, 255, 255]) };
  const meshes = { quad: QUAD_MESH };
  // the grab step at the centre pixel, measured on the linear background (u, v) → (r, g)
  const step = (r) => { const c = px(r, 32, 32); return [(c[0] - (32.5 / W) * 255) / 255, (c[1] - (32.5 / H) * 255) / 255]; };
  const near = (a, e, msg) => { assert.ok(Math.abs(a[0] - e[0]) < 2.5 / 255 && Math.abs(a[1] - e[1]) < 2.5 / 255, `${msg}: got ${a.map((x) => x.toFixed(4))}, want ${e.map((x) => x.toFixed(4))}`); };
  // 3 Directional_UV: −_DisturbDirUV × 0.1 × _Intensity in the client's top-down screen uv
  let r = await render(t, { textures, meshes, items: [{ kind: 'mesh', mesh: 'quad', inst: { m: [3, 0, 0, 0, 3, 0, 0, 0, 1] }, mat: grabMat({ _DirMode: 3, _Intensity: 0.5 }, { colors: { _DisturbDirUV: [0.6, 0.4, 0, 0] } }) }] });
  near(step(r), [-0.6 * 0.1 * 0.5, 0.4 * 0.1 * 0.5], 'Directional_UV');
  // 1 Directional (object space): the screen step of _DisturbDir through the renderer's transform (scale 3 → ×3)
  r = await render(t, { textures, meshes, items: [{ kind: 'mesh', mesh: 'quad', inst: { m: [3, 0, 0, 0, 3, 0, 0, 0, 1] }, mat: grabMat({ _DirMode: 1, _Intensity: 0.5 }, { colors: { _DisturbDir: [0.04, -0.03, 0, 0] } }) }] });
  near(step(r), [0.5 * (3 * 0.04) / (2 * HW), 0.5 * (3 * -0.03) / (2 * HH)], 'Directional (object space)');
  // the same material on a particle mesh: Unity hands it world-space vertices, so _DisturbDir is not scaled
  r = await render(t, { textures, meshes, items: [{ kind: 'mesh', part: 'ps', mesh: 'quad', inst: { m: [3, 0, 0, 0, 3, 0, 0, 0, 1] }, mat: grabMat({ _DirMode: 1, _Intensity: 0.5 }, { colors: { _DisturbDir: [0.04, -0.03, 0, 0] } }) }] });
  near(step(r), [0.5 * 0.04 / (2 * HW), 0.5 * -0.03 / (2 * HH)], 'Directional (particle: world space)');
  // 2 Center: one unit away from _DisturbCenter (far to the left: every vertex moves +x), through the transform
  r = await render(t, { textures, meshes, items: [{ kind: 'mesh', mesh: 'quad', inst: { m: [3, 0, 0, 0, 3, 0, 0, 0, 1] }, mat: grabMat({ _DirMode: 2, _Intensity: 0.2 }, { colors: { _DisturbCenter: [-40, 0, 0, 0] } }) }] });
  near(step(r), [0.2 * 3 / (2 * HW), 0], 'Center (object space)');
  // _CUSTOMDATA_ON: TEXCOORD1.zw scale the step (particle custom streams)
  const cd = grabMat({ _DirMode: 3, _Intensity: 0.5, _CUSTOMDATA: 1 }, { colors: { _DisturbDirUV: [0.6, 0.4, 0, 0] }, top: { keywords: ['_CUSTOMDATA_ON'] } });
  r = await render(t, { textures, meshes, items: [{ kind: 'quad', inst: { ax: [3, 0, 0], ay: [0, -3, 0], t1: [0, 0, 0.5, 2] }, mat: cd }] });
  near(step(r), [-0.6 * 0.1 * 0.5 * 0.5, 0.4 * 0.1 * 0.5 * 2], 'custom data scale');
});

test('Ram/VertexDisturb(CustomData): vertices move in the shader\'s object space by the disturb texture × weight × intensity', {
  skip: !enabled && 'set RENDER_E2E=1 (needs Chrome)', timeout: 120000,
}, async (t) => {
  const textures = { white: tex1([255, 255, 255, 255]), vd: tex1([191, 128, 128, 255]) };
  const meshes = { quad: QUAD_MESH };
  const mat = {
    shader: 'Torappu/Particles-L2D/Ram/VertexDisturb(CustomData)', keywords: [], queue: 3000,
    passes: [{ blend: ['SrcAlpha', 'OneMinusSrcAlpha', 'Zero', 'OneMinusSrcAlpha'], blendOp: 'Add', zTest: 'Disabled', zWrite: false, cull: 'Off', colorMask: 15 }],
    floats: { _Opacity: 1, _PremultiplyAlpha: 5, _Amount: 0, _BorderWidth: 0.1, _IntensityU: 0, _IntensityV: 0, _NormalDisturb: 0, _NormalDisturbIntensity: 0, _VertexDisturbUSpeed: 0, _VertexDisturbVSpeed: 0 },
    colors: { _MainColor: [1, 0, 0, 1], _VertexDisturbIntensity: [0.8, 0, 0, 0] },
    textures: { _MainTex: { tex: 'white', st: [1, 1, 0, 0] }, _RamTex: { tex: 'white', st: [1, 1, 0, 0] }, _VertexDisturbTex: { tex: 'vd', st: [1, 1, 0, 0] },
      _VertexDisturbWeightTex: { tex: 'white', st: [1, 1, 0, 0] } },
  };
  // the quad's left edge on the middle row: the first pixel the red draw covers (background b = 0.5)
  const left = (r) => { for (let x = 0; x < W; x++) if (px(r, x, 32)[2] < 20) return x; return -1; };
  const shift = 0.8 * (191 / 255 - 0.5);   // object-space x offset
  const edgePx = (xw) => Math.ceil((xw / HW * 0.5 + 0.5) * W - 0.5);
  // MeshRenderer (scale 2): the offset is in mesh space, so it is scaled with the mesh
  let r = await render(t, { textures, meshes, items: [{ kind: 'mesh', mesh: 'quad', inst: { m: [2, 0, 0, 0, 2, 0, 0, 0, 1] }, mat }] });
  assert.equal(left(r), edgePx(-1 + 2 * shift), 'renderer: mesh-space displacement');
  // particle mesh: Unity's particle vertices are world space, so the same offset is not scaled
  r = await render(t, { textures, meshes, items: [{ kind: 'mesh', part: 'ps', mesh: 'quad', inst: { m: [2, 0, 0, 0, 2, 0, 0, 0, 1] }, mat }] });
  assert.equal(left(r), edgePx(-1 + shift), 'particle: world-space displacement');
  // no weight, no displacement
  r = await render(t, { textures: { ...textures, black: tex1([0, 0, 0, 255]) }, meshes, items: [{ kind: 'mesh', mesh: 'quad', inst: { m: [2, 0, 0, 0, 2, 0, 0, 0, 1] },
    mat: { ...mat, textures: { ...mat.textures, _VertexDisturbWeightTex: { tex: 'black', st: [1, 1, 0, 0] } } } }] });
  assert.equal(left(r), edgePx(-1), 'weight 0');
});

test('3D/MatCapTransparent: fresnel blend to the matcap and highlight from the view-space normal (inverse transpose)', {
  skip: !enabled && 'set RENDER_E2E=1 (needs Chrome)', timeout: 120000,
}, async (t) => {
  const textures = { main: tex1([200, 100, 50, 255]), cap: tex1([0, 255, 0, 255]), hl: tex1([128, 0, 0, 255]), white: tex1([255, 255, 255, 255]) };
  // a quad whose normals all lean (0, −0.6, −0.8): toward the camera (−z) and down
  const tilted = { ...QUAD_MESH, normals: [0, -0.6, -0.8, 0, -0.6, -0.8, 0, -0.6, -0.8, 0, -0.6, -0.8] };
  const mat = {
    shader: 'Torappu/Particles-L2D/3D/MatCapTransparent', keywords: [], queue: 3000,
    passes: [{ blend: ['SrcAlpha', 'OneMinusSrcAlpha', 'Zero', 'OneMinusSrcAlpha'], blendOp: 'Add', zTest: 'Disabled', zWrite: false, cull: 'Back', colorMask: 15 }],
    floats: { _Amount: 0, _BorderWidth: 0.1, _HighLightStrength: 0.5, _FresnelPow: 1 },
    colors: { _Color: [1, 1, 1, 1], _CtrlParams: [0, 0.4, 0, 1] },
    textures: { _MainTex: { tex: 'main', st: [1, 1, 0, 0] }, _DissolveTex: { tex: 'white', st: [1, 1, 0, 0] }, _MatCap: { tex: 'cap', st: [1, 1, 0, 0] }, _MatCapHighLight: { tex: 'hl', st: [1, 1, 0, 0] } },
  };
  const smooth = (x) => { const s = Math.min(1, Math.max(0, x)); return s * s * (3 - 2 * s); };
  const expect = (nz) => {
    const f = smooth((1 - nz) / 0.4), h = smooth(128 / 255) * 0.5;
    return [200, 100, 50].map((b, i) => { const c = b / 255 + f * ([0, 1, 0][i] - b / 255); return (c + h * (1 - c)) * 255; });
  };
  const check = (r, nz, msg) => { const c = px(r, 32, 32); const e = expect(nz); assert.ok(e.every((v, i) => Math.abs(v - c[i]) <= 2), `${msg}: got ${c.slice(0, 3)}, want ${e.map(Math.round)}`); };
  let r = await render(t, { textures, meshes: { q: tilted }, items: [{ kind: 'mesh', mesh: 'q', inst: { m: [3, 0, 0, 0, 3, 0, 0, 0, 3] }, mat }] });
  check(r, 0.8, 'view normal z 0.8');
  // a MeshRenderer stretched 3× more in y: its normal goes through the inverse transpose → (0, −0.6 / 9, −0.8 / 3)
  r = await render(t, { textures, meshes: { q: tilted }, items: [{ kind: 'mesh', mesh: 'q', inst: { m: [3, 0, 0, 0, 9, 0, 0, 0, 3] }, mat }] });
  check(r, (0.8 / 3) / Math.hypot(0.6 / 9, 0.8 / 3), 'inverse transpose');
});

/** A UV sphere (radius r, clockwise seen from outside = Unity front faces). */
function sphere(r = 0.7, n = 24) {
  const P = [], N = [], U = [], I = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const th = (i / n) * 2 * Math.PI, ph = (j / n) * Math.PI;
    const x = Math.sin(ph) * Math.cos(th), y = -Math.cos(ph), z = Math.sin(ph) * Math.sin(th);
    P.push(r * x, r * y, r * z); N.push(x, y, z); U.push(i / n, j / n);
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1; I.push(a, c, b, b, c, d); }
  return { positions: P, normals: N, uv0: U, colors: null, submeshes: [I] };
}

test('Unlit-Outline: the main pass, and the shell pass pushed out along the projected normal (with or without depth)', {
  skip: !enabled && 'set RENDER_E2E=1 (needs Chrome)', timeout: 120000,
}, async (t) => {
  const textures = { main: tex1([255, 128, 64, 255]) };
  const pz = { blend: ['SrcAlpha', 'OneMinusSrcAlpha', 'Zero', 'OneMinusSrcAlpha'], blendOp: 'Add', zTest: 'LessEqual', zWrite: true, colorMask: 15 };
  const mat = {
    shader: 'Torappu/Particles-L2D/Unlit-Outline', keywords: [], queue: 3000, passes: [{ ...pz, cull: 'Back' }, { ...pz, cull: 'Front' }],
    floats: { _Outline_Width: 300, _Outline_Depth_Offset: 0, _Alpha: 1 },
    colors: { _TintColor: [0.5, 0.5, 0.5, 0.5], _Outline_Color: [0, 0, 1, 1] },
    textures: { _MainTex: { tex: 'main', st: [1, 1, 0, 0] } },
  };
  // silhouette radius 0.7 / 2 × 32 = 11.2 px from the centre; the shell reaches 0.0003 × 300 × 32 = 2.9 px further
  for (const depth of [true, false]) {
    const r = await render(t, { depth, textures, meshes: { s: sphere() }, items: [{ kind: 'mesh', mesh: 's', mat }] });
    assert.deepEqual(px(r, 32, 32).slice(0, 3), [255, 128, 64], `main pass at the centre (depth ${depth})`);
    assert.deepEqual(px(r, 32 + 13, 32).slice(0, 3), [0, 0, 255], `shell just outside the silhouette (depth ${depth})`);
    assert.notDeepEqual(px(r, 32 + 16, 32).slice(0, 3), [0, 0, 255], `background beyond the shell (depth ${depth})`);
  }
});

test('3D/Toon: emission + ambient + Lambert + saturated Blinn-Phong, the Custom sun given in view space', {
  skip: !enabled && 'set RENDER_E2E=1 (needs Chrome)', timeout: 120000,
}, async (t) => {
  const textures = { main: tex1([100, 150, 200, 255]), white: tex1([255, 255, 255, 255]) };
  const mat = (sun) => ({
    shader: 'Torappu/Particles-L2D/3D/Toon', keywords: ['_SUNMODE_CUSTOM'], queue: 2000,
    passes: [{ blend: ['One', 'Zero', 'Zero', 'OneMinusSrcAlpha'], blendOp: 'Add', zTest: 'LessEqual', zWrite: true, cull: 'Back', colorMask: 15 }],
    floats: { _SunMode: 1, _Ambient: 0.2, _Diffuse: 1, _Shininess: 5.8, _Specular: 0.5 },
    colors: { _SunDir: sun, _LightColor: [1, 0.5, 0.25, 1], _Color: [1, 1, 1, 1], _EmissionColor: [0.05, 0.05, 0.05, 1], _SpecColor: [0.2, 0.2, 0.2, 1] },
    textures: { _MainTex: { tex: 'main', st: [1, 1, 0, 0] }, _EmissionMap: { tex: 'white', st: [1, 1, 0, 0] } },
  });
  const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const expect = (sun) => {
    const n = [0, 0, -1];
    const s = norm(sun.slice(0, 3)), l = [s[0], s[1], -s[2]];          // view → world: the view flips z
    const p = [((32.5 / W) * 2 - 1) * HW, ((32.5 / H) * 2 - 1) * HH, 0];   // the centre pixel's point; camera (0, 0, −10)
    const v = norm([-p[0], -p[1], -10 - p[2]]);
    const h = norm([l[0] + v[0], l[1] + v[1], l[2] + v[2]]);
    const df = Math.max(0, Math.min(1, dot(n, l))), sp = Math.max(0, Math.min(1, dot(h, n)));
    const tc = [100, 150, 200].map((x) => x / 255), lc = [1, 0.5, 0.25];
    return tc.map((x, i) => 255 * (0.05 + 0.2 * x + df * x * lc[i] * sun[3] + Math.min(1, sp ** 5.8 * 0.2 * lc[i] * 0.5)));
  };
  for (const sun of [[0, 0, 1, 0.5], [0.6, 0, 0.8, 0.5]]) {
    const r = await render(t, { textures, meshes: { quad: QUAD_MESH }, items: [{ kind: 'mesh', mesh: 'quad', inst: { m: [3, 0, 0, 0, 3, 0, 0, 0, 3] }, mat: mat(sun) }] });
    const c = px(r, 32, 32), e = expect(sun);
    assert.ok(e.every((x, i) => Math.abs(x - c[i]) <= 2), `sun ${sun}: got ${c.slice(0, 3)}, want ${e.map(Math.round)}`);
  }
});
