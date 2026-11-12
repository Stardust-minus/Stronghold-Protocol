"""Architecture probe (ppo3): SPNet generalised. width scales every hidden size; trunk 'mlp' (SPNet) or 'resln' (residual
blocks with LayerNorm, SimBa / BRO style); attn > 0 adds pre-LN self-attention layers over all entity rows plus a global
token before pooling, and the pointer heads read the attended rows. Linear, ReLU, LayerNorm and softmax attention only:
all mirrorable in plain JS (infer.mjs would need LayerNorm and attention added)."""
from collections import defaultdict
import torch
import torch.nn as nn
import torch.nn.functional as F
from model import EMB, ENTITY_OUT, POINTER, SCALARS


def mlp(i, h, o):
    return nn.Sequential(nn.Linear(i, h), nn.ReLU(), nn.Linear(h, o), nn.ReLU())


class ResBlock(nn.Module):
    def __init__(self, d):
        super().__init__(); self.ln = nn.LayerNorm(d); self.f1 = nn.Linear(d, 4 * d // 2); self.f2 = nn.Linear(4 * d // 2, d)
    def forward(self, x):
        return x + self.f2(F.relu(self.f1(self.ln(x))))


class AttnLayer(nn.Module):
    def __init__(self, d, heads):
        super().__init__(); self.h = heads; self.ln1 = nn.LayerNorm(d); self.qkv = nn.Linear(d, 3 * d); self.o = nn.Linear(d, d)
        self.ln2 = nn.LayerNorm(d); self.f1 = nn.Linear(d, 2 * d); self.f2 = nn.Linear(2 * d, d)
    def forward(self, x, keep):  # x (B, T, d), keep (B, T) bool
        B, T, d = x.shape; h = self.h
        q, k, v = self.qkv(self.ln1(x)).view(B, T, 3, h, d // h).permute(2, 0, 3, 1, 4)
        att = (q @ k.transpose(-1, -2)) / (d // h) ** 0.5
        att = att.masked_fill(~keep[:, None, None, :], -1e9).softmax(-1)
        x = x + self.o((att @ v).transpose(1, 2).reshape(B, T, d))
        return x + self.f2(F.relu(self.f1(self.ln2(x))))


class SPNet2(nn.Module):
    def __init__(self, spec, width=1.0, trunk='mlp', depth=2, attn=0, attn_dim=128, heads=4, ctx=256):
        super().__init__()
        self.spec = spec; self.cfg = dict(width=width, trunk=trunk, depth=depth, attn=attn, attn_dim=attn_dim, heads=heads, ctx=ctx)
        blocks, vocab = spec['blocks'], spec['vocab']
        self.D, self.A = spec['dim'], spec['actions']
        W = lambda n: max(8, int(round(n * width)))
        self.emb = nn.ModuleDict({k: nn.Embedding(vocab[k], d) for k, d in EMB.items() if k in vocab})
        self.names = [n for n in ENTITY_OUT if n in blocks]
        ids = defaultdict(list)
        for block, field, voc in spec['ids']:
            ids[block].append((field, voc))
        self.layout, self.enc, self.out = {}, nn.ModuleDict(), {}
        for name in self.names:
            b = blocks[name]; idf = {f for f, _ in ids[name]}
            numeric = [i for i in range(b['width']) if i not in idf]
            self.register_buffer(f'num_{name}', torch.tensor(numeric, dtype=torch.long), persistent=False)
            self.layout[name] = (b['offset'], b['count'], b['width'], ids[name])
            o = W(ENTITY_OUT[name]); self.out[name] = o
            self.enc[name] = mlp(len(numeric) + sum(EMB[v] for _, v in ids[name]), max(o, 64), o)
        nb = blocks['bonds']; self.bonds_at = (nb['offset'], nb['count'] * nb['width'])
        self.bonds = mlp(self.bonds_at[1], W(128), W(128))
        ents = [n for n in self.names if n != 'global']
        C = W(ctx)
        if attn:
            da = attn_dim
            self.proj = nn.ModuleDict({n: nn.Linear(self.out[n], da) for n in ents})
            self.gproj = nn.Linear(self.out['global'] + W(128), da)
            self.typ = nn.Parameter(torch.zeros(len(ents) + 1, da))
            self.layers = nn.ModuleList([AttnLayer(da, heads) for _ in range(attn)])
            self.lnf = nn.LayerNorm(da)
            trunk_in = self.out['global'] + W(128) + da + sum(2 * da for _ in ents)
            slot_dim = {n: da for n in ents}
        else:
            trunk_in = self.out['global'] + W(128) + sum(2 * self.out[n] for n in ents)
            slot_dim = dict(self.out)
        H = W(512)
        if trunk == 'resln':
            self.trunk = nn.Sequential(nn.Linear(trunk_in, H), *[ResBlock(H) for _ in range(depth)], nn.LayerNorm(H), nn.Linear(H, C), nn.ReLU())
        else:
            self.trunk = nn.Sequential(nn.Linear(trunk_in, H), nn.ReLU(), nn.Linear(H, C), nn.ReLU())
        self.scalar = nn.Linear(C, SCALARS)
        self.pointer = [n for n in POINTER if n in blocks]
        self.ptr = nn.ModuleDict({n: nn.Sequential(nn.Linear(slot_dim[n] + C, W(128)), nn.ReLU(), nn.Linear(W(128), 1)) for n in self.pointer})
        self.value = nn.Sequential(nn.Linear(C, W(128)), nn.ReLU(), nn.Linear(W(128), 1))
        self.ents = ents

    def _block(self, obs, name):
        off, n, w, ids = self.layout[name]
        x = obs[:, off:off + n * w].reshape(obs.shape[0], n, w)
        parts = [x.index_select(2, getattr(self, f'num_{name}'))]
        for field, voc in ids:
            code = x[..., field].round().long().clamp_(0, self.emb[voc].num_embeddings - 1)
            parts.append(self.emb[voc](code))
        return self.enc[name](torch.cat(parts, dim=-1)), x[..., 0] > 0.5

    @staticmethod
    def _pool(h, present):
        m = present.unsqueeze(-1).to(h.dtype); cnt = m.sum(1).clamp_min(1.0)
        mx = (h * m - (1 - m) * 1e4).max(1).values
        mx = torch.where(present.any(1, keepdim=True), mx, torch.zeros_like(mx))
        return torch.cat([(h * m).sum(1) / cnt, mx], dim=-1)

    def forward(self, obs, mask=None):
        g, _ = self._block(obs, 'global'); g = g[:, 0]
        bo = self.bonds(obs[:, self.bonds_at[0]:self.bonds_at[0] + self.bonds_at[1]])
        hs, pres = {}, {}
        for name in self.ents:
            hs[name], pres[name] = self._block(obs, name)
        feats = [g, bo]
        if self.cfg['attn']:
            toks, keep, spans, t0 = [self.gproj(torch.cat([g, bo], -1))[:, None] + self.typ[0]], [torch.ones_like(pres[self.ents[0]][:, :1])], {}, 1
            for j, name in enumerate(self.ents):
                toks.append(self.proj[name](hs[name]) + self.typ[j + 1]); keep.append(pres[name])
                spans[name] = (t0, t0 + hs[name].shape[1]); t0 += hs[name].shape[1]
            x = torch.cat(toks, 1); kp = torch.cat(keep, 1)
            for layer in self.layers:
                x = layer(x, kp)
            x = self.lnf(x)
            feats.append(x[:, 0])
            for name in self.ents:
                a_, b_ = spans[name]; hs[name] = x[:, a_:b_]; feats.append(self._pool(hs[name], pres[name]))
        else:
            for name in self.ents:
                feats.append(self._pool(hs[name], pres[name]))
        c = self.trunk(torch.cat(feats, -1))
        logits = [self.scalar(c)]
        for name in self.pointer:
            h = hs[name]; cc = c.unsqueeze(1).expand(-1, h.shape[1], -1)
            logits.append(self.ptr[name](torch.cat([h, cc], -1)).squeeze(-1))
        logits = torch.cat(logits, -1)
        if mask is not None:
            logits = logits.masked_fill(~mask, -1e9)
        return logits, self.value(c).squeeze(-1)


def flops_per_forward(net, obs, mask):
    """Multiply-adds x 2 of Linear layers and attention matmuls for one observation (batch 1)."""
    total = [0]
    hooks = []
    for mod in net.modules():
        if isinstance(mod, nn.Linear):
            hooks.append(mod.register_forward_hook(lambda m_, i, o: total.__setitem__(0, total[0] + 2 * i[0].numel() // i[0].shape[-1] * m_.in_features * m_.out_features)))
    with torch.no_grad():
        net(obs[:1], mask[:1])
    for h in hooks:
        h.remove()
    if net.cfg['attn']:  # q·k and att·v per layer
        T = 1 + sum(net.layout[n][1] for n in net.ents); da = net.cfg['attn_dim']
        total[0] += net.cfg['attn'] * 2 * 2 * T * T * da
    return total[0]
