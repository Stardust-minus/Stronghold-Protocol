// Each rolling-release page owns its URL namespace. No shared cookie can move another tab's assets or socket.
const RELEASE_PATH = /^\/_release\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\/|$)/;
const RESOURCE_PATH = /^\/(?:assets|media|data|sim|shared|vendor|fonts|js|css)\//;

export function releaseBase(pathname = globalThis.location?.pathname) {
  const match = typeof pathname === 'string' ? RELEASE_PATH.exec(pathname) : null;
  return match ? `/_release/${match[1]}` : '';
}

export function releaseResource(url, pathname = globalThis.location?.pathname) {
  if (typeof url !== 'string' || !RESOURCE_PATH.test(url)) return url;
  const base = releaseBase(pathname);
  if (!base) return url;
  // Mirror the repository topology: public/js imports ../../shared, while server/sim also imports ../../shared.
  // At the origin root the browser used to clamp an extra '..'; a version prefix must not rely on that clamping.
  const root = url.startsWith('/sim/') ? '/server' : /^\/(?:assets|media|vendor|fonts|js|css)\//.test(url) ? '/public' : '';
  return base + root + url;
}

/** Only browser art manifests are adapted; numerical simulation data is never rewritten. */
export function pinAssetManifest(value, pathname = globalThis.location?.pathname) {
  if (!releaseBase(pathname)) return value;
  if (typeof value === 'string') return releaseResource(value, pathname);
  if (Array.isArray(value)) return value.map((v) => pinAssetManifest(v, pathname));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, pinAssetManifest(v, pathname)]));
  return value;
}
