#!/usr/bin/env python3
"""Offline fixed-profile private-code staging from an exact source manifest."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys

_PROFILE_SPEC = importlib.util.spec_from_file_location('cluster_code_profiles', Path(__file__).resolve().with_name('cluster-profile.py'))
profiles = importlib.util.module_from_spec(_PROFILE_SPEC)
sys.modules[_PROFILE_SPEC.name] = profiles
_PROFILE_SPEC.loader.exec_module(profiles)
_BETA = profiles.get_profile()
SITE, FALLBACK = _BETA.site, '@ark_beta_cluster_code'
ROOTS = ('public/js', 'public/css')
COORDINATOR = 'http://' + _BETA.wg_core + ':' + str(_BETA.coordinator_port)
TOOL_PATH = 'deploy/stardust/tools/cluster-private-code.py'
HEX40, HEX64 = re.compile(r'[a-f0-9]{40}'), re.compile(r'[a-f0-9]{64}')
SEGMENT = re.compile(r'[A-Za-z0-9_-][A-Za-z0-9_.-]*')
MAX_MANIFEST, MAX_FILE, MAX_CODE = 1024 * 1024, 8 * 1024 * 1024, 32 * 1024 * 1024


class Refused(Exception):
    """Fixed codes only; no file bytes, credentials or arbitrary paths in CLI errors."""


def require(ok, code):
    if not ok:
        raise Refused(code)


def canonical(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':'), allow_nan=False) + '\n').encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(value):
    require(isinstance(value, str) and 0 < len(value) <= 512 and '\\' not in value,
            'UNSAFE_PATH')
    parts = value.split('/')
    require(all(SEGMENT.fullmatch(part) and '..' not in part and not part.endswith('.') for part in parts), 'UNSAFE_PATH')
    return value


def absolute(value):
    require(isinstance(value, (str, Path)), 'UNSAFE_ABSOLUTE_PATH')
    spelling = str(value)
    require(spelling and '\0' not in spelling and Path(spelling).is_absolute()
            and spelling == os.path.normpath(spelling), 'UNSAFE_ABSOLUTE_PATH')
    return Path(spelling)


def directory(path):
    info = os.lstat(path)
    require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode), 'UNSAFE_DIRECTORY')
    return info


def root_directory(value):
    path = absolute(value)
    for parent in (*reversed(path.parents), path):
        directory(parent)
    return path


def regular(info):
    require(stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode) and info.st_nlink == 1,
            'NONREGULAR_OR_LINKED_FILE')


def open_without_links(path):
    parent = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for component in path.parts[1:-1]:
            opened = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
            os.close(parent)
            parent = opened
        before = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        regular(before)
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=parent)
        return fd, before
    finally:
        os.close(parent)


def read_file(path, limit=MAX_FILE):
    path = absolute(path)
    fd, before = open_without_links(path)
    try:
        opened = os.fstat(fd)
        regular(opened)
        require(0 <= opened.st_size <= limit, 'INPUT_SIZE_BOUND')
        require((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino), 'INPUT_REPLACED')
        chunks, remaining = [], limit + 1
        while remaining:
            chunk = os.read(fd, min(remaining, 128 * 1024))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b''.join(chunks)
        after = os.fstat(fd)
        regular(after)
        identity = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, stat.S_IMODE(info.st_mode))
        require(identity(opened) == identity(after) and len(raw) == opened.st_size and len(raw) <= limit, 'INPUT_CHANGED')
        return raw, stat.S_IMODE(after.st_mode)
    finally:
        os.close(fd)


def reject_duplicates(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'DUPLICATE_JSON_KEY')
        result[key] = value
    return result


def source_manifest(path, expected_sha, build, *, profile='beta', source_kind='tree'):
    profiles.get_profile(profile)
    require(source_kind in ('tree', 'commit'), 'INVALID_SOURCE_KIND')
    require(profiles.path_allowed(path, profile), 'CROSS_PROFILE_SOURCE_PATH')
    require(isinstance(expected_sha, str) and HEX64.fullmatch(expected_sha)
            and isinstance(build, str) and HEX40.fullmatch(build)
            and (source_kind != 'tree' or build == expected_sha[:40]), 'INVALID_TREE_IDENTITY')
    raw, _ = read_file(path, MAX_MANIFEST)
    require(sha(raw) == expected_sha, 'SOURCE_MANIFEST_HASH_MISMATCH')
    try:
        value = json.loads(raw, object_pairs_hook=reject_duplicates,
                           parse_constant=lambda _constant: (_ for _ in ()).throw(Refused('INVALID_JSON_CONSTANT')))
    except (ValueError, UnicodeError):
        raise Refused('INVALID_SOURCE_MANIFEST') from None
    require(isinstance(value, dict) and set(value) == {'baseRevision', 'files', 'kind', 'version'}
            and type(value['version']) is int and value['version'] == 1 and value['kind'] == source_kind
            and isinstance(value['baseRevision'], str) and HEX40.fullmatch(value['baseRevision'])
            and (source_kind != 'commit' or value['baseRevision'] == build), 'INVALID_SOURCE_SCHEMA')
    require(raw == canonical(value), 'NONCANONICAL_SOURCE_MANIFEST')
    files = value['files']
    require(isinstance(files, list) and 1 <= len(files) <= 4096, 'INVALID_SOURCE_INVENTORY')
    paths = []
    for row in files:
        require(isinstance(row, dict) and set(row) == {'bytes', 'mode', 'path', 'sha256'}, 'INVALID_SOURCE_ENTRY')
        paths.append(safe_path(row['path']))
        require(type(row['bytes']) is int and 0 <= row['bytes'] <= 64 * 1024 * 1024
                and row['mode'] in ('0o644', '0o755') and isinstance(row['sha256'], str)
                and HEX64.fullmatch(row['sha256']), 'INVALID_SOURCE_ENTRY')
    require(paths == sorted(paths) and len(set(paths)) == len(paths), 'DUPLICATE_OR_UNSORTED_SOURCE_PATHS')
    selected = []
    for row in files:
        path = row['path']
        if any(path.startswith(prefix + '/') for prefix in ROOTS):
            require(is_code(path) and row['bytes'] <= MAX_FILE, 'UNKNOWN_PRIVATE_CODE_ENTRY')
            selected.append(row)
    require(any(row['path'].startswith('public/js/') for row in selected)
            and any(row['path'].startswith('public/css/') for row in selected)
            and sum(row['bytes'] for row in selected) <= MAX_CODE, 'INVALID_PRIVATE_CODE_INVENTORY')
    return value, selected


def is_code(path):
    return path.startswith('public/js/') and path.endswith('.js') or path.startswith('public/css/') and path.endswith('.css')


def inventory(root, relative=''):
    current = root / relative
    directory(current)
    files, dirs = [], []
    for entry in sorted(os.scandir(current), key=lambda row: row.name):
        child = safe_path(relative + '/' + entry.name if relative else entry.name)
        info = entry.stat(follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
            dirs.append(child)
            subfiles, subdirs = inventory(root, child)
            files.extend(subfiles)
            dirs.extend(subdirs)
        else:
            regular(info)
            files.append(child)
    return sorted(files), sorted(dirs)


def parents(paths):
    directories = set()
    for path in paths:
        for parent in PurePosixPath(path).parents:
            if str(parent) != '.':
                directories.add(str(parent))
    return sorted(directories)


def verified_snapshots(source, selected):
    source = root_directory(source)
    directory(source / 'public')
    actual_files, actual_dirs = [], []
    for prefix in ROOTS:
        files, dirs = inventory(source, prefix)
        actual_files.extend(files)
        actual_dirs.extend([prefix, *dirs])
    expected = [row['path'] for row in selected]
    expected_dirs = sorted(set(ROOTS) | {path for path in parents(expected) if path != 'public'})
    require(sorted(actual_files) == expected and sorted(actual_dirs) == expected_dirs, 'SOURCE_CODE_INVENTORY_MISMATCH')
    snapshots = {}
    for row in selected:
        raw, mode = read_file(source / row['path'])
        require(len(raw) == row['bytes'] and sha(raw) == row['sha256'] and oct(mode) == row['mode'], 'SOURCE_CODE_BYTES_OR_MODE_MISMATCH')
        snapshots[row['path']] = raw
    return snapshots


def security_headers(marker, *, profile='beta'):
    maps = profiles.get_profile(profile).security_map
    # Exact stock Beta security expressions. Defining location add_header suppresses
    # inheritance, so repeat ALL stock security headers but NEVER business ACAO.
    return [
        '    add_header Strict-Transport-Security "max-age=31536000" always;',
        '    add_header X-Content-Type-Options nosniff always;',
        '    add_header X-Frame-Options $' + maps + '_frame always;',
        '    add_header Referrer-Policy same-origin always;',
        '    add_header Cache-Control "private, no-store" always;',
        '    add_header Content-Security-Policy $' + maps + '_csp always;',
        '    add_header X-Robots-Tag "noindex, nofollow" always;',
        '    add_header X-Ark-Code-Source "' + marker + '" always;',
    ]


def proxy_body(*, profile='beta'):
    p = profiles.get_profile(profile)
    return [
        '    auth_request /_gate/check;',
        '    if ($request_method !~ ^(GET|HEAD)$) { return 405; }',
        '    proxy_http_version 1.1;',
        '    proxy_set_header Host $host;',
        '    proxy_set_header X-Real-IP $remote_addr;',
        '    proxy_set_header X-Forwarded-For $remote_addr;',
        '    proxy_set_header X-Forwarded-Proto $scheme;',
        '    proxy_set_header Forwarded "";',
        '    proxy_set_header X-Forwarded-Host "";',
        '    proxy_set_header CF-Connecting-IP "";',
        '    proxy_set_header Upgrade "";',
        '    proxy_set_header Connection "";',
        '    proxy_cache off;',
        '    proxy_redirect off;',
        '    proxy_connect_timeout 5s;',
        '    proxy_read_timeout 30s;',
        '    proxy_hide_header Access-Control-Allow-Origin;',
        '    proxy_hide_header Cache-Control;',
        '    proxy_hide_header X-Content-Type-Options;',
        '    proxy_hide_header X-Frame-Options;',
        '    proxy_hide_header Referrer-Policy;',
        '    proxy_hide_header Content-Security-Policy;',
        '    proxy_hide_header X-Robots-Tag;',
        '    proxy_hide_header Strict-Transport-Security;',
        '    proxy_hide_header X-Ark-Code-Source;',
        '    proxy_pass http://' + p.wg_core + ':' + str(p.coordinator_port) + ';',
        *security_headers('cluster', profile=profile),
    ]


def render_include(build, selected, *, profile='beta', source_kind='tree'):
    p = profiles.get_profile(profile)
    fallback = '@ark_' + p.name + '_cluster_code'
    require(HEX40.fullmatch(build), 'INVALID_TREE_IDENTITY')
    prefix = '/www/sites/' + p.site + '/localcode/' + p.code_prefix + build
    lines = [
        '# STAGED private Beta TREE code; NOT an activation record.',
        '# build=' + build + '; sourceKind=tree; this is NOT a Git commit.',
        '# Include only inside ' + SITE + ' server.',
        '# Stock $ark_beta_frame/$ark_beta_csp maps and /_gate/check are required.',
        '# CSP expression is stock; an empty $ark_beta_csp emits no CSP header.',
        '# Coordinator MUST be the SAME frozen TREE build; never formal/old monolith.',
    ]
    if profile != 'beta' or source_kind != 'tree':
        lines = [
            '# STAGED private ' + profile.capitalize() + ' code; NOT an activation record.',
            '# build=' + build + '; sourceKind=' + source_kind + '; full source manifest is pinned.',
            '# Include only inside ' + p.site + ' server.',
            '# Stock $' + p.security_map + '_frame/$' + p.security_map + '_csp maps and /_gate/check are required.',
            '# CSP expression is stock; an empty $' + p.security_map + '_csp emits no CSP header.',
            '# Coordinator MUST be the SAME fixed source build; never the other profile/old monolith.',
        ]
    for row in selected:
        source_path = safe_path(row['path'])
        require(is_code(source_path), 'UNKNOWN_PRIVATE_CODE_ENTRY')
        path = source_path[len('public/'):]
        mime = 'application/javascript' if path.startswith('js/') else 'text/css'
        lines.extend(['', 'location = /' + path + ' {',
                      '    auth_request /_gate/check;',
                      '    if ($request_method !~ ^(GET|HEAD)$) { return 405; }',
                      '    alias ' + prefix + '/' + path + ';',
                      # Static404 occurs after access phase; named fallback repeats the gate.
                      '    error_page 404 = ' + fallback + ';',
                      '    disable_symlinks on;', '    types { }',
                      '    default_type ' + mime + ';', '    expires off;', '    etag on;',
                      *security_headers('edge', profile=profile), '}'])
    # Exact locations win over these prefixes. Unknown code can ONLY proxy to the
    # same private coordinator, not a filesystem wildcard or old/formal backend.
    for prefix in ('/js/', '/css/'):
        lines.extend(['', 'location ^~ ' + prefix + ' {', *proxy_body(profile=profile), '}'])
    lines.extend(['', 'location ' + fallback + ' {', *proxy_body(profile=profile), '}', ''])
    return '\n'.join(lines).encode()


def release_metadata(build, digest, source, selected, *, profile='beta', source_kind='tree'):
    p = profiles.get_profile(profile)
    tool_bytes, _ = read_file(Path(__file__).resolve())
    include = render_include(build, selected, profile=profile, source_kind=source_kind)
    files = [{'path': row['path'][len('public/'):], 'sourcePath': row['path'], 'bytes': row['bytes'],
              'sha256': row['sha256'], 'sourceMode': row['mode'], 'mode': '0o644'} for row in selected]
    value = {'version': 1, 'namespace': p.name, 'sourceKind': source_kind, 'build': build,
             'sourceManifestSha256': digest, 'sourceManifestFiles': len(source['files']),
             'baseRevision': source['baseRevision'], 'prepared': True, 'activated': False,
             'preparer': {'path': TOOL_PATH, 'sha256': sha(tool_bytes)}, 'files': files,
             'nginx': [{'path': 'nginx/cluster-private-code-' + profile + '.conf', 'bytes': len(include), 'sha256': sha(include)}]}
    return value, include


def expected_outputs(value):
    base = 'localcode/' + profiles.get_profile(value['namespace']).code_prefix + value['build'] + '/'
    return [{'path': base + row['path'], 'bytes': row['bytes'], 'sha256': row['sha256']} for row in value['files']] + value['nginx']


def sums(value):
    outputs = [*expected_outputs(value), {'path': 'release-manifest.json', 'sha256': sha(canonical(value))}]
    return ''.join(row['sha256'] + '  ' + row['path'] + '\n' for row in outputs).encode()


def put(path, raw):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
    try:
        os.fchmod(fd, 0o644)
        with os.fdopen(fd, 'wb', closefd=False) as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
    finally:
        os.close(fd)


def prepare(source, manifest, digest, build, output, *, profile='beta', source_kind='tree'):
    p = profiles.get_profile(profile)
    require(all(profiles.path_allowed(path, profile) for path in (source, manifest, output)), 'CROSS_PROFILE_SOURCE_PATH')
    source, output = root_directory(source), absolute(output)
    root_directory(output.parent)
    require(output != source and source not in output.parents, 'OUTPUT_INSIDE_SOURCE')
    require(not os.path.lexists(output), 'OUTPUT_ALREADY_EXISTS')
    original, selected = source_manifest(manifest, digest, build, profile=profile, source_kind=source_kind)
    snapshots = verified_snapshots(source, selected)
    value, include = release_metadata(build, digest, original, selected, profile=profile, source_kind=source_kind)
    paths = [row['path'] for row in expected_outputs(value)] + ['release-manifest.json', 'SHA256SUMS']
    os.mkdir(output, 0o755)
    os.chmod(output, 0o755)
    try:
        for relative in sorted(parents(paths), key=lambda name: (name.count('/'), name)):
            os.mkdir(output / relative, 0o755)
            os.chmod(output / relative, 0o755)
        for row in value['files']:
            put(output / ('localcode/' + p.code_prefix + build) / row['path'], snapshots[row['sourcePath']])
        put(output / value['nginx'][0]['path'], include)
        put(output / 'SHA256SUMS', sums(value))
        put(output / 'release-manifest.json', canonical(value))
    except BaseException:
        # This process exclusively created this fresh staging directory, never a live release.
        shutil.rmtree(output)
        raise
    return value


def verify(output, manifest, digest, build, *, profile='beta', source_kind='tree'):
    profiles.get_profile(profile)
    require(all(profiles.path_allowed(path, profile) for path in (output, manifest)), 'CROSS_PROFILE_SOURCE_PATH')
    output = root_directory(output)
    original, selected = source_manifest(manifest, digest, build, profile=profile, source_kind=source_kind)
    value, include = release_metadata(build, digest, original, selected, profile=profile, source_kind=source_kind)
    metadata, metadata_mode = read_file(output / 'release-manifest.json', MAX_MANIFEST)
    require(metadata == canonical(value) and metadata_mode == 0o644, 'STAGED_METADATA_MISMATCH')
    paths = sorted([row['path'] for row in expected_outputs(value)] + ['release-manifest.json', 'SHA256SUMS'])
    files, dirs = inventory(output)
    require(files == paths and dirs == parents(paths), 'STAGED_INVENTORY_MISMATCH')
    for row in expected_outputs(value):
        raw, mode = read_file(output / row['path'])
        require(len(raw) == row['bytes'] and sha(raw) == row['sha256'] and mode == 0o644, 'STAGED_BYTES_OR_MODE_MISMATCH')
    require(read_file(output / value['nginx'][0]['path'])[0] == include
            and read_file(output / 'SHA256SUMS')[0] == sums(value), 'STAGED_INCLUDE_OR_SUMS_MISMATCH')
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', default='beta', choices=tuple(profiles.PROFILES))
    parser.add_argument('--source-kind', default='tree', choices=('tree', 'commit'))
    parser.add_argument('--source')
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--build', required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--out')
    mode.add_argument('--verify')
    args = parser.parse_args()
    try:
        require(bool(args.source) == bool(args.out), 'INVALID_CLI_MODE')
        value = prepare(args.source, args.manifest, args.manifest_sha256, args.build, args.out, profile=args.profile, source_kind=args.source_kind) if args.out else \
            verify(args.verify, args.manifest, args.manifest_sha256, args.build, profile=args.profile, source_kind=args.source_kind)
        print(json.dumps({'event': 'cluster-private-code-' + ('prepared' if args.out else 'verified'),
                          'namespace': value['namespace'], 'sourceKind': value['sourceKind'], 'build': value['build'],
                          'sourceManifestSha256': value['sourceManifestSha256'], 'urls': len(value['files']), 'activated': False}))
        return 0
    except (Refused, OSError, ValueError, TypeError):
        print('{"event":"refused","reason":"pinned fixed-profile private code refused"}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
