// Feedback #162 and #160 on the client (Node): 收起 / 展开 of a pending choice (ui/choiceOverlay.js PeekPill / ChoicePill,
// screens/game.js usePeek, ui/bandCommand.js CommandDraft) and 卡池剩余 (ui/poolCount.js; the shop cards, the reward cards
// and the bond card's members; 设置「显示卡池剩余张数」). Browser checks: test/ui/fb-peek-pool.e2e.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
globalThis.fetch = async (url) => {
  const name = String(url).split('/').pop();
  try {
    const body = readFileSync(path.join(ROOT, 'data', name), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  } catch {
    return { ok: false, status: 404, json: async () => ({}) };
  }
};

const { poolLeftOf, PoolTag, withPoolTag, isEdgeAnchor } = await import('../../public/js/ui/poolCount.js');
const { ChessCard, ItemCard } = await import('../../public/js/ui/shopBar.js');
const { BondPopup } = await import('../../public/js/ui/bondStrip.js');
const { ChoiceView, ChoicePill, PeekPill } = await import('../../public/js/ui/choiceOverlay.js');
const { Countdown } = await import('../../public/js/ui/components.js');
const { DEFAULT_SETTINGS, sanitizeSettings } = await import('../../public/js/ui/gameLogic.js');
const { data } = await import('../../public/js/data.js');
const { DATA } = await import('../match/harness.js');

await data.loadAll('chess', 'bonds', 'assets', 'garrisons', 'items', 'backups', 'choices', 'effects');

function* walk(v) {
  if (Array.isArray(v)) { for (const x of v) yield* walk(x); return; }
  if (!v || typeof v !== 'object') return;
  yield v;
  yield* walk(v.props?.children);
}
const hasClass = (v, c) => typeof v?.props?.class === 'string' && v.props.class.split(/\s+/).includes(c);
const textOf = (v) => {
  if (v == null || typeof v === 'boolean') return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(textOf).join('');
  return typeof v === 'object' ? textOf(v.props?.children) : '';
};
const tags = (v) => [...walk(v)].filter((n) => n.type === PoolTag);

const visible = Object.values(DATA.chess).filter((c) => c.visible && !c.isGolden && !c.isDiy && !c.isHidden);
const golden = Object.values(DATA.chess).find((c) => c.isGolden && c.baseId && visible.some((v) => v.chessId === c.baseId));
const A = visible.find((c) => c.chessId !== golden.baseId).chessId;
const ITEM = Object.keys(DATA.items).find((id) => DATA.items[id].itemType === 'EQUIP' && !DATA.items[id].isGolden && !DATA.items[id].hideInShop);

test('#160 poolLeftOf: the count of an operator / equipment in m.private poolLeft; an elite reads its base; nothing without the field', () => {
  const priv = { poolLeft: { chess: { [A]: 3, [golden.baseId]: 7 }, items: { [ITEM]: 0 } } };
  assert.equal(poolLeftOf(priv, 'chess', A), 3);
  assert.equal(poolLeftOf(priv, 'chess', golden.chessId), 7, 'an elite id counts against its base');
  assert.equal(poolLeftOf(priv, 'item', ITEM), 0, '0 is a count (red), not "unknown"');
  assert.equal(poolLeftOf(priv, 'chess', 'chess_nope'), null);
  assert.equal(poolLeftOf(priv, 'item', A), null, 'kinds are separate maps');
  assert.equal(poolLeftOf({}, 'chess', A), null, 'no poolLeft (单人, 独立卡池, a bot seat): no count');
  assert.equal(poolLeftOf(null, 'chess', A), null);
  assert.equal(poolLeftOf({ poolLeft: { chess: { [A]: -1 } } }, 'chess', A), null, 'junk is no count');
});

test('#160 PoolTag: 「余 n」 with the full sentence for assistive tech, red at 0, nothing without a count', () => {
  assert.equal(PoolTag({ n: null }), null);
  assert.equal(PoolTag({ n: undefined }), null);
  const tag = PoolTag({ n: 12 });
  assert.ok(hasClass(tag, 'pooltag') && hasClass(tag, 'pooltag--card') && !hasClass(tag, 'is-empty'));
  assert.equal(tag.props['data-pool-left'], 12);
  assert.equal(tag.props['aria-label'], '卡池剩余 12 张');
  assert.match(textOf(tag), /余 12/);
  const zero = PoolTag({ n: 0, where: 'member' });
  assert.ok(hasClass(zero, 'is-empty') && hasClass(zero, 'pooltag--member'));
});

test('#160 shop cards: the tab right of the price on operator and equipment cards, in the 盟约 and the 规程 look; none without a count', () => {
  const slot = { kind: 'chess', id: A, price: 3, basePrice: 3 };
  const boxOf = (v) => [...walk(v)].find((n) => hasClass(n, 'scard__pricebox'));
  for (const reg of [false, true]) {
    const card = ChessCard({ slot, idx: 0, priv: {}, onBuy() {}, onDetail() {}, reg, pool: 5 });
    const t = tags(card);
    assert.equal(t.length, 1, `operator card (reg ${reg})`);
    assert.equal(t[0].props.n, 5);
    // the price and its tab share one box (withPoolTag): the price first, the tab after it — CSS puts the tab on its right
    const box = boxOf(card);
    const kids = [box.props.children].flat();
    assert.equal(kids.length, 2, `price + tab (reg ${reg})`);
    assert.equal(kids[1].type, PoolTag);
    assert.ok(reg ? hasClass(kids[0], 'scard__cost') : kids[0].type?.name === 'PriceHex', `the price is the box's first child (reg ${reg})`);
    // no count (单人, 独立卡池, 设置 off): no box, no tab — the price is drawn exactly as before
    const none = ChessCard({ slot, idx: 0, priv: {}, onBuy() {}, onDetail() {}, reg });
    assert.equal(tags(none).length, 0, 'no count: no tab');
    assert.equal(boxOf(none), undefined, 'no count: no box');
    const item = ItemCard({ slot: { kind: 'item', id: ITEM, price: 2 }, idx: 5, onBuy() {}, onDetail() {}, reg, pool: 0 });
    assert.deepEqual(tags(item).map((x) => x.props.n), [0], `equipment card (reg ${reg})`);
    assert.ok(boxOf(item), `equipment card's box (reg ${reg})`);
  }
  // the 盟约 card keeps the box in .scard__top (the price's place)
  const cov = ChessCard({ slot, idx: 0, priv: {}, onBuy() {}, onDetail() {}, pool: 5 });
  const top = [...walk(cov)].find((n) => hasClass(n, 'scard__top'));
  assert.ok(boxOf(top) && tags(top).length === 1, '盟约: the box inside .scard__top');
  assert.ok(hasClass([...walk(cov)].find((n) => hasClass(n, 'scard')), 'has-pool'), '盟约 operator card: has-pool (phones move the pips and 可晋升)');
  assert.equal(hasClass([...walk(ChessCard({ slot, idx: 0, priv: {}, onBuy() {}, onDetail() {} }))].find((n) => hasClass(n, 'scard')), 'has-pool'), false);
  // 规程: a priced card's box keeps the hexagon's CSS anchor (HexBadge drops style); FREE's root_cost position moves to the box;
  // an anchor in the card's right part (乌萨斯齐心团 / 可露希尔) is is-edge: right-aligned, only the height kept
  const face = (left) => ({ cost: { style: { left, top: '7%' } }, layers: [], namebar: {}, profession: { style: {} }, name: { style: {}, color: '#fff', fontSize: 0.2 }, bonds: null });
  const regCard = ChessCard({ slot, idx: 0, priv: {}, onBuy() {}, onDetail() {}, reg: true, faceModel: face('49.4%'), pool: 5 });
  assert.equal(boxOf(regCard).props.style, null, '规程 hexagon: the CSS anchor');
  const freeArgs = { slot: { ...slot, price: 0 }, idx: 0, priv: {}, free: true, onBuy() {}, onDetail() {}, reg: true, pool: 5 };
  const regFree = ChessCard({ ...freeArgs, faceModel: face('49.4%') });
  assert.deepEqual(boxOf(regFree).props.style, { left: '49.4%', top: '7%' }, '规程 FREE: the box at root_cost');
  assert.equal(hasClass(boxOf(regFree), 'is-edge'), false);
  const freePill = [...walk(regFree)].find((n) => hasClass(n, 'scard__cost--free'));
  assert.equal(freePill.props.style, undefined, 'FREE itself sits in the box');
  const edge = ChessCard({ ...freeArgs, faceModel: face('72.1%') });
  assert.ok(hasClass(boxOf(edge), 'is-edge'), 'root_cost in the right part: is-edge');
  assert.deepEqual(boxOf(edge).props.style, { '--pb-top': '7%' }, 'is-edge keeps root_cost\'s height only');
  const freeNone = ChessCard({ ...freeArgs, pool: null, faceModel: face('72.1%') });
  assert.deepEqual([...walk(freeNone)].find((n) => hasClass(n, 'scard__cost--free')).props.style, { left: '72.1%', top: '7%' }, 'no count: FREE at root_cost as before');
  // the bar reads the setting and the private view; the reward cards get the same counts
  const bar = read('public/js/ui/shopBar.js');
  assert.match(bar, /settings\?\.poolCount === false \? null : poolLeftOf\(priv, kind, id\)/);
  assert.equal((bar.match(/pool=\$\{poolOf\('chess', s\.id\)\}/g) || []).length, 2, 'both shops\' operator cards');
  assert.equal((bar.match(/pool=\$\{poolOf\('item', s\.id\)\}/g) || []).length, 2, 'both shops\' equipment cards');
  assert.equal((bar.match(/poolOf=\$\{poolOf\}/g) || []).length, 2, 'both reward rows');
  assert.match(bar, /pool: poolOf\(kind, s\.id\)/);
});

test('#160 isEdgeAnchor / withPoolTag: the right part of the card is past 55 %; no count returns the price untouched', () => {
  assert.equal(isEdgeAnchor({ left: '72.1%' }), true);
  assert.equal(isEdgeAnchor({ left: '49.4%' }), false);
  assert.equal(isEdgeAnchor(null), false);
  assert.equal(isEdgeAnchor({}), false);
  const price = { type: 'span', props: { class: 'x' } };
  assert.equal(withPoolTag(price, null), price);
  assert.equal(withPoolTag(price, -1), price);
  assert.equal(withPoolTag(price, 1.5), price);
  const box = withPoolTag(price, 0, { style: { left: '72%', top: '6%' }, edge: true });
  assert.ok(hasClass(box, 'scard__pricebox') && hasClass(box, 'is-edge'));
  assert.deepEqual(box.props.style, { '--pb-top': '6%' });
});

test('#160 bond card: each member\'s count under its portrait — own card only, never a banned member or a watched teammate\'s card', () => {
  const bond = visible.find((c) => Array.isArray(c.bonds) && c.bonds.length)?.bonds[0];
  const members = visible.filter((c) => c.bonds?.includes(bond)).map((c) => c.chessId);
  assert.ok(members.length >= 2);
  const counts = Object.fromEntries(members.map((id, i) => [id, i]));
  const own = { board: [], hand: [], temp: [], poolLeft: { chess: counts, items: {} } };
  const props = { bondId: bond, entry: { count: 0, active: false, tier: 0, layers: 0 }, onClose() {} };
  const rows = [...walk(BondPopup({ ...props, priv: own, poolCounts: true }))].filter((n) => hasClass(n, 'bpop__member'));
  assert.ok(rows.length >= 2);
  for (const row of rows) {
    const tag = tags(row);
    assert.equal(tag.length, 1, row.key);
    assert.equal(tag[0].props.n, counts[row.key] ?? null, `${row.key}: its own count`);
    assert.equal(tag[0].props.where, 'member');
  }
  assert.equal(tags(BondPopup({ ...props, priv: own })).filter((x) => x.props.n != null).length, 0, '设置 off: none');
  assert.equal(tags(BondPopup({ ...props, priv: own, poolCounts: true, owner: 'P2' })).filter((x) => x.props.n != null).length, 0, 'a watched teammate\'s card: none');
  const counted = rows.filter((r) => counts[r.key] != null).length;
  const banned = tags(BondPopup({ ...props, priv: own, poolCounts: true, banned: [rows[1].key] })).filter((x) => x.props.n != null);
  assert.equal(banned.length, counted - 1, 'a banned member: no count');
  assert.match(read('public/js/screens/game.js'), /poolCounts=\$\{playerSettings\.poolCount !== false && bondPop\.ownerId === myId\}/);
});

test('#160 设置「显示卡池剩余张数」: on by default (like 预选盟约\'s switches); only false turns it off', () => {
  assert.equal(DEFAULT_SETTINGS.poolCount, true);
  assert.equal(sanitizeSettings(null).poolCount, true, 'a profile saved before the switch');
  for (const junk of [0, 'false', null, {}]) assert.equal(sanitizeSettings({ poolCount: junk }).poolCount, true, JSON.stringify(junk));
  assert.equal(sanitizeSettings({ poolCount: false }).poolCount, false);
  assert.match(read('public/js/ui/settings.js'), /label=\$\{t\('显示卡池剩余张数'\)\} micro="POOL COUNT" value=\$\{s\.poolCount\}/);
});

test('#160 / #162 strings are in every shipped pack', () => {
  const ids = ['显示卡池剩余张数', '和队友共用卡池时，在商店卡牌的价格右侧、盟约详情的成员头像上显示该干员或装备在卡池里还剩几张。官方界面没有这些数字。',
    '卡池剩余 {n} 张', '余 {n}', '已选中'];
  for (const code of ['en', 'ja', 'ko', 'zh-TW']) {
    const pack = JSON.parse(read(`public/i18n/${code}.json`));
    for (const id of ids) {
      assert.equal(typeof pack[id], 'string', `${code}: ${id}`);
      if (id.includes('{n}')) assert.match(pack[id], /\{n\}/, `${code}: ${id} keeps {n}`);
    }
  }
});

const sp = (o = {}) => ({
  family: 'bounty', cards: [{ idx: 0, effectId: 'x', name: 'A', desc: 'a', takenBy: null }, { idx: 1, effectId: 'y', name: 'B', desc: 'b', takenBy: null }],
  order: ['me', 'p2'], turnPid: 'me', pickOf: new Map(), takenBy: new Map(), pickedCount: 0, ...o,
});

test('#162 the 展开 button: the choice\'s name, its countdown while it is timed, 「已选中」 when a card stays selected, a pulse on my turn', () => {
  const deadline = Date.now() + 9000;
  const pill = ChoicePill({ sp: sp(), myId: 'me', solo: false, deadline, total: 30, armed: true, onExpand() {} });
  assert.ok(hasClass(pill, 'spov-pill') && hasClass(pill, 'is-turn'));
  assert.equal(pill.props['data-testid'], 'sp-expand');
  const nodes = [...walk(pill)];
  const clock = nodes.find((n) => n.type === Countdown);
  assert.ok(clock && clock.props.deadline === deadline && clock.props.total === 30, 'the clock keeps running in the button');
  assert.ok(nodes.some((n) => hasClass(n, 'spov-pill__armed')), 'a selected card is kept and said so');
  assert.match(textOf(pill), /展开/);
  const quiet = [...walk(ChoicePill({ sp: sp({ turnPid: 'p2' }), myId: 'me', solo: false, onExpand() {} }))];
  assert.ok(!quiet.some((n) => n.type === Countdown), 'untimed: no clock');
  assert.ok(!quiet.some((n) => hasClass(n, 'spov-pill__armed')));
  assert.ok(!hasClass(ChoicePill({ sp: sp({ turnPid: 'p2' }), myId: 'me', solo: false, onExpand() {} }), 'is-turn'), 'someone else deciding: no pulse');
  assert.ok(hasClass(ChoicePill({ sp: sp({ turnPid: null, concurrent: true }), myId: 'me', solo: false, onExpand() {} }), 'is-turn'), 'a concurrent draft: my turn');
  // a 教鞭 choice: its own name, always the viewer's
  const pc = ChoicePill({ sp: sp({ name: '教鞭 · 战术特训', turnPid: 'me' }), myId: 'me', solo: false, personal: true, onExpand() {} });
  assert.match(textOf(pc), /教鞭 · 战术特训/);
  assert.ok(hasClass(pc, 'is-turn'));
  // the official btn_open (local client ui/battle) with a CSS square fallback; 收起's btn_close the same way
  const art = nodes.find((n) => n.props?.name === 'btn_open');
  assert.ok(art && art.props.fallback, 'btn_open, falling back to the CSS square');
  const view = [...walk(ChoiceView({ pub: { players: [] }, sp: sp(), myId: 'me', solo: false, onCollapse() {} }))];
  const close = view.find((n) => hasClass(n, 'spov__collapse'));
  assert.ok([...walk(close)].some((n) => n.props?.name === 'btn_close'));
  assert.equal(PeekPill({ name: 'X', onExpand() {}, testId: 'command-expand' }).props['data-testid'], 'command-expand');
});

test('#162 wiring: a hidden choice gives the screen back (no has-sp / has-spdraft), keeps its selection, and 更换指令 hides too', () => {
  const game = read('public/js/screens/game.js');
  assert.match(game, /\(\(sp && !spHidden\) \|\| \(hasPersonalChoice && !personalHidden\) \|\| offerBlocksPrep\(pub\?\.offers\)\) && 'has-sp', sp && !spHidden && 'has-spdraft'/);
  assert.match(game, /usePeek\(sp \? `sp\|\$\{pub\?\.round \?\? ''\}\|\$\{sp\.family\}\|\$\{sp\.cards\.length\}` : null\)/, 'a new draft (round, family) opens expanded');
  assert.match(game, /usePeek\(personalChoice \? `pc\|\$\{personalChoice\.id\}` : null\)/);
  assert.match(game, /usePeek\(commandDraft \? `cmd\|\$\{commandDraft\.id\}` : null\)/);
  assert.match(game, /collapsed=\$\{spHidden\} onCollapsedChange=\$\{setSpHidden\}/);
  assert.match(game, /collapsed=\$\{personalHidden\} onCollapsedChange=\$\{setPersonalHidden\}/);
  assert.match(game, /<\$\{CommandDraft\} key=\$\{commandDraft\.id\} draft=\$\{commandDraft\} collapsed=\$\{commandHidden\} onCollapsedChange=\$\{setCommandHidden\}/);
  const overlay = read('public/js/ui/choiceOverlay.js');
  assert.match(overlay, /onCollapse=\$\{\(\) => setCollapsed\(true\)\}/, '收起 keeps the selected card (upstream dropped it)');
  assert.match(overlay, /if \(armed == null \|\| collapsed\) return undefined;/, 'Esc while hidden closes the screen\'s panels, not the selection');
  const cmd = read('public/js/ui/bandCommand.js');
  assert.match(cmd, /data-testid="command-collapse"/);
  assert.match(cmd, /<\$\{PeekPill\} name=\$\{t\('更换指令'\)\}/);
});
