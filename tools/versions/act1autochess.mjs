// tools/versions/act1autochess.mjs — build profile of 第一期下半: 盟约·上半 (act1autochess) in its final state V1_2
// (2025-11-25 → 2025-12-12; docs/DATA.md "Official versions (M0)", DESIGN §35.22). The master activity_table holds no pure
// 上半 any more: commit 12e0a020 (2026-03-10) migrated
// act1autochess to the 下半 schema and replaced the shared autoChessData, so every table is pinned to a commit of the
// season (Kengxxiao/ArknightsGameData, zh_CN/gamedata; cached in .cache/gamedata@<sha>/).
//   default 21b1f240 (2025-12-05, 上半 final): activity_table — its autochess sections are byte-identical to fdf34ff5 and
//           to every commit up to 3421eaff —, character / skill / uniequip / battle_equip, range_table (equal to the
//           range_table of dcc057f6, 2025-09-04) and the level files (levels/activities/act1autochess/* equal those of
//           23c99d5d, the V1_2 update)
//   enemy   ee2cabff (2025-12-05 17:15): enemy_handbook_table and enemy_database, the last change inside the season
// V1_2 opened on 11-25 with 23c99d5d; the 12-05 commit added 莎草's module, 娜斯提 to the owned 自选 pool, the ray / Mon3tr
// 自选 modules and 10 bond texts (DATA.md pins row), and changed three battle templates the build does not read. A split
// at 12-05 is open for the maintainer (DESIGN §35.22).
// M2 reads these rules and the per-version research. Other missing research still falls back to 第二期 [ASSUMED];
// the later measured draft/stock tables remain excluded. See docs/history/0.3.2.md §35.22.7.

export default Object.freeze({
  id: 'act1autochess',
  season: 'act1autochess',
  pins: Object.freeze({
    default: '21b1f240817dafe486653adda7a5085ff8a1ba17',
    enemy: 'ee2cabffd45de01548cc6dceb23129ce93ac7926',
  }),
  // 上半's bondInfoDict has activeType / isActiveInDeck instead of activeCondition; its 盟约·辅助干员 is a NORMAL row that
  // backs itself up (tools/versions/adapters.mjs)
  // Every 自选 6★ the default offers and the pin predates (the owner's decisions of 2026-11-02: rel25's 塔露拉 冻河 国度 and
  // the collab 焰狐龙梓兰 结城理, then the same 自选 range as the default — 6★ the version fields as shop chess stay shop
  // chess): each one's own records, with the summons they name, come from the commit the default reads it from
  // (tools/versions/act2autochess.mjs: fe7d8d05, or 08ba2aea for the three of 2026-11-01), so they equal the default's.
  // 麒麟R夜刀 is in the pinned tables but without EXE-Y (uniequip_003_yato2 is newer than every pin): his records are
  // replaced by the default's (`replace`, the owner's decision of 2026-11-02). The other collab picks keep the pin's.
  lateOperators: Object.freeze([
    Object.freeze({
      sha: 'fe7d8d05edc36cf5678a24bfe9e84e891f6cf7ad',
      charIds: Object.freeze([
        'char_1015_aglna2', 'char_1029_yato2', 'char_1048_orchd2', 'char_1050_chen3', 'char_1051_headb2',
        'char_1052_kalts2', 'char_2027_wang', 'char_4037_demetr', 'char_4217_makoto', 'char_4226_veen',
        'char_4228_closur', 'char_4229_aphris', 'char_4230_mcnist', 'char_4231_clemnt', 'char_4235_thumpy',
      ]),
      replace: Object.freeze(['char_1029_yato2']),
    }),
    Object.freeze({ sha: '08ba2aea0e8dba88eff0ec0d2c87e24b4db626f8', charIds: Object.freeze(['char_4244_tocka', 'char_4246_dminon', 'char_4247_oxi']) }),
  ]),
  // 第一期 has no 奥术 or 独行 bond: the owner's decision of 2026-11-02, after the precedents — 水月 (伏击客) is 迅捷 here
  // where 第二期 makes it 独行, 史尔特尔 loses 奥术: 国度 协防 + 迅捷, 塔露拉 协防 + 不屈 (her death rule adds 不屈 layers
  // alone), 玛露西尔 协防 alone
  diyBonds: Object.freeze({
    char_4246_dminon: Object.freeze(['swiftShip']),
    char_4247_oxi: Object.freeze(['indomShip']),
    char_4141_marcil: Object.freeze([]),
  }),
  diyTalentNotes: Object.freeze({ char_4247_oxi: '二技能有层数或三技能持续期间，我方其他干员阵亡时，【不屈】层数+1（联防、最终攻势、隐秘核心中不生效）' }),
  adapters: Object.freeze(['bondActiveType', 'selfBackupPreset']),
  research: 'docs/research/versions/act1autochess/',
  // the 下半-measured tables (shop stock overrides, the measured draft weights) are left out: uniform draws [ASSUMED]
  tables: Object.freeze({ stock: null, shopDraft: null, tacticDraft: null, bountyDrafts: null }),
  // 歌蕾蒂娅's garrison_39 names 斯卡蒂、幽灵鲨或安哲拉 here (下半: 深巡); 安哲拉 is shop chess chess_char_3_10
  pools: Object.freeze({ pool_chess_glady: Object.freeze(['char_263_skadi', 'char_143_ghost', 'char_218_cuttle']) }),
  config: Object.freeze({
    hiddenCore: Object.freeze({ single: 300, multi: 1000 }), // PRTS 卫戍协议：盟约: >300 / >1000 layers
    // Deploy order row by row from the bottom (PRTS 卫戍协议/帮助,
    // changed on 2026-03-14), a timed solo prep (300 s), no bench equipment, no boss shared by both
    // sides (news 5114). Full-bench swaps now follow the maintainer's round53 compatibility instruction in all
    // versions; exact first-period client fidelity is not independently re-measured [ASSUMED] (DESIGN §36.2).
    rules: Object.freeze({ deployOrder: 'rowBottomUp', soloTimed: true, benchEquip: false, bossMirrorShare: false }),
  }),
  expect: Object.freeze({ bonds: 18, bands: 30, visibleNonDiy: 95, triggerDeviations: 'none' }),
});
