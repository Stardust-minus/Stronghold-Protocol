// tools/prepare-dynamic-scenes.mjs — name the checked 动态立绘 scenes (tools/assets/dynamic-scenes.mjs) in data/assets.json
// from the registry tools/assets/dynamic-scenes.json, like tools/prepare-dynamic-backdrops.mjs: the manifest is rewritten
// in place (hash recomputed, the generator field kept); stats.files / stats.bytes move by the scene files and the
// textures and meshes they name, newly named or no longer named (read from the asset tree: `--assets` is required).
//
//   node tools/prepare-dynamic-scenes.mjs --assets <dir mapped to /assets/> [--check]
//     --check: exit 1 when the manifest would change (nothing written).
//   node tools/prepare-dynamic-scenes.mjs --assets <dir> --enable <kind/id,…> --note <text> [--disable]
//     the release list: mark those records checked (enabled, check: { date, scene: sha8, note }) or not, then rewrite.
// The scene files (public/assets/local/dynfx/, tools/local-extract/dyn-scenes-pack.mjs) are git-ignored like every other
// extracted file; docs/ASSETS.md "Dynamic illustrations" says how they are made and checked.
import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from './assets/manifest.mjs';
import { applyDynamicScenes, loadDynamicScenes, sceneDeps, SCENE_FIELDS, REGISTRY_PATH } from './assets/dynamic-scenes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The files the scenes a body names use (asset-relative → bytes), read from the tree. */
export function namedSceneFiles(body, assetRoot) {
  const out = new Map();
  for (const [kind, field] of Object.entries(SCENE_FIELDS)) {
    for (const rec of Object.values(body?.[kind] || {})) {
      const u = rec?.[field]?.scene;
      if (typeof u !== 'string') continue;
      const rel = u.replace(/^\/assets\//, '');
      try {
        out.set(rel, statSync(join(assetRoot, rel)).size);
        for (const r of sceneDeps(JSON.parse(readFileSync(join(assetRoot, rel), 'utf8')))) out.set(r, statSync(join(assetRoot, r)).size);
      } catch { /* a scene no longer on disk: counted as before */ }
    }
  }
  return out;
}

export function rewriteManifest(manifest, { registry, assetRoot }) {
  const { version, hash, generator, stats, ...body } = manifest;
  const before = namedSceneFiles(body, assetRoot);
  const { body: next } = applyDynamicScenes(body, { registry, assetRoot });
  const after = namedSceneFiles(next, assetRoot);
  const added = [...after].filter(([r]) => !before.has(r)), removed = [...before].filter(([r]) => !after.has(r));
  const out = { version, hash: null, generator, stats: { ...stats }, ...next };
  if (Number.isSafeInteger(stats?.files)) out.stats.files = stats.files + added.length - removed.length;
  if (Number.isSafeInteger(stats?.bytes)) out.stats.bytes = stats.bytes + added.reduce((n, [, b]) => n + b, 0) - removed.reduce((n, [, b]) => n + b, 0);
  out.hash = contentHash(next);
  return out;
}

/** Mark records of the registry checked (or not): `ids` are `skins/<id>` / `chars/<id>`. Returns the records changed. */
export function markChecked(registry, ids, { note = '', on = true, date = new Date().toISOString().slice(0, 10) } = {}) {
  const changed = [];
  for (const id of ids) {
    const [kind, ...rest] = id.split('/'); const R = registry[kind]?.[rest.join('/')];
    if (!R?.scene) throw new Error(`no scene for ${id}`);
    if (on) { R.enabled = true; R.check = { date, scene: R.scene.sha256.slice(0, 8), note }; } else { R.enabled = false; delete R.check; }
    changed.push(id);
  }
  return changed;
}

function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const at = arg('--assets'); const check = argv.includes('--check');
  if (!at) { console.error('usage: node tools/prepare-dynamic-scenes.mjs --assets <dir> [--check] [--enable <kind/id,…> --note <text> [--disable]]'); process.exit(2); }
  const assetRoot = resolve(at); const registry = loadDynamicScenes();
  const ids = arg('--enable');
  if (ids) {
    const changed = markChecked(registry, ids.split(',').filter(Boolean), { note: arg('--note') || '', on: !argv.includes('--disable') });
    writeFileSync(REGISTRY_PATH + '.tmp', JSON.stringify(registry, null, 1) + '\n'); renameSync(REGISTRY_PATH + '.tmp', REGISTRY_PATH);
    console.log(`tools/assets/dynamic-scenes.json: ${changed.length} records ${argv.includes('--disable') ? 'disabled' : 'checked'}`);
  }
  const path = join(ROOT, 'data/assets.json'); const raw = readFileSync(path, 'utf8'); const manifest = JSON.parse(raw);
  const out = rewriteManifest(manifest, { registry, assetRoot });
  const text = JSON.stringify(out) + (raw.endsWith('\n') ? '\n' : '');
  const count = (kind) => Object.values(out[kind] || {}).filter((r) => r?.[SCENE_FIELDS[kind]]?.scene).length;
  const enabled = Object.values(SCENE_FIELDS).length && ['skins', 'chars'].reduce((n, k) => n + Object.values(registry[k] || {}).filter((r) => r.enabled).length, 0);
  console.log(`data/assets.json: scenes ${count('skins')} skins + ${count('chars')} 精二 (${enabled} enabled in the registry); `
    + `files ${manifest.stats?.files} → ${out.stats.files}, bytes ${manifest.stats?.bytes} → ${out.stats.bytes}${text === raw ? ' (unchanged)' : ''}`);
  if (text === raw) return;
  if (check) process.exit(1);
  writeFileSync(path + '.tmp', text); renameSync(path + '.tmp', path);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
