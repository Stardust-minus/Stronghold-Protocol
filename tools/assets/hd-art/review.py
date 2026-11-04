"""Accept or reject every box and draw the review sheets. A look is accepted when PSNR >= P0, or else when the gradient NCC
(an independent, colour-blind check: check_boxes.py `grad`) >= G0; failing both = a miss (it keeps today's portrait).
Thresholds calibrated on looks verified by eye (rel30, 11-04): misses scored PSNR <= 13.2 and grad <= 0.067; correct
low-PSNR looks (effects / scenery over the character) grad >= 0.136.
argv: box-all-prefix check-all.json [box-retry.json check-retry.json] jobs.json hd_out hd_out_retry out_dir [P0 G0 N]
Writes out_dir/box-final.json, check-final.json, misses.json and review-low-<k>.png (N lowest-scoring accepted looks)."""
import glob, json, os, shutil, sys
import numpy as np
from PIL import Image, ImageDraw
a = sys.argv[1:]
box = {}
for f in sorted(glob.glob(a[0] + '*.json')): box.update(json.load(open(f, encoding='utf-8')))
chk = json.load(open(a[1]))
rbox = json.load(open(a[2])) if a[2] != '-' and os.path.exists(a[2]) else {}
rchk = json.load(open(a[3])) if a[3] != '-' and os.path.exists(a[3]) else {}
jobs = {j['key']: j for j in json.load(open(a[4]))}
HDOUT, HDRETRY, OUT = a[5], a[6], a[7]
P0 = float(a[8]) if len(a) > 8 else 18.0; G0 = float(a[9]) if len(a) > 9 else 0.12; N = int(a[10]) if len(a) > 10 else 40
ok = lambda r, c: r and c and (r['psnr'] >= P0 or c['grad'] >= G0)
final, fchk, misses, used_retry = {}, {}, [], []
for k, r in box.items():
    c = chk.get(k)
    if k in rbox and ok(rbox[k], rchk.get(k)) and not ok(r, c):
        r, c = rbox[k], rchk[k]; used_retry.append(k)
        src = os.path.join(HDRETRY, jobs[k]['hd'])
        if os.path.exists(src): dst = os.path.join(HDOUT, jobs[k]['hd']); os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.copyfile(src, dst)
    final[k] = r
    if c: fchk[k] = c
    if not ok(r, c): misses.append(k)
os.makedirs(OUT, exist_ok=True)
json.dump(final, open(os.path.join(OUT, 'box-final.json'), 'w'), indent=0)
json.dump(fchk, open(os.path.join(OUT, 'check-final.json'), 'w'), indent=0)
json.dump(sorted(misses), open(os.path.join(OUT, 'misses.json'), 'w'), indent=0)
acc = [k for k in final if k not in misses]
print('looks', len(final), 'accepted', len(acc), 'misses', len(misses), 'from retry', used_retry)
print('accepted by psnr', sum(1 for k in acc if final[k]['psnr'] >= P0), 'by grad only', sum(1 for k in acc if final[k]['psnr'] < P0))
for k in sorted(misses): print('  miss', k, {x: fchk.get(k, {}).get(x) for x in ('psnr', 'grad', 'ncc', 'inlier', 'w')})
# the lowest-scoring accepted: by PSNR (the primary signal), each scored also by grad
low = sorted(acc, key=lambda k: (final[k]['psnr'], fchk.get(k, {}).get('grad', 0)))[:N]
def panel(img):
    bg = Image.new('RGBA', (180, 360), (60, 60, 60, 255)); bg.alpha_composite(img.convert('RGBA').resize((180, 360), Image.LANCZOS)); return bg
per = 10
for s in range(0, len(low), per):
    keys = low[s:s + per]; cols = 5
    sheet = Image.new('RGB', (cols * (3 * 180 + 30), ((len(keys) + cols - 1) // cols) * (360 + 34)), (30, 30, 30))
    d = ImageDraw.Draw(sheet)
    for i, k in enumerate(keys):
        j = jobs[k]; r = final[k]
        P = Image.open(j['portrait']).convert('RGBA')
        hd = os.path.join(HDOUT, j['hd'])
        if r['box'][2] >= 180 and os.path.exists(hd):
            H = Image.open(hd)   # what a default card shows: portraitHD (the cut-out for a scene look)
        else:
            Ill = Image.open(j['illustration']).convert('RGBA'); x, y, w = r['boxF']; W, Hh = Ill.size
            big = Image.new('RGBA', (W * 2, Hh * 2), (0, 0, 0, 0)); big.paste(Ill, (W // 2, Hh // 2))
            H = big.resize((180, 360), Image.LANCZOS, box=(x + W // 2, y + Hh // 2, x + W // 2 + w, y + Hh // 2 + 2 * w))
        pa, pb = panel(P), panel(H)
        diff = np.clip(np.abs(np.asarray(pa, dtype=np.int16)[..., :3] - np.asarray(pb, dtype=np.int16)[..., :3]) * 4, 0, 255).astype(np.uint8)
        cx, cy = (i % cols) * (3 * 180 + 30), (i // cols) * (360 + 34)
        sheet.paste(pa.convert('RGB'), (cx, cy + 30)); sheet.paste(pb.convert('RGB'), (cx + 180, cy + 30)); sheet.paste(Image.fromarray(diff, 'RGB'), (cx + 360, cy + 30))
        c = fchk.get(k, {})
        d.text((cx + 2, cy + 2), f"{k[5:][:34]}", fill=(255, 255, 255))
        d.text((cx + 2, cy + 15), f"psnr {r['psnr']} grad {c.get('grad')} gain {round(r['box'][2] / 180, 2)}{' scene' if r.get('bgShare', 0) > 0.05 else ''}", fill=(200, 200, 120))
    sheet.save(os.path.join(OUT, f'review-low-{s // per + 1}.png'), optimize=True)
print('sheets', (len(low) + per - 1) // per)
