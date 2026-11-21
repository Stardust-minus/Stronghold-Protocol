// INFO_CHECK is one two-column briefing for every version (2026-11-21; 规程's alone before, ui/regulationBriefing.js).
// The preview is the stage's own cells until a manifest lists a picture (ui/stagePreview.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

const { MatchBondGroups, MatchBondRow, BannedByBond, BannedThumb, BondLackTag, RegulationHead } = await import('../../public/js/ui/matchInfo.js');
const { MatchEnemies } = await import('../../public/js/ui/matchEnemies.js');
const { StageMap, stagePreviewChoice, stagePreviewKeys, STAGE_PREVIEW_CROP, STAGE_PREVIEW_ZOOM } = await import('../../public/js/ui/stagePreview.js');
const { Img, RichText } = await import('../../public/js/ui/gameComponents.js');
const { Tooltip } = await import('../../public/js/ui/components.js');

function* walk(v) {
  if (Array.isArray(v)) { for (const x of v) yield* walk(x); return; }
  if (!v || typeof v !== 'object') return;
  yield v;
  if (typeof v.type === 'function' && !v.props?.children) return;
  yield* walk(v.props?.children);
}
const hasClass = (v, c) => typeof v?.props?.class === 'string' && v.props.class.split(/\s+/).includes(c);
const textOf = (v) => Array.isArray(v) ? v.map(textOf).join('')
  : typeof v === 'string' || typeof v === 'number' ? String(v) : v && typeof v === 'object' ? textOf(v.props?.children) : '';

test('one briefing for every version: the left scroll, the right column, the dock; no version switch', () => {
  assert.equal(existsSync(path.join(ROOT, 'public/js/ui/regulationBriefing.js')), false, 'no second layout');
  const brief = read('public/js/screens/briefing.js');
  assert.doesNotMatch(brief, /regulationBriefingLayout|version\.family|regulationFamily/);
  assert.match(brief, /<div class="screen brief" data-layout="one">/);
  const order = ['<div class="brief__split">', '<div class="brief__scroll">', 'brief-sec--core', 'brief-sec--addon', 'brief-sec--banned',
    '<div class="brief__dock">', '<aside class="brief__side">', '<${StagePreview}', '<${MatchEnemies} pub=${pub} gd=${gd} layout="regulation" />',
    '<${SetupReroll} pub=${pub} compact=${true} />', '<${LoadoutButton}', '<div class="brief__foot">', 'class="brief-go"'];
  let at = -1;
  for (const m of order) { const i = brief.indexOf(m, at + 1); assert.ok(i > at, m); at = i; }
  // 自选上场 (盟约's 候补) pinned under the scroll, only with a choice to make
  assert.match(brief, /\$\{priv\?\.diyChoice \? html`<div class="brief__dock">\s*<\$\{DiyChoice\} priv=\$\{priv\} onChoose=\$\{actions\.diyChoose\}/);
  assert.match(brief, /stagePreviewChoice\(\{ ui: gd\.m\?\.ui, localGroups \}, pub\.stageId\)/);
  assert.match(brief, /pool=\$\{stagePoolLine\(mode\)\}/);
  assert.doesNotMatch(brief, /enemyIconUrl|factionIconUrl|brief-boss|brief-faction/);
  assert.doesNotMatch(brief, /brief-legend|brief-banned|function BondRow|bannedPerBond|disabledBondSets/);
});

test('the stage preview has no picture (none) until a manifest lists one or the render runs — never cells', () => {
  const choice = stagePreviewChoice({ ui: {}, localGroups: null }, 'act3autochess_m01');
  assert.deepEqual(choice, { kind: 'none' });
});

test('规程 leader shows the name only; the round, abilities and battlefield stay on a tap', () => {
  const pub = { modeId: 'm', bossId: 'b', stageId: 's', factions: ['element'], lastRound: 15 };
  const gd = {
    config: { modes: { m: { stages: ['s', 's2'], bossRound: 15 } } },
    boss: () => ({ name: '鳍', enemyKey: 'e', abilities: ['技能甲', '技能乙'] }),
    enemy: () => ({ name: '鳍' }),
    stage: () => ({ name: '沙地' }),
    factions: { types: { element: { name: '元素', desc: '说明', icon: 'element' } } },
    m: {},
  };
  const reg = MatchEnemies({ pub, gd, layout: 'regulation' });
  const face = [...walk(reg)].find((v) => hasClass(v, 'reg-boss'));
  assert.ok(face);
  assert.match(textOf(face), /敌方领袖/);
  assert.match(textOf([...walk(face)].find((v) => hasClass(v, 'brief-boss__name'))), /鳍/);
  const textCol = [...walk(face)].find((v) => hasClass(v, 'brief-boss__text'));
  assert.equal([...walk(textCol)].some((v) => hasClass(v, 'brief-boss__abil') || hasClass(v, 'reg-boss__abil')), false);
  const tip = [...walk(reg)].find((v) => v.type === Tooltip && v.props.tipClass === 'reg-boss__tip');
  assert.equal(tip.props.tap, true);
  const rich = [...walk(tip.props.text)].filter((v) => v.type === RichText);
  assert.deepEqual(rich.map((v) => v.props.text), ['技能甲', '技能乙']);
  assert.match(textOf(tip.props.text), /最终攻势/);
  assert.match(textOf(tip.props.text), /沙地/);
  assert.match(textOf(tip.props.text), /战场随机（共2张）/);
  assert.ok([...walk(face)].some((v) => hasClass(v, 'sr-only') && [...walk(v)].some((x) => x.type === RichText)));
  const faction = [...walk(reg)].find((v) => hasClass(v, 'brief-faction'));
  assert.equal(faction.props['data-faction'], 'element');
  const plain = MatchEnemies({ pub, gd });
  assert.ok([...walk(plain)].some((v) => hasClass(v, 'brief-boss__abil')));
  assert.equal([...walk(plain)].some((v) => hasClass(v, 'reg-boss')), false);
  assert.match(textOf(plain), /本局遭遇敌方/);
});

function bondModel() {
  const bond = (bondId, members, core = true) => ({ bondId, name: bondId, isCore: core, thresholds: [1, 2], visibleMembers: members });
  const core = [bond('sargon', ['a', 'b']), bond('yan', ['b'])];
  const addon = [bond('extra', ['c'], false)];
  return {
    regulation: true,
    choice: { groups: [['sargon'], ['yan']], picked: null },
    core, addon, bonds: [...core, ...addon],
    banned: ['a', 'c', 'b', 'z'],
    perBond: new Map([['sargon', 2], ['yan', 1], ['extra', 1]]),
    stateOf: () => null,
    sets: { drawn: new Set(), off: new Set() },
    diyBanned: [],
  };
}

test('规程 groups share one header; the covenant groups do not', () => {
  const model = bondModel();
  const open = MatchBondGroups({ model, panels: true, onPick() {}, onBond() {} });
  assert.equal([...walk(open)].filter((v) => v.type === RegulationHead).length, 1);
  assert.equal([...walk(open)].filter((v) => hasClass(v, 'reg-group__n')).length, 2);
  const rows = [...walk(open)].filter((v) => v.type === MatchBondRow);
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((row) => row.props.head === false));
  // the pick is final; the panels stay (the official 1/3), the picked one lit and marked 已激活, no buttons
  const settled = MatchBondGroups({ model: { ...model, choice: { ...model.choice, picked: 0 } }, panels: true, onPick() {}, onBond() {} });
  const sn = [...walk(settled)];
  assert.equal(sn.filter((v) => v.type === RegulationHead).length, 1);
  assert.equal(sn.filter((v) => hasClass(v, 'brief-bond-group')).length, 2);
  assert.ok(hasClass(sn.find((v) => v.props?.['data-group'] === 0), 'is-on'));
  assert.ok(hasClass(sn.find((v) => v.props?.['data-group'] === 1), 'is-dropped'));
  assert.equal(sn.some((v) => v.props?.['data-testid']?.startsWith?.('bond-group-')), false);
  assert.match(textOf(sn.find((v) => hasClass(v, 'reg-group__on'))), /已激活/);
  const noChoice = MatchBondGroups({ model: { ...model, choice: null }, panels: true, onPick() {}, onBond() {} });
  assert.equal(noChoice.type, MatchBondRow);
  assert.equal(noChoice.props.head.type, RegulationHead);
  const plain = MatchBondGroups({ model, onPick() {}, onBond() {} });
  assert.equal([...walk(plain)].some((v) => v.type === RegulationHead), false);
  assert.equal([...walk(plain)].filter((v) => v.type === MatchBondRow)[0].props.head, undefined);
});

test('BannedByBond groups operators by bond and repeats one who is in two', () => {
  const view = BannedByBond({ model: bondModel(), onBond() {} });
  const groups = [...walk(view)].filter((v) => hasClass(v, 'reg-banned__group'));
  assert.deepEqual(groups.map((v) => v.props['data-bond']), ['sargon', 'yan', 'extra']);
  const thumbs = (node) => [...walk(node)].filter((v) => v.type === BannedThumb).map((v) => v.props.id);
  assert.deepEqual(thumbs(groups[0]), ['a', 'b']);
  assert.deepEqual(thumbs(groups[1]), ['b']);
  assert.deepEqual(thumbs(groups[2]), ['c']);
  const rest = [...walk(view)].find((v) => v.props?.['data-testid'] === 'banned-rest');
  assert.deepEqual(thumbs(rest), ['z']);
  const empty = BannedByBond({ model: { ...bondModel(), banned: [], perBond: new Map() } });
  assert.match(textOf(empty), /本局没有禁用干员/);
});

test('a banned operator is the official grey portrait with the 禁用 corner; a drawn bond keeps its 阵容不完整 corner (round 83)', () => {
  // the operator: UnitThumb dimmed, the uthumb--banned look, the corner badge (no local art in the tests: the CSS fold)
  const thumb = BannedThumb({ id: 'a' });
  assert.equal(thumb.type?.name, 'UnitThumb');
  assert.equal(thumb.props.id, 'a');
  assert.equal(thumb.props.dim, true);
  assert.equal(thumb.props.class, 'uthumb--banned');
  assert.ok(hasClass(thumb.props.badge, 'uthumb__ban'));
  // the group disc: the drawn set's official corner (BondLackTag) instead of the ✕; a bond the mode never activates keeps the ✕
  const model = { ...bondModel(), stateOf: (id) => (id === 'sargon' ? 'drawn' : id === 'extra' ? 'off' : null) };
  const view = BannedByBond({ model, onBond() {} });
  const discs = [...walk(view)].filter((v) => v.type?.name === 'BondDisc');
  const byName = Object.fromEntries(discs.map((d) => [d.props.name, d.props]));
  assert.equal(byName.sargon.tag?.type, BondLackTag);
  assert.equal(byName.sargon.cross, false);
  assert.equal(byName.extra.cross, true);
  assert.equal(byName.extra.tag, null);
  assert.equal(byName.yan.cross, false);
  // the CSS: one bond a row like the official screen (the owner 2026-11-21: side by side was too compact), the discs in one
  // column, tier mark bottom-left, the corner on the top-right
  const css = readFileSync(path.join(ROOT, 'public/css/screens/briefing.css'), 'utf8');
  assert.match(css, /--ban-ut: \.72rem/);
  assert.match(css, /\n\.reg-banned__groups \{ display: flex; flex-direction: column;/);
  assert.match(css, /\n\.reg-banned__disc \{ flex: none; width: [^;]+;/);
  assert.match(css, /\.reg-banned \.uthumb\.uthumb--banned \.uthumb__tier \{ top: auto; bottom:/);
  assert.match(css, /\.uthumb__ban \{[^}]*top: 1px; right: 1px; width: 34%/);
});

// no drawn map (the owner, 2026-11-21: 「去掉CSS地图，直接用实际图片」): a picture, the render, else an empty frame
test('the preview is a picture or the stage\'s render — never a drawn cell map', () => {
  assert.deepEqual({ ...STAGE_PREVIEW_CROP }, { r0: 7, r1: 12, c0: 0, c1: 10 });
  assert.equal(STAGE_PREVIEW_ZOOM, 'dialog');
  assert.deepEqual(stagePreviewKeys('act3autochess_m01'), [
    'stagePreview/act3autochess_m01', 'mapPreview/act3autochess_m01', 'stageMap/act3autochess_m01',
  ]);
  const stage = { tiles: { r: { buildable: 'MELEE', height: 'LOW' } }, rows: Array.from({ length: 19 }, () => 'r'.repeat(21)) };
  const map = StageMap({ stage, choice: { kind: 'none' } });
  assert.equal(map.props['data-preview'], 'none');
  assert.equal([...walk(map)].some((v) => /reg-map__cell/.test(v.props?.class || '')), false, 'no cells');
  const picture = StageMap({ stage: null, choice: { kind: 'picture', url: '/m.png', key: 'stagePreview/x' } });
  assert.equal(picture.props['data-preview'], 'picture');
  assert.equal(picture.props['data-assumed'], undefined);
  assert.equal([...walk(picture)].find((v) => v.type === Img).props.src, '/m.png');
  const assets = JSON.parse(read('data/assets.json'));
  // data/local-assets.json is git-ignored (CI has none): then only data/assets.json is checked
  const local = existsSync(path.join(ROOT, 'data/local-assets.json')) ? JSON.parse(read('data/local-assets.json')) : { groups: {} };
  const src = { ui: assets.ui, localGroups: local.groups };
  for (const id of ['act3autochess_m01', 'act2autochess_m01']) {
    assert.deepEqual(stagePreviewChoice(src, id), { kind: 'none' }, 'no picture, no probe yet: the frame waits for the render');
  }
  assert.deepEqual(
    stagePreviewChoice({ ui: { 'stagePreview/act3autochess_m01': '/x.png' }, localGroups: {} }, 'act3autochess_m01'),
    { kind: 'picture', url: '/x.png', key: 'stagePreview/act3autochess_m01' },
  );
  assert.deepEqual(
    stagePreviewChoice({ ui: {}, localGroups: { 'ui/stagePreview': { act3autochess_m01: { path: '/local.png' } } } }, 'act3autochess_m01'),
    { kind: 'picture', url: '/local.png', key: 'ui/stagePreview/act3autochess_m01' },
  );
  const srcJs = read('public/js/ui/stagePreview.js');
  assert.match(srcJs, /name="search"/);
  assert.match(srcJs, /<\$\{Modal\}/);
  assert.doesNotMatch(srcJs, /reg-map__cell|stagePreviewCells|StageMiniMap/);
  assert.doesNotMatch(read('public/css/screens/briefing.css'), /reg-map__cell/);
});
