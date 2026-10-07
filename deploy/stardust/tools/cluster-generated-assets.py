#!/usr/bin/env python3
"""Validate required generated renderer metadata before exporting a cluster image."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat

INDEX = 'data/local-assets.json'
LIMIT = 4 * 1024 * 1024
SEGMENT = re.compile(r'[A-Za-z0-9_\[\]-][A-Za-z0-9_.\[\]-]*')


class Refused(Exception):
    """A missing index must fail the release, not select procedural terrain."""


def read_regular(root, relative, *, limit=LIMIT):
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
        if identity(before) != identity(after) or not raw or len(raw) > limit:
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
    if not isinstance(atlas, dict) or atlas.get('path') != '/assets/local/map/autochess/TX_autochessi_D.png' \
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
            read_regular(root, relative)
    except OSError:
        raise Refused('renderer index references missing resource') from None
    return {'path': INDEX, 'bytes': raw, 'sha256': hashlib.sha256(raw).hexdigest(),
            'resourceReferences': len(references), 'kind': 'generated-renderer-data'}
