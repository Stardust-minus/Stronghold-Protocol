// Canonical dependency-free nickname policy, reused by the game through shared/names.js.
// Word-list data: pinned Shutterstock LDNOOBW en/zh, CC-BY-4.0; see name-dictionary.mjs
// and NAME-DICTIONARY-LICENSE.txt. This is a bounded literal filter, not a semantic classifier.
// To update: review upstream en/zh at a fixed commit, replace the literal snapshot + hashes,
// review these exclusions/supplements, then run test/name-policy.test.js and both net/auth suites.
import { ENGLISH_TEXT, CHINESE_TEXT } from './name-dictionary.mjs';

export const NAME_POLICY_LIMITS = Object.freeze({ nameLength: 12, rawLength: 256, dictionaryEntries: 2048, wordLength: 64, dictionaryLength: 65536 });
export const NAME_REASON = Object.freeze({ SENSITIVE: 'sensitive', EMPTY: 'empty', TOO_LONG: 'too_long', INVALID_TYPE: 'invalid_type' });
export const NAME_REJECTED_MESSAGE = '代号含有不适宜内容，请换一个昵称。';
export const nameReasonMessage = reason => reason === NAME_REASON.SENSITIVE ? NAME_REJECTED_MESSAGE
  : reason === NAME_REASON.TOO_LONG ? '代号最多 12 字，请缩短后重试。' : '请输入有效的博士代号。';

// These are exclusions of dictionary ENTRIES, not a name-level bypass: an otherwise acceptable
// identity/body term next to an abusive term still fails. Single-character Chinese entries are
// always excluded: ambiguous characters/surnames must never become substring bans.
export const NAME_DICTIONARY_EXCLUSIONS = Object.freeze({
  english: Object.freeze(['sex', 'sexy', 'sexual', 'sexuality', 'gay', 'lesbian', 'queer', 'homosexual', 'bisexual',
    'penis', 'vagina', 'clitoris', 'testicle', 'testicles', 'anus', 'breasts', 'nipple', 'nipples', 'sperm', 'scrotum', 'labia',
    'rectum', 'vulva', 'genitals', 'semen', 'ejaculation', 'fecal', 'xx', 'xxx', 'nsfw', 'lolita']),
  chinese: Object.freeze(['成人', '乳房', '乳头', '乳頭', '阴道', '陰道', '阴茎', '陰莖', '阴唇', '陰唇', '阴蒂', '陰蒂',
    '睾丸', '精液', '胸部', '生殖器', '肛门', '肛門', '处女', '包皮', '精子', '射精', '月经', '屁股',
    '交配', '外阴', '阴户', '阴核', '阴毛', '阴部', '阳具', '阳萎', '龟头', '卵子', '性器', '性无能',
    '九游', '私服', '激情', '后庭', '祖宗', '老母', '老二', '他妈', '你妈', '他娘', '你娘', '妈妈的', '你全家',
    '同性恋', '同性戀', '异性恋', '異性戀', '双性恋', '雙性戀', '黑人', '白人', '中国', '中國', '日本', '台湾', '臺灣',
    '法轮功', '法輪功', '天安门', '天安門', '六四', '八九六四']),
});
// Small, explicit local supplements; the third-party dictionaries remain the primary corpus.
export const NAME_DICTIONARY_SUPPLEMENTS = Object.freeze({
  english: Object.freeze(['kill yourself']),
  chinese: Object.freeze(['草你妈', '草你媽', '操你媽', '傻逼', '傻比', '傻屌', '狗日的', '日你妈', '日你媽', '去死吧', '杀你全家', '殺你全家']),
});

const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const INVISIBLE_RE = /[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}]/gu;
const SEPARATOR_RE = /[\p{White_Space}\p{P}\p{S}]/u;
const LATIN_WORD_RE = /[\p{Script=Latin}\p{N}\p{M}]/u;
const COMPACTABLE_RE = /^[\p{L}\p{N}\p{M}\s]+$/u;
// A very narrow lexical exemption avoids treating the ordinary possessive “妈妈的…” as an
// insult. Mask only this harmless span, never approve the entire name (an appended insult fails).
const NEUTRAL_CHINESE_SPANS = Object.freeze(['妈妈的']);

function clean(raw) {
  return raw.normalize('NFKC').replace(LONE_SURROGATE_RE, '').replace(/\s+/g, ' ')
    .replace(INVISIBLE_RE, '').replace(/ {2,}/g, ' ').trim();
}

/** Legacy display sanitizer: still caps code points without splitting surrogate pairs. */
export function sanitizeName(raw) {
  if (typeof raw !== 'string' || raw.length > NAME_POLICY_LIMITS.rawLength) return null;
  const value = [...clean(raw)].slice(0, NAME_POLICY_LIMITS.nameLength).join('').trim();
  return value || null;
}

function compactWithOffsets(text) {
  let compact = '';
  const starts = [], ends = [];
  let offset = 0;
  for (const character of text) {
    if (!SEPARATOR_RE.test(character)) {
      compact += character;
      // Offsets for every UTF-16 unit let literal includes/indexOf remain bounded and simple.
      for (let i = 0; i < character.length; i++) { starts.push(offset); ends.push(offset + character.length); }
    }
    offset += character.length;
  }
  return { compact, starts, ends };
}

function latinBoundary(text, start, end) {
  // CJK scripts are boundaries for English words; Latin letters/digits/marks are not.
  const before = [...text.slice(0, start)].at(-1) || '';
  const after = [...text.slice(end)].at(0) || '';
  return !LATIN_WORD_RE.test(before) && !LATIN_WORD_RE.test(after);
}

function contains(text, word, english, offsets = null) {
  let at = text.indexOf(word);
  while (at !== -1) {
    const start = offsets ? offsets.starts[at] : at;
    const end = offsets ? offsets.ends[at + word.length - 1] : at + word.length;
    if (!english || latinBoundary(offsets ? offsets.original : text, start, end)) return true;
    at = text.indexOf(word, at + 1);
  }
  return false;
}

/**
 * Pure factory for reviewed local dictionaries/tests. All entries are literals, never regexes.
 * Limits are checked before normalization/compilation; no unbounded caches or request-time I/O.
 */
export function createNamePolicy({ english = ENGLISH_TEXT.trimEnd().split('\n'), chinese = CHINESE_TEXT.trimEnd().split('\n'),
  extraEnglish = NAME_DICTIONARY_SUPPLEMENTS.english, extraChinese = NAME_DICTIONARY_SUPPLEMENTS.chinese,
  ignoredEnglish = NAME_DICTIONARY_EXCLUSIONS.english, ignoredChinese = NAME_DICTIONARY_EXCLUSIONS.chinese } = {}) {
  const groups = [english, chinese, extraEnglish, extraChinese, ignoredEnglish, ignoredChinese];
  if (groups.some(group => !Array.isArray(group)) || groups.reduce((n, group) => n + group.length, 0) > NAME_POLICY_LIMITS.dictionaryEntries) {
    throw new Error('Invalid name dictionary size');
  }
  let length = 0;
  for (const group of groups) for (const word of group) {
    if (typeof word !== 'string' || !word.length || word.length > NAME_POLICY_LIMITS.wordLength) throw new Error('Invalid name dictionary entry');
    length += word.length;
  }
  if (length > NAME_POLICY_LIMITS.dictionaryLength) throw new Error('Invalid name dictionary size');
  const ignore = [new Set(ignoredEnglish.map(word => clean(word).toLowerCase())), new Set(ignoredChinese.map(word => clean(word).toLowerCase()))];
  const seen = new Set(), words = [];
  for (const [entries, englishMatch] of [[english.concat(extraEnglish), true], [chinese.concat(extraChinese), false]]) {
    for (const raw of entries) {
      const literal = clean(raw).toLowerCase();
      if (!literal || (!englishMatch && [...literal].length < 2) || ignore[englishMatch ? 0 : 1].has(literal)) continue;
      const key = `${englishMatch}:${literal}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Punctuation in dictionary entries stays literal: e.g. (a+)+$ can never become a regex
      // or an over-broad single-letter compact match. Only letters/numbers/space compact.
      const compact = COMPACTABLE_RE.test(literal) ? compactWithOffsets(literal).compact : null;
      words.push({ literal, compact, english: englishMatch });
    }
  }

  return raw => {
    if (typeof raw !== 'string') return { ok: false, reason: NAME_REASON.INVALID_TYPE };
    // Guard BEFORE NFKC/spreading/scanning; huge or invisible-padded strings cannot consume CPU.
    if (raw.length > NAME_POLICY_LIMITS.rawLength) return { ok: false, reason: NAME_REASON.TOO_LONG };
    const name = clean(raw);
    if (!name) return { ok: false, reason: NAME_REASON.EMPTY };
    let text = name.toLowerCase();
    for (const phrase of NEUTRAL_CHINESE_SPANS) text = text.replaceAll(phrase, ' ');
    const offsets = { ...compactWithOffsets(text), original: text };
    for (const word of words) {
      if (contains(text, word.literal, word.english)
        || (word.compact && contains(offsets.compact, word.compact, word.english, offsets))) {
        // No matched term, submitted name or normalized rejected value leaves this function.
        return { ok: false, reason: NAME_REASON.SENSITIVE };
      }
    }
    // Wire-format limit is UTF-16 units (shared/protocol.js); do not truncate a rejected callsign.
    if (name.length > NAME_POLICY_LIMITS.nameLength) return { ok: false, reason: NAME_REASON.TOO_LONG };
    return { ok: true, name };
  };
}

export const moderateName = createNamePolicy();
