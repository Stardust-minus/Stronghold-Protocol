// tools/versions/act1autochess-v1_1.mjs — build profile of 第一期上半: 盟约·上半 (act1autochess) in its first
// sub-version V1_1 (2025-11-14 16:00 → 2025-11-25 16:00), with the 11-18 hotfix (docs/DATA.md "Official versions (M0)";
// the maintainer's decisions of 2026-10-22, DESIGN §35.22). Pinned to Kengxxiao/ArknightsGameData:
//   default   8303c922 (the launch, data version 25-11-12-14-06-12): the range table, the enemy tables (enemy_database
//             changed again at 23c99d5d, so there is no separate enemy pin: V1_2's ee2cabff would leak V1_2 enemies) and
//             the 43 level files (the hotfix changed none; V1_2's 23c99d5d changed the three solo hidden-core levels
//             h08_0X_s, whose routes end at the 传送 entrance (1,3) instead of the protection point (2,2))
//   activity  ea164ef7 (the 11-18 hotfix, 25-11-17-12-07-19): activity_table with the first 20 strategies.
//             versionInfoDict counts the hotfix as V1_1 (V1_2 starts 2025-11-25 16:00) and 7 of V1_1's 11 days ran on
//             it. Its changes: leader HP ×0.75 (Funny / Normal pools, −5…−12.5% Hard), modeFactorInfo.SINGLE
//             1.0 → 1.25, borrowCount 8 → 20, the enemy effects 攻坚装备II / III, 战场 m06 weight 40 → 60, m07
//             weight 40 → 5 and Hard modes only (taken out of both Normal modes), 墨浪 / 枯朽萃聚使徒 special-enemy
//             weight 10 → 0, the leader weight of boss_2 (假想敌：铳) 5 → 2, 9 more enemies inactive in the Normal modes
//             (one of them, 沉沙 enemy_1207_sfji, also in the Funny modes), and 拟态物质's effectDesc (eff_acarm069
//             and the golden eff_acgarm069: 初始干员)
//   character ea164ef7: the hotfix also reworded skill_table's two sktok_acarm069 descriptions the same way, rows the
//             build does not read (the output is byte-identical with the character tables of 8303c922); character /
//             uniequip / battle_equip are the same at both commits. The client drag fix is not a build input.
// adapters: the two 上半 schema adapters, and launchMilestones: the table lists all 60 功勋 levels, and levels 36–60 open
// with V1_2 (availableTime 2025-11-25 16:00), so V1_1 has 35.
// The rest is as tools/versions/act1autochess.mjs.

export default Object.freeze({
  id: 'act1autochess@V1_1',
  season: 'act1autochess',
  pins: Object.freeze({
    default: '8303c922f749f0dcf08e03671519421ef6a7748b',
    activity: 'ea164ef70736ca2d1a356b3bf7b1cd7540960dc1',
    character: 'ea164ef70736ca2d1a356b3bf7b1cd7540960dc1',
  }),
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
        'char_1052_kalts2', 'char_2027_wang', 'char_4037_demetr', 'char_4212_nasti', 'char_4217_makoto',
        'char_4226_veen', 'char_4228_closur', 'char_4229_aphris', 'char_4230_mcnist', 'char_4231_clemnt',
        'char_4235_thumpy',
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
  adapters: Object.freeze(['bondActiveType', 'selfBackupPreset', 'launchMilestones']),
  research: 'docs/research/versions/act1autochess-v1_1/',
  tables: Object.freeze({ stock: null, shopDraft: null, tacticDraft: null, bountyDrafts: null }),
  pools: Object.freeze({ pool_chess_glady: Object.freeze(['char_263_skadi', 'char_143_ghost', 'char_218_cuttle']) }),
  config: Object.freeze({
    hiddenCore: Object.freeze({ single: 300, multi: 1000 }),
    // Round53 authorizes full-bench swaps in every version; first-period client fidelity is unmeasured [ASSUMED], §36.2.
    rules: Object.freeze({ deployOrder: 'rowBottomUp', soloTimed: true, benchEquip: false, bossMirrorShare: false }),
  }),
  expect: Object.freeze({ bonds: 18, bands: 20, visibleNonDiy: 95, triggerDeviations: 'none' }),
});
