// The phone fixes of 2026-10-11, carried into the hub lobby of 2026-10-14 (the design by 雨千代chiyo): 全屏 stays in the top
// bar and explains itself where the browser has no element fullscreen (iPhone), the join key never zooms iOS on focus,
// and the hub keeps this server's own entries. Layout is checked in the browser (test/ui/multiplayer-mobile.e2e.test.js;
// SP_E2E=1). The folded roster's emotes became danmaku: test/ui/team-roster.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = name => readFileSync(new URL(name, import.meta.url), 'utf8');

test('全屏 sits in the hub top bar beside 设置 / 玩法说明, with the explanation where it is unsupported', () => {
  const lobby = source('../../public/js/screens/lobby.js');
  const tools = lobby.slice(lobby.indexOf('<div class="topbar__tools">'), lobby.indexOf('<div class="topbar__right">'));
  assert.match(tools, /<\$\{SettingsButton\}/);
  assert.match(tools, /<\$\{GuideButton\}/);
  assert.match(tools, /<\$\{HubFullscreenButton\} \/>/);
  assert.match(lobby, /if \(!ok\) return html`<\$\{FullscreenButton\} class="hub-fs-btn hub-fs-btn--help" showUnavailable=\$\{true\} \/>`/);
  // the name chip is the one 统计数据 entry of the hub
  assert.equal((lobby.match(/onClick=\$\{openStats\}/g) || []).length, 1);
});

test('the hub keeps the join key, 公告, the boards and the queue', () => {
  const lobby = source('../../public/js/screens/lobby.js');
  assert.match(lobby, /<\$\{HubTile\} icon="key" label=\$\{t\('密钥加入'\)\}/);
  assert.match(lobby, /<\$\{NoticeCard\} value=\$\{noticeValue\}/);
  assert.match(lobby, /<div class="hub-contact"><div class="hub-contact__row"><\$\{SiteBoards\} \/><\/div><\$\{DesignCredit\} \/><\$\{HubFoot\} \/><\/div>/);
  assert.match(lobby, /net\.request\('queue\.join', \{ difficulty: matchFocus/);
  assert.match(lobby, /<\$\{QueueFlow\} queue=\$\{queue\}/);
  const css = source('../../public/css/screens/lobby.css');
  assert.match(css, /\.lobby-screen \.join-row \.field--code \.field__input \{ font-size: max\(calc\(\.34 \* var\(--t\)\), 16px\); \}/, 'no iOS focus zoom');
  assert.match(css, /:is\(\.sp-touch, \.sp-coarse\) :is\(\.ally-key input, \.cardpick__search input, \.sw-search input\) \{ font-size: 16px; \}/);
});
