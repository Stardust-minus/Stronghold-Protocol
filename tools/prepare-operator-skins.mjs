// Import verified PRTS appearances. Artwork stays ignored; registry entries contain metadata only.
// The source directory is separate from scripts and never used as an interpreter/build working directory.
import { readFile, writeFile, mkdir, lstat, rename, rm, realpath, link } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { OPERATOR_SKINS, skinFor } from '../shared/skins.js';
import { atlasInfo, normalizeAtlas } from './assets/atlas.mjs';
import { parseSkel, normalizeSkelPaths } from './assets/skel.mjs';
import { resolveRoles } from './assets/anim-roles.mjs';
import { contentHash, totalBytes } from './assets/manifest.mjs';
import { skinBattleModels, validateSkinPng } from './assets/skin-battle-source.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pngSize = validateSkinPng;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function skinResourceFiles(skins) {
  const files = new Set();
  const walk = value => {
    if (typeof value === 'string' && value.startsWith('/assets/')) files.add(value.slice('/assets/'.length));
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(skins); return files;
}
export function retainInstalledSkins(current, assetRoot) {
  const skins = {}, files = new Set();
  for (const [id, rec] of Object.entries(current?.skins || {})) {
    if (!skinFor(rec?.charId, id) || !rec.avatar || !rec.portrait || !rec.spine?.front) continue;
    const required = skinResourceFiles({ [id]: rec });
    if (!required.size || [...required].some(rel => !rel.startsWith(`skins/${id}/`) || rel.includes('..') || !existsSync(join(assetRoot, rel)))) continue;
    skins[id] = rec; for (const rel of required) files.add(rel);
  }
  return { skins, files };
}
export function skinManifestMetadata(manifest, assetRoot) {
  const { version, hash, generator, stats, ...body } = manifest;
  const files = skinResourceFiles(body);
  return { ...manifest, hash: contentHash(body), stats: { ...stats, files: files.size, bytes: totalBytes(assetRoot, files), skins: Object.keys(manifest.skins || {}).length } };
}

async function download(url, max = 16 * 1024 * 1024) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !['prts.wiki', 'media.prts.wiki', 'static.prts.wiki', 'torappu.prts.wiki'].includes(u.hostname) || u.username || u.password || u.port || u.hash
    || (u.hostname === 'torappu.prts.wiki' && (u.search || !/^\/assets\/char_spine\/char_[A-Za-z0-9_-]+\/(?:[A-Za-z0-9_\/.-]|%23)+\.(?:json|skel|atlas|png)$/.test(u.pathname)))) throw new Error('Untrusted source');
  const response = await fetch(u, { signal: AbortSignal.timeout(25000), credentials: 'omit', redirect: 'error' });
  if (!response.ok) { const error = new Error(`Source HTTP ${response.status}: ${u.pathname}`); error.status = response.status; throw error; }
  if (Number(response.headers.get('content-length')) > max) throw new Error('Source too large');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > max) throw new Error('Source too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
async function put(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  if (await realpath(dirname(path)) !== resolve(dirname(path))) throw new Error('Refusing artwork through a symlink');
  try {
    const info = await lstat(path); if (!info.isFile()) throw new Error('Refusing non-regular artwork');
    const old = await readFile(path);
    if (!old.equals(bytes)) throw new Error(`Refusing to replace different artwork: ${path}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const temporary = path + '.part-' + randomUUID();
    try {
      await writeFile(temporary, bytes, { flag: 'wx' });
      try { await link(temporary, path); }
      catch (collision) {
        if (collision.code !== 'EEXIST') throw collision;
        if (!(await lstat(path)).isFile() || !(await readFile(path)).equals(bytes)) throw new Error(`Refusing to replace different artwork: ${path}`);
      }
    } finally { await rm(temporary, { force: true }); }
  }
}
function dynamicConfig(skin) {
  const raw = skin.wikiDynamic;
  let config = raw && typeof raw === 'object' ? raw.data || raw[`skin${skin.wikiIndex}`] || raw : null;
  if (typeof raw === 'string') {
    const match = new RegExp(`"skin${skin.wikiIndex}"\\s*:\\s*(\\{[^{}]*\\})`).exec(raw);
    if (match) { try { config = JSON.parse(match[1].replace(/,\s*}/g, '}')); } catch { config = null; } }
  }
  const id = config?.id || (typeof skin.dynIllustId === 'string' ? skin.dynIllustId.replace(/#/g, '__') : null);
  return identifier(id) ? { id, background: !!config?.bg, foreground: !!config?.fg } : null;
}

export function skinCatalogueSource(rows) {
  const entries = JSON.stringify(rows, null, 2)
    .replace(/^(\s*"(?:name|brand)": )(".*")(,?)$/gm, '$1N_($2)$3')
    .replace(/^(\s*"charName": .*)$/gm, '$1 // i18n-ignore: exact Wiki image-title lookup, not UI text');
  return `// Verified skin metadata generated by tools/prepare-operator-skins.mjs. No artwork or resource URLs.\nimport { N_ } from './i18n.js';\nexport const SKIN_CATALOGUE = Object.freeze(${entries}.map(Object.freeze));\n`;
}

export async function prepareSkins({ sourceDir, fetchSources = false, catalogue = OPERATOR_SKINS, manifestPath = join(root, 'data/assets.json'), assetRoot = join(root, 'public/assets'), registryPath = null, modelSource = 'legacy' }) {
  if (!['legacy', 'metadata'].includes(modelSource) || !Array.isArray(catalogue) || catalogue.length > 1000
    || (modelSource === 'metadata' && new Set(catalogue.map(skin => skin?.id)).size !== catalogue.length)) throw new Error('Invalid bounded skin import');
  const source = resolve(sourceDir); await mkdir(source, { recursive: true });
  if (!(await lstat(source)).isDirectory() || await realpath(source) !== source) throw new Error('Unsafe source directory');
  const prior = await readFile(manifestPath), manifest = JSON.parse(prior);
  const registryPrior = registryPath ? await readFile(registryPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; }) : null;
  const skins = {}, accepted = [], inventory = [], failures = [], dynamicFailures = [], preserved = [], models = [];
  let sourceBlocked = false;
  const obtain = async (rel, url, max = 16 * 1024 * 1024) => {
    const path = join(source, rel); let bytes;
    try { const s = await lstat(path); if (!s.isFile() || s.size > max || await realpath(path) !== resolve(path)) throw new Error('Invalid source file'); bytes = await readFile(path); }
    catch (error) { if (error.code !== 'ENOENT' || !fetchSources) throw error; bytes = await download(url, max); await put(path, bytes); }
    inventory.push({ path: rel, source: url, bytes: bytes.length, sha256: sha(bytes) }); return bytes;
  };
  const model = async (skin, side, remote, stem, dynamic = false) => {
    const rel = `skins/${skin.id}/${side}/`;
    const atlas = (await obtain(`${skin.id}/${side}/${stem}.atlas`, remote + stem + '.atlas', 512 * 1024)).toString('utf8');
    const ai = atlasInfo(atlas);
    if (!ai.pages.length || ai.pages.length > 8 || ai.pages.some(p => !/^[A-Za-z0-9_-][A-Za-z0-9_#.-]*\.png$/.test(p) || p.includes('..'))) throw new Error('Unsafe atlas pages');
    const pageNames = new Map(ai.pages.map(p => [p, p.replace(/#/g, '_')]));
    if (new Set(pageNames.values()).size !== ai.pages.length) throw new Error('Atlas page name collision');
    const sizes = new Map(), textureFiles = []; let textureBytes = 0;
    for (const page of ai.pages) {
      const bytes = await obtain(`${skin.id}/${side}/${page}`, remote + encodeURIComponent(page));
      textureBytes += bytes.length; if (textureBytes > 64 * 1024 * 1024) throw new Error('Artwork texture budget exceeded');
      sizes.set(page, pngSize(bytes)); textureFiles.push({ path: join(assetRoot, rel, pageNames.get(page)), bytes });
    }
    const norm = normalizeAtlas(atlas, { pageSize: p => sizes.get(p), pma: false, renamePage: p => pageNames.get(p) });
    const bytes = await obtain(`${skin.id}/${side}/${stem}.skel`, remote + stem + '.skel', 8 * 1024 * 1024);
    const display = normalizeSkelPaths(bytes);
    const displayStem = display.removed.length ? stem + '.display' : stem;
    const skel = parseSkel(display.bytes, atlasInfo(norm.text).regions);
    if (!skel.version.startsWith('3.8.') || skel.missingRegions.length || !skel.animations.length) throw new Error('Incompatible skin skeleton');
    if (!bytes.subarray(display.sourceHeaderEnd).equals(Buffer.from(display.bytes.subarray(display.displayHeaderEnd)))
      || JSON.stringify(parseSkel(bytes, atlasInfo(norm.text).regions)) !== JSON.stringify(skel)) throw new Error('Display normalization changed skeleton data');
    for (const texture of textureFiles) await put(texture.path, texture.bytes);
    await put(join(assetRoot, rel, stem + '.atlas'), Buffer.from(norm.text)); await put(join(assetRoot, rel, displayStem + '.skel'), display.bytes);
    models.push({ id: skin.id, side, version: skel.version, sourceSha256: sha(bytes), displaySha256: sha(display.bytes),
      editorRootsRemoved: display.removed, skeletonBodyPreserved: true, animationNames: skel.animations, missingRegions: skel.missingRegions, atlasPages: ai.pages });
    // Skin hit timings are never emitted into simulator inputs; all these entries are display-only.
    return { skel: `/assets/${rel}${displayStem}.skel`, atlas: `/assets/${rel}${stem}.atlas`, textures: ai.pages.map(p => `/assets/${rel}${pageNames.get(p)}`), pma: false,
      anims: dynamic ? { idle: skel.animations.find(name => /^idle$/i.test(name)) || skel.animations[0] } : resolveRoles(skel.animations, { skillIndices: [0, 1, 2], durations: skel.durations }),
      animations: skel.durations, bounds: skel.bounds };
  };
  const prepareOne = async skin => {
    try {
      if (!identifier(skin.id) || !identifier(skin.charId) || !manifest.chars?.[skin.charId] || !Number.isInteger(skin.wikiIndex) || skin.wikiIndex < 1 || skin.wikiIndex > 99 || typeof skin.name !== 'string' || typeof skin.charName !== 'string' || !skin.charName.trim()) throw new Error('Incomplete metadata mapping');
      if (modelSource === 'metadata' && Object.hasOwn(manifest.skins || {}, skin.id)) {
        if (manifest.skins[skin.id].charId !== skin.charId || manifest.skins[skin.id].name !== skin.name) throw new Error('Conflicting installed skin identity');
        preserved.push(skin.id); return;
      }
      const battle = modelSource === 'metadata' ? skinBattleModels(skin, JSON.parse((await obtain(`${skin.id}/model-meta.json`,
        `https://torappu.prts.wiki/assets/char_spine/${skin.charId}/meta.json`, 256 * 1024)).toString('utf8'))) : null;
      const charName = skin.charName;
      const types = ['头像', '半身像', '立绘'], titles = types.map(type => `文件:${type} ${charName} skin${skin.wikiIndex}.png`);
      const api = new URL('https://prts.wiki/api.php');
      for (const [k, v] of Object.entries({ action: 'query', format: 'json', prop: 'imageinfo', titles: titles.join('|'), iiprop: 'url|size|sha1' })) api.searchParams.set(k, v);
      const meta = JSON.parse((await obtain(`${skin.id}/imageinfo.json`, api.href, 256 * 1024)).toString('utf8'));
      const rec = { charId: skin.charId, name: skin.name, brand: skin.brand, spine: {}, dynamicDeclared: !!skin.dynIllustId };
      for (const [i, field] of ['avatar', 'portrait', 'illustration'].entries()) {
        const info = Object.values(meta.query?.pages || {}).find(page => page.title === titles[i])?.imageinfo?.[0];
        if (!info?.url || !Number.isSafeInteger(info.size) || info.size > 16 * 1024 * 1024) throw new Error(`Missing picture: ${titles[i]}`);
        const bytes = await obtain(`${skin.id}/${field}.png`, info.url);
        if (bytes.length !== info.size || createHash('sha1').update(bytes).digest('hex') !== info.sha1) throw new Error('Wiki picture integrity mismatch');
        pngSize(bytes); await put(join(assetRoot, 'skins', skin.id, `${field}.png`), bytes);
        rec[field] = `/assets/skins/${skin.id}/${field}.png`;
      }
      if (battle) {
        for (const [side, declaration] of Object.entries(battle.models)) rec.spine[side] = await model(skin, side, declaration.remote, declaration.stem);
        if (!battle.models.back) rec.backUnavailable = true;
        if (battle.kind === 'unified') rec.battleModelKind = 'unified'; // One declared battle model, not independent Front/Back sources.
      } else for (const side of ['front', 'back']) {
        const folder = side === 'back' ? `back_${skin.id}` : skin.id;
        const stem = skin[`${side}Stem`] || `skin/${skin.charId}/${folder}/${skin.id}`;
        if (typeof stem !== 'string' || !stem.startsWith(`skin/${skin.charId}/`) || stem.includes('..') || !/^[A-Za-z0-9_\/-]+$/.test(stem)) throw new Error('Invalid bound model source');
        const filename = stem.split('/').at(-1), remote = `https://static.prts.wiki/spine38/${stem.slice(0, stem.lastIndexOf('/') + 1)}`;
        try { rec.spine[side] = await model(skin, side, remote, filename); }
        catch (error) {
          if (side !== 'back' || error.status !== 404) throw error;
          rec.backUnavailable = true; // Use this appearance's Front in every direction, never silently the default skin.
        }
      }
      const dynamic = dynamicConfig(skin);
      if (dynamic && modelSource === 'metadata') dynamicFailures.push({ id: skin.id, reason: 'Dynamic illustration not prepared by battle-only metadata import', notAttempted: true });
      if (dynamic && modelSource === 'legacy') {
        rec.dynamicDeclared = true;
        try {
          rec.dynamic = await model(skin, 'dynamic', `https://static.prts.wiki/spine38/dyn/${dynamic.id}/${dynamic.id}/`, dynamic.id, true);
          for (const [flag, suffix] of [['background', 'bg'], ['foreground', 'fg']]) if (dynamic[flag]) {
            const url = `https://static.prts.wiki/spine38/dynbg/${dynamic.id}/${dynamic.id}_${suffix}.png`;
            const bytes = await obtain(`${skin.id}/dynamic/${suffix}.png`, url); pngSize(bytes);
            await put(join(assetRoot, 'skins', skin.id, 'dynamic', `${suffix}.png`), bytes); rec.dynamic[flag] = `/assets/skins/${skin.id}/dynamic/${suffix}.png`;
          }
        } catch (error) { if ([403, 429].includes(error.status)) sourceBlocked = true;
          delete rec.dynamic; dynamicFailures.push({ id: skin.id, reason: error.message }); }
      }
      skins[skin.id] = rec;
      accepted.push({ id: skin.id, charId: skin.charId, name: skin.name, brand: skin.brand, officialId: skin.officialId, wikiIndex: skin.wikiIndex, charName });
      console.log(`[skins] ready ${skin.charId} / ${skin.name}${rec.dynamic ? ' + dynamic illustration' : ''}`);
    } catch (error) { if ([403, 429].includes(error.status)) sourceBlocked = true;
      failures.push({ id: skin.id, charId: skin.charId, name: skin.name, reason: error.message }); console.log(`[skins] unavailable ${skin.charId} / ${skin.name}: ${error.message}`); }
  };
  // At most two public-source imports in flight. No retries, no whole-site crawl or runtime hotlink.
  let index = 0;
  const run = async () => { while (index < catalogue.length && !sourceBlocked) { const skin = catalogue[index++]; await prepareOne(skin); await new Promise(resolve => setTimeout(resolve, 250)); } };
  await Promise.all([run(), run()]);
  manifest.skins = { ...(manifest.skins || {}), ...skins };
  const report = { schemaVersion: 1, modelSource, baseManifestSHA256: sha(prior), accepted, preserved, failures, dynamicFailures, models, files: inventory };
  const reportPath = join(source, `inventory-${Date.now()}-${randomUUID()}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  if (modelSource === 'metadata' && sourceBlocked) throw new Error('Refusing to publish a source-blocked skin import');
  if (modelSource === 'metadata' && failures.length) throw new Error('Refusing to publish an incomplete metadata skin import');
  let registryBytes = null;
  if (registryPath && accepted.length) {
    const registry = new Map(OPERATOR_SKINS.map(s => [s.id, s])); for (const skin of accepted.sort((a, b) => a.id.localeCompare(b.id))) registry.set(skin.id, skin);
    registryBytes = Buffer.from(skinCatalogueSource([...registry.values()]));
  }
  const manifestBytes = Buffer.from(JSON.stringify(skinManifestMetadata(manifest, assetRoot)) + '\n');
  const currentRegistry = registryPath ? await readFile(registryPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; }) : null;
  if (!(await readFile(manifestPath)).equals(prior) || (registryPath && (registryPrior === null ? currentRegistry !== null : !currentRegistry?.equals(registryPrior)))) throw new Error('Skin import baseline changed');
  const pending = [];
  try {
    for (const [path, bytes] of [[registryPath, registryBytes], [manifestPath, manifestBytes]]) if (path && bytes) {
      const temporary = path + '.part-' + randomUUID(); pending.push({ path, temporary }); await writeFile(temporary, bytes, { flag: 'wx' });
    }
    const checkedRegistry = registryPath ? await readFile(registryPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; }) : null;
    if (!(await readFile(manifestPath)).equals(prior) || (registryPath && (registryPrior === null ? checkedRegistry !== null : !checkedRegistry?.equals(registryPrior)))) throw new Error('Skin import baseline changed');
    for (const { path, temporary } of pending) await rename(temporary, path);
  } finally { for (const { temporary } of pending) await rm(temporary, { force: true }); }
  return { skins: Object.keys(skins).length, operators: new Set(accepted.map(s => s.charId)).size, dynamicIllustrations: Object.values(skins).filter(s => s.dynamic).length, failures: failures.length,
    preserved: preserved.length, sourceBlocked, unprocessed: catalogue.length - index, reportPath,
    sourceFiles: inventory.length, sourceBytes: inventory.reduce((n, f) => n + f.bytes, 0) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = flag => { const i = process.argv.indexOf(flag); return i < 0 ? null : process.argv[i + 1]; };
  if (!value('--source')) throw new Error('Usage: prepare-operator-skins.mjs --source <isolated-source-dir> [--download] [--model-source legacy|metadata] [--catalogue <metadata.json>] [--registry <new-shared-catalogue.js>]');
  const metadata = value('--catalogue') ? JSON.parse(await readFile(value('--catalogue'), 'utf8')) : null;
  const catalogue = metadata ? (Array.isArray(metadata) ? metadata : metadata.skins || metadata.entries || metadata.catalogue) : OPERATOR_SKINS;
  if (!Array.isArray(catalogue) || catalogue.length > 1000) throw new Error('Invalid bounded skin catalogue');
  console.log(JSON.stringify(await prepareSkins({ sourceDir: value('--source'), fetchSources: process.argv.includes('--download'), catalogue, registryPath: value('--registry'), modelSource: value('--model-source') || 'legacy' })));
}
