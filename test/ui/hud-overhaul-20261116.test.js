// The 2026-11-16 in-match UI overhaul (the owner: 「地图周边会出现一些黑色缺损」「人物立绘会跳出卡面的框」「可露希尔的右上角准备没有紧贴
// 右上角」「所有主题把鼠标放到冻结/刷新上时都会出现异常现象」「UI必须大修」): the stylesheet rules that keep each fix, and the card
// markup. The scene backdrop is pinned in test/render/board3d-scene.test.js; the screenshots are under the release's UI 大修 folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PANEL_RIGHT_BOTTOM_SHOP_REG } from '../../public/js/ui/gameLogic/panel.js';

globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
const { ChessCard } = await import('../../public/js/ui/shopBar.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const reg = read('public/css/screens/game-reghud.css');
const theme = read('public/css/ui-theme.css');
/** The declarations of the first rule whose selector list is exactly `sel` (comments stripped first). */
function block(css, sel) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const m = new RegExp(`(?:^|[}\\s])${esc}\\s*\\{([^}]*)\\}`).exec(src);
  return m ? m[1] : null;
}
function* walk(v) {
  if (!v || typeof v !== 'object') return;
  if (Array.isArray(v)) { for (const x of v) yield* walk(x); return; }
  yield v;
  yield* walk(v.props?.children);
}
const hasClass = (v, c) => typeof v?.props?.class === 'string' && v.props.class.split(/\s+/).includes(c);

test('no stylesheet comment ends early and leaks its words into a rule (a path like themes/*/x closes the comment)', () => {
  const dirs = ['public/css', 'public/css/screens'];
  for (const dir of dirs) {
    for (const f of readdirSync(path.join(ROOT, dir)).filter((n) => n.endsWith('.css'))) {
      const src = read(`${dir}/${f}`).replace(/\/\*[\s\S]*?\*\//g, ' ');
      for (const m of src.matchAll(/([^{};]*)\{/g)) {
        const prelude = m[1].replace(/"[^"]*"|'[^']*'/g, '').replace(/\[[^\]]*\]/g, '').trim();
        assert.doesNotMatch(prelude, /[一-鿿「」]|\bthe\s|\(the owner|\s\w+ing\s/, `${dir}/${f}: ${prelude.slice(0, 80)}`);
      }
    }
  }
});

test('冻结 / 刷新 keep their plate when hovered or pressed: size, repeat, no box glow', () => {
  const b = block(reg, '.shopbar.shopbar--reg .toolbtn:hover:not(:disabled),\n.shopbar.shopbar--reg .toolbtn:active:not(:disabled)');
  assert.ok(b, 'the hover / press rule');
  assert.match(b, /background-size:\s*100% 100%/);
  assert.match(b, /background-repeat:\s*no-repeat/);
  assert.match(b, /box-shadow:\s*none/);
  assert.match(theme, /html\[data-sp-slot~="shop_refresh"\] \.shopbar--reg \.toolbtn--amber:hover:not\(:disabled\)/);
});

test('a 规程 card\'s portrait sits in a clipping box, right of centre as the prefab\'s char_portrait', () => {
  const priv = { funds: 20, hand: [], board: [], temp: [], loadout: {} };
  const card = ChessCard({ slot: { kind: 'chess', id: 'chess_x', price: 3, basePrice: 3 }, idx: 0, priv, onBuy() {}, onDetail() {}, reg: true });
  const nodes = [...walk(card)];
  const box = nodes.find((n) => hasClass(n, 'scard__artbox'));
  assert.ok(box, 'the art box');
  assert.ok([...walk(box.props.children)].some((n) => n.props?.class === 'scard__art'), 'the portrait inside it');
  const clip = block(reg, '.scard.scard--reg .scard__artbox');
  assert.match(clip, /position:\s*absolute;\s*inset:\s*0/);
  assert.match(clip, /clip-path:\s*inset\(var\(--art-clip-t, 0\) var\(--art-clip-r, 0\) 0 0\)/);
  const art = block(reg, '.scard.scard--reg .scard__artbox > .scard__art');
  assert.match(art, /transform:\s*none/, 'the covenant card\'s centring transform is dropped');
  assert.match(art, /right:\s*-6\.1%;\s*top:\s*-15\.8%;\s*width:\s*72\.3%/);
  // the face sprites' transparent margins
  assert.match(theme, /html\[data-sp-theme="ac_s_closur"\]\[data-sp-slot~="chess_frame_normal"\] \.scard\.scard--reg:is\(\.scard--t1, \.scard--t2, \.scard--t3, \.scard--t4\) \{ --art-clip-t: 6\.1%; --art-clip-r: 3%; \}/);
  // the covenant card stays clipped by its own overflow
  assert.match(read('public/css/screens/game-shop.css'), /\.scard \{[^}]*overflow: hidden/);
});

test('the pack\'s countdown and ready button sit in the top-right corner; the EFFECTS column starts under them', () => {
  assert.match(block(read('public/css/screens/game.css'), '.gtop'), /--gtop-pt:\s*\.2rem;\s*--gtop-pr:\s*\.3rem;\s*padding:\s*var\(--gtop-pt\) var\(--gtop-pr\)/);
  assert.match(reg, /\.gtop__clock--pf \{ margin-top: calc\(-1 \* var\(--gtop-pt, \.2rem\)\); margin-right: calc\(-1 \* var\(--gtop-pr, \.3rem\)\); \}/);
  assert.match(reg, /\.gtop--pf ~ \.gm__effects \{ top: 3rem; \}/);
  assert.match(reg, /\.gtop--pf ~ \.dpanel--right \{ top: 3rem; \}/, 'the right detail card no longer covers the TV and the ready button');
});

test('a theme\'s 🔍 pictures are the whole button: our frame, icon, ▶▶ and bracket frames step aside, hover keeps the picture', () => {
  assert.match(theme, /html\[data-sp-slot~="img_check_enemy"\] \.enemybtn:not\(\.has-sprite\) > \* \{ visibility: hidden; \}/);
  const hover = block(theme, 'html[data-sp-slot~="img_check_enemy"] .enemybtn:hover:not(.is-grey)');
  assert.match(hover, /background-image:\s*var\(--sp-img-img_check_enemy\)/);
  assert.match(theme, /html\[data-sp-slot~="img_check_player"\] \.gtop__frame--l::before/);
});

test('phones keep the 规程 shop\'s own sizes; the right card ends above it at the panel constant', () => {
  const phone = reg.slice(reg.indexOf('@media (max-height: 600px) and (pointer: coarse), (max-width: 767px) {'));
  assert.ok(phone.length > 0);
  assert.match(phone, /\.gm \.shopbar\.shopbar--reg \{ max-width: none; \}/);
  assert.match(phone, /\.gm \.shopbar \.scard\.scard--reg \{ width: 1\.55rem; height: 1\.87rem; \}/);
  assert.doesNotMatch(reg, /\.shopbar--reg \.scard \{ width: 1\.2rem; height: 1\.45rem; \}/, 'no shrunken short-screen card');
  assert.match(phone, /\.gm \.scard\.scard--reg \.scard__name \{ font-size: max\(\.16rem, calc\(11px \* var\(--ui\)\)\) !important; \}/, 'a readable name over the inline prefab size');
  const inset = /\.gm\.gm--reg \.dpanel--right\.is-shop \{ bottom: ([\d.]+)rem; \}/.exec(reg);
  assert.equal(Number(inset?.[1]), PANEL_RIGHT_BOTTOM_SHOP_REG);
  assert.match(read('public/js/ui/shopBar.js'), /--reg-k-min/);
});
