// One portable operator preset; gameplay choices and display-only skins retain their own validators.
import { parseImport, parseStored, parseStoredOps, sanitizeEntries, sanitizeOps, LOADOUT_EXPORT_KIND } from './loadoutModel.js';
import { parseOwnershipImport, cleanIds, sanitizeNotOwned, OWNERSHIP_EXPORT_KIND } from './ownershipModel.js';
import { parseDiyImport, cleanPicks, sanitizeDiyPicks, DIY_EXPORT_KIND } from './diyModel.js';
import { parseSkinImport, SKINS_EXPORT_KIND } from './skinsModel.js';
import { cleanSkinChoices } from '../../../shared/skins.js';
import { checkLoadout, checkLoadoutOps, cultivationCharIds } from '../../../shared/protocol.js';
import { N_ } from '../../../shared/i18n.js';

export const OPERATOR_PRESET_KIND = 'stronghold.operator-preset';
export const OPERATOR_PRESET_VERSION = 1;
export const OPERATOR_PRESET_MAX_BYTES = 256 * 1024;
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.hasOwn(o, k);
const sections = ['entries', 'notOwned', 'diy', 'skins'];
const fail = error => ({ ok: false, error });

export function operatorPresetPayload(state, { now = Date.now() } = {}) {
  return { kind: OPERATOR_PRESET_KIND, v: OPERATOR_PRESET_VERSION,
    exportedAt: new Date(Number.isFinite(now) ? now : Date.now()).toISOString(),
    entries: parseStored(state?.entries), notOwned: cleanIds(state?.notOwned),
    diy: cleanPicks(state?.diy), skins: cleanSkinChoices(state?.skins),
    ...(own(state || {}, 'ops') ? { ops: parseStoredOps({ ops: state.ops }) } : {}) };
}
export const serializeOperatorPreset = (state, opts) => JSON.stringify(operatorPresetPayload(state, opts), null, 2);

/** Complete presets replace the original four sections; optional ops keeps older files scoped to what they contain. */
export function parseOperatorPreset(input) {
  let raw = input;
  if (typeof raw === 'string') {
    if (new TextEncoder().encode(raw).length > OPERATOR_PRESET_MAX_BYTES) return fail(N_('内容过长，无法导入'));
    if (!raw.trim()) return fail(N_('没有可导入的内容'));
    try { raw = JSON.parse(raw); } catch { return fail(N_('无法识别的内容')); }
  }
  if (isObj(raw) && raw.kind === OPERATOR_PRESET_KIND) {
    if (Number.isInteger(raw.v) && raw.v > OPERATOR_PRESET_VERSION) return fail(N_('这份预设来自更新的版本，请先更新游戏'));
    if (raw.v !== OPERATOR_PRESET_VERSION || !sections.every(k => own(raw, k))
      || !isObj(raw.entries) || !Array.isArray(raw.notOwned) || !isObj(raw.diy) || !isObj(raw.skins)
      || (own(raw, 'ops') && !isObj(raw.ops))) {
      return fail(N_('完整预设缺少配置项或格式无效，未做任何改动'));
    }
    return { ok: true, scope: 'all', patch: { entries: raw.entries, notOwned: raw.notOwned, diy: raw.diy, skins: raw.skins,
      ...(own(raw, 'ops') ? { ops: raw.ops } : {}) } };
  }
  const kind = isObj(raw) ? raw.kind : null;
  if (kind === SKINS_EXPORT_KIND) {
    const r = parseSkinImport(raw);
    return r.ok ? { ok: true, scope: 'skins', patch: { skins: r.choices }, dropped: r.dropped } : r;
  }
  if (kind === DIY_EXPORT_KIND || (!kind && isObj(raw) && own(raw, 'picks'))) {
    const r = parseDiyImport(raw);
    return r.ok ? { ok: true, scope: 'diy', patch: { diy: r.picks } } : r;
  }
  if (kind === OWNERSHIP_EXPORT_KIND || Array.isArray(raw) || (!kind && isObj(raw) && own(raw, 'notOwned'))) {
    const r = parseOwnershipImport(raw);
    return r.ok ? { ok: true, scope: 'notOwned', patch: { notOwned: r.notOwned } } : r;
  }
  if (!kind || kind === LOADOUT_EXPORT_KIND) {
    if (isObj(raw) && own(raw, 'ops') && !isObj(raw.ops)) return fail(N_('无法识别的格式'));
    const r = parseImport(raw);
    return r.ok ? { ok: true, scope: 'entries', patch: { entries: r.entries, ...(r.ops ? { ops: r.ops } : {}) } } : r;
  }
  return fail(N_('这不是干员预设的数据'));
}

/** Validate every included section before the store is touched. Empty explicit complete sections restore defaults. */
export function prepareOperatorPreset(parsed, { lookup, data, kitted } = {}) {
  if (!parsed?.ok || !isObj(parsed.patch)) return fail(N_('无法识别的格式'));
  const patch = {}, counts = {}; let dropped = parsed.dropped || 0;
  for (const key of [...sections, 'ops']) {
    if (!own(parsed.patch, key)) continue;
    const raw = parsed.patch[key];
    let clean, asked, kept;
    if (key === 'entries') {
      if (typeof lookup !== 'function') return fail(N_('游戏数据没有载入'));
      asked = Object.keys(raw).length;
      clean = sanitizeEntries(raw, lookup);
      const legal = Object.entries(raw).some(([id, e]) => checkLoadout({ [id]: e }, lookup).ok);
      if (asked && !Object.keys(clean).length && !legal) return fail(N_('这份预设包含当前版本不可用的配置，未做任何改动'));
      kept = Object.keys(clean).length;
      if (parsed.scope === 'entries' && !kept) {
        if (own(parsed.patch, 'ops')) { counts.entries = 0; dropped += asked; continue; }
        if (asked) return fail(N_('这份预设包含当前版本不可用的配置，未做任何改动'));
      }
    } else if (key === 'notOwned') {
      if (typeof lookup !== 'function') return fail(N_('游戏数据没有载入'));
      asked = raw.length; clean = sanitizeNotOwned(raw, lookup); kept = clean.length;
    } else if (key === 'diy') {
      asked = Object.keys(raw).length;
      if (asked && (!data?.chess || !data?.backups || kitted == null)) return fail(N_('自选编队数据尚未就绪，请稍后重试'));
      clean = asked ? sanitizeDiyPicks(raw, data, kitted) : {}; kept = Object.keys(clean).length;
    } else if (key === 'ops') {
      asked = Object.keys(raw).length;
      if (asked && (!data?.chess || !data?.backups)) return fail(N_('游戏数据没有载入'));
      const ids = cultivationCharIds(data?.chess, data?.backups), isOperator = id => ids.has(id);
      clean = sanitizeOps(raw, isOperator); kept = Object.keys(clean).length;
      const legal = Object.entries(raw).some(([id, value]) => checkLoadoutOps({ [id]: value }, isOperator).ok);
      if (asked && !kept && !legal) return fail(N_('这份预设包含当前版本不可用的配置，未做任何改动'));
    } else {
      asked = Object.keys(raw).length; clean = cleanSkinChoices(raw); kept = Object.keys(clean).length;
    }
    if (key !== 'entries' && key !== 'ops' && asked && !kept) return fail(N_('这份预设包含当前版本不可用的配置，未做任何改动'));
    patch[key] = clean; counts[key] = kept; dropped += Math.max(0, asked - kept);
  }
  if (!Object.keys(patch).length) return fail(N_('无法识别的格式'));
  return { ok: true, scope: parsed.scope, patch, counts, dropped };
}
