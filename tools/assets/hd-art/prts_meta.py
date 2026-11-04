"""PRTS imageinfo for 立绘 / 半身像 {name} 1|2.png of every operator (metadata only). argv: names.json chars.json out.json"""
import json, sys, time, urllib.parse, urllib.request
names = json.load(open(sys.argv[1], encoding='utf-8'))
want = json.load(open(sys.argv[2], encoding='utf-8'))   # charId -> {"e2": bool}
UA = 'stronghold-assets/1.0 (fan remake asset check)'
titles = []
for cid, info in want.items():
    n = names[cid]
    for kind in ('立绘', '半身像'):
        for ph in ('1', '2') if info['e2'] else ('1',):
            titles.append((cid, kind, ph, f'文件:{kind} {n} {ph}.png'))
out = {}
def query(batch):
    q = urllib.parse.urlencode({'action': 'query', 'format': 'json', 'prop': 'imageinfo', 'iiprop': 'url|size|sha1',
                                'titles': '|'.join(t[3] for t in batch)})
    for attempt in range(4):
        try:
            req = urllib.request.Request('https://prts.wiki/api.php?' + q, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception as e:
            time.sleep(3 * (attempt + 1)); err = e
    raise err
for i in range(0, len(titles), 40):
    batch = titles[i:i + 40]
    d = query(batch)
    norm = {x['from']: x['to'] for x in d.get('query', {}).get('normalized', [])}
    pages = {p['title']: p for p in d.get('query', {}).get('pages', {}).values()}
    for cid, kind, ph, t in batch:
        p = pages.get(norm.get(t, t)) or {}
        ii = (p.get('imageinfo') or [None])[0]
        out.setdefault(cid, {})[f'{kind}{ph}'] = ii and {k: ii[k] for k in ('url', 'size', 'width', 'height', 'sha1')}
    time.sleep(1.0)
json.dump(out, open(sys.argv[3], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
miss = {c: [k for k, v in d.items() if not v] for c, d in out.items() if any(not v for v in d.values())}
print('operators', len(out), 'titles', len(titles), 'missing', sum(len(v) for v in miss.values()))
for c, ks in list(miss.items())[:40]: print(' miss', c, names[c], ks)
