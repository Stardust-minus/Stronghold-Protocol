// The 卫戍协议：盟约 entry animation (ui/allianceScene.js) before the title screen, on every page load, with the event's
// sound as the recording has it: the entry cue act1autochess_g_ui_load at video 1.686 s, then the lobby music from its
// very start at 2.144 s with audio.js's own 0.8 s fade-in (a cross-correlation of the recording's soundtrack against the
// official files: r 0.988 / 0.998, nothing else is in it). A fresh page may not play sound before a user gesture, so a
// black 点击进入 card waits for the tap that unlocks it (audio.js listens for the same gesture), then the film runs.
// The card comes up at once and the film's art loads behind it (this fork, 2026-11-16: the art used to get a 1.2 s look
// before the card, which a cold first visit often missed — 盟约's film in place of 规程's, or no card and no film at
// all): a tap before the art is in turns the card into 加载中 until it is, for a while (ART_MS / TAP_MS below); art
// that fails, or is not in by then, takes the card down and leaves the title screen.
// Volumes / mute are the settings' (sfx · bgm channels); the player's own lobby music (audio.setLobbyTrack) plays in
// place of the official track as everywhere else, untouched by the film — a custom track that arrives while the film
// holds the music is handed to audio.js at once. A tap / click / key skips (the film, or the wait for its art). Whether
// the film plays is decided once, when the title is entered: a phone that is portrait then gets no film, and turning it
// landscape later does not start one. Reduced motion, or no art at all (no art pack: nothing to load), gets no film and
// no card. Never over a room or a match: the route is watched from the card on, and a session restored into a room / a
// match while the card waits or the film runs takes the overlay down at once, silences the cue and hands the music
// back to that screen.
// main.js calls playEntryFilm once at boot. A 规程 start (versions.js startupVersion) plays 规程's own opening instead
// (ui/regulationFilm.js: the client's season entry, DESIGN §37.147) through the same card, skip, cue and music hold;
// without that art (it comes only from a local-client extraction, data/local-assets.json) or when it does not load in
// time, 盟约's film plays (this fork, 2026-11-15: the film is on by default, so a 规程 start should not show nothing).
// Both films' art loads from the start (盟约's asked for right after 规程's), so 盟约's is in, or nearly, by the time
// 规程's has failed.
import { store, selectRoute } from '../store.js';
import { audio, resolveBgm } from '../audio.js';
import { data } from '../data.js';
import { reducedMotion } from './device.js';
import { mountAllianceIntro, preloadSprites, setCycleOrigin, INTRO_AUDIO, INTRO_SPAN } from './allianceScene.js';
import { t } from '../../../shared/i18n.js';
import { scriptOf } from '../../../shared/i18nPacks.js';
import { DEFAULT_VERSION } from '../../../shared/versions.js';
import { startupVersion } from '../versions.js';

// The cue for a manifest that does not list it: the manifest's own entry (audio.sfx.ui.load) carries the content hash, so
// the worker answers it from a finished download (GitHub #725, §37.99).
const ENTRY_SFX = '/assets/audio/sfx/customse/act1autochess/act1autochess_g_ui_load.mp3';
// the cue against the music as the recording mixes them (cue ×0.28, music ×0.18 of their files), at the default
// volumes (sfx 0.8 → ×0.576, bgm 0.6 → ×0.198 in audio.js _applyVolumes)
const SFX_GAIN = 0.54;
// The art's time (this fork, 2026-11-16). A cold first visit loaded 规程's opening (prefabs.json and 40 pictures, about
// 3.5 MB through the entry and the CDN redirects) in 1.3–2.6 s on a fast line, and 盟约's film (8 pictures, about 2.2 MB)
// in about 1 s more; a player's slower line takes a few times that (a browser held to 8 Mbit/s and 150 ms: 规程's
// opening 6.9 s after the card, 16 Mbit/s and 100 ms: 4.7 s). The card is up meanwhile and waits for its tap anyway,
// so the art may take ART_MS from the moment it starts to load, with the card once the page has booted (not from the
// page's start: on a slow line the boot alone takes seconds) — about three times the fast line's whole load; a tap
// later than that still gives art in flight TAP_MS more. 加载中 is on the card meanwhile (a tap goes to the title), then
// the card goes: the title screen, not a longer black one.
const ART_MS = 8000;
const TAP_MS = 2500;
// Art not in this long after its load began is given up for this page load (a card still waiting for its tap goes then)
const ART_CAP_MS = 60000;
// A 规程 start asks for 盟约's pictures, the fallback, right after 规程's (at the latest this long after 规程's load
// began, should its pack not answer): 规程's are then fetched first — 盟约's queue behind them on HTTP/1.1, and 规程's
// are fetchPriority high on HTTP/2 — so the fallback does not hold up the film it stands in for (both at once, 盟约's
// first: neither in within ART_MS at 8 Mbit/s), and is in, or nearly, when 规程's fails.
const FALLBACK_LEAD_MS = 1500;

const CSS = `
.spa-entry{position:fixed;inset:0;z-index:2147483647;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;
  border:0;outline:0;overflow:hidden;background:#000;cursor:pointer;color:#dfe9ea}
.spa-entry::backdrop{background:transparent}
.spa-entry__gate{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;
  font-family:Bender,"Microsoft YaHei","Noto Sans SC",sans-serif;color:#dfe9ea;animation:spa-pulse 1.8s ease-in-out infinite}
.spa-entry__gate b{font:700 22px/1 "Microsoft YaHei","Noto Sans SC",sans-serif;letter-spacing:.4em;padding-left:.4em}
.spa-entry__gate i{font-style:normal;font-size:12px;letter-spacing:.5em;color:#47c9a9}
@keyframes spa-pulse{0%,100%{opacity:.55}50%{opacity:1}}
.spa-entry__gate--wait{animation-duration:1s}
.spa-entry__gate--wait::after{content:"";width:120px;height:2px;margin-top:4px;
  background:linear-gradient(90deg,transparent,#47c9a9,transparent) 0 0/50% 100% no-repeat;animation:spa-wait 1.1s linear infinite}
@keyframes spa-wait{from{background-position:-100% 0}to{background-position:200% 0}}
.spa-entry__skip{position:absolute;right:3%;bottom:3.5%;z-index:2;font:12px/1 "Microsoft YaHei","Noto Sans SC",sans-serif;
  letter-spacing:.2em;color:rgba(220,240,236,.45);pointer-events:none;transition:opacity .3s}`;

const mq = (q) => { try { return !!globalThis.matchMedia(q).matches; } catch { return false; } };
/** A phone / tablet: a coarse (touch) pointer and no mouse. */
const touchDevice = () => (mq('(pointer: coarse)') || mq('(any-pointer: coarse)')) && !mq('(any-pointer: fine)');
/** Phones play the opening in landscape (in portrait the game shows its rotate hint; a 16:9 film would be a strip). */
function phoneReady() {
  return globalThis.innerWidth > globalThis.innerHeight;
}

/**
 * Decode the cue (and warm the lobby music) while the pictures load; null when nothing can be heard now.
 * @param {string} version  the version whose lobby track the film hands over to
 */
async function prepareSound(version) {
  const ctx = audio.ctx;
  if (!ctx || ctx.state !== 'running' || audio.volumes?.muted) return null;
  const manifest = data.get('assets');
  const track = resolveBgm(manifest, 'lobby', version);
  const listed = manifest?.audio?.sfx?.ui?.load;
  const wait = (p) => Promise.race([Promise.resolve(p).catch(() => null), new Promise((r) => setTimeout(() => r(null), 2500))]);
  const [sfx] = await Promise.all([wait(audio._buffer(typeof listed === 'string' && listed ? listed : ENTRY_SFX)), wait(track?.intro ? audio._buffer(track.intro) : null), wait(track ? audio._buffer(track.loop) : null)]);
  return { sfx };
}
/**
 * Hold the screen's music for the opening: the playing track fades out and every playBgm meanwhile is only remembered;
 * the release starts the remembered (else the last) track from its top — audio.js's own start, fade-in included.
 * Null when the music is silent or the player's own lobby music is set (audio.setLobbyTrack → audio.lobbyTrack): that
 * one keeps playing on — no fade, playBgm left alone. A lobbyTrack that arrives while the hold is up is not waited
 * out: the next playBgm drops the placeholder at once and calls the real playBgm (no further fade-out).
 * @param {any} [a] the audio manager (tests pass a stand-in)
 * @returns {(() => void) | null} the release
 */
export function holdBgm(a = audio) {
  if (!a.ctx || a.bgmSilent || a.lobbyTrack || Object.prototype.hasOwnProperty.call(a, 'playBgm')) return null;
  let asked;
  let passed = false;
  const placeholder = (key) => {
    // the player's own file loaded after the hold (installLobbyMedia is async): hand this call to audio.js now
    if (a.lobbyTrack) {
      if (a.playBgm === placeholder) delete a.playBgm;
      passed = true;
      try { a.playBgm(key); } catch { /* ignore */ }
      return;
    }
    asked = key;
  };
  a.playBgm = placeholder;
  try { ++a.bgmToken; a._fadeOutBgm(null, 0.4); } catch { /* ignore */ }
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    if (a.playBgm === placeholder) delete a.playBgm;
    if (passed) return; // already started from its top; releasing must not start it again
    try { a.playBgm(asked !== undefined ? asked : a.lastBgmKey ?? 'lobby'); } catch { /* ignore */ }
  };
}

let playing = false;

/**
 * @typedef {{ render: (t: number) => void, grain: () => void, destroy: () => void }} FilmScene
 * @typedef {{ label: string, mount: (host: HTMLElement) => FilmScene, preload: (ms: number) => Promise<boolean>,
 *   span: { from: number, fadeAt: number, to: number }, audio: { sfxAt: number, bgmAt: number }, version: string,
 *   origin?: (t0: number) => void }} Film  span / audio: film seconds (the film runs from `from` to `to`, fading out
 *   from `fadeAt`; the cue starts at sfxAt, the held music at bgmAt); version: whose lobby track to warm; origin: told
 *   the moment film second `from` is on screen
 */

/**
 * 盟约's film (ui/allianceScene.js).
 * @param {(host: HTMLElement) => FilmScene} mount
 * @returns {Film}
 */
function allianceFilm(mount) {
  return {
    label: t('卫戍协议') + ' · ' + t('盟约'),
    mount,
    preload: (ms) => preloadSprites(undefined, ms),
    span: INTRO_SPAN,
    audio: INTRO_AUDIO,
    // its cues are timed to the default season's lobby track (act2autochess is not in audio.seasons)
    version: DEFAULT_VERSION,
    // the backdrop under the opening shows the same moment of the cycle
    origin: (t0) => setCycleOrigin(t0 + (3.12 - INTRO_SPAN.from) * 1000),
  };
}

/** 规程's opening's label and the lobby version it hands over to: the card's before its pack is in. */
const regulationTitle = () => ({ label: t('卫戍协议·规程'), version: startupVersion(store.get()) });

/**
 * 规程's opening (ui/regulationFilm.js), or null when its group is not extracted / not readable.
 * @param {((host: HTMLElement) => FilmScene)|null} [mount]  tests pass a stand-in scene
 * @returns {Promise<Film|null>}
 */
async function regulationFilm(mount = null) {
  const m = await import('./regulationFilm.js');
  const pack = await m.loadRegulationPack();
  if (!pack) return null;
  return {
    ...regulationTitle(),
    mount: mount || ((host) => m.mountRegulationIntro(host, pack)),
    preload: (ms) => m.preloadRegulation(pack, ms),
    span: m.REG_SPAN,
    audio: m.REG_AUDIO,
  };
}

/**
 * The films a start may play, best first (a 规程 start: 规程's opening, then 盟约's film), every one's art loading from
 * now on, each film's pictures asked for right after the better one's (FALLBACK_LEAD_MS). choice(): the first film
 * whose art is in once every better one has failed; null when none can play; undefined while that still waits on a
 * load. pick(until) waits for the choice until `until` (performance.now(); null: no limit), then takes the first film
 * whose art is in, else null.
 * @param {(Film|null|Promise<Film|null>)[]} list
 * @param {number} cap  ms a film's art may take at all (ART_CAP_MS)
 */
function loadFilms(list, cap) {
  /** @type {{ film: Film|null, ok: boolean|undefined }[]} */
  const art = list.map(() => ({ film: null, ok: undefined }));
  /** @type {Set<() => void>} */
  const waits = new Set();
  let better = Promise.resolve();
  list.forEach((entry, i) => {
    let timer = 0, asked = () => {};
    const turn = i === 0 ? Promise.resolve() : new Promise((resolve) => {
      const lead = setTimeout(resolve, FALLBACK_LEAD_MS);
      better.then(() => { clearTimeout(lead); resolve(undefined); });
    });
    better = new Promise((resolve) => { asked = resolve; });
    const loaded = turn.then(() => entry)
      .then((film) => { art[i].film = film || null; const p = film ? film.preload(cap) : false; asked(); return p; })
      .then((ok) => ok === true, () => { asked(); return false; });
    // the cap holds for the whole of it, 规程's pack (its manifest and prefabs.json) included
    Promise.race([loaded, new Promise((resolve) => { timer = setTimeout(() => resolve(false), cap); })])
      .then((ok) => { clearTimeout(timer); art[i].ok = ok; for (const w of [...waits]) w(); });
  });
  /** @param {boolean} [late] the wait is over: the first film whose art is in */
  const choice = (late = false) => {
    for (const a of art) {
      if (a.ok) return a.film;
      if (a.ok === undefined && !late) return undefined;
    }
    return null;
  };
  return {
    choice,
    /** @param {number|null} until @returns {Promise<Film|null>} */
    async pick(until) {
      for (;;) {
        const film = choice();
        if (film !== undefined) return film;
        const left = until == null ? Infinity : until - performance.now();
        if (left <= 0) return choice(true);
        await new Promise((resolve) => {
          const done = () => { clearTimeout(timer); waits.delete(done); resolve(undefined); };
          const timer = left === Infinity ? 0 : setTimeout(done, left);
          waits.add(done);
        });
      }
    },
  };
}

/**
 * @param {() => boolean} allowed  false once the film must go (a room / a match, the caller's skip)
 * @param {ReturnType<typeof loadFilms>} films
 * @param {{ label: string, version: string }} first  the best film's label and lobby version (the card's until the
 *   choice is made)
 * @param {{ by: number, tap: number }} budget  by: when the art's ART_MS run out (performance.now()); tap: TAP_MS (tests
 *   pass their own)
 */
function run(allowed, films, first, budget) {
  if (playing || !allowed()) return;
  playing = true;
  if (!document.getElementById('spa-entry-style')) {
    const st = document.createElement('style');
    st.id = 'spa-entry-style';
    st.textContent = CSS;
    document.head.append(st);
  }
  // a modal <dialog>: the top layer, so it also covers the fullscreen prompt (fullscreen-guide.js, a modal dialog too)
  const el = document.createElement('dialog');
  el.className = 'spa-entry';
  el.setAttribute('aria-label', first.label);
  el.innerHTML = '<span class="spa-entry__skip"></span>';
  el.firstChild.textContent = t('点击跳过');
  const locked = !(audio.ctx && audio.ctx.state === 'running');
  const skipLabel = el.querySelector('.spa-entry__skip');
  const card = document.createElement('div');
  card.className = 'spa-entry__gate';
  /** The card's line, already translated (t() at the call: the i18n extractor reads only literal t() calls); the Latin
   * one under it is a decoration under a CJK prompt (a Latin translation already says it). */
  const say = (text, latin) => {
    card.innerHTML = `<b></b><i>${latin}</i>`;
    card.firstChild.textContent = text;
    if (scriptOf(text) === 'alphabetic') card.lastChild.remove();
  };
  // the art is not in yet: the card says 加载中 until the film mounts, with the skip label under it
  const waiting = () => {
    say(t('加载中'), 'LOADING');
    card.className = 'spa-entry__gate spa-entry__gate--wait';
    el.append(card);
    skipLabel.style.opacity = '';
  };
  let gate = Promise.resolve(), gateKey = null;
  if (locked) {
    skipLabel.style.opacity = '0';
    say(t('点击进入'), 'TAP TO START');
    el.append(card);
    gate = new Promise((resolve) => {
      const go = () => {
        removeEventListener('keydown', go, true);
        if (films.choice() === undefined) waiting();
        else { card.remove(); skipLabel.style.opacity = ''; }
        // audio.js creates / resumes the context on this same gesture; give it a moment to start running
        const until = performance.now() + 600;
        const wait = () => (audio.ctx?.state === 'running' || performance.now() > until ? resolve() : setTimeout(wait, 30));
        setTimeout(wait, 0);
      };
      gateKey = go;
      el.addEventListener('pointerdown', go, { once: true });
      addEventListener('keydown', go, true);
    });
  }
  document.body.append(el);
  try { el.showModal(); } catch { el.setAttribute('open', ''); }

  let scene = null, raf = 0, release = null, bgmTimer = 0, done = false, src = null, chosen = null;
  const cleanup = () => {
    cancelAnimationFrame(raf);
    try { scene?.destroy(); } catch { /* ignore */ }
    try { el.close(); } catch { /* ignore */ }
    el.remove();
    playing = false;
  };
  /** 'end' (the film ran out, or no art for one), 'skip' (a tap / key) or 'leave' (the route left the title / lobby) */
  const finish = (how) => {
    if (done) return;
    done = true;
    unwatch();
    clearTimeout(bgmTimer);
    removeEventListener('keydown', onKey, true);
    if (gateKey) removeEventListener('keydown', gateKey, true);
    if (how === 'leave') {
      // a restored room / match: nothing of the film may sit over it or be heard in it.
      // stop() throws InvalidStateError when its time is before the scheduled start, which used to skip the
      // disconnect in the same try and let the cue play inside the match. Disconnect first; stop on its own,
      // at a time that is not before that start.
      const cue = src;
      try { cue?.gain.disconnect(); } catch { /* ignore */ }
      try {
        if (cue?.node) {
          const now = audio.ctx?.currentTime ?? cue.when ?? 0;
          cue.node.stop(cue.when == null ? now : Math.max(now, cue.when));
        }
      } catch { /* ignore */ }
      release?.(); // the music goes back to audio.js, which plays the new screen's track
      cleanup();
      return;
    }
    release?.();
    if (how === 'skip') {
      // a skip: the cue stops with the picture (the music starts now, from its top); a cue not started yet is cut off
      // like the leave's (a fade-out stop before its start time would throw and let it play)
      const cue = src, now = audio.ctx?.currentTime ?? 0;
      if (cue?.node && cue.when != null && now < cue.when) {
        try { cue.gain.disconnect(); } catch { /* ignore */ }
        try { cue.node.stop(cue.when); } catch { /* ignore */ }
      } else {
        try { cue?.gain.gain.setTargetAtTime(0, now, 0.08); cue?.node.stop(now + 0.5); } catch { /* ignore */ }
      }
      el.style.transition = 'opacity .3s ease';
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
      setTimeout(cleanup, 320);
    } else cleanup();
  };
  const onKey = () => finish('skip');
  el.addEventListener('cancel', (e) => { e.preventDefault(); if (!locked) finish('skip'); }); // Esc skips like any other key
  // skipping is armed once the card's tap is over (the gate's own tap must not skip): the wait for the art, the film
  const armSkip = () => { el.addEventListener('pointerdown', () => finish('skip')); addEventListener('keydown', onKey, true); };
  // the route, from the card on: a session restored into a room / a match takes the film down at once
  const unwatch = store.subscribe(() => { if (!done && !allowed()) finish('leave'); });
  // until a film is chosen: the choice names the overlay, and art that cannot play takes the card down at once
  films.pick(null).then((film) => {
    if (done || chosen) return;
    if (film) el.setAttribute('aria-label', film.label);
    else finish('end');
  });

  const fonts = document.fonts?.load
    ? Promise.race([Promise.all(['300 40px Bender', '400 40px Bender'].map((f) => document.fonts.load(f).catch(() => null))), new Promise((r) => setTimeout(r, 1200))])
    : null;
  gate.then(async () => {
    if (done) return;
    armSkip();
    // the cue decodes (and the lobby music warms) while the art may still be loading
    const early = prepareSound(first.version);
    let film = films.choice();
    if (film === undefined) {
      // 加载中: up since the tap; with sound running before any card, only once the art takes a moment (not a flash)
      const later = setTimeout(waiting, locked ? 0 : 250);
      film = await films.pick(Math.max(budget.by, performance.now() + budget.tap));
      clearTimeout(later);
    }
    if (done) return;
    // a sprite that 404'd (or never loaded) is not a film: take the cover down instead of playing blank frames
    if (!film) { finish('end'); return; }
    chosen = film;
    el.setAttribute('aria-label', film.label);
    const [, sound] = await Promise.all([fonts, film.version === first.version ? early : prepareSound(film.version)]);
    if (done) return;
    if (!allowed()) { finish('leave'); return; }
    card.remove();
    try { scene = film.mount(el); } catch (err) { console.warn('[intro] could not start', err); finish('end'); return; }
    const { from, fadeAt, to } = film.span;
    const lead = 0.04;
    const t0 = performance.now() + lead * 1000; // video second `from` is on screen at t0
    film.origin?.(t0);
    if (sound && audio.ctx?.state === 'running') {
      const ctx = audio.ctx;
      if (sound.sfx && audio.sfxGain) {
        try {
          const node = ctx.createBufferSource(), gain = ctx.createGain();
          node.buffer = sound.sfx; gain.gain.value = SFX_GAIN;
          node.connect(gain); gain.connect(audio.sfxGain);
          const when = ctx.currentTime + lead + Math.max(0, film.audio.sfxAt - from);
          node.start(when);
          src = { node, gain, when };
        } catch { /* ignore */ }
      }
      release = holdBgm();
      // audio.js starts a track 50 ms after it is asked for
      if (release) bgmTimer = setTimeout(() => release?.(), Math.max(0, (lead + film.audio.bgmAt - from - 0.05) * 1000));
    }
    const frame = () => {
      if (done) return;
      const T = from + (performance.now() - t0) / 1000;
      if (T >= to) { finish('end'); return; }
      if (T < 3.2) scene.grain();
      scene.render(Math.max(from, T));
      const fade = Math.min(1, Math.max(0, (T - fadeAt) / (to - fadeAt)));
      el.style.opacity = (1 - fade).toFixed(3);
      if (fade > 0) { el.style.pointerEvents = 'none'; skipLabel.style.opacity = '0'; }
      raf = requestAnimationFrame(frame);
    };
    scene.render(from);
    raf = requestAnimationFrame(frame);
  });
}

/**
 * Play the film once per page load, before the title screen — also when a reload lands in the lobby; never over a
 * room or a match, never under reduced motion, and never unless every sprite actually loads. The card comes up at
 * once (unless there is no art at all); the art may take ART_MS from then, or TAP_MS after a later tap, before the
 * card goes without a film. A phone that is portrait when this is called does not play it later, after a
 * rotation. globalThis.__SP_ENTRY_FILM__ = 'off' (the browser suites) plays nothing. A 规程 start without 规程's opening
 * (not extracted, or its pictures do not load in that time) plays 盟约's film instead. Resolves once the overlay is up,
 * or when none comes this page load.
 * @param {{ skip?: () => boolean, mount?: typeof mountAllianceIntro, regulation?: () => boolean,
 *   regulationMount?: ((host: HTMLElement) => FilmScene)|null, budget?: { load?: number, tap?: number, cap?: number } }} [opts]
 *   skip() → true when it must not (or no longer) play; mount: 盟约's scene (tests pass a stand-in); regulation() →
 *   true: 规程's opening instead (asked once, here), 盟约's film when its group is not extracted; regulationMount: its
 *   scene (tests); budget: ART_MS / TAP_MS / ART_CAP_MS (tests)
 */
export async function playEntryFilm(opts = {}) {
  const { skip = () => false, mount = mountAllianceIntro, regulation = () => false, regulationMount = null } = opts;
  const budget = { load: ART_MS, tap: TAP_MS, cap: ART_CAP_MS, ...opts.budget };
  // dev / E2E switch, like globalThis.__SP_RENDER__: the browser suites that are not about the film set it before the
  // page loads (test/helpers/entryFilm.js skipEntryFilm); a player's page never has it
  if (globalThis.__SP_ENTRY_FILM__ === 'off') return;
  if (reducedMotion()) return;
  // once, as the title is entered — a later rotation does not get a second look
  if (touchDevice() && !phoneReady()) return;
  try { await data.load('assets'); } catch { return; }
  const allowed = () => { const r = selectRoute(store.get()); return r !== 'room' && r !== 'game' && !skip(); };
  if (!allowed()) return;
  // 规程's opening when its art is extracted and loads; else 盟约's film (this fork). Both films' art loads from here
  // on, behind the card: the card does not wait for it, and 盟约's is not left until 规程's has failed
  const alliance = allianceFilm(mount);
  const reg = regulation();
  const by = performance.now() + budget.load;
  const films = loadFilms(reg ? [regulationFilm(regulationMount), alliance] : [alliance], budget.cap);
  // no art pack: there is nothing to load (the sprites have no URL) and the loads have failed by the next task — no card
  await new Promise((r) => setTimeout(r, 0));
  if (films.choice() === null || !allowed()) return;
  run(allowed, films, reg ? regulationTitle() : alliance, { by, tap: budget.tap });
}
