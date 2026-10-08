// Resolve only admitted appearances from the release manifest, never an arbitrary client-provided URL.
import { skinFor, skinIdFor } from '../../../shared/skins.js';
export function appearanceEntry(manifest, charId, skinId) {
  if (!skinFor(charId, skinId)) return null;
  const entry = manifest?.skins && Object.hasOwn(manifest.skins, skinId) ? manifest.skins[skinId] : null;
  return entry?.charId === charId ? entry : null;
}
export function appearanceRecord(record, skinId) {
  return record && skinFor(record.charId || record.assets?.spine, skinId) ? { ...record, skinId } : record;
}
export function ownAppearance(record, priv) {
  return appearanceRecord(record, skinIdFor(priv?.skins, record?.charId || record?.assets?.spine));
}
