import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { localcodeInclude, prepareLocalcodeRelease, verifyLocalcodeRelease } from './prepare-localcode-release.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TOOL = join(REPO, 'deploy/stardust/tools/prepare-localcode-release.mjs');
const BASELINE = '9ddbd02f50c06be69a1e4e7b41acc3f34487f2fd';
const hash = (data) => createHash('sha256').update(data).digest('hex');
const json = (data) => JSON.stringify(data, null, 2) + '\n';
async function put(path, contents) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents); }
async function absent(path) { await assert.rejects(lstat(path), { code: 'ENOENT' }); }
async function temporary(t) {
  const base = await mkdtemp(join(tmpdir(), 'ark-private-localcode-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}
function git(repo, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_AUTHOR_DATE: '2026-10-06T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-06T00:00:00Z' });
  const result = spawnSync('git', ['--no-optional-locks', '--no-replace-objects', '-C', repo,
    '-c', 'protocol.allow=never', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Localcode test fixture', '-c', 'user.email=fixture@example.invalid', ...args], { env, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString() || String(result.error));
  return result.stdout;
}
async function exportCode(repo, revision, source) {
  await mkdir(join(source, 'public/js'), { recursive: true });
  await mkdir(join(source, 'public/css'), { recursive: true });
  const rows = git(repo, ['ls-tree', '-r', '-z', revision, '--', 'public/js', 'public/css']).toString().split('\0').filter(Boolean);
  const files = [];
  for (const row of rows) {
    const [, , , blob, path] = /^(\d{6}) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(row);
    if (!(path.startsWith('public/js/') && path.endsWith('.js') || path.startsWith('public/css/') && path.endsWith('.css'))) continue;
    await put(join(source, path), git(repo, ['cat-file', 'blob', blob]));
    files.push(path.slice('public/'.length));
  }
  return files.sort();
}
async function fixture(t) {
  const base = await temporary(t);
  const repo = join(base, 'owned-git-fixture');
  await mkdir(repo);
  // All git writes below are confined to this newly created, explicitly owned temporary repo.
  git(repo, ['init', '--initial-branch=localcode-fixture']);
  await put(join(repo, 'public/js/main.js'), 'export const business = "private";\n');
  await put(join(repo, 'public/js/data.js'), 'export const loader = "/data/chess.json";\n');
  await put(join(repo, 'public/js/ui/panel.js'), 'export const panel = 1;\n');
  await put(join(repo, 'public/css/theme.css'), 'body { color: #123456; }\n');
  await put(join(repo, 'public/css/screens/game.css'), '.game { display: grid; }\n');
  git(repo, ['add', '--', 'public/js', 'public/css']);
  git(repo, ['commit', '-m', 'Own temporary code fixture']);
  const revision = git(repo, ['rev-parse', 'HEAD']).toString().trim();
  const source = join(base, 'app'); const output = join(base, 'prepared');
  await exportCode(repo, revision, source);
  // Excluded routes never get copied, parsed, imported, adapted or added to nginx locations.
  for (const path of ['public/index.html', 'shared/private.js', 'server/sim/private.js', 'data/private.json',
    'data.js', 'client-build', 'api/private.js', 'ws', 'auth/private.js', 'public/vendor/private.js', 'public/assets/private.png',
    'public/js/main.js.map', 'public/css/notes.txt']) await put(join(source, path), 'excluded, not executable');
  await put(join(source, 'package.json'), 'deliberately not JSON: this tool is NOT an app build');
  return { base, repo, source, output, revision };
}
function cli(args, options = {}) { return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', ...options }); }
async function manifestEdit(f, edit) {
  const path = join(f.output, 'release-manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  edit(manifest);
  await put(path, json(manifest));
}

// Mandatory real-repository test: fixed 9dd objects are only read, never exported via working tree.
test('real fixed 9dd commit: single-blob read export, default repo verification and reproducible output', async (t) => {
  const base = await temporary(t);
  const source = join(base, 'app'); const output = join(base, 'prepared');
  const paths = await exportCode(REPO, BASELINE, source);
  assert.equal(paths.length, 101);
  const result = await prepareLocalcodeRelease({ source, revision: BASELINE, output });
  assert.equal(result.namespace, 'beta'); assert.equal(result.source.fullref, BASELINE);
  assert.deepEqual(result.files.map(({ path }) => path), paths);
  assert.equal(result.preparer.sha256, hash(await readFile(TOOL)));
  assert.deepEqual(await verifyLocalcodeRelease(output, { revision: BASELINE, namespace: 'beta' }), result);
  const output2 = join(base, 'prepared2');
  assert.deepEqual(await prepareLocalcodeRelease({ source, revision: BASELINE, output: output2 }), result);
  assert.equal(await readFile(join(output, 'SHA256SUMS'), 'utf8'), await readFile(join(output2, 'SHA256SUMS'), 'utf8'));
  const child = cli(['--verify', output, '--revision', BASELINE, '--namespace', 'beta']);
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /Verified private beta.*101 exact/);
  t.diagnostic(`Fixed real-repo baseline ${BASELINE}; test runtime ${process.version}; no Nginx/Docker/network/activation`);
});

test('only tracked JS/CSS snapshots are staged with exact MIME/gate/fallback and private metadata', async (t) => {
  const f = await fixture(t);
  const manifest = await prepareLocalcodeRelease(f);
  assert.equal(manifest.files.length, 5);
  assert.deepEqual(await verifyLocalcodeRelease(f.output, { repo: f.repo }), manifest);
  assert.deepEqual((await readdir(f.output)).sort(), ['SHA256SUMS', 'localcode', 'nginx', 'release-manifest.json']);
  const include = await readFile(join(f.output, 'nginx/localcode-beta.conf'), 'utf8');
  assert.equal(manifest.nginx[0].sha256, hash(include));
  assert.equal(manifest.nginx[0].bytes, Buffer.byteLength(include));
  const blocks = [...include.matchAll(/location = (\/[^\s]+) \{\n([\s\S]*?)\n\}/g)];
  assert.equal(blocks.length, manifest.files.length);
  assert.deepEqual(blocks.map((m) => m[1]), manifest.files.map(({ path }) => '/' + path));
  for (const [full, url, body] of blocks) {
    assert.match(body, /auth_request \/_gate\/check;/);
    assert.match(body, /if \(\$request_method !~ \^\(GET\|HEAD\)\$\) \{ return 405; \}/);
    assert.match(body, /error_page 404 = @ark_beta_localcode_fallback;/);
    assert.ok(body.includes(`alias /www/sites/ark-proto-beta.stardust.matce.cn/localcode/${f.revision}${url};`));
    assert.match(body, /types \{ \}/);
    assert.ok(body.includes(`default_type ${url.startsWith('/js/') ? 'application/javascript' : 'text/css'};`));
    assert.match(body, /add_header Cache-Control "private, no-store" always;/);
    assert.match(body, /add_header X-Content-Type-Options "nosniff" always;/);
    assert.match(body, /add_header X-Ark-Code-Source "edge" always;/);
    assert.match(body, /disable_symlinks on;/); assert.match(body, /expires off;/); assert.match(body, /etag on;/);
    assert.doesNotMatch(full, /auth_request off|Access-Control-Allow-Origin|proxy_cache|proxy_pass|try_files|rewrite|\$arg_|\$v\b|max_ranges|if_modified_since|return 200/);
  }
  assert.match(include, /Main vhost MUST define location @ark_beta_localcode_fallback with auth_request/);
  assert.match(include, new RegExp(`SAME beta upstream at source ${f.revision}`));
  assert.doesNotMatch(include, /^location @|^location [~^]|\/shared\/|\/sim\/|\/data\/|location = \/data\.js|\/client-build|\/api\/|\/auth\/|\/vendor\/|\/assets\//m);
  assert.ok(manifest.files.some(({ path }) => path === 'js/data.js'), 'the loader /js/data.js is code, unlike the generated /data.js shim');
  for (const entry of manifest.files) {
    const staged = join(f.output, 'localcode', f.revision, entry.path);
    const bytes = await readFile(staged);
    assert.deepEqual(bytes, await readFile(join(f.source, entry.sourcePath)));
    assert.equal(entry.bytes, bytes.length); assert.equal(entry.sha256, hash(bytes));
    assert.equal((await lstat(staged)).mode & 0o777, 0o644);
    assert.equal((await lstat(staged)).nlink, 1);
  }
  assert.match(await readFile(join(f.output, 'SHA256SUMS'), 'utf8'), /release-manifest\.json\n$/);
});

test('prod has separate aliases/include/fallback; verification can pin namespace and source', async (t) => {
  const f = await fixture(t);
  const result = await prepareLocalcodeRelease({ ...f, namespace: 'prod' });
  const include = await readFile(join(f.output, 'nginx/localcode-prod.conf'), 'utf8');
  assert.match(include, /\/www\/sites\/ark-proto\.stardust\.matce\.cn\/localcode\//);
  assert.match(include, /error_page 404 = @ark_prod_localcode_fallback;/);
  assert.doesNotMatch(include, /ark-proto-beta|@ark_beta|SAME beta/);
  assert.equal(result.namespace, 'prod');
  assert.deepEqual(await verifyLocalcodeRelease(f.output, { repo: f.repo, namespace: 'prod', revision: f.revision }), result);
  await assert.rejects(verifyLocalcodeRelease(f.output, { repo: f.repo, namespace: 'beta' }), /namespace differs/);
  await assert.rejects(verifyLocalcodeRelease(f.output, { repo: f.repo, revision: '1'.repeat(40) }), /source fullref differs/);
});

test('changed source bytes and extra/missing tracked code are not proven by a supplied revision', async (t) => {
  for (const change of ['bytes', 'extra-js', 'extra-css', 'missing']) {
    const f = await fixture(t);
    if (change === 'bytes') await put(join(f.source, 'public/js/main.js'), 'export const business = "forged";');
    if (change === 'extra-js') await put(join(f.source, 'public/js/ui/untracked.js'), 'export default 1;');
    if (change === 'extra-css') await put(join(f.source, 'public/css/untracked.css'), 'body {}');
    if (change === 'missing') await rm(join(f.source, 'public/js/main.js'));
    await assert.rejects(prepareLocalcodeRelease(f), /Source bytes differ|Source code inventory differs/);
    await absent(f.output);
  }
});

test('only a real full commit is accepted, not abbreviations, refs, fake objects, trees, blobs or tags', async (t) => {
  const f = await fixture(t);
  const tree = git(f.repo, ['rev-parse', `${f.revision}^{tree}`]).toString().trim();
  const blob = git(f.repo, ['rev-parse', `${f.revision}:public/js/main.js`]).toString().trim();
  git(f.repo, ['tag', '-a', 'fixture-tag', '-m', 'Temporary fixture tag', f.revision]);
  const tag = git(f.repo, ['rev-parse', 'fixture-tag']).toString().trim();
  for (const revision of ['HEAD', f.revision.slice(0, 7), f.revision.toUpperCase(), '../escape', '0'.repeat(40), 'a'.repeat(39), tree, blob, tag]) {
    await assert.rejects(prepareLocalcodeRelease({ ...f, revision }), /Revision must|git object verification/);
    await absent(f.output);
  }
  for (const namespace of ['dev', 'beta;return 200', '', '../prod']) await assert.rejects(prepareLocalcodeRelease({ ...f, namespace }), /Namespace must/);
});

test('paths reject hidden/traversal/nginx syntax, symlink ancestors, hardlinks and nonregular files', async (t) => {
  const changes = ['dotfile', 'dotdir', 'semicolon', 'space', 'quote', 'variable', 'percent', 'backslash', 'newline', 'double-dot',
    'symlink', 'hardlink', 'directory-link', 'public-link', 'source-link', 'fifo'];
  for (const change of changes) {
    const f = await fixture(t);
    const names = { dotfile: '.private.js', dotdir: '.secret/a.js', semicolon: 'bad;return.js', space: 'bad name.js',
      quote: 'bad"name.js', variable: '$host.js', percent: '%2e.js', backslash: 'bad\\name.js', newline: 'bad\nname.js', 'double-dot': 'a..js' };
    if (names[change]) await put(join(f.source, 'public/js', names[change]), 'unsafe');
    if (change === 'symlink' || change === 'hardlink') {
      await rm(join(f.source, 'public/js/main.js'));
      await (change === 'symlink' ? symlink : link)(join(f.repo, 'public/js/main.js'), join(f.source, 'public/js/main.js'));
    }
    if (change === 'directory-link') {
      await rm(join(f.source, 'public/js/ui'), { recursive: true });
      await symlink(join(f.repo, 'public/js/ui'), join(f.source, 'public/js/ui'));
    }
    if (change === 'public-link') {
      await rm(join(f.source, 'public'), { recursive: true }); await symlink(join(f.repo, 'public'), join(f.source, 'public'));
    }
    if (change === 'source-link') { await symlink(f.source, join(f.base, 'source-link')); f.source = join(f.base, 'source-link'); }
    if (change === 'fifo') {
      const result = spawnSync('mkfifo', [join(f.source, 'public/js/fifo.js')]); assert.equal(result.status, 0);
    }
    await assert.rejects(prepareLocalcodeRelease(f), /Unsafe|regular|symlinks/);
    await absent(f.output);
  }
  const f = await fixture(t);
  await assert.rejects(prepareLocalcodeRelease({ ...f, source: f.source + '/../app' }), /traversal/);
});

test('tracked unsafe paths and git symlink blobs are rejected even when the export mimics normal bytes', async (t) => {
  for (const change of ['unsafe-name', 'tracked-link']) {
    const f = await fixture(t);
    if (change === 'unsafe-name') await put(join(f.repo, 'public/js/bad;name.js'), 'export default 1;');
    else { await rm(join(f.repo, 'public/js/main.js')); await symlink('data.js', join(f.repo, 'public/js/main.js')); }
    git(f.repo, ['add', '--', 'public/js']); git(f.repo, ['commit', '-m', 'Temporary unsafe fixture']);
    f.revision = git(f.repo, ['rev-parse', 'HEAD']).toString().trim();
    await assert.rejects(prepareLocalcodeRelease(f), /Unsafe|Tracked entry is not a regular/);
    await absent(f.output);
  }
});

test('new output refuses existing files/directories, links, traversal and symlink parents without touching them', async (t) => {
  for (const change of ['empty', 'populated', 'file', 'link', 'dangling-link', 'parent-link', 'traversal', 'inside-source']) {
    const f = await fixture(t);
    if (change === 'empty') await mkdir(f.output);
    if (change === 'populated') await put(join(f.output, 'keep'), 'keep');
    if (change === 'file') await put(f.output, 'keep');
    if (change === 'link') await symlink(f.source, f.output);
    if (change === 'dangling-link') await symlink(join(f.base, 'not-there'), f.output);
    if (change === 'parent-link') { await symlink(f.base, join(f.base, 'parent-link')); f.output = join(f.base, 'parent-link', 'prepared'); }
    if (change === 'traversal') f.output = join(f.base, 'app') + '/../prepared';
    if (change === 'inside-source') f.output = join(f.source, 'prepared');
    await assert.rejects(prepareLocalcodeRelease(f), /NEW nonexistent|regular directory|symlinks|traversal|outside/);
    if (change === 'populated') assert.equal(await readFile(join(f.output, 'keep'), 'utf8'), 'keep');
    if (change === 'file') assert.equal(await readFile(f.output, 'utf8'), 'keep');
    assert.equal(await readFile(join(f.source, 'public/js/main.js'), 'utf8'), 'export const business = "private";\n');
  }
});

test('verify rejects altered bytes, include, sums, metadata, extra files/directories and soft/hard links', async (t) => {
  for (const change of ['bytes', 'forged-bytes-and-hash', 'include', 'sums', 'extra-code', 'extra-root', 'extra-nginx', 'extra-revision',
    'empty-directory', 'missing', 'symlink', 'hardlink', 'metadata-hardlink', 'directory-link', 'root-link',
    'namespace', 'source-fullref', 'source-tree', 'source-extra', 'blob', 'sha', 'length', 'tool', 'tool-path', 'include-hash',
    'duplicate', 'manifest-extra', 'null-source']) {
    const f = await fixture(t);
    await prepareLocalcodeRelease(f);
    const staged = join(f.output, 'localcode', f.revision, 'js/main.js');
    if (change === 'bytes' || change === 'forged-bytes-and-hash') await put(staged, 'forged source');
    if (change === 'forged-bytes-and-hash') await manifestEdit(f, (m) => { const e = m.files.find(({ path }) => path === 'js/main.js'); e.bytes = 13; e.sha256 = hash('forged source'); });
    if (change === 'include') await put(join(f.output, 'nginx/localcode-beta.conf'), 'auth_request off;');
    if (change === 'sums') await put(join(f.output, 'SHA256SUMS'), 'forged');
    if (change === 'extra-code') await put(join(f.output, 'localcode', f.revision, 'js/extra.js'), 'extra');
    if (change === 'extra-root') await put(join(f.output, 'extra'), 'extra');
    if (change === 'extra-nginx') await put(join(f.output, 'nginx/extra.conf'), 'extra');
    if (change === 'extra-revision') await put(join(f.output, 'localcode', '1'.repeat(40), 'js/main.js'), 'extra');
    if (change === 'empty-directory') await mkdir(join(f.output, 'empty'));
    if (change === 'missing') await rm(staged);
    if (change === 'symlink' || change === 'hardlink') { await rm(staged); await (change === 'symlink' ? symlink : link)(join(f.source, 'public/js/main.js'), staged); }
    if (change === 'metadata-hardlink') {
      const path = join(f.output, 'release-manifest.json'); const other = join(f.base, 'linked-manifest');
      await put(other, await readFile(path)); await rm(path); await link(other, path);
    }
    if (change === 'directory-link') {
      const path = join(f.output, 'localcode', f.revision, 'js'); await rm(path, { recursive: true }); await symlink(join(f.source, 'public/js'), path);
    }
    if (change === 'root-link') { await symlink(f.output, join(f.base, 'output-link')); f.output = join(f.base, 'output-link'); }
    const edits = {
      namespace: (m) => { m.namespace = 'prod'; }, 'source-fullref': (m) => { m.source.fullref = '0'.repeat(40); },
      'source-tree': (m) => { m.source.tree = '1'.repeat(40); }, 'source-extra': (m) => { m.source.path = '/arbitrary/app'; },
      blob: (m) => { m.files[0].gitBlob = '1'.repeat(40); }, sha: (m) => { m.files[0].sha256 = '1'.repeat(64); },
      length: (m) => { m.files[0].bytes += 1; }, tool: (m) => { m.preparer.sha256 = '1'.repeat(64); },
      'tool-path': (m) => { m.preparer.path = 'other.mjs'; }, 'include-hash': (m) => { m.nginx[0].sha256 = '1'.repeat(64); },
      duplicate: (m) => { m.files.push(m.files[0]); }, 'manifest-extra': (m) => { m.extra = 'extra'; }, 'null-source': (m) => { m.source = null; },
    };
    if (edits[change]) await manifestEdit(f, edits[change]);
    await assert.rejects(verifyLocalcodeRelease(f.output, { repo: f.repo }), /differ|regular|symlinks|git object verification|Revision must/);
  }
});

test('verify uses git objects, not the repository working tree; a different claimed commit is checked', async (t) => {
  const f = await fixture(t);
  const manifest = await prepareLocalcodeRelease(f);
  await put(join(f.repo, 'public/js/main.js'), 'working tree change');
  assert.deepEqual(await verifyLocalcodeRelease(f.output, { repo: f.repo }), manifest);
  git(f.repo, ['add', '--', 'public/js/main.js']); git(f.repo, ['commit', '-m', 'Own temporary second commit']);
  const revision = git(f.repo, ['rev-parse', 'HEAD']).toString().trim();
  await assert.rejects(prepareLocalcodeRelease({ ...f, revision, output: join(f.base, 'new-commit') }), /Source bytes differ/);
  await manifestEdit(f, (m) => { m.source.fullref = revision; m.source.tree = git(f.repo, ['rev-parse', `${revision}^{tree}`]).toString().trim(); });
  await assert.rejects(verifyLocalcodeRelease(f.output, { repo: f.repo }), /Manifest hash\/source/);
});

test('git replacements and inherited GIT_* overrides cannot attest changed bytes', async (t) => {
  const f = await fixture(t);
  await put(join(f.repo, 'public/js/main.js'), 'export const forgedReplacement = true;\n');
  git(f.repo, ['add', '--', 'public/js/main.js']); git(f.repo, ['commit', '-m', 'Own temporary replacement commit']);
  const replacement = git(f.repo, ['rev-parse', 'HEAD']).toString().trim();
  git(f.repo, ['replace', f.revision, replacement]); // Writes ONLY the owned temporary fixture.
  const manifest = await prepareLocalcodeRelease(f);
  assert.deepEqual(await verifyLocalcodeRelease(f.output, { repo: f.repo }), manifest);
  const child = cli(['--verify', f.output, '--repo', f.repo], { env: { ...process.env,
    GIT_DIR: join(f.base, 'not-a-git-dir'), GIT_OBJECT_DIRECTORY: join(f.base, 'no-objects'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.repositoryformatversion', GIT_CONFIG_VALUE_0: '999' } });
  assert.equal(child.status, 0, child.stderr);
  await put(join(f.source, 'public/js/main.js'), 'export const forgedReplacement = true;\n');
  await assert.rejects(prepareLocalcodeRelease({ ...f, output: join(f.base, 'forged') }), /Source bytes differ/);
  await absent(join(f.base, 'forged'));
});

test('include builder rejects path injection, wrong scope and duplicate routes', () => {
  const base = { namespace: 'beta', source: { fullref: BASELINE } };
  for (const path of ['../js/main.js', '.js', 'js/.hidden.js', 'js/a;return.js', 'js/a$uri.js', 'js/a%20.js', 'shared/code.js', 'js/code.css', 'css/code.js', 'data.js']) {
    assert.throws(() => localcodeInclude({ ...base, files: [{ path }] }), /Unsafe|Invalid\/duplicate/);
  }
  assert.throws(() => localcodeInclude({ ...base, files: [{ path: 'js/a.js' }, { path: 'js/a.js' }] }), /duplicate/);
});

test('CLI prepares/verifies offline and rejects unknown, duplicate, missing or mixed mode options', async (t) => {
  const f = await fixture(t);
  const args = ['--source', f.source, '--revision', f.revision, '--repo', f.repo, '--out', f.output, '--namespace', 'beta'];
  const child = cli(args); assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /STAGED, NOT ACTIVE/);
  assert.equal(cli(['--verify', f.output, '--repo', f.repo]).status, 0);
  for (const bad of [[], ['--namespace', 'dev'], ['--unknown', 'x'], ['--namespace', 'beta', '--namespace', 'prod'],
    ['--out'], ['--source', f.source], ['--verify', f.output, '--out', 'new'], ['--verify', f.output, '--source', f.source],
    ['--verify', f.output, '--namespace', 'prod', '--repo', f.repo], ['--verify', f.output, '--revision', 'HEAD'],
    ['--verify', f.output, '--repo', join(f.base, 'missing-repo')]]) {
    const result = cli(bad); assert.notEqual(result.status, 0); assert.ok(result.stderr.length);
  }
});
