import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeSeats, roomFacts, partyQueueReason } from '../../public/js/screens/room.js';
import { experimentalOptions, experimentalSummary, ExperimentalOptions } from '../../public/js/ui/experimental.js';

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const rules = capacity => ({ revivalEnabled: false, disableSharedPool: false, ...(capacity > 4 ? { playerCapacity: capacity } : {}) });
const walk = node => Array.isArray(node) ? node.flatMap(walk) : node?.props ? [node, ...walk(node.props.children)] : [];
const seat = (i, ready = true) => ({ seat: i, playerId: `p${i}`, name: `Capacity${i}`, ready, connected: true, isBot: false });

for (const capacity of [4, 8, 10, 16, 20]) test(`room rendering derives the admitted ${capacity} slots without losing the last member`, () => {
  const room = { mode: 'coop', hostId: 'p0', experimental: rules(capacity), seats: Array.from({ length: capacity }, (_, i) => seat(i)) };
  const seats = normalizeSeats(room), facts = roomFacts(room, `p${capacity - 1}`);
  assert.equal(seats.length, capacity); assert.equal(seats.at(-1).playerId, `p${capacity - 1}`);
  assert.equal(facts.mine.seat, capacity - 1); assert.equal(facts.humans.length, capacity);
  assert.equal(roomFacts(room, 'p0').canStart, true);
  room.seats.at(-1).ready = false; assert.equal(roomFacts(room, 'p0').canStart, false);
  assert.equal(normalizeSeats({ ...room, mode: 'solo' }).length, 1);
});

test('party queue requires every other human ready and excludes expanded rooms even with only two players', () => {
  const room = { mode: 'coop', hostId: 'p0', experimental: rules(4), seats: [seat(0, false), seat(1)] };
  assert.equal(partyQueueReason(room, 'p0'), null, 'host queue action is the host readiness');
  room.seats[1].ready = false; assert.match(partyQueueReason(room, 'p0'), /未准备/);
  room.seats[1].ready = true;
  for (const capacity of [8, 10, 16, 20]) assert.match(partyQueueReason({ ...room, experimental: rules(capacity) }, 'p0'), /不能参与公开匹配/);
});

test('capacity UI sends immutable full options, can restore defaults, and never changes pool or rescue toggles', () => {
  const value = rules(4), changes = [];
  const view = ExperimentalOptions({ open: true, value, editable: true, onChange: next => changes.push(next) });
  const toggle = walk(view).find(node => node.props.id === 'experimental-multiplayer');
  assert.equal(toggle.props.checked, false); toggle.props.onChange({ currentTarget: { checked: true } });
  assert.deepEqual(changes, [rules(8)]); assert.deepEqual(value, rules(4));
  const expanded = ExperimentalOptions({ open: true, value: rules(20), editable: true, onChange: next => changes.push(next) });
  const picker = walk(expanded).find(node => node.props.id === 'experimental-capacity');
  assert.equal(picker.props.value, 20);
  assert.deepEqual(walk(picker).filter(node => node.type === 'option').map(node => node.props.value), [8, 10, 16, 20]);
  picker.props.onChange({ currentTarget: { value: '16' } }); assert.deepEqual(changes.at(-1), rules(16));
  picker.props.onChange({ currentTarget: { value: '21' } }); assert.deepEqual(changes.at(-1), rules(16));
  walk(expanded).find(node => node.props.id === 'experimental-multiplayer').props.onChange({ currentTarget: { checked: false } });
  assert.deepEqual(changes.at(-1), rules(4));
  assert.equal(experimentalSummary(rules(20)), '复活 关闭 · 共享卡池 开启 · 20 人好友房');
  assert.deepEqual(experimentalOptions({ ...rules(4), playerCapacity: '20' }), rules(4));
});

test('capacity controls remain room-host-only, busy-locked, and absent in solo', () => {
  const changes = [];
  for (const props of [{ editable: false }, { editable: true, busy: true }]) {
    const view = ExperimentalOptions({ open: true, value: rules(20), onChange: next => changes.push(next), ...props });
    for (const node of walk(view).filter(node => node.props.id === 'experimental-multiplayer' || node.props.id === 'experimental-capacity')) {
      assert.equal(node.props.disabled, true); node.props.onChange({ currentTarget: { checked: true, value: '8' } });
    }
  }
  const solo = ExperimentalOptions({ open: true, value: rules(4), mode: 'solo', editable: true });
  assert.ok(!walk(solo).some(node => node.props.id === 'experimental-multiplayer'));
  const publicRoom = ExperimentalOptions({ open: true, value: rules(4), source: 'matchmaking', editable: true });
  assert.ok(!walk(publicRoom).some(node => node.props.id === 'experimental-multiplayer'));
  assert.equal(changes.length, 0);
});

test('large seat, teammate, strategy and contingency lists scroll inside bounded panels', () => {
  assert.match(source('../../public/css/screens/room.css'), /\.seats\.seats--expanded \{[^}]*overflow-y: auto/);
  assert.match(source('../../public/css/screens/game.css'), /\.team\.team--expanded \{[^}]*max-height:[^}]*overflow-y: auto/);
  assert.match(source('../../public/css/screens/draft.css'), /\.draft-order__players \{[^}]*overflow-y: auto/);
  assert.match(source('../../public/css/screens/game-panels.css'), /\.spov--expanded \.spov__grid \{[^}]*overflow-y: auto/);
  assert.match(source('../../public/js/ui/teamPanel.js'), /players\.length > 6 && 'team--expanded'/);
  assert.match(source('../../public/js/ui/choiceOverlay.js'), /sp\.cards\.length > 6 && 'spov--expanded'/);
});
