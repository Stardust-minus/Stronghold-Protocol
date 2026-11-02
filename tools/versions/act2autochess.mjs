// tools/versions/act2autochess.mjs — build profile of the default version, 第二期下半: 盟约·下半 (act2autochess) in its
// final state V2_2 (docs/DATA.md "Official versions (M0)", DESIGN §35.22): the research in docs/research/, the 下半-measured
// tables of tools/build-data.mjs, and no config.version. Kengxxiao/ArknightsGameData dropped AUTOCHESS_SEASON from
// activity_table with client 2.7.91 (08ba2aea, 2026-11-01), so master cannot build the mode any more. Every table stays
// at 17759cc8 (2026-10-08), the commit this data was built from. The season lasts until fe7d8d05 (2026-10-24), but
// bee3f83c (2026-10-14) changed 克莱门莎 S3's projectile_life_time from 5 to 3.5, which this data has not taken.

export default Object.freeze({
  id: 'act2autochess',
  season: 'act2autochess',
  pins: Object.freeze({ default: '17759cc8cdf37388414145d16262a3a06f3ab25e' }),
  // 塔露拉 (2026-11-01) is newer than the pin; only her own records come from the later commit, so no other operator moves
  lateOperators: Object.freeze({ sha: '08ba2aea0e8dba88eff0ec0d2c87e24b4db626f8', charIds: Object.freeze(['char_4247_oxi']) }),
  adapters: Object.freeze([]),
  research: null,                // docs/research/
  tables: 'default',             // stock / shopDraft / tacticDraft / bountyDrafts as measured on 下半
  config: Object.freeze({ hiddenCore: Object.freeze({ single: 350, multi: 1200 }) }), // no rules: no config.version
  expect: Object.freeze({ bonds: 23, bands: 40, visibleNonDiy: 112, triggerDeviations: 'default' }),
});
