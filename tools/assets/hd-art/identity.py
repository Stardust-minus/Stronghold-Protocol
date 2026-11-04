"""For every operator look: which PRTS 半身像 variant ('base' 「<名字>」 or 'alt' 「<名字>(卫戍协议)」) equals the in-game
portrait (mean / max abs difference on premultiplied RGBA; PRTS's and the client dump's decodes differ by ~3/255).
argv: assets.json assets-collab.json roots.json dl-portrait-dir out.json
roots.json: [[url prefix, [local dirs…]], …] — where the in-game portraits are on disk."""
import json, os, sys
import numpy as np
from PIL import Image
m = json.load(open(sys.argv[1]))['chars']; c = json.load(open(sys.argv[2]))['chars']
ROOTS = json.load(open(sys.argv[3])); DL = sys.argv[4]
def local(p):
    for k, bases in ROOTS:
        if p.startswith(k):
            for b in bases:
                if os.path.exists(b + p[len(k):]): return b + p[len(k):]
            return None
def arr(p):
    a = np.asarray(Image.open(p).convert('RGBA'), dtype=np.int32)
    return np.concatenate([a[..., :3] * a[..., 3:] // 255, a[..., 3:]], -1)
res = {}
for cid, rec in {**m, **c}.items():
    for ph, field in (('1', 'portrait'), ('2', 'portraitE2')):
        if not rec.get(field): continue
        lp = local(rec[field])
        if not lp: res[f'{cid}_{ph}'] = {'error': 'no local portrait', 'path': rec[field]}; continue
        L = arr(lp); best = None
        for tag in ('alt', 'base'):
            q = os.path.join(DL, tag, f'{cid}_{ph}.png')
            if not os.path.exists(q): continue
            Q = arr(q)
            if Q.shape != L.shape: continue
            d = np.abs(L - Q); cand = (tag, int(d.max()), float(d.mean()))
            if best is None or cand[2] < best[2]: best = cand
        res[f'{cid}_{ph}'] = {'variant': best[0], 'maxdiff': best[1], 'meandiff': round(best[2], 3)} if best else {'error': 'no prts portrait'}
json.dump(res, open(sys.argv[5], 'w'), indent=0)
bad = {k: v for k, v in res.items() if v.get('error') or v['meandiff'] > 10}
print('looks', len(res), 'outside noise', len(bad)); [print(' ', k, v) for k, v in bad.items()]
