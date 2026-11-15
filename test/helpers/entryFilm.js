/**
 * No entry film on this page's loads (globalThis.__SP_ENTRY_FILM__ = 'off' before every document, reloads included).
 * A browser under automation already gets none unless the page asks with `?film=on` (public/js/main.js wantsEntryFilm);
 * the suites that are not about the film set this as well, so a run with the film forced on does not take their first
 * clicks. test/ui/entry-film.test.js covers the film itself; test/e2e/client.mjs Client.open goes through one like a
 * player (passEntryFilm).
 * @param {any} page
 */
export function skipEntryFilm(page) {
  return page.evaluateOnNewDocument(() => { globalThis.__SP_ENTRY_FILM__ = 'off'; });
}
