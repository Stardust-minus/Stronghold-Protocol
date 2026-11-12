"""Self-contained HTML evaluation pages (inline CSS / SVG, no scripts or external assets) and their index.
python eval_report.py --www www/eval --name ppo2-5M --title "..." --run ppo2=path.json [--run ...]
       [--ref 规则版legacy=path.json] [--live 线上legacy=path.json]
Per config: win rate (Wilson 95 %), paired differences against each baseline (fa: mean / IQM / bootstrap 95 %;
win: McNemar; survival), survival histogram, LP, human seats, rule counts, round trips. index.html lists pages newest first."""
import argparse, html, json, os, time
import numpy as np
from stats import wilson, mcnemar_p, iqm, paired_bootstrap

DIFF_ZH = {'FUNNY': '娱乐', 'NORMAL': '普通', 'HARD': '困难', 'ABYSS': '终极'}
CSS = """body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:24px;color:#1f2328;background:#fff;max-width:1180px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:26px 0 8px;border-bottom:1px solid #d0d7de;padding-bottom:4px}
.meta{color:#59636e;font-size:12px}table{border-collapse:collapse;font-size:12.5px;margin:6px 0}
td,th{border:1px solid #d0d7de;padding:3px 7px;text-align:right;white-space:nowrap}th{background:#f6f8fa;font-weight:600}
td.l,th.l{text-align:left}.pos{color:#1a7f37;font-weight:600}.neg{color:#cf222e;font-weight:600}.dim{color:#8c959f}
.row{display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start}.note{font-size:12px;color:#59636e;margin:4px 0 10px}
@media (prefers-color-scheme: dark){body{background:#0d1117;color:#e6edf3}th{background:#161b22}td,th{border-color:#30363d}
h2{border-color:#30363d}.meta,.note{color:#9198a1}}"""
PALETTE = ['#2f6fdd', '#d4762c', '#7a52c9', '#2a9d8f', '#c94f7c', '#6b8e23']


def cfg_zh(cfg):
    mode, diff = cfg.split(':')
    m = '单人' if mode == 'solo' else f'同盟 {mode[4:] or 4} 人'
    return f'{m} · {DIFF_ZH.get(diff, diff)}'


def fmt(x, d=3, sign=False):
    if x is None or (isinstance(x, float) and not np.isfinite(x)):
        return '–'
    return f'{x:+.{d}f}' if sign else f'{x:.{d}f}'


def cls(lo, hi):
    return 'pos' if lo > 0 else 'neg' if hi < 0 else ''


def hist_svg(series, w=360, h=120):
    """Survival-round histogram (per match, AI seats' mean survival floored), one bar group per round 1–15."""
    rounds = list(range(1, 16)); n = len(series)
    counts = [[0] * 15 for _ in range(n)]
    for j, (_, vals) in enumerate(series):
        for v in vals:
            r = min(15, max(1, int(np.floor(v + 1e-9))))
            counts[j][r - 1] += 1
        tot = max(1, len(vals)); counts[j] = [c / tot for c in counts[j]]
    top = max(0.05, max(max(c) for c in counts)) if n else 1
    pad_l, pad_b = 26, 18; cw = (w - pad_l - 4) / 15; bw = cw / max(1, n) * 0.85
    out = [f'<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img"><title>存活回合分布</title>']
    for i, r in enumerate(rounds):
        x0 = pad_l + i * cw
        out.append(f'<text x="{x0 + cw / 2:.1f}" y="{h - 4}" font-size="9" text-anchor="middle" fill="currentColor">{r}</text>')
        for j in range(n):
            bh = (h - pad_b - 6) * counts[j][i] / top
            out.append(f'<rect x="{x0 + j * bw + 1:.1f}" y="{h - pad_b - bh:.1f}" width="{bw:.1f}" height="{bh:.1f}" fill="{PALETTE[j % len(PALETTE)]}">'
                       f'<title>{html.escape(series[j][0])} 第{r}回合 {counts[j][i]:.0%}</title></rect>')
    out.append(f'<text x="2" y="10" font-size="9" fill="currentColor">{top:.0%}</text>')
    out.append(f'<line x1="{pad_l}" y1="{h - pad_b}" x2="{w - 4}" y2="{h - pad_b}" stroke="currentColor" stroke-width="0.5"/></svg>')
    legend = ' '.join(f'<span style="color:{PALETTE[j % len(PALETTE)]}">■</span> {html.escape(s[0])}' for j, s in enumerate(series))
    return ''.join(out) + f'<div class="note">{legend}</div>'


def paired(a, b):
    ma = {m['seed']: m for m in a['perMatch']}; mb = {m['seed']: m for m in b['perMatch']}
    seeds = sorted(set(ma) & set(mb)); n = len(seeds)
    if not n:
        return None
    fa = np.array([mb[s].get('faShare', 0) - ma[s].get('faShare', 0) for s in seeds])
    sv = np.array([mb[s]['rlSurvival'] - ma[s]['rlSurvival'] for s in seeds])
    oa = sum(1 for s in seeds if ma[s]['win'] and not mb[s]['win']); ob = sum(1 for s in seeds if mb[s]['win'] and not ma[s]['win'])
    return {'n': n, 'dwin': (sum(mb[s]['win'] for s in seeds) - sum(ma[s]['win'] for s in seeds)) / n, 'onlyRef': oa, 'onlyRun': ob,
            'p': mcnemar_p(oa, ob), 'fa': float(fa.mean()), 'faIQM': iqm(fa), 'faCI': paired_bootstrap(fa),
            'sv': float(sv.mean()), 'svCI': paired_bootstrap(sv, seed=1)}


def page(title, runs, refs, meta_note):
    cfgs = []
    for _, r in runs + refs:
        for c in r['configs']:
            if c not in cfgs:
                cfgs.append(c)
    body = [f'<h1>{html.escape(title)}</h1><div class="meta">{html.escape(meta_note)} · 生成于 {time.strftime("%Y-%m-%d %H:%M")}</div>',
            '<div class="note">终极的主指标是 fa（第 14 回合最终攻势首领血池被打掉的比例，按种子配对）：均值、IQM（去掉上下各 25% 的均值）、'
            '95% 配对 bootstrap 区间。胜率是辅助指标：Wilson 95% 区间，配对胜负用精确 McNemar 检验。绿色 = 区间整体高于参照，红色 = 整体低于参照。</div>']
    for cfg in cfgs:
        body.append(f'<h2>{cfg_zh(cfg)} <span class="dim">({cfg})</span></h2>')
        rows = ['<tr><th class="l">对象</th><th>局数</th><th>胜率</th><th>95% 区间</th><th>fa</th><th>AI 存活</th><th>AI LP</th>'
                '<th>真人存活</th><th>真人主盟约档</th><th>抢主盟约/局</th><th>抢合成/局</th><th>规则违规</th><th>同名往返/准备</th><th>错误</th></tr>']
        series = []
        for name, r in refs + runs:
            c = r['configs'].get(cfg)
            if not c:
                continue
            k = sum(m['win'] for m in c['perMatch']) if c.get('perMatch') else round(c['teamWin'] * c['matches'])
            lo, hi = wilson(k, c['matches'])
            rl, ai, hu = c['roles'].get('rl', {}), c['ai'].get('rl', {}), c['roles'].get('human-legacy', {})
            rows.append(f'<tr><td class="l">{html.escape(name)}</td><td>{c["matches"]}</td><td>{c["teamWin"]:.3f}</td><td>[{lo:.3f}, {hi:.3f}]</td>'
                        f'<td>{fmt(c.get("faShare"))}</td><td>{fmt(rl.get("survival"), 2)}</td><td>{fmt(rl.get("lp"), 1)}</td>'
                        f'<td>{fmt(hu.get("survival"), 2)}</td><td>{fmt(hu.get("humanMainTier"), 2)}</td>'
                        f'<td>{fmt(ai.get("yieldMainPerMatch"), 2)}</td><td>{fmt(ai.get("yieldMergePerMatch"), 2)}</td>'
                        f'<td>{int(ai.get("violations", 0)) if name not in dict(refs) or "规则" in name else "–"}</td>'
                        f'<td>{fmt(ai.get("roundTripsPerPrep"))}</td><td>{c.get("errors", 0)}</td></tr>')
            if c.get('perMatch'):
                series.append((name, [m['rlSurvival'] for m in c['perMatch']]))
        body.append('<div class="row"><div><table>' + ''.join(rows) + '</table></div>' + (f'<div>{hist_svg(series)}</div>' if series else '') + '</div>')
        prow = ['<tr><th class="l">对象</th><th class="l">参照</th><th>配对种子</th><th>fa 差</th><th>fa IQM 差</th><th>fa 95% 区间</th>'
                '<th>胜率差</th><th>只参照赢 / 只本方赢</th><th>McNemar p</th><th>存活差</th><th>存活 95% 区间</th></tr>']
        for name, r in runs:
            c = r['configs'].get(cfg)
            for rname, ref in refs:
                rc = ref['configs'].get(cfg)
                if not c or not rc or not c.get('perMatch') or not rc.get('perMatch'):
                    continue
                d = paired(rc, c)
                if not d:
                    continue
                prow.append(f'<tr><td class="l">{html.escape(name)}</td><td class="l">{html.escape(rname)}</td><td>{d["n"]}</td>'
                            f'<td class="{cls(*d["faCI"])}">{fmt(d["fa"], 3, True)}</td><td>{fmt(d["faIQM"], 3, True)}</td>'
                            f'<td>[{fmt(d["faCI"][0], 3, True)}, {fmt(d["faCI"][1], 3, True)}]</td><td>{fmt(d["dwin"], 3, True)}</td>'
                            f'<td>{d["onlyRef"]} / {d["onlyRun"]}</td><td class="{"pos" if d["p"] < 0.05 and d["dwin"] > 0 else "neg" if d["p"] < 0.05 else ""}">{d["p"]:.3g}</td>'
                            f'<td class="{cls(*d["svCI"])}">{fmt(d["sv"], 2, True)}</td><td>[{fmt(d["svCI"][0], 2, True)}, {fmt(d["svCI"][1], 2, True)}]</td></tr>')
        if len(prow) > 1:
            body.append('<table>' + ''.join(prow) + '</table>')
        elif refs:
            body.append('<div class="note">没有可配对的逐局记录（旧格式的评估文件），只列出总量。</div>')
    return (f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{html.escape(title)}</title><style>{CSS}</style></head><body>' + ''.join(body) + '<p class="note"><a href="index.html">← 全部评估</a></p></body></html>')


def write_index(www):
    man = os.path.join(www, 'index.json')
    items = json.load(open(man)) if os.path.exists(man) else []
    items.sort(key=lambda x: x['time'], reverse=True)
    rows = ''.join(f'<tr><td class="l"><a href="{html.escape(x["file"])}">{html.escape(x["title"])}</a></td><td class="l">{html.escape(x.get("note", ""))}</td>'
                   f'<td>{time.strftime("%m-%d %H:%M", time.localtime(x["time"]))}</td></tr>' for x in items)
    open(os.path.join(www, 'index.html'), 'w').write(
        f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>评估报告</title><style>{CSS}</style></head><body>'
        f'<h1>评估报告</h1><div class="meta">同种子评估，最新在前</div><table><tr><th class="l">评估</th><th class="l">说明</th><th>时间</th></tr>{rows}</table></body></html>')


def add(www, name, title, runs, refs, note=''):
    os.makedirs(www, exist_ok=True)
    fn = f'{name}.html'
    open(os.path.join(www, fn), 'w').write(page(title, runs, refs, note))
    man = os.path.join(www, 'index.json')
    items = [x for x in (json.load(open(man)) if os.path.exists(man) else []) if x['file'] != fn]
    items.append({'file': fn, 'title': title, 'note': note, 'time': time.time()})
    json.dump(items, open(man, 'w'), ensure_ascii=False, indent=0)
    write_index(www)
    return os.path.join(www, fn)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--www', required=True); ap.add_argument('--name', required=True); ap.add_argument('--title', required=True)
    ap.add_argument('--note', default='')
    ap.add_argument('--run', action='append', default=[], help='label=path (evaluated runs)')
    ap.add_argument('--ref', action='append', default=[], help='label=path (baselines; paired against every run)')
    a = ap.parse_args()
    load = lambda xs: [(k, json.load(open(v))) for k, v in (x.split('=', 1) for x in xs) if os.path.exists(v)]
    print(add(a.www, a.name, a.title, load(a.run), load(a.ref), a.note))
