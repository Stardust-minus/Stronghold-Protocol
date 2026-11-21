// The strategy draft's battlefield (#65): the stage's picture — the render of its 3D board the briefing shows
// (ui/stagePreview.js StageShot, the same stageThumb.js cache) — beside its name and the mode's pool. No drawn tile map
// since 2026-11-21 (the owner: 「去掉CSS地图，直接用实际图片」). The browser pass is test/ui/match-chrome-feedback.e2e.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
globalThis.document ??= { createElement: () => ({}), head: { appendChild() {} }, documentElement: { style: {} } };
const preview = await import('../../public/js/ui/stagePreview.js');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

test('the draft shows the stage\'s render (StageShot), with no drawn mini map left', () => {
  assert.equal(typeof preview.StageShot, 'function');
  assert.equal(preview.StageMiniMap, undefined);
  const draft = read('public/js/screens/bandDraft.js');
  assert.match(draft, /<\$\{StageShot\} stage=\$\{stage\} stageId=\$\{pub\.stageId\} localGroups=/);
  assert.doesNotMatch(draft, /StageMiniMap/);
  assert.doesNotMatch(read('public/css/screens/draft.css'), /\.stagemap/);
  assert.match(read('public/css/screens/draft.css'), /\.draft-map \.reg-map--shot \{/);
});

test('every battlefield of every version has a 3D scene to render (the 联防 templates aside)', () => {
  const local = path.join(ROOT, 'data/local-assets.json');
  if (!existsSync(local)) return; // git-ignored: CI has none
  const groups = JSON.parse(readFileSync(local, 'utf8')).groups;
  const json = (p) => JSON.parse(read(p));
  const ids = new Set(Object.keys(json('data/stages.json')));
  for (const dir of readdirSync(path.join(ROOT, 'data/versions'))) {
    const f = `data/versions/${dir}/stages.json`;
    if (existsSync(path.join(ROOT, f))) for (const id of Object.keys(json(f))) ids.add(id);
  }
  const fields = [...ids].filter((id) => !id.includes('escaped'));
  assert.ok(fields.length >= 11, `${fields.length} stages`);
  for (const id of fields) assert.equal(preview.stageSceneListed(groups, id), true, id);
});
