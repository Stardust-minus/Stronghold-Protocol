// public/js/ui/dynFx.js — SPIKE (spike/dyn-fx-20261116, not for release): the official 动态立绘 scene around the Spine.
// The client's dyn illust prefab (arts/dynchars) is one scene: the Spine (split by Spine-Unity's SkeletonRenderSeparator
// into parts with their own sorting orders), the mesh layers and particle systems behind and in front of it, Animator
// clips, Torappu.Fx behaviours (FxUVTweener / FxUVRotation / FxDelay) and BoneFollowers that keep effects on bones — all
// shot by one orthographic camera (DynIllust `_cameraSize`, centred on the world origin, the root offset by its own
// position). tools/local-extract/dyn_scenes.py exports the prefab in the battle effects' format (DESIGN §33) plus `dyn`;
// this module plays it with that runtime (render/vfx: Effect, FxGL) in the prefab root's frame and draws it, sorted the
// Unity way (sorting layer, order, queue, camera depth) together with the Spine parts, inside the Pixi render.
//
//   dynFxEnabled()                     the spike's switch: ?dynfx=1 or globalThis.__dynfx
//   sceneKeyOf(entry)                  the prefab key of a dynamic entry (skins/<id>/dynamic, char/dynamic/<id>_2)
//   await loadScene(key)               the compiled scene (shared) or null
//   const s = new DynScene(P, scene, spine)   one playing instance: s.view (a Pixi container that draws the Spine's
//                                      slots and the scene; the Spine itself stops drawing), s.update(dt) after
//                                      spine.update(dt), s.frame (the official camera square, skeleton px, y-up)
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

/** The spike's file list (the extracted scenes; served from outside the asset tree). */
export const DYNFX_LIST_URL = (globalThis.__dynfxList) || '/dynfx/s5/local-fx.json';
/** The camera's distance behind the scene: Unity sorts an orthographic camera's transparents by depth along its view;
 * the battle runtime sorts by distance to a point, which from this far is that depth. */
const FAR = 1e4;
const env = () => globalThis;

export function dynFxEnabled() {
  try { return !!env().__dynfx || /[?&]dynfx=1(?:&|$)/.test(env().location?.search || ''); } catch { return false; }
}

/** The client's prefab key of a dynamic entry (lower case, as the file list keeps keys). */
export function sceneKeyOf(entry) {
  const m = /\/assets\/(?:skins\/([^/]+)\/dynamic|char\/dynamic\/([^/]+))\//.exec(String(entry?.skel || ''));
  if (!m) return null;
  if (m[1]) { const i = m[1].lastIndexOf('_'); return `dyn_illust_${m[1].slice(0, i)}#${m[1].slice(i + 1)}`.toLowerCase(); }
  return `dyn_illust_${m[2]}`.toLowerCase();
}

let mainLib = null;
const lib = () => mainLib || (mainLib = new FxLibrary({ listUrl: DYNFX_LIST_URL, layers: null }));
const scenes = new Map();

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

/** Load and compile a scene once (null when the list does not have it). */
export function loadScene(key) {
  const k = String(key || '').toLowerCase();
  if (!scenes.has(k)) {
    scenes.set(k, (async () => {
      const L = lib();
      await L.init();
      if (!L.has(k)) return null;
      const desc = await L.descriptor(k);
      if (!desc) return null;
      const info = prepareScene(desc);
      await Promise.all((desc.meshes || []).map((m) => L.loadMesh(m)));
      return { key: k, desc, def: compileEffect(desc, L), ...info };
    })().catch((e) => { console.warn('[dynfx] scene failed', k, e?.message || e); return null; }));
  }
  return scenes.get(k);
}

const contexts = new WeakMap();
/** One FxGL (and texture library: a decoded image is let go once on the GPU) per Pixi renderer. */
export function fxContext(renderer) {
  let c = contexts.get(renderer);
  if (c && c.uid !== renderer.CONTEXT_UID) c = null;
  if (!c) {
    if (!renderer?.gl || renderer.context?.webGLVersion !== 2) return null;
    const texLib = new FxLibrary({ listUrl: DYNFX_LIST_URL, layers: null });
    const glLib = { texture: (k, h) => texLib.texture(k, h), mesh: (k) => lib().mesh(k), release: (k, h) => texLib.release(k, h), forgetGpu: () => texLib.forgetGpu() };
    c = { glr: new FxGL(renderer.gl, glLib), texLib, uid: renderer.CONTEXT_UID, pass: 1 };
    contexts.set(renderer, c);
  }
  return c;
}

function byUnityOrder(a, b) {
  return (a.layer - b.layer) || (a.order - b.order) || (a.queue - b.queue) || (b.dist - a.dist) || (a.seq - b.seq);
}

const live = new Set();
/** Test hooks: the playing scenes. */
export const dynFxScenes = live;

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
    /** The official camera square in skeleton px (y-up), like a dynamic entry's `bounds`. */
    this.frame = { x: (cx - camS) * k, y: (cy - camS) * k, width: 2 * camS * k, height: 2 * camS * k };
    this.basis = { right: [1, 0, 0], up: [0, 1, 0], fwd: [0, 0, 1], pos: [cx, cy, -scene.rootPos[2] - FAR], h: 1, tanHalf: camS / FAR };
    this.stats = { fxDraws: 0, spineParts: 0, items: 0, particles: 0, updateMs: 0, buildMs: 0, renderMs: 0, grabs: 0 };
    this.view = new P.Container();
    this.view._render = (r) => this.render(r);
    this.filter = null;
    spine.renderable = false;   // its slots are drawn by this view, between the scene's layers
    live.add(this);
  }

  /** Put the scene's textures on the GPU of this renderer (screenshots: no layer missing on the first frame). */
  async preload(renderer) {
    const c = fxContext(renderer);
    if (!c) return false;
    await c.texLib.init();
    await Promise.all((this.s.desc.textures || []).map((t) => c.texLib.loadTexture(t, false)));
    for (const t of this.s.desc.textures || []) c.glr.texture(t, false);
    resetPixi(renderer);
    return true;
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
    live.delete(this);
    this.spine.renderable = true;
    try { this.view.destroy(); } catch { /* gone with its stage */ }
    this.fx.kill();
  }
}

function conj(q) { return [-q[0], -q[1], -q[2], q[3]]; }
