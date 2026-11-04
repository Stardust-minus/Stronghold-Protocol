// tools/prepare-operator-illustrations.mjs — write the HD static-art fields (tools/assets/illustrations.mjs) into the
// committed manifests from the registry tools/assets/char-illustrations.json, like the skin import does for skins: the
// manifest is rewritten in place (hash recomputed, the generator field kept); stats.files / stats.bytes move by the new
// files the registry names (their sizes are the registry's, checked on disk), so no full asset tree is needed.
//
//   node tools/prepare-operator-illustrations.mjs --assets <dir mapped to /assets/> [--check]
//     data/assets.json (operators' 精一 / 精二 and skins) and data/assets-collab.json (collab operators, under collab/).
//     --check: exit 1 when either manifest would change (nothing written).
// The artwork itself (public/assets/char/illustration, char/portrait_hd, skins/<id>/portrait_hd.png and the collab pack's
// copies) is git-ignored like every other picture; tools/assets/hd-art/README.md rebuilds it and the registry.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { contentHash } from './assets/manifest.mjs';
import { applyIllustrations, loadIllustrationRegistry, HD_FIELDS } from './assets/illustrations.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The files and bytes the HD fields of a body name (by the registry), to move the stats by on a re-run. */
function hdFiles(body, registry) {
  const files = new Map();
  const size = (url) => {
    const m = /^\/assets\/(?:collab\/)?char\/(illustration|portrait_hd)\/(.+)_([12])\.png$/.exec(url);
    if (m) { const L = registry.chars?.[m[2]]?.[m[3] === '1' ? 'e1' : 'e2']; return m[1] === 'illustration' ? L?.illustration?.bytes : L?.hd?.bytes; }
    const s = /^\/assets\/skins\/([^/]+)\/portrait_hd\.png$/.exec(url);
    return s ? registry.skins?.[s[1]]?.hd?.bytes : undefined;
  };
  for (const rec of Object.values(body?.chars || {})) for (const k of HD_FIELDS) if (typeof rec?.[k] === 'string' && k !== 'portraitScene') files.set(rec[k], size(rec[k]) ?? 0);
  for (const rec of Object.values(body?.skins || {})) if (typeof rec?.portraitHD === 'string') files.set(rec.portraitHD, size(rec.portraitHD) ?? 0);
  return files;
}

export function rewriteManifest(manifest, { registry, assetRoot, prefix }) {
  const { version, hash, generator, stats, ...body } = manifest;
  const before = hdFiles(body, registry);
  const { body: next, files, bytes } = applyIllustrations(body, { registry, assetRoot, prefix });
  const old = [...before.values()].reduce((a, b) => a + b, 0);
  const out = { version, hash: null, generator, stats: { ...stats }, ...next };
  if (Number.isSafeInteger(stats?.files)) out.stats.files = stats.files - before.size + files.size;
  if (Number.isSafeInteger(stats?.bytes)) out.stats.bytes = stats.bytes - old + bytes;
  out.hash = prefix ? createHash('sha256').update(JSON.stringify(collabDoc(out))).digest('hex').slice(0, 12) : contentHash(next);
  return out;
}
// the collab pack's hash covers its document without the build fields (tools/collab-assets.mjs)
const collabDoc = ({ version, kind, prefix, hash, generator, stats, ...doc }) => doc;

function main(argv) {
  const at = argv.indexOf('--assets'); const check = argv.includes('--check');
  if (at < 0 || !argv[at + 1]) { console.error('usage: node tools/prepare-operator-illustrations.mjs --assets <dir> [--check]'); process.exit(2); }
  const assetRoot = resolve(argv[at + 1]); const registry = loadIllustrationRegistry();
  let changed = false;
  for (const [file, prefix] of [['data/assets.json', ''], ['data/assets-collab.json', 'collab/']]) {
    const path = join(ROOT, file); const raw = readFileSync(path, 'utf8'); const manifest = JSON.parse(raw);
    const out = rewriteManifest(manifest, { registry, assetRoot, prefix });
    const text = JSON.stringify(out) + (raw.endsWith('\n') ? '\n' : '');
    const n = Object.values(out.chars || {}).filter((c) => c.portraitHD).length + Object.values(out.chars || {}).filter((c) => c.portraitHDE2).length
      + Object.values(out.skins || {}).filter((s) => s.portraitHD).length;
    console.log(`${file}: ${n} HD looks, files ${manifest.stats?.files} → ${out.stats.files}, bytes ${manifest.stats?.bytes} → ${out.stats.bytes}${text === raw ? ' (unchanged)' : ''}`);
    if (text === raw) continue;
    changed = true;
    if (!check) { writeFileSync(path + '.tmp', text); renameSync(path + '.tmp', path); }
  }
  if (check && changed) process.exit(1);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
