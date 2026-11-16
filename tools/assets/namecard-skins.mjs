// tools/assets/namecard-skins.mjs — 名片-only skins (2026-11-16, the owner: 阿米娅's 术师 / 近卫 skins on the 名片 only): appearances
// of forms this game does not field — skin_table charId char_002_amiya, tmplId char_002_amiya (术师) / char_1001_amiya2 (近卫) —
// unpacked from the local client like the skins' and the 精二 动态立绘 (docs/ASSETS.md "Name-card-only skins"), from the
// committed registry tools/assets/namecard-skins.json. They are never in shared/skin-catalogue.js / OPERATOR_SKINS: no one
// wears them in a match; public/js/ui/namecards.js NAMECARD_SKINS lists the ids the 名片 picker offers.
//
// Manifest section (only records whose every file is on disk with the registry's size):
//   namecardSkins: { [key]: { illustration, illustrationSize, portrait, portraitBox?, dynamic?: { skel, atlas, textures, pma,
//     anims: { idle }, animations, bounds, frames? } } } — the fields of a skins[key] record the 名片 reads.
// Files: /assets/skins/<key>/<registry names> (dynamic/ for the Spine files), as an outfit's.
import { readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REGISTRY_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'namecard-skins.json');
export const SECTION = 'namecardSkins';

/** The committed registry (an empty one when the file is missing: a checkout before 2026-11-16). */
export function loadNamecardSkinRegistry(path = REGISTRY_PATH) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { version: 1, skins: {} }; throw e; }
}

/** The asset-relative directory of a 名片-only skin. */
export const namecardSkinDir = (key) => `skins/${key}`;

function onDisk(assetRoot, rel, bytes) {
  if (!assetRoot) return true;
  try { return statSync(join(assetRoot, rel)).size === bytes; } catch { return false; }
}

const isName = (n) => typeof n === 'string' && /^[\w.-]+(\/[\w.-]+)?$/.test(n) && !n.includes('..');
const isFile = (f) => f && isName(f.name) && Number.isSafeInteger(f.bytes) && f.bytes > 0 && /^[0-9a-f]{64}$/.test(f.sha256 || '');
const isRect = (r) => r && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(r[k])) && r.width > 0 && r.height > 0;
const isSize = (s) => Array.isArray(s) && s.length === 2 && s.every((v) => Number.isSafeInteger(v) && v > 0);
/** A registry entry the manifest may name: its 立绘 and half-body art, a 动态立绘 with an idle clip and bounds when it has one. */
export function validEntry(R) {
  if (!R || !/^[a-z0-9_]+$/i.test(R.key || '') || !isFile(R.illustration) || !isSize(R.illustration.size) || !isFile(R.portrait)) return false;
  const D = R.dynamic;
  return !D || (isFile(D.skel) && isFile(D.atlas) && Array.isArray(D.textures) && D.textures.length > 0 && D.textures.every(isFile)
    && typeof D.pma === 'boolean' && D.animations && Object.hasOwn(D.animations, D.idle) && isRect(D.bounds)
    && (D.frames == null || (isRect(D.frames.avatar) && isRect(D.frames.portrait))));
}

/** Every file of an entry, asset-relative, with its registry size. */
export function entryFiles(R) {
  const dir = namecardSkinDir(R.key);
  const D = R.dynamic;
  return [R.illustration, R.portrait, ...(D ? [D.skel, D.atlas, ...D.textures] : [])].map((f) => ({ rel: `${dir}/${f.name}`, bytes: f.bytes }));
}

/**
 * Set `namecardSkins` on a manifest body (a copy; the input is not changed; the section is rebuilt from the registry —
 * absent when no record is complete). `assetRoot`: the folder the /assets/ URLs map to (files checked by size; null =
 * trust the registry).
 * @returns {{ body: any, files: Set<string>, bytes: number, looks: number }} files/bytes: the files named (asset-relative)
 */
export function applyNamecardSkins(body, { registry = loadNamecardSkinRegistry(), assetRoot = null } = {}) {
  const { [SECTION]: _old, ...out } = body || {};
  const files = new Set(); let bytes = 0;
  const section = {};
  for (const [key, R0] of Object.entries(registry.skins || {})) {
    const R = { ...R0, key };
    if (!validEntry(R)) continue;
    const all = entryFiles(R);
    if (!all.every((f) => onDisk(assetRoot, f.rel, f.bytes))) continue;
    const url = (f) => `/assets/${namecardSkinDir(key)}/${f.name}`;
    const rec = { illustration: url(R.illustration), illustrationSize: R.illustration.size, portrait: url(R.portrait) };
    if (Array.isArray(R.portraitBox) && R.portraitBox.length === 4 && R.portraitBox.every(Number.isFinite)) rec.portraitBox = R.portraitBox;
    const D = R.dynamic;
    if (D) {
      rec.dynamic = { skel: url(D.skel), atlas: url(D.atlas), textures: D.textures.map(url), pma: D.pma, anims: { idle: D.idle },
        animations: D.animations, bounds: D.bounds, ...(D.frames ? { frames: { avatar: D.frames.avatar, portrait: D.frames.portrait } } : {}) };
    }
    section[key] = rec;
    for (const f of all) { files.add(f.rel); bytes += f.bytes; }
  }
  if (Object.keys(section).length) out[SECTION] = section;
  return { body: out, files, bytes, looks: Object.keys(section).length };
}
