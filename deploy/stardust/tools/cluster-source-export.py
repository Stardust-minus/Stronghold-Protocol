#!/usr/bin/env python3
"""Export committed cluster code plus separately inventoried generated resources."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess

SPEC = importlib.util.spec_from_file_location('cluster_generated_assets', Path(__file__).with_name('cluster-generated-assets.py'))
assets = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(assets)
HEX40 = re.compile(r'[a-f0-9]{40}')
APP_ICON_FILES = ('app-192.png', 'app-512.png', 'app-maskable-192.png', 'app-maskable-512.png',
                  'app.svg', 'apple-touch-icon.png', 'favicon-16.png', 'favicon-32.png', 'favicon-48.png', 'favicon.ico')
AUTH_FILES = ('name-policy.mjs', 'name-dictionary.mjs', 'name-sensitive-dictionary.mjs',
              'name-filter-vendor.mjs', 'name-filter-node.mjs', 'NAME-DICTIONARY-LICENSE.txt',
              'NAME-FILTER-LICENSE.txt', 'NAME-CATEGORIES-LICENSE.txt', 'NAME-POLITICAL-LICENSE.txt')


class Refused(Exception):
    """Fail closed before using uncommitted source or dropping renderer data."""


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def code_path(name):
    return name in ('package.json', 'package-lock.json', 'public/index.html', 'public/manifest.json') \
        or name in tuple('public/icons/' + file for file in APP_ICON_FILES) \
        or name.startswith(('server/', 'shared/', 'data/', 'public/js/', 'public/css/')) \
        or re.fullmatch(r'public/i18n/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\.json', name) is not None \
        or name in tuple('deploy/stardust/auth/' + file for file in AUTH_FILES)


def export(root, output, revision):
    root, output = Path(root).absolute(), Path(output).absolute()
    if not isinstance(revision, str) or not HEX40.fullmatch(revision):
        raise Refused('full committed revision required')
    if root.resolve() != root or output == root or output.resolve() != output or output.exists():
        raise Refused('new normalized export directory required')
    git = lambda *args: subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.PIPE)
    if git('rev-parse', revision + '^{commit}').decode().strip() != revision:
        raise Refused('commit identity mismatch')
    entries = []
    for record in git('ls-tree', '-r', '-z', revision).split(b'\0'):
        if not record:
            continue
        metadata, raw_name = record.split(b'\t', 1)
        mode, kind, oid = metadata.decode().split()
        name = raw_name.decode()
        if code_path(name):
            if kind != 'blob' or mode not in ('100644', '100755') or '..' in Path(name).parts:
                raise Refused('regular committed code required')
            raw = git('cat-file', 'blob', oid)
            if assets.read_regular(root, name) != raw:
                raise Refused('checkout code differs from committed export')
            entries.append((name, raw, 0o755 if mode == '100755' else 0o644))
    names = {name for name, _, _ in entries}
    if not {'server/cluster/start.mjs', 'shared/experimental.js', 'shared/cluster-load.js', 'data/assets.json'} <= names \
            or any('deploy/stardust/auth/' + file not in names for file in AUTH_FILES):
        raise Refused('complete cluster source inventory required')
    dockerfile = git('show', revision + ':deploy/stardust/cluster/Dockerfile.cluster')
    if assets.read_regular(root, 'deploy/stardust/cluster/Dockerfile.cluster') != dockerfile:
        raise Refused('Dockerfile differs from committed export')
    generated = assets.generated_renderer_data(root)
    if generated['path'] in names:
        raise Refused('generated game-art index must remain outside committed code')
    output.mkdir(mode=0o755)
    app = output / 'app'
    app.mkdir(mode=0o755)

    def copy(name, raw, mode=0o644):
        destination = app / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open('xb') as file:
            file.write(raw)
        destination.chmod(mode)
        return {'path': name, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'mode': oct(mode)}

    source = [copy(name, raw, mode) for name, raw, mode in sorted(entries)]
    source_raw = canonical({'version': 1, 'kind': 'commit', 'baseRevision': revision, 'files': source})
    source_digest = hashlib.sha256(source_raw).hexdigest()
    (output / 'source-manifest.json').write_bytes(source_raw)
    resources = []
    for category in ('public/assets', 'public/fonts', 'public/vendor'):
        directory = root / category
        if not directory.is_dir() or directory.is_symlink():
            raise Refused('matched public resource directory required')
        for path in sorted(directory.rglob('*')):
            if path.is_symlink():
                raise Refused('resource symlink refused')
            if path.is_file():
                relative = path.relative_to(root).as_posix()
                resources.append(copy(relative, assets.read_regular(root, relative, limit=64 * 1024 * 1024)))
    resources.append({**copy(generated['path'], generated['bytes']), 'kind': generated['kind']})
    dependencies = root / 'node_modules'
    if not dependencies.is_dir() or dependencies.is_symlink():
        raise Refused('locked prepared dependencies required')
    for path in sorted(dependencies.rglob('*')):
        relative = path.relative_to(dependencies)
        if '.bin' in relative.parts:
            continue
        if path.is_symlink():
            raise Refused('dependency symlink refused')
        if path.is_file():
            name = 'node_modules/' + relative.as_posix()
            # Locked packages include legitimate empty .d.ts and module files.
            copy(name, assets.read_regular(root, name, limit=64 * 1024 * 1024, allow_empty=True))
    resource_raw = canonical({'version': 1, 'sourceKind': 'commit', 'build': revision,
        'sourceManifestSha256': source_digest, 'files': sorted(resources, key=lambda row: row['path'])})
    resource_digest = hashlib.sha256(resource_raw).hexdigest()
    (output / 'resource-manifest.json').write_bytes(resource_raw)
    version = json.loads(dict((name, raw) for name, raw, _ in entries)['package.json'])['version']
    identity = {'sourceKind': 'commit', 'build': revision, 'sourceManifestSha256': source_digest,
        'resourceManifestSha256': resource_digest, 'sourceFiles': len(source), 'resourceFiles': len(resources),
        'publicResourceFiles': len(resources) - 1, 'generatedRendererIndex': {
            'path': generated['path'], 'bytes': len(generated['bytes']), 'sha256': generated['sha256'],
            'resourceReferences': generated['resourceReferences']}, 'version': version}
    (output / 'identity.json').write_bytes(canonical(identity))
    (output / 'Dockerfile').write_bytes(dockerfile)
    return identity


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(export(args.source, args.out, args.revision)))
        return 0
    except (Refused, assets.Refused, OSError, ValueError, subprocess.SubprocessError):
        print(json.dumps({'ok': False, 'reason': 'cluster source/resource export refused'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
