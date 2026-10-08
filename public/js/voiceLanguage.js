// Voice language belongs to the listener, not the room, operator appearance or interface language.
export const VOICE_LANGUAGES = Object.freeze(['cn', 'jp', 'en']);
export const normalizeVoiceLanguage = value => VOICE_LANGUAGES.includes(value) ? value : 'cn';

/** One selected-language line, then the ordinary Chinese line of the same battle slot. */
export function voiceCandidates(manifest, charId, slot, language, random = Math.random) {
  if (typeof charId !== 'string' || typeof slot !== 'string') return [];
  const audio = manifest?.audio;
  if (!audio) return [];
  const line = voices => voices && Object.hasOwn(voices, charId) && Object.hasOwn(voices[charId] || {}, slot) ? voices[charId][slot] : null;
  const chosen = normalizeVoiceLanguage(language);
  const roll = Math.max(0, Math.min(0.999999999, Number(random()) || 0));
  const pick = value => {
    const urls = (Array.isArray(value) ? value : [value]).filter(url => typeof url === 'string' && url);
    return urls.length ? urls[Math.floor(roll * urls.length)] : null;
  };
  const chinese = pick(line(audio.voiceByLang?.cn)) || pick(line(audio.voice));
  const preferred = chosen === 'cn' ? chinese : pick(line(audio.voiceByLang?.[chosen]));
  return [...new Set([preferred, chosen === 'cn' ? null : chinese].filter(Boolean))];
}
