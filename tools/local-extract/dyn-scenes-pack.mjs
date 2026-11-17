// tools/local-extract/dyn-scenes-pack.mjs — the 动态立绘 scenes (tools/assets/dynamic-scenes.mjs) into an asset tree and
// the registry tools/assets/dynamic-scenes.json, from an export of tools/local-extract/dyn_scenes.py (2026-11-17).
//
//   .venv/bin/python tools/local-extract/dyn_scenes.py <export> --jobs 8 --tex webp --no-half
//   node tools/local-extract/dyn-scenes-pack.mjs --export <export> --assets <dir mapped to /assets/> [--upload <dir>] [--dry]
//
// One scene per record of tools/assets/dynamic-backdrops.json (its dynIllustId: the client prefab), trimmed to its
// always-on part (idleScene). Files are written add-only — a file already there must have the same bytes: the scene in its
// record's folder (scene-<sha8>.json), the textures and meshes in <assets>/local/dynfx/{tex,mesh}/ (content-addressed
// names: written once however many scenes use one). The registry
// keeps `enabled` and `check` of a record whose scene file did not change (a changed scene has to be checked again: it
// is listed). --upload writes upload-manifest.tsv / .json there (every file of every scene: path, bytes, sha256, source,
// hosting). Then node tools/prepare-dynamic-scenes.mjs --assets <dir> names the enabled scenes in data/assets.json.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDynamicBackdrops } from '../assets/dynamic-backdrops.mjs';
import { REGISTRY_PATH, SCENE_ROOT, SCENE_FIELDS, idleScene, sceneFile, sceneFileName, sceneRel, loadDynamicScenes } from '../assets/dynamic-scenes.mjs';
import { familyOf } from '../../public/js/render/vfx/materials.js';
import { isCollabUrl } from '../../shared/collabAssets.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
/** Families the battle effects had before the 动态立绘 scenes (the first batch uses only these). */
const NEW_FAMILIES = new Set(['disturb2', 'dissolveDoubleEdge', 'erase', 'grab']);
/** Families the runtime only approximated until feat/dyn-fx-shaders-20261117 drew them: their scenes stay the last batch. */
const LATE_FAMILIES = new Set(['matcap', 'outline', 'toon', 'rgbsplit', 'uiAlpha']);

/**
 * The check batch of a trimmed scene (the trial's order): 3 — a shader the runtime approximates or only drew since the
 * shader branch (MatCap, Outline, Toon, RGBsplit, UI AlphaBlend); 1 — the battle families only, one Spine part, no skinned mesh, no vertex displacement; else 2. And the
 * families its always-on renderers use.
 */
export function sceneBatch(desc) {
  const N = desc.nodes || [], mats = desc.materials || [];
  const fams = new Set(); let fallback = false, special = false, skinned = false;
  for (const n of N) {
    if (n.skinnedMeshRenderer) skinned = true;
    for (const k of ['meshRenderer', 'particleSystemRenderer', 'trailRenderer', 'lineRenderer', 'skinnedMeshRenderer']) {
      for (const i of n[k]?.materials || []) {
        const s = mats[i]?.shader;
        if (!s || /spine|skeleton/i.test(s)) continue;
        const f = familyOf(s);
        fams.add(f.family);
        if (f.fallback || LATE_FAMILIES.has(f.family)) fallback = true;
        if (NEW_FAMILIES.has(f.family) || /VertexDisturb/.test(s)) special = true;
      }
    }
  }
  const parts = (desc.dyn?.spine?.separatorSlotNames || []).length > 0;
  return { batch: fallback ? 3 : !special && !parts && !skinned ? 1 : 2, families: [...fams].sort() };
}

function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const exp = arg('--export'), assets = arg('--assets'), upload = arg('--upload'), dry = argv.includes('--dry');
  if (!exp || !assets) { console.error('usage: node tools/local-extract/dyn-scenes-pack.mjs --export <dir> --assets <dir> [--upload <dir>] [--dry]'); process.exit(2); }
  const fxDir = join(exp, 'fx');
  const list = JSON.parse(readFileSync(join(exp, 'local-fx.json'), 'utf8')).groups;
  const texMeta = JSON.parse(readFileSync(join(fxDir, 'textures.json'), 'utf8')).textures;
  const fxRel = (p) => p.slice(p.indexOf('/fx/') + 4);
  const manifest = JSON.parse(readFileSync(join(ROOT, 'data/assets.json'), 'utf8'));
  const backdrops = loadDynamicBackdrops(), old = loadDynamicScenes();
  const files = new Map();   // rel → { bytes, sha256, users: [prefab key], bundle, clientHash }
  let written = 0, same = 0;
  const put = (rel, buf, user) => {
    const h = sha256(buf), p = join(assets, rel);
    if (existsSync(p)) {
      if (sha256(readFileSync(p)) !== h) throw new Error(`${rel} exists with other bytes (add-only)`);
      same++;
    } else if (!dry) {
      mkdirSync(dirname(p), { recursive: true }); writeFileSync(p + '.tmp', buf); renameSync(p + '.tmp', p); written++;
    } else written++;
    const f = files.get(rel) || { bytes: buf.length, sha256: h, users: [], bundle: user.bundle, clientHash: user.clientHash };
    if (!f.users.includes(user.key)) f.users.push(user.key);
    files.set(rel, f);
    return h;
  };
  const registry = { version: 1, source: 'the local CN client (hot update 26-11-06-12-42-25-70182449): each dyn_illust prefab of arts/dynchars/*.ab exported by tools/local-extract/dyn_scenes.py (WebP q90, no half-size copies) and trimmed to its always-on part (tools/assets/dynamic-scenes.mjs idleScene)', skins: {}, chars: {} };
  const reset = [], missing = [];
  for (const kind of ['skins', 'chars']) {
    for (const [id, B] of Object.entries(backdrops[kind] || {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const key = String(B.dynIllustId || '').toLowerCase();
      const e = list['fx/prefabs']?.[key];
      const rec = manifest[kind]?.[id]?.[SCENE_FIELDS[kind]];
      if (!e || !rec) { missing.push(`${kind}/${id} (${key}${e ? '' : ': not exported'}${rec ? '' : ': no record'})`); continue; }
      if (isCollabUrl(rec.skel)) throw new Error(`${kind}/${id}: a collab 动态立绘 — its scene would belong to the collab pack (not supported)`);
      const user = { key, bundle: B.bundle, clientHash: B.clientHash };
      const { desc, cut } = idleScene(JSON.parse(readFileSync(join(fxDir, fxRel(e.path)), 'utf8')));
      let texBytes = 0, meshBytes = 0;
      const tex = (k) => {
        const m = texMeta[k];
        if (!m?.file) return null;
        const rel = `${SCENE_ROOT}/tex/${k}.webp`, buf = readFileSync(join(fxDir, m.file));
        const h = put(rel, buf, user); texBytes += buf.length;
        return { url: `/assets/~${h.slice(0, 16)}/${rel}`, w: m.w, h: m.h, wrapU: m.wrapU, wrapV: m.wrapV, filter: m.filter, mips: m.mips };
      };
      const mesh = (k) => {
        const g = list['fx/mesh']?.[k];
        if (!g?.path) return null;
        const rel = `${SCENE_ROOT}/mesh/${k}.json`, buf = readFileSync(join(fxDir, fxRel(g.path)));
        const h = put(rel, buf, user); meshBytes += buf.length;
        return `/assets/~${h.slice(0, 16)}/${rel}`;
      };
      const file = sceneFile(desc, { tex, mesh });
      const buf = Buffer.from(JSON.stringify(file));
      const h = sha256(buf), name = sceneFileName(h);
      put(sceneRel(kind, id, name), buf, user);
      const prev = old[kind]?.[id], kept = prev?.scene?.sha256 === h;
      if (prev?.enabled && !kept) reset.push(`${kind}/${id}`);
      const { batch, families } = sceneBatch(desc);
      registry[kind][id] = {
        dynIllustId: B.dynIllustId, bundle: B.bundle, clientHash: B.clientHash,
        scene: { name, bytes: buf.length, sha256: h },
        textures: desc.textures.length, texBytes, meshes: Object.keys(file.meshes).length, meshBytes,
        cut: { nodes: cut.nodes, clips: cut.clips, textures: cut.textures.length, meshes: cut.meshes.length },
        batch, families, enabled: !!(kept && prev.enabled), ...(kept && prev.check ? { check: prev.check } : {}),
      };
    }
  }
  const n = Object.keys(registry.skins).length + Object.keys(registry.chars).length;
  const all = [...files.values()];
  const by = (b) => [...Object.values(registry.skins), ...Object.values(registry.chars)].filter((r) => r.batch === b).length;
  console.log(`${n} scenes (batches 1/2/3: ${by(1)}/${by(2)}/${by(3)}); files ${files.size} (${(all.reduce((s, f) => s + f.bytes, 0) / 1048576).toFixed(1)} MB): `
    + `${written} written, ${same} already there${dry ? ' (dry run: nothing written)' : ''}`);
  if (missing.length) console.log(`no scene: ${missing.join(', ')}`);
  if (reset.length) console.log(`check again (the scene changed, enabled reset): ${reset.join(', ')}`);
  if (!dry) { writeFileSync(REGISTRY_PATH + '.tmp', JSON.stringify(registry, null, 1) + '\n'); renameSync(REGISTRY_PATH + '.tmp', REGISTRY_PATH); }
  if (upload) {
    const rows = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([rel, f]) => {
      const what = /\/scene-[0-9a-f]{8}\.json$/.test(rel) ? 'scene file (always-on part)' : rel.includes('/tex/') ? 'effect texture (WebP q90)' : 'effect mesh';
      const more = f.users.length > 1 ? ` (+${f.users.length - 1} other scene${f.users.length > 2 ? 's' : ''})` : '';
      return { path: `/assets/${rel}`, bytes: f.bytes, sha256: f.sha256,
        source: `local client 26-11-06 hot update: ${String(f.bundle).replace(/^arts\/dynchars\//, '')} (hot update hash ${f.clientHash}) — ${f.users[0]}${more}, 动态立绘 scene ${what} (tools/local-extract/dyn_scenes.py + dyn-scenes-pack.mjs, feat/dyn-fx-20261117)`,
        hosting: 'public: ModelScope profile + OpenI mirror', scenes: f.users };
    });
    mkdirSync(upload, { recursive: true });
    writeFileSync(join(upload, 'upload-manifest.tsv'), 'path\tbytes\tsha256\tsource\thosting\n' + rows.map((r) => [r.path, r.bytes, r.sha256, r.source, r.hosting].join('\t')).join('\n') + '\n');
    writeFileSync(join(upload, 'upload-manifest.json'), JSON.stringify({ files: rows, count: rows.length, bytes: rows.reduce((s, r) => s + r.bytes, 0), collab: [],
      note: 'no collab file: no collab skin or operator has a 动态立绘 (shared/collabAssets.js; the pack refuses one). 合作款 (年、令、重岳、黍) are normal skins.' }, null, 1));
    console.log(`upload manifest: ${rows.length} files → ${upload}`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
