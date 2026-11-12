"""Policy / value network of the Stronghold RL environment (plan §8, B2).

Built from the environment's spec (HELLO frame / record meta): every integer-coded field is embedded, each entity block
(shop slots, owned pieces, enemies, rewards, personal cards, draft cards, teammates) goes through a small MLP and is
pooled (masked mean + max) into a context; slot actions (buy slot i, sell piece j, reward k, personal p, card c) are
scored from that slot's own encoding plus the context, the four scalar actions (end, refresh, level, freeze) from the
context. Only Embedding, Linear, ReLU, masked mean / max and concatenation: a plain-JS forward pass can mirror it.
"""
from collections import defaultdict
import torch
import torch.nn as nn

EMB = {'piece': 32, 'enemy': 16, 'band': 16, 'stage': 8, 'card': 16, 'kind': 8, 'bond': 16, 'boss': 16}
# blocks a spec does not have are skipped (an older checkpoint builds as before); S5 blocks come last, so their pooled
# features are the trunk's last input columns (surgery.py zero-initialises them)
ENTITY_OUT = {'global': 128, 'shop': 128, 'owned': 128, 'enemies': 64, 'rewards': 96, 'personal': 64, 'cards': 64, 'mates': 64,
              'extra': 32, 'mateBonds': 64, 'bands': 32}
POINTER = ['shop', 'owned', 'rewards', 'personal', 'cards', 'bands']  # the action order after the 4 scalars (blocks a spec has)
SCALARS = 4


def mlp(i, h, o):
    return nn.Sequential(nn.Linear(i, h), nn.ReLU(), nn.Linear(h, o), nn.ReLU())


class SPNet(nn.Module):
    def __init__(self, spec, ctx=256):
        super().__init__()
        self.spec = spec
        blocks, vocab = spec['blocks'], spec['vocab']
        self.D, self.A = spec['dim'], spec['actions']
        self.emb = nn.ModuleDict({k: nn.Embedding(vocab[k], d) for k, d in EMB.items() if k in vocab})
        self.names = [n for n in ENTITY_OUT if n in blocks]
        ids = defaultdict(list)
        for block, field, voc in spec['ids']:
            ids[block].append((field, voc))
        self.layout = {}
        self.enc = nn.ModuleDict()
        for name in self.names:
            out = ENTITY_OUT[name]; b = blocks[name]
            idf = {f for f, _ in ids[name]}
            numeric = [i for i in range(b['width']) if i not in idf]
            self.register_buffer(f'num_{name}', torch.tensor(numeric, dtype=torch.long), persistent=False)
            self.layout[name] = (b['offset'], b['count'], b['width'], ids[name])
            in_dim = len(numeric) + sum(EMB[v] for _, v in ids[name])
            self.enc[name] = mlp(in_dim, max(out, 64), out)
        nb = blocks['bonds']
        self.bonds_at = (nb['offset'], nb['count'] * nb['width'])
        self.bonds = mlp(self.bonds_at[1], 128, 128)
        pooled = sum(2 * ENTITY_OUT[n] for n in self.names if n != 'global')
        self.trunk = nn.Sequential(nn.Linear(ENTITY_OUT['global'] + 128 + pooled, 512), nn.ReLU(), nn.Linear(512, ctx), nn.ReLU())
        self.scalar = nn.Linear(ctx, SCALARS)
        self.pointer = [n for n in POINTER if n in blocks]
        self.ptr = nn.ModuleDict({n: nn.Sequential(nn.Linear(ENTITY_OUT[n] + ctx, 128), nn.ReLU(), nn.Linear(128, 1)) for n in self.pointer})
        self.value = nn.Sequential(nn.Linear(ctx, 128), nn.ReLU(), nn.Linear(128, 1))
        counts = [blocks[n]['count'] for n in self.pointer]
        assert SCALARS + sum(counts) == self.A, (counts, self.A)

    def _block(self, obs, name):
        off, n, w, ids = self.layout[name]
        x = obs[:, off:off + n * w].reshape(obs.shape[0], n, w)
        parts = [x.index_select(2, getattr(self, f'num_{name}'))]
        for field, voc in ids:
            code = x[..., field].round().long().clamp_(0, self.emb[voc].num_embeddings - 1)
            parts.append(self.emb[voc](code))
        h = self.enc[name](torch.cat(parts, dim=-1))
        present = x[..., 0] > 0.5
        return h, present

    @staticmethod
    def _pool(h, present):
        m = present.unsqueeze(-1).to(h.dtype)
        cnt = m.sum(1).clamp_min(1.0)
        mean = (h * m).sum(1) / cnt
        mx = (h * m - (1 - m) * 1e4).max(1).values
        mx = torch.where(present.any(1, keepdim=True), mx, torch.zeros_like(mx))
        return torch.cat([mean, mx], dim=-1)

    def forward(self, obs, mask=None):
        """obs (B, D) float, mask (B, A) bool -> masked logits (B, A), value (B,)."""
        g, _ = self._block(obs, 'global')
        feats = [g[:, 0], self.bonds(obs[:, self.bonds_at[0]:self.bonds_at[0] + self.bonds_at[1]])]
        ents = {}
        for name in self.names:
            if name == 'global':
                continue
            h, present = self._block(obs, name)
            ents[name] = h
            feats.append(self._pool(h, present))
        c = self.trunk(torch.cat(feats, dim=-1))
        logits = [self.scalar(c)]
        for name in self.pointer:
            h = ents[name]
            cc = c.unsqueeze(1).expand(-1, h.shape[1], -1)
            logits.append(self.ptr[name](torch.cat([h, cc], dim=-1)).squeeze(-1))
        logits = torch.cat(logits, dim=-1)
        if mask is not None:
            logits = logits.masked_fill(~mask, -1e9)
        return logits, self.value(c).squeeze(-1)


def param_count(net):
    return sum(p.numel() for p in net.parameters())


def save(path, net, extra=None):
    torch.save({'state': net.state_dict(), 'spec': net.spec, **({'cfg': net.cfg} if hasattr(net, 'cfg') else {}), **(extra or {})}, path)


def load(path, device='cpu'):
    ck = torch.load(path, map_location=device, weights_only=False)
    if ck.get('cfg'):  # an architecture-probe network (model2.SPNet2)
        from model2 import SPNet2
        net = SPNet2(ck['spec'], **ck['cfg']).to(device)
    else:
        net = SPNet(ck['spec']).to(device)
    net.load_state_dict(ck['state'])
    return net, ck
