import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../public/entry-nav.js', import.meta.url), 'utf8');
function run(path) {
  const location = new URL(path, 'https://ark-proto.stardust.matce.cn');
  const replaced = [];
  vm.runInNewContext(source, { URL, location, history: { state: { retained: true }, replaceState: (...args) => replaced.push(args) } });
  return replaced;
}
for (const path of ['/', '/index.html', '/_release/old/public/', '/_release/old/public/index.html']) {
  test(`entry navigation removes only animation marker on ${path}`, () => {
    assert.deepEqual(run(path + '?_prts=1&room=ABCD#loadout'), [[{ retained: true }, '', path + '?room=ABCD#loadout']]);
    assert.deepEqual(run(path + '?room=ABCD'), []);
  });
}
test('entry navigation never changes assets, arbitrary paths or invalid release ids', () => {
  for (const path of ['/js/main.js', '/_release/old/public/js/main.js', '/_release/old', '/_release/.hidden/public/', '/_release/old/other/']) assert.deepEqual(run(path + '?_prts=1'), []);
});
