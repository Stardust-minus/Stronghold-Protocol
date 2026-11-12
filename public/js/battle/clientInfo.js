// public/js/battle/clientInfo.js — what this page tells the server about itself for shadow verification (DESIGN §14
// "Shadow verification"; g.sim `client`, shared/protocol.js): the browser engine, the system and the device class (fixed
// vocabularies — the server counts replica / verification outcomes per such group), the front-end build it runs
// (ui/buildGuard.js), a random device id of its own (localStorage 'sp.devId', never derived from anything about the
// device), and whether it verifies battles of other matches for the server.
//
// It verifies unless the player opted out (localStorage 'sp.verify' = '0', or 'sp.localSim' = '0' — no local simulation
// at all), the page has no module Worker, the page is stale (a newer build is deployed), or the device looks weak
// (fewer than 4 logical cores, or less than 4 GB where the browser says): a verification is a whole battle simulated in
// a Worker, about a second on a mid-range phone.
import { pageBuild, pageStale } from '../ui/buildGuard.js';

const DEV_KEY = 'sp.devId';

/** @param {string} ua @param {any} [nav] */
export function classifyClient(ua, nav = {}) {
  const s = String(ua || '');
  const ios = /iPhone|iPad|iPod/.test(s) || (/Macintosh/.test(s) && Number(nav.maxTouchPoints) > 1);
  const os = ios ? 'ios' : /Android/.test(s) ? 'android' : /Windows/.test(s) ? 'windows' : /Mac OS X|Macintosh/.test(s) ? 'mac'
    : /Linux|X11|CrOS/.test(s) ? 'linux' : 'other';
  // every iOS browser is WebKit; Gecko before Blink (Firefox names no Chrome); Blink: Chrome, Edge, the Chinese browsers
  const eng = ios ? 'webkit' : /Firefox\/|Gecko\/\d/.test(s) && !/like Gecko/.test(s) ? 'gecko'
    : /Chrome\/|Chromium\/|CriOS|EdgA?\/|HeadlessChrome/.test(s) ? 'blink' : /AppleWebKit/.test(s) ? 'webkit' : 'other';
  const mobileHint = typeof nav.userAgentData?.mobile === 'boolean' ? nav.userAgentData.mobile : null;
  const dev = mobileHint ?? (ios || os === 'android' || /Mobi/.test(s)) ? 'mobile' : 'desktop';
  return { eng, os, dev };
}

function deviceId(storage) {
  try {
    const have = storage?.getItem(DEV_KEY);
    if (typeof have === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(have)) return have;
    const bytes = new Uint8Array(12);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    storage?.setItem(DEV_KEY, id);
    return id;
  } catch {
    return null;
  }
}

/**
 * @param {{ nav?: any, storage?: Storage | null, build?: string | null, stale?: boolean, hasWorker?: boolean }} [deps] tests
 * @returns {{ eng: string, os: string, dev: string, build: string | null, id: string | null, verify: boolean }}
 */
export function simClientInfo({ nav = globalThis.navigator || {}, storage = globalThis.localStorage ?? null, build = pageBuild(),
  stale = pageStale(), hasWorker = typeof globalThis.Worker === 'function' } = {}) {
  const { eng, os, dev } = classifyClient(nav.userAgent, nav);
  const optedOut = (() => {
    try { return storage?.getItem('sp.verify') === '0' || storage?.getItem('sp.localSim') === '0'; } catch { return false; }
  })();
  const cores = Number(nav.hardwareConcurrency) || 0;
  const memory = Number(nav.deviceMemory);
  const weak = cores < 4 || (Number.isFinite(memory) && memory > 0 && memory < 4);
  const tag = typeof build === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(build) ? build : null;
  return { eng, os, dev, build: tag, id: deviceId(storage), verify: !optedOut && hasWorker && !stale && !weak && !!tag };
}
