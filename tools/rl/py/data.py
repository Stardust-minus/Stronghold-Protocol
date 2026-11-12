"""Behaviour-cloning shards written by tools/rl/record.mjs (one directory per data id)."""
import glob, json
import numpy as np


def record_dtype(meta):
    return np.dtype([('obs', '<f2', (meta['D'],)), ('mask', 'u1', (meta['maskBytes'],)), ('action', 'u1'), ('kind', 'u1'),
                     ('pad', '<u2'), ('traj', '<u4'), ('reward', '<f4')])


def discounted_returns(traj, reward, terms, gamma):
    """Per record: the discounted return of the transition it starts. A record's own `reward` is what accrued since the
    trajectory's previous record (it belongs to that previous transition); a trajectory's last transition gets its
    terminal reward."""
    n = len(traj)
    ret = np.zeros(n, dtype=np.float32)
    order = np.argsort(traj, kind='stable')
    t_sorted = traj[order]
    cuts = np.flatnonzero(np.diff(t_sorted)) + 1
    for g in np.split(order, cuts):
        if not len(g):
            continue
        tid = int(traj[g[0]])
        r = np.empty(len(g), dtype=np.float64)
        r[:-1] = reward[g[1:]]
        r[-1] = terms.get(tid, {}).get('reward', 0.0)
        acc = 0.0
        out = np.empty(len(g), dtype=np.float32)
        for k in range(len(g) - 1, -1, -1):
            acc = r[k] + gamma * acc
            out[k] = acc
        ret[g] = out
    return ret


def load_shards(path, gamma=0.997):
    """[(tag, meta, records memmap, returns)] for every shard of `path` (a data-id directory)."""
    out = []
    for mp in sorted(glob.glob(path + '/*.meta.json')):
        meta = json.load(open(mp))
        rec = np.memmap(mp[:-len('.meta.json')] + '.bin', dtype=record_dtype(meta), mode='r')
        terms = {}
        with open(mp[:-len('.meta.json')] + '.terms.jsonl') as f:
            for line in f:
                if line.strip():
                    t = json.loads(line)
                    terms[t['traj']] = t
        out.append((meta['tag'], meta, rec, discounted_returns(np.asarray(rec['traj']), np.asarray(rec['reward']), terms, gamma)))
    return out


def unpack_mask(bits, A):
    return np.unpackbits(bits, axis=1, bitorder='little')[:, :A].astype(bool)
