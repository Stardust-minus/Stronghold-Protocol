// AI 联防置后 (the owner's request of 2026-11-04, rel29): the room's experimental `uniteHumansFirst` ranks every human
// before any seat the engine plays (an AI teammate, AI 托管) when the 联防 helpers are chosen and ordered
// (server/match/unite.js helperOrder); the usual order applies within each side. Off, the order is the old one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helperOrder } from '../../server/match/unite.js';
import { isExperimental, experimentalOptions, experimentalKey, sameExperimental, experimentalRuleChanged, isUniteHumansFirst } from '../../shared/experimental.js';
import { experimentalSummary, experimentalChanged, ruleRows } from '../../public/js/ui/experimental.js';
import { changedPages } from '../../public/js/ui/roomSettings.js';
import { snapshotMatch, restoreMatch } from '../../server/match/snapshot.js';
import { createRngFromState } from '../../server/sim/rng.js';
import { makeMatch } from './harness.js';

const rules = (o = {}) => ({ revivalEnabled: false, disableSharedPool: false, ...o });
/** A perfect player as helperStats reads it: `units` operators on the board, no bond. */
const seat = (playerId, s, units, engine = false) => {
  const board = new Map();
  for (let i = 0; i < units; i++) board.set(`${i},0`, { kind: 'chess', uid: i + 1 });
  return { playerId, seat: s, board, deployCount: units, bonds: {}, layers: {}, pendingLayerGains: null, botControlled: engine };
};
const M = (on) => ({ gd: { unite: { maxHelpers: 2 } }, uniteHumansFirst: on, disableLayerCap: false });
const ids = (list) => list.map((p) => p.playerId);

test('helpers: off, the usual order picks the AI with more units; on, every human comes first', () => {
  const ai = seat('ai_0', 0, 9, true), takeover = seat('p_away', 1, 8, true), a = seat('p_a', 2, 6), b = seat('p_b', 3, 5);
  const perfects = [ai, takeover, a, b];
  assert.deepEqual(ids(helperOrder(M(false), perfects, new Map())), ['ai_0', 'p_away']);
  assert.deepEqual(ids(helperOrder(M(true), perfects, new Map())), ['p_a', 'p_b'], 'two humans: both, by units');
  // one human: the human, then the best of the engine's seats; the human meets the enemies first (the pair's order too)
  assert.deepEqual(ids(helperOrder(M(true), [ai, takeover, b], new Map())), ['p_b', 'ai_0']);
  assert.deepEqual(ids(helperOrder(M(true), [ai, takeover], new Map())), ['ai_0', 'p_away'], 'no human: the usual order');
  assert.deepEqual(ids(helperOrder(M(false), [ai, b], new Map())), ['ai_0', 'p_b']);
});

test('the option: optional key, absent when off; its own matchmaking key; a rule change', () => {
  assert.equal(isExperimental(rules({ uniteHumansFirst: true })), true);
  for (const bad of ['true', 1, null]) assert.equal(isExperimental(rules({ uniteHumansFirst: bad })), false, String(bad));
  assert.deepEqual(experimentalOptions(rules({ uniteHumansFirst: true })), rules({ uniteHumansFirst: true }));
  assert.deepEqual(experimentalOptions(rules({ uniteHumansFirst: false })), rules());
  assert.notEqual(experimentalKey(rules({ uniteHumansFirst: true })), experimentalKey(rules()));
  assert.equal(sameExperimental(rules({ uniteHumansFirst: true }), rules()), false);
  assert.equal(experimentalRuleChanged(experimentalOptions(rules({ uniteHumansFirst: true }))), true);
  assert.equal(isUniteHumansFirst(rules({ uniteHumansFirst: true })), true);
  assert.equal(isUniteHumansFirst(rules()), false);
  // every option at once still fits the key bound
  assert.equal(isExperimental(rules({ playerCapacity: 8, disableDuckLord: true, disableLayerCap: true, disableHitLimit: true, enemyHpMul: 2,
    enemyHpPlan: [[1, 1], [6, 2]], enemyAtkMul: 2, poolPlan: [0, 0, 0, 0, 1, 1, 1, 1], collabOps: true, console: true, uniteHumansFirst: true })), true);
});

test('client: the summary, the changed mark, the 规则 page (co-op only)', () => {
  assert.match(experimentalSummary(rules({ uniteHumansFirst: true })), /AI 联防置后/);
  assert.equal(experimentalChanged(rules({ uniteHumansFirst: true })), true);
  assert.equal(changedPages({ experimental: rules({ uniteHumansFirst: true }) }).rules, true);
  const sent = [];
  const rows = (mode) => ruleRows({ value: rules(), mode, editable: true, onChange: (v) => sent.push(v) }).flat(Infinity).filter(Boolean);
  const find = (mode) => {
    let hit = null;
    const visit = (n) => { if (Array.isArray(n)) return n.forEach(visit); if (n?.props) { if (n.props.id === 'experimental-unite-humans') hit = n; visit(n.props.children); } };
    visit(rows(mode));
    return hit;
  };
  assert.ok(find('coop'), 'co-op 规则 page');
  assert.equal(find('solo'), null, 'no 联防 in a solo run');
});

test('the match reads it, and a checkpoint restore keeps it', (t) => {
  // humans only: a checkpoint waits in prep for AI seats to be ready (snapshot.js canSnapshot)
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 91, fake: true, experimental: rules({ uniteHumansFirst: true }) }).start();
  t.after(() => h.m.dispose());
  assert.equal(h.m.uniteHumansFirst, true);
  h.toPrep(1);
  const doc = JSON.parse(JSON.stringify(snapshotMatch(h.m)));
  assert.equal(doc.experimental.uniteHumansFirst, true);
  const r = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seats: doc.seats, seed: doc.seed, experimental: doc.experimental });
  t.after(() => r.m.dispose());
  assert.equal(restoreMatch(r.m, doc, { createRngFromState, log: { warn() {} } }), true);
  assert.equal(r.m.uniteHumansFirst, true);
  const off = makeMatch({ mode: 'coop', humans: 2, seed: 91, fake: true }).start();
  t.after(() => off.m.dispose());
  assert.equal(off.m.uniteHumansFirst, false);
});
