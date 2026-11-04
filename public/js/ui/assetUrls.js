// Asset URL resolution against data/assets.json (docs/ASSETS.md). Pure: every function takes the
// manifest object (or null) and returns a URL string or null — callers draw their own fallback
// (glyph, CSS shape) when null. Only URLs present in the manifest are ever returned, so the client
// never requests files the asset pipeline did not produce (no 404 noise in the console).

import { appearanceEntry } from './skinAssets.js';

const str = (v) => (typeof v === 'string' && v ? v : null);
const obj = (v) => (v && typeof v === 'object' ? v : null);

/** Skin pictures belong to the effective operator, never the original chess of a stand-in / DIY slot. */
function skinPicture(m, chess, skinId, field) {
  if (!skinId) return null;
  const id = chess?.charId || str(chess?.assets?.[field])?.replace(/_[12]$/, '');
  const skin = m?.chars?.[id]?.skins?.[skinId];
  const elite = chess?.isGolden || /_2$/.test(chess?.assets?.[field] || '');
  return str(elite && skin?.[`${field}E2`]) || str(skin?.[field]) || (field === 'portrait' ? str(skin?.illust) : null);
}

/** @param {any} m manifest @param {string} key 'group/key' */
export function uiUrl(m, key) {
  return str(obj(obj(m)?.ui)?.[key]);
}

/**
 * Operator avatar for a chess record (golden → E2 art when present).
 * @param {any} m manifest
 * @param {any} chess chess.json record (or { assets: { avatar } })
 */
export function chessAvatarUrl(m, chess, { skin = null } = {}) {
  const appearance = appearanceEntry(m, chess?.charId || chess?.assets?.spine, chess?.skinId);
  if (str(appearance?.avatar)) return appearance.avatar;
  const picture = skinPicture(m, chess, skin, 'avatar');
  if (picture) return picture;
  const chars = obj(obj(m)?.chars);
  const id = str(chess?.assets?.avatar) || str(chess?.charId);
  if (!chars || !id) return null;
  if (id.endsWith('_2') && !chars[id]) {
    const base = chars[id.slice(0, -2)];
    return str(base?.avatarE2) || str(base?.avatar);
  }
  // A golden piece whose avatar id is the character key uses that entry's E2 art when it has one.
  // Official ids are `charId` or `charId_2` (the suffix branch above). Model and voice have no E2
  // field on the character entry: the composed `spine` / `voice` id is already the form's.
  const entry = chars[id];
  if (entry && chess?.isGolden && str(entry.avatarE2)) return str(entry.avatarE2);
  return str(entry?.avatar) || (chess?.charId ? str(chars[chess.charId]?.avatar) : null);
}

/**
 * The HD pictures of a portrait (rel30, the owner's 「来点高清立绘」; hd30's manifest contract,
 * /root/projects/rel30-20261104/hd/contract.md): next to the 180×360 `portrait` / `portraitE2` of a char (and `portrait` of
 * a skin) the manifest may carry `portraitHD` / `portraitHDE2` (the same 1:2 framing cut from the illustration at its
 * native resolution; outside the illustration transparent), `illustration` / `illustrationE2` (the whole 立绘),
 * `illustrationSize` / `illustrationSizeE2` ([W, H], layout before it loads), `portraitBox` / `portraitBoxE2` ([x, y, w, h]
 * fractions of [W, H] from the top-left: where the 180×360 sits — w·W : h·H = 1 : 2; x / y may be < 0 and x + w > 1, the
 * portrait running past the 立绘's edge) and `portraitScene` / `portraitSceneE2: true` (the 立绘 has an opaque scene behind
 * the character where the portrait is transparent). A scene look never draws its 立绘 anywhere (main's rule of 11-04):
 * its source has no illustration / box, only the cut-out `portraitHD*` — and without one (hd30 emits none where it would
 * not be sharper) today's 180×360 with today's maths. A manifest without the fields (an older one, a plugin's art, a look
 * the matcher missed) has only the 180×360.
 */
const HD_FIELDS = Object.freeze({
  portrait: { hd: 'portraitHD', ill: 'illustration', box: 'portraitBox', size: 'illustrationSize', hdSize: 'portraitHDSize', scene: 'portraitScene' },
  portraitE2: { hd: 'portraitHDE2', ill: 'illustrationE2', box: 'portraitBoxE2', size: 'illustrationSizeE2', hdSize: 'portraitHDSizeE2', scene: 'portraitSceneE2' },
});

/** A portraitBox: four finite numbers, a positive size, overlapping the picture (it may run past its edges). */
export function isPortraitBox(b) {
  return Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === 'number' && Number.isFinite(v))
    && b[2] > 0 && b[3] > 0 && b[0] < 1 && b[1] < 1 && b[0] + b[2] > 0 && b[1] + b[3] > 0;
}
const isSize = (v) => Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(n) && n > 0);

/**
 * A portrait as drawn from a manifest entry's `field` ('portrait' | 'portraitE2'): { src: the 180×360, hd: its HD crop or
 * null, illustration + box: the whole 立绘 and where the portrait sits in it (both or neither), size: the 立绘's [W, H] or
 * null, scene: a cut-out look (views and the seat framer keep to the cut-out) }; null without src.
 */
export function portraitSourceOf(entry, field) {
  const src = str(entry?.[field]);
  if (!src) return null;
  const k = HD_FIELDS[field];
  if (!k) return plainSource(src);
  const scene = entry[k.scene] === true;
  // a scene look: never its 立绘 (no illustration / box at all, so no view can draw it)
  const box = !scene && isPortraitBox(entry[k.box]) ? entry[k.box] : null;
  const illustration = box ? str(entry[k.ill]) : null;
  return { src, hd: str(entry[k.hd]), illustration, box: illustration ? box : null,
    size: illustration && isSize(entry[k.size]) ? entry[k.size] : null, scene };
}
const plainSource = (src) => (src ? { src, hd: null, illustration: null, box: null, size: null, scene: false } : null);

/**
 * The half-body portrait of a chess record (golden → E2 portrait when present) with its HD pictures (portraitSourceOf).
 * @param {any} m
 * @param {any} chess
 */
export function chessPortraitSource(m, chess, { skin = null } = {}) {
  const appearance = appearanceEntry(m, chess?.charId || chess?.assets?.spine, chess?.skinId);
  if (str(appearance?.portrait)) return portraitSourceOf(appearance, 'portrait');
  const picture = skinPicture(m, chess, skin, 'portrait');
  if (picture) return plainSource(picture);
  const chars = obj(obj(m)?.chars);
  const id = str(chess?.assets?.portrait);
  if (!chars) return null;
  const pick = (entry, e2) => (e2 && str(entry?.portraitE2) ? portraitSourceOf(entry, 'portraitE2') : portraitSourceOf(entry, 'portrait'));
  if (id) {
    // A golden piece whose portrait id is the character key uses portraitE2 when the entry has one.
    // An entry with only `portrait` (a custom golden URL included) keeps that URL. Official ids are
    // `charId_1` / `charId_2` and are not character keys, so they stay on the suffix branches below.
    if (chars[id]) return pick(chars[id], !!chess?.isGolden);
    if (id.endsWith('_2')) {
      const base = chars[id.slice(0, -2)];
      if (base) return pick(base, true);
    }
    if (id.endsWith('_1')) {
      const base = chars[id.slice(0, -2)];
      if (base) return portraitSourceOf(base, 'portrait');
    }
  }
  const byChar = chess?.charId ? chars[chess.charId] : null;
  if (!byChar) return null;
  return pick(byChar, !!chess?.isGolden);
}

/**
 * Half-body portrait (180×360) for a chess record (golden → E2 portrait when present).
 * @param {any} m
 * @param {any} chess
 */
export function chessPortraitUrl(m, chess, opts) {
  return chessPortraitSource(m, chess, opts)?.src ?? null;
}

/** The HD crop of chessPortraitUrl's portrait (rel30: the same framing, the illustration's resolution), or null. */
export function chessPortraitHdUrl(m, chess, opts) {
  return chessPortraitSource(m, chess, opts)?.hd ?? null;
}

/**
 * The pictures a large half-body view tries in order (rel30 HD): each record's HD crop, then its 180×360 — the first
 * record is the worn appearance, the next ones its fallbacks (the default look); duplicates and nulls dropped. The HD crop
 * frames exactly like the 180×360 (only sharper), so a box styled for the one shows the other the same.
 * @param {any} m @param {any[]} records @returns {string[]}
 */
export function portraitChain(m, records, opts) {
  const out = [];
  for (const rec of records) {
    const p = rec ? chessPortraitSource(m, rec, opts) : null;
    for (const u of [p?.hd, p?.src]) if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

/** <Img> props for a picture chain: the first URL, the rest as its fallbacks. @param {string[]} srcs */
export const chainProps = (srcs) => ({ src: srcs[0] ?? null, fallbackSrc: srcs.slice(1) });

/** Skill icon of a chess record (manifest `skills[iconId]`, else the empty skill sprite). */
export function skillIconUrl(m, chess) {
  const skills = obj(obj(m)?.skills);
  const id = str(chess?.assets?.skillIcon) || str(chess?.skill?.iconId) || str(chess?.skill?.skillId);
  if (skills && id && skills[id]) return str(skills[id]);
  const byId = obj(obj(m)?.skillsById);
  const alt = byId && chess?.skill?.skillId ? byId[chess.skill.skillId] : null;
  if (skills && alt && skills[alt]) return str(skills[alt]);
  return uiUrl(m, 'skillIcon/empty');
}

/**
 * Skill icon of one skill record (DESIGN §16 `skills[]`: iconId / skillId), else the empty skill sprite — or null with
 * `{ empty: false }` (the asset manifest only carries the default skills' icons: callers then draw a lettered S1–S3
 * tile instead of a blank square).
 */
export function skillRecordIconUrl(m, skill, { empty = true } = {}) {
  const skills = obj(obj(m)?.skills);
  for (const id of [str(skill?.iconId), str(skill?.skillId)]) if (skills && id && skills[id]) return str(skills[id]);
  const byId = obj(obj(m)?.skillsById);
  const alt = byId && skill?.skillId ? byId[skill.skillId] : null;
  if (skills && alt && skills[alt]) return str(skills[alt]);
  return empty ? uiUrl(m, 'skillIcon/empty') : null;
}

const PROF_KEY = {
  PIONEER: 'pioneer', WARRIOR: 'warrior', TANK: 'tank', SNIPER: 'sniper', CASTER: 'caster', MEDIC: 'medic',
  SUPPORT: 'support', SPECIAL: 'special',
};

/** Profession icon (small white glyph). */
export function profIconUrl(m, profession) {
  const k = PROF_KEY[String(profession || '').toUpperCase()];
  return k ? str(obj(obj(obj(m)?.prof)?.icon)?.[k]) : null;
}

/** Square profession glyph (manifest `prof.large`: a black glyph on white, drawn as a white one by loadout.css). */
export function profGlyphUrl(m, profession) {
  const v = obj(obj(obj(m)?.prof)?.large)?.[String(profession || '').toLowerCase()];
  return str(v);
}

/** Sub-profession icon from a chess record (`assets.subProfIcon` = 'sub_<id>_icon'). */
export function subProfIconUrl(m, chess) {
  const sub = obj(obj(obj(m)?.prof)?.sub);
  if (!sub) return null;
  const raw = str(chess?.assets?.subProfIcon);
  const id = raw ? raw.replace(/^sub_/, '').replace(/_icon$/, '') : str(chess?.subProfessionId);
  return id ? str(sub[id]) : null;
}

/** Bond glyph (white; tint in CSS). */
export function bondIconUrl(m, bondId) {
  return bondId ? str(obj(obj(m)?.bonds)?.[bondId]) : null;
}

/** Band (strategy) icon. */
export function bandIconUrl(m, bandId) {
  return bandId ? str(obj(obj(m)?.bands)?.[bandId]) : null;
}

/** Item icon for an items.json record (by trapId / iconId) or a raw trap id. */
export function itemIconUrl(m, item) {
  const items = obj(obj(m)?.items);
  if (!items) return null;
  if (typeof item === 'string') return str(items[item]);
  return str(items[item?.iconId]) || str(items[item?.trapId]);
}

/** Enemy icon (manifest keeps fallbacks resolved). */
export function enemyIconUrl(m, enemyKey) {
  const e = enemyKey ? obj(obj(obj(m)?.enemies)?.[enemyKey]) : null;
  if (e?.icon) return str(e.icon);
  // `_2` / `_3` variants fall back to their base enemy
  const base = typeof enemyKey === 'string' ? enemyKey.replace(/_\d+$/, '') : null;
  return base && base !== enemyKey ? str(obj(obj(obj(m)?.enemies)?.[base])?.icon) : null;
}

/** Token avatar, falling back to its owner operator's avatar. */
export function tokenAvatarUrl(m, tokenId) {
  const tokens = obj(obj(m)?.tokens);
  const t = tokenId ? obj(tokens?.[tokenId]) : null;
  if (t?.avatar) return str(t.avatar);
  if (t?.owner) return str(obj(obj(obj(m)?.chars)?.[t.owner])?.avatar);
  return null;
}

/** Faction (特训敌人 type) icon: `enemyTypeIcon/<icon>`. */
export function factionIconUrl(m, iconId) {
  return iconId ? uiUrl(m, `enemyTypeIcon/${iconId}`) : null;
}

/** Title (评语) icon: `titleIcon/<picId>`. */
export function titleIconUrl(m, picId) {
  return picId ? uiUrl(m, `titleIcon/${picId}`) : null;
}

/** Greek type letters of some modules (ISW-α, …) → the Latin letter of the client's icon file names (isw-a). */
const GREEK = { 'α': 'a', 'β': 'b', 'γ': 'g', 'δ': 'd', 'Δ': 'd' };
/** Lower-cased key → path index of a local `groups.module` object (built once per manifest object). */
const moduleIconIndex = new WeakMap();

/**
 * Official module (uniequip) TYPE icon from the local-client art (DESIGN §13 / §16): `data/local-assets.json`
 * `groups.module[<type>]`, matched case-insensitively against the module's typeName ('MAR-X' → key 'mar-x', 'PRI-X' →
 * key 'PRI-X' — the client's file names are mixed case). null when the manifest, the group or the entry is missing
 * (callers draw the lettered tile / type text instead).
 * @param {any} local the local-art manifest (`data.get('local')`) or null
 * @param {string} typeName e.g. 'MAR-X'
 */
export function moduleTypeIconUrl(local, typeName) {
  const g = obj(obj(obj(local)?.groups)?.module);
  const t = str(typeName)?.trim();
  if (!g || !t) return null;
  const exact = str(obj(g[t])?.path);
  if (exact) return exact;
  let idx = moduleIconIndex.get(g);
  if (!idx) {
    idx = new Map();
    for (const [k, v] of Object.entries(g)) {
      const p = str(obj(v)?.path);
      if (p && !idx.has(k.toLowerCase())) idx.set(k.toLowerCase(), p);
    }
    moduleIconIndex.set(g, idx);
  }
  const key = t.replace(/[αβγδΔ]/g, (c) => GREEK[c]).toLowerCase();
  return idx.get(key) || null;
}

/**
 * Icon for an m.private.effects entry: { iconKind: 'band'|'choice'|'team'|'item'|'garrison', iconId }.
 * @param {any} m
 * @param {{ iconKind?: string, iconId?: string }} eff
 */
export function effectIconUrl(m, eff) {
  const kind = eff?.iconKind;
  const id = str(eff?.iconId);
  if (kind === 'band') return bandIconUrl(m, id) || (id && id.startsWith('icon_') ? bandIconUrl(m, `band_${id.slice(5)}`) : null);
  if (kind === 'item') return itemIconUrl(m, id);
  if (kind === 'garrison') return uiUrl(m, `garrisonTypeIcon/${id || 's_icon_bond'}`) || uiUrl(m, 'garrisonTypeIcon/s_icon_bond');
  if (kind === 'team') return uiUrl(m, `buffIcon/${id && id.startsWith('icon_') ? id : 'icon_team_buff'}`);
  if (kind === 'choice') return uiUrl(m, `buffIcon/${id && id.startsWith('icon_') ? id : 'icon_player_buff'}`);
  return id ? uiUrl(m, `buffIcon/${id}`) : null;
}
