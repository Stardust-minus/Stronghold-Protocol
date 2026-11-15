"""Download PRTS files sequentially, verifying size + sha1. argv: jobs.json outdir. jobs: [{"rel","url","size","sha1"}]"""
import hashlib, json, os, sys, time, urllib.error, urllib.parse, urllib.request
jobs = json.load(open(sys.argv[1], encoding='utf-8')); out = os.path.realpath(sys.argv[2])
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
# prts.wiki / media.prts.wiki answer 403 to a client without browser-like headers (2026-11-15); 403 / 429 end the run (no retry)
HEADERS = {'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'zh-CN,zh;q=0.9'}
ok = skip = bad = 0
for j in jobs:
    u = urllib.parse.urlsplit(j['url'])
    if u.scheme != 'https' or u.hostname != 'media.prts.wiki': raise SystemExit(f"untrusted url {j['url']}")
    dst = os.path.realpath(os.path.join(out, j['rel']))
    if not dst.startswith(out + os.sep): raise SystemExit('path escape')
    if os.path.exists(dst) and os.path.getsize(dst) == j['size'] and hashlib.sha1(open(dst, 'rb').read()).hexdigest() == j['sha1']:
        skip += 1; continue
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(j['url'], headers=HEADERS), timeout=60) as r:
                b = r.read(32 * 1024 * 1024 + 1)
            if len(b) != j['size'] or hashlib.sha1(b).hexdigest() != j['sha1'] or b[:8] != b'\x89PNG\r\n\x1a\n': raise ValueError('integrity')
            open(dst + '.part', 'wb').write(b); os.replace(dst + '.part', dst); ok += 1; break
        except urllib.error.HTTPError as e:
            if e.code in (403, 429): raise SystemExit(f'media.prts.wiki answered {e.code}: stop (no retry)')
            time.sleep(3 * (attempt + 1))
        except Exception as e:
            time.sleep(3 * (attempt + 1))
    else:
        bad += 1; print('FAILED', j['rel'], j['url'])
    time.sleep(0.25)
print('ok', ok, 'skip', skip, 'failed', bad)
