// tools/assets/dynamic-scenes.mjs — the official 动态立绘 scenes, played live (2026-11-17, the owner: every 动态立绘's
// scene — the mesh layers, particles and shader effects before and behind the character — plays like the client's, at
// the highest quality; the baked backdrop of tools/assets/dynamic-backdrops.mjs is only its placeholder): the committed
// registry tools/assets/dynamic-scenes.json and the scene files (docs/ASSETS.md "Dynamic illustrations").
//
// A scene file (public/js/ui/dynFx.js plays it) is the client prefab of a record — skins[id].dynamic, an operator's own
// 精二 chars[id].dynamicE2 — exported by tools/local-extract/dyn_scenes.py (DESIGN §33 fx-prefab + `dyn`) and trimmed to
// its always-on part by idleScene: { format: 'dyn-scene', version: 1, key, prefab, textures: { key: { path, w, h, wrapU,
// wrapV, filter, mips } }, meshes: { key: path } }. The scene file sits in its record's own folder, next to the baked
// pictures (`scene-<sha8>.json` in /assets/skins/<id>/dynamic/, /assets/char/dynamic/<charId>_2/: data/assets.json names
// it, and never a local-client path); the textures (WebP) and meshes all scenes share — content-addressed, one file
// however many scenes use it — live in tools/local-extract's tree, local/dynfx/tex/ and mesh/, named only by the scene
// files, with their content-hash segment (shared/assetPaths.js), so a browser keeps them for a year.
//
// The registry holds per record: { dynIllustId, bundle, clientHash, scene: { name, bytes, sha256 }, textures, texBytes,
// meshes, meshBytes, batch, enabled, check? }. `enabled` is the release list: only a scene checked against the official
// client (tools/local-extract/dyn-scenes-pack.mjs writes the rest, never `enabled`) gets its `scene` URL in
// data/assets.json; the others keep the baked pictures. So a batch ships once it is checked.
import { readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backdropDir } from './dynamic-backdrops.mjs';

export const REGISTRY_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'dynamic-scenes.json');
/** The folder of the scenes' textures and meshes (asset-relative): tex/, mesh/. */
export const SCENE_ROOT = 'local/dynfx';
export const SCENE_FORMAT = 'dyn-scene';
export const SCENE_VERSION = 1;
/** Where a kind's records are: skins[id].dynamic, chars[id].dynamicE2. */
export const SCENE_FIELDS = Object.freeze({ skins: 'dynamic', chars: 'dynamicE2' });
/** The node fields an always-off node keeps (its place in the hierarchy). */
const STUB_KEYS = ['id', 'name', 'parent', 'children', 'active', 'pos', 'rot', 'scale', 'ignored'];
const RENDERERS = ['meshRenderer', 'particleSystemRenderer', 'trailRenderer', 'lineRenderer', 'skinnedMeshRenderer'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The committed registry (an empty one when the file is missing: a checkout before 2026-11-17). */
export function loadDynamicScenes(path = REGISTRY_PATH) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { version: 1, skins: {}, chars: {} }; throw e; }
}

/** The file name of a scene (in its record's folder): `scene-<sha8>.json`. */
export const sceneFileName = (sha256) => `scene-${sha256.slice(0, 8)}.json`;
/** A record's scene file, asset-relative: `skins/<id>/dynamic/<name>`, `char/dynamic/<charId>_2/<name>`. */
export const sceneRel = (kind, id, name) => `${backdropDir(kind, id)}/${name}`;

const isFile = (f) => isObj(f) && typeof f.name === 'string' && /^scene-[0-9a-f]{8}\.json$/.test(f.name) && Number.isSafeInteger(f.bytes) && f.bytes > 0
  && typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.sha256);
/** A registry entry with a well-formed scene file. */
export const validSceneEntry = (R) => isObj(R) && isFile(R.scene);

/** Every string anywhere in `v` (texture and mesh keys are strings; nothing else in a node looks like one). */
function strings(v, out) {
  if (typeof v === 'string') out.add(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (isObj(v)) for (const x of Object.values(v)) strings(x, out);
  return out;
}

/**
 * The always-on part of a dyn illust descriptor (a copy; node indices unchanged): what the 「查看立绘」 idle never shows is
 * cut — the DynIllust `_particles` groups of the actions (1 special, 2 start, 3 interact) keep only their place in the
 * hierarchy, an Animator's clips other than its default state's lose their curves, and the materials, textures and meshes
 * only those parts used leave the lists. What nothing names is kept. `cut`: what went.
 * @param {any} desc @returns {{ desc: any, cut: { nodes: number, clips: number, textures: string[], meshes: string[] } }}
 */
export function idleScene(desc) {
  const d = structuredClone(desc);
  const N = Array.isArray(d.nodes) ? d.nodes : [];
  const il = (N[0]?.behaviours || []).find((b) => b?.class === 'DynIllust')?.fields || {};
  const roots = new Set();
  for (const p of il._particles || []) { const n = p?.particle?.node; if (Number.isInteger(n) && p.action !== 0 && N[n]) roots.add(n); }
  const off = new Uint8Array(N.length);
  // nodes come depth first (a parent before its children)
  for (let i = 0; i < N.length; i++) { const p = N[i].parent; off[i] = roots.has(i) || (Number.isInteger(p) && p >= 0 && off[p]) ? 1 : 0; }
  const matsOf = (n) => RENDERERS.flatMap((k) => (Array.isArray(n[k]?.materials) ? n[k].materials : [])).filter(Number.isInteger);
  const matOn = new Set(), matOff = new Set(), strOn = new Set(), strOff = new Set();
  for (let i = 0; i < N.length; i++) {
    for (const m of matsOf(N[i])) (off[i] ? matOff : matOn).add(m);
    strings(N[i], off[i] ? strOff : strOn);
  }
  const mats = Array.isArray(d.materials) ? d.materials : [];
  const texOf = (m) => Object.values(isObj(m?.textures) ? m.textures : {}).map((t) => t?.tex).filter((k) => typeof k === 'string');
  const texOn = new Set(), texOff = new Set();
  mats.forEach((m, i) => { for (const k of texOf(m)) (matOff.has(i) && !matOn.has(i) ? texOff : texOn).add(k); });
  for (const k of strOn) texOn.add(k);
  const cutTex = (d.textures || []).filter((k) => texOff.has(k) && !texOn.has(k));
  const cutMesh = (d.meshes || []).filter((k) => !k.startsWith('builtin:') && strOff.has(k) && !strOn.has(k));
  // the clips that play: each kept Animator's default (its own, and DynIllust's default state for it), every legacy one
  const play = new Set(), viaAnimator = new Set();
  const clips = Array.isArray(d.clips) ? d.clips : [];
  const states = isObj(d.dyn?.animatorStates) ? d.dyn.animatorStates : {};
  for (let i = 0; i < N.length; i++) {
    const a = N[i].animator, l = N[i].animation;
    if (a) {
      for (const c of a.clips || []) viaAnimator.add(c);
      if (!off[i]) {
        if (Number.isInteger(a.default)) play.add(a.default);
        const name = states[i]?.default?.clip;
        for (const c of a.clips || []) if (name != null && clips[c]?.name === name) play.add(c);
      }
    }
    if (l) for (const c of [...(l.clips || []), l.default]) if (Number.isInteger(c)) play.add(c);
  }
  let cutClips = 0;
  clips.forEach((c, i) => {
    if (!isObj(c) || play.has(i) || !viaAnimator.has(i)) return;
    if ((c.curves || []).length || (c.events || []).length) cutClips++;
    c.curves = []; c.events = [];
  });
  let cutNodes = 0;
  for (let i = 0; i < N.length; i++) {
    if (!off[i]) continue;
    const n = N[i], keep = {};
    for (const k of STUB_KEYS) if (k in n) keep[k] = n[k];
    if (Object.keys(n).length > Object.keys(keep).length) cutNodes++;
    N[i] = keep;
  }
  const ct = new Set(cutTex), cm = new Set(cutMesh);
  d.textures = (d.textures || []).filter((k) => !ct.has(k));
  d.meshes = (d.meshes || []).filter((k) => !cm.has(k));
  return { desc: d, cut: { nodes: cutNodes, clips: cutClips, textures: cutTex, meshes: cutMesh } };
}

/**
 * A scene file: the trimmed descriptor and the URL of every texture and mesh it names. `tex(key)` → { url, w, h, wrapU,
 * wrapV, filter, mips } (textures.json's fields), `mesh(key)` → its URL; a key either has none of is an error.
 */
export function sceneFile(desc, { tex, mesh }) {
  const textures = {}, meshes = {};
  for (const k of desc.textures || []) {
    const t = tex(k);
    if (!t?.url) throw new Error(`${desc.key}: texture ${k} has no file`);
    textures[k] = { path: t.url, w: t.w, h: t.h, wrapU: t.wrapU, wrapV: t.wrapV, filter: t.filter, mips: t.mips };
  }
  for (const k of desc.meshes || []) {
    if (k.startsWith('builtin:')) continue;
    const u = mesh(k);
    if (!u) throw new Error(`${desc.key}: mesh ${k} has no file`);
    meshes[k] = u;
  }
  return { format: SCENE_FORMAT, version: SCENE_VERSION, key: desc.key, prefab: desc, textures, meshes };
}

/** A record's scene file URL path. */
export const sceneUrl = (kind, id, name) => `/assets/${sceneRel(kind, id, name)}`;

/** The asset-relative paths of the files a scene file names (the content-hash segment taken off). */
export function sceneDeps(file) {
  const rel = (u) => String(u).replace(/^\/assets\/(?:~[0-9a-f]{16}\/)?/, '');
  return [...Object.values(file?.textures || {}).map((t) => rel(t.path)), ...Object.values(file?.meshes || {}).map(rel)];
}

function size(assetRoot, rel) {
  try { return statSync(join(assetRoot, rel)).size; } catch { return -1; }
}

/**
 * Apply the registry to a manifest body (a copy; the input is not changed): each enabled record whose scene file is on
 * disk with its size (`assetRoot` null = trust the registry) gets `scene`; a record not enabled (or whose file is
 * missing) has none. With `assetRoot`, a scene whose textures and meshes are not all on disk is left out too.
 * @returns {{ body: any, files: Map<string, number>, records: number, parked: Set<string> }} files: the scene files and
 *   what they name (asset-relative → bytes; with `assetRoot` only); parked: the scene files of the records not named
 *   (not checked yet, or incomplete on disk) — kept on disk all the same (fetch-assets --prune leaves them)
 */
export function applyDynamicScenes(body, { registry = loadDynamicScenes(), assetRoot = null, kinds = ['skins', 'chars'] } = {}) {
  const out = { ...body }; const files = new Map(), parked = new Set(); let records = 0;
  for (const kind of kinds) {
    const field = SCENE_FIELDS[kind];
    if (!field || !body?.[kind]) continue;
    out[kind] = { ...body[kind] };
    for (const [id, rec] of Object.entries(body[kind])) {
      if (!rec?.[field]) continue;
      const R = registry[kind]?.[id];
      let url = null;
      if (validSceneEntry(R)) parked.add(sceneRel(kind, id, R.scene.name));
      if (R?.enabled === true && validSceneEntry(R)) {
        const rel = sceneRel(kind, id, R.scene.name);
        if (!assetRoot) url = sceneUrl(kind, id, R.scene.name);
        else if (size(assetRoot, rel) === R.scene.bytes) {
          let deps;
          try { deps = sceneDeps(JSON.parse(readFileSync(join(assetRoot, rel), 'utf8'))); } catch { deps = null; }
          const sizes = deps ? deps.map((r) => [r, size(assetRoot, r)]) : null;
          if (sizes && sizes.every(([, b]) => b > 0)) {
            url = sceneUrl(kind, id, R.scene.name);
            files.set(rel, R.scene.bytes);
            for (const [r, b] of sizes) files.set(r, b);
          }
        }
      }
      const { scene, ...plain } = rec[field];
      if (url) { out[kind][id] = { ...rec, [field]: { ...plain, scene: url } }; records++; parked.delete(sceneRel(kind, id, R.scene.name)); } else if (scene !== undefined) out[kind][id] = { ...rec, [field]: plain };
    }
  }
  return { body: out, files, records, parked };
}
