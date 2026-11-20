// 实验性功能 by group on the page (the owner, 2026-11-16; ui/experimental.js, ui/matchmaking.js, ui/matchOffer.js): what is on,
// grouped in shared/experimental.js EXPERIMENTAL_GROUPS order; a ticket's own options; the scope's 我的实验性; where an
// offer's options come from. The dialog's pages: test/ui/room-settings-dialog.test.js; the browser: experimental-groups.e2e.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExperimentalDetails, experimentalByGroup, experimentalCountText, experimentalItems, groupRows, optionGroups, queueConfig } from '../../public/js/ui/experimental.js';
import { customProblem, matchConfig, matchScope, matchScopeRequest, queueScope, queueTakesCustom, toggleMatchScope } from '../../public/js/ui/matchmaking.js';
import { offerRules, offerRulesOrigin } from '../../public/js/ui/matchOffer.js';
import { queueOptions } from '../../shared/experimental.js';

const walk = (node) => (Array.isArray(node) ? node.flatMap(walk) : node?.props ? [node, ...walk(node.props.children)] : []);
const ids = (rows) => walk(rows).map((n) => n.props.id).filter(Boolean);
const rules = (o = {}) => ({ revivalEnabled: false, disableSharedPool: false, ...o });
const ALL = rules({ revivalEnabled: true, disableSharedPool: true, playerCapacity: 8, disableDuckLord: true, disableLayerCap: true, disableHitLimit: true,
  enemyHpMul: 2, enemyAtkMul: 1.5, collabOps: true, console: true, uniteHumansFirst: true });

test('what is on, by group and in their order; a solo room has no teammates\' rules; the count', () => {
  assert.deepEqual(experimentalItems(rules()), []);
  assert.deepEqual(experimentalItems(ALL).map((x) => `${x.group}:${x.key}`), ['seats:playerCapacity', 'team:revivalEnabled', 'team:uniteHumansFirst', 'bonds:disableLayerCap',
    'bonds:disableDuckLord', 'enemy:enemyHpMul', 'enemy:enemyAtkMul', 'enemy:disableHitLimit', 'pools:disableSharedPool', 'special:collabOps', 'special:console']);
  assert.deepEqual(experimentalItems(ALL, { mode: 'solo' }).map((x) => x.key), ['disableLayerCap', 'disableDuckLord', 'enemyHpMul', 'enemyAtkMul', 'disableHitLimit', 'collabOps', 'console']);
  assert.deepEqual(experimentalItems(ALL, { omit: ['playerCapacity'] })[0].key, 'revivalEnabled');
  assert.deepEqual(experimentalByGroup(rules({ enemyHpMul: 2, revivalEnabled: true })).map((g) => [g.id, g.items.length]), [['team', 1], ['enemy', 1]]);
  assert.equal(experimentalItems(rules({ enemyHpPlan: [[1, 1], [6, 2]] }))[0].text, '敌人生命 1–5回合 ×1 / 6回合起 ×2');
  assert.deepEqual(experimentalItems(rules({ staticPoolSplit: true, poolPlan: [0, 0, 1, 1] })).map((x) => `${x.group}:${x.key}:${x.text}`),
    ['pools:staticPoolSplit:卡池静态初始化', 'pools:poolPlan:手动卡池 2 组'], '卡池静态初始化 in the 卡池 group, before the manual plan');
  assert.deepEqual(experimentalItems(rules({ staticPoolSplit: true }), { mode: 'solo' }), [], 'a solo room has no pool to deal');
  assert.deepEqual(queueConfig(rules({ staticPoolSplit: true })), rules({ staticPoolSplit: true }), 'a ticket keeps it');
  assert.equal(experimentalCountText(0), '未开启');
  assert.equal(experimentalCountText(3), '已开启 3 项');
});

test('the details: one block per group with its items, or the empty line', () => {
  const nodes = walk(ExperimentalDetails({ value: rules({ enemyAtkMul: 2, disableHitLimit: true, revivalEnabled: true }) }));
  assert.deepEqual(nodes.filter((n) => n.props['data-group']).map((n) => n.props['data-group']), ['team', 'enemy']);
  assert.deepEqual(nodes.filter((n) => n.props['data-key']).map((n) => n.props['data-key']), ['revivalEnabled', 'enemyAtkMul', 'disableHitLimit']);
  const empty = ExperimentalDetails({ value: rules() });
  assert.match(empty.props.class, /expd--empty/);
  assert.equal(empty.props.children, '全部规则保持原样');
});

test('a ticket\'s own options: the rules of the game only, 禁用鸭爵策略 kept as asked; its groups', () => {
  assert.deepEqual(queueConfig(ALL), rules({ revivalEnabled: true, disableSharedPool: true, disableLayerCap: true, disableHitLimit: true, enemyHpMul: 2, enemyAtkMul: 1.5,
    uniteHumansFirst: true, disableDuckLord: true }));
  assert.ok(queueOptions(queueConfig(ALL)), 'what the page sends, the server takes');
  assert.deepEqual(queueConfig(null), rules());
  assert.deepEqual(experimentalItems(rules({ disableDuckLord: true }), { queue: true }).map((x) => x.text), ['禁用鸭爵策略（多人同盟）']);
  const props = (o = {}) => ({ value: rules(), mode: 'coop', source: 'queue', editable: true, onChange() {}, ...o });
  assert.deepEqual(optionGroups(props()), ['team', 'bonds', 'enemy', 'pools'], 'no seat count, no 特殊功能');
  assert.deepEqual(ids(groupRows('bonds', props())), ['experimental-layer-cap']);
  assert.deepEqual(ids(groupRows('bonds', props({ multi: true }))), ['experimental-layer-cap', 'experimental-ducklord'], 'with 多人同盟 in the scope');
  assert.deepEqual(ids(groupRows('pools', props())), ['experimental-pool', 'experimental-pool-split'], 'no manual groups');
  const sent = [];
  const duck = walk(groupRows('bonds', props({ multi: true, value: rules({ disableDuckLord: true }), onChange: (v) => sent.push(v) }))).find((n) => n.props.id === 'experimental-ducklord');
  assert.equal(duck.props.checked, true, 'kept on although the ticket names no seat count');
  duck.props.onChange({ currentTarget: { checked: false } });
  assert.deepEqual(sent, [rules()]);
});

test('the scope\'s 我的实验性: remembered, sent with its options, left out for an older server', () => {
  assert.deepEqual(matchScope({ seats: ['four'], rules: ['experimental', 'custom'] }).rules, ['custom', 'experimental']);
  const scope = { seats: ['four'], rules: ['standard', 'custom'] };
  assert.deepEqual(matchScopeRequest(scope, rules({ revivalEnabled: true, console: true })), { capacities: [4], rules: ['standard', 'custom'], experimental: rules({ revivalEnabled: true }) });
  assert.deepEqual(matchScopeRequest(scope, rules({ revivalEnabled: true }), false), { capacities: [4], rules: ['standard'] });
  assert.deepEqual(matchScopeRequest({ seats: ['four'], rules: ['custom'] }, rules({ revivalEnabled: true }), false), { capacities: [4], rules: ['standard'] }, 'never an empty list');
  assert.deepEqual(matchScopeRequest({ seats: ['four'], rules: ['standard'] }, rules({ revivalEnabled: true })), { capacities: [4], rules: ['standard'] });
  assert.deepEqual(toggleMatchScope(scope, 'rules', 'custom').rules, ['standard']);
  assert.equal(queueTakesCustom({ queueRules: ['standard', 'experimental', 'custom'] }), true);
  assert.equal(queueTakesCustom({ queueRules: null }), false);
  assert.deepEqual(matchConfig('x'), rules());
  assert.deepEqual(matchConfig(rules({ enemyAtkMul: 2, poolPlan: [0, 0, 1, 1] })), rules({ enemyAtkMul: 2 }));
});

test('why 我的实验性 cannot be queued: nothing on, or nothing that counts in a chosen size', () => {
  const four = { seats: ['four'], rules: ['custom'] }, multi = { seats: ['multi'], rules: ['custom'] };
  assert.equal(customProblem({ seats: ['four'], rules: ['standard'] }, rules()), null, 'not asked');
  assert.equal(customProblem(four, rules()), 'empty');
  assert.equal(customProblem(four, rules({ disableDuckLord: true })), 'size');
  assert.equal(customProblem(multi, rules({ disableDuckLord: true })), null);
  assert.equal(customProblem({ seats: ['four', 'multi'], rules: ['custom'] }, rules({ disableDuckLord: true })), 'size');
  assert.equal(customProblem(four, rules({ enemyHpMul: 2 })), null);
});

test('the search names the rules a lone ticket takes', () => {
  const q = (o) => queueScope({ state: 'queued', required: 4, partyRoomCode: null, ...o })?.rules;
  assert.equal(q({ rules: ['custom'], config: rules({ revivalEnabled: true, enemyAtkMul: 2 }) }), '我的实验性 · 2 项');
  assert.equal(q({ rules: ['standard', 'custom'], config: rules({ revivalEnabled: true }) }), '标准或我的实验性 · 1 项');
  assert.equal(q({ rules: ['custom', 'experimental'], config: rules({ revivalEnabled: true }) }), '我的或任意实验性');
  assert.equal(q({ rules: ['standard', 'custom', 'experimental'], config: rules({ revivalEnabled: true }) }), '不限规则');
  assert.equal(q({ rules: ['experimental'] }), '仅实验性规则');
  assert.equal(q({ rules: ['standard'] }), '标准规则');
  assert.equal(q({}), '含实验性规则');
});

test('确认入场: the options of the offer without the seat count, and where they come from', () => {
  const offer = (o) => ({ state: 'offered', required: 4, experimental: rules(), ...o });
  assert.deepEqual(offerRules(offer()), []);
  assert.equal(offerRulesOrigin(offer()), null, 'a standard game');
  assert.deepEqual(offerRules(offer({ required: 8, experimental: rules({ playerCapacity: 8 }) })), [], 'the seat count is the chip line\'s');
  const mine = rules({ revivalEnabled: true, disableDuckLord: true });
  assert.equal(offerRulesOrigin(offer({ required: 8, experimental: { ...rules({ revivalEnabled: true }), playerCapacity: 8, disableDuckLord: true }, config: mine })), 'own');
  assert.equal(offerRulesOrigin(offer({ experimental: rules({ revivalEnabled: true }), config: mine })), 'own', 'at four seats 禁用鸭爵策略 does not count');
  assert.equal(offerRulesOrigin(offer({ experimental: rules({ enemyHpMul: 2 }), config: mine })), 'others');
  assert.equal(offerRulesOrigin(offer({ experimental: rules({ enemyHpMul: 2 }) })), 'others');
  assert.equal(offerRulesOrigin(offer({ experimental: rules({ enemyHpMul: 2 }), partyRoomCode: 'ABCD' })), 'room');
});
