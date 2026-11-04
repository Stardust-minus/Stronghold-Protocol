"""Where a 180x360 portrait sits inside its illustration (scale + offset): masked SSD on the portrait's opaque pixels (the
portrait is the character layer; a skin's illustration may carry an opaque scene behind it). Verified by masked PSNR of the
anti-aliased resample; also reports `bgShare`: the share of the portrait's transparent pixels where the illustration crop is
opaque (a scene the portrait does not show). Writes the native-resolution crop when asked.
argv: jobs.json out.json [hd_out_root]   jobs: [{"key","portrait","illustration","hd"(rel path or null)}]"""
import json, math, os, sys
import numpy as np
from PIL import Image

SCENE = 0.05  # share of the portrait's transparent pixels where the 立绘 is opaque: a scene

def rgba(img): return np.asarray(img.convert('RGBA'), dtype=np.float32) / 255.0

def corr(img, k, fs):
    """valid cross-correlation of img with kernel k (same dims), via FFT; returns map of shape img - k + 1"""
    H, W = img.shape; h, w = k.shape
    return np.fft.irfft2(np.fft.rfft2(img, fs) * np.conj(np.fft.rfft2(k, fs)), fs)[:H - h + 1, :W - w + 1]

def masked_ssd(Ic, Tc, M):
    """Ic: [C,H,W] image; Tc: [C,h,w] template; M: [h,w] mask (0/1). Mean squared error over the mask at every offset."""
    _, H, W = Ic.shape; h, w = M.shape
    if h > H or w > W: return None
    fs = (H + h, W + w); n = M.sum()
    tot = 0
    for c in range(Ic.shape[0]):
        I = Ic[c]; T = Tc[c] * M
        tot = tot + corr(I * I, M, fs) - 2 * corr(I, T, fs) + (T * T).sum()
    return tot / (n * Ic.shape[0])

def resize_stack(A, size):
    return np.stack([np.asarray(Image.fromarray(A[c].astype(np.float32), 'F').resize(size, Image.BOX if size[0] < A.shape[2] else Image.BILINEAR), dtype=np.float64) for c in range(A.shape[0])])

def features(a):
    """premultiplied-on-black RGB (the illustration's composite is what a crop shows) as 3 channels"""
    return np.transpose(a[..., :3] * a[..., 3:4], (2, 0, 1))

def find(P, Ill, rmin=0.05, rmax=0.95, cw=45):
    W, Hh = Ill.size
    p = rgba(P); M = (p[..., 3] > 0.9).astype(np.float64)
    Tf = features(p)
    pad = int(0.25 * W)
    If = np.pad(features(rgba(Ill)), ((0, 0), (pad, pad), (pad, pad)))
    Wp, Hp = W + 2 * pad, Hh + 2 * pad
    # coarse at 1/4: template 45x90
    T4 = resize_stack(Tf, (cw, 2 * cw)); M4 = (np.asarray(Image.fromarray(M.astype(np.float32), 'F').resize((cw, 2 * cw), Image.BOX)) > 0.99).astype(np.float64)
    pyr = [If]
    while pyr[-1].shape[2] > 400: pyr.append(resize_stack(pyr[-1], (pyr[-1].shape[2] // 2, pyr[-1].shape[1] // 2)))
    def scaled(size):
        src = next((L for L in reversed(pyr) if L.shape[2] >= size[0]), pyr[0])
        return resize_stack(src, size)
    best = (1e9, None); r = rmin
    while r <= rmax:
        s = float(cw) / (r * W)
        size = (max(cw + 1, int(round(Wp * s))), max(2 * cw + 1, int(round(Hp * s))))
        m = masked_ssd(scaled(size), T4, M4)
        if m is not None:
            y, x = np.unravel_index(np.argmin(m), m.shape)
            if m[y, x] < best[0]: best = (m[y, x], (r, x / s, y / s))
        r *= 1.04
    _, (r0, x0, y0) = best
    best = (1e9, None)
    for r in np.arange(r0 * 0.955, r0 * 1.0451, r0 * 0.0025):
        s = 180.0 / (r * W); mg = 20
        cx, cy = x0 * s, y0 * s
        size = (int(round(Wp * s)), int(round(Hp * s)))
        x1, y1 = max(0, int(cx) - mg), max(0, int(cy) - mg)
        # resize only the window region: crop the padded illustration first (in illustration px), then scale
        X0, Y0 = x1 / s, y1 / s; X1, Y1 = (x1 + 180 + 2 * mg) / s, (y1 + 360 + 2 * mg) / s
        win = np.stack([np.asarray(Image.fromarray(If[c].astype(np.float32), 'F').resize((180 + 2 * mg, 360 + 2 * mg), Image.BOX, box=(X0, Y0, min(X1, Wp), min(Y1, Hp))), dtype=np.float64) for c in range(3)])
        m = masked_ssd(win, Tf, M)
        if m is None: continue
        y, x = np.unravel_index(np.argmin(m), m.shape)
        if m[y, x] < best[0]:
            best = (m[y, x], (r, X0 + x / s - pad, Y0 + y / s - pad))
    mse, (r, bx, by) = best
    return mse, (bx, by, r * W)

def verify(P, Ill, box):
    x, y, w = box
    W, H = Ill.size
    big = Image.new('RGBA', (W * 2, H * 2), (0, 0, 0, 0)); big.paste(Ill.convert('RGBA'), (W // 2, H // 2))
    crop = big.resize((180, 360), Image.LANCZOS, box=(x + W // 2, y + H // 2, x + W // 2 + w, y + H // 2 + 2 * w))
    a = rgba(crop); b = rgba(P); M = b[..., 3] > 0.9
    pa = a[..., :3] * a[..., 3:]; pb = b[..., :3] * b[..., 3:]
    mse = ((pa - pb) ** 2)[M].mean()
    bg = float(((b[..., 3] < 0.1) & (a[..., 3] > 0.9)).sum() / max(1, (b[..., 3] < 0.1).sum()))
    return (99.0 if mse == 0 else 10 * math.log10(1 / mse)), bg

def main():
    jobs = json.load(open(sys.argv[1], encoding='utf-8')); out = {}
    if os.path.exists(sys.argv[2]): out = json.load(open(sys.argv[2], encoding='utf-8'))
    hd_root = os.path.realpath(sys.argv[3]) if len(sys.argv) > 3 else None
    if len(sys.argv) > 4:
        i, n = map(int, sys.argv[4].split('/')); jobs = jobs[i::n]
    for j in jobs:
        if j['key'] in out and out[j['key']].get('psnr') is not None and not j.get('force'): continue
        P = Image.open(j['portrait']); Ill = Image.open(j['illustration'])
        if P.size != (180, 360): out[j['key']] = {'error': f'portrait {P.size}'}; continue
        mse, (x, y, w) = find(P, Ill, j.get('rmin', 0.05), j.get('rmax', 0.95), j.get('cw', 45))
        psnr, bg = verify(P, Ill, (x, y, w))
        bx, by, bw = int(round(x)), int(round(y)), int(round(w))
        W, H = Ill.size
        rec = {'size': [W, H], 'boxF': [round(x, 2), round(y, 2), round(w, 2)], 'box': [bx, by, bw, 2 * bw],
               'fraction': [bx / W, by / H, bw / W, 2 * bw / H], 'psnr': round(psnr, 2), 'bgShare': round(bg, 3)}
        if hd_root and j.get('hd'):
            dst = os.path.realpath(os.path.join(hd_root, j['hd']))
            if not dst.startswith(hd_root + os.sep): raise SystemExit('path escape')
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            crop = Ill.convert('RGBA').crop((bx, by, bx + bw, by + 2 * bw))  # outside the 立绘 -> transparent
            if bg > SCENE:
                # a scene behind the character: keep the in-game silhouette (the portrait's alpha, upscaled) x the 立绘's alpha
                pa = np.asarray(P.convert('RGBA').getchannel('A').resize((bw, 2 * bw), Image.LANCZOS), dtype=np.float32)
                ca = np.asarray(crop.getchannel('A'), dtype=np.float32)
                crop.putalpha(Image.fromarray(np.clip(np.round(pa * ca / 255.0), 0, 255).astype(np.uint8), 'L'))
                rec['scene'] = True
            crop.save(dst + '.part.png', optimize=True)
            os.replace(dst + '.part.png', dst); rec['hdSize'] = [bw, 2 * bw]
        out[j['key']] = rec
        print(j['key'], rec['size'], rec['box'], 'psnr', rec['psnr'], 'bg', rec['bgShare'], flush=True)
        json.dump(out, open(sys.argv[2] + '.part', 'w', encoding='utf-8'), indent=0); os.replace(sys.argv[2] + '.part', sys.argv[2])
main()
