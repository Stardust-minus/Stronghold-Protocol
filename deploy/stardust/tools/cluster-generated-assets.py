#!/usr/bin/env python3
"""Validate required generated renderer metadata before exporting a cluster image."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat

INDEX = 'data/local-assets.json'
# A code / data file read for the export. data/assets.json passed 4 MiB on 2026-11-16 (rel43: 4,206,433 B with the 名片-only
# skins and the 动态立绘 backdrops); 8 MiB, the per-file bound of cluster-private-code.py (MAX_FILE).
LIMIT = 8 * 1024 * 1024
# Referenced art: a 0.2.5 battlefield scene.bin reaches 6.5 MB (act2autochess_m01).
RESOURCE_LIMIT = 16 * 1024 * 1024
SEGMENT = re.compile(r'[A-Za-z0-9_\[\]-][A-Za-z0-9_.\[\]-]*')


class Refused(Exception):
    """A missing index must fail the release, not select procedural terrain."""


def read_regular(root, relative, *, limit=LIMIT, allow_empty=False):
    parts = Path(relative).parts
    if type(allow_empty) is not bool or (allow_empty and (not parts or parts[0] != 'node_modules' or '..' in parts)):
        raise Refused('only dependency files may be empty')
    path = Path(root) / relative
    for parent in (path, *path.parents):
        if parent.is_symlink():
            raise Refused('renderer resource symlink refused')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise Refused('regular single-link renderer resource required')
        with os.fdopen(fd, 'rb', closefd=False) as file:
            raw = file.read(limit + 1)
        after = os.fstat(fd)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if identity(before) != identity(after) or (not raw and not allow_empty) or len(raw) > limit:
            raise Refused('renderer resource changed or exceeds bound')
        return raw
    finally:
        os.close(fd)


def generated_renderer_data(root):
    """Return verified bytes; callers copy these bytes, not a second unchecked read.

    The generated index is intentionally ignored by Git, like game art. It belongs
    in the release's resource manifest, not in a claimed committed-source inventory.
    """
    try:
        raw = read_regular(root, INDEX)
        value = json.loads(raw)
    except (OSError, ValueError):
        raise Refused('generated renderer index required') from None
    if not isinstance(value, dict) or type(value.get('version')) is not int or value['version'] != 1 \
            or type(value.get('count')) is not int or value['count'] <= 0 or not isinstance(value.get('groups'), dict):
        raise Refused('generated renderer index schema refused')
    groups = value['groups']
    atlas = groups.get('map/autochess', {}).get('TX_autochessi_D')
    meshes = groups.get('mesh/map_autochess_bkg')
    if not isinstance(atlas, dict) or atlas.get('path') not in (
            '/assets/local/map/autochess/TX_autochessi_D.png',
            '/assets/local/map/autochess/TX_autochessi_D.webp') \
            or atlas.get('kind') != 'Texture2D' or not isinstance(meshes, dict) or not meshes:
        raise Refused('map atlas and mesh inventory required')
    references = set()
    entries = 0
    for records in groups.values():
        if not isinstance(records, dict):
            raise Refused('renderer group schema refused')
        for record in records.values():
            entries += 1
            if not isinstance(record, dict) or not isinstance(record.get('path'), str):
                raise Refused('renderer entry schema refused')
            path = record['path']
            if not path.startswith('/assets/local/') or any(not SEGMENT.fullmatch(part) or part in ('.', '..') for part in path[1:].split('/')):
                raise Refused('renderer entry path refused')
            references.add('public' + path)
    if entries != value['count']:
        raise Refused('renderer entry count mismatch')
    try:
        for relative in sorted(references):
            read_regular(root, relative, limit=RESOURCE_LIMIT)
    except OSError:
        raise Refused('renderer index references missing resource') from None
    return {'path': INDEX, 'bytes': raw, 'sha256': hashlib.sha256(raw).hexdigest(),
            'resourceReferences': len(references), 'kind': 'generated-renderer-data'}


FX_INDEX = 'data/local-fx.json'
FX_PREFIX = '/assets/local/fx/'


def generated_fx_data(root):
    """The official battle effects' file list (data/local-fx.json, 0.3.0 tools/local-extract/fx.py), or None when absent.

    Ignored by Git like the renderer index; the coordinator serves it as /data/local-fx.json (server/http/static.js) and
    the page shows 设置「官方特效」 and loads effects only when it names prefabs. The effect files themselves are art of the
    material sources (/assets/local/fx/…), not of the image, so only the list's schema and paths are checked here.
    """
    path = Path(root) / FX_INDEX
    if not os.path.lexists(path):
        return None
    try:
        raw = read_regular(root, FX_INDEX)
        value = json.loads(raw)
    except (OSError, ValueError):
        raise Refused('generated effects list unreadable') from None
    if not isinstance(value, dict) or type(value.get('version')) is not int or value['version'] != 1 \
            or value.get('format') != 'fx-manifest' or type(value.get('count')) is not int or value['count'] <= 0 \
            or not isinstance(value.get('groups'), dict):
        raise Refused('generated effects list schema refused')
    prefabs = value['groups'].get('fx/prefabs')
    if not isinstance(prefabs, dict) or not prefabs:
        raise Refused('effects list names no prefabs')
    entries = 0
    for records in value['groups'].values():
        if not isinstance(records, dict):
            raise Refused('effects group schema refused')
        for record in records.values():
            entries += 1
            if not isinstance(record, dict) or not isinstance(record.get('path'), str):
                raise Refused('effects entry schema refused')
            item = record['path']
            if not item.startswith(FX_PREFIX) or any(not SEGMENT.fullmatch(part) or part in ('.', '..') for part in item[1:].split('/')):
                raise Refused('effects entry path refused')
    if entries != value['count']:
        raise Refused('effects entry count mismatch')
    return {'path': FX_INDEX, 'bytes': raw, 'sha256': hashlib.sha256(raw).hexdigest(), 'entries': entries, 'kind': 'generated-fx-data'}
