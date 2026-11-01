// 同盟设置 (ui/roomSettings.js): the room's options in one dialog, 卡池 with 手动指定卡池编组 (ui/poolEditor.js). The browser check
// is test/ui/pool-editor.e2e.test.js; the plan's rules: test/pool-plan.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { capacityRows, experimentalChanged, experimentalOptions, experimentalSummary, poolRows } from '../../public/js/ui/experimental.js';
import { changedPages, RoomSettings, settingsPage, settingsPages, takenSeats } from '../../public/js/ui/roomSettings.js';
import { PoolEditor, poolStock } from '../../public/js/ui/poolEditor.js';

const walk = (node) => (Array.isArray(node) ? node.flatMap(walk) : node?.props ? [node, ...walk(node.props.children)] : []);
const rules = (o = {}) => ({ revivalEnabled: false, disableSharedPool: false, ...o });
const seat = (playerId, o = {}) => ({ playerId, name: playerId, ...o });
const room = (o = {}) => ({ mode: 'coop', source: 'private', hostId: 'h', experimental: rules(), seats: [seat('h'), null, null, null], aiPicksLast: true, ...o });
const dialog = (o = {}) => walk(RoomSettings({ page: 'alliance', room: room(), myId: 'h', editable: true, busy: null, onExperimental() {}, ...o }));
const ids = (nodes) => nodes.map((n) => n.props.id).filter(Boolean);

test('a co-op room has three pages, a solo room one; a press opens its page or the first', () => {
  assert.deepEqual(settingsPages(room()), ['alliance', 'rules', 'pools']);
  assert.deepEqual(settingsPages(room({ mode: 'solo' })), ['sim']);
  assert.equal(settingsPage(room(), 'rules'), 'rules');
  assert.equal(settingsPage(room({ mode: 'solo' }), 'rules'), 'sim', '实验性选项 of a solo room');
  assert.equal(settingsPage(room({ mode: 'solo' }), 'alliance'), 'sim');
});

test('closed, there is nothing; open, the title says the room\'s kind', () => {
  assert.equal(RoomSettings({ page: null, room: room() }), null);
  assert.equal(RoomSettings({ page: 'alliance', room: room() }).props.title, '同盟设置');
  assert.equal(RoomSettings({ page: 'sim', room: room({ mode: 'solo' }) }).props.title, '模拟设置');
});

test('each page holds its rows', () => {
  const on = { on: false, editable: true };
  const alliance = ids(dialog({ page: 'alliance', aiLast: on, takeover: on, listed: on, room: room({ experimental: rules({ playerCapacity: 8 }), seats: new Array(8).fill(null) }) }));
  assert.deepEqual(alliance.filter((id) => !id.startsWith('rset')), ['experimental-multiplayer', 'experimental-capacity', 'room-ai-last', 'room-ai-takeover', 'room-opt-listed', 'experimental-ducklord']);
  assert.deepEqual(ids(dialog({ page: 'rules' })).filter((id) => !id.startsWith('rset')), ['experimental-revival', 'experimental-layer-cap', 'experimental-hit-limit', 'experimental-enemy-hp', 'experimental-enemy-atk']);
  assert.deepEqual(ids(dialog({ page: 'pools' })).filter((id) => !id.startsWith('rset')), ['experimental-pool', 'experimental-pools-manual']);
  const solo = dialog({ page: 'sim', room: room({ mode: 'solo' }), soloOption: on });
  assert.deepEqual(ids(solo).filter((id) => !id.startsWith('rset')), ['room-solo-unlimited', 'experimental-layer-cap', 'experimental-hit-limit', 'experimental-enemy-hp', 'experimental-enemy-atk']);
  assert.equal(solo.some((n) => n.props.role === 'tablist'), false, 'one page, no tabs');
});

test('the editor shows only with a plan, and its changes keep every other rule', () => {
  assert.equal(dialog({ page: 'pools' }).some((n) => n.type === PoolEditor), false);
  const sent = [];
  const nodes = dialog({ page: 'pools', onExperimental: (v) => sent.push(v), room: room({ experimental: rules({ disableLayerCap: true, poolPlan: [0, 0, 1, 1] }) }) });
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

test('a tab\'s dot says that page differs from a new room', () => {
  assert.deepEqual(changedPages(room()), { alliance: false, rules: false, pools: false });
  assert.deepEqual(changedPages(room({ listed: true })), { alliance: true, rules: false, pools: false });
  assert.equal(changedPages(room({ aiPicksLast: false })).alliance, true, 'on by default');
  assert.equal(changedPages(room({ experimental: rules({ playerCapacity: 8 }) })).alliance, true);
  assert.deepEqual(changedPages(room({ experimental: rules({ enemyHpMul: 2 }) })), { alliance: false, rules: true, pools: false });
  assert.deepEqual(changedPages(room({ experimental: rules({ disableSharedPool: true }) })), { alliance: false, rules: false, pools: true });
  assert.equal(changedPages(room({ experimental: rules({ poolPlan: [0, 0, 0, 0] }) })).pools, true);
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
