"""Structural check of every box: masked NCC (luminance) and `inlier` — the share of the portrait's opaque pixels the
anti-aliased resample of the 立绘 at the box reproduces within 0.1 (premultiplied RGB). Effects or scenery the 立绘 draws
over the character lower NCC a lot but leave most pixels in place; a wrong place reproduces almost none. argv: box-results(glob prefix) jobs.json out.json"""
import glob, json, math, sys
import numpy as np
from PIL import Image
res = {}
for f in sorted(glob.glob(sys.argv[1] + '*.json')): res.update(json.load(open(f, encoding='utf-8')))
jobs = {j['key']: j for j in json.load(open(sys.argv[2], encoding='utf-8'))}
out = {}
for key, r in res.items():
    if 'boxF' not in r: continue
    j = jobs[key]; x, y, w = r['boxF']
    Ill = Image.open(j['illustration']).convert('RGBA'); P = Image.open(j['portrait']).convert('RGBA')
    W, H = Ill.size
    big = Image.new('RGBA', (W * 2, H * 2), (0, 0, 0, 0)); big.paste(Ill, (W // 2, H // 2))
    c = np.asarray(big.resize((180, 360), Image.LANCZOS, box=(x + W // 2, y + H // 2, x + W // 2 + w, y + H // 2 + 2 * w)), dtype=np.float64) / 255
    p = np.asarray(P, dtype=np.float64) / 255
    M = p[..., 3] > 0.9
    lum = lambda a: (0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]) * a[..., 3]
    a, b = lum(c)[M], lum(p)[M]
    a = a - a.mean(); b = b - b.mean()
    ncc = float((a * b).sum() / (math.sqrt((a * a).sum() * (b * b).sum()) + 1e-12))
    # independent of colour: edges. Sobel gradient magnitude of the premultiplied luminance, NCC on the opaque region
    def grad(L):
        gx = np.zeros_like(L); gy = np.zeros_like(L)
        gx[1:-1, 1:-1] = (L[:-2, 2:] + 2 * L[1:-1, 2:] + L[2:, 2:]) - (L[:-2, :-2] + 2 * L[1:-1, :-2] + L[2:, :-2])
        gy[1:-1, 1:-1] = (L[2:, :-2] + 2 * L[2:, 1:-1] + L[2:, 2:]) - (L[:-2, :-2] + 2 * L[:-2, 1:-1] + L[:-2, 2:])
        return np.hypot(gx, gy)
    ga, gb = grad(lum(c))[M], grad(lum(p))[M]
    ga = ga - ga.mean(); gb = gb - gb.mean()
    gncc = float((ga * gb).sum() / (math.sqrt((ga * ga).sum() * (gb * gb).sum()) + 1e-12))
    # silhouette agreement where the 立绘 has its own alpha (no scene): IoU of the opaque masks
    A = p[..., 3] > 0.5; B = c[..., 3] > 0.5
    iou = float((A & B).sum() / max(1, (A | B).sum()))
    pc = c[..., :3] * c[..., 3:]; pp = p[..., :3] * p[..., 3:]
    inl = float((np.abs(pc - pp).max(-1) < 0.1)[M].mean())
    out[key] = {'ncc': round(ncc, 4), 'grad': round(gncc, 4), 'iou': round(iou, 4), 'inlier': round(inl, 3), 'psnr': r['psnr'], 'w': r['box'][2], 'bg': r.get('bgShare')}
json.dump(out, open(sys.argv[3], 'w'), indent=0)
v = sorted(out.items(), key=lambda kv: kv[1]['inlier'])
print('checked', len(v), 'inlier<0.3', sum(1 for _, x in v if x['inlier'] < 0.3), 'inlier<0.5', sum(1 for _, x in v if x['inlier'] < 0.5))
for k, x in v[:25]: print(' ', k, x)
