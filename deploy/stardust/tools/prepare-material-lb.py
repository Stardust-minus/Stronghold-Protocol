#!/usr/bin/env python3
"""Prepare a matched 60/40 material profile without activating it; C1 remains the default."""

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from urllib.parse import quote

RELEASE = 'v013-hangzhou-20261006-1f742992'
MODEL_REPO = 'Stardust/arknight-assets'
MODEL_REVISION = '34fa98b056c7554b8dbea7a4e18e78b6c6445fbb'
MODEL_PREFIX = 'releases/v013-modelscope-20261006-1f742992-174200'
FALLBACK_ORIGIN = 'https://ark-asset.hanabi-ai.cn:25442'
FALLBACK = FALLBACK_ORIGIN + '/releases/' + RELEASE
OSS_ORIGIN = 'https://obs.cn-south-222.ai.pcl.cn'
MODEL_BASE = 'https://modelscope.cn/datasets/' + MODEL_REPO + '/resolve/' + MODEL_REVISION + '/' + MODEL_PREFIX + '/'
CONTAINER_PREFIX = '/www/sites/ark-proto.stardust.matce.cn/material-lb/'
EXTENSIONS = {'png', 'jpg', 'jpeg', 'webp', 'gif', 'atlas', 'skel', 'obj', 'mtl', 'json',
              'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav'}
TEMPLATES = Path(__file__).resolve().parent.parent / 'material-lb'
ENTRY_KEYS = {'requestPath', 'fileName', 'bytes', 'sha256', 'mime'}
RELEASE_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,95}')
OPENI_ONLY_ALLOWLIST = frozenset({'/assets/skins/char_340_shwaz_snow_1/illustration.png'})
MAX_MODEL_PREFIXES = 8
OPENI_MANIFEST_KEYS = {'schemaVersion', 'release', 'fallbackBase', 'dataset', 'apiOrigin',
                       'ossOrigin', 'ossPathPrefix', 'entries', 'mirrorReleases'}
MODEL_MANIFEST_KEYS = {'schemaVersion', 'release', 'fallbackBase', 'repo', 'revision', 'prefix',
                       'apiOrigin', 'deliveryStrategy', 'uploadVerified', 'entries', 'mirrorReleases',
                       'prefixes', 'openiOnlyPaths'}


def model_prefix_pin(value):
    return isinstance(value, str) and value.startswith('releases/') and bool(
        RELEASE_ID.fullmatch(value[len('releases/'):]))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def relative(value):
    return isinstance(value, str) and 0 < len(value) <= 2048 and all(
        re.fullmatch(r'[A-Za-z0-9_\[\]-][A-Za-z0-9_.\[\]-]*', p) and not p.endswith('.')
        for p in value.split('/'))


def public_path(value):
    if not isinstance(value, str) or not value.startswith('/') or not relative(value[1:]):
        return False
    parts = value[1:].split('/')
    return len(parts) > 1 and (parts[0] == 'media' or
        (parts[0] == 'assets' and parts[-1].rsplit('.', 1)[-1] in EXTENSIONS))


def entries(manifest, models, *, release=RELEASE, model_prefix=MODEL_PREFIX, model_prefixes=None):
    rows = manifest.get('entries')
    require(isinstance(rows, list) and 0 < len(rows) <= 50000, 'invalid entry count')
    result, files = {}, {}
    mirrors = manifest.get('mirrorReleases', [release])
    require(isinstance(mirrors, list) and 0 < len(mirrors) <= 2 and len(set(mirrors)) == len(mirrors), 'invalid mirrors')
    require(all(isinstance(m, str) and RELEASE_ID.fullmatch(m) for m in mirrors), 'invalid mirror IDs')
    for row in rows:
        require(isinstance(row, dict) and set(row) == ENTRY_KEYS, 'invalid entry fields')
        require(public_path(row['requestPath']) and row['requestPath'] not in result, 'invalid or duplicate path')
        require(relative(row['fileName']), 'invalid object path')
        parts = row['fileName'].split('/')
        require(len(parts) >= 4 and parts[0] == 'releases' and parts[2] in ('assets', 'media'), 'invalid object namespace')
        require(any(row['fileName'].startswith(pin + '/') for pin in
                    (model_prefixes if model_prefixes is not None else [model_prefix]))
                if models else parts[1] in mirrors, 'unapproved object release')
        require(type(row['bytes']) is int and row['bytes'] >= 0, 'invalid size')
        require(isinstance(row['sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', row['sha256']), 'invalid SHA256')
        require(isinstance(row['mime'], str) and len(row['mime']) <= 128 and
                re.fullmatch(r'[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+', row['mime']), 'invalid MIME')
        require(parts[2] != 'assets' or public_path('/assets/' + '/'.join(parts[3:])), 'invalid asset object')
        require(parts[2] != 'media' or (row['mime'].startswith('audio/') and parts[-1].rsplit('.', 1)[-1] not in EXTENSIONS), 'invalid audio object')
        require(not row['requestPath'].startswith('/media/') or parts[2] == 'media', 'invalid media alias')
        values = tuple(row[k] for k in ('bytes', 'sha256', 'mime'))
        require(row['fileName'] not in files or files[row['fileName']] == values, 'conflicting object metadata')
        files[row['fileName']] = values
        result[row['requestPath']] = row
    return result


def render(openi, models, container_dir, *, release=RELEASE, model_revision=MODEL_REVISION, model_prefix=MODEL_PREFIX,
           model_prefixes=None, openi_only_paths=()):
    require(isinstance(openi, dict) and isinstance(models, dict), 'manifests must be objects')
    require(set(openi) <= OPENI_MANIFEST_KEYS and set(models) <= MODEL_MANIFEST_KEYS, 'unknown manifest fields')
    require(isinstance(release, str) and RELEASE_ID.fullmatch(release), 'invalid release pin')
    require(isinstance(model_revision, str) and re.fullmatch(r'[a-f0-9]{40}', model_revision), 'invalid ModelScope revision pin')
    require(model_prefix_pin(model_prefix), 'invalid ModelScope prefix pin')
    prefixes = [model_prefix] if model_prefixes is None else model_prefixes
    require(isinstance(prefixes, (list, tuple)) and 0 < len(prefixes) <= MAX_MODEL_PREFIXES and
            all(model_prefix_pin(pin) for pin in prefixes) and len(set(prefixes)) == len(prefixes) and
            prefixes[0] == model_prefix, 'invalid ModelScope prefix whitelist')
    require(len(prefixes) == 1 or model_revision != MODEL_REVISION, 'multiple prefixes require a new revision pin')
    require(isinstance(openi_only_paths, (list, tuple)) and len(openi_only_paths) <= 1 and
            all(isinstance(path, str) and path in OPENI_ONLY_ALLOWLIST for path in openi_only_paths) and
            len(set(openi_only_paths)) == len(openi_only_paths), 'invalid OpenI-only exception')
    require(models.get('prefixes', [model_prefix]) == list(prefixes), 'ModelScope prefix declarations differ')
    require(models.get('openiOnlyPaths', []) == list(openi_only_paths), 'OpenI-only declarations differ')
    fallback = FALLBACK_ORIGIN + '/releases/' + release
    resolve_base = 'https://modelscope.cn/datasets/' + MODEL_REPO + '/resolve/' + model_revision + '/'
    model_bases = [resolve_base + pin + '/' for pin in prefixes]
    model_base = model_bases[0]
    require(isinstance(container_dir, str) and container_dir.startswith(CONTAINER_PREFIX) and
            re.fullmatch(r'[A-Za-z0-9_-]{1,96}', container_dir[len(CONTAINER_PREFIX):]), 'invalid container directory')
    require(type(openi.get('schemaVersion')) is int and type(models.get('schemaVersion')) is int and
            openi['schemaVersion'] == models['schemaVersion'] == 1, 'invalid schema')
    require(openi.get('release') == models.get('release') == release, 'mismatched release')
    require(openi.get('fallbackBase') == models.get('fallbackBase') == fallback, 'invalid fallback')
    require(openi.get('dataset') == 'Stardust_minus/arknight_assets' and openi.get('apiOrigin') == 'https://openi.pcl.ac.cn' and
            openi.get('ossOrigin') == OSS_ORIGIN, 'invalid OpenI origin')
    prefix = openi.get('ossPathPrefix')
    require(isinstance(prefix, str) and prefix.startswith('/') and prefix.endswith('/') and
            len(prefix.split('/')) == 4 and relative(prefix[1:-1]), 'invalid OSS prefix')
    require(models.get('repo') == MODEL_REPO and models.get('revision') == model_revision and
            models.get('prefix') == model_prefix and models.get('apiOrigin') == 'https://modelscope.cn' and
            models.get('deliveryStrategy') == '302-to-stable-public-api' and models.get('uploadVerified') is True,
            'unverified or mismatched ModelScope profile')
    oi = entries(openi, False, release=release, model_prefix=model_prefix)
    ms = entries(models, True, release=release, model_prefix=model_prefix, model_prefixes=prefixes)
    exceptions = set(openi_only_paths)
    require(exceptions <= set(oi), 'OpenI-only alias missing from OpenI inventory')
    require(set(ms) == set(oi) - exceptions, 'alias inventories differ')
    for path, row in ms.items():
        require(all(row[k] == oi[path][k] for k in ('bytes', 'sha256', 'mime')), 'alias bytes differ')
    urls = {p: resolve_base + '/'.join(quote(segment, safe='') for segment in row['fileName'].split('/'))
            for p, row in ms.items()}
    require(all(any(url.startswith(base) for base in model_bases) for url in urls.values()), 'invalid ModelScope target')
    paths = {path: False if path in exceptions else urls[path] for path in oi}
    data = {'schemaVersion': 2, 'release': release, 'fallbackBase': fallback, 'modelscopeBase': model_base,
            'openiWeight': 40, 'modelscopeWeight': 60, 'ningxiaWeight': 0, 'paths': paths}
    if len(model_bases) > 1:
        data['modelscopeBases'] = model_bases
    q = lambda value: json.dumps(value, ensure_ascii=True)
    lua_bases = '{' + ', '.join(q(base) for base in model_bases) + '}'
    lua_exceptions = '{' + ', '.join('[' + q(path) + '] = true' for path in openi_only_paths) + '}'
    header_data = {'fallback_base': fallback, 'oss_authority': OSS_ORIGIN.removeprefix('https://'),
                   'oss_path_prefix': prefix, 'entries': {
                       path: {'fileName': row['fileName'], **({} if path in exceptions else {'modelscope': urls[path]})}
                       for path, row in oi.items()}}
    access = (TEMPLATES / 'access.lua').read_text().replace('__MATERIAL_LB_DATA__', container_dir + '/routes.json')
    access = access.replace('"' + RELEASE + '"', q(release)).replace('"' + FALLBACK + '"', q(fallback)).replace('"' + MODEL_BASE + '"', q(model_base))
    access_key = 'ark_material_lb_' + container_dir[len(CONTAINER_PREFIX):].replace('-', '_')
    access = access.replace('"ark_material_lb_20261006_model60_v3"', q(access_key))
    access = access.replace('__MATERIAL_LB_MODELSCOPE_BASES__', lua_bases).replace(
        '__MATERIAL_LB_OPENI_ONLY__', lua_exceptions)
    key = 'ark_material_lb_header_data_' + container_dir[len(CONTAINER_PREFIX):].replace('-', '_')
    header = (TEMPLATES / 'header.lua').read_text().replace('__MATERIAL_LB_KEY__', key).replace(
        '__MATERIAL_LB_HEADER_DATA__', container_dir + '/header-data.json')
    header = header.replace('"' + FALLBACK + '"', q(fallback)).replace(
        '__MATERIAL_LB_MODELSCOPE_BASES__', lua_bases).replace('__MATERIAL_LB_OPENI_ONLY__', lua_exceptions)
    header = header.replace('__MATERIAL_LB_OSS_PATH_PREFIX__', q(prefix)).replace(
        '__MATERIAL_LB_MIRRORS__', '{' + ', '.join('[' + q(mirror) + '] = true'
            for mirror in openi.get('mirrorReleases', [release])) + '}')
    return {'routes.json': (json.dumps(data, separators=(',', ':')) + '\n').encode(),
            'access.lua': access.encode(), 'header.lua': header.encode(),
            'header-data.json': (json.dumps(header_data, separators=(',', ':')) + '\n').encode()}


def write_output(files, output):
    require(not output.exists() and not output.is_symlink(), 'output already exists')
    repo = Path(__file__).resolve().parents[3]
    resolved = output.resolve()
    if resolved.is_relative_to(repo):
        require(any(resolved.is_relative_to(repo / p) for p in ('deploy/stardust/build', '.cache/stardust')), 'output must be ignored')
    output.mkdir(mode=0o755, parents=True)
    for name, body in files.items():
        with (output / name).open('xb') as stream:
            stream.write(body)
        (output / name).chmod(0o644)
    return {name: hashlib.sha256(body).hexdigest() for name, body in files.items()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--openi-manifest', type=Path, required=True)
    parser.add_argument('--modelscope-manifest', type=Path, required=True)
    parser.add_argument('--container-dir', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--release')
    parser.add_argument('--modelscope-revision')
    parser.add_argument('--modelscope-prefix')
    parser.add_argument('--modelscope-allowed-prefix', action='append', dest='model_prefixes',
                        help='complete immutable prefix whitelist, primary first; must match manifest prefixes')
    parser.add_argument('--openi-only-path', action='append', default=[], dest='openi_only_paths',
                        help='explicit authorized single alias; must match manifest openiOnlyPaths')
    args = parser.parse_args()
    try:
        pins = (args.release, args.modelscope_revision, args.modelscope_prefix)
        require(all(pins) or not any(pins), 'new profile requires all three pins')
        profile = dict(release=pins[0], model_revision=pins[1], model_prefix=pins[2]) if all(pins) else {}
        openi = json.loads(args.openi_manifest.read_text())
        models = json.loads(args.modelscope_manifest.read_text())
        files = render(openi, models, args.container_dir, model_prefixes=args.model_prefixes,
                       openi_only_paths=args.openi_only_paths, **profile)
        hashes = write_output(files, args.out)
        print(json.dumps({'prepared': True, 'activated': False, 'out': str(args.out), 'filesSha256': hashes}))
    except (OSError, ValueError, TypeError, KeyError):
        print(json.dumps({'prepared': False, 'activated': False, 'error': 'invalid profile, input or output'}))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
