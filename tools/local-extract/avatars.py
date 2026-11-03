"""The official dynamic player avatars (rel27; owner 2026-11-03 「头像能也做成动态的吗，以及官方的一些动态头像。同样要求最高质量」).

display_meta_table playerAvatarData lists eight DYNAMIC avatars (avatar_dyn_01 … _08, dynAvatarId assets_avatar_dyn_NN;
our official avatar list already ships their static pictures, /assets/ui/playerAvatar/avatar_dyn_NN.png). The client
draws each from one UGUI prefab of arts/dynavatars_0.ab (assets_avatar_dyn_NN): a 180 × 180 RectTransform clipped by a
RectMask2D, holding
  - a Spine SkeletonGraphic (01–04, 07, 08): the holder spine_dyn_avatar_NN is filled at run time with the prefab
    spine_assets_avatar_dyn_NN — a Spine 3.8 JSON skeleton, one RGBA page, animation `loop`. Skeleton units are UI px
    (SkeletonDataAsset.scale 0.01 × the canvas' 100 px per unit) and the skeleton origin sits at the holder's centre:
    the holder's own position (every one: 0, 0). 02's prefab carries anchoredPosition (0, -90), which the client does
    not apply — drawn with it, 02 shows only the top of the head, while the official static picture (the whole box at
    150 / 180) matches the skeleton at the centre, as all six do; kept as `prefabOffset` for the record;
  - a UIParticle layer (02, 03, 04, 07, 08): Unity ParticleSystems drawn in the canvas over the skeleton;
  - or a frame sequence (05 「很调皮的狗」, 06 「很好奇的猫」): 150 × 150 sprites stretched over the box, switched by a legacy
    Animation clip's CanvasGroup alpha curves on the 60 Hz grid, looping.
Output (opt-in, `--only ui/avatar_dyn`) under <out>/ui/avatar_dyn/<avatarId>/, one manifest group per avatar
(ui/avatar_dyn/<avatarId>):
  - avatar.json — the descriptor the client reads (DESCRIPTOR below);
  - Spine: <stem>.json (the skeleton bytes as shipped), <stem>.atlas (normalize_atlas: real page sizes, no `pma`),
    <page>.png (straight RGBA as merge_alpha writes it, lossless);
  - particles: fx/prefabs/<avatarId>_fx.json + fx/tex/<key>.png (fx.Exporter: the battle effects' fx-prefab format,
    lossless PNG textures; fx/tex/half/ copies as for every fx texture), placed in the box's UI space;
  - sequences: <avatarId>.webp — the frames at their native 150 × 150, one lossless animated WebP (alpha kept, `exact`)
    with the clip's own timing.
Nothing here is drawn by default: without the group the page keeps the static picture.
"""
import json
import math
from pathlib import Path

SUB = 'ui/avatar_dyn'
BUNDLE = 'arts/dynavatars_0.ab'
FORMAT = 'avatar-dyn'
VERSION = 1
STATIC = '/assets/ui/playerAvatar/{id}.png'
FX_ROOTS = ('avatar_ui_fx', 'ui_particle')      # the particle layer's root under the avatar box (04 has no avatar_ui_fx)
SEQ_FPS = 60                                     # the clips' sample rate; their keys sit on this grid

DESCRIPTOR = """avatar.json: {format: 'avatar-dyn', version: 1, id, name?, box: [w, h] (UI px, the RectMask2D rect: draw
clipped to it), static: the official static picture, layers: [...] in draw order (the prefab's sibling order)}.
Layer kinds:
  spine: {skeleton, atlas, pages: [..], spine: '3.8.99', pma: false, animation, loop: true, timeScale, duration (s),
          unitPx: 1 (UI px per skeleton unit), offset: [x, y] (UI px of the skeleton origin from the box centre, y up;
          all [0, 0]), prefabOffset? (informational, not applied)}
  fx: {prefab (fx-prefab JSON, textures by key), textures: {key: {file, w, h, alpha, ...}} (files relative to the
       avatar directory's fx/), uiParticle: the UIParticle fields, rects: {nodeName: {ap, size, amin, amax, pivot}}}
  sequence: {src (lossless animated WebP), size: [150, 150], fit: 'stretch' (over the box), fps: 60, duration (s),
             frames, timeline: [[frame, ms], ...]}"""


def _rect(tt):
    f = lambda v: [round(v['x'], 4), round(v['y'], 4)]  # noqa: E731
    return {'ap': f(tt['m_AnchoredPosition']), 'size': f(tt['m_SizeDelta']), 'amin': f(tt['m_AnchorMin']),
            'amax': f(tt['m_AnchorMax']), 'pivot': f(tt['m_Pivot']), 'scale': round(tt['m_LocalScale']['x'], 4)}


class _Bundle:
    """The bundle's own objects, by path id, with the GameObject tree."""

    def __init__(self, path):
        import aklz4  # noqa: F401  (registers the LZ4AK decoder)
        import UnityPy
        self.env = UnityPy.load(str(path))
        self.objs = {o.path_id: o for o in self.env.objects}
        self.tt = {}

    def get(self, pptr):
        return self.objs.get(pptr['m_PathID']) if pptr and not pptr.get('m_FileID') and pptr.get('m_PathID') else None

    def tree(self, o):
        if o.path_id not in self.tt:
            self.tt[o.path_id] = o.read_typetree()
        return self.tt[o.path_id]

    def comps(self, go):
        return [c for c in (self.get(x['component']) for x in self.tree(go)['m_Component']) if c is not None]

    def transform(self, go):
        return next((c for c in self.comps(go) if c.type.name in ('RectTransform', 'Transform')), None)

    def children(self, go):
        tf = self.transform(go)
        out = []
        for ch in self.tree(tf).get('m_Children', []) if tf else []:
            t = self.get(ch)
            g = self.get(self.tree(t)['m_GameObject']) if t else None
            if g is not None:
                out.append(g)
        return out

    def roots(self):
        out = {}
        for o in self.env.objects:
            if o.type.name != 'GameObject':
                continue
            tf = self.transform(o)
            if tf is not None and not self.tree(tf).get('m_Father', {}).get('m_PathID'):
                out[self.tree(o)['m_Name']] = o
        return out

    def find(self, go, name):
        for ch in self.children(go):
            if self.tree(ch)['m_Name'] == name:
                return ch
            hit = self.find(ch, name)
            if hit is not None:
                return hit
        return None

    def walk(self, go, path=''):
        name = self.tree(go)['m_Name']
        here = f'{path}/{name}' if path else name
        yield here, go
        for ch in self.children(go):
            yield from self.walk(ch, here)


def spine_duration(skel, name):
    """The length (s) of animation `name` of a Spine JSON skeleton: its last key time."""
    anim = (skel.get('animations') or {}).get(name) or {}
    best = 0.0

    def scan(v):
        nonlocal best
        if isinstance(v, list):
            for k in v:
                if isinstance(k, dict) and isinstance(k.get('time'), (int, float)):
                    best = max(best, float(k['time']))
                scan(k)
        elif isinstance(v, dict):
            for x in v.values():
                scan(x)
    scan(anim)
    return round(best, 6)


def straight_alpha(img):
    """True unless the page looks premultiplied: some semi-transparent pixel brighter than its alpha (merge_alpha's
    test — premultiplied data cannot have max(RGB) > A)."""
    px = img.convert('RGBA').getdata()
    semi = brighter = 0
    for r, g, b, a in px:
        if 0 < a < 255:
            semi += 1
            if max(r, g, b) > a:
                brighter += 1
    return semi == 0 or brighter > 0


def write_skeleton(b, sda_obj, out_dir, url, log):
    """The Spine files of a SkeletonDataAsset: (layer fields, {file: manifest entry}) or (None, {})."""
    from extract import _text_bytes, merge_alpha, normalize_atlas, atlas_pages, safe_name
    sda = b.tree(sda_obj)
    skel_o = b.get(sda.get('skeletonJSON'))
    if skel_o is None:
        return None, {}
    ta = skel_o.read()
    raw = _text_bytes(ta)
    skel = json.loads(raw.decode('utf-8-sig'))
    stem = safe_name(ta.m_Name)
    texts, pages = [], {}
    for aref in sda.get('atlasAssets') or []:
        aa = b.get(aref)
        if aa is None:
            continue
        at = b.tree(aa)
        af = b.get(at.get('atlasFile'))
        if af is not None:
            texts.append(_text_bytes(af.read()).decode('utf-8', 'replace'))
        for mref in at.get('materials') or []:
            mo = b.get(mref)
            if mo is None:
                continue
            texs = dict(b.tree(mo)['m_SavedProperties']['m_TexEnvs'])
            main, alpha = b.get(texs.get('_MainTex', {}).get('m_Texture')), b.get(texs.get('_AlphaTex', {}).get('m_Texture'))
            if main is not None:
                mt = main.read()
                pages[safe_name(mt.m_Name) + '.png'] = merge_alpha(mt.image, alpha.read().image if alpha is not None else None)
    if len(texts) != 1 or not pages:
        log(f'  warn {stem}: {len(texts)} atlas text(s), {len(pages)} page(s)')
        return None, {}
    names = atlas_pages(texts[0])
    if set(names) != set(pages):
        if len(names) != 1 or len(pages) != 1:
            log(f'  warn {stem}: atlas pages {names} != textures {sorted(pages)}')
            return None, {}
        pages = {names[0]: next(iter(pages.values()))}
    out_dir.mkdir(parents=True, exist_ok=True)
    files = {}
    (out_dir / f'{stem}.json').write_bytes(raw)
    files[f'{stem}.json'] = {'path': f'{url}/{stem}.json', 'kind': 'TextAsset'}
    atlas = normalize_atlas(texts[0], {p: img.size for p, img in pages.items()})
    (out_dir / f'{stem}.atlas').write_bytes(atlas.encode('utf-8'))
    files[f'{stem}.atlas'] = {'path': f'{url}/{stem}.atlas', 'kind': 'TextAsset'}
    pma = False
    for fname, img in pages.items():
        img.save(out_dir / fname, 'PNG')
        files[fname] = {'path': f'{url}/{fname}', 'w': img.width, 'h': img.height, 'kind': 'Texture2D'}
        if not straight_alpha(img):
            pma = True
            log(f'  warn {stem}: page {fname} looks premultiplied')
    layer = {'kind': 'spine', 'skeleton': f'{url}/{stem}.json', 'atlas': f'{url}/{stem}.atlas',
             'pages': [f'{url}/{p}' for p in pages], 'spine': (skel.get('skeleton') or {}).get('spine'), 'pma': pma,
             'animations': {n: spine_duration(skel, n) for n in (skel.get('animations') or {})},
             'scale': sda.get('scale')}
    return layer, files


def spine_layer(b, roots, aid, box_go, out_dir, url, log):
    """The skeleton of avatar `aid`: the prefab spine_assets_<aid> its holder spine_dyn_<…> receives at run time."""
    prefab = roots.get(f'spine_assets_{aid}')
    if prefab is None:
        return None, {}
    graphic = next((c for c in b.comps(prefab) if c.type.name == 'MonoBehaviour' and 'skeletonDataAsset' in b.tree(c)), None)
    sda_obj = b.get(b.tree(graphic)['skeletonDataAsset']) if graphic is not None else None
    if sda_obj is None:
        log(f'  warn {aid}: no SkeletonGraphic with a SkeletonDataAsset in spine_assets_{aid}')
        return None, {}
    layer, files = write_skeleton(b, sda_obj, out_dir, url, log)
    if layer is None:
        return None, {}
    g = b.tree(graphic)
    anims = layer.pop('animations')
    start = g.get('startingAnimation') or ''
    name = start if start in anims else ('loop' if 'loop' in anims else next(iter(anims), ''))
    if start and start != name:
        log(f'  note {aid}: startingAnimation {start!r} is not in the skeleton; playing {name!r} (its only clip)')
    rect = _rect(b.tree(b.transform(prefab)))
    holder = next((c for c in b.children(box_go) if b.tree(c)['m_Name'].startswith('spine_dyn_')), None)
    hold = _rect(b.tree(b.transform(holder))) if holder is not None else {'ap': [0.0, 0.0]}
    unit = round((layer.pop('scale') or 0.01) * 100, 6)    # × the canvas' 100 reference pixels per unit
    layer.update({'animation': name, 'loop': True, 'timeScale': g.get('timeScale', 1) or 1, 'duration': anims.get(name),
                  'unitPx': unit, 'offset': hold['ap'], 'initialSkin': g.get('initialSkinName') or None,
                  **({'prefabOffset': rect['ap']} if rect['ap'] != [0.0, 0.0] else {})})
    return layer, files


def fx_layer(fx_env, aid, fx_root_name, rel, out_dir, url, b, box_go, log):
    """The UIParticle layer: its subtree as an fx-prefab (fx.Exporter, lossless PNG) + the UI rects of its nodes."""
    import fx
    roots = fx_env.prefabs(rel)
    root = roots.get(f'assets_{aid}')
    if root is None:
        return None, {}
    target = None
    for k in fx.go_children(fx_env, root):
        if fx_env.tt(k).get('m_Name') == fx_root_name:
            target = k
    if target is None:
        return None, {}
    ex = fx.Exporter(fx_env, out_dir, log, texture_format='png')
    key = f'{aid}_fx'
    entry = ex.prefab(key, target, rel)
    files = {}
    base = out_dir / fx.FX_SUB
    for p in sorted(base.rglob('*')):
        if p.is_file():
            relp = p.relative_to(out_dir).as_posix()
            files[relp] = {'path': f'{url}/{relp}', 'kind': 'Texture2D' if p.suffix == '.png' else 'TextAsset'}
    # the UI rects and the UIParticle settings the fx-prefab's Transform-only nodes do not carry
    src = b.find(box_go, fx_root_name)
    rects, uip = {}, None
    for path, go in b.walk(src) if src is not None else []:
        tf = b.transform(go)
        if tf is not None and tf.type.name == 'RectTransform':
            rects[path] = _rect(b.tree(tf))
        for c in b.comps(go):
            if c.type.name == 'MonoBehaviour':
                t = b.tree(c)
                if '_particles' in t or 'm_Scale' in t or 'm_Scale3D' in t:
                    ptr = lambda v: isinstance(v, dict) and 'm_PathID' in v  # noqa: E731
                    uip = {k: v for k, v in t.items() if k not in ('m_GameObject', 'm_Script', 'm_Material', 'm_OnCullStateChanged')
                           and not ptr(v) and not (isinstance(v, list) and v and all(ptr(x) for x in v))}
    layer = {'kind': 'fx', 'prefab': f'{url}/{fx.FX_SUB}/prefabs/{fx.fx_file(key)}.json',
             'textures': {k: {**m, 'file': f'{url}/{fx.FX_SUB}/{m["file"]}', **({'half': f'{url}/{fx.FX_SUB}/{m["half"]}'} if m.get('half') else {})}
                          for k, m in ex.textures.items()},
             'stats': {k: entry.get(k) for k in ('nodes', 'particleSystems', 'liveParticles', 'duration', 'looping')},
             'uiParticle': uip, 'rects': rects}
    return layer, files


def _curve_value(keys, t):
    """A float curve at time t: linear between its keys (the clips' keys sit on the 60 Hz grid with 0 / 1 steps one
    sample apart, so the grid samples are exact whatever the tangents)."""
    if not keys:
        return 0.0
    if t <= keys[0][0]:
        return keys[0][1]
    for (t0, v0), (t1, v1) in zip(keys, keys[1:]):
        if t0 <= t <= t1:
            return v0 if t1 == t0 else v0 + (v1 - v0) * (t - t0) / (t1 - t0)
    return keys[-1][1]


def sequence_layer(b, aid, box_go, out_dir, url, log):
    """A frame sequence: an Animation whose clip switches child Images' CanvasGroup alpha. One lossless animated WebP
    of the native sprites with the clip's timing (one frame per run of equal 60 Hz samples)."""
    anim_go = anim = None
    for _path, go in b.walk(box_go):
        a = next((c for c in b.comps(go) if c.type.name == 'Animation'), None)
        if a is not None:
            anim_go, anim = go, a
            break
    if anim is None:
        return None, {}
    at = b.tree(anim)
    clips = [b.get(c) for c in at.get('m_Animations') or []]
    clip = next((c for c in clips if c is not None), None)
    if clip is None:
        return None, {}
    ct = b.tree(clip)
    curves = {}
    for cv in ct.get('m_FloatCurves') or []:
        if cv.get('attribute') == 'm_Alpha':
            curves[cv['path']] = [(float(k['time']), float(k['value'])) for k in cv['curve']['m_Curve']]
    length = max((k[-1][0] for k in curves.values() if k), default=0.0)
    sr = float(ct.get('m_SampleRate') or SEQ_FPS)
    frames = []                                          # (path, Image) in sibling order
    for ch in b.children(anim_go):
        name = b.tree(ch)['m_Name']
        img = next((b.get(b.tree(c)['m_Sprite']) for c in b.comps(ch)
                    if c.type.name == 'MonoBehaviour' and b.tree(c).get('m_Sprite', {}).get('m_PathID')), None)
        if img is not None and name in curves:
            frames.append((name, img.read().image.convert('RGBA')))
    if not frames or length <= 0:
        log(f'  warn {aid}: sequence without frames or length')
        return None, {}
    ticks = int(round(length * sr))
    shown = []
    for i in range(ticks):
        t = i / sr
        alphas = [_curve_value(curves[n], t) for n, _ in frames]
        best = max(range(len(frames)), key=lambda j: alphas[j])
        if alphas[best] < 0.999 or sum(1 for a in alphas if a > 0.001) != 1:
            log(f'  warn {aid}: t={t:.4f} alphas {[round(a, 3) for a in alphas]}')
        shown.append(best)
    runs = []
    for idx in shown:
        if runs and runs[-1][0] == idx:
            runs[-1][1] += 1
        else:
            runs.append([idx, 1])
    if len(runs) > 1 and runs[0][0] == runs[-1][0]:      # the loop's seam: the last run continues the first
        pass                                             # kept as two frames: the timing stays exact either way
    ms, acc, done = [], 0.0, 0
    for _idx, n in runs:
        acc += n * 1000.0 / sr
        ms.append(int(round(acc)) - done)
        done += ms[-1]
    out_dir.mkdir(parents=True, exist_ok=True)
    imgs = [frames[i][1] for i, _ in runs]
    name = f'{aid}.webp'
    imgs[0].save(out_dir / name, 'WEBP', save_all=True, append_images=imgs[1:], duration=ms, loop=0, lossless=True,
                 quality=100, method=6, exact=True)
    w, h = imgs[0].size
    layer = {'kind': 'sequence', 'src': f'{url}/{name}', 'size': [w, h], 'fit': 'stretch', 'fps': int(sr),
             'duration': round(length, 6), 'frames': len(frames), 'timeline': [[frames[i][0], m] for (i, _), m in zip(runs, ms)]}
    return layer, {name: {'path': f'{url}/{name}', 'w': w, 'h': h, 'kind': 'Texture2D'}}


def export(ab_root, out_root, manifest, log, names=None, cabs=None):
    """Write every dynamic avatar under <out_root>/ui/avatar_dyn/; returns the file count. `names`: avatar id → item
    name (display_meta), optional."""
    import fx
    src = Path(ab_root) / BUNDLE
    if not src.exists():
        log(f'skip (missing) {BUNDLE}')
        return 0
    b = _Bundle(src)
    roots = b.roots()
    fx_env = None
    total = 0
    for rname in sorted(r for r in roots if r.startswith('assets_avatar_dyn_')):
        aid = rname[len('assets_'):]
        box_go = roots[rname]
        box = _rect(b.tree(b.transform(box_go)))
        sub = f'{SUB}/{aid}'
        out_dir = Path(out_root) / sub
        url = f'/assets/local/{sub}'
        files, layers = {}, []
        for ch in b.children(box_go):
            n = b.tree(ch)['m_Name']
            if n.startswith('spine_dyn_'):
                layer, f = spine_layer(b, roots, aid, box_go, out_dir, url, log)
            elif n.startswith('anim_dyn_'):
                layer, f = sequence_layer(b, aid, box_go, out_dir, url, log)
            elif n in FX_ROOTS:
                if fx_env is None:
                    fx_env = fx.AssetEnv(ab_root, cabs if cabs is not None else fx.scan_cabs(ab_root))
                layer, f = fx_layer(fx_env, aid, n, BUNDLE, out_dir, url, b, box_go, log)
            else:
                log(f'  note {aid}: child {n!r} not drawn')
                continue
            if layer is None:
                log(f'  warn {aid}: layer {n!r} not exported')
                continue
            layers.append(layer)
            files.update(f)
        if not layers:
            continue
        doc = {'format': FORMAT, 'version': VERSION, 'id': aid, **({'name': names[aid]} if names and names.get(aid) else {}),
               'box': box['size'], 'clip': 'rect', 'static': STATIC.format(id=aid), 'layers': layers}
        (out_dir / 'avatar.json').write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
        files['avatar.json'] = {'path': f'{url}/avatar.json', 'kind': 'TextAsset'}
        manifest[sub] = files
        total += len(files)
        log(f'{BUNDLE}: {aid} -> {sub} ({len(files)} files: {", ".join(l["kind"] for l in layers)})')
    return total
