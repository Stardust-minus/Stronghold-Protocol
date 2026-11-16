// tools/prepare-namecard-skins.mjs — write the 名片-only skins (tools/assets/namecard-skins.mjs) into data/assets.json from the
// registry tools/assets/namecard-skins.json, like tools/prepare-operator-dynamic-e2.mjs does for the 精二 动态立绘: the manifest is
// rewritten in place (hash recomputed, the generator field kept); stats.files / stats.bytes move by the files the registry
// names (their sizes checked on disk), so no full asset tree is needed.
//
//   node tools/prepare-namecard-skins.mjs --assets <dir mapped to /assets/> [--check]
//     --check: exit 1 when the manifest would change (nothing written).
// The files themselves (public/assets/skins/<key>/) are git-ignored like every other picture; they are unpacked from the
// local client (docs/ASSETS.md "Name-card-only skins").
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentHash } from './assets/manifest.mjs';
import { applyNamecardSkins, loadNamecardSkinRegistry, entryFiles, SECTION } from './assets/namecard-skins.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The files and bytes a body's section already names (sizes by the registry), to move the stats by on a re-run. */
function namedFiles(body, registry) {
  const files = new Map();
  for (const key of Object.keys(body?.[SECTION] || {})) {
    const R = registry.skins?.[key];
    if (R) for (const f of entryFiles({ ...R, key })) files.set(f.rel, f.bytes);
  }
  return files;
}

export function rewriteManifest(manifest, { registry, assetRoot }) {
  const { version, hash, generator, stats, ...body } = manifest;
  const before = namedFiles(body, registry);
  const { body: next, files, bytes } = applyNamecardSkins(body, { registry, assetRoot });
  const old = [...before.values()].reduce((a, b) => a + b, 0);
  const out = { version, hash: null, generator, stats: { ...stats }, ...next };
  if (Number.isSafeInteger(stats?.files)) out.stats.files = stats.files - before.size + files.size;
  if (Number.isSafeInteger(stats?.bytes)) out.stats.bytes = stats.bytes - old + bytes;
  out.hash = contentHash(next);
  return out;
}

function main(argv) {
  const at = argv.indexOf('--assets'); const check = argv.includes('--check');
  if (at < 0 || !argv[at + 1]) { console.error('usage: node tools/prepare-namecard-skins.mjs --assets <dir> [--check]'); process.exit(2); }
  const assetRoot = resolve(argv[at + 1]); const registry = loadNamecardSkinRegistry();
  const path = join(ROOT, 'data/assets.json'); const raw = readFileSync(path, 'utf8'); const manifest = JSON.parse(raw);
  const out = rewriteManifest(manifest, { registry, assetRoot });
  const text = JSON.stringify(out) + (raw.endsWith('\n') ? '\n' : '');
  const n = Object.keys(out[SECTION] || {}).length;
  console.log(`data/assets.json: ${n} 名片-only skins of ${Object.keys(registry.skins || {}).length} in the registry, files ${manifest.stats?.files} → ${out.stats.files}, bytes ${manifest.stats?.bytes} → ${out.stats.bytes}${text === raw ? ' (unchanged)' : ''}`);
  if (text === raw) return;
  if (check) process.exit(1);
  writeFileSync(path + '.tmp', text); renameSync(path + '.tmp', path);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
