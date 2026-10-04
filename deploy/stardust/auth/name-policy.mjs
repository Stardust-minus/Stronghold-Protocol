// Canonical nickname adapter around the ACTUAL mint-filter@4.0.3 Aho–Corasick engine.
// No custom detection algorithm. Auth/game use this same dependency-free offline module.
// Licensed corpora: LDNOOBW en/zh (CC-BY-4.0), fwwdn categories + houbb politics (Apache-2.0).
// See each dictionary module's pinned revisions/hashes and the accompanying license files.
// Updates: vendor a fixed upstream version/category snapshot, retain provenance/licenses,
// review only non-political false positives, then run name-policy + auth/net tests on Node24.
// Coverage is dictionary-based, not a semantic classifier and never guaranteed exhaustive.
import Mint from './name-filter-vendor.mjs';
import { ENGLISH_TEXT, CHINESE_TEXT } from './name-dictionary.mjs';
import { POLITICAL_TEXT, ADULT_TEXT, ILLEGAL_TEXT, TAGGED_POLITICAL_TEXT } from './name-sensitive-dictionary.mjs';

export const NAME_POLICY_LIMITS = Object.freeze({ nameLength: 12, rawLength: 256, dictionaryEntries: 8192, wordLength: 64, dictionaryLength: 262144 });
export const NAME_REASON = Object.freeze({ SENSITIVE: 'sensitive', EMPTY: 'empty', TOO_LONG: 'too_long', INVALID_TYPE: 'invalid_type' });
export const NAME_REJECTED_MESSAGE = '代号含有不适宜内容，请换一个昵称。';
export const nameReasonMessage = reason => reason === NAME_REASON.SENSITIVE ? NAME_REJECTED_MESSAGE
  : reason === NAME_REASON.TOO_LONG ? '代号最多 12 字，请缩短后重试。' : '请输入有效的博士代号。';

// Entry exclusions apply to the obscenity corpus ONLY, never the political category.
// They cannot approve an entire name containing a different blocked term.
export const NAME_DICTIONARY_EXCLUSIONS = Object.freeze({
  english: Object.freeze(['sex', 'sexy', 'sexual', 'sexuality', 'gay', 'lesbian', 'queer', 'homosexual', 'bisexual',
    'penis', 'vagina', 'clitoris', 'testicle', 'testicles', 'anus', 'breasts', 'nipple', 'nipples', 'sperm', 'scrotum', 'labia',
    'rectum', 'vulva', 'genitals', 'semen', 'ejaculation', 'fecal', 'xx', 'xxx', 'nsfw', 'lolita']),
  chinese: Object.freeze(['成人', '乳房', '乳头', '乳頭', '阴道', '陰道', '阴茎', '陰莖', '阴唇', '陰唇', '阴蒂', '陰蒂',
    '睾丸', '精液', '胸部', '生殖器', '肛门', '肛門', '处女', '包皮', '精子', '射精', '月经', '屁股',
    '交配', '外阴', '阴户', '阴核', '阴毛', '阴部', '阳具', '阳萎', '龟头', '卵子', '性器', '性无能',
    '九游', '私服', '激情', '后庭', '祖宗', '老母', '老二', '他妈', '你妈', '他娘', '你娘', '妈妈的', '你全家',
    '同性恋', '同性戀', '异性恋', '異性戀', '双性恋', '雙性戀', '黑人', '白人', '中国', '中國', '日本', '台湾', '臺灣']),
});
export const NAME_DICTIONARY_SUPPLEMENTS = Object.freeze({
  english: Object.freeze(['kill yourself']),
  chinese: Object.freeze(['草你妈', '草你媽', '操你媽', '傻逼', '傻比', '傻屌', '狗日的', '日你妈', '日你媽', '去死吧', '杀你全家', '殺你全家']),
});

const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const INVISIBLE_RE = /[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}]/gu;
const SEPARATOR_RE = /[\p{White_Space}\p{P}\p{S}]/gu;
const LATIN_WORD_RE = /[\p{Script=Latin}\p{N}\p{M}]/u;
const COMPACTABLE_RE = /^[\p{L}\p{N}\p{M}\s]+$/u;
const BOUNDARY = '\u0001'; // User-supplied controls are stripped before this adapter creates boundaries.
export const categoryWords = text => text.replace(/^﻿/, '').split(/[,，\r\n]+/).map(word => word.trim()).filter(Boolean);
const POLITICAL_WORDS = Object.freeze(categoryWords(POLITICAL_TEXT).concat(categoryWords(TAGGED_POLITICAL_TEXT)));
const CHINESE_WORDS = Object.freeze(CHINESE_TEXT.trimEnd().split('\n').concat(categoryWords(ADULT_TEXT), categoryWords(ILLEGAL_TEXT)));

function clean(raw) {
  return raw.normalize('NFKC').replace(LONE_SURROGATE_RE, '').replace(/\s+/g, ' ')
    .replace(INVISIBLE_RE, '').replace(/ {2,}/g, ' ').trim();
}
export function sanitizeName(raw) {
  if (typeof raw !== 'string' || raw.length > NAME_POLICY_LIMITS.rawLength) return null;
  const value = [...clean(raw)].slice(0, NAME_POLICY_LIMITS.nameLength).join('').trim();
  return value || null;
}
const compact = text => text.replace(SEPARATOR_RE, '');

// Encode Latin boundaries in both input and dictionary for the existing engine. No match scanning,
// dynamic regexes or dictionary-derived expressions: Scunthorpe/Cass/class stay whole Latin words.
function englishForm(text) {
  let output = BOUNDARY, previous = null;
  for (const character of text) {
    const latin = LATIN_WORD_RE.test(character);
    if (previous !== null && latin !== previous) output += BOUNDARY;
    output += character;
    previous = latin;
  }
  return output + BOUNDARY;
}

/** Pure bounded adapter/factory; mint-filter performs ALL detection, with literal trie keys. */
export function createNamePolicy({ english = ENGLISH_TEXT.trimEnd().split('\n'), chinese = CHINESE_WORDS, political = POLITICAL_WORDS,
  extraEnglish = NAME_DICTIONARY_SUPPLEMENTS.english, extraChinese = NAME_DICTIONARY_SUPPLEMENTS.chinese,
  ignoredEnglish = NAME_DICTIONARY_EXCLUSIONS.english, ignoredChinese = NAME_DICTIONARY_EXCLUSIONS.chinese } = {}) {
  const groups = [english, chinese, political, extraEnglish, extraChinese, ignoredEnglish, ignoredChinese];
  if (groups.some(group => !Array.isArray(group)) || groups.reduce((n, group) => n + group.length, 0) > NAME_POLICY_LIMITS.dictionaryEntries) {
    throw new Error('Invalid name dictionary size');
  }
  let length = 0;
  for (const group of groups) for (const word of group) {
    if (typeof word !== 'string' || !word.length || word.length > NAME_POLICY_LIMITS.wordLength) throw new Error('Invalid name dictionary entry');
    length += word.length;
  }
  if (length > NAME_POLICY_LIMITS.dictionaryLength) throw new Error('Invalid name dictionary size');
  const exclusions = [new Set(ignoredEnglish.map(word => clean(word).toLowerCase())), new Set(ignoredChinese.map(word => clean(word).toLowerCase()))];
  const prepare = (entries, ignore, isChinese = false) => [...new Set(entries.map(word => clean(word).toLowerCase())
    .filter(word => word && (!isChinese || [...word].length >= 2) && !ignore.has(word)))];
  const englishWords = prepare(english.concat(extraEnglish), exclusions[0]);
  const chineseWords = prepare(chinese.concat(extraChinese), exclusions[1], true);
  // Political categories are intact: no exclusions or name-level whitelist can bypass them.
  const politicalWords = prepare(political, new Set());
  const englishEngine = new Mint(englishWords.map(englishForm));
  const englishCompactEngine = new Mint(englishWords.filter(word => COMPACTABLE_RE.test(word)).map(word => englishForm(compact(word))));
  const chineseEngine = new Mint(chineseWords);
  const chineseCompactEngine = new Mint(chineseWords.filter(word => COMPACTABLE_RE.test(word)).map(compact));
  const politicalEngine = new Mint(politicalWords);
  const politicalCompactEngine = new Mint(politicalWords.filter(word => COMPACTABLE_RE.test(word)).map(compact));

  return raw => {
    if (typeof raw !== 'string') return { ok: false, reason: NAME_REASON.INVALID_TYPE };
    if (raw.length > NAME_POLICY_LIMITS.rawLength) return { ok: false, reason: NAME_REASON.TOO_LONG };
    const name = clean(raw);
    if (!name) return { ok: false, reason: NAME_REASON.EMPTY };
    const original = name.toLowerCase(), folded = compact(original);
    // Never expose Mint.filter().words/text or a matched term to callers/logs.
    if (!politicalEngine.verify(original) || !politicalCompactEngine.verify(folded)) return { ok: false, reason: NAME_REASON.SENSITIVE };
    // Only this harmless possessive span is masked in the obscenity corpus, not the political corpus.
    const text = original.replaceAll('妈妈的', ' ');
    if (!chineseEngine.verify(text) || !chineseCompactEngine.verify(compact(text))
      || !englishEngine.verify(englishForm(text)) || !englishCompactEngine.verify(englishForm(compact(text)))) {
      return { ok: false, reason: NAME_REASON.SENSITIVE };
    }
    if (name.length > NAME_POLICY_LIMITS.nameLength) return { ok: false, reason: NAME_REASON.TOO_LONG };
    return { ok: true, name };
  };
}

export const moderateName = createNamePolicy();
