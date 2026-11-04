"""Registry tools/assets/char-illustrations.json + a staging asset tree from the box results.
argv: box-results(glob prefix) provenance.json jobs.json hd_out_dir stage_dir registry_out [min_psnr] [min_hd_gain] [check.json] [misses.json] [no-hd.json]"""
import glob, hashlib, json, os, shutil, sys
from urllib.parse import unquote
res = {}
for f in sorted(glob.glob(sys.argv[1] + '*.json')): res.update(json.load(open(f, encoding='utf-8')))
prov = json.load(open(sys.argv[2], encoding='utf-8'))
jobs = {j['key']: j for j in json.load(open(sys.argv[3], encoding='utf-8'))}
HDOUT = os.path.realpath(sys.argv[4]); stage = os.path.realpath(sys.argv[5]); out = sys.argv[6]
MIN = float(sys.argv[7]) if len(sys.argv) > 7 else 18.0; GAIN = float(sys.argv[8]) if len(sys.argv) > 8 else 1.0
CHECK = json.load(open(sys.argv[9])) if len(sys.argv) > 9 else {}
# looks whose box is wrong, confirmed by eye (side-by-side renders): NCC / inlier scores alone also flag correct matches
# where the 立绘 draws effects or scenery over the character
MISSES = set(json.load(open(sys.argv[10]))) if len(sys.argv) > 10 else set()
# looks kept on their in-game portrait by default although matched (e.g. official effects drawn over the character): box only
NOHD = set(json.load(open(sys.argv[11]))) if len(sys.argv) > 11 else set()
def sha256(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()
def place(src, rel):
    dst = os.path.join(stage, rel); os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.exists(dst): os.remove(dst)
    os.link(src, dst)
reg = {'version': 1, 'minHdGain': GAIN, 'source': 'PRTS 立绘 (prts.wiki 文件:立绘 <干员> <1|2>.png; skins: the skin import\'s 立绘 <干员> skinN.png), sha1-checked against the PRTS API',
       'generator': 'tools/assets/hd-art (fork hd30, 2026-11-04)', 'minPsnr': MIN, 'chars': {}, 'skins': {}}
low = []; nohd = []
for key, r in sorted(res.items()):
    if 'error' in r or 'hdSize' not in r: low.append((key, r)); continue
    if r['psnr'] < MIN: low.append((key, r['psnr'])); continue
    j = jobs[key]; hd_src = os.path.join(HDOUT, j['hd'])
    if key in MISSES: low.append((key, 'miss')); continue
    hd_src = os.path.realpath(hd_src)
    look = {'box': r['box'], 'gain': round(r['box'][2] / 180, 3), 'psnr': r['psnr'], **({'ncc': CHECK[key]['ncc'], 'inlier': CHECK[key]['inlier']} if key in CHECK else {}),
            **({'scene': True} if r.get('scene') or r.get('bgShare', 0) > 0.05 else {})}
    # the native crop only where it is at least as detailed as the in-game portrait (gain >= GAIN): never coarser than today
    if r['box'][2] >= GAIN * 180 and key not in NOHD:
        look['hd'] = {'size': r['hdSize'], 'bytes': os.path.getsize(hd_src), 'sha256': sha256(hd_src)}
        place(hd_src, j['hd'])
    else: nohd.append(key)
    if key.startswith('char:'):
        cid, ph = key[5:].rsplit('_', 1)
        p = prov[f'{cid}_{ph}']
        prefix = 'collab/' if j['hd'].startswith('collab/') else ''
        rel = f'{prefix}char/illustration/{cid}_{ph}.png'
        place(j['illustration'], rel)
        look['illustration'] = {'size': r['size'], 'bytes': os.path.getsize(j['illustration']), 'sha256': sha256(j['illustration']),
                                'source': {'file': unquote(p['url'].rsplit('/', 1)[1]), 'url': p['url'], 'sha1': p['sha1'], 'variant': p['variant']}}
        reg['chars'].setdefault(cid, {})['e1' if ph == '1' else 'e2'] = look
    else:
        sid = key[5:]
        look['illustration'] = {'size': r['size']}
        reg['skins'][sid] = look
json.dump(reg, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1, sort_keys=True); open(out, 'a').write('\n')
from collections import Counter
print('excluded by reason', dict(Counter(x[1] if isinstance(x[1], str) else 'psnr/error' for x in low)))
print('looks without portraitHD (gain < %.2f)' % GAIN, len(nohd))
print('chars', len(reg['chars']), 'char looks', sum(len(v) for v in reg['chars'].values()), 'skins', len(reg['skins']), 'below/failed', len(low))
for x in low[:30]: print('  ', x)
