import test from 'node:test';
import assert from 'node:assert/strict';
import { teamPanelLayout } from '../../public/js/ui/teamLayout.js';

for (const count of [4, 5, 6, 8, 12, 16, 20]) {
  for (const [height, root] of [[630, 100], [560, 75], [420, 66], [250, 40], [220, 40]]) {
    test(`${count} teammates stay readable at ${height}px with every seat reachable`, () => {
      const layout = teamPanelLayout(count, height, root, 480);
      assert.ok(layout.columns >= 1 && layout.columns <= 2);
      assert.equal(layout.rows, Math.ceil(count / layout.columns));
      assert.ok(layout.avatar <= layout.rowHeight);
      assert.ok(layout.avatar >= 36);
      assert.ok(layout.rowHeight >= 48, 'short screens scroll rather than shrinking interaction rows');
      assert.ok(layout.rows * layout.columns >= count, 'the final seat has a layout slot');
    });
  }
}

test('wide rosters use two columns, narrow and touch rosters preserve one readable scrolling column', () => {
  assert.equal(teamPanelLayout(20, 630, 100, 480).columns, 2);
  const short = teamPanelLayout(20, 220, 40, 480);
  assert.equal(short.columns, 2); assert.equal(short.rows, 10);
  assert.ok(short.rows * short.rowHeight > 220, 'overflow is intentionally confined to the roster');
  const touch = teamPanelLayout(20, 220, 40, 340, true);
  assert.equal(touch.columns, 1); assert.equal(touch.rows, 20);
  assert.equal(teamPanelLayout(20, 630, 100, 280).columns, 1);
  assert.equal(teamPanelLayout(5, 630, 100, 480).columns, 1);
});
