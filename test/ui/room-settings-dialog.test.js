// 同盟设置 (ui/roomSettings.js): the room's options in one dialog — 同盟, and 实验性功能 by group (shared/experimental.js
// EXPERIMENTAL_GROUPS, the owner 2026-11-16), 卡池 with 手动指定卡池编组 (ui/poolEditor.js). The browser check is
// test/ui/pool-editor.e2e.test.js and test/ui/experimental-groups.e2e.test.js; the plan's rules: test/pool-plan.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { capacityRows, experimentalChanged, experimentalOptions, experimentalSummary, poolRows } from '../../public/js/ui/experimental.js';
import { changedPages, groupCounts, RoomSettings, settingsPage, settingsPages, takenSeats } from '../../public/js/ui/roomSettings.js';
import { PoolEditor, poolStock } from '../../public/js/ui/poolEditor.js';

const walk = (node) => (Array.isArray(node) ? node.flatMap(walk) : node?.props ? [node, ...walk(node.props.children)] : []);
const rules = (o = {}) => ({ revivalEnabled: false, disableSharedPool: false, ...o });
const seat = (playerId, o = {}) => ({ playerId, name: playerId, ...o });
const room = (o = {}) => ({ mode: 'coop', source: 'private', hostId: 'h', experimental: rules(), seats: [seat('h'), null, null, null], aiPicksLast: true, ...o });
const dialog = (o = {}) => walk(RoomSettings({ page: 'alliance', room: room(), myId: 'h', editable: true, busy: null, onExperimental() {}, ...o }));
const ids = (nodes) => nodes.map((n) => n.props.id).filter(Boolean);

test('a co-op room has 同盟 and six groups, a solo room three, a matchmade room four; a press opens its page or the first', () => {
  assert.deepEqual(settingsPages(room()), ['alliance', 'seats', 'team', 'bonds', 'enemy', 'pools', 'special']);
  assert.deepEqual(settingsPages(room({ mode: 'solo' })), ['bonds', 'enemy', 'special'], 'no teammates, no pools, no seat count');
  assert.deepEqual(settingsPages(room({ source: 'matchmaking' })), ['alliance', 'team', 'bonds', 'enemy', 'pools'], 'no seat count, no 联动干员 / 调控台');
  assert.equal(settingsPage(room(), 'enemy'), 'enemy');
  assert.equal(settingsPage(room(), 'experimental'), 'seats', 'nothing on: the first group');
  assert.equal(settingsPage(room({ experimental: rules({ enemyAtkMul: 2 }) }), 'experimental'), 'enemy', 'the first group with something on');
  assert.equal(settingsPage(room(), 'rules'), 'seats', 'an older caller\'s 规则');
  assert.equal(settingsPage(room({ mode: 'solo' }), 'rules'), 'bonds', '实验性功能 of a solo room');
  assert.equal(settingsPage(room({ mode: 'solo' }), 'alliance'), 'bonds');
  assert.equal(settingsPage(room(), 'nope'), 'alliance');
});

test('closed, there is nothing; open, the title says the room\'s kind', () => {
  assert.equal(RoomSettings({ page: null, room: room() }), null);
  assert.equal(RoomSettings({ page: 'alliance', room: room() }).props.title, '同盟设置');
  assert.equal(RoomSettings({ page: 'sim', room: room({ mode: 'solo' }) }).props.title, '模拟设置');
});

const rowIds = (nodes) => ids(nodes).filter((id) => !id.startsWith('rset') && !id.startsWith('expp'));
test('each page holds its rows', () => {
  const on = { on: false, editable: true };
  const big = room({ experimental: rules({ playerCapacity: 8 }), seats: new Array(8).fill(null) });
  assert.deepEqual(rowIds(dialog({ page: 'alliance', aiLast: on, takeover: on, listed: on, room: big })), ['room-ai-last', 'room-ai-takeover', 'room-opt-listed']);
  const group = (page, r = room(), o = {}) => rowIds(dialog({ page, room: r, ...o }));
  assert.deepEqual(group('seats', big), ['experimental-multiplayer', 'experimental-capacity']);
  // AI 联防置后 (rel29): co-op only (no 联防 in a solo run)
  assert.deepEqual(group('team'), ['experimental-revival', 'experimental-unite-humans']);
  assert.deepEqual(group('bonds'), ['experimental-layer-cap']);
  assert.deepEqual(group('bonds', big), ['experimental-layer-cap', 'experimental-ducklord'], '禁用鸭爵策略: an expanded room only');
  assert.deepEqual(group('enemy'), ['experimental-enemy-hp', 'experimental-enemy-hp-plan', 'experimental-enemy-atk', 'experimental-hit-limit']);
  assert.deepEqual(group('pools'), ['experimental-pool', 'experimental-pools-manual']);
  // 联动干员 and 调控台 (#125) are a private room's only (shared/experimental.js isCollabRoom / isConsoleRoom)
  assert.deepEqual(group('special'), ['experimental-collab', 'experimental-console']);
  assert.deepEqual(group('special', room({ source: 'matchmaking' })), group('alliance', room({ source: 'matchmaking' })), 'a matchmade room has no 特殊功能');
  const solo = dialog({ page: 'enemy', room: room({ mode: 'solo' }), soloOption: on });
  assert.deepEqual(rowIds(solo), ['room-solo-unlimited', 'experimental-enemy-hp', 'experimental-enemy-hp-plan', 'experimental-enemy-atk', 'experimental-hit-limit']);
  assert.equal(solo.some((n) => n.props.role === 'tablist' && n.props.class === 'rset__tabs'), false, 'no 同盟 tab');
  assert.deepEqual(solo.filter((n) => n.props.role === 'tab').map((n) => n.props['data-testid']), ['exp-group-bonds', 'exp-group-enemy', 'exp-group-special']);
  // the rail: every group of the room, the shown one selected, each with the count of what is on
  const rail = dialog({ page: 'enemy', room: room({ experimental: rules({ enemyAtkMul: 2, disableHitLimit: true, revivalEnabled: true }) }) }).filter((n) => n.props.role === 'tab');
  assert.deepEqual(rail.map((n) => n.props['data-testid']), ['room-settings-alliance', 'room-settings-experimental',
    'exp-group-seats', 'exp-group-team', 'exp-group-bonds', 'exp-group-enemy', 'exp-group-pools', 'exp-group-special']);
  assert.equal(rail.find((n) => n.props['data-testid'] === 'exp-group-enemy').props['aria-selected'], 'true');
  assert.equal(rail.find((n) => n.props['data-testid'] === 'room-settings-experimental').props['aria-selected'], 'true');
  const text = (n) => walk(n).map((x) => x.props?.children).flat(Infinity).filter((x) => typeof x === 'string' || typeof x === 'number').join('');
  assert.match(text(rail.find((n) => n.props['data-testid'] === 'exp-group-enemy')), /敌人2/);
  assert.match(text(rail.find((n) => n.props['data-testid'] === 'exp-group-team')), /队友协作1/);
  assert.match(text(rail.find((n) => n.props['data-testid'] === 'room-settings-experimental')), /3/);
});

test('the editor shows only with a plan, and its changes keep every other rule', () => {
  assert.equal(dialog({ page: 'pools' }).some((n) => n.type === PoolEditor), false);
  const sent = [];
  const nodes = dialog({ page: 'pools', onExperimental: (v) => sent.push(v), room: room({ experimental: rules({ disableLayerCap: true, poolPlan: [0, 0, 1, 1] }) }) });
  assert.equal(dialog({ page: 'enemy', room: room({ experimental: rules({ poolPlan: [0, 0, 1, 1] }) }) }).some((n) => n.type === PoolEditor), false, 'only on 卡池');
  const editor = nodes.find((n) => n.type === PoolEditor);
  assert.deepEqual(editor.props.plan, [0, 0, 1, 1]);
  editor.props.onPlan([0, 1, 1, 1]);
  assert.deepEqual(sent, [rules({ disableLayerCap: true, poolPlan: [0, 1, 1, 1] })]);
});

test('a guest reads every page: nothing to switch', () => {
  const on = { on: true, editable: false };
  const nodes = dialog({ editable: false, aiLast: on, takeover: on, listed: on, room: room({ experimental: rules({ playerCapacity: 8 }), seats: new Array(8).fill(null) }) });
  for (const input of nodes.filter((n) => n.type === 'input' || n.type === 'select')) assert.equal(input.props.disabled, true, input.props.id);
  const sent = [];
  const last = dialog({ editable: false, aiLast: on, onAiLast: (v) => sent.push(v) }).find((n) => n.props.id === 'room-ai-last');
  last.props.onChange({ currentTarget: { checked: false } });
  assert.deepEqual(sent, []);
});

test('while a request runs the host\'s switches wait', () => {
  const on = { on: false, editable: true };
  for (const input of dialog({ busy: 'experimental', aiLast: on }).filter((n) => n.type === 'input')) assert.equal(input.props.disabled, true, input.props.id);
});

test('手动指定卡池编组 turns on from the automatic rule and off without a trace', () => {
  const sent = [], props = { editable: true, onChange: (v) => sent.push(v) };
  const manual = (value, seats) => walk(poolRows({ value, seats, ...props })).find((n) => n.props.id === 'experimental-pools-manual');
  manual(rules(), [0]).props.onChange({ currentTarget: { checked: true } });
  assert.deepEqual(sent.at(-1), rules({ poolPlan: [0, 0, 0, 0] }));
  manual(rules({ playerCapacity: 8 }), [0, 1, 2, 3, 4, 5]).props.onChange({ currentTarget: { checked: true } });
  assert.deepEqual(sent.at(-1).poolPlan, [0, 0, 0, 1, 1, 1, 1, 1], 'six of eight start 3 + 3');
  manual(rules({ disableSharedPool: true }), [0, 1]).props.onChange({ currentTarget: { checked: true } });
  assert.deepEqual(sent.at(-1), rules({ poolPlan: [0, 1, 2, 3] }), '禁用共享卡池 is what the automatic rule built');
  manual(rules({ poolPlan: [0, 0, 1, 1] }), []).props.onChange({ currentTarget: { checked: false } });
  assert.deepEqual(sent.at(-1), rules());
});

test('禁用共享卡池 waits while the plan decides', () => {
  const sw = walk(poolRows({ value: rules({ poolPlan: [0, 0, 1, 1] }), editable: true })).find((n) => n.props.id === 'experimental-pool');
  assert.equal(sw.props.disabled, true);
  assert.equal(sw.props.checked, false);
});

test('a new seat count takes a new layout from the automatic rule, in the same message', () => {
  const sent = [];
  const nodes = walk(capacityRows({ value: rules({ playerCapacity: 8, poolPlan: [0, 1, 1, 1, 1, 1, 1, 1] }), seats: [0], editable: true, onChange: (v) => sent.push(v) }));
  nodes.find((n) => n.props.id === 'experimental-capacity').props.onChange({ currentTarget: { value: '12' } });
  assert.deepEqual(sent.at(-1), rules({ playerCapacity: 12, poolPlan: [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2] }));
  nodes.find((n) => n.props.id === 'experimental-multiplayer').props.onChange({ currentTarget: { checked: false } });
  assert.deepEqual(sent.at(-1), rules({ poolPlan: [0, 0, 0, 0] }));
});

test('the page options read a plan, and a stale or foreign plan is none', () => {
  assert.deepEqual(experimentalOptions(rules({ poolPlan: [1, 1, 0, 0] })), rules({ poolPlan: [0, 0, 1, 1] }));
  assert.deepEqual(experimentalOptions(rules({ poolPlan: [0, 1] })), rules());
  assert.equal(experimentalChanged(rules({ poolPlan: [0, 0, 0, 0] })), true);
  assert.match(experimentalSummary(rules({ poolPlan: [0, 0, 1, 2] })), /手动卡池 3 组$/);
  assert.doesNotMatch(experimentalSummary(rules()), /手动卡池/);
});

test('a tab\'s dot / a group\'s count says that page differs from a new room', () => {
  const none = { alliance: false, seats: false, team: false, bonds: false, enemy: false, pools: false, special: false };
  assert.deepEqual(changedPages(room()), none);
  assert.deepEqual(changedPages(room({ listed: true })), { ...none, alliance: true });
  assert.equal(changedPages(room({ aiPicksLast: false })).alliance, true, 'on by default');
  assert.deepEqual(changedPages(room({ experimental: rules({ playerCapacity: 8 }) })), { ...none, seats: true });
  assert.deepEqual(changedPages(room({ experimental: rules({ enemyHpMul: 2 }) })), { ...none, enemy: true });
  assert.deepEqual(changedPages(room({ experimental: rules({ disableSharedPool: true }) })), { ...none, pools: true });
  assert.equal(changedPages(room({ experimental: rules({ poolPlan: [0, 0, 0, 0] }) })).pools, true);
  assert.deepEqual(groupCounts(room({ experimental: rules({ enemyHpMul: 2, enemyAtkMul: 3, revivalEnabled: true, console: true }) })), { enemy: 2, team: 1, special: 1 });
});

test('takenSeats keeps room seat numbers', () => {
  assert.deepEqual(takenSeats(room({ seats: [seat('a'), null, seat('b'), null] })), [0, 2]);
});

test('a pool reads its taken seats, or its seats while none is taken', () => {
  const seats = [seat('a'), null, null, null, seat('b'), seat('c'), seat('d'), seat('e'), seat('f'), seat('g')];
  assert.deepEqual(poolStock([1, 2, 3], seats), { taken: 0, scale: 1 });
  assert.deepEqual(poolStock([4, 5, 6, 7, 8, 9], seats), { taken: 6, scale: 1.5 });
  assert.deepEqual(poolStock([0, 1], seats), { taken: 1, scale: 1 });
  assert.deepEqual(poolStock([1, 2, 3, 10, 11], seats), { taken: 0, scale: 1.25 }, 'five empty seats');
});

test('the room shows the plan on its seats only when there is one, and the old popover is gone', () => {
  const src = readFileSync(new URL('../../public/js/screens/room.js', import.meta.url), 'utf8');
  assert.match(src, /room\.experimental\?\.poolPlan\?\.\[index\]/);
  assert.doesNotMatch(src, /RoomOptions|rs-opts|ExperimentalOptions/);
  const css = readFileSync(new URL('../../public/css/screens/lobby.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.rs-opts|\.rs-opt\b/);
  assert.doesNotMatch(css, /:has\(|@container|@layer/, 'ESR 115 and older Safari');
});
