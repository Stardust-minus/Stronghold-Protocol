// test/ui/ui-leftovers-3533.test.js — the §35.18 UI leftovers fixed in 0.3.2 (DESIGN §35.51), pinned in the stylesheets
// and the markup; the browser checks are test/ui/room-fit.e2e.test.js and lobby-hub.e2e.test.js (text-fit) and the
// measurements in §35.51.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const css = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const block = (text, head) => {
  const i = text.indexOf(head);
  assert.ok(i >= 0, head);
  let depth = 0;
  for (let j = text.indexOf('{', i); j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}' && --depth === 0) return text.slice(i, j + 1);
  }
  return text.slice(i);
};

test('the 机变 overlay leaves the corner\'s buttons uncovered: they wrap within its 2.8rem column, a phone\'s overlay starts past them', () => {
  const panels = css('public/css/screens/game-panels.css');
  assert.match(panels, /\.spov \{ position: absolute; inset: 0 0 0 2\.8rem;/);
  assert.match(block(panels, '@media (min-width: 768px) {\n  .gm.has-sp .gm__corner'),
    /\.gm\.has-sp \.gm__corner \{ flex-wrap: wrap-reverse; align-content: flex-start; max-width: calc\(2\.8rem - \.24rem - \.1rem\); \}/);
  const dev = css('public/css/devices.css');
  // the coarse phone's overlay starts past the corner's wrapped width (measured in the browser: mock.e2e's 「the 机变
  // overlay leaves every corner button clickable」, elementFromPoint at each button's centre, wide windows and a phone)
  assert.match(dev, /\.gm\.has-sp > \.spov \{ left: calc\(max\(2\.8rem,/);
  assert.match(dev, /\.gm\.is-collapsed\.has-sp \.gm__corner \{ flex-wrap: wrap-reverse;/);
});

test('text-fit: ellipsis exceptions stay scoped; only player names may break inside a word', () => {
  const src = readFileSync(path.join(ROOT, 'test/e2e/text-fit.mjs'), 'utf8');
  assert.match(src, /webkitLineClamp/);
  // §35.23.12: callers may allow the compact version pill while checking its accessible name and bounds.
  assert.ok(src.includes("export function textProblems(rootSel, extraEllipsis = '')"));
  assert.ok(src.includes("if (!cut.matches(`.seat__name, .specbar__who, .room-mode${extraEllipsis ? `, ${extraEllipsis}` : ''}`)) out.push(`ellipsis ${label}`);"));
  assert.match(src, /!breakOk\(p, c\) && !el\.closest\('\.seat__name'\)/);
});

test('the other event screens at a big 文字大小: 成就统计\'s banner, the briefing\'s header, 已被选择, the top bar\'s ping, the loadout card view', () => {
  const stats = css('public/css/screens/stats.css');
  assert.match(stats, /\.achv__banner \{[^}]*min-height: \.74rem;/);
  assert.doesNotMatch(stats, /\.achv__banner \{[^}]*[^-]height: \.74rem/);
  assert.match(stats, /\.achv__title \{[^}]*grid-template-areas: "mark en" "mark name";/);
  assert.doesNotMatch(stats, /margin: 0 0 0 -\.9rem/, 'the name no longer slides under the decorative ALLIANCE');
  const brief = css('public/css/screens/briefing.css');
  const briefShort = block(brief, '@media (max-height: 520px) {');
  for (const r of [/\.stephead__micro \{ display: none; \}/, /\.stephead__guide \.btn__label \{ display: none; \}/]) assert.match(briefShort, r);
  // the review: the bars grow at every height (1024×600 at 特大 too), the micro gives way at 大 / 特大 up to 640 px
  assert.match(brief, /\.brief \.brief-h \{[^}]*height: auto; min-height: \.66rem;/);
  assert.match(block(brief, '@media (max-height: 640px) {'), /:root\[data-text="xl"\] \.stephead__micro \{ display: none; \}/);
  assert.match(readFileSync(path.join(ROOT, 'public/js/ui/matchEnemies.js'), 'utf8'), /<b>\$\{slashBreaks\(name\)\}<\/b>/);
  const draft = block(css('public/css/screens/draft.css'), '@media (max-height: 520px) {');
  assert.match(draft, /\.dband__taken \{ white-space: nowrap;[^}]*font-size: min\(calc\(\.21 \* var\(--t\)\), calc\(12px \+ var\(--t-step\) \/ 2\)\); \}/);
  assert.match(draft, /\.dband__name \{[^}]*text-wrap: balance;[^}]*-webkit-line-clamp: 2;/);
  assert.match(draft, /\.draft\.has-status \.stephead__name \{ display: none; \}/);
  assert.match(draft, /\.draft-skip \{[^}]*white-space: nowrap;/);
  // the review: Japanese names by the line-breaking rules, Korean names on one line; the header's status wraps beside 2/2
  assert.match(draft, /\.dband__name:lang\(ja\) \{ line-break: strict; \}/);
  assert.match(draft, /\.dband__name:lang\(ko\) \{ display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; \}/);
  const draftAll = css('public/css/screens/draft.css');
  assert.match(draftAll, /\.draft \.stephead__right \{ flex: 1 1 0;/);
  assert.match(draftAll, /\.draft \.dturn__go b \{ white-space: normal; text-wrap: balance;/);
  assert.match(draftAll, /\.draft \.draft-skip \{ height: auto;/, 'above the base rule (`.draft`)');
  // §35.56: the step's name gives way by text size (大 / 特大) and on short screens, not by window width; 玩法说明 keeps its box
  assert.doesNotMatch(draftAll, /@media \(max-width: 1440px\)/);
  assert.match(draftAll, /:root\[data-text="lg"\] \.draft\.has-status \.stephead__name, :root\[data-text="xl"\] \.draft\.has-status \.stephead__name \{ display: none; \}/);
  assert.match(block(draftAll, '@media (max-height: 640px) {'), /\.draft\.has-status \.stephead__name \{ display: none; \}/);
  assert.match(draftAll, /\.draft \.stephead__guide \{ flex: none; \}/);
  assert.match(brief, /margin: \.1rem \.5rem max\(1\.6rem, calc\(\.76rem \+ \.58 \* var\(--t\)\)\);/);
  assert.match(briefShort, /\.brief \.stephead__name \{ min-width: 0; white-space: normal; text-wrap: balance;/);
  const panels = css('public/css/screens/game-panels.css');
  assert.match(panels, /\.spov \.rt:lang\(ko\), \.spov \.rt-note:lang\(ko\), \.spov \.rt-vup:lang\(ko\) \{ word-break: keep-all; overflow-wrap: break-word; \}/);
  assert.match(block(panels, '@media (max-height: 520px) {\n  .spov__titles'), /\.spov__sub \{ grid-row: 3; grid-column: 1 \/ -1;/);
  assert.match(readFileSync(path.join(ROOT, 'public/js/screens/bandDraft.js'), 'utf8'), /held && 'is-held', head && 'has-status'\)/);
  assert.match(css('public/css/screens/game.css'), /\.gtop__net \.ping \{ height: auto; min-height: \.32rem; padding-top: 1px; padding-bottom: 1px; \}/);
  const lo = css('public/css/screens/loadout.css');
  assert.match(lo, /\.lo-top__note \{ margin: 0; max-width: min\(8\.4rem, 100%\);/);
  assert.match(lo, /\.lo-bbar__tiers \{[^}]*padding-top: max\(\.24rem, calc\(17px \* var\(--sp-ui, 1\)\)\); \}/);
});

