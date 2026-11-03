// public/js/screens/game/early.js — which events are replayed when a field is entered late.

import { fxForm } from '../../../../shared/protocol.js';

export const STATE_EV = new Set(['spawn', 'die', 'deploy', 'status', 'skill']);

/** Event tuples replayed when a field is entered late: the state-bearing kinds and the fx that change an enemy's model
 *  form (shared/protocol.js fxForm — the field meta's UnitInfo `form` predates them). */
export const keepEarly = (e) => Array.isArray(e) && (STATE_EV.has(e[0]) || fxForm(e) !== undefined);

/** Tuples kept per field while the view does not show it (screens/game.js onEv). */
export const EARLY_MAX = 1500;

/**
 * Bound a field's early buffer (`buf`, in place) to `max` tuples without losing who is on the field: until 2026-11-02 the
 * oldest tuples were cut, and those are the spawns of the battle's opening — a 联防 entered late (a busy field toggles
 * statuses hundreds of times a second) then had operators with no UnitInfo, drawn as the enemy-styled placeholder (render/
 * app.js createUnknown, the owner's report 「联防的时候，干员有概率变成红色水滴」, no panel). Superseded toggles go first —
 * of the 'status' tuples only the last per (unit, status), of the 'skill' tuples the last per unit (what the view ends up
 * showing; battle/runner.js compactHeld) —, then the oldest tuples but the spawns; the spawns are bounded by the units.
 * @param {any[]} buf @param {number} [max]
 */
export function trimEarly(buf, max = EARLY_MAX) {
  if (!Array.isArray(buf) || buf.length <= max) return buf;
  const last = new Map();
  buf.forEach((x, i) => {
    if (x[0] === 'status') last.set(`s:${x[1]}:${x[2]}`, i);
    else if (x[0] === 'skill') last.set(`k:${x[1]}`, i);
  });
  let kept = buf.filter((x, i) => (x[0] === 'status' ? last.get(`s:${x[1]}:${x[2]}`) === i : x[0] === 'skill' ? last.get(`k:${x[1]}`) === i : true));
  let over = kept.length - max;
  if (over > 0) kept = kept.filter((x) => x[0] === 'spawn' || over-- <= 0);
  buf.length = 0;
  buf.push(...kept);
  return buf;
}

/**
 * What the SOUND gets of that replay: the 'spawn' tuples alone, which teach the audio who is on the field. The buffered
 * list is every spawn, die, deploy, status and skill since the field's m.field — up to 1500 of them, while the view was not
 * showing it — so handing it to the audio would play the old deaths, deploy lines and skill cues all at once on entering
 * (GitHub PR #292 by @LimitlessHPPK handed over the whole list; its hold of a cast that arrives before its unit,
 * audio.js `pendingSkill`, is what the live path needs, and `onEv` already forwards the full list).
 */
export const audioEarly = (early) => (Array.isArray(early) ? early.filter((e) => Array.isArray(e) && e[0] === 'spawn') : []);

/** Replace, never merge, the shown field's opening stats from m.field; compact b.snap never changes this cache. */
export function snapshotStats(snap) {
  const units = new Map();
  if (Array.isArray(snap?.unitStats) && snap.unitStats.length) {
    const listed = new Set((Array.isArray(snap.units) ? snap.units : []).map(u => Array.isArray(u) ? u[0] : u?.id));
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
