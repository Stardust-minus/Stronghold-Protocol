// tools/assets/dynamic-backdrops.mjs — the official camera frame of every 动态立绘 and its baked backdrop (2026-11-16, the
// owner: 「批准，都照常」 — the scene layers around the character, as the client draws them): from the committed registry
// tools/assets/dynamic-backdrops.json (docs/ASSETS.md "Dynamic illustrations").
//
// A client 动态立绘 is a whole scene: the Spine character, the MeshRenderer layers before and behind it (L2D effect
// shaders) and particles, seen through a camera that shows a square — side 2 × DynIllust._cameraSize, centred on the
// prefab root's offset reversed. The registry holds, per skin (skins[id].dynamic) and per operator's own 精二 one
// (chars[id].dynamicE2):
//   frame: { x, y, width, height } — that square in y-up skeleton space (public/js/ui/dynamicFraming.js dynamicFrame);
//   background / foreground (optional): { name, bytes, sha256, width, height } — one WebP each of the always-on layers
//     behind / in front of the character (not the particles, not the Interact / Special ones), baked offline to exactly the
//     frame's square, in the record's own folder (/assets/skins/<id>/dynamic/, /assets/char/dynamic/<charId>_2/);
//   prts: 'replaced' | 'kept' — for the 9 skins that had PRTS's composite (bg.png / fg.png): whether the bake replaced it.
// A record keeps a background / foreground it already names unless the registry names its own (PRTS 'kept').
import { readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REGISTRY_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'dynamic-backdrops.json');
const LAYERS = ['background', 'foreground'];

/** The committed registry (an empty one when the file is missing: a checkout before 2026-11-16). */
export function loadDynamicBackdrops(path = REGISTRY_PATH) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { version: 1, skins: {}, chars: {} }; throw e; }
}

const isRect = (r) => !!r && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(r[k])) && r.width > 0 && r.height > 0;
const isFile = (f) => !!f && typeof f.name === 'string' && /^[\w.-]+$/.test(f.name) && Number.isSafeInteger(f.bytes) && f.bytes > 0;
/** A registry entry the manifest may use: a frame, and well-formed layer files where named. */
export function validBackdrop(R) {
  return !!R && isRect(R.frame) && LAYERS.every((k) => R[k] == null || isFile(R[k]));
}

/** The asset-relative folder of a record's files: a skin's dynamic/, an operator's 精二 one. */
export const backdropDir = (kind, id) => (kind === 'skins' ? `skins/${id}/dynamic` : `char/dynamic/${id}_2`);

function onDisk(assetRoot, rel, bytes) {
  if (!assetRoot) return true;
  try { return statSync(join(assetRoot, rel)).size === bytes; } catch { return false; }
}

/**
 * The record `rec` (a `dynamic` / `dynamicE2`) with the registry entry R applied: its frame, and each layer the registry
 * names whose file is on disk with its size (`assetRoot` null = trust the registry). `files`: Map of the named layer
 * files (asset-relative → bytes), filled.
 */
export function withBackdrop(rec, R, kind, id, { assetRoot = null, files = new Map() } = {}) {
  if (!rec || !validBackdrop(R)) return rec;
  const out = { ...rec, frame: { x: R.frame.x, y: R.frame.y, width: R.frame.width, height: R.frame.height } };
  for (const k of LAYERS) {
    const f = R[k];
    if (!f) continue;
    const rel = `${backdropDir(kind, id)}/${f.name}`;
    if (!onDisk(assetRoot, rel, f.bytes)) continue;
    out[k] = `/assets/${rel}`; files.set(rel, f.bytes);
  }
  return out;
}

/** Where a kind's records are: skins[id].dynamic, chars[id].dynamicE2. */
export const BACKDROP_FIELDS = Object.freeze({ skins: 'dynamic', chars: 'dynamicE2' });

/**
 * Apply the registry to a manifest body (a copy; the input is not changed): skins[id].dynamic and chars[id].dynamicE2
 * (`kinds`: only those). @returns {{ body: any, files: Map<string, number>, records: number }} files: the layer files named
 * (asset-relative → bytes)
 */
export function applyDynamicBackdrops(body, { registry = loadDynamicBackdrops(), assetRoot = null, kinds = ['skins', 'chars'] } = {}) {
  const out = { ...body }; const files = new Map(); let records = 0;
  for (const kind of kinds) {
    const field = BACKDROP_FIELDS[kind];
    if (!field || !body?.[kind]) continue;
    out[kind] = { ...body[kind] };
    for (const [id, R] of Object.entries(registry[kind] || {})) {
      const rec = body[kind][id];
      if (!rec?.[field] || !validBackdrop(R)) continue;
      out[kind][id] = { ...rec, [field]: withBackdrop(rec[field], R, kind, id, { assetRoot, files }) };
      records++;
    }
  }
  return { body: out, files, records };
}
