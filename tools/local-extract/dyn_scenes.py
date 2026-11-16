"""SPIKE (spike/dyn-fx-20261116): export the client's official dyn illust scenes (arts/dynchars/*.ab, `dyn_illust_*` prefabs) as fx-prefab
descriptors (docs/design/vfx-format.md §33, written by tools/local-extract/fx.py's own Exporter) plus the dyn illust
extras the remake's runtime needs (`dyn`: camera, Spine node, render separator, action-only groups, Animator default
states). Read-only on the client; the Spine pages are not exported (the remake has the skeletons).

Usage: .venv/bin/python tools/local-extract/dyn_scenes.py <out root> [--jobs N] [--tex png|webp|none] [--url /dynfx/x] [substr ...]
  <out root>/fx/{prefabs,tex,mesh}/…, <out root>/fx/textures.json, <out root>/local-fx.json (fx-manifest, URLs under --url),
  <out root>/summary.json (per prefab: shaders, behaviours, counts)
"""
import argparse
import hashlib
import json
import re
import sys
import traceback
from multiprocessing import Pool
from pathlib import Path

BASE = '/mnt/Arknights Game/Arknights_Data/StreamingAssets/AB/Windows'
G = {}


def _init(le, root, cabs, out, tex):
    sys.path.insert(0, le)
    sys.dont_write_bytecode = True
    import aklz4  # noqa: F401
    import fx
    env = fx.AssetEnv(root, cabs)
    ex = fx.Exporter(env, out, log=lambda m: G['log'].append(m), texture_format='png' if tex == 'png' else 'webp')
    G.update(fx=fx, env=env, ex=ex, tex=tex, log=[], skip=False)
    orig_material, orig_texture = ex.material, ex.texture

    def material(f, o):
        d = env.tt(o)
        sf, so = env.resolve(o.assets_file, d.get('m_Shader'))
        name = ex.shader_info(sf, so)['name'] if so is not None and sf != 'builtin' else None
        G['skip'] = bool(name and re.search(r'spine|skeleton', name, re.I))
        try:
            return orig_material(f, o)
        finally:
            G['skip'] = False

    def texture(f, o):
        if G['skip']:
            return None                    # a Spine page: the remake has the skeleton's own atlas
        if G['tex'] == 'none':             # analysis only: the texture's header, no decode
            k = (id(f), o.path_id)
            if k in ex._tex_keys:
                return ex._tex_keys[k]
            d = env.tt(o)
            key = f'{fx.FX_SAFE.sub("_", d.get("m_Name") or "tex").strip("._") or "tex"}-{d.get("m_Width")}x{d.get("m_Height")}'
            ex.textures.setdefault(key, {'name': d.get('m_Name'), 'w': d.get('m_Width'), 'h': d.get('m_Height'),
                                         'format': fx.TEXTURE_FORMATS.get(d.get('m_TextureFormat'), str(d.get('m_TextureFormat'))),
                                         'bytes': d.get('m_CompleteImageSize'),
                                         'bundle': str(getattr(o.assets_file, 'name', ''))})
            ex._tex_keys[k] = key
            return key
        return orig_texture(f, o)

    ex.material, ex.texture = material, texture


def _walk(env, fx, root):
    """GameObjects in Exporter.prefab's node order (depth first, children in Transform order)."""
    out, order = [], [root]
    while order:
        go = order.pop(0)
        out.append(go)
        order[0:0] = list(fx.go_children(env, go))
    return out


def _animator_default(env, go):
    """(default state name, its clip name) of the GameObject's Animator controller's first layer, or None."""
    gd = env.tt(go)
    for c in gd.get('m_Component', []):
        f, o = env.resolve(go.assets_file, c.get('component'))
        if o is None or f == 'builtin' or o.type.name != 'Animator':
            continue
        cf, co = env.resolve(o.assets_file, env.tt(o).get('m_Controller'))
        if co is None or cf == 'builtin':
            return None
        cd = env.tt(co)
        tos = {k: v for k, v in cd.get('m_TOS', [])}
        clips = []
        for cp in cd.get('m_AnimationClips', []):
            kf, ko = env.resolve(co.assets_file, cp)
            clips.append(env.tt(ko).get('m_Name') if ko is not None and kf != 'builtin' else None)
        ctl = cd.get('m_Controller', {})
        sms = ctl.get('m_StateMachineArray', [])
        if not sms:
            return None
        sm = sms[0].get('data', sms[0])
        states = sm.get('m_StateConstantArray', [])
        di = sm.get('m_DefaultState', 0)
        names = []
        for st in states:
            st = st.get('data', st)
            nm = tos.get(st.get('m_NameID'), st.get('m_NameID'))
            cl = None
            for bt in st.get('m_BlendTreeConstantArray', []):
                bt = bt.get('data', bt)
                for nd in bt.get('m_NodeArray', []):
                    nd = nd.get('data', nd)
                    cid = nd.get('m_ClipID')
                    if isinstance(cid, int) and 0 <= cid < len(clips):
                        cl = clips[cid]
                        break
                if cl:
                    break
            names.append({'state': nm, 'clip': cl, 'speed': st.get('m_Speed', 1), 'loop': bool(st.get('m_Loop', 0))})
        if not names:
            return None
        return {'default': names[min(di, len(names) - 1)], 'states': names}
    return None


def _skeleton_scale(env, go):
    """SkeletonDataAsset.scale of the root's SkeletonAnimation (Unity units per skeleton px; 0.01 in every scene)."""
    for c in env.tt(go).get('m_Component', []):
        f, o = env.resolve(go.assets_file, c.get('component'))
        if o is None or f == 'builtin' or o.type.name != 'MonoBehaviour':
            continue
        d = env.tt(o)
        if 'skeletonDataAsset' in d:
            af, ao = env.resolve(o.assets_file, d['skeletonDataAsset'])
            return env.tt(ao).get('scale') if ao is not None and af != 'builtin' else None
    return None


def _export(job):
    rel, = job
    fx, env, ex = G['fx'], G['env'], G['ex']
    G['log'] = []
    res = []
    try:
        prefabs = env.prefabs(rel)
        for name, go in sorted(prefabs.items()):
            if not name.startswith('dyn_illust_'):
                continue
            key = name.lower()
            entry = ex.prefab(key, go, rel)
            path = ex.out / entry['file']
            doc = json.loads(path.read_text(encoding='utf-8'))
            gos = _walk(env, fx, go)
            dyn = {'animatorStates': {}}
            for nid, g in enumerate(gos):
                if 'animator' in doc['nodes'][nid]:
                    a = _animator_default(env, g)
                    if a:
                        dyn['animatorStates'][nid] = a
            for b in doc['nodes'][0].get('behaviours', []):
                f = b['fields']
                if '_cameraSize' in f:
                    dyn['illust'] = {'class': b['class'], 'cameraSize': f.get('_cameraSize'), 'maxSize': f.get('_maxSize'),
                                     'actionRoots': [p.get('particle', {}).get('node') for p in f.get('_particles') or [] if isinstance(p, dict) and isinstance(p.get('particle'), dict)]}
                if 'skeletonDataAsset' in f:
                    dyn['spine'] = {'class': b['class'], 'data': (f.get('skeletonDataAsset') or {}).get('name'), 'animation': f.get('_animationName'),
                                    'separatorSlotNames': f.get('separatorSlotNames'), 'tintBlack': f.get('tintBlack'), 'pma': f.get('pmaVertexColors')}
                if 'partsRenderers' in f:
                    dyn['separator'] = {'class': b['class'], 'parts': [p.get('node') if isinstance(p, dict) else None for p in f.get('partsRenderers') or []]}
            if 'spine' in dyn:
                dyn['spine']['scale'] = _skeleton_scale(env, go)
            doc['dyn'] = dyn
            path.write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
            res.append((key, entry))
    except Exception:
        G['log'].append(f'ERROR {rel}: {traceback.format_exc()}')
    return rel, res, dict(ex.textures), dict(ex.meshes), G['log']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('subs', nargs='*')
    ap.add_argument('--jobs', type=int, default=1)
    ap.add_argument('--tex', default='png', choices=('png', 'webp', 'none'))
    ap.add_argument('--url', default='/dynfx')
    a = ap.parse_args()
    a.le = str(Path(__file__).resolve().parent)
    sys.path.insert(0, a.le)
    import aklz4  # noqa: F401
    import fx
    from bundles import client_bundles
    out = Path(a.out)
    (out / 'fx').mkdir(parents=True, exist_ok=True)
    with client_bundles(BASE, log=lambda m: print(m, flush=True)) as root:
        names = sorted(p.relative_to(root).as_posix() for p in (root / 'arts' / 'dynchars').glob('*.ab'))
        if a.subs:
            names = [n for n in names if any(s in n for s in a.subs)]
        print(len(names), 'bundles', flush=True)
        cabs = fx.scan_cabs(root)
        print('cabs', len(cabs), flush=True)
        textures, meshes, prefabs = {}, {}, {}
        with Pool(max(1, a.jobs), initializer=_init, initargs=(a.le, str(root), cabs, str(out), a.tex)) as pool:
            for rel, res, tex, mesh, log in pool.imap_unordered(_export, [(n,) for n in names]):
                for m in log:
                    print(m, flush=True)
                textures.update(tex)
                meshes.update(mesh)
                for key, entry in res:
                    prefabs[key] = entry
                print(rel, [k for k, _ in res], flush=True)
    (out / 'fx' / 'textures.json').write_text(json.dumps({'format': 'fx-textures', 'version': 1, 'textures': textures}, ensure_ascii=False))
    u = a.url.rstrip('/') + '/fx/'
    groups = {
        'fx': {'textures': {'path': u + 'textures.json', 'kind': 'FxTextures', 'count': len(textures)}},
        'fx/prefabs': {k: {'path': u + e['file'], 'kind': 'FxPrefab'} for k, e in sorted(prefabs.items())},
        'fx/tex': {k: {'path': u + t['file'], 'w': t['w'], 'h': t['h'], 'kind': 'Texture2D',
                       **({'encoding': t['encoding']} if t.get('encoding') else {}), **({'half': u + t['half']} if t.get('half') else {})}
                   for k, t in sorted(textures.items()) if t.get('file')},
        'fx/mesh': {k: {'path': u + m['file'], 'kind': 'FxMesh', 'verts': m['verts']} for k, m in sorted(meshes.items())},
    }
    (out / 'local-fx.json').write_text(json.dumps({'version': 1, 'format': 'fx-manifest', 'source': 'local-client', 'set': 'keys',
                                                   'count': sum(len(g) for g in groups.values()), 'groups': groups}, ensure_ascii=False))
    (out / 'summary.json').write_text(json.dumps(prefabs, ensure_ascii=False, indent=1))
    print('prefabs', len(prefabs), 'textures', len(textures), 'meshes', len(meshes), flush=True)


if __name__ == '__main__':
    main()
