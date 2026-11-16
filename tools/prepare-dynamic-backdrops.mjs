// tools/prepare-dynamic-backdrops.mjs — write the 动态立绘's official camera frame and baked backdrop layers
// (tools/assets/dynamic-backdrops.mjs) into data/assets.json from the registry tools/assets/dynamic-backdrops.json, like
// tools/prepare-operator-dynamic-e2.mjs: the manifest is rewritten in place (hash recomputed, the generator field kept);
// stats.files / stats.bytes move by the layer files newly named (their sizes checked on disk) and by those no longer
// named (a PRTS composite the bake replaced: its size from the registry's `replaces`), so no full asset tree is needed.
//
//   node tools/prepare-dynamic-backdrops.mjs --assets <dir mapped to /assets/> [--check]
//     --check: exit 1 when the manifest would change (nothing written).
// tools/prepare-operator-dynamic-e2.mjs applies the 精二 part of it too (it rebuilds chars[id].dynamicE2 from its own registry).
// The pictures (public/assets/skins/<id>/dynamic/, public/assets/char/dynamic/<charId>_2/) are git-ignored like every
// other picture; docs/ASSETS.md "Dynamic illustrations" says how they are baked.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from './assets/manifest.mjs';
import { applyDynamicBackdrops, loadDynamicBackdrops } from './assets/dynamic-backdrops.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The backdrop layer URLs a body names (skins' dynamic, operators' dynamicE2). */
function namedLayers(body) {
  const urls = new Set();
  for (const [kind, field] of [['skins', 'dynamic'], ['chars', 'dynamicE2']]) {
    for (const rec of Object.values(body?.[kind] || {})) {
      for (const k of ['background', 'foreground']) if (typeof rec?.[field]?.[k] === 'string') urls.add(rec[field][k]);
    }
  }
  return urls;
}

/** The bytes of a layer file no longer named: the registry's record of what a baked layer replaced. */
function replacedBytes(registry, url) {
  for (const [kind, dir] of [['skins', (id) => `/assets/skins/${id}/dynamic/`], ['chars', (id) => `/assets/char/dynamic/${id}_2/`]]) {
    for (const [id, R] of Object.entries(registry[kind] || {})) {
      for (const r of R.replaces || []) if (url === dir(id) + r.name && Number.isSafeInteger(r.bytes)) return r.bytes;
    }
  }
  return 0;
}

export function rewriteManifest(manifest, { registry, assetRoot }) {
  const { version, hash, generator, stats, ...body } = manifest;
  const before = namedLayers(body);
  const { body: next, files } = applyDynamicBackdrops(body, { registry, assetRoot });
  const after = namedLayers(next);
  const added = [...files].filter(([rel]) => after.has(`/assets/${rel}`) && !before.has(`/assets/${rel}`));
  const removed = [...before].filter((u) => !after.has(u));
  const out = { version, hash: null, generator, stats: { ...stats }, ...next };
  if (Number.isSafeInteger(stats?.files)) out.stats.files = stats.files + added.length - removed.length;
  if (Number.isSafeInteger(stats?.bytes)) out.stats.bytes = stats.bytes + added.reduce((n, [, b]) => n + b, 0) - removed.reduce((n, u) => n + replacedBytes(registry, u), 0);
  out.hash = contentHash(next);
  return out;
}

function main(argv) {
  const at = argv.indexOf('--assets'); const check = argv.includes('--check');
  if (at < 0 || !argv[at + 1]) { console.error('usage: node tools/prepare-dynamic-backdrops.mjs --assets <dir> [--check]'); process.exit(2); }
  const assetRoot = resolve(argv[at + 1]); const registry = loadDynamicBackdrops();
  const path = join(ROOT, 'data/assets.json'); const raw = readFileSync(path, 'utf8'); const manifest = JSON.parse(raw);
  const out = rewriteManifest(manifest, { registry, assetRoot });
  const text = JSON.stringify(out) + (raw.endsWith('\n') ? '\n' : '');
  const count = (kind, field, k) => Object.values(out[kind] || {}).filter((r) => r?.[field]?.[k]).length;
  console.log(`data/assets.json: frames ${count('skins', 'dynamic', 'frame')} skins + ${count('chars', 'dynamicE2', 'frame')} 精二, `
    + `backgrounds ${count('skins', 'dynamic', 'background')} + ${count('chars', 'dynamicE2', 'background')}, foregrounds ${count('skins', 'dynamic', 'foreground')} + ${count('chars', 'dynamicE2', 'foreground')}; `
    + `files ${manifest.stats?.files} → ${out.stats.files}, bytes ${manifest.stats?.bytes} → ${out.stats.bytes}${text === raw ? ' (unchanged)' : ''}`);
  if (text === raw) return;
  if (check) process.exit(1);
  writeFileSync(path + '.tmp', text); renameSync(path + '.tmp', path);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
