// The strategy draft's search box (the owner, 2026-11-16: 「再加一个搜索框，可以输入搜索对应策略」; screens/bandDraft.js). A query
// matches a strategy by its name (most are named after the operator who leads it), the name of its effect and the bonds
// it is built around; in Chinese also by the pinyin initials of those, as players type them (「amy」 阿米娅, 「klms」
// 克莱门莎, 「kxme」 卡西米尔). Every space-separated term has to match. When no strategy matches that way, the
// descriptions are searched instead (「装备」 finds the strategies that work on equipment) and the result says so — a
// short name never drowns in the descriptions (「余」 is a strategy; 「剩余」 is in many texts).
// Pure, no DOM (test/ui/band-search.test.js).

const PY_LETTERS = 'abcdefghjklmnopqrstwxyz';
/** The first character of each initial in pinyin collation order (阿 a … 帀 z; no initial i, u or v). */
const PY_BOUNDS = '阿八嚓哒妸发旮哈讥咔垃妈拿噢妑七呥仨他屲夕丫帀'; // i18n-ignore: collation keys, not UI text
const CJK = /[㐀-䶿一-鿿豈-﫿]/;

let collator;
function pinyinCollator() {
  if (collator === undefined) {
    try { collator = new Intl.Collator('zh-Hans-CN-u-co-pinyin'); } catch { collator = null; }
  }
  return collator;
}

/**
 * The pinyin initial of one CJK character from the zh pinyin collation (no dictionary: a character sorts between the
 * first characters of its initial and the next); '' for anything else, or where the collation is missing. A character
 * with two readings gets the collation's (桑葚 → 'sr').
 * @param {string} ch
 */
export function pinyinInitial(ch) {
  if (typeof ch !== 'string' || !CJK.test(ch)) return '';
  const col = pinyinCollator();
  if (!col) return '';
  let k = -1;
  for (let i = 0; i < PY_BOUNDS.length; i++) {
    if (col.compare(PY_BOUNDS[i], ch) <= 0) k = i;
    else break;
  }
  return k < 0 ? '' : PY_LETTERS[k];
}

/** Pinyin initials of a text; Latin letters and digits kept in lower case, the rest dropped: 「伊奥莱塔·罗素」 → 'yaltls'. */
export function pinyinInitials(text) {
  let out = '';
  for (const ch of String(text ?? '').normalize('NFKC')) {
    if (/[a-z0-9]/i.test(ch)) out += ch.toLowerCase();
    else out += pinyinInitial(ch);
  }
  return out;
}

/** Folded for matching: NFKC, lower case, without spaces and the punctuation names carry (· ・ “ ” 「 」 …). */
export function foldSearch(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase()
    .replace(/[\s·・•.,，、:：;；'"‘’“”「」『』《》〈〉()（）[\]【】\-—_~～!！?？]/g, '');
}

/** Rich text as plain text: the official <@tag>…</> markup and {placeholders} left out. */
const plain = (s) => String(s ?? '').replace(/<[@$][^>]*>|<\/>/g, '').replace(/\{[^{}]*\}/g, '');

/**
 * The search keys of each strategy: `main` (its name, effect name, bond names — folded), `py` (their pinyin initials),
 * `desc` (its description, folded).
 * @param {any[]} bands the draft's strategies
 * @param {(bondId: string) => (string|null|undefined)} bondName
 * @param {{ pinyin?: boolean }} [o] pinyin: index the initials too (a Chinese interface)
 * @returns {Map<string, { main: string[], py: string[], desc: string }>}
 */
export function bandSearchIndex(bands, bondName, { pinyin = true } = {}) {
  const out = new Map();
  for (const b of Array.isArray(bands) ? bands : []) {
    if (!b || typeof b.bandId !== 'string') continue;
    const bondIds = [...new Set([...(Array.isArray(b.bondIds) ? b.bondIds : []), ...(Array.isArray(b.relateBondIds) ? b.relateBondIds : [])])];
    const names = [b.name, b.effectName, ...bondIds.map((id) => (typeof bondName === 'function' ? bondName(id) : null))]
      .filter((n) => typeof n === 'string' && n);
    out.set(b.bandId, {
      main: names.map(foldSearch).filter(Boolean),
      py: pinyin ? names.map(pinyinInitials).filter(Boolean) : [],
      desc: foldSearch(plain(b.descRaw || b.desc)),
    });
  }
  return out;
}

/**
 * The strategies a query shows: null when the query is empty (all of them); else `ids` — the strategies every term of
 * which is in their names (a Latin term: also in the names' pinyin initials) — and `byDesc`: no strategy matched by
 * name, these matched by description.
 * @param {Map<string, { main: string[], py: string[], desc: string }>} index bandSearchIndex(...)
 * @param {string} query
 * @returns {null | { ids: Set<string>, byDesc: boolean }}
 */
export function searchBands(index, query) {
  const terms = String(query ?? '').split(/\s+/).map(foldSearch).filter(Boolean);
  if (!terms.length) return null;
  const byName = (k) => terms.every((q) => k.main.some((m) => m.includes(q)) || (/^[a-z0-9]+$/.test(q) && k.py.some((p) => p.includes(q))));
  const ids = new Set();
  for (const [id, k] of index) if (byName(k)) ids.add(id);
  if (ids.size) return { ids, byDesc: false };
  for (const [id, k] of index) if (terms.every((q) => k.desc.includes(q))) ids.add(id);
  return { ids, byDesc: ids.size > 0 };
}
