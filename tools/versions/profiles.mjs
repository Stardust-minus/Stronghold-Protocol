// tools/versions/profiles.mjs — load the build profile of an official version (shared/versions.js; docs/DATA.md "Official
// versions (M0)"). A profile is tools/versions/<slug>.mjs:
//   { id, season, pins, adapters, research, tables, pools?, config: { hiddenCore: { single, multi }, rules? },
//     expect: { bonds, bands, visibleNonDiy, triggerDeviations } }
//   pins      null (master, .cache/gamedata/) or { default: <sha>, <group>: <sha> … } — the commit of each file group
//             (pinGroupOf), cached in .cache/gamedata@<sha>/
//   lateOperators  { sha, charIds, replace? }, a list of them, or omitted — operators newer than the pinned tables: their
//             character, skill, range and module records (nothing else) are read from `sha`, cached in
//             .cache/gamedata@<sha>/. A non-default version takes each of the default's 自选 operators it lacks from the
//             commit the default reads it from, so the records match the default's; the summons those records name
//             come along when the pin lacks them. `replace: [charId…]` (only ids of the same entry) lets an entry
//             overwrite an operator the pin already has, modules included (麒麟R夜刀's EXE-Y)
//   diyBonds / diyTalentNotes  { <charId>: … } or omitted — replace an entry of tools/build-data.mjs DIY_EXTRA_BONDS /
//             DIY_TALENT_NOTES (the deliberate 自选 bonds and talent lines) where the version lacks a bond they name
//   adapters  names in tools/versions/adapters.mjs, applied in this order to the loaded activity_table
//   research  the version's research directory (falls back to docs/research/, with a warning) or null = docs/research/
//   tables    'default' (the 下半-measured tables of tools/build-data.mjs) or { stock, shopDraft, tacticDraft,
//             bountyDrafts } with null = left out
//   pools     { <pool id>: [charId…] } replaces the operators tools/build-data.mjs writes for a hand-written chess pool,
//             where the version's trait text names others (omitted = the default's)
//   config    hiddenCore thresholds; `rules` the rule switches a non-default build writes into config.version =
//             { id, family, rules } ({} = the default's rules)
//   expect    the counts validateAll checks; triggerDeviations 'default' (every deliberate deviation meets its official
//             TAKE_DAMAGE row), 'present' (those of the operators the version has) or 'none' (no TAKE_DAMAGE row at all)

import { VERSIONS, versionById, versionSlug } from '../../shared/versions.js';

/** The official commit a file is read from groups files that change together (pins[group] ?? pins.default). */
const PIN_GROUPS = Object.freeze({
  'excel/activity_table.json': 'activity',
  'excel/character_table.json': 'character',
  'excel/skill_table.json': 'character',
  'excel/uniequip_table.json': 'character',
  'excel/battle_equip_table.json': 'character',
  'excel/range_table.json': 'range',
  'excel/enemy_handbook_table.json': 'enemy',
  'levels/enemydata/enemy_database.json': 'enemy',
});

/**
 * The pin group of a gamedata path (relative to zh_CN/gamedata/), or null for a file no group names.
 * @param {string} rel
 * @returns {string | null}
 */
export function pinGroupOf(rel) {
  if (Object.hasOwn(PIN_GROUPS, rel)) return PIN_GROUPS[rel];
  if (rel.startsWith('levels/activities/')) return 'levels';
  return null;
}

/**
 * The commit a profile reads a gamedata file from, or null for master.
 * @param {{ pins: Record<string, string> | null }} profile
 * @param {string} rel
 * @returns {string | null}
 */
export function pinnedShaOf(profile, rel) {
  if (!profile.pins) return null;
  const group = pinGroupOf(rel);
  return (group && profile.pins[group]) || profile.pins.default || null;
}

/**
 * The registry entry and the build profile of a version id. Throws on an unknown id or a profile that does not match
 * its entry.
 * @param {string} id
 */
export async function loadProfile(id) {
  const entry = versionById(id);
  if (!entry) throw new Error(`unknown version ${JSON.stringify(id)} (valid: ${VERSIONS.map((v) => v.id).join(', ')})`);
  const slug = versionSlug(entry);
  const profile = (await import(`./${slug}.mjs`)).default;
  if (!profile || profile.id !== entry.id || profile.season !== entry.season) {
    throw new Error(`tools/versions/${slug}.mjs: id / season ${profile?.id} / ${profile?.season} do not match ${entry.id} / ${entry.season}`);
  }
  return { entry, profile, slug };
}
