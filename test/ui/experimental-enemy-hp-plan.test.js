// The 规则 page's 敌人生命倍率 by round (feedback #118, rel27; ui/experimental.js ruleRows): the switch under the single
// multiplier, the segment editor, the summary and the enemy detail's round multiplier (roundEnemyMul).
import test from 'node:test';
import assert from 'node:assert/strict';
import { experimentalOptions, experimentalChanged, experimentalSummary, enemyHpPlanText, ruleRows, roundEnemyMul } from '../../public/js/ui/experimental.js';
import { changedPages } from '../../public/js/ui/roomSettings.js';

const rules = (o = {}) => ({ revivalEnabled: false, disableSharedPool: false, ...o });
const body = (node) => (node?.props ? [node, ...[].concat(node.props.children ?? []).flatMap(body)] : Array.isArray(node) ? node.flatMap(body) : []);
const EXAMPLE = [[1, 1], [6, 1.5], [9, 2.5]];
const byTestId = (nodes, id) => nodes.filter((n) => n.props?.['data-testid'] === id);

test('options, marker, summary and the 规则 dot: a plan is kept, replaces the single multiplier, and reads as rounds', () => {
  assert.deepEqual(experimentalOptions(rules({ enemyHpPlan: EXAMPLE })), rules({ enemyHpPlan: EXAMPLE }));
  assert.deepEqual(experimentalOptions(rules({ enemyHpMul: 3, enemyHpPlan: EXAMPLE })), rules({ enemyHpPlan: EXAMPLE }));
  assert.deepEqual(experimentalOptions(rules({ enemyHpPlan: [[1, 2], [4, 2]] })), rules({ enemyHpMul: 2 }));
  assert.deepEqual(experimentalOptions(rules({ enemyHpPlan: [[2, 2], [4, 3]] })), rules(), 'not a plan');
  assert.equal(experimentalChanged(rules({ enemyHpPlan: EXAMPLE })), true);
  assert.equal(enemyHpPlanText(EXAMPLE), '1–5回合 ×1 / 6–8回合 ×1.5 / 9回合起 ×2.5');
  assert.equal(enemyHpPlanText([[1, 2], [2, 3], [3, 5]]), '1回合 ×2 / 2回合 ×3 / 3回合起 ×5');
  assert.match(experimentalSummary(rules({ enemyHpPlan: EXAMPLE, enemyAtkMul: 2 })), /· 敌人生命 1–5回合 ×1 \/ 6–8回合 ×1\.5 \/ 9回合起 ×2\.5 · 敌人攻击 ×2$/);
  assert.doesNotMatch(experimentalSummary(rules({ enemyHpPlan: EXAMPLE })), /敌人生命 ×/);
  assert.equal(changedPages({ mode: 'coop', experimental: rules({ enemyHpPlan: EXAMPLE }) }).rules, true);
  assert.equal(changedPages({ mode: 'coop', experimental: rules() }).rules, false);
});

test('the enemy detail\'s preview: the multipliers of the match\'s round', () => {
  const o = rules({ enemyHpPlan: EXAMPLE, enemyAtkMul: 2 });
  assert.deepEqual(roundEnemyMul(o, 3), { enemyAtkMul: 2 });
  assert.deepEqual(roundEnemyMul(o, 7), { enemyHpMul: 1.5, enemyAtkMul: 2 });
  assert.deepEqual(roundEnemyMul(o, 12), { enemyHpMul: 2.5, enemyAtkMul: 2 });
  assert.deepEqual(roundEnemyMul(rules({ enemyHpMul: 3 }), 1), { enemyHpMul: 3 });
  assert.equal(roundEnemyMul(rules(), 5), null);
  assert.equal(roundEnemyMul(null, 5), null);
});

test('the switch: on starts from the single multiplier (the player\'s example from ×1), off keeps the first segment\'s', () => {
  for (const mode of ['coop', 'solo']) {
    const sent = [];
    const nodes = body(ruleRows({ value: rules({ disableLayerCap: true }), mode, editable: true, onChange: (v) => sent.push(v) }));
    const sw = byTestId(nodes, 'experimental-enemy-hp-plan-switch')[0];
    assert.ok(sw, mode); assert.equal(sw.props.checked, false);
    assert.equal(byTestId(nodes, 'experimental-enemy-hp-plan').length, 0, 'no editor while off');
    sw.props.onChange({ currentTarget: { checked: true } });
    assert.deepEqual(sent.at(-1), rules({ disableLayerCap: true, enemyHpPlan: EXAMPLE }));
    const from2 = [];
    body(ruleRows({ value: rules({ enemyHpMul: 2 }), mode, editable: true, onChange: (v) => from2.push(v) }))
      .find((n) => n.props?.['data-testid'] === 'experimental-enemy-hp-plan-switch').props.onChange({ currentTarget: { checked: true } });
    assert.deepEqual(from2.at(-1), rules({ enemyHpPlan: [[1, 2], [6, 3], [9, 5]] }), 'from ×2: two and four steps up, clamped at ×5');
    const off = [];
    const on = body(ruleRows({ value: rules({ enemyHpPlan: [[1, 1.5], [6, 3]] }), mode, editable: true, onChange: (v) => off.push(v) }));
    assert.equal(on.find((n) => n.props?.id === 'experimental-enemy-hp').props.disabled, true, 'the single list is the plan\'s now');
    byTestId(on, 'experimental-enemy-hp-plan-switch')[0].props.onChange({ currentTarget: { checked: false } });
    assert.deepEqual(off.at(-1), rules({ enemyHpMul: 1.5 }));
  }
});

test('the editor: a row per segment, rounds between the neighbours, add / change / remove; one segment left is the single multiplier', () => {
  const sent = [];
  const nodes = body(ruleRows({ value: rules({ enemyHpPlan: EXAMPLE }), editable: true, onChange: (v) => sent.push(v) }));
  const rows = byTestId(nodes, 'experimental-enemy-hp-seg');
  assert.equal(rows.length, 3);
  const froms = byTestId(nodes, 'experimental-enemy-hp-from'), muls = byTestId(nodes, 'experimental-enemy-hp-mul'), dels = byTestId(nodes, 'experimental-enemy-hp-del');
  assert.equal(froms.length, 2, 'the first segment starts at round 1, no list');
  assert.equal(dels.length, 2, 'the first segment stays');
  const opts = (sel) => [].concat(sel.props.children).flat().map((o) => o.props.value);
  assert.deepEqual(opts(froms[0]), [2, 3, 4, 5, 6, 7, 8], 'after round 1, before round 9');
  assert.deepEqual(opts(froms[1]), [7, 8, 9, 10, 11, 12, 13, 14, 15], 'after round 6, up to 15');
  assert.deepEqual(opts(muls[0]), [1, 1.25, 1.5, 2, 2.5, 3, 5]);
  froms[0].props.onChange({ currentTarget: { value: '5' } });
  assert.deepEqual(sent.at(-1), rules({ enemyHpPlan: [[1, 1], [5, 1.5], [9, 2.5]] }));
  muls[2].props.onChange({ currentTarget: { value: '3' } });
  assert.deepEqual(sent.at(-1), rules({ enemyHpPlan: [[1, 1], [6, 1.5], [9, 3]] }));
  byTestId(nodes, 'experimental-enemy-hp-add')[0].props.onClick();
  assert.deepEqual(sent.at(-1), rules({ enemyHpPlan: [...EXAMPLE, [10, 3]] }), 'the next round, one step up');
  dels[0].props.onClick();
  assert.deepEqual(sent.at(-1), rules({ enemyHpPlan: [[1, 1], [9, 2.5]] }));
  const two = [];
  byTestId(body(ruleRows({ value: rules({ enemyHpPlan: [[1, 2], [6, 3]] }), editable: true, onChange: (v) => two.push(v) })), 'experimental-enemy-hp-del')[0].props.onClick();
  assert.deepEqual(two.at(-1), rules({ enemyHpMul: 2 }), 'one segment left: the single multiplier');
  // six segments, or the last at round 15: no 添加阶段
  const six = Array.from({ length: 6 }, (_, i) => [1 + i, 1 + (i % 2)]);
  assert.equal(byTestId(body(ruleRows({ value: rules({ enemyHpPlan: six }), editable: true })), 'experimental-enemy-hp-add').length, 0);
  assert.equal(byTestId(body(ruleRows({ value: rules({ enemyHpPlan: [[1, 1], [15, 2]] }), editable: true })), 'experimental-enemy-hp-add').length, 0);
});

test('read only: a guest sees the plan, every control disabled, nothing sent', () => {
  const sent = [];
  const nodes = body(ruleRows({ value: rules({ enemyHpPlan: EXAMPLE }), editable: false, onChange: (v) => sent.push(v) }));
  for (const id of ['experimental-enemy-hp-from', 'experimental-enemy-hp-mul', 'experimental-enemy-hp-del', 'experimental-enemy-hp-add']) {
    const list = byTestId(nodes, id);
    assert.ok(list.length > 0, id);
    for (const n of list) assert.equal(n.props.disabled, true, id);
  }
  byTestId(nodes, 'experimental-enemy-hp-del')[0].props.onClick();
  byTestId(nodes, 'experimental-enemy-hp-mul')[0].props.onChange({ currentTarget: { value: '2' } });
  assert.deepEqual(sent, []);
});
