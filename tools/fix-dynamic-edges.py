#!/usr/bin/env python3
"""Repair the page edges of the 动态立绘 whose colour and alpha disagree (2026-11-06, the dashes on 归溟幽灵鲨's face).

These pages are premultiplied (manifest `pma: true`) but lossy: around each attachment, colour runs wider or brighter than
alpha allows. Drawn as they are, those pixels add light, so the seams of the mouth, nose and eyes turn into bright dots;
drawn as straight alpha, the same seams turn into dark dashes. For every pixel of the page:
  - alpha 0: RGB 0 too (it is block noise, and alpha raised from it would make opaque squares);
  - a semi-transparent pixel that is a dimmed copy of the even, bright opaque pixels around it, and brighter than its alpha
    allows (a seam): its coverage is how far it is dimmed, so alpha rises to that and its colour becomes exactly those
    pixels' colour at that alpha. Over skin of the same colour such a pixel then cannot show at all;
  - any other pixel: alpha rises to max(R, G, B), the least that makes it valid premultiplied colour.
A pixel darker than its alpha allows, or beside uneven colour, is left alone: that is a line, and its soft edge stays soft.
Do not run this over the other premultiplied pages: they are clean.

The results get their own names, `<page>.edge.<ext>` and `<stem>.edge.atlas` (the same atlas, its page lines renamed), so a
client on an older manifest keeps the files it knows. data/assets.json names them.

  python3 tools/fix-dynamic-edges.py <assets root> <out root> [skin id …]    # e.g. public/assets; the out root is laid out the same
"""
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

SKINS = {
    'char_1023_ghost2_boc_6': 'dyn_illust_char_1023_ghost2_boc__6',
    'char_350_surtr_summer_9': 'dyn_illust_char_350_surtr_summer__9',
    'char_4055_bgsnow_wild_7': 'dyn_illust_char_4055_bgsnow_wild__7',
    'char_472_pasngr_epoque_17': 'dyn_illust_char_472_pasngr_epoque__17',
    'char_1014_nearl2_epoque_17': 'dyn_illust_char_1014_nearl2_epoque__17',
    'char_2014_nian_nian_4': 'dyn_illust_char_2014_nian_nian__4',
    'char_1013_chen2_boc_6': 'dyn_illust_char_1013_chen2_boc__6',
    'char_2015_dusk_nian_7': 'dyn_illust_char_2015_dusk_nian__7',
    'char_250_phatom_sale_4': 'dyn_illust_char_250_phatom_sale__4',
    'char_322_lmlee_witch_3': 'dyn_illust_char_322_lmlee_witch__3',
    'char_391_rosmon_epoque_17': 'dyn_illust_char_391_rosmon_epoque__17',
}
PAGE_LINE = re.compile(r'^(\S+)\.(png|webp)$', re.M)
OPAQUE = 240     # alpha from which a pixel counts as solid colour
RADIUS = 2       # how far a seam reaches from the solid colour
TOLERANCE = 32   # how far (per channel, 0-255) a pixel may be from a dimmed copy of its neighbours
BRIGHT = 96      # neighbours darker than this say nothing: the ratio of two small numbers is noise
EVEN = 24        # the most the neighbours' brightness may spread (standard deviation, 0-255): more means a line runs there


def box_sum(values, r=RADIUS):
    """The sum over the (2r+1)² square around each pixel."""
    pad = np.pad(values, r, mode='constant').astype(np.float64)
    for axis in (0, 1):
        c = np.cumsum(pad, axis=axis)
        hi = np.take(c, range(2 * r, c.shape[axis]), axis=axis)
        lo = np.take(c, range(0, c.shape[axis] - 2 * r), axis=axis)
        pad = hi - np.concatenate([np.zeros_like(np.take(c, [0], axis=axis)), np.take(lo, range(0, lo.shape[axis] - 1), axis=axis)], axis=axis)
    return pad


def fix_pixels(p):
    """An RGBA array (uint8) → the repaired copy."""
    p = p.copy()
    p[p[..., 3] == 0] = 0
    alpha, rgb = p[..., 3], p[..., :3].astype(np.float64)
    bright = rgb.max(axis=2)
    solid = alpha >= OPAQUE
    count = box_sum(solid)
    seam = (alpha > 0) & ~solid & (count > 0)
    around = np.zeros(rgb.shape)
    for c in range(3):
        around[seam, c] = (box_sum(rgb[..., c] * solid)[seam]) / count[seam]
    near = around.max(axis=2)
    dim = np.zeros(bright.shape)
    spread = np.zeros(bright.shape)
    spread[seam] = box_sum(bright * bright * solid)[seam] / count[seam] - (box_sum(bright * solid)[seam] / count[seam]) ** 2
    usable = seam & (near >= BRIGHT) & (spread <= EVEN * EVEN)
    dim[usable] = np.minimum(bright[usable] / near[usable], 1)
    cover = np.round(dim * 255)
    copy = usable & (bright <= near) & (cover > alpha) & (np.abs(rgb - around * dim[..., None]).max(axis=2) <= TOLERANCE)
    out = np.maximum(alpha, bright)
    out[copy] = cover[copy]
    p[..., 3] = np.clip(out, 0, 255).astype(np.uint8)
    p[copy, :3] = np.clip(np.round(around[copy] * (cover[copy, None] / 255)), 0, 255).astype(np.uint8)
    return p


def save(array, dst):
    image = Image.fromarray(array, 'RGBA')
    if dst.suffix == '.webp':
        image.save(dst, lossless=True, quality=100, method=6, exact=True)
    else:
        image.save(dst, compress_level=9)


def main(root, out, only):
    for skin, stem in SKINS.items():
        if only and skin not in only:
            continue
        src, dst = Path(root, 'skins', skin, 'dynamic'), Path(out, 'skins', skin, 'dynamic')
        dst.mkdir(parents=True, exist_ok=True)
        atlas = (src / f'{stem}.atlas').read_text(encoding='utf-8')
        pages = PAGE_LINE.findall(atlas)
        if not pages:
            raise SystemExit(f'{skin}: no page in its atlas')
        for page, ext in pages:
            save(fix_pixels(np.asarray(Image.open(src / f'{page}.{ext}').convert('RGBA'))), dst / f'{page}.edge.{ext}')
        (dst / f'{stem}.edge.atlas').write_text(PAGE_LINE.sub(r'\1.edge.\2', atlas), encoding='utf-8', newline='\n')
        print(skin, len(pages), 'pages')


if __name__ == '__main__':
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2], set(sys.argv[3:]))
