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
