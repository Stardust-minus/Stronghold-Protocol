// The official 动态立绘 scenes played live (ui/dynFx.js, 2026-11-17): a scene file loads and compiles once per URL (the
// last SCENE_CACHE unused ones kept); preload puts its textures and meshes on a renderer's GPU, counted per renderer, and
// says no — the baked placeholder stays — when anything failed; destroying the last scene that uses a texture deletes it
// (a closed view keeps nothing on the GPU: the trial leaked them); a released or restored context is handled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScene, DynScene, dynFxGpu, releaseRenderer, fxContext, SCENE_CACHE, dynFxEnabled, sceneUrlOf } from '../../public/js/ui/dynFx.js';

const T = { pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1] };
const MESH = { format: 'fx-mesh', version: 2, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], uv0: [0, 0, 1, 0, 0, 1], submeshes: [[0, 1, 2]] };
const files = new Map();
function scene(name, textures) {
  const desc = {
    format: 'fx-prefab', version: 1, key: `dyn_illust_${name}`,
    nodes: [
      { id: 0, name: 'root', parent: null, children: [1], active: true, ...T, behaviours: [{ class: 'DynIllust', fields: { _cameraSize: 10, _particles: [] } }] },
      { id: 1, name: 'layer', parent: 0, children: [], active: true, ...T, meshRenderer: { m_Enabled: true, materials: [0] } },
    ],
    materials: [{ name: 'm', shader: 'Torappu/Particles-L2D/AlphaBlend', passes: [{ blend: ['SrcAlpha', 'OneMinusSrcAlpha', 'Zero', 'OneMinusSrcAlpha'] }], queue: 'Transparent',
      floats: {}, colors: {}, textures: { _MainTex: { tex: textures[0], st: [1, 1, 0, 0] } } }],
    clips: [], textures, meshes: [`mesh_${name}`], dyn: { illust: { cameraSize: 10 }, spine: { scale: 0.01 }, animatorStates: {} },
  };
  const file = { format: 'dyn-scene', version: 1, key: desc.key, prefab: desc,
    textures: Object.fromEntries(textures.map((k) => [k, { path: `/assets/local/dynfx/tex/${k}.webp`, w: 2, h: 2, wrapU: 'repeat', wrapV: 'repeat', filter: 'bilinear', mips: 1 }])),
    meshes: { [`mesh_${name}`]: `/assets/local/dynfx/mesh/${name}.json` } };
  files.set(`/assets/local/dynfx/scene/${name}.json`, JSON.stringify(file));
  files.set(`/assets/local/dynfx/mesh/${name}.json`, JSON.stringify(MESH));
  for (const k of textures) if (!k.startsWith('missing')) files.set(`/assets/local/dynfx/tex/${k}.webp`, 'webp');
  return `/assets/local/dynfx/scene/${name}.json`;
}
globalThis.fetch = async (url) => {
  const body = files.get(String(url));
  return body == null ? new Response('no', { status: 404 }) : new Response(body, { status: 200, headers: { 'content-type': /\.json$/.test(url) ? 'application/json' : 'image/webp' } });
};
const bitmaps = [];
globalThis.createImageBitmap = async () => { const b = { width: 2, height: 2, closed: false, close() { this.closed = true; } }; bitmaps.push(b); return b; };

/** A WebGL2 context where every call succeeds; deleted textures are recorded. */
function fakeGl() {
  const deleted = [];
  let n = 0;
  const gl = new Proxy({ deleted }, {
    get(target, name) {
      if (typeof name !== 'string') return undefined;
      if (name in target) return target[name];
      if (name === 'getContextAttributes') return () => ({ depth: true });
      if (name === 'deleteTexture') return (t) => { if (t) deleted.push(t); };
      if (/^create/.test(name)) return () => ({ id: ++n, kind: name });
      if (/^[A-Z0-9_]+$/.test(name)) return 1;
      return (target[name] ??= () => ({}));
    },
  });
  return gl;
}
let uid = 0;
const renderer = () => ({ gl: fakeGl(), CONTEXT_UID: ++uid, context: { webGLVersion: 2 }, batch: { flush() {} } });
class Container { constructor() { this.children = []; } addChild(c) { this.children.push(c); } destroy() { this.destroyed = true; } }
const P = { Container };
const spine = () => ({ skeleton: { findBone: () => null }, children: [], renderable: true, state: { tracks: [] } });

test('on by default (no ?dynfx=1 any more); a record names its scene file, nothing else counts as one', () => {
  assert.equal(dynFxEnabled(), true);
  assert.equal(sceneUrlOf({ scene: '/assets/~0123456789abcdef/local/dynfx/scene/x.json' }), '/assets/~0123456789abcdef/local/dynfx/scene/x.json');
  assert.equal(sceneUrlOf({ scene: 'https://x/y.json' }), null);
  assert.equal(sceneUrlOf({}), null);
});

test('two scenes on one renderer: a shared texture is uploaded once and deleted with the last scene that uses it', async () => {
  const r = renderer();
  const a = await loadScene(scene('a', ['ta', 'shared']));
  const b = await loadScene(scene('b', ['tb', 'shared']));
  assert.ok(a && b);
  assert.equal(await loadScene({ scene: a.url }), a, 'compiled once per URL');
  const sa = new DynScene(P, a, spine()), sb = new DynScene(P, b, spine());
  assert.equal(await sa.preload(r), true);
  assert.equal(await sb.preload(r), true);
  assert.equal(dynFxGpu.textures, 3);
  assert.equal(dynFxGpu.meshes, 2);
  assert.equal(dynFxGpu.scenes, 2);
  assert.ok(bitmaps.every((x) => x.closed), 'a decoded image is let go once on the GPU');
  const sp = spine(), box = new Container();
  sa.spine = sp; sa.mount(box);
  assert.deepEqual([box.children.length, sp.renderable], [1, false], 'mounted: the scene draws the Spine\'s slots');
  fxContext(r).glr.grabTex = { id: 'grab' };
  sa.destroy();
  assert.equal(sp.renderable, true);
  assert.equal(dynFxGpu.textures, 2, 'ta went; shared stays for b');
  assert.equal(dynFxGpu.grabs, 1, 'a scene left: the GrabPass copy stays');
  sb.destroy();
  assert.deepEqual([dynFxGpu.textures, dynFxGpu.meshes, dynFxGpu.scenes, dynFxGpu.texBytes, dynFxGpu.grabs], [0, 0, 0, 0, 0], 'nothing left on the GPU');
  assert.equal(r.gl.deleted.length, 4, 'ta, tb, shared and the GrabPass copy deleted');
  sb.destroy();
  assert.equal(r.gl.deleted.length, 4, 'destroy twice: nothing more');
  releaseRenderer(r);
});

test('a texture that fails: preload says no (the placeholder stays), and gives its counts back on destroy', async () => {
  const r = renderer();
  const s = await loadScene(scene('c', ['tc', 'missing_c']));
  const d = new DynScene(P, s, spine());
  const warn = console.warn; const said = []; console.warn = (...a) => said.push(a.join(' '));
  try { assert.equal(await d.preload(r), false); } finally { console.warn = warn; }
  assert.ok(said.some((m) => /incomplete/.test(m)));
  d.destroy();
  assert.deepEqual([dynFxGpu.textures, dynFxGpu.scenes], [0, 0]);
  releaseRenderer(r);
  assert.equal(await loadScene(scene('nofile', ['x']).replace('nofile', 'gone')), null, 'a scene file that does not load: null');
});

test('a renderer released while a scene loads gets no new FxGL; a restored context takes the counts over', async () => {
  const r = renderer();
  const s = await loadScene(scene('d', ['td']));
  const d = new DynScene(P, s, spine());
  const p = d.preload(r);
  releaseRenderer(r);
  assert.equal(await p, false);
  assert.equal(dynFxGpu.renderers, 0, 'not rebuilt for a released renderer');
  d.destroy();
  const r2 = renderer();
  const e = new DynScene(P, s, spine());
  assert.equal(await e.preload(r2), true);
  const old = fxContext(r2);
  r2.CONTEXT_UID = ++uid;                       // a lost context restored: Pixi keeps the object, a new UID
  const now = fxContext(r2);
  assert.notEqual(now, old);
  assert.equal(now.tex.get('td'), 1, 'the counts moved to the new context');
  await now.texLib.loadTexture('td', false);    // drawn again on the new context
  now.glr.texture('td', false);
  assert.equal(now.glr.textures.size, 1);
  e.destroy();
  assert.equal(now.glr.textures.size, 0, 'released on the context it is on now');
  releaseRenderer(r2);
});

test(`compiled scenes: the last ${SCENE_CACHE} unused are kept, older ones dropped with their mesh data`, async () => {
  const before = dynFxGpu.cached;
  const urls = [];
  for (let i = 0; i < SCENE_CACHE + 3; i++) urls.push(scene(`e${i}`, [`te${i}`]));
  const r = renderer();
  for (const u of urls) { const s = new DynScene(P, await loadScene(u), spine()); await s.preload(r); s.destroy(); }
  assert.ok(dynFxGpu.cached <= SCENE_CACHE, `${dynFxGpu.cached} kept (${before} before)`);
  assert.equal(dynFxGpu.textures, 0);
  releaseRenderer(r);
});

/** A scene of layers (nodes 1…) under the root, each { name, pos, rot?, order, follower? }: a material each, one mesh. */
function layered(name, layers) {
  const nodes = [{ id: 0, name: 'root', parent: null, children: layers.map((_, i) => i + 1), active: true, ...T,
    behaviours: [{ class: 'DynIllust', fields: { _cameraSize: 10, _particles: [] } }] }];
  layers.forEach((l, i) => nodes.push({ id: i + 1, name: l.name, parent: 0, children: [], active: true, ...T, pos: l.pos, rot: l.rot || [0, 0, 0, 1],
    meshFilter: { mesh: `mesh_${name}` }, meshRenderer: { m_Enabled: true, materials: [i], m_SortingOrder: l.order || 0 },
    behaviours: l.follower ? [{ class: 'BoneFollower', enabled: true, fields: { boneName: l.follower, followXYPosition: 1, followZPosition: 1, followBoneRotation: 1, followSkeletonFlip: 1, followLocalScale: 1 } }] : [] }));
  const url = scene(name, [`t_${name}`]);
  const file = JSON.parse(files.get(url));
  file.prefab.nodes = nodes;
  file.prefab.materials = layers.map((l) => ({ ...file.prefab.materials[0], name: l.name }));   // one each: no merged draws
  files.set(url, JSON.stringify(file));
  return url;
}

test('a BoneFollower turns with its bone: pixi-spine keeps the world 2×2 in a PIXI Matrix (the trial read bone.a/c: NaN, the subtree vanished)', async () => {
  const s = await loadScene(layered('fol', [{ name: 'fire', pos: [4, 12, 0], follower: 'BG_Fire' }]));
  // the bone at 30° in Unity's y-up world: Spine (a, b | c, d) = (cos, −sin | sin, cos); pixi-spine y-down stores
  // matrix.a = a, matrix.c = Spine b, matrix.b = −Spine c, matrix.d = −d
  const th = Math.PI / 6;
  const bone = { worldX: 400, worldY: -1200, scaleX: 1, scaleY: 1, matrix: { a: Math.cos(th), c: -Math.sin(th), b: -Math.sin(th), d: -Math.cos(th), tx: 400, ty: -1200 } };
  const sp = { ...spine(), skeleton: { scaleX: 1, scaleY: 1, findBone: (n) => (n === 'BG_Fire' ? bone : null) } };
  const d = new DynScene(P, s, sp);
  d.update(0);
  const L = d.fx.loc, o = 1 * 10;
  assert.deepEqual([L[o], L[o + 1]].map((v) => +v.toFixed(4)), [4, 12], 'at the bone (Unity units, y-up)');
  assert.ok([3, 4, 5, 6].every((k) => Number.isFinite(L[o + k])), 'a rotation, not NaN');
  assert.equal(+(2 * Math.atan2(L[o + 5], L[o + 6]) * 180 / Math.PI).toFixed(3), 30, 'turned by the bone\'s world angle');
  d.destroy();
});

test('layers sort by depth along the orthographic view; equal depth keeps the hierarchy order (not the distance off the axis)', async () => {
  // 陈 精二: the sky (nearest the camera's axis) and its clouds at one order and z — the sky first, the clouds over it
  const s = await loadScene(layered('sky', [{ name: 'sky', pos: [0.4, 9.4, 0], order: -3 }, { name: 'cloud', pos: [-2.7, 10.3, 0], order: -3 },
    { name: 'near', pos: [0, 9, -1], order: -3 }, { name: 'front', pos: [9, 9, 5], order: -2 }]));
  const r = renderer();
  r.projection = { projectionMatrix: { a: 0.01, b: 0, c: 0, d: -0.01, tx: -1, ty: 1 } };
  const sp = { ...spine(), worldTransform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 } };
  const d = new DynScene(P, s, sp);
  assert.equal(await d.preload(r), true);
  const glr = fxContext(r).glr, drawn = [];
  glr.upload = () => {};
  glr.draw = (run) => { for (const e of run) drawn.push(s.desc.nodes[e.node].name); };
  d.update(0);
  d.render(r);
  assert.deepEqual(drawn, ['sky', 'cloud', 'near', 'front']);
  d.destroy();
  releaseRenderer(r);
});

test('the root\'s scale (重岳 精二 0.9227) scales the skeleton and the layers alike: the frame, the followers and the projection take it', async () => {
  const url = layered('rootscale', [{ name: 'fire', pos: [4, 12, 0], follower: 'BG_Fire' }]);
  const file = JSON.parse(files.get(url));
  file.prefab.nodes[0].pos = [-0.3, -9.79, 6];
  file.prefab.nodes[0].scale = [0.5, 0.5, 1];
  files.set(url, JSON.stringify(file));
  const s = await loadScene(url);
  assert.deepEqual(s.rootScale, [0.5, 0.5, 1]);
  const bone = { worldX: 400, worldY: -1200, scaleX: 1, scaleY: 1, matrix: { a: 1, c: 0, b: 0, d: -1, tx: 400, ty: -1200 } };
  const sp = { ...spine(), skeleton: { scaleX: 1, scaleY: 1, findBone: (n) => (n === 'BG_Fire' ? bone : null) }, worldTransform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 } };
  const d = new DynScene(P, s, sp);
  // the camera square (half 10 Unity units at the world origin) in skeleton px: ÷ the root's scale, like the client's DynIllust
  assert.deepEqual(Object.values(d.frame).map((v) => +v.toFixed(3)), [(0.3 - 10) * 200, (9.79 - 10) * 200, 4000, 4000].map((v) => +v.toFixed(3)));
  d.update(0);
  const L = d.fx.loc, w = d.fx.world[1];
  assert.deepEqual([L[10], L[11]].map((v) => +v.toFixed(4)), [4, 12], 'the follower\'s local position: the bone in the root\'s frame');
  // its world (the root's scale kept) projects back onto the bone's pixel: the layer stays on the skeleton
  const m = d._vp({ projection: { projectionMatrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 } } });
  assert.deepEqual([m[0] * w[12] + m[4] * w[13] + m[12], m[1] * w[12] + m[5] * w[13] + m[13]].map((v) => +v.toFixed(3)), [400, -1200]);
  d.destroy();
});
