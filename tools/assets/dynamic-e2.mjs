// tools/assets/dynamic-e2.mjs — the operators' own 精二 动态立绘 (2026-11-16, the owner: 「有一部分干员精英II立绘也是动态的，
// 现在没有显示动态，例如塔露拉」): the official default 精二 look of skin_table (charSkins[<charId>#2], dynIllustId set — 27
// operators in the 11-06 client), unpacked from the local client's arts/dynchars/<charId>_2.ab like the skins' 61
// (straight pages except `pma`, lossless WebP pages whose RGBA equals the decoded texture), from the committed registry
// tools/assets/char-dynamic-e2.json (docs/ASSETS.md "Dynamic illustrations").
//
// Manifest field (only where the operator has its 精二 pictures and every file is on disk with the registry's size):
//   chars[id].dynamicE2: { skel, atlas, textures, pma, anims: { idle }, animations, bounds, frames: { avatar, portrait } } —
//     the record of a skin's `dynamic` (public/js/ui/dynamicFraming.js e2Dynamic); `frames` are the official 精二 avatar and
//     180×360 portrait in skeleton space, matched offline against a render of the Idle at t = 0.
// Files: /assets/char/dynamic/<charId>_2/<registry names>.
import { readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REGISTRY_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'char-dynamic-e2.json');
export const FIELD = 'dynamicE2';

/** The committed registry (an empty one when the file is missing: a checkout before 2026-11-16). */
export function loadDynamicE2Registry(path = REGISTRY_PATH) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { version: 1, chars: {} }; throw e; }
}

/** The asset-relative directory of an operator's 精二 动态立绘. */
export const dynamicE2Dir = (id) => `char/dynamic/${id}_2`;

function onDisk(assetRoot, rel, bytes) {
  if (!assetRoot) return true;
  try { return statSync(join(assetRoot, rel)).size === bytes; } catch { return false; }
}

const isFile = (f) => f && typeof f.name === 'string' && /^[\w.-]+$/.test(f.name) && Number.isSafeInteger(f.bytes) && f.bytes > 0;
const isRect = (r) => r && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(r[k])) && r.width > 0 && r.height > 0;
/** A registry entry the manifest may name: its files, an idle clip among its clips, bounds and both crops. */
export function validEntry(R) {
  return !!R && isFile(R.skel) && isFile(R.atlas) && Array.isArray(R.textures) && R.textures.length > 0 && R.textures.every(isFile)
    && typeof R.pma === 'boolean' && R.animations && Object.hasOwn(R.animations, R.idle) && isRect(R.bounds)
    && isRect(R.frames?.avatar) && isRect(R.frames?.portrait);
}

/**
 * Add `dynamicE2` to a manifest body's operators (a copy; the input is not changed; a stale one is dropped first).
 * `assetRoot`: the folder the /assets/ URLs map to (files checked by size; null = trust the registry).
 * @returns {{ body: any, files: Set<string>, bytes: number, looks: number }} files/bytes: the files named (asset-relative)
 */
export function applyDynamicE2(body, { registry = loadDynamicE2Registry(), assetRoot = null } = {}) {
  const out = { ...body }; const files = new Set(); let bytes = 0, looks = 0;
  if (!body?.chars) return { body: out, files, bytes, looks };
  out.chars = { ...body.chars };
  for (const [id, rec] of Object.entries(body.chars)) {
    if (!rec || typeof rec !== 'object') continue;
    let next = Object.hasOwn(rec, FIELD) ? Object.fromEntries(Object.entries(rec).filter(([k]) => k !== FIELD)) : null;
    const R = registry.chars?.[id];
    if (validEntry(R) && (rec.avatarE2 || rec.portraitE2)) {
      const dir = dynamicE2Dir(id);
      const all = [R.skel, R.atlas, ...R.textures];
      if (all.every((f) => onDisk(assetRoot, `${dir}/${f.name}`, f.bytes))) {
        next ??= { ...rec };
        const url = (f) => `/assets/${dir}/${f.name}`;
        next[FIELD] = { skel: url(R.skel), atlas: url(R.atlas), textures: R.textures.map(url), pma: R.pma, anims: { idle: R.idle },
          animations: R.animations, bounds: R.bounds, frames: { avatar: R.frames.avatar, portrait: R.frames.portrait } };
        for (const f of all) { files.add(`${dir}/${f.name}`); bytes += f.bytes; }
        looks++;
      }
    }
    if (next) out.chars[id] = next;
  }
  return { body: out, files, bytes, looks };
}
