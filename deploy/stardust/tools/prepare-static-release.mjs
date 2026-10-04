// Offline, fail-closed preparation; does not activate a release or contact either production host.
// Usage: node deploy/stardust/tools/prepare-static-release.mjs --release <fixed-id> --revision <40-hex>
//          --out <NEW-directory> [--source <matched-app-directory>]
// Verify copied/staged output: node deploy/stardust/tools/prepare-static-release.mjs --verify <directory>
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const GAME_ORIGIN = 'https://ark-proto.stardust.matce.cn';
const STATIC_ORIGIN = 'https://ark-asset.hanabi-ai.cn:25442';
const STATIC_ROOT = '/srv/ark-static';
const IMMUTABLE = 'public, max-age=31536000, immutable';
// Exactly the current generated three-face/six-file CSS. Review the adapter when upstream changes it.
export const FONT_CSS_SHA256 = 'af82f8e4bffb870d1bb1b574815ad863fe7bcb047633554bfb06845a2fa1f9c4';
export const FONT_CSS_RELATIVE_SHA256 = '528a8e05114949c51768002d2665203de13f6e71e1028b8a8ddb5d76e0e21193';
const FONT_FILES = ['bender-regular.woff2', 'bender-regular.otf', 'bender-light.woff2', 'bender-light.ttf',
  'novecento-wide-normal.woff2', 'novecento-wide-normal.otf'];
const ART_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.atlas', '.skel', '.obj', '.mtl', '.json']);
export const AUDIO_MIME = Object.freeze({ '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav' });
const hash = (data) => createHash('sha256').update(data).digest('hex');
const json = (data) => JSON.stringify(data, null, 2) + '\n';
const fail = (message) => { throw new Error(message); };
const checksumEntries = (manifest) => [
  ...manifest.files.map((entry) => ({ ...entry, path: `releases/${manifest.release}/${entry.path}` })),
  ...manifest.nginx,
];
const checksumText = (manifest) => checksumEntries(manifest).map(({ path, sha256 }) => `${sha256}  ${path}\n`).join('');

function validateRelease(release, revision) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(release || '')) fail('Release must be a fixed, safe identifier (letters/digits/_/-; at most 96 characters)');
  if (!/^[a-f0-9]{40}$/.test(revision || '')) fail('Revision must be the full, fixed, lowercase 40-hex source commit');
}

function safePath(path) {
  if (typeof path !== 'string' || !path || path.split('/').some((s) =>
    !/^[a-zA-Z0-9_\[\]-][a-zA-Z0-9_.\[\]-]*$/.test(s) || s.endsWith('.'))) fail(`Unsafe release path: ${path}`);
  return path;
}

async function regular(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !stat.size) fail(`Expected a nonempty regular file with no links: ${path}`);
  return stat;
}

// Check ancestors as well as the final file; e.g. node_modules/preact must not be a symlink.
async function readInput(root, rel) {
  for (let p = dirname(join(root, rel)); p !== root; p = dirname(p)) {
    if (!p.startsWith(root + '/')) fail(`Input escapes source: ${rel}`);
    if (!(await lstat(p)).isDirectory()) fail(`Input parent is not a regular directory: ${p}`);
  }
  await regular(join(root, rel));
  return readFile(join(root, rel));
}

async function walk(root, rel) {
  const dir = join(root, rel);
  if (!(await lstat(dir)).isDirectory()) fail(`Expected a directory, not a symlink: ${dir}`);
  const out = [];
  for (const entry of (await readdir(dir)).sort()) {
    const name = safePath(`${rel}/${entry}`);
    const stat = await lstat(join(root, name));
    if (stat.isDirectory()) out.push(...await walk(root, name));
    else { await regular(join(root, name)); out.push({ path: name, mtime: Math.floor(stat.mtimeMs / 1000) }); }
  }
  return out;
}

export function patchFonts(data) {
  const digest = hash(data);
  if (digest === FONT_CSS_RELATIVE_SHA256) return Buffer.from(data); // Exact reviewed output only, not arbitrary relative CSS.
  if (digest !== FONT_CSS_SHA256) fail('Unexpected fonts.css; review the exact six-URL font adapter before releasing');
  let src = data.toString('utf8');
  for (const name of FONT_FILES) {
    const before = `url('/fonts/${name}')`;
    if (src.split(before).length !== 2) fail(`Unexpected font reference: ${name}`);
    src = src.replace(before, `url('./${name}')`);
  }
  return Buffer.from(src);
}

export function patchHooks(data) {
  const target = GAME_ORIGIN + '/vendor/preact.module.js';
  const src = data.toString('utf8');
  // npm's vendor adapter currently emits exactly one static sibling Preact import at the beginning.
  const matches = [...src.matchAll(/\bfrom\s*(["'])\.\/preact\.module\.js\1/g)];
  const imports = src.match(/\bimport\b/g) || [];
  const froms = [...src.matchAll(/\bfrom\s*(["'])[^"']+\1/g)];
  if (matches.length !== 1 || imports.length !== 1 || froms.length !== 1 || !/^import\{[^}]+\}from["']\.\/preact\.module\.js["'];/.test(src)) {
    fail('Unexpected hooks import; review the single-instance Preact adapter before releasing');
  }
  return Buffer.from(src.replace(matches[0][0], `from"${target}"`));
}

function references(value, refs = new Set()) {
  if (typeof value === 'string' && /^\/(assets|fonts|vendor)\//.test(value)) refs.add(safePath(value.slice(1)));
  else if (Array.isArray(value)) for (const v of value) references(v, refs);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) references(v, refs);
  return refs;
}

export function mediaMappings(files, audioExts, prefix) {
  if (prefix !== '/media/' || !audioExts.length || new Set(audioExts).size !== audioExts.length || audioExts.some((ext) => !AUDIO_MIME[ext])) {
    fail('Unexpected shared/media.js contract; review audio MIME and routing before releasing');
  }
  const groups = new Map();
  for (const { path } of files) {
    if (!path.startsWith('assets/audio/')) continue;
    const ext = extname(path);
    if (!audioExts.includes(ext)) fail(`Unsupported/non-lowercase audio extension: ${path}`);
    const stem = path.slice('assets/audio/'.length, -ext.length);
    if (audioExts.includes(extname(stem).toLowerCase())) fail(`Audio stem still ends in a media extension: ${stem}`);
    if (!groups.has(stem)) groups.set(stem, new Map());
    groups.get(stem).set(ext, path);
  }
  const routes = [];
  for (const [stem, available] of groups) {
    for (const requestedExtension of ['', ...audioExts]) {
      // Same as serveMedia: an explicit supported extension wins if present; otherwise use default priority.
      const order = requestedExtension ? [requestedExtension, ...audioExts.filter((ext) => ext !== requestedExtension)] : audioExts;
      const ext = order.find((ext) => available.has(ext));
      routes.push({ url: prefix + stem + requestedExtension, requestedExtension, file: available.get(ext), ext, mime: AUDIO_MIME[ext] });
    }
  }
  return routes.sort((a, b) => a.url.localeCompare(b.url, 'en'));
}

export function nginxIncludes(manifest, { staticRoot = STATIC_ROOT } = {}) {
  if (!isAbsolute(staticRoot) || !/^\/[a-zA-Z0-9_./-]+$/.test(staticRoot) || staticRoot.split('/').includes('..')) fail('Unsafe static root');
  validateRelease(manifest.release, manifest.sourceRevision);
  const release = manifest.release;
  const prefix = `/releases/${release}/`;
  const variable = `ark_static_${hash(release).slice(0, 12)}_file`;
  const banner = `# Generated STAGED release ${release}; not an activation record.\n`;
  const cache = banner + `~^(200|206|304):${prefix}(assets|fonts|vendor|media)/ "${IMMUTABLE}";\n`;
  // Exact inventory, rather than extension-based publication: extra files added after staging are never served.
  const files = banner + `map $uri $${variable} {\n    default "";\n` + manifest.files.map(({ path }) => {
    safePath(path);
    return `    "${prefix}${path}" "${prefix}${path}";\n`;
  }).join('') + '}\n';
  const methods = '    if ($request_method = OPTIONS) { return 204; }\n    limit_except GET HEAD OPTIONS { deny all; }\n    disable_symlinks on;\n';
  let locations = banner;
  for (const dir of ['assets', 'fonts', 'vendor']) {
    locations += `location ${prefix}${dir}/ {\n${methods}    if ($${variable} = "") { return 404; }\n    try_files $${variable} =404;\n}\n\n`;
  }
  // An alias never redirects. Explicit MIME also handles suffix fallbacks (e.g. .ogg URL backed by .mp3).
  for (const { url, file, mime } of manifest.media) {
    safePath(url.slice(1)); safePath(file);
    if (!file.startsWith('assets/audio/') || !Object.values(AUDIO_MIME).includes(mime)) fail('Unsafe media mapping');
    locations += `location = ${prefix}${url.slice(1)} {\n${methods}    alias ${staticRoot}${prefix}${file};\n    types { }\n    default_type ${mime};\n}\n\n`;
  }
  locations += `location ${prefix}media/ { return 404; }\n`;
  let game = banner + '# REPLACE the baseline /assets/, /fonts/, /vendor/ locations; include once in the TLS server.\n';
  for (const dir of ['assets', 'fonts', 'vendor', 'media']) {
    game += `location ^~ /${dir}/ {\n    auth_request off;\n    return 302 ${STATIC_ORIGIN}/releases/${release}$request_uri;\n}\n\n`;
  }
  return { 'static-cache.conf': cache, 'static-files.conf': files, 'static-locations.conf': locations, 'game-static-locations.conf': game };
}

/** Source must be the same pinned app export used for the game image; this tool does not export/build the game. */
export async function prepareStaticRelease({ source = REPO, output, release, sourceRevision }) {
  validateRelease(release, sourceRevision);
  if (!output) fail('A NEW output directory is required');
  source = resolve(source); output = resolve(output);
  if (await realpath(source) !== source) fail('Source path must not traverse symlinks');
  if (output === source || output.startsWith(source + '/') && !output.startsWith(join(source, 'deploy/stardust/build') + '/')) {
    fail('Keep staged output outside the source, or under ignored deploy/stardust/build/');
  }
  // All source prerequisites are read/validated before creating output.
  const inputs = [];
  const inputData = new Map();
  const input = async (path) => {
    if (inputData.has(path)) return inputData.get(path);
    const data = await readInput(source, path);
    inputs.push({ path, bytes: data.length, sha256: hash(data) });
    inputData.set(path, data);
    return data;
  };
  const pkg = JSON.parse(await input('package.json'));
  const lock = JSON.parse(await input('package-lock.json'));
  if (pkg.version !== lock.version || pkg.version !== lock.packages?.['']?.version ||
    JSON.stringify(pkg.dependencies) !== JSON.stringify(lock.packages[''].dependencies)) fail('package.json and package-lock.json do not match');
  const installedLock = JSON.parse(await input('node_modules/.package-lock.json'));
  const vendorInput = await input('tools/vendor.mjs');
  const mediaInput = await input('shared/media.js');
  // Import the source export's adapters, not this checkout's potentially different version.
  const { VENDOR_FILES, VENDOR_REWRITES, rewriteBare } = await import(pathToFileURL(join(source, 'tools/vendor.mjs')));
  const { AUDIO_EXTS, MEDIA_PREFIX } = await import(pathToFileURL(join(source, 'shared/media.js')));
  if (!vendorInput.length || !mediaInput.length || !Array.isArray(VENDOR_FILES) || typeof rewriteBare !== 'function') fail('Missing source vendor/media contracts');
  const assetManifest = JSON.parse(await input('data/assets.json'));
  if (assetManifest.version !== 1 || !assetManifest.hash || !assetManifest.stats?.files) fail('Unexpected data/assets.json schema; review manifest verification');
  const refs = references(assetManifest);
  try { for (const ref of references(JSON.parse(await input('data/local-assets.json')))) refs.add(ref); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!(await lstat(join(source, 'public'))).isDirectory()) fail('public must be a regular directory');
  const files = [];
  for (const dir of ['assets', 'fonts', 'vendor']) files.push(...await walk(join(source, 'public'), dir));
  const byPath = new Map(files.map((entry) => [entry.path, entry]));
  for (const ref of refs) if (!byPath.has(ref)) fail(`Manifest references missing/empty resource: ${ref}`);
  for (const { path } of files) {
    if (path.startsWith('assets/') && !(ART_EXTS.has(extname(path)) || AUDIO_EXTS.includes(extname(path)))) fail(`Refusing non-art/code file under assets: ${path}`);
    if (path.startsWith('fonts/') && !['fonts/fonts.css', ...FONT_FILES.map((f) => 'fonts/' + f)].includes(path)) fail(`Unexpected font file: ${path}`);
  }
  for (const name of FONT_FILES) if (!byPath.has('fonts/' + name)) fail(`Missing font: ${name}`);
  const patches = new Map();
  const fontData = await input('public/fonts/fonts.css');
  patches.set('fonts/fonts.css', patchFonts(fontData));
  const vendorNames = new Set();
  for (const [from, name] of VENDOR_FILES) {
    safePath(name); vendorNames.add('vendor/' + name);
    const packageName = from.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1];
    if (!packageName) fail(`Unexpected vendor source: ${from}`);
    const key = 'node_modules/' + packageName;
    const expected = lock.packages?.[key];
    const installed = installedLock.packages?.[key];
    const installedPackage = JSON.parse(await input(key + '/package.json'));
    if (!expected?.integrity || expected.version !== installed?.version || expected.integrity !== installed.integrity || expected.version !== installedPackage.version) {
      fail(`Installed vendor package does not match package-lock: ${packageName}`);
    }
    const original = await input(from);
    const expectedData = VENDOR_REWRITES[name] ? Buffer.from(rewriteBare(original.toString('utf8'), VENDOR_REWRITES[name])) : original;
    const current = await input('public/vendor/' + name);
    if (!current.equals(expectedData)) fail(`public/vendor/${name} differs from the locked installed package; regenerate vendor offline`);
    if (name === 'hooks.module.js') patches.set('vendor/' + name, patchHooks(current));
  }
  for (const { path } of files) if (path.startsWith('vendor/') && !vendorNames.has(path)) fail(`Unexpected vendor/code file: ${path}`);
  if (!patches.has('vendor/hooks.module.js')) fail('Missing hooks vendor patch');
  const media = mediaMappings(files, AUDIO_EXTS, MEDIA_PREFIX);
  if (!media.length) fail('No extensionless audio routes found');
  const manifest = { schemaVersion: 1, release, sourceRevision, appVersion: pkg.version,
    preparerSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    inputs: inputs.sort((a, b) => a.path.localeCompare(b.path, 'en')), patches: [],
    audioExtensions: [...AUDIO_EXTS], mediaPrefix: MEDIA_PREFIX, media, files: [], nginx: [] };
  await mkdir(dirname(output), { recursive: true });
  if (await realpath(dirname(output)) !== dirname(output)) fail('Output parent must not traverse symlinks');
  await mkdir(output); // Never overwrite even an empty existing release directory.
  try {
    await chmod(output, 0o755);
    const directories = new Set([output]);
    const directory = async (path) => {
      if (directories.has(path)) return;
      await directory(dirname(path));
      await mkdir(path);
      await chmod(path, 0o755);
      directories.add(path);
    };
    for (const entry of files.sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
      const dest = join(output, 'releases', release, entry.path);
      await directory(dirname(dest));
      if (patches.has(entry.path)) await writeFile(dest, patches.get(entry.path), { mode: 0o644 });
      else await copyFile(join(source, 'public', entry.path), dest);
      await chmod(dest, 0o644);
      await utimes(dest, entry.mtime, entry.mtime);
      const data = await readFile(dest);
      if (!data.length) fail(`Empty staged file: ${entry.path}`);
      manifest.files.push({ path: entry.path, bytes: data.length, sha256: hash(data) });
      if (patches.has(entry.path)) manifest.patches.push({ path: entry.path,
        beforeSha256: hash(await readInput(source, 'public/' + entry.path)), afterSha256: hash(data) });
    }
    await directory(join(output, 'nginx'));
    for (const [name, contents] of Object.entries(nginxIncludes(manifest))) {
      await writeFile(join(output, 'nginx', name), contents);
      manifest.nginx.push({ path: 'nginx/' + name, bytes: Buffer.byteLength(contents), sha256: hash(contents) });
    }
    await writeFile(join(output, 'SHA256SUMS'), checksumText(manifest));
    await writeFile(join(output, 'release-manifest.json'), json(manifest)); // Last: completed preparation marker, outside the public tree.
    return manifest;
  } catch (e) { await rm(output, { recursive: true, force: true }); throw e; }
}

export async function verifyStaticRelease(output) {
  output = resolve(output);
  if (await realpath(output) !== output) fail('Output must not traverse symlinks');
  const manifest = JSON.parse(await readInput(output, 'release-manifest.json'));
  validateRelease(manifest.release, manifest.sourceRevision);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || !Array.isArray(manifest.audioExtensions) || !Array.isArray(manifest.nginx) || !/^[a-f0-9]{64}$/.test(manifest.preparerSha256)) fail('Unexpected release manifest');
  if (json(mediaMappings(manifest.files, manifest.audioExtensions, manifest.mediaPrefix)) !== json(manifest.media)) fail('Media mappings differ from the staged audio inventory');
  const prefix = `releases/${manifest.release}`;
  const actual = await walk(output, prefix);
  const expected = new Set(manifest.files.map(({ path }) => `${prefix}/${safePath(path)}`));
  if (expected.size !== manifest.files.length || actual.length !== expected.size || actual.some(({ path }) => !expected.has(path))) fail('Staged inventory differs from manifest (extra/missing files)');
  for (const { path, bytes, sha256 } of manifest.files) {
    const data = await readInput(output, `${prefix}/${path}`);
    if (data.length !== bytes || hash(data) !== sha256) fail(`Staged file hash/length mismatch: ${path}`);
  }
  const fontData = await readInput(output, `${prefix}/fonts/fonts.css`);
  if (hash(fontData) !== FONT_CSS_RELATIVE_SHA256) fail('Unexpected staged fonts.css; expected the reviewed relative six-URL output');
  const hooksData = await readInput(output, `${prefix}/vendor/hooks.module.js`);
  const hooks = hooksData.toString('utf8');
  const expectedImport = `from"${GAME_ORIGIN}/vendor/preact.module.js"`;
  if (hooks.split(expectedImport).length !== 2) fail('Staged hooks Preact identity differs from the root game URL');
  const originalHooks = Buffer.from(hooks.replace(expectedImport, 'from"./preact.module.js"'));
  if (!patchHooks(originalHooks).equals(hooksData)) fail('Unexpected staged hooks import');
  if ((await readInput(output, 'SHA256SUMS')).toString('utf8') !== checksumText(manifest)) fail('SHA256SUMS differs from manifest');
  const nginxEntries = [];
  for (const [name, contents] of Object.entries(nginxIncludes(manifest))) {
    if ((await readInput(output, 'nginx/' + name)).toString('utf8') !== contents) fail(`Generated Nginx include differs from manifest: ${name}`);
    nginxEntries.push({ path: 'nginx/' + name, bytes: Buffer.byteLength(contents), sha256: hash(contents) });
  }
  if (json(nginxEntries) !== json(manifest.nginx)) fail('Generated Nginx inventory differs from manifest');
  return manifest;
}

async function cli(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--source', '--out', '--release', '--revision', '--verify'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--') || options[key]) fail('Usage: --release <fixed-id> --revision <40-hex> --out <NEW-directory> [--source <matched-app-directory>] OR --verify <directory>');
    options[key] = args[i + 1];
  }
  if (options['--verify'] && Object.keys(options).length !== 1) fail('--verify must be used alone');
  const result = options['--verify'] ? await verifyStaticRelease(options['--verify']) : await prepareStaticRelease({ source: options['--source'], output: options['--out'], release: options['--release'], sourceRevision: options['--revision'] });
  const stems = result.media.filter(({ requestedExtension }) => !requestedExtension).length;
  console.log(`${options['--verify'] ? 'Verified' : 'Prepared (STAGED, not active)'} ${result.release}: ${result.files.length} files, ${stems} extensionless audio routes (+${result.media.length - stems} explicit-extension aliases), app ${result.appVersion}, source ${result.sourceRevision}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
