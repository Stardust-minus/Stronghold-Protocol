import test from 'node:test';
import assert from 'node:assert/strict';
import { teamPanelLayout } from '../../public/js/ui/teamLayout.js';

for (const count of [5, 6, 8, 12, 16, 20]) {
  for (const [height, root] of [[630, 100], [560, 75], [420, 66], [250, 40], [220, 40]]) {
    test(`${count} teammates fit ${height}px without dropping the final seat`, () => {
      const layout = teamPanelLayout(count, height, root);
      assert.ok(layout.columns >= 1 && layout.columns <= 3);
      assert.equal(layout.rows, Math.ceil(count / layout.columns));
      assert.ok(layout.rows * layout.rowHeight + (layout.rows - 1) * layout.gap <= height + 0.001);
      assert.ok(layout.avatar <= layout.rowHeight);
      assert.ok(layout.rowHeight >= 20, 'supported short screens keep readable compact rows');
    });
  }
}

test('resize recomputes columns rather than hiding or scrolling seats', () => {
  const tall = teamPanelLayout(20, 630, 100);
  const short = teamPanelLayout(20, 250, 40);
  assert.equal(tall.columns, 1);
  assert.equal(short.columns, 2);
  assert.equal(short.rows, 10);
  assert.equal(teamPanelLayout(20, 560, 75).columns, 1);
  assert.deepEqual(teamPanelLayout(20, 630, 100), tall);
});
