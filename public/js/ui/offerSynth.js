// 确认入场's sounds, drawn in code (2026-11-05; ui/offerCues.js plays them through audio.synth, so they run in the SFX
// channel — mute and the SFX volume apply as to every UI sound; no file is shipped or fetched). Original cues for the
// takeover's beats (ui/matchOffer.js), short and dry so they sit under the music:
//   arrive   — a riser (band-passed noise sweeping up, OFFER_RISE_S) into an impact (a pitched-down sine thump, a noise
//              crack and a bright click) that lands with the title's slam;
//   peer     — a crisp two-partial tick for each acceptance;
//   mine     — a confirm hit: a short thump under a rising fifth;
//   tick     — a dry wood-like click for each of the last five seconds;
//   allReady — a whoosh (noise swept through a band-pass, up then away) with a soft sub swell, the hand-off to connecting;
//   broken   — a falling tone over a low thud.
// playOfferSynth(ctx, out, name, volume) schedules the nodes from ctx.currentTime and returns the cue's length in seconds
// (0 for an unknown name); every node stops by itself.

/** The riser's length: the impact lands this long after the arrival (the takeover's title slam is timed to it). */
export const OFFER_RISE_S = 0.34;
export const OFFER_SYNTHS = Object.freeze(['arrive', 'peer', 'mine', 'tick', 'allReady', 'broken']);

const noises = new WeakMap();
/** One second of white noise per context (seeded, so every page makes the same). */
function noise(ctx) {
  let b = noises.get(ctx);
  if (b) return b;
  const rate = ctx.sampleRate || 44100;
  b = ctx.createBuffer(1, rate, rate);
  const ch = b.getChannelData(0);
  let x = 0x2f6e2b1;
  for (let i = 0; i < ch.length; i++) { x = (x * 1103515245 + 12345) >>> 0; ch[i] = (x / 0xffffffff) * 2 - 1; }
  noises.set(ctx, b);
  return b;
}

/** A gain node with an attack / exponential-decay envelope from `t`. */
function env(ctx, out, t, attack, peak, decay) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(out);
  return g;
}

function tone(ctx, out, t, { type = 'sine', f0, f1 = f0, glide = 0.1, attack = 0.004, peak, decay }) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + glide);
  o.connect(env(ctx, out, t, attack, peak, decay));
  o.start(t);
  o.stop(t + attack + decay + 0.05);
}

function burst(ctx, out, t, { type = 'lowpass', f0, f1 = f0, glide = 0.1, q = 0.8, attack = 0.002, peak, decay, offset = 0 }) {
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.Q.setValueAtTime(q, t);
  f.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + glide);
  src.connect(f);
  f.connect(env(ctx, out, t, attack, peak, decay));
  src.start(t, offset);
  src.stop(t + attack + decay + 0.05);
}

function impact(ctx, out, t, v) {
  tone(ctx, out, t, { f0: 160, f1: 40, glide: 0.22, peak: v, decay: 0.5 });
  burst(ctx, out, t, { f0: 2600, f1: 500, glide: 0.12, peak: v * 0.55, decay: 0.16 });
  tone(ctx, out, t, { type: 'triangle', f0: 2400, f1: 1800, glide: 0.02, peak: v * 0.25, decay: 0.03 });
}

/**
 * Schedule one cue into `out` (the SFX channel) from now.
 * @param {BaseAudioContext} ctx @param {AudioNode} out @param {string} name OFFER_SYNTHS @param {number} [volume] 0..1
 * @returns {number} seconds the cue lasts (0: unknown name)
 */
export function playOfferSynth(ctx, out, name, volume = 1) {
  const v = Math.max(0, Math.min(1, Number(volume) || 0));
  const t = (ctx.currentTime || 0) + 0.005;
  switch (name) {
    case 'arrive': {
      burst(ctx, out, t, { type: 'bandpass', f0: 280, f1: 5200, glide: OFFER_RISE_S, q: 1.6, attack: OFFER_RISE_S * 0.9, peak: v * 0.45, decay: 0.05 });
      tone(ctx, out, t, { type: 'sawtooth', f0: 110, f1: 440, glide: OFFER_RISE_S, attack: OFFER_RISE_S * 0.9, peak: v * 0.06, decay: 0.04 });
      impact(ctx, out, t + OFFER_RISE_S, v);
      return OFFER_RISE_S + 0.6;
    }
    case 'peer':
      tone(ctx, out, t, { type: 'triangle', f0: 1760, peak: v * 0.5, decay: 0.09 });
      tone(ctx, out, t + 0.012, { f0: 2640, peak: v * 0.28, decay: 0.07 });
      return 0.15;
    case 'mine':
      tone(ctx, out, t, { f0: 120, f1: 55, glide: 0.12, peak: v * 0.7, decay: 0.22 });
      tone(ctx, out, t, { type: 'triangle', f0: 660, peak: v * 0.35, decay: 0.28 });
      tone(ctx, out, t + 0.06, { type: 'triangle', f0: 990, peak: v * 0.3, decay: 0.32 });
      burst(ctx, out, t, { type: 'highpass', f0: 3000, peak: v * 0.18, decay: 0.05 });
      return 0.45;
    case 'tick':
      tone(ctx, out, t, { type: 'square', f0: 1250, f1: 900, glide: 0.03, peak: v * 0.18, decay: 0.035 });
      burst(ctx, out, t, { type: 'bandpass', f0: 2200, q: 3, peak: v * 0.25, decay: 0.03 });
      return 0.08;
    case 'allReady':
      burst(ctx, out, t, { type: 'bandpass', f0: 380, f1: 3400, glide: 0.32, q: 1.2, attack: 0.28, peak: v * 0.5, decay: 0.42 });
      tone(ctx, out, t, { f0: 70, f1: 120, glide: 0.4, attack: 0.2, peak: v * 0.35, decay: 0.5 });
      tone(ctx, out, t + 0.22, { type: 'triangle', f0: 880, f1: 1320, glide: 0.2, peak: v * 0.16, decay: 0.4 });
      return 0.8;
    case 'broken':
      tone(ctx, out, t, { type: 'triangle', f0: 520, f1: 210, glide: 0.34, peak: v * 0.32, decay: 0.38 });
      tone(ctx, out, t, { f0: 90, f1: 45, glide: 0.2, peak: v * 0.5, decay: 0.3 });
      return 0.45;
    default:
      return 0;
  }
}
