// server/match/titleCutoffs.js — 规程's 评语 tier lines (server/match/results.js regulationTitles; the owner's decision of
// 2026-11-16). Each kind of 评语 (act3autochess playerTitleDataDict `type`) has three ranks; a player's value of the kind
// (the stat of config.titles[].stat: results.js regulationValues) reaches rank 1 at the first number and rank 2 at the
// second (the least value of each rank).
//
// Source: the official lines are unpublished, so they are ours — rank 1 = the top 50 % and rank 2 = the top 15 % of this
// server's own play: bot-only matches (tools/title-cutoffs.mjs; no player data read), every 规程 mode a room can play —
// solo 极速模拟 and 规程等级 1–20, co-op 标准 / 险境 / 绝境 / 终极 with 2, 3 and 4 AI seats (33 configurations) — 100 seeds
// each (1001–1100), the shipped `legacy` bot with the Match's default layout rehearsal, every match played out (a seat
// eliminated early is a sample too): 3 300 matches, 5 700 samples, pooled (2026-11-16, data 79.2.0 of V3_1). The shares
// the lines give on those samples (whole numbers tie: the line whose share is nearest the target):
//   kind    rank 1   share    rank 2     share
//   BOND    177      50.0 %   311        14.9 %   activated alliance layers (盟约层数)
//   KILL    268      50.0 %   347        15.0 %   enemies defeated, 联防 included (creditedKills)
//   EQUIP   5        54.1 %   11         13.1 %   equipment issued (itemsEquipped)
//   COIN    147      47.7 %   155        15.4 %   funds spent
//   CHAR    6        58.1 %   8          19.7 %   promotions to elite (merges)
//   DAMAGE  522 200  50.0 %   1 876 800  15.0 %   damage to the enemy leader (bossDamage)
// Per room mode the lines differ little (solo / co-op: BOND 172 / 181, 286 / 326; DAMAGE 678 720 / 406 635, 1 764 001 /
// 1 995 000), so one table serves both.
//
// To change them: edit the numbers below (each kind's [rank 1, rank 2], rank 2 above rank 1), then regenerate 规程's golden
// (`node tools/golden.mjs --version act3autochess@V3_1 --update`: only the matches' titles move). To measure again (a new
// sequence, a new bot, other shares): `node tools/title-cutoffs.mjs --version act3autochess@V3_1 --seeds 100 --seed 1001
// --jobs 18 --json <file>` (a stopped run resumes on the same file; `--from <file>` only summarizes, `--top1` / `--top2`
// set the shares) and copy the REGULATION_TITLE_CUTOFFS line it prints.
export const REGULATION_TITLE_CUTOFFS = Object.freeze({
  BOND: Object.freeze([177, 311]),
  KILL: Object.freeze([268, 347]),
  EQUIP: Object.freeze([5, 11]),
  COIN: Object.freeze([147, 155]),
  CHAR: Object.freeze([6, 8]),
  DAMAGE: Object.freeze([522200, 1876800]),
});
