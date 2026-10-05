import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortcutFor, shortcutBlocked, selectionShortcutAllowed } from '../../public/js/ui/gameLogic.js';

const selected = (area = 'board', kind = 'chess') => ({ editable: true, entry: { area, piece: { uid: 1, kind } } });

test('Q/X selection keys keep text, modifiers, composition, repeat and modal guards', () => {
  for (const [key, action] of [['q', 'retreat'], ['x', 'sell']]) {
    assert.equal(shortcutFor({ key }), action);
    assert.equal(shortcutFor({ code: `Key${key.toUpperCase()}` }), action);
    for (const flag of ['ctrlKey', 'metaKey', 'altKey', 'repeat', 'isComposing']) assert.equal(shortcutFor({ key, [flag]: true }), null);
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(shortcutFor({ key, target: { tagName } }), null);
    assert.equal(shortcutFor({ key, target: { isContentEditable: true } }), null);
    assert.equal(shortcutBlocked(action, { modal: true }), true);
    assert.equal(shortcutBlocked(action, { drawer: true }), true);
  }
});

test('only editable selected operators can retreat or sell, never tokens or item destruction', () => {
  assert.equal(selectionShortcutAllowed('retreat', selected()), true);
  for (const area of ['hand', 'temp']) assert.equal(selectionShortcutAllowed('retreat', selected(area)), false);
  for (const area of ['board', 'hand', 'temp']) assert.equal(selectionShortcutAllowed('sell', selected(area)), true);
  for (const kind of ['token', 'item', 'enemy']) {
    for (const act of ['retreat', 'sell']) assert.equal(selectionShortcutAllowed(act, selected('board', kind)), false);
  }
  for (const act of ['retreat', 'sell']) {
    assert.equal(selectionShortcutAllowed(act), false);
    assert.equal(selectionShortcutAllowed(act, { ...selected(), editable: false }), false);
    for (const flag of ['dragging', 'facing', 'busy']) assert.equal(selectionShortcutAllowed(act, { ...selected(), [flag]: true }), false);
  }
  assert.equal(selectionShortcutAllowed('destroy', selected()), false);
  assert.equal(selectionShortcutAllowed('sell', selected('equipped')), false);
});
