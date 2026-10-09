// public/js/screens/game/early.js — which events are replayed when a field is entered late.

import { fxForm } from '../../../../shared/protocol.js';

export const STATE_EV = new Set(['spawn', 'die', 'deploy', 'status', 'skill']);

/** Event tuples replayed when a field is entered late: the state-bearing kinds and the fx that change an enemy's model
 *  form (shared/protocol.js fxForm — the field meta's UnitInfo `form` predates them). */
export const keepEarly = (e) => Array.isArray(e) && (STATE_EV.has(e[0]) || fxForm(e) !== undefined);

/**
 * What the SOUND gets of that replay: the 'spawn' tuples alone, which teach the audio who is on the field. The buffered
 * list is every spawn, die, deploy, status and skill since the field's m.field — up to 1500 of them, while the view was not
 * showing it — so handing it to the audio would play the old deaths, deploy lines and skill cues all at once on entering
 * (GitHub PR #292 by @LimitlessHPPK handed over the whole list; its hold of a cast that arrives before its unit,
 * audio.js `pendingSkill`, is what the live path needs, and `onEv` already forwards the full list).
 */
export const audioEarly = (early) => (Array.isArray(early) ? early.filter((e) => Array.isArray(e) && e[0] === 'spawn') : []);

/** Replace, never merge, the shown field's server stats; legacy snapshots clear the previous values too. */
export function snapshotStats(snap) {
  const units = new Map();
  if (Array.isArray(snap?.unitStats) && snap.unitStats.length) {
    const listed = new Set((Array.isArray(snap.units) ? snap.units : []).filter(Array.isArray).map(t => t[0]));
    for (const entry of snap.unitStats) {
      if (entry && Number.isInteger(entry.id) && listed.has(entry.id)) units.set(entry.id, entry);
    }
  }
  return { fieldId: typeof snap?.fieldId === 'string' ? snap.fieldId : null, units };
}

/** An initial m.field may be empty: deployed piece identities arrive through spawn events after the battle starts. */
export function notePieceUnits(units, { infos = [], events = [] } = {}) {
  const note = u => { if (u && Number.isInteger(u.id) && Number.isInteger(u.uid) && u.ownerId != null) units.set(u.id, u); };
  for (const u of Array.isArray(infos) ? infos : []) note(u);
  for (const e of Array.isArray(events) ? events : []) if (Array.isArray(e) && e[0] === 'spawn') note(e[1]);
  return units;
}

/** A battle card, including an own prep piece left open: ids are field-local and piece uids are owner-local. */
export function snapshotUnitStats(stats, field, { id = null, pieceUid = null, ownerId = null, units = null } = {}) {
  if (!field?.fieldId || field.prep || stats?.fieldId !== field.fieldId) return null;
  const infos = units instanceof Map ? [...units.values()] : Array.isArray(field.units) ? field.units : [];
  const unitId = id ?? (Number.isInteger(pieceUid) && ownerId != null
    ? infos.find(u => u && u.uid === pieceUid && u.ownerId === ownerId && stats.units.has(u.id))?.id : null);
  const entry = unitId != null ? stats.units.get(unitId) : null;
  return entry ? { ...entry, src: 'battle' } : null;
}
