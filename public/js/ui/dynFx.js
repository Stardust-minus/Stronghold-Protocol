// public/js/ui/dynFx.js — the official 动态立绘 scene around the Spine (2026-11-17, the owner: the scenes of every 动态立绘
// play live like the official client's, at the highest quality — never stepped down for a device or for performance).
// The client's dyn illust prefab (arts/dynchars) is one scene: the Spine (split by Spine-Unity's SkeletonRenderSeparator
// into parts with their own sorting orders), the mesh layers and particle systems behind and in front of it, Animator
// clips, Torappu.Fx behaviours (FxUVTweener / FxUVRotation / FxDelay) and BoneFollowers that keep effects on bones — all
// shot by one orthographic camera (DynIllust `_cameraSize`, centred on the world origin, the root offset by its own
// position). tools/local-extract/dyn_scenes.py exports the prefab in the battle effects' format (DESIGN §33) plus `dyn`;
// tools/prepare-dynamic-scenes.mjs puts one scene file per record (`scene`: skins[id].dynamic, chars[id].dynamicE2) next
// to its pictures, the textures and meshes shared by every scene under /assets/dynfx/ (docs/ASSETS.md "Dynamic
// illustrations"). This module plays a scene with the battle effects' runtime (render/vfx: Effect, FxGL) in the prefab
// root's frame and draws it, sorted the Unity way (sorting layer, order, queue, camera depth) together with the Spine
// parts, inside the Pixi render.
//
//   dynFxEnabled()                    on, unless globalThis.__dynfx === false (a test / comparison switch, not a setting)
//   await loadScene(entry | url)      the compiled scene of a record (`scene`) or null; cached while a view plays it, and
//                                     the last SCENE_CACHE unused ones kept
//   const s = new DynScene(P, scene, spine)   one instance — nothing changes on screen yet
//   await s.preload(renderer)         its textures and meshes on that renderer's GPU; false: no WebGL2 (keep the bake)
//   s.mount(container)                the swap: s.view joins the container (it draws the Spine's slots between the scene's
//                                     layers), the Spine stops drawing itself
//   s.update(dt) after spine.update(dt); s.frame (the official camera square, skeleton px, y-up); s.destroy()
//   releaseRenderer(renderer)         a renderer going away (the 「查看立绘」 preview's): every FxGL resource of it freed
//
// GPU memory: a texture or mesh is on a renderer's GPU while a scene there uses it (counted per renderer); the last one
// destroyed deletes it, and with no scene left the GrabPass copy goes too (a closed view keeps nothing on the GPU).
//
// Idle only: the DynIllust `_particles` groups of the actions (1 special, 2 start, 3 interact) are switched off; the
// Animators it drives play their default (idle) state. [ASSUMED] An idle clip no longer than the Spine Idle restarts
// with every Idle loop (their lengths match the Idle's in the samples: 塔露拉 6.57–6.67 s against 6.667 s); a longer
// non-looping clip plays once and holds, a looping one loops on its own length.
import { FxLibrary } from '../render/vfx/library.js';
import { compileEffect, Effect } from '../render/vfx/effect.js';
import { FxGL } from '../render/vfx/gl.js';
import { FrameData } from '../render/vfx/geom.js';
import { resetPixi } from '../render/vfx/system.js';
import { sampleClip } from '../render/vfx/clips.js';
import { mat4InvertAffine, mat4Point, mat4Rotation, quatMul } from '../render/vfx/math.js';
import { fetchMaterial } from '../materialFallback.js';

/** The scene file format (tools/assets/dynamic-scenes.mjs). */
export const SCENE_FORMAT = 'dyn-scene';
/** Compiled scenes kept after their last view (reopening one of them loads nothing but its textures). */
export const SCENE_CACHE = 6;
/** The camera's distance behind the scene: Unity sorts an orthographic camera's transparents by depth along its view;
 * the battle runtime sorts by distance to a point, which from this far is that depth. */
const FAR = 1e4;
const env = () => globalThis;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function dynFxEnabled() {
  try { return env().__dynfx !== false; } catch { return true; }
}

/** The scene file URL of a record (or a URL itself), else null. */
export function sceneUrlOf(src) {
  const u = typeof src === 'string' ? src : src?.scene;
  return typeof u === 'string' && /^\/assets\/.+\.json$/.test(u) ? u : null;
}

/**
 * A scene file the runtime can play: { format: 'dyn-scene', version: 1, key, prefab: fx-prefab descriptor with `dyn`,
 * textures: { key: { path, w, h, wrapU?, wrapV?, filter?, mips? } }, meshes: { key: path } } — every texture and mesh
 * the prefab names listed with an /assets/ path.
 */
export function validSceneFile(f) {
  if (!isObj(f) || f.format !== SCENE_FORMAT || f.version !== 1 || typeof f.key !== 'string' || !isObj(f.prefab)) return false;
  const d = f.prefab, path = (p) => typeof p === 'string' && p.startsWith('/assets/');
  if (!Array.isArray(d.nodes) || !d.nodes.length || !isObj(f.textures) || !isObj(f.meshes)) return false;
  return (d.textures || []).every((k) => path(f.textures[k]?.path)) && (d.meshes || []).every((k) => k.startsWith('builtin:') || path(f.meshes[k]));
}

// Every scene's textures and meshes in one file list (keys are content-addressed: the same key is the same file).
const shared = { groups: { fx: {}, 'fx/prefabs': {}, 'fx/tex': {}, 'fx/mesh': {} }, infos: {} };
function register(file) {
  for (const [k, t] of Object.entries(file.textures)) {
    shared.groups['fx/tex'][k] = { path: t.path, w: t.w, h: t.h };
    shared.infos[k] = { wrapU: t.wrapU, wrapV: t.wrapV, filter: t.filter, mips: t.mips };
  }
  for (const [k, p] of Object.entries(file.meshes)) shared.groups['fx/mesh'][k] = { path: p };
}

/** The effects library over the scenes' files, loading through the public-material failover (materialFallback.js). */
class SceneLibrary extends FxLibrary {
  constructor() { super({ list: { groups: shared.groups }, layers: null }); }
  texInfo() { return Promise.resolve(shared.infos); }
  async _json(url) { return url ? fetchMaterial(url, (r) => r.json()) : null; }
  async _image(url) {
    const blob = await fetchMaterial(url, (r) => r.blob());
    if (typeof createImageBitmap === 'function') {
      return { image: await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' }), flipped: true };
    }
    if (typeof Image === 'undefined' || typeof URL?.createObjectURL !== 'function') return null;
    const src = URL.createObjectURL(blob);
    try {
      const image = await new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = () => reject(new Error(`dynfx image ${url}`)); im.src = src; });
      return { image, flipped: false };
    } finally { URL.revokeObjectURL(src); }
  }
}

let mainLib = null;
/** The library of descriptors and mesh data (CPU, shared by every renderer). */
const lib = () => mainLib || (mainLib = new SceneLibrary());

const scenes = new Map();   // url → { promise, users, used, meshes }
let clock = 0;

/** Load and compile a record's scene once (null when it has none or it fails). */
export function loadScene(src) {
  const url = sceneUrlOf(src);
  if (!url) return Promise.resolve(null);
  let r = scenes.get(url);
  if (!r) {
    r = { url, users: 0, used: 0, meshes: [], promise: null };
    r.promise = (async () => {
      const L = lib();
      await L.init();
      const file = await fetchMaterial(url, (res) => res.json());
      if (!validSceneFile(file)) throw new Error('not a scene file');
      register(file);
      const desc = file.prefab;
      const info = prepareScene(desc);
      r.meshes = (desc.meshes || []).filter((k) => !k.startsWith('builtin:'));
      await Promise.all((desc.meshes || []).map((m) => L.loadMesh(m)));
      return { url, key: file.key, desc, def: compileEffect(desc, L), textures: [...new Set(desc.textures || [])], meshes: [...new Set(desc.meshes || [])], ...info };
    })().catch((e) => {
      if (scenes.get(url) === r) scenes.delete(url);
      console.warn('[dynfx] scene failed', url, e?.message || e);
      return null;
    });
    scenes.set(url, r);
  }
  r.used = ++clock;
  return r.promise;
}

function retainScene(url) { const r = scenes.get(url); if (r) { r.users++; r.used = ++clock; } }
function releaseScene(url) {
  const r = scenes.get(url);
  if (r) { r.users = Math.max(0, r.users - 1); r.used = ++clock; }
  const idle = [...scenes.values()].filter((x) => x.users === 0).sort((a, b) => b.used - a.used);
  for (const x of idle.slice(SCENE_CACHE)) {
    scenes.delete(x.url);
    const keep = new Set();
    for (const y of scenes.values()) for (const k of y.meshes) keep.add(k);
    const L = lib();
    for (const k of x.meshes) if (!keep.has(k)) { L.meshes.delete(k); L.meshLoads.delete(k); }
  }
}

const contexts = new WeakMap();
const allContexts = new Set();
/** One FxGL (and texture library: a decoded image is let go once on the GPU) per Pixi renderer, with its use counts. */
export function fxContext(renderer) {
  let c = contexts.get(renderer);
  if (c && c.uid === renderer.CONTEXT_UID) return c;
  if (!renderer?.gl || renderer.context?.webGLVersion !== 2) return null;
  const old = c;
  const texLib = new SceneLibrary();
  const glLib = { texture: (k, h) => texLib.texture(k, h), mesh: (k) => lib().mesh(k), release: (k, h) => texLib.release(k, h), forgetGpu: () => texLib.forgetGpu() };
  // a restored context: the scenes still playing keep their counts (their textures load again on the new one)
  c = { glr: new FxGL(renderer.gl, glLib), texLib, uid: renderer.CONTEXT_UID, pass: 1,
    tex: old ? old.tex : new Map(), mesh: old ? old.mesh : new Map(), scenes: old ? old.scenes : 0 };
  if (old) { old.texLib.dropImages(); allContexts.delete(old); }
  contexts.set(renderer, c); allContexts.add(c);
  return c;
}

const bump = (m, k, d) => { const n = (m.get(k) || 0) + d; if (n > 0) m.set(k, n); else m.delete(k); return n; };

/** A scene's textures and meshes counted on a context. */
function acquireGpu(c, s) {
  c.scenes++;
  for (const k of s.textures) bump(c.tex, k, 1);
  for (const k of s.meshes) bump(c.mesh, k, 1);
}

/** The counts given back; what no scene there uses any more is deleted from the GPU (and a decode in flight let go). */
function releaseGpu(c, s) {
  c.scenes = Math.max(0, c.scenes - 1);
  const glr = c.glr, gl = glr.gl, L = c.texLib;
  for (const k of s.textures) {
    if (bump(c.tex, k, -1) > 0) continue;
    const id = `${k}|0`, t = glr.textures.get(id);
    if (t) { gl.deleteTexture(t.tex); glr.textures.delete(id); glr.stats.textures--; glr.stats.texBytes -= t.bytes; }
    L.onGpu.delete(id);
    L.images.get(id)?.image?.close?.(); L.images.delete(id);
    const p = L.imageLoads.get(id);
    L.imageLoads.delete(id);
    p?.then(() => { if (!c.tex.has(k)) { L.images.get(id)?.image?.close?.(); L.images.delete(id); } });
  }
  for (const k of s.meshes) {
    if (bump(c.mesh, k, -1) > 0) continue;
    const m = glr.meshes.get(k);
    if (m) { gl.deleteVertexArray(m.vao); gl.deleteBuffer(m.vbo); gl.deleteBuffer(m.ibo); }
    glr.meshes.delete(k);
  }
  if (c.scenes === 0 && glr.grabTex) { gl.deleteTexture(glr.grabTex); glr.grabTex = null; glr.grabW = 0; glr.grabH = 0; }
}

/** A renderer going away: its FxGL (textures, meshes, programs, buffers) and decoded images freed. */
export function releaseRenderer(renderer) {
  const c = renderer ? contexts.get(renderer) : null;
  if (!c) return;
  contexts.delete(renderer); allContexts.delete(c);
  try {
    const gl = c.glr.gl;
    if (c.glr.grabTex) gl.deleteTexture(c.glr.grabTex);
    c.glr.grabTex = null;
    c.glr.destroy();
  } catch { /* a lost context: gone with it */ }
  c.texLib.dropImages();
  c.tex.clear(); c.mesh.clear(); c.scenes = 0;
}

/** Test hooks: the GPU side of every renderer's scenes, and the compiled scenes kept. */
export const dynFxGpu = Object.freeze({
  get scenes() { let n = 0; for (const c of allContexts) n += c.scenes; return n; },
  get textures() { let n = 0; for (const c of allContexts) n += c.glr.textures.size; return n; },
  get texBytes() { let n = 0; for (const c of allContexts) n += c.glr.stats.texBytes; return n; },
  get meshes() { let n = 0; for (const c of allContexts) for (const m of c.glr.meshes.values()) if (m) n++; return n; },
  get grabs() { let n = 0; for (const c of allContexts) if (c.glr.grabTex) n++; return n; },
  get renderers() { return allContexts.size; },
  get cached() { return scenes.size; },
});

function byUnityOrder(a, b) {
  return (a.layer - b.layer) || (a.order - b.order) || (a.queue - b.queue) || (b.dist - a.dist) || (a.seq - b.seq);
}

const live = new Set();
/** Test hooks: the mounted scenes. */
export const dynFxScenes = live;

/** The scene's idle set, Animator drive list, bone followers and Spine parts (mutates the descriptor before compiling). */
export function prepareScene(desc) {
  const N = desc.nodes || [], dyn = desc.dyn || {}, root = N[0] || {};
  const beh = (cls) => (root.behaviours || []).find((b) => b.class === cls);
  const il = beh('DynIllust')?.fields || {};
  const hidden = [];
  for (const p of il._particles || []) {
    const n = p?.particle?.node;
    if (n != null && p.action !== 0 && N[n]) { N[n].active = false; hidden.push(n); }
  }
  const off = new Uint8Array(N.length);
  for (let i = 0; i < N.length; i++) { const p = N[i].parent; off[i] = hidden.includes(i) || (p != null && off[p]) ? 1 : 0; }
  const drive = [];
  for (const [nid, st] of Object.entries(dyn.animatorStates || {})) {
    const i = Number(nid), n = N[i];
    if (!n?.animator || off[i]) continue;
    const ci = (n.animator.clips || []).find((c) => desc.clips?.[c]?.name === st.default?.clip);
    if (ci == null) continue;
    n.animator.default = ci;
    n.animator.enabled = false;           // driven by DynScene (the time rule in the header), not Effect.update
    drive.push({ node: i, clip: ci, speed: Number(st.default?.speed) || 1 });
  }
  const bones = [];
  for (let i = 0; i < N.length; i++) {
    if (off[i]) continue;
    for (const b of N[i].behaviours || []) {
      if (b.class !== 'BoneFollower' || b.enabled === false) continue;
      const f = b.fields || {};
      bones.push({ node: i, bone: String(f.boneName || ''), xy: !!f.followXYPosition, z: !!f.followZPosition, rot: !!f.followBoneRotation,
        flip: !!f.followSkeletonFlip, scale: !!f.followLocalScale });
    }
  }
  const sep = beh('SkeletonRenderSeparator'), sk = beh('SkeletonAnimation');
  const sepSlots = Array.isArray(sk?.fields?.separatorSlotNames) ? sk.fields.separatorSlotNames : [];
  const partNodes = (sep?.fields?.partsRenderers || []).map((p) => p?.node).filter((x) => x != null && N[x]);
  const mr = (n) => N[n].meshRenderer || {};
  const parts = (partNodes.length ? partNodes : [0]).map((n) => ({ node: n, order: Number(mr(n).m_SortingOrder) || 0, layer: Number(mr(n).m_SortingLayer) || 0 }));
  return { hidden, drive, bones, parts, sepSlots, camSize: Number(dyn.illust?.cameraSize) || 10,
    rootPos: Array.isArray(root.pos) ? root.pos.slice(0, 3) : [0, 0, 0], skelScale: Number(dyn.spine?.scale) || 0.01 };
}

export class DynScene {
  /** @param {any} P PIXI @param {any} scene loadScene(...) @param {any} spine a PIXI.spine.Spine @param {{ seed?: number }} [opts] */
  constructor(P, scene, spine, opts = {}) {
    this.P = P; this.s = scene; this.spine = spine;
    this.fx = new Effect(scene.def, { seed: opts.seed, lib: lib() });
    this.fx.place({ pos: [0, 0, 0] });
    this.time = 0;
    this.frameNo = 0;
    this.fd = new FrameData();
    this.vpm = new Float32Array(16);
    this.inv = new Float32Array(16);
    this.bones = scene.bones.map((b) => ({ ...b, ref: spine.skeleton?.findBone?.(b.bone) || null }));
    const camS = scene.camSize, k = 1 / scene.skelScale;
    const cx = -scene.rootPos[0], cy = -scene.rootPos[1];
    /** The official camera square in skeleton px (y-up), like a dynamic entry's `frame`. */
    this.frame = { x: (cx - camS) * k, y: (cy - camS) * k, width: 2 * camS * k, height: 2 * camS * k };
    this.basis = { right: [1, 0, 0], up: [0, 1, 0], fwd: [0, 0, 1], pos: [cx, cy, -scene.rootPos[2] - FAR], h: 1, tanHalf: camS / FAR };
    this.stats = { fxDraws: 0, spineParts: 0, items: 0, particles: 0, updateMs: 0, buildMs: 0, renderMs: 0, grabs: 0 };
    this.view = new P.Container();
    this.view._render = (r) => this.render(r);
    this.filter = null;
    this.gpu = null;          // the renderer its textures are counted on (preload); released on its current context
    this.mounted = false;
    this.gone = false;
    retainScene(scene.url);
  }

  /**
   * Put the scene's textures and meshes on the GPU of this renderer (so its first frame has every layer). False — keep
   * the placeholder — without WebGL2, once destroyed, when the renderer's context went meanwhile (lost, released) or
   * when any texture or mesh failed: a scene shows whole or not at all.
   */
  async preload(renderer) {
    const c = fxContext(renderer);
    if (!c || this.gone) return false;
    if (!this.gpu) { this.gpu = renderer; acquireGpu(c, this.s); }
    await c.texLib.init();
    await Promise.all(this.s.textures.map((t) => c.texLib.loadTexture(t, false)));
    // not fxContext: a renderer released meanwhile must not get a new FxGL
    if (this.gone || contexts.get(renderer) !== c || renderer.CONTEXT_UID !== c.uid) return false;
    for (const t of this.s.textures) c.glr.texture(t, false);
    for (const m of this.s.meshes) c.glr.mesh(m);
    resetPixi(renderer);
    const whole = this.s.textures.every((t) => c.glr.textures.has(`${t}|0`)) && this.s.meshes.every((m) => !!c.glr.meshes.get(m));
    if (!whole) console.warn('[dynfx] scene incomplete, the placeholder stays', this.s.url);
    return whole && !this.gone;
  }

  /** The swap: the view joins `container` (after the Spine) and the Spine's slots are drawn by it from now on. */
  mount(container) {
    if (this.gone || this.mounted) return;
    container.addChild(this.view);
    this.spine.renderable = false;
    this.mounted = true;
    live.add(this);
  }

  /** Advance by dt seconds — after spine.update(dt): the bone followers read this frame's bones. */
  update(dt) {
    const t0 = performance.now();
    const fx = this.fx, s = this.s;
    const tr = this.spine.state?.tracks?.[0];
    const idleLen = tr?.animation?.duration || 0;
    const tt = tr ? tr.trackTime : this.time;
    const inLoop = idleLen > 0 ? tt % idleLen : tt;
    const sink = fx._sink();
    const T = this.time + dt;
    for (const d of s.drive) {
      const c = fx.def.clips[d.clip];
      if (!c) continue;
      const t = c.loop ? T * d.speed : idleLen > 0 && c.length <= idleLen * 1.05 ? inLoop * d.speed : T * d.speed;
      sampleClip(c, t, sink);
    }
    this._follow();
    fx.update(dt);
    this.time = T;
    let n = 0;
    for (const sy of fx.sys) if (sy) n += sy.count;
    this.stats.particles = n;
    this.stats.updateMs = performance.now() - t0;
  }

  /** BoneFollower (Spine-Unity, world-space branch): the node at the bone's world position, turned by its world angle. */
  _follow() {
    const fx = this.fx, L = fx.loc, k = this.s.skelScale;
    for (const b of this.bones) {
      const bone = b.ref;
      if (!bone) continue;
      const i = b.node, o = i * 10, cw = fx.world[i];
      // pixi-spine keeps bones y-down (spine yDown): Unity's y-up world is (x, −y), its matrix c and d negated
      const wx = b.xy ? bone.worldX * k : cw[12], wy = b.xy ? -bone.worldY * k : cw[13], wz = b.z ? 0 : cw[14];
      const p = fx.def.parent[i];
      if (p >= 0) {
        mat4InvertAffine(fx.world[p], this.inv);
        const lp = mat4Point(this.inv, wx, wy, wz, [0, 0, 0]);
        L[o] = lp[0]; L[o + 1] = lp[1]; L[o + 2] = lp[2];
      } else { L[o] = wx; L[o + 1] = wy; L[o + 2] = wz; }
      if (b.rot) {
        let a = Math.atan2(-bone.c, bone.a);
        if (b.scale && bone.scaleX < 0) a += Math.PI;
        const q = [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
        const local = p >= 0 ? quatMul(conj(mat4Rotation(fx.world[p])), q) : q;
        L[o + 3] = local[0]; L[o + 4] = local[1]; L[o + 5] = local[2]; L[o + 6] = local[3];
      }
      L[o + 7] = b.scale ? bone.scaleX : 1; L[o + 8] = (b.scale ? bone.scaleY : 1) * (b.flip ? Math.sign((this.spine.skeleton?.scaleX || 1) * (this.spine.skeleton?.scaleY || 1)) || 1 : 1); L[o + 9] = 1;
    }
  }

  /** Root frame (Unity units, y-up) → clip space through the Spine's world transform and Pixi's projection. */
  _vp(renderer) {
    const pm = renderer.projection.projectionMatrix, wt = this.spine.worldTransform;
    const a = pm.a * wt.a + pm.c * wt.b, b = pm.b * wt.a + pm.d * wt.b;
    const c = pm.a * wt.c + pm.c * wt.d, d = pm.b * wt.c + pm.d * wt.d;
    const tx = pm.a * wt.tx + pm.c * wt.ty + pm.tx, ty = pm.b * wt.tx + pm.d * wt.ty + pm.ty;
    const k = 1 / this.s.skelScale, m = this.vpm;
    m[0] = a * k; m[1] = b * k; m[2] = 0; m[3] = 0;
    m[4] = -c * k; m[5] = -d * k; m[6] = 0; m[7] = 0;
    m[8] = 0; m[9] = 0; m[10] = 1 / 1000; m[11] = 0;
    m[12] = tx; m[13] = ty; m[14] = 0; m[15] = 1;
    return m;
  }

  /** The Spine parts as sort items: slot ranges of the draw order cut before each separator slot. */
  _parts() {
    const s = this.s, sk = this.spine.skeleton, n = this.spine.children.length;
    const cuts = [];
    if (s.sepSlots.length && s.parts.length > 1 && sk?.drawOrder) {
      for (const name of s.sepSlots) { const i = sk.drawOrder.findIndex((sl) => sl?.data?.name === name); if (i > 0) cuts.push(i); }
      cuts.sort((x, y) => x - y);
    }
    const edges = [0, ...cuts.slice(0, s.parts.length - 1), n];
    const out = [];
    const P = this.basis.pos;
    for (let k = 0; k < edges.length - 1; k++) {
      const p = s.parts[k], w = this.fx.world[p.node];
      const dx = w[12] - P[0], dy = w[13] - P[1], dz = w[14] - P[2];
      out.push({ part: 'spine', from: edges[k], to: edges[k + 1], layer: p.layer, order: p.order, queue: 3000, dist: Math.sqrt(dx * dx + dy * dy + dz * dz), seq: 0 });
    }
    return out;
  }

  /** Draw the Spine slots from..to (Pixi), the Spine object itself being non-renderable. */
  _slots(renderer, from, to) {
    const ch = this.spine.children;
    for (let i = from; i < to && i < ch.length; i++) ch[i].render(renderer);
  }

  render(renderer) {
    const t0 = performance.now();
    const c = fxContext(renderer);
    if (!c) { this._slots(renderer, 0, this.spine.children.length); return; }
    this.ctx = c;
    renderer.batch.flush();
    const vp = this._vp(renderer), basis = this.basis;
    const fd = this.fd;
    fd.reset();
    const items = [];
    let seq = 0;
    const keep = this.filter;   // test hook: (item) => draw it (screenshots of the layers alone)
    this.fx.gather(basis, (e) => { if (keep && !keep(e)) return; e.seq = seq++; items.push(e); });
    for (const p of this._parts()) { if (keep && !keep(p)) continue; p.seq = seq++; items.push(p); }
    items.sort(byUnityOrder);
    const frameNo = ++this.frameNo;
    const list = [];
    let prev = null;
    for (const e of items) {
      if (e.part === 'spine') { list.push(e); prev = null; continue; }
      const r = e.effect.build(e, basis, fd, frameNo);
      if (!r || !r.count) continue;
      e.kind = r.kind; e.first = r.first; e.count = r.count;
      if (prev && prev.mat === e.mat && prev.kind === e.kind && !prev.ov && !e.ov && prev.meshKey === e.meshKey && prev.submesh === e.submesh
        && prev.first + prev.count === e.first) { prev.count += e.count; continue; }
      list.push(e);
      prev = e;
    }
    const st = this.stats;
    st.items = items.length; st.fxDraws = 0; st.spineParts = 0;
    st.buildMs = performance.now() - t0;   // CPU: gather, sort, particle / mesh geometry (JS)
    const d0 = c.glr.stats.draws, g0 = c.glr.stats.grabs || 0;
    try { c.glr.upload(fd); } finally { resetPixi(renderer); }
    let run = [];
    const flush = () => {
      if (!run.length) return;
      try { c.glr.draw(run, { vp, cam: basis.pos, time: this.fx.time, half: false, pass: ++c.pass }); } catch (err) {
        if (!this._warned) { this._warned = true; console.error('[dynfx] draw failed', err); }
      } finally { resetPixi(renderer); }
      run = [];
    };
    for (const e of list) {
      if (e.part === 'spine') { flush(); this._slots(renderer, e.from, e.to); renderer.batch.flush(); st.spineParts++; } else run.push(e);
    }
    flush();
    st.fxDraws = c.glr.stats.draws - d0;
    st.grabs = (c.glr.stats.grabs || 0) - g0;
    st.renderMs = performance.now() - t0;
  }

  destroy() {
    if (this.gone) return;
    this.gone = true;
    live.delete(this);
    if (this.mounted) this.spine.renderable = true;
    try { this.view.destroy(); } catch { /* gone with its stage */ }
    this.fx.kill();
    // the renderer's current context: after a restore the counts moved to it (fxContext); a released renderer has none
    if (this.gpu) { const c = contexts.get(this.gpu); this.gpu = null; if (c) try { releaseGpu(c, this.s); } catch { /* a lost context */ } }
    releaseScene(this.s.url);
  }
}

function conj(q) { return [-q[0], -q[1], -q[2], q[3]]; }
