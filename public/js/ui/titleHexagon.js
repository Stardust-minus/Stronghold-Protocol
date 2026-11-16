import { N_ } from '../../../shared/i18n.js';

// Order and rotations from the official statistics template.
export const TITLE_HEX_SECTORS = [
  ['comment_4', 180], ['comment_5', 240], ['comment_6', 300],
  ['comment_1', 0], ['comment_2', 60], ['comment_3', 120],
];

/** The awards at which the official statistics view fills a 评语's wedge and brightens its count. */
export const TITLE_FULL_COUNT = 20;

/** 规程's six 评语 kinds (playerTitleDataDict `type`), in the official table's order. */
export const REGULATION_KINDS = Object.freeze(['BOND', 'KILL', 'EQUIP', 'COIN', 'CHAR', 'DAMAGE']);

/** What each 规程 kind rates (config.titles `stat`, server/match/results.js regulationTitles): the hexagon's labels. */
export const KIND_NAMES = Object.freeze({
  BOND: N_('盟约层数'), KILL: N_('击败数'), EQUIP: N_('装备配发'), COIN: N_('消耗资金'), CHAR: N_('晋升次数'), DAMAGE: N_('领袖伤害'),
});

/**
 * The family of a 评语 table: 'regulation' when its titles carry an official kind (规程: six kinds × three ranks, the same
 * comment_N ids name other titles than 盟约's six), else 'covenant'.
 * @param {any[]|null|undefined} titles config.titles
 * @returns {'regulation'|'covenant'}
 */
export const titleTableFamily = (titles) => (Array.isArray(titles) && titles.some((x) => x && typeof x.type === 'string') ? 'regulation' : 'covenant');

/**
 * The hexagon's six wedges of a 评语 table, clockwise from the top (the rotations of TITLE_HEX_SECTORS):
 * `{ key, angle, count, name, kind?, titles }`.
 *   盟约: one title each, in the official template's order; `count` its awards, `name` its name.
 *   规程 (the owner's decision of 2026-11-16): one kind each, in the table's order [ASSUMED: the official view of 规程 is
 *        unpublished]; `count` the kind's points — the official `point` of each 评语 received (rank 1 and rank 2 one each,
 *        rank 0 none) — `kind` the KIND_NAMES msgid, `titles` its three 评语 by rank with their awards.
 * @param {any[]} titles config.titles of the table
 * @param {Record<string, number>} awards title id → times received
 * @returns {Array<{ key: string, angle: number, count: number, name: string, kind?: string, titles: Array<{ id: string, name: string, text: string, awards: number }> }>}
 */
export function hexWedges(titles, awards) {
  const list = Array.isArray(titles) ? titles.filter((x) => x && typeof x.id === 'string') : [];
  const n = (id) => Math.max(0, Number(awards?.[id]) || 0);
  const view = (x) => ({ id: x.id, name: x.name || x.id, text: x.text || '', awards: n(x.id) });
  if (titleTableFamily(list) === 'regulation') {
    return REGULATION_KINDS.map((kind, i) => {
      const own = list.filter((x) => x.type === kind).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
      return { key: kind, angle: TITLE_HEX_SECTORS[i][1], kind: KIND_NAMES[kind], name: KIND_NAMES[kind],
        count: own.reduce((s, x) => s + n(x.id) * Math.max(0, Number(x.point) || 0), 0), titles: own.map(view) };
    });
  }
  return TITLE_HEX_SECTORS.map(([id, angle]) => {
    const x = list.find((r) => r.id === id);
    return { key: id, angle, count: n(id), name: x?.name || id, titles: x ? [view(x)] : [] };
  });
}

/** Clipped fill in each wedge's local coordinates; zero has no active area. */
export function titleSectorClip(count) {
  const scale = Math.min(1, Math.max(0, count) / TITLE_FULL_COUNT);
  if (!(scale > 0)) return null;
  const points = [
    [47, 0], [47 * (1 - scale), 93 * scale], [47 - 43 * scale, 100 * scale],
    [53 + 43 * scale, 100 * scale], [53 + 47 * scale, 93 * scale], [53, 0],
  ];
  return `polygon(${points.map(([x, y]) => `${x}% ${y}%`).join(',')})`;
}
