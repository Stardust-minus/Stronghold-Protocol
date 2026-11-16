// The strategies (bands) and alliances (bonds) of every official version, for the views of past matches — 成就统计
// (ui/achievements.js) and 统计数据 (screens/stats.js). The page holds the data of the one version it shows (规程·序列Ⅰ in
// the lobby by default, versions.js shownVersion), but the records span every version, and a record names its strategy and
// its alliances by ids that the shown version may not have: 规程 renamed every strategy (华法琳 is band_bldsk in 盟约 and
// band_takecare in 规程, 娜仁图亚 band_narant / band_sargon), 第二期下半 added 铃兰 / 缪尔赛思, 森蚺 band_zumama is 第一期
// only, and ten alliance ids are missing from some version. Those views printed the raw id (owner's report 2026-11-16:
// 「最常使用的策略有一部分没有正确显示策略名称，例如华法琳，娜仁图亚」).
// An id means one strategy / alliance in every version that has it (checked over data/ and data/versions/*: 85 strategy
// ids and 27 alliance ids, none with two names; every icon is in data/assets.json), so a lookup by id is enough: the
// shown data first (its texts in the page's language, through the page's own lookups), then the other versions' records,
// their Chinese names through data.localeName. Those files (bands.json, bonds.json of data/versions/<slug>/ — or data/
// for 第二期下半 while another version is shown) are downloaded once a view holds records of that version; a version this
// server does not serve stays unknown and its ids print as before.

import { useEffect, useMemo, useReducer } from '../../vendor/hooks.module.js';
import { createDataStore, data } from '../data.js';
import { DEFAULT_VERSION, VERSIONS, versionById } from '../../../shared/versions.js';
import { recordVersion } from './stats.js';

/** The files a record view names ids of. */
export const RECORD_FILES = Object.freeze(['bands', 'bonds']);

/** version id → a data store over that version's directory (one per page; created on first need). */
const stores = new Map();

/**
 * The store of a version's files (`/data/` + its dir; createDataStore's tolerant indexing and its retries).
 * @param {string} id a registry id @returns {ReturnType<typeof createDataStore>|null}
 */
function storeOf(id) {
  const v = versionById(id);
  if (!v) return null;
  let s = stores.get(v.id);
  if (!s) { s = createDataStore({ base: `/data/${v.dir}` }); stores.set(v.id, s); }
  return s;
}

/** The version the page's data belongs to (its config's `version`, none for 第二期下半). @param {any} config */
export const configVersion = (config) => (typeof config?.version?.id === 'string' && versionById(config.version.id) ? config.version.id : DEFAULT_VERSION);

/**
 * The versions whose files a view of `records` needs besides the shown one, in registry order.
 * @param {any[]} records @param {string} shown the version of the page's data
 */
export function versionsToLoad(records, shown) {
  const have = new Set((Array.isArray(records) ? records : []).map(recordVersion));
  return VERSIONS.filter((v) => v.id !== shown && have.has(v.id)).map((v) => v.id);
}

/**
 * Lookups over every version: `band(id)` / `bond(id)` the shown data's record (`gd`'s, in the page's language), else the
 * first other version's that has the id — a copy whose name is in the page's language when data.localeName knows it —,
 * else null; `bands()` every known strategy by id (the shown data's first), for the strategy marks (stats.js
 * strategyBadgeIds reads each band's own victorCount); `foreign(kind, id)` the version an id comes from when the shown
 * data lacks it (null otherwise). Pure over `others` (version id → { lookup, list }): Node-testable.
 * @param {any} gd makeLookups / useGameData
 * @param {Map<string, { lookup: (name: string, id: string) => any, list: (name: string) => any[] }>} others
 * @param {(zh: string) => string} [localeName]
 */
export function withAllVersions(gd, others, localeName = (zh) => zh) {
  const named = (rec) => (rec && typeof rec.name === 'string' ? { ...rec, name: localeName(rec.name) || rec.name } : rec);
  const fromOthers = (file, id) => {
    for (const [version, s] of others) {
      const rec = s.lookup(file, id);
      if (rec) return { rec, version };
    }
    return null;
  };
  const shownOf = (kind, id) => (kind === 'bands' ? gd.band(id) : gd.bond(id));
  return {
    ...gd,
    band: (id) => gd.band(id) || named(fromOthers('bands', id)?.rec ?? null),
    bond: (id) => gd.bond(id) || named(fromOthers('bonds', id)?.rec ?? null),
    foreign: (kind, id) => (id == null || shownOf(kind, id) ? null : fromOthers(kind, id)?.version ?? null),
    bands: () => {
      const out = {};
      for (const s of [...others.values()].reverse()) for (const b of s.list('bands')) if (b?.bandId) out[b.bandId] = b;
      for (const b of gd.list('bands')) if (b?.bandId) out[b.bandId] = b;
      return out;
    },
  };
}

/**
 * Hook: `gd` widened with the other versions' strategies and alliances (withAllVersions) for a view of `records`; the
 * files of the versions those records played download in the background and the view draws again as each one lands.
 * @param {any} gd @param {any[]} records
 */
export function useRecordLookups(gd, records) {
  const [tick, force] = useReducer((c) => c + 1, 0);
  const shown = configVersion(gd.config);
  const want = useMemo(() => versionsToLoad(records, shown), [records, shown]);
  const key = want.join('|');
  useEffect(() => {
    let alive = true;
    for (const id of want) {
      const s = storeOf(id);
      if (!s) continue;
      for (const f of RECORD_FILES) s.load(f).then(() => { if (alive) force(); });
    }
    return () => { alive = false; };
  }, [key]);
  return useMemo(() => {
    const others = new Map();
    for (const id of want) {
      const s = stores.get(id);
      if (s) others.set(id, s);
    }
    return withAllVersions(gd, others, (zh) => data.localeName(zh));
  }, [gd, key, tick, data.locale()]);
}

/** The version that stands for a season (an activity id): its final sub-version, the season's first registry entry. @param {string|null} season */
export const seasonVersion = (season) => VERSIONS.find((v) => v.season === season)?.id ?? DEFAULT_VERSION;

/**
 * Hook: the 评语 table (config.titles) of `version`'s family — 盟约's six (every 盟约 version has the same) or 规程's 18 (the
 * same comment_N ids, other titles: ui/titleHexagon.js). The shown data's own when it is of that family; else that
 * version's config, downloaded once (null until it lands, or when this server does not serve it).
 * @param {any} gd the page's lookups @param {string|null} version a registry id (null: the shown data's)
 * @returns {any[]|null}
 */
export function useTitleTable(gd, version) {
  const [tick, force] = useReducer((c) => c + 1, 0);
  const shown = configVersion(gd.config);
  const id = version && versionById(version) ? version : shown;
  const own = versionById(id)?.family === versionById(shown)?.family;
  useEffect(() => {
    if (own) return undefined;
    let alive = true;
    storeOf(id)?.load('config').then(() => { if (alive) force(); }, () => {});
    return () => { alive = false; };
  }, [id, own]);
  return useMemo(() => {
    const titles = own ? gd.config?.titles : stores.get(id)?.get('config')?.titles;
    return Array.isArray(titles) ? titles : null;
  }, [own, id, gd.config, tick]);
}
