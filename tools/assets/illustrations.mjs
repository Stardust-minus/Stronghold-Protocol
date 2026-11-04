// tools/assets/illustrations.mjs — HD static art (rel30, the owner's decision of 2026-11-04 「来点高清立绘」): the original
// 立绘 of every operator look (精一 `_1`, 精二 `_2`; PRTS 「立绘 <name> <1|2>.png」, sha1-verified) and where the in-game
// 180×360 portrait sits in it, from the committed registry tools/assets/char-illustrations.json (built by
// tools/assets/hd-art/: prts_meta.py → prts_get.py → identity.py → portrait_box.py; docs/ASSETS.md "HD static art").
//
// Manifest fields (only where the look has its portrait and the files are on disk with the registry's size; a look without
// them falls back to `portrait` / `portraitE2` exactly as before; portraitHD only where it is at least as sharp as the portrait):
//   chars[id]: illustration / illustrationE2, illustrationSize / illustrationSizeE2 [W, H], portraitBox / portraitBoxE2
//              [x, y, w, h] fractions of [W, H] (the portrait's area; w·W : h·H = 1 : 2, may run past an edge),
//              portraitHD / portraitHDE2 (the 立绘 cropped at the box, native resolution, lossless), portraitHDSize(E2),
//              portraitScene / portraitSceneE2 (true: the 立绘 has an opaque scene behind the character, as for skins)
//   skins[id]: illustrationSize, portraitBox, portraitHD, portraitHDSize, portraitScene (true: the skin's 立绘 has an opaque
//              scene behind the character; portraitHD is then a cut-out with the in-game portrait's alpha, upscaled)
// The collab pack (data/assets-collab.json) takes the same fields under its /assets/collab/ prefix.
import { readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REGISTRY_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'char-illustrations.json');
export const PHASES = Object.freeze([['e1', '1', ''], ['e2', '2', 'E2']]);

/** The committed registry (an empty one when the file is missing: a checkout before rel30). */
export function loadIllustrationRegistry(path = REGISTRY_PATH) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { version: 1, chars: {}, skins: {} }; throw e; }
}

/** The asset-relative files of an operator look / a skin (prefix '' or 'collab/'). */
export const charFiles = (prefix, id, ph) => ({ illustration: `${prefix}char/illustration/${id}_${ph}.png`, hd: `${prefix}char/portrait_hd/${id}_${ph}.png` });
export const skinHdFile = (id) => `skins/${id}/portrait_hd.png`;

const fr = (v) => Math.round(v * 1e6) / 1e6;
export const boxFraction = (box, [W, H]) => [fr(box[0] / W), fr(box[1] / H), fr(box[2] / W), fr(box[3] / H)];

function onDisk(assetRoot, rel, bytes) {
  if (!assetRoot) return true;
  try { return statSync(join(assetRoot, rel)).size === bytes; } catch { return false; }
}

/** The fields this module writes (stripped first, so a re-run never keeps a stale one). */
export const HD_FIELDS = Object.freeze(['illustration', 'illustrationE2', 'illustrationSize', 'illustrationSizeE2', 'portraitBox', 'portraitBoxE2',
  'portraitHD', 'portraitHDE2', 'portraitHDSize', 'portraitHDSizeE2', 'portraitScene', 'portraitSceneE2']);
const strip = (rec, keep = []) => Object.fromEntries(Object.entries(rec).filter(([k]) => keep.includes(k) || !HD_FIELDS.includes(k)));

// a look: its box in the 立绘 always; `hd` (the native crop) only where the 立绘 is at least as detailed as the portrait
// there (box ≥ 180 px wide) — a narrower region would make portraitHD coarser than today's portrait (it then keeps it)
const validLook = (L) => L && Array.isArray(L.box) && L.box.length === 4 && L.box.every(Number.isFinite) && L.box[2] > 0 && L.box[3] === 2 * L.box[2]
  && Array.isArray(L.illustration?.size);
const hasHd = (L) => Array.isArray(L.hd?.size) && Number.isSafeInteger(L.hd?.bytes);

/**
 * Add the HD fields to a manifest body (a copy; the input is not changed). `assetRoot`: the folder the /assets/ URLs map to
 * (files are checked by size; null = trust the registry). `prefix`: '' for data/assets.json, 'collab/' for the collab pack.
 * @returns {{ body: any, files: Set<string>, bytes: number, looks: number }} files/bytes: the new files (asset-relative)
 */
export function applyIllustrations(body, { registry = loadIllustrationRegistry(), assetRoot = null, prefix = '' } = {}) {
  const out = { ...body }; const files = new Set(); let bytes = 0, looks = 0;
  if (body?.chars) {
    out.chars = { ...body.chars };
    for (const [id, rec] of Object.entries(body.chars)) {
      if (!rec || typeof rec !== 'object') continue;
      const R = registry.chars?.[id];
      let next = HD_FIELDS.some((k) => Object.hasOwn(rec, k)) ? strip(rec) : null;
      if (next) out.chars[id] = next;
      if (!R) continue;
      for (const [k, ph, sfx] of PHASES) {
        const L = R[k]; const field = sfx ? 'portraitE2' : 'portrait';
        if (!validLook(L) || !rec[field] || !Number.isSafeInteger(L.illustration.bytes)) continue;
        const f = charFiles(prefix, id, ph);
        if (!onDisk(assetRoot, f.illustration, L.illustration.bytes)) continue;
        const hd = hasHd(L) && onDisk(assetRoot, f.hd, L.hd.bytes);
        next ??= strip(rec);
        Object.assign(next, { [`illustration${sfx}`]: `/assets/${f.illustration}`, [`illustrationSize${sfx}`]: L.illustration.size,
          [`portraitBox${sfx}`]: boxFraction(L.box, L.illustration.size),
          ...(hd ? { [`portraitHD${sfx}`]: `/assets/${f.hd}`, [`portraitHDSize${sfx}`]: L.hd.size } : {}),
          // the 立绘 has an opaque scene behind the character (as for skins): the client keeps the portrait's silhouette
          ...(L.scene ? { [`portraitScene${sfx}`]: true } : {}) });
        files.add(f.illustration); bytes += L.illustration.bytes; looks++;
        if (hd) { files.add(f.hd); bytes += L.hd.bytes; }
      }
      if (next) out.chars[id] = next;
    }
  }
  if (body?.skins && !prefix) {
    out.skins = { ...body.skins };
    for (const [id, rec] of Object.entries(body.skins)) {
      if (!rec || typeof rec !== 'object') continue;
      const L = registry.skins?.[id];
      // a skin keeps its own `illustration` (the PRTS skin import's): only the derived fields are rewritten
      if (HD_FIELDS.some((k) => k !== 'illustration' && Object.hasOwn(rec, k))) out.skins[id] = strip(rec, ['illustration']);
      if (!validLook(L) || !rec.illustration || !rec.portrait) continue;
      const hdRel = skinHdFile(id);
      const hd = hasHd(L) && onDisk(assetRoot, hdRel, L.hd.bytes);
      out.skins[id] = { ...strip(rec, ['illustration']), illustrationSize: L.illustration.size, portraitBox: boxFraction(L.box, L.illustration.size),
        ...(hd ? { portraitHD: `/assets/${hdRel}`, portraitHDSize: L.hd.size } : {}), ...(L.scene ? { portraitScene: true } : {}) };
      looks++;
      if (hd) { files.add(hdRel); bytes += L.hd.bytes; }
    }
  }
  return { body: out, files, bytes, looks };
}
