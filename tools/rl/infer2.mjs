// tools/rl/infer2.mjs — exact rewrite of infer.mjs (same network, same outputs up to float rounding, ~2x less work):
// weight views cached at load; each encoder's embedding columns folded into per-code first-layer tables; absent rows
// skipped (they never enter pooling, and their actions are masked); pointer heads split as W_h·h + (W_c·c + b) with the
// context part once per head, legal rows only; the value head only on request; preallocated scratch buffers.
//   const net = SPPolicy2.load('policy');  const { logits, value } = net.forward(obs, mask, { value: false });
import { readFileSync } from 'node:fs';

export class SPPolicy2 {
  constructor(m, f32) {
    this.m = m; this.D = m.D; this.A = m.A;
    const W = (name) => { const t = m.tensors[name]; if (!t) throw new Error(`missing tensor ${name}`); return { data: f32.subarray(t.offset, t.offset + t.shape.reduce((x, y) => x * y, 1)), shape: t.shape }; };
    const lin = (p) => { const w = W(`${p}.weight`), b = W(`${p}.bias`); return { w: w.data, b: b.data, out: w.shape[0], inn: w.shape[1] }; };
    this.blocks = {};
    for (const [name, L] of Object.entries(m.layout)) {
      const l0 = lin(`enc.${name}.0`), l2 = lin(`enc.${name}.2`);
      // first-layer columns: numeric fields first, then each id field's embedding (model.py _block order)
      const tables = []; let col = L.numeric.length;
      for (const [field, voc] of L.ids) {
        const E = W(`emb.${voc}.weight`), dim = m.emb[voc], n = E.shape[0], T = new Float64Array(n * l0.out);
        for (let code = 0; code < n; code++) for (let o = 0; o < l0.out; o++) {
          let s = 0; const row = o * l0.inn + col;
          for (let k = 0; k < dim; k++) s += l0.w[row + k] * E.data[code * dim + k];
          T[code * l0.out + o] = s;
        }
        tables.push({ field, n, T }); col += dim;
      }
      this.blocks[name] = { L, l0, l2, tables, h0: new Float32Array(l0.out), rows: Array.from({ length: L.count }, () => new Float32Array(l2.out)),
        present: new Uint8Array(L.count) };
    }
    this.bonds0 = lin('bonds.0'); this.bonds2 = lin('bonds.2');
    this.trunk0 = lin('trunk.0'); this.trunk2 = lin('trunk.2'); this.scalarL = lin('scalar');
    this.ptr = {};
    for (const name of m.pointer) {
      const p0 = lin(`ptr.${name}.0`), p2 = lin(`ptr.${name}.2`), o = this.blocks[name].l2.out;
      this.ptr[name] = { p0, p2, o, cc: new Float64Array(p0.out), hid: new Float32Array(p0.out) };
    }
    this.value0 = lin('value.0'); this.value2 = lin('value.2');
    this.cat = new Float32Array(this.trunk0.inn); this.t0 = new Float32Array(this.trunk0.out); this.c = new Float32Array(this.trunk2.out);
    this.bh = new Float32Array(this.bonds0.out); this.bo = new Float32Array(this.bonds2.out);
    this.logits = new Float32Array(this.A);
  }

  static load(base) {
    const m = JSON.parse(readFileSync(`${base}.json`, 'utf8')), buf = readFileSync(`${base}.bin`);
    return new SPPolicy2(m, new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)));
  }

  static dense(l, x, xo, y, relu) { // y = relu?(W x + b), x read from offset xo
    const { w, b, out, inn } = l;
    for (let o = 0; o < out; o++) {
      let s = b[o]; const row = o * inn;
      for (let i = 0; i < inn; i++) s += w[row + i] * x[xo + i];
      y[o] = relu && s < 0 ? 0 : s;
    }
  }

  encode(obs, name) {
    const B = this.blocks[name], { L, l0, l2, tables, h0 } = B, num = L.numeric, nn = num.length;
    for (let r = 0; r < L.count; r++) {
      const base = L.offset + r * L.width;
      B.present[r] = obs[base] > 0.5 ? 1 : 0;
      if (!B.present[r] && name !== 'global') continue; // never pooled, its actions are masked
      for (let o = 0; o < l0.out; o++) {
        let s = l0.b[o]; const row = o * l0.inn;
        for (let i = 0; i < nn; i++) s += l0.w[row + i] * obs[base + num[i]];
        for (const t of tables) { let code = Math.round(obs[base + t.field]); if (!(code >= 0)) code = 0; if (code > t.n - 1) code = t.n - 1; s += t.T[code * l0.out + o]; }
        h0[o] = s < 0 ? 0 : s;
      }
      SPPolicy2.dense(l2, h0, 0, B.rows[r], true);
    }
  }

  forward(obs, mask, { value = true } = {}) {
    const cat = this.cat; let off;
    for (const name of Object.keys(this.m.layout)) this.encode(obs, name);
    cat.set(this.blocks.global.rows[0], 0); off = this.blocks.global.rows[0].length;
    const [bo] = this.m.bondsAt;
    SPPolicy2.dense(this.bonds0, obs, bo, this.bh, true); SPPolicy2.dense(this.bonds2, this.bh, 0, this.bo, true);
    cat.set(this.bo, off); off += this.bo.length;
    for (const name of Object.keys(this.m.layout)) {
      if (name === 'global') continue;
      const B = this.blocks[name], d = B.l2.out; let n = 0;
      for (let k = 0; k < d; k++) { cat[off + k] = 0; cat[off + d + k] = -Infinity; }
      for (let r = 0; r < B.L.count; r++) if (B.present[r]) {
        n++; const h = B.rows[r];
        for (let k = 0; k < d; k++) { cat[off + k] += h[k]; if (h[k] > cat[off + d + k]) cat[off + d + k] = h[k]; }
      }
      if (!n) for (let k = 0; k < 2 * d; k++) cat[off + k] = 0;
      else for (let k = 0; k < d; k++) cat[off + k] /= n;
      off += 2 * d;
    }
    SPPolicy2.dense(this.trunk0, cat, 0, this.t0, true); SPPolicy2.dense(this.trunk2, this.t0, 0, this.c, true);
    const c = this.c, logits = this.logits; logits.fill(-1e9);
    const sc = this.scalarL;
    for (let a = 0; a < sc.out; a++) if (!mask || mask[a]) { let s = sc.b[a]; for (let i = 0; i < sc.inn; i++) s += sc.w[a * sc.inn + i] * c[i]; logits[a] = s; }
    let k = sc.out;
    for (const name of this.m.pointer) {
      const P = this.ptr[name], B = this.blocks[name], { p0, p2, o, cc, hid } = P;
      let need = false;
      for (let r = 0; r < B.L.count; r++) if (!mask || mask[k + r]) { need = true; break; }
      if (need) for (let j = 0; j < p0.out; j++) { // the context half of the first layer, once per head
        let s = p0.b[j]; const row = j * p0.inn + o;
        for (let i = 0; i < c.length; i++) s += p0.w[row + i] * c[i];
        cc[j] = s;
      }
      for (let r = 0; r < B.L.count; r++, k++) {
        if (mask && !mask[k]) continue;
        const h = B.rows[r];
        for (let j = 0; j < p0.out; j++) { let s = cc[j]; const row = j * p0.inn; for (let i = 0; i < o; i++) s += p0.w[row + i] * h[i]; hid[j] = s < 0 ? 0 : s; }
        let s = p2.b[0]; for (let j = 0; j < p2.inn; j++) s += p2.w[j] * hid[j];
        logits[k] = s;
      }
    }
    let v = null;
    if (value) {
      const h = new Float32Array(this.value0.out); SPPolicy2.dense(this.value0, c, 0, h, true);
      let s = this.value2.b[0]; for (let j = 0; j < this.value2.inn; j++) s += this.value2.w[j] * h[j]; v = s;
    }
    return { logits, value: v };
  }
}
