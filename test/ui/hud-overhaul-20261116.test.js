// The 2026-11-16 in-match UI overhaul (the owner: 「地图周边会出现一些黑色缺损」「人物立绘会跳出卡面的框」「可露希尔的右上角准备没有紧贴
// 右上角」「所有主题把鼠标放到冻结/刷新上时都会出现异常现象」「UI必须大修」): the stylesheet rules that keep each fix, and the card
// markup. The scene backdrop is pinned in test/render/board3d-scene.test.js; the screenshots are under the release's UI 大修 folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PANEL_RIGHT_BOTTOM_SHOP_REG, panelSide, panelSlots, bondPopupPlace, CORNER_TOP, PANEL_RIGHT_MIN_PX } from '../../public/js/ui/gameLogic/panel.js';
import { cornerOffset, readyCountPlate } from '../../public/js/ui/prefab/hud.js';
import { makePack } from '../../public/js/ui/prefab/view.js';
import { cornerKind } from '../../public/js/ui/regHud.js';

globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
const { ChessCard, faceBoxStyle, twoRowWidth, REG_TWO_ROWS_BELOW } = await import('../../public/js/ui/shopBar.js');

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
  assert.match(art, /right:\s*var\(--art-r, -6\.1%\);\s*top:\s*var\(--art-t, -15\.8%\);\s*width:\s*var\(--art-w, 72\.3%\)/);
  // the face sprites' transparent margins
  assert.match(theme, /html\[data-sp-theme="ac_s_closur"\]\[data-sp-slot~="chess_frame_normal"\] \.scard\.scard--reg:is\(\.scard--t1, \.scard--t2, \.scard--t3, \.scard--t4\) \{ --art-clip-t: 6\.1%; --art-clip-r: 3%; \}/);
  // the covenant card stays clipped by its own overflow
  assert.match(read('public/css/screens/game-shop.css'), /\.scard \{[^}]*overflow: hidden/);
});

test('the pack\'s countdown and ready button sit in the top-right corner; the EFFECTS column starts under them', () => {
  assert.match(block(read('public/css/screens/game.css'), '.gtop'), /--gtop-pt:\s*\.2rem;\s*--gtop-pr:\s*\.3rem;\s*padding:\s*var\(--gtop-pt\) var\(--gtop-pr\)/);
  assert.match(reg, /\.gtop__clock--pf \{ margin-top: calc\(-1 \* var\(--gtop-pt, \.2rem\)\); margin-right: calc\(-1 \* var\(--gtop-pr, \.3rem\)\); \}/);
  assert.match(reg, /\.gtop--pf ~ \.gm__effects \{ top: 3rem; \}/);
  assert.match(reg, /\.gtop--pf ~ \.dpanel--right, \.gtop--pf ~ \.bpop--right \{ top: 3rem; \}/, 'the right detail card no longer covers the TV and the ready button');
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

// ---- second pass (11-16 evening): the official 🔍 size, 可露希尔's card proportions, the phone's right card, the narrow
// window's shop, the panel constants, 已就绪 on a plate; 卫戍协议终端's own countdown / ready and the hand-made corner

test('the official packs\' 🔍 buttons at their RectTransform size (layout.json img_check_*), one unit .0144rem', () => {
  assert.match(theme, /html\[data-sp-theme="ac_s_closur"\]\[data-sp-slot~="img_check_player"\] \.gtop__iconbtn \{ --chk-w: 100; --chk-h: 68; \}/);
  assert.match(theme, /html\[data-sp-theme="ac_s_closur"\]\[data-sp-slot~="img_check_enemy"\] \.enemybtn \{ --chk-w: 88; --chk-h: 56; \}/);
  assert.match(theme, /\[data-sp-theme="ac_n_iron"\]\[data-sp-slot~="img_check_enemy"\] \.enemybtn \{ --chk-w: 73; --chk-h: 41; \}/);
  const size = block(theme, 'html:is([data-sp-theme="ac_n_initial"], [data-sp-theme="ac_n_iron"], [data-sp-theme="ac_s_closur"])[data-sp-slot~="img_check_player"] .gtop .gtop__iconbtn,\nhtml:is([data-sp-theme="ac_n_initial"], [data-sp-theme="ac_n_iron"], [data-sp-theme="ac_s_closur"])[data-sp-slot~="img_check_enemy"] .gtop .enemybtn');
  assert.ok(size, 'the size rule');
  assert.match(size, /height:\s*calc\(var\(--chk-h\) \* \.0144rem\);\s*aspect-ratio:\s*var\(--chk-w\) \/ var\(--chk-h\)/);
});

test('可露希尔\'s 157×207 card face keeps its proportions over the 155×187 slot (no 10 % squeeze)', () => {
  assert.equal(faceBoxStyle({ w: 155, h: 187 }), null);
  assert.equal(faceBoxStyle(null), null);
  assert.deepEqual(faceBoxStyle({ w: 157, h: 207 }), { '--face-w': '1.57rem', '--face-h': '2.07rem' });
  const b = block(reg, '.shopbar .scard.scard--reg.has-facebox,\n.gm .shopbar .scard.scard--reg.has-facebox');
  assert.match(b, /width:\s*var\(--face-w\);\s*height:\s*var\(--face-h\);/);
  assert.match(b, /margin:\s*calc\(\(1\.87rem - var\(--face-h\)\) \/ 2\) calc\(\(1\.55rem - var\(--face-w\)\) \/ 2\)/, 'the row keeps its layout');
  const priv = { funds: 20, hand: [], board: [], temp: [], loadout: {} };
  const faceModel = { card: { w: 157, h: 207 }, layers: [], art: { '--art-w': '71.3376%' }, namebar: {}, profession: { style: {} },
    name: { style: {}, color: '#000000', fontSize: 0.16 }, bonds: {} };
  const card = ChessCard({ slot: { kind: 'chess', id: 'chess_x', price: 3, basePrice: 3 }, idx: 0, priv, onBuy() {}, onDetail() {}, reg: true, faceModel });
  const nodes = [...walk(card)];
  const btn = nodes.find((n) => hasClass(n, 'scard--reg'));
  assert.ok(hasClass(btn, 'has-facebox'));
  assert.equal(btn.props.style['--face-h'], '2.07rem');
  assert.equal(nodes.find((n) => hasClass(n, 'scard__artbox')).props.style['--art-w'], '71.3376%', 'the pack\'s own char_portrait box');
});

test('the right card starts under whose corner sits there; too short a right slot (a phone above the shop) gives way left', () => {
  const vp = { width: 800, height: 360 };
  const R = 32;
  const closur = panelSlots(vp, R, { shopOpen: true, reg: true, corner: 'ac_s_closur' });
  assert.equal(closur.right.top, R * 3);
  assert.equal(panelSlots(vp, R, { shopOpen: true, reg: true }).right.top, R * 2.1);
  assert.ok(closur.right.bottom - closur.right.top < PANEL_RIGHT_MIN_PX, '~117 px at 800×360');
  const uf = { left: R * 3, right: R * 4, top: 150, bottom: 200 };
  assert.equal(panelSide(uf, closur), 'right', 'without the floor: the short right slot');
  assert.equal(panelSide(uf, closur, { minRight: PANEL_RIGHT_MIN_PX }), 'left');
  const desk = panelSlots({ width: 1366, height: 768 }, 1366 / 19.2, { shopOpen: true, reg: true, corner: 'ac_s_closur' });
  assert.equal(panelSide({ left: 300, right: 400, top: 300, bottom: 400 }, desk, { minRight: PANEL_RIGHT_MIN_PX }), 'right', 'a desktop keeps the right card');
  // the bond popup docked right starts there too
  const ufR = { left: 2.3 * R + 1, right: 2.3 * R + 30, top: 100, bottom: 140 };
  assert.equal(bondPopupPlace(ufR, vp, R, null, { corner: 'ac_s_closur' }), 'right');
  // the css says the same per corner
  assert.equal(CORNER_TOP.ac_s_closur, 3);
  assert.equal(CORNER_TOP.ac_n_iron, 3);
  assert.match(reg, /\.gtop--pf ~ \.dpanel--right, \.gtop--pf ~ \.bpop--right \{ top: 3rem; \}/);
  const init = /\.gtop\[data-corner="ac_n_initial"\] ~ \.bpop--right \{ top: calc\(([\d.]+)rem \+ max\(([\d.]+)rem, calc\(20px \* var\(--ui\)\)\)\); \}/.exec(reg);
  assert.ok(init);
  assert.ok(Math.abs(Number(init[1]) + Number(init[2]) - CORNER_TOP.ac_n_initial) < 1e-9);
  assert.equal(CORNER_TOP.hand, 2.1);
  const game = read('public/js/screens/game.js');
  assert.equal((game.match(/panelSlots\(vp, rem, \{ shopOpen, reg: regView, corner \}\), \{ minRight: PANEL_RIGHT_MIN_PX \}/g) || []).length, 2);
});

test('whose corner: an installed official pack (卫戍协议终端 too), else the hand-made countdown', () => {
  const groups = { 'themes/ac_n_initial': { 'prefabs.json': { path: 'x' } }, 'themes/ac_s_closur': { 'prefabs.json': { path: 'y' } } };
  assert.equal(cornerKind(groups, 'ac_n_initial'), 'ac_n_initial');
  assert.equal(cornerKind(groups, 'ac_s_closur'), 'ac_s_closur');
  assert.equal(cornerKind(groups, 'ac_n_iron'), 'hand', 'not installed');
  assert.equal(cornerKind(groups, ''), 'hand');
  const hud = read('public/js/ui/hud.js');
  assert.match(hud, /usePrefabPack\(!pack && settings\?\.uiTheme === 'ac_n_initial' \? data\.get\('local'\)\?\.groups : null, 'ac_n_initial', \{ includeDefault: true \}\)/);
  assert.match(hud, /data-corner=\$\{cornerKind\}/);
  assert.match(reg, /\.gtop\[data-corner="hand"\] \.gtop__clock \{ margin-top: calc\(\.08rem - var\(--gtop-pt, \.2rem\)\); margin-right: calc\(\.1rem - var\(--gtop-pr, \.3rem\)\); \}/);
});

test('a sized countdown root (卫戍协议终端\'s 180×100, anchored top right) hangs the ready face from its own corner, not its glows', () => {
  const R = (size, pos = [0, 0], anchor = [0.5, 0.5], pivot = [0.5, 0.5]) => ({ anchors: { min: anchor, max: anchor }, pivot, sizeDelta: size, anchoredPosition: pos });
  const cd = { name: 'panel_countdown', rect: R([180, 100], [-90, -50], [1, 1]), children: [
    { name: 'glow', rect: R([344, 266], [113, 0]), image: { type: 'simple', color: '#187D66', sprite: 'g' } },
    { name: 'digits', rect: R([60, 40], [0, 0]), image: { type: 'simple', color: '#FFFFFF', sprite: 'd' } },
  ] };
  const ready = {
    name: 'panel_prep_ready', rect: R([0, 0]),
    scripts: [{ anims: { _animationLocation: { clip: 'btn_ready_switch', on: 2 } } }],
    children: [{ name: 'btn_ready', id: 2, rect: R([196, 68], [-98, -116], [1, 1]), image: { type: 'simple', color: '#FFFFFF', sprite: 'b' } }],
  };
  const pack = makePack({}, 'themes/x', { spPrefabs: 1, prefabs: { panel_countdown: cd, panel_prep_ready: ready }, clips: {} });
  // the countdown's box: its 180×100 root, the corner its top-right; the button: x −196…0, y 82…150 from that corner
  assert.deepEqual(cornerOffset(pack), { x: `${Number(((180 - 196) * 1.44 / 100).toFixed(4))}rem`, y: `${Number((82 * 1.44 / 100).toFixed(4))}rem` });
});

test('已就绪 n/m sits on a plate: the pack\'s seat strip (panel_player bg), else a CSS bar', () => {
  const ready = { name: 'panel_prep_ready', children: [{ name: 'btn_ready', children: [{ name: 'group_cancel', children: [{ name: 'panel_player', children: [
    { name: 'bg', image: { type: 'sliced', sprite: 'player_bg', slice: [0, 33, 0, 33], file: 'sprites/player_bg.webp' } },
  ] }] }] }] };
  const pack = { doc: { prefabs: { panel_prep_ready: ready } }, sprite: (name) => `/u/${name}.webp` };
  assert.deepEqual(readyCountPlate(pack), { '--rc-plate': 'url("/u/player_bg.webp")', '--rc-slice': '0 33 0 33', '--rc-cap': '0 0.2376rem 0 0.2376rem' });
  assert.equal(readyCountPlate({ doc: { prefabs: {} }, sprite: () => '' }), null);
  const game = read('public/css/screens/game.css');
  assert.match(block(game, '.readywrap__count'), /background:\s*linear-gradient\(90deg, transparent, rgba\(6, 10, 9, \.78\)/);
  assert.match(block(game, '.readywrap__count.has-plate'), /border-image:\s*var\(--rc-plate\) var\(--rc-slice\) fill \/ var\(--rc-cap\) stretch/);
});

test('a bitmap-font text in a colour other than white is tinted (卫戍协议终端\'s mint countdown)', () => {
  const view = read('public/js/ui/prefab/view.js');
  assert.match(view, /backgroundBlendMode: 'multiply'/);
  assert.match(view, /<\$\{BitmapText\} text=\$\{box\.text\} font=\$\{bitmap\} align=\$\{align\} tint=\$\{\[r, g, b\]\} \/>/);
});

test('a narrow window lays the 规程 shop out in two balanced rows', () => {
  assert.equal(REG_TWO_ROWS_BELOW, 480);
  // level box, five cards, the equipment card, the character card (prefab widths), gap 6
  const ws = [112, 155, 155, 155, 155, 155, 155, 192];
  const W = twoRowWidth(ws, 6);
  const rows = [];
  let cur = 0;
  let n = 0;
  for (const w of ws) {
    const next = n ? cur + 6 + w : w;
    if (n && next > W) { rows.push(n); cur = w; n = 1; } else { cur = next; n++; }
  }
  rows.push(n);
  assert.equal(rows.length, 2, `two rows at ${W}`);
  assert.ok(W < (ws.reduce((a, b) => a + b, 0) + 6 * 7) * 0.6, 'about half the single row');
  assert.equal(twoRowWidth([100], 6), 100);
  assert.match(reg, /\.shopbar--reg \.shopbar__cluster\.is-2row \.shopbar__row \{ flex-wrap: wrap; justify-content: flex-end; row-gap: \.26rem; \}/);
  assert.match(reg, /\.shopbar--reg \.shopbar__cluster\.is-2row \.shopbar__cards \{ display: contents; \}/);
});
