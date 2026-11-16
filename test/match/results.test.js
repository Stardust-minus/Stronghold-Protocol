// RESULT: titles (评语) assignment, per-player rows, trophies, rewards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignTitles, regulationTitles, regulationRank, regulationValues, regulationProgress, isRegulationTable } from '../../server/match/results.js';
import { REGULATION_TITLE_CUTOFFS } from '../../server/match/titleCutoffs.js';
import { getVersionData } from '../../server/data.js';
import { GameData } from '../../server/match/gamedata.js';
import { PHASE } from '../../shared/constants.js';
import { DATA, makeMatch } from './harness.js';

const gd = new GameData(DATA, 'mode_multi_hard');
const fake = (seat, s = {}, layers = 0, lp = 10) => ({
  playerId: `p${seat}`, seat, alive: true, lp, lpAtFinal: lp,
  stats: { bossDamage: 0, merges: 0, itemsEquipped: 0, gold: 0, ...s },
  activatedLayers: () => layers,
});

test('titles: each player ≤ 1 title, each title ≤ once, leaders first, 卫戍之星 only on a win', () => {
  const players = [
    fake(0, { bossDamage: 900, merges: 1, gold: 50 }, 100, 5),
    fake(1, { bossDamage: 100, merges: 6, gold: 20 }, 300, 9),
    fake(2, { itemsEquipped: 9, gold: 99 }, 10, 30),
    fake(3, { merges: 2, gold: 1 }, 50, 12),
  ];
  const win = assignTitles(gd, players, true);
  const ids = [...win.values()].map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'each title used once');
  assert.equal(win.get('p0').id, 'comment_1', 'top boss damage (win)');
  assert.ok(['comment_2', 'comment_4'].includes(win.get('p1').id));
  assert.ok(win.size === 4);
  const loss = assignTitles(gd, players, false);
  assert.ok(![...loss.values()].some((t) => t.id === 'comment_1'), '卫戍之星 needs a win');
  for (const t of [...win.values(), ...loss.values()]) assert.ok(t.name && t.text && t.picId);
  // nobody gets a 'max' title for a zero stat; the 'min' title 坚若磐石 (least LP lost) goes to a player who lost none
  const none = assignTitles(gd, [fake(0, {}, 0, 0)], false);
  assert.deepEqual([...none.values()].map((t) => t.id), ['comment_3']);
  const dead = assignTitles(gd, [{ ...fake(0, {}, 0, 0), alive: false }], false);
  assert.equal(dead.size, 0, 'an eliminated player gets nothing for zero stats');
});

test('m.result rows: lineup, bonds, stats, roundsPassed per player, trophies (co-op) and rewards', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 2, seed: 80, fake: true, script: (b) => (b.round !== 2 ? {} : b.kind === 'unite' ? { survivors: { p_1: 10 } } : { leaks: { p_1: 10 } }) }).start();
  const m = h.m;
  h.toPrep(1);
  h.ps('p_1').lp = 5;
  h.drive(() => m.phase === PHASE.PREP && m.round === 3);
  assert.equal(h.ps('p_1').alive, false);
  h.m.onLeave('p_1');
  assert.equal(h.ended, null, 'a human is still there');
  h.m.onLeave('p_0');
  const r = h.ended;
  assert.ok(r);
  assert.equal(r.reason, 'abandoned');
  assert.equal(r.victory, false);
  const rows = Object.fromEntries(r.players.map((p) => [p.playerId, p]));
  assert.equal(rows.p_1.roundsPassed, 1);
  assert.equal(rows.p_1.eliminatedRound, 2);
  assert.equal(rows.p_0.roundsPassed, 2);
  for (const p of r.players) {
    for (const k of ['playerId', 'seat', 'name', 'isBot', 'victory', 'roundsPassed', 'lineup', 'bonds', 'stats', 'title', 'trophies', 'reward']) assert.ok(k in p, k);
    for (const k of ['dmgDealt', 'kills', 'leaks', 'gold', 'refreshes', 'merges', 'itemsEquipped', 'bossDamage', 'activatedLayers', 'lpLost']) assert.ok(Number.isFinite(p.stats[k]), k);
  }
  assert.equal(rows.p_0.reward, Math.round(20 * 1.7 * 1.25), 'reward = base[rounds] × difficulty × mode');
  assert.equal(r.modeId, 'mode_multi_hard');
  assert.ok(Number.isFinite(r.durationMs));
  m.dispose();
});

test('Final Assault: the result LP are the alive players\' shares of the merged team LP (a team beaten to 0 shows 0)', () => {
  // defeat: the boss is never hurt, the overtime drain empties the team pool
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, seed: 4, fake: true, script: (b) => (b.kind === 'boss' ? { bossDps: 0 } : {}) }).start();
  h.autoHumans();
  const end = h.runToEnd();
  assert.equal(h.m.teamLp, 0);
  assert.equal(end.reason, 'defeat');
  assert.equal(end.teamLp, 0);
  for (const p of end.players) {
    assert.equal(p.alive, true);
    assert.equal(p.roundsPassed, 13);
    assert.equal(p.lp, 0, `${p.playerId}: a team beaten to 0 LP shows 0, not its pre-merge LP`);
    assert.equal(h.lastTo(p.playerId, 'm.private').lp, 0, 'm.private follows');
  }
  assert.ok(h.lastBc('m.public').players.every((p) => p.lp === 0), 'm.public follows');
  h.m.dispose();

  // victory after losing LP in the boss fight: Σ shares = team LP, each share ∝ the LP the player brought in
  const h2 = makeMatch({
    mode: 'coop', difficulty: 'FUNNY', humans: 3, seed: 7, fake: true,
    script: (b) => (b.kind === 'boss' ? { bossDps: b.sharedBoss.maxHp / 8, leakEvents: b.fieldId === 'b1' ? [{ at: 1, lpr: 5 }, { at: 2, lpr: 6 }] : [] } : {}),
  }).start();
  h2.autoHumans();
  h2.drive(() => h2.m.phase === PHASE.PREP && h2.m.round === 14);
  const [a, b, c] = ['p_0', 'p_1', 'p_2'].map((id) => h2.ps(id));
  a.lp = 30; b.lp = 21; c.lp = 9;
  const r2 = h2.runToEnd();
  assert.equal(r2.victory, true);
  assert.equal(h2.m.teamLp, 60 - 11);
  assert.equal(r2.teamLp, 49);
  const lp = Object.fromEntries(r2.players.map((p) => [p.playerId, p.lp]));
  assert.equal(lp.p_0 + lp.p_1 + lp.p_2, 49);
  for (const [id, brought] of [['p_0', 30], ['p_1', 21], ['p_2', 9]]) {
    assert.ok(Math.abs(lp[id] - (49 * brought) / 60) < 1, `${id}: share ${lp[id]} of 49 for ${brought}/60`);
    assert.ok(lp[id] <= brought);
  }
  h2.m.dispose();
});

test('co-op trophies / victory follow each player\'s OWN rounds passed: a teammate eliminated in R6 gets the table value of 5 rounds, not the Hidden-Core row', async () => {
  const { buildResult } = await import('../../server/match/results.js');
  const h = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 2, seed: 5, fake: true }).start();
  h.toPrep(6);
  const m = h.m;
  const out = h.ps('p_1');
  out.lp = 0;
  out.eliminate(6);
  m.round = 15;
  m.hiddenReached = true;
  const res = buildResult(m, { victory: true, hiddenReached: true, hiddenCleared: true, reason: 'victory' });
  const tr = m.gd.config.trophies;
  const row = (pid) => res.players.find((p) => p.playerId === pid);
  assert.equal(row('p_0').roundsPassed, 15);
  assert.equal(row('p_0').trophies, tr.hiddenCore.HARD, 'the survivor cleared the Hidden Core');
  assert.equal(row('p_0').victory, true);
  assert.equal(row('p_1').roundsPassed, 5);
  assert.equal(row('p_1').trophies, tr.byRoundsPassed.find((x) => 5 <= x.maxRound).HARD, 'own 5 rounds, not the Hidden-Core row');
  assert.notEqual(row('p_1').trophies, tr.hiddenCore.HARD);
  assert.equal(row('p_1').victory, false, 'eliminated before the boss round: the clear is not its own');
  assert.equal(res.victory, true, 'the team result is still a win');
  m.dispose();
});

// 规程's 评语 (the owner's decision of 2026-11-16): six kinds × three ranks of playerTitleDataDict, each player rated on the
// kinds' tier lines (server/match/titleCutoffs.js) and given the 评语 of its best one.
const ACT3 = getVersionData('act3autochess@V3_1', { log: { warn() {}, error() {}, info() {} } });

test('规程 config.titles: the official table — six kinds × ranks 0–2, rank 0 scores nothing, each kind names its stat', () => {
  const titles = new GameData(ACT3, 'mode_multi_hard').titles;
  assert.equal(titles.length, 18);
  assert.equal(isRegulationTable(titles), true);
  assert.equal(isRegulationTable(gd.titles), false, '盟约 keeps its six titles');
  const kinds = { BOND: 'activatedLayers', KILL: 'kills', EQUIP: 'itemsEquipped', COIN: 'fundsSpent', CHAR: 'merges', DAMAGE: 'bossDamage' };
  for (const [kind, stat] of Object.entries(kinds)) {
    const own = titles.filter((x) => x.type === kind);
    assert.deepEqual(own.map((x) => [x.rank, x.point, x.stat]), [[0, 0, stat], [1, 1, stat], [2, 1, stat]], kind);
    for (const x of own) assert.ok(x.name && x.picId && x.text, x.id);
  }
  // data/tuning.json's 坚若磐石 override names comment_3, which is 不朽盟约 (BOND rank 2) here: not applied
  assert.equal(titles.find((x) => x.id === 'comment_3').stat, 'activatedLayers');
  for (const k of Object.keys(kinds)) {
    const [a, b] = REGULATION_TITLE_CUTOFFS[k];
    assert.ok(Number.isInteger(a) && Number.isInteger(b) && a >= 1 && b > a, `${k} lines ${a} < ${b}`);
  }
});

test('规程 评语: the best rank over the kinds, then the value furthest past its line; rank 0 is the closest kind; teammates may share one', () => {
  const titles = new GameData(ACT3, 'mode_multi_hard').titles;
  const lines = { BOND: [100, 200], KILL: [100, 200], EQUIP: [4, 6], COIN: [100, 150], CHAR: [5, 8], DAMAGE: [1000, 5000] };
  const p = (seat, { layers = 0, kills = 0, items = 0, gold = 0, merges = 0, boss = 0 } = {}) => ({
    playerId: `p${seat}`, seat, alive: true, lp: 10, creditedKills: kills, activatedLayers: () => layers,
    stats: { bossDamage: boss, merges, itemsEquipped: items, gold, kills: 0 },
  });
  const players = [
    p(0, { layers: 250, kills: 150, gold: 160 }), // BOND 2 (250/200) vs COIN 2 (160/150): BOND is further past its line
    p(1, { layers: 120, kills: 180 }), // BOND 1 (1.2) vs KILL 1 (1.8): KILL
    p(2, { items: 3, merges: 4, gold: 30 }), // nothing ranked: the closest to a first line is CHAR (0.8)
    p(3, { layers: 300, kills: 150, gold: 160 }), // the same 评语 as seat 0
    p(4), // nothing at all: the first kind's consolation
  ];
  const got = regulationTitles(titles, players, lines);
  const name = (id) => titles.find((x) => x.id === got.get(id)?.id)?.name;
  assert.equal(name('p0'), '不朽盟约');
  assert.equal(name('p1'), '可靠后盾');
  assert.equal(name('p2'), '孤胆先锋');
  assert.equal(name('p3'), '不朽盟约', 'absolute lines: two teammates can both reach 不朽盟约');
  assert.equal(name('p4'), '百花齐放');
  assert.equal(regulationRank(4, lines.EQUIP), 1);
  assert.equal(regulationRank(6, lines.EQUIP), 2);
  assert.equal(regulationRank(3, lines.EQUIP), 0);
  // assignTitles takes 规程's path on its data (the shipped lines), whatever the outcome
  const live = assignTitles(new GameData(ACT3, 'mode_multi_hard'), players, false);
  assert.equal(live.size, players.length, 'every player gets one 评语');
  for (const t of live.values()) assert.ok(t.id && t.name && t.picId && t.text);
  assert.deepEqual(regulationValues(titles, players[0]), { BOND: 250, KILL: 150, EQUIP: 0, COIN: 160, CHAR: 0, DAMAGE: 0 });
  // within a rank the measure is the band, not value / line: a long-tailed kind (领袖伤害) does not crowd out a narrow one
  const both = p(5, { gold: 190, boss: 7000 }); // COIN 2: (190 − 150) / 50 = 0.8; DAMAGE 2: (7000 − 5000) / 4000 = 0.5
  assert.equal(titles.find((x) => x.id === regulationTitles(titles, [both], lines).get('p5').id).name, '挥金如土');
  assert.equal(regulationProgress(190, lines.COIN, 2), 0.8);
  assert.equal(regulationProgress(125, lines.COIN, 1), 0.5);
  assert.equal(regulationProgress(50, lines.COIN, 0), 0.5);
});
