// Offline private business-code staging only: no network, activation, proxy cache or public assets.
// Prepare: --source <fixed-app-export> --revision <40-hex> --out <NEW-directory>
//          [--namespace beta|prod] [--repo <read-only-object-repository>]
// Verify:  --verify <directory> [--repo <repository>] [--namespace beta|prod] [--revision <40-hex>]
// The output parent must already exist. The main vhost MUST define the named fallback described
// in the generated include, using the SAME namespace/revision upstream and continuing the gate.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(TOOL), '../../..');
const TOOL_PATH = 'deploy/stardust/tools/prepare-localcode-release.mjs';
const ROOTS = ['public/js', 'public/css'];
const SITES = Object.freeze({ beta: 'ark-proto-beta.stardust.matce.cn', prod: 'ark-proto.stardust.matce.cn' });
const hash = (data) => createHash('sha256').update(data).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const fail = (message) => { throw new Error(message); };
const sorted = (values) => [...values].sort();

function validateNamespace(namespace) {
  if (typeof namespace !== 'string' || !Object.hasOwn(SITES, namespace)) fail('Namespace must be beta or prod');
}
function validateRevision(revision) {
  if (typeof revision !== 'string' || !/^[a-f0-9]{40}$/.test(revision)) fail('Revision must be a full lowercase 40-hex commit');
}
function safePath(path) {
  // ASCII only; no dot segments/files, escapes, query fragments, nginx variables/quotes/blocks.
  if (typeof path !== 'string' || !path || path.split('/').some((part) =>
    !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part) || part.includes('..') || part.endsWith('.'))) {
    fail(`Unsafe localcode path: ${JSON.stringify(path)}`);
  }
  return path;
}
function absolute(path, label) {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.split(/[\\/]/).includes('..')) fail(`${label} requires a path without traversal`);
  return resolve(path);
}
async function directory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`Expected a regular directory, not a link: ${path}`);
}
async function rootDirectory(path) {
  await directory(path);
  if (await realpath(path) !== path) fail(`Directory must not traverse symlinks: ${path}`);
}
function regular(stat, path) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail(`Expected a regular file without soft/hard links: ${path}`);
}
async function readInput(root, rel) {
  safePath(rel);
  const path = join(root, rel);
  await rootDirectory(root);
  for (let parent = dirname(path); parent !== root; parent = dirname(parent)) {
    if (!parent.startsWith(root + sep)) fail(`Input escapes root: ${rel}`);
    await directory(parent);
  }
  const before = await lstat(path);
  regular(before, path);
  // Do not follow a last-component link or block on a substituted FIFO. Copy this checked
  // byte snapshot, never reopen the source later with copyFile after the git comparison.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    regular(opened, path);
    if (opened.dev !== before.dev || opened.ino !== before.ino) fail(`File changed while reading: ${rel}`);
    const data = await file.readFile();
    const after = await file.stat();
    regular(after, path);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || data.length !== after.size) {
      fail(`File changed while reading: ${rel}`);
    }
    return data;
  } finally { await file.close(); }
}
async function inventory(root, rel = '') {
  await directory(join(root, rel));
  const files = []; const directories = [];
  for (const name of sorted(await readdir(join(root, rel)))) {
    const path = safePath(rel ? `${rel}/${name}` : name);
    const stat = await lstat(join(root, path));
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      directories.push(path);
      const child = await inventory(root, path);
      files.push(...child.files); directories.push(...child.directories);
    } else { regular(stat, path); files.push(path); }
  }
  return { files: sorted(files), directories: sorted(directories) };
}
const isCode = (path) => path.startsWith('public/js/') && path.endsWith('.js') || path.startsWith('public/css/') && path.endsWith('.css');

function git(repo, args) {
  // No caller GIT_DIR/WORK_TREE/config injection, replacements, index locks or promisor fetch.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  const result = spawnSync('git', ['--no-optional-locks', '--no-replace-objects', '-C', repo,
    '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=never', ...args], { env, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`Read-only git object verification failed (${args[0]}): ${result.error?.message || result.stderr?.toString().trim()}`);
  return result.stdout;
}
async function commitInventory(repo, revision) {
  validateRevision(revision);
  repo = absolute(repo, 'Repository');
  await rootDirectory(repo);
  if (git(repo, ['rev-parse', '--show-object-format']).toString().trim() !== 'sha1') fail('Repository must use 40-hex SHA-1 git objects');
  if (git(repo, ['rev-parse', '--verify', `${revision}^{commit}`]).toString().trim() !== revision) fail('Revision must name the commit itself, not a tag or replacement');
  const tree = git(repo, ['rev-parse', '--verify', `${revision}^{tree}`]).toString().trim();
  const entries = [];
  const listing = git(repo, ['ls-tree', '-r', '-z', '--full-tree', revision, '--', ...ROOTS]);
  for (const record of listing.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(record);
    if (!match) fail('Unexpected git tree entry');
    const [, mode, type, gitBlob, sourcePath] = match;
    safePath(sourcePath);
    if (!ROOTS.some((root) => sourcePath.startsWith(root + '/')) || type !== 'blob' || !['100644', '100755'].includes(mode)) {
      fail(`Tracked entry is not a regular code file: ${sourcePath}`);
    }
    if (isCode(sourcePath)) entries.push({ path: sourcePath.slice('public/'.length), sourcePath, gitBlob });
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!entries.some(({ path }) => path.startsWith('js/')) || !entries.some(({ path }) => path.startsWith('css/'))) fail('Commit must contain tracked public JS and CSS');
  const data = new Map(); const files = [];
  for (const entry of entries) {
    const bytes = git(repo, ['cat-file', 'blob', entry.gitBlob]);
    // Verify the returned object ID ourselves as well as comparing the exact source bytes.
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (blob !== entry.gitBlob) fail(`Git blob content does not match its object ID: ${entry.sourcePath}`);
    data.set(entry.path, bytes);
    files.push({ ...entry, bytes: bytes.length, sha256: hash(bytes) });
  }
  return { source: { fullref: revision, tree }, files, data };
}

export function localcodeInclude({ namespace, source, files }) {
  validateNamespace(namespace); validateRevision(source?.fullref);
  const fallback = `@ark_${namespace}_localcode_fallback`;
  const prefix = `/www/sites/${SITES[namespace]}/localcode/${source.fullref}`;
  let text = `# STAGED PRIVATE localcode; namespace=${namespace}; source=${source.fullref}. NOT active.\n`;
  text += `# Include ONLY in the ${SITES[namespace]} server; do not publish this inventory.\n`;
  text += `# Main vhost MUST define location ${fallback} with auth_request /_gate/check,\n`;
  text += `# private, no-store always, nosniff, GET/HEAD only, no public CORS/cache, and proxy_pass\n`;
  text += `# to the SAME ${namespace} upstream at source ${source.fullref}; never another namespace/revision.\n`;
  text += '# Preserve the original URI/query for that upstream. No query parameter selects a release.\n';
  const seen = new Set();
  for (const { path } of files) {
    safePath(path);
    if (!isCode('public/' + path) || seen.has(path)) fail(`Invalid/duplicate localcode URL: ${path}`);
    seen.add(path);
    const mime = path.startsWith('js/') ? 'application/javascript' : 'text/css';
    text += `\nlocation = /${path} {\n`;
    text += '    auth_request /_gate/check;\n';
    text += '    if ($request_method !~ ^(GET|HEAD)$) { return 405; }\n';
    text += `    alias ${prefix}/${path};\n`;
    // Missing-file fallback happens in the static content phase, AFTER the access gate.
    // No rewrite/try_files URI fallback that could change namespaces or bypass the gate.
    text += `    error_page 404 = ${fallback};\n`;
    text += '    disable_symlinks on;\n    types { }\n';
    text += `    default_type ${mime};\n`;
    text += '    expires off;\n    etag on;\n';
    text += '    add_header Cache-Control "private, no-store" always;\n';
    text += '    add_header X-Content-Type-Options "nosniff" always;\n';
    text += '    add_header X-Ark-Code-Source "edge" always;\n}\n';
  }
  return text;
}
async function releaseMetadata(namespace, commit) {
  const manifest = { schemaVersion: 1, namespace, source: commit.source,
    preparer: { path: TOOL_PATH, sha256: hash(await readInput(dirname(TOOL), basename(TOOL))) },
    files: commit.files, nginx: [] };
  const contents = localcodeInclude(manifest);
  manifest.nginx.push({ path: `nginx/localcode-${namespace}.conf`, bytes: Buffer.byteLength(contents), sha256: hash(contents) });
  return { manifest, contents };
}
function outputFiles(manifest) {
  return [...manifest.files.map((file) => ({ ...file, path: `localcode/${manifest.source.fullref}/${file.path}` })), ...manifest.nginx];
}
function checksums(manifest) {
  return [...outputFiles(manifest), { path: 'release-manifest.json', sha256: hash(json(manifest)) }]
    .map(({ path, sha256 }) => `${sha256}  ${path}\n`).join('');
}
function expectedDirectories(manifest) {
  const dirs = new Set(['localcode', `localcode/${manifest.source.fullref}`, `localcode/${manifest.source.fullref}/js`, `localcode/${manifest.source.fullref}/css`, 'nginx']);
  for (const { path } of outputFiles(manifest)) {
    for (let dir = dirname(path); dir !== '.'; dir = dirname(dir)) dirs.add(dir);
  }
  return sorted(dirs);
}

/** Only matched code blobs are proven. This is NOT proof of the rest of the app/image export. */
export async function prepareLocalcodeRelease({ namespace = 'beta', source, revision, repo = REPO, output } = {}) {
  validateNamespace(namespace); validateRevision(revision);
  source = absolute(source, 'Source app export'); output = absolute(output, 'New output');
  await rootDirectory(source);
  await rootDirectory(dirname(output));
  const distance = relative(source, output);
  if (distance !== '..' && !distance.startsWith('..' + sep)) fail('Output must be outside the source app export');
  try { await lstat(output); fail('Output must be a NEW nonexistent directory (no overwrite/links)'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const commit = await commitInventory(repo, revision);
  await directory(join(source, 'public'));
  const actual = [];
  for (const root of ROOTS) actual.push(...(await inventory(source, root)).files.filter(isCode));
  if (json(sorted(actual)) !== json(sorted(commit.files.map(({ sourcePath }) => sourcePath)))) fail('Source code inventory differs from tracked commit (extra/untracked/missing files)');
  const snapshots = new Map();
  for (const { path, sourcePath } of commit.files) {
    const data = await readInput(source, sourcePath);
    if (!data.equals(commit.data.get(path))) fail(`Source bytes differ from tracked git blob: ${sourcePath}`);
    snapshots.set(path, data);
  }
  const { manifest, contents } = await releaseMetadata(namespace, commit);
  await mkdir(output, { mode: 0o755 }); // Atomic claim: even an empty pre-existing directory is refused.
  try {
    await chmod(output, 0o755);
    for (const dir of expectedDirectories(manifest).sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0))) {
      await mkdir(join(output, dir), { mode: 0o755 }); await chmod(join(output, dir), 0o755);
    }
    const put = async (path, data) => {
      await writeFile(join(output, path), data, { flag: 'wx', mode: 0o644 });
      await chmod(join(output, path), 0o644);
    };
    for (const { path } of manifest.files) await put(`localcode/${revision}/${path}`, snapshots.get(path));
    await put(manifest.nginx[0].path, contents);
    await put('SHA256SUMS', checksums(manifest));
    await put('release-manifest.json', json(manifest)); // Last: completed staging marker, outside code URLs.
    return manifest;
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
}

/** Verification needs local trusted git objects; hashes supplied by the manifest are not proof. */
export async function verifyLocalcodeRelease(output, { repo = REPO, namespace, revision } = {}) {
  output = absolute(output, 'Verify output');
  await rootDirectory(output);
  const manifestData = await readInput(output, 'release-manifest.json');
  const manifest = JSON.parse(manifestData);
  if (!manifest || manifest.schemaVersion !== 1) fail('Unexpected localcode manifest schema');
  validateNamespace(manifest.namespace); validateRevision(manifest.source?.fullref);
  if (namespace !== undefined) { validateNamespace(namespace); if (namespace !== manifest.namespace) fail('Manifest namespace differs from requested namespace'); }
  if (revision !== undefined) { validateRevision(revision); if (revision !== manifest.source.fullref) fail('Manifest source fullref differs from requested revision'); }
  const commit = await commitInventory(repo, manifest.source.fullref);
  const expected = await releaseMetadata(manifest.namespace, commit);
  // Reconstruct ALL fields from trusted git and this tool. Also rejects duplicate JSON keys,
  // extra/source fields, forged blob IDs/hashes/lengths and changed tool/include provenance.
  if (!manifestData.equals(Buffer.from(json(expected.manifest)))) fail('Manifest hash/source/tool/include fields differ from verified git inventory');
  const actual = await inventory(output);
  const paths = sorted([...outputFiles(manifest).map(({ path }) => path), 'release-manifest.json', 'SHA256SUMS']);
  if (json(actual.files) !== json(paths) || json(actual.directories) !== json(expectedDirectories(manifest))) fail('Output inventory differs (extra/missing files or directories)');
  for (const { path } of manifest.files) {
    const data = await readInput(output, `localcode/${manifest.source.fullref}/${path}`);
    if (!data.equals(commit.data.get(path))) fail(`Staged hash/source bytes differ from tracked git blob: ${path}`);
  }
  if (!(await readInput(output, manifest.nginx[0].path)).equals(Buffer.from(expected.contents))) fail('Generated include hash/content differs');
  if (!(await readInput(output, 'SHA256SUMS')).equals(Buffer.from(checksums(manifest)))) fail('SHA256SUMS differs from verified inventory');
  return manifest;
}

const USAGE = 'Usage: --source <fixed-app-export> --revision <40-hex> --out <NEW-directory> [--namespace beta|prod] [--repo <repository>] OR --verify <directory> [--repo <repository>] [--namespace beta|prod] [--revision <40-hex>]';
async function cli(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    if (!['--namespace', '--source', '--revision', '--repo', '--out', '--verify'].includes(key) || !value || value.startsWith('--') || Object.hasOwn(options, key)) fail(USAGE);
    options[key] = value;
  }
  if (options['--verify'] && (options['--source'] || options['--out'])) fail('--verify cannot be combined with --source or --out');
  const common = { namespace: options['--namespace'], revision: options['--revision'], repo: options['--repo'] };
  const result = options['--verify'] ? await verifyLocalcodeRelease(options['--verify'], common)
    : await prepareLocalcodeRelease({ ...common, source: options['--source'], output: options['--out'] });
  console.log(`${options['--verify'] ? 'Verified' : 'Prepared (STAGED, NOT ACTIVE)'} private ${result.namespace} localcode ${result.source.fullref}: ${result.files.length} exact JS/CSS URLs. Fallback must be defined by the matched main vhost.`);
}
if (process.argv[1] && resolve(process.argv[1]) === TOOL) {
  cli(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
