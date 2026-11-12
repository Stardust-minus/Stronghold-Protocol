// Plain-JS forward pass of the policy network (tools/rl/py/model.py SPNet), for in-process inference (plan §8, B5):
// Embedding, Linear, ReLU, masked mean / max pooling and concatenation only. Weights: py/export.py (manifest + f32 bin).
//   const net = SPPolicy.load('policy');  const { logits, value } = net.forward(obs /* Float32Array(D) */, mask /* Uint8Array(A) */);
import { readFileSync } from 'node:fs';

export class SPPolicy {
  constructor(manifest, f32) {
    this.m = manifest;
    this.w = (name) => { const t = manifest.tensors[name]; if (!t) throw new Error(`missing tensor ${name}`); return { data: f32.subarray(t.offset, t.offset + t.shape.reduce((x, y) => x * y, 1)), shape: t.shape }; };
    this.D = manifest.D; this.A = manifest.A;
  }

  static load(base) {
    const manifest = JSON.parse(readFileSync(`${base}.json`, 'utf8'));
    const buf = readFileSync(`${base}.bin`);
    const f32 = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
    return new SPPolicy(manifest, f32);
  }

  // y = relu?(x W^T + b); W (out, in)
  linear(prefix, x, relu) {
    const W = this.w(`${prefix}.weight`), b = this.w(`${prefix}.bias`);
    const [out, inn] = W.shape, y = new Float32Array(out);
    for (let o = 0; o < out; o++) {
      let s = b.data[o]; const row = o * inn;
      for (let i = 0; i < inn; i++) s += W.data[row + i] * x[i];
      y[o] = relu && s < 0 ? 0 : s;
    }
    return y;
  }

  // nn.Sequential(Linear, ReLU, Linear, ReLU) = mlp(); indices 0 and 2
  mlp(prefix, x) { return this.linear(`${prefix}.2`, this.linear(`${prefix}.0`, x, true), true); }

  block(obs, name) {
    const L = this.m.layout[name], rows = [], present = [];
    const embDim = this.m.emb;
    for (let r = 0; r < L.count; r++) {
      const base = L.offset + r * L.width;
      const parts = [];
      for (const i of L.numeric) parts.push(obs[base + i]);
      for (const [field, voc] of L.ids) {
        const E = this.w(`emb.${voc}.weight`), dim = embDim[voc], n = E.shape[0];
        let code = Math.round(obs[base + field]); if (!(code >= 0)) code = 0; if (code > n - 1) code = n - 1;
        for (let k = 0; k < dim; k++) parts.push(E.data[code * dim + k]);
      }
      rows.push(this.mlp(`enc.${name}`, Float32Array.from(parts)));
      present.push(obs[base] > 0.5);
    }
    return { rows, present };
  }

  static pool(rows, present) {
    const d = rows[0].length, mean = new Float32Array(d), mx = new Float32Array(d);
    let n = 0;
    for (let r = 0; r < rows.length; r++) if (present[r]) { n++; for (let k = 0; k < d; k++) mean[k] += rows[r][k]; }
    if (!n) return new Float32Array(2 * d);
    mx.fill(-Infinity);
    for (let r = 0; r < rows.length; r++) if (present[r]) for (let k = 0; k < d; k++) if (rows[r][k] > mx[k]) mx[k] = rows[r][k];
    const out = new Float32Array(2 * d);
    for (let k = 0; k < d; k++) { out[k] = mean[k] / n; out[d + k] = mx[k]; }
    return out;
  }

  forward(obs, mask) {
    const feats = [];
    const g = this.block(obs, 'global'); feats.push(g.rows[0]);
    const [bo, bn] = this.m.bondsAt; feats.push(this.mlp('bonds', obs.subarray(bo, bo + bn)));
    const ents = {};
    for (const name of Object.keys(this.m.layout)) { // the blocks this checkpoint has, in its trunk order
      if (name === 'global') continue;
      ents[name] = this.block(obs, name);
      feats.push(SPPolicy.pool(ents[name].rows, ents[name].present));
    }
    const cat = new Float32Array(feats.reduce((s, f) => s + f.length, 0)); let o = 0;
    for (const f of feats) { cat.set(f, o); o += f.length; }
    const c = this.linear('trunk.2', this.linear('trunk.0', cat, true), true);
    const logits = new Float32Array(this.A); let k = 0;
    for (const v of this.linear('scalar', c, false)) logits[k++] = v;
    for (const name of this.m.pointer) {
      for (const h of ents[name].rows) {
        const x = new Float32Array(h.length + c.length); x.set(h); x.set(c, h.length);
        logits[k++] = this.linear(`ptr.${name}.2`, this.linear(`ptr.${name}.0`, x, true), false)[0];
      }
    }
    if (mask) for (let a = 0; a < this.A; a++) if (!mask[a]) logits[a] = -1e9;
    const value = this.linear('value.2', this.linear('value.0', c, true), false)[0];
    return { logits, value };
  }
}

// parity check: node infer.mjs <policy base> <obs.f32> <mask.u8> <n>  → prints JSON of logits / values
if (process.argv[1] && process.argv[1].endsWith('infer.mjs') && process.argv.length >= 6) {
  const net = SPPolicy.load(process.argv[2]);
  const n = Number(process.argv[5]);
  const ob = readFileSync(process.argv[3]), mb = readFileSync(process.argv[4]);
  const obs = new Float32Array(ob.buffer.slice(ob.byteOffset, ob.byteOffset + ob.length)), mask = new Uint8Array(mb);
  const out = { logits: [], values: [] }; const t0 = performance.now();
  for (let i = 0; i < n; i++) { const r = net.forward(obs.subarray(i * net.D, (i + 1) * net.D), mask.subarray(i * net.A, (i + 1) * net.A)); out.logits.push(Array.from(r.logits)); out.values.push(r.value); }
  out.msPerForward = (performance.now() - t0) / n;
  process.stdout.write(JSON.stringify(out));
}
