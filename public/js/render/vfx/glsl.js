// render/vfx/glsl.js — GLSL ES 3.0 programs of the official battle effects' shader families (DESIGN §33.7; client
// docs: the official effects layer). Our own GLSL: each family reproduces the computation of the client's particle
// shaders as documented for the runtime (official shader source is never part of the repository).
//
//   vertexSource(kind)            'quad' (instanced particle quads: centre + two half-axis vectors per particle),
//                                 'mesh' (instanced meshes: centre + a 3×3 basis per instance — mesh particles and
//                                 MeshRenderers), 'strip' (CPU-built triangles: trails, lines, skinned meshes)
//   fragmentSource(family, defs)  the family's fragment shader; defs: { cvs (custom vertex streams), weight (_WEIGHT_ON),
//                                 lite (the light tier drops the distortion lookups) }
//   FAMILIES                      the families and the Unity properties each reads (uniform `u<name>`)
//
// Conventions of every family: material properties are uniforms named after the Unity property (`u_TintColor`,
// `u_MainTex`, `u_MainTex_ST` …); `u_Time` is Unity's _Time (t/20, t, 2t, 3t) on the battle clock; colours are in
// gamma space as the client renders them; the vertex colour is the particle / mesh colour; outputs are straight
// colour + alpha for the material's own blend state (render/vfx/gl.js maps the alpha factors for the transparent
// effect canvas). Custom vertex streams (the *(CustomData) shaders' `_HGCUSTOMVERTEXSTREAM_ON` variant) arrive packed
// as Unity packs them after the UV: v_t0 = TEXCOORD0.zw, v_t1 = TEXCOORD1, v_t2 = TEXCOORD2.

const HEAD = '#version 300 es\nprecision highp float;\nprecision highp int;\n';

const VARY_OUT = `out vec2 v_uv; out vec4 v_col; out vec2 v_t0; out vec4 v_t1; out vec4 v_t2; out vec3 v_wpos; out vec3 v_nrm;\n`;
const VARY_IN = `in vec2 v_uv; in vec4 v_col; in vec2 v_t0; in vec4 v_t1; in vec4 v_t2; in vec3 v_wpos; in vec3 v_nrm;\n`;

/** Attribute locations (shared by every program so one VAO layout fits all). */
export const LOC = Object.freeze({
  corner: 0, pos: 0, center: 1, ax: 2, ay: 3, m0: 2, m1: 3, color: 4, uvr: 5, t0: 6, t1: 7, t2: 8, nrm: 9, uv: 10, vcol: 11, m2: 12,
});

/**
 * The vertex shader of a geometry kind; `ext` (a family's vertex stage, FAMILIES[f].vs(defs)) switches to the
 * object-space template below. Kind 'meshr' is a MeshRenderer's mesh (object space = the mesh's own space); 'mesh'
 * without ext covers both.
 */
export function vertexSource(kind, ext) {
  if (ext) return extVertexSource(kind, ext);
  if (kind === 'meshr') kind = 'mesh';
  if (kind === 'quad') {
    return `${HEAD}
layout(location=0) in vec2 a_corner;
layout(location=1) in vec3 a_center;
layout(location=2) in vec3 a_ax;
layout(location=3) in vec3 a_ay;
layout(location=4) in vec4 a_color;
layout(location=5) in vec4 a_uvr;
layout(location=6) in vec2 a_t0;
layout(location=7) in vec4 a_t1;
layout(location=8) in vec4 a_t2;
uniform mat4 u_vp;
${VARY_OUT}
void main() {
  vec3 p = a_center + a_ax * a_corner.x + a_ay * a_corner.y;
  vec3 n = cross(a_ax, a_ay);
  float l = length(n);
  v_nrm = l > 1e-8 ? n / l : vec3(0.0, 0.0, -1.0);
  v_wpos = p;
  v_uv = a_uvr.xy + (a_corner + 0.5) * a_uvr.zw;
  v_col = a_color; v_t0 = a_t0; v_t1 = a_t1; v_t2 = a_t2;
  gl_Position = u_vp * vec4(p, 1.0);
}`;
  }
  if (kind === 'mesh') {
    return `${HEAD}
layout(location=0) in vec3 a_pos;
layout(location=9) in vec3 a_nrm;
layout(location=10) in vec2 a_uv;
layout(location=11) in vec4 a_vcol;
layout(location=1) in vec3 a_center;
layout(location=2) in vec3 a_m0;
layout(location=3) in vec3 a_m1;
layout(location=12) in vec3 a_m2;
layout(location=4) in vec4 a_color;
layout(location=5) in vec4 a_uvr;
layout(location=6) in vec2 a_t0;
layout(location=7) in vec4 a_t1;
layout(location=8) in vec4 a_t2;
uniform mat4 u_vp;
${VARY_OUT}
void main() {
  vec3 p = a_center + a_m0 * a_pos.x + a_m1 * a_pos.y + a_m2 * a_pos.z;
  vec3 n = mat3(a_m0, a_m1, a_m2) * a_nrm;
  float l = length(n);
  v_nrm = l > 1e-8 ? n / l : vec3(0.0, 0.0, -1.0);
  v_wpos = p;
  v_uv = a_uvr.xy + a_uv * a_uvr.zw;
  v_col = a_color * a_vcol; v_t0 = a_t0; v_t1 = a_t1; v_t2 = a_t2;
  gl_Position = u_vp * vec4(p, 1.0);
}`;
  }
  // strip
  return `${HEAD}
layout(location=0) in vec3 a_pos;
layout(location=10) in vec2 a_uv;
layout(location=11) in vec4 a_vcol;
layout(location=9) in vec3 a_nrm;
uniform mat4 u_vp;
${VARY_OUT}
void main() {
  v_wpos = a_pos;
  float l = length(a_nrm);
  v_nrm = l > 1e-8 ? a_nrm / l : vec3(0.0, 0.0, -1.0);
  v_uv = a_uv; v_col = a_vcol; v_t0 = vec2(0.0); v_t1 = vec4(0.0); v_t2 = vec4(0.0);
  gl_Position = u_vp * vec4(a_pos, 1.0);
}`;
}

/**
 * The vertex stage of the families that work in the shader's object space (动态立绘 3D / vertex shaders): the client's
 * object space is a MeshRenderer's mesh space (ObjectToWorld = the renderer's transform, kind 'meshr'); particle
 * meshes, billboards and CPU-built strips reach the shader in world space with an identity ObjectToWorld (Unity bakes
 * the particle transform into the vertices). In main(): `op` / `on` the object-space position / normal (ext.pre may
 * move op), `o2w`, then the world position / normal (inverse transpose, normalised per vertex), clip position, and
 * ext.post (extra varyings, may move gl_Position). Uniforms u_V / u_P are Unity's view and projection matrices.
 */
function extVertexSource(kind, ext) {
  const attrs = kind === 'quad' ? `layout(location=0) in vec2 a_corner;
layout(location=1) in vec3 a_center;
layout(location=2) in vec3 a_ax;
layout(location=3) in vec3 a_ay;`
    : kind === 'strip' ? `layout(location=0) in vec3 a_pos;
layout(location=10) in vec2 a_uv;
layout(location=11) in vec4 a_vcol;
layout(location=9) in vec3 a_nrm;`
      : `layout(location=0) in vec3 a_pos;
layout(location=9) in vec3 a_nrm;
layout(location=10) in vec2 a_uv;
layout(location=11) in vec4 a_vcol;
layout(location=1) in vec3 a_center;
layout(location=2) in vec3 a_m0;
layout(location=3) in vec3 a_m1;
layout(location=12) in vec3 a_m2;`;
  const inst = kind === 'strip' ? '' : `
layout(location=4) in vec4 a_color;
layout(location=5) in vec4 a_uvr;
layout(location=6) in vec2 a_t0;
layout(location=7) in vec4 a_t1;
layout(location=8) in vec4 a_t2;`;
  const setup = kind === 'quad' ? `
  vec3 cn = cross(a_ax, a_ay); float cl = length(cn);
  vec4 op = vec4(a_center + a_ax * a_corner.x + a_ay * a_corner.y, 1.0);
  vec3 on = cl > 1e-8 ? cn / cl : vec3(0.0, 0.0, -1.0);
  mat4 o2w = mat4(1.0);
  vec2 uv0 = a_uvr.xy + (a_corner + 0.5) * a_uvr.zw;
  v_col = a_color; v_t0 = a_t0; v_t1 = a_t1; v_t2 = a_t2;`
    : kind === 'strip' ? `
  vec4 op = vec4(a_pos, 1.0);
  vec3 on = a_nrm;
  mat4 o2w = mat4(1.0);
  vec2 uv0 = a_uv;
  v_col = a_vcol; v_t0 = vec2(0.0); v_t1 = vec4(0.0); v_t2 = vec4(0.0);`
      : kind === 'meshr' ? `
  vec4 op = vec4(a_pos, 1.0);
  vec3 on = a_nrm;
  mat4 o2w = mat4(vec4(a_m0, 0.0), vec4(a_m1, 0.0), vec4(a_m2, 0.0), vec4(a_center, 1.0));
  vec2 uv0 = a_uvr.xy + a_uv * a_uvr.zw;
  v_col = a_color * a_vcol; v_t0 = a_t0; v_t1 = a_t1; v_t2 = a_t2;`
        : `
  mat3 pm = mat3(a_m0, a_m1, a_m2);
  vec4 op = vec4(a_center + pm * a_pos, 1.0);
  vec3 on = pm * a_nrm;
  mat4 o2w = mat4(1.0);
  vec2 uv0 = a_uvr.xy + a_uv * a_uvr.zw;
  v_col = a_color * a_vcol; v_t0 = a_t0; v_t1 = a_t1; v_t2 = a_t2;`;
  return `${HEAD}
${attrs}${inst}
uniform mat4 u_vp;
uniform mat4 u_V;
uniform mat4 u_P;
uniform vec4 u_Time;
uniform vec4 u_Screen;
uniform vec3 u_WorldSpaceCameraPos;
${VARY_OUT}${ext.decl || ''}
void main() {${setup}
  v_uv = uv0;
${ext.pre || ''}
  vec4 wp = o2w * op;
  vec3 wn = transpose(inverse(mat3(o2w))) * on;
  float wl = length(wn);
  v_nrm = wl > 1e-8 ? wn / wl : vec3(0.0, 0.0, -1.0);
  v_wpos = wp.xyz;
  gl_Position = u_vp * wp;
${ext.post || ''}
}`;
}

/** Depth-only heightfield of the board (the ground pass's pre-pass): board positions through u_vp. */
export const DEPTH_VS = `${HEAD}
layout(location=0) in vec3 a_pos;
uniform mat4 u_vp;
void main() { gl_Position = u_vp * vec4(a_pos, 1.0); }`;
export const DEPTH_FS = `${HEAD}
out vec4 o;
void main() { o = vec4(0.0); }`;

// ---- fragment families --------------------------------------------------------------------------------------------

const COMMON = `
uniform vec4 u_Time;
uniform vec3 u_WorldSpaceCameraPos;
out vec4 o_col;
vec4 chan4(vec4 c, float ch) { return ch < 0.5 ? c : ch < 1.5 ? c.rrrr : ch < 2.5 ? c.gggg : ch < 3.5 ? c.bbbb : c.aaaa; }
float chan1(vec4 c, float ch) { return ch < 0.5 ? c.r : ch < 1.5 ? c.g : ch < 2.5 ? c.b : c.a; }
vec2 st(vec2 uv, vec4 s) { return uv * s.xy + s.zw; }
float dissolveMask(float d, float amount, float border) {
  float r = 1.0 - roundEven(amount + 0.5);
  return clamp((d - amount + border * r) / max(border, 1e-4), 0.0, 1.0);
}
vec2 uvRot(vec2 uv, vec4 r, float on) { vec2 c = uv - 0.5; return on > 0.5 ? vec2(dot(c, r.xz), dot(c, r.yw)) + 0.5 : uv; }
vec4 premul(vec3 rgb, float a, float pm) { return pm < 1.5 ? vec4(rgb * a * 2.0, a) : vec4(rgb, a); }
`;

const S = (names) => names.map((n) => `uniform sampler2D u${n};`).join('\n');
const U4 = (names) => names.map((n) => `uniform vec4 u${n};`).join('\n');
const U1 = (names) => names.map((n) => `uniform float u${n};`).join('\n');

/**
 * Families: `src(defs)` → fragment body, `props` the Unity properties read (for the material compiler's uniform
 * list; textures listed in `tex`).
 */
export const FAMILIES = {
  // Additive / AlphaBlend and their L2D, Bloom, ZWrite, ZDistort, TileBasedTint relatives: 2 × vertex colour × tint ×
  // the main texture (or one of its channels); AlphaBlend's _PremultiplyAlpha source factor One premultiplies (×2 more)
  basic: {
    tex: ['_MainTex'],
    src: () => `${S(['_MainTex'])}
${U4(['_MainTex_ST', '_TintColor'])}
${U1(['_MainTexChannel', '_PremultiplyAlpha'])}
void main() {
  vec4 c = chan4(texture(u_MainTex, st(v_uv, u_MainTex_ST)), u_MainTexChannel) * 2.0 * v_col * u_TintColor;
  float a = clamp(c.a, 0.0, 1.0);
  o_col = premul(c.rgb, a, u_PremultiplyAlpha);
}`,
  },
  // Unity's built-in 'Legacy Shaders/Particles/Alpha Blended Premultiply': colour × texture × colour alpha (blend One,
  // OneMinusSrcAlpha) — the disabled timing systems' Default-Particle material mostly
  legacyPremul: {
    tex: ['_MainTex'],
    src: () => `${S(['_MainTex'])}
${U4(['_MainTex_ST'])}
void main() { o_col = v_col * texture(u_MainTex, st(v_uv, u_MainTex_ST)) * v_col.a; }`,
  },
  // 'Legacy Shaders/Particles/Alpha Blended'
  legacyAlpha: {
    tex: ['_MainTex'],
    src: () => `${S(['_MainTex'])}
${U4(['_MainTex_ST', '_TintColor'])}
void main() { vec4 c = 2.0 * v_col * u_TintColor * texture(u_MainTex, st(v_uv, u_MainTex_ST)); o_col = vec4(c.rgb, clamp(c.a, 0.0, 1.0)); }`,
  },
  // 'Particles/Standard Unlit' (multiply colour mode, emission)
  stdUnlit: {
    tex: ['_MainTex', '_EmissionMap'],
    src: () => `${S(['_MainTex', '_EmissionMap'])}
${U4(['_MainTex_ST', '_Color', '_EmissionColor'])}
${U1(['_EmissionEnabled'])}
void main() {
  vec4 c = texture(u_MainTex, st(v_uv, u_MainTex_ST)) * u_Color * v_col;
  if (u_EmissionEnabled > 0.5) c.rgb += texture(u_EmissionMap, st(v_uv, u_MainTex_ST)).rgb * u_EmissionColor.rgb;
  o_col = vec4(c.rgb, clamp(c.a, 0.0, 1.0));
}`,
  },
  // Dissolve AB / Add: the main texture's alpha cut by a noise texture against _Amount with a soft _BorderWidth
  dissolve: {
    tex: ['_MainTex', '_DissolveTex'],
    src: () => `${S(['_MainTex', '_DissolveTex'])}
${U4(['_MainTex_ST', '_DissolveTex_ST', '_TintColor'])}
${U1(['_Amount', '_BorderWidth'])}
void main() {
  float m = dissolveMask(texture(u_DissolveTex, st(v_uv, u_DissolveTex_ST)).r, u_Amount, u_BorderWidth);
  vec4 c = 2.0 * v_col * u_TintColor * texture(u_MainTex, st(v_uv, u_MainTex_ST));
  o_col = vec4(c.rgb, clamp(m * c.a, 0.0, 1.0));
}`,
  },
  // Dissolve AB / Add UVTween: both UVs scrolled by _Time × _UVTween (xy main, zw dissolve), wrapped
  dissolveTween: {
    tex: ['_MainTex', '_DissolveTex'],
    src: () => `${S(['_MainTex', '_DissolveTex'])}
${U4(['_MainTex_ST', '_DissolveTex_ST', '_TintColor', '_UVTween'])}
${U1(['_Amount', '_BorderWidth'])}
void main() {
  vec4 tw = u_Time.y * u_UVTween;
  vec2 duv = fract(st(v_uv, u_DissolveTex_ST) + tw.zw), muv = fract(st(v_uv, u_MainTex_ST) + tw.xy);
  float m = dissolveMask(texture(u_DissolveTex, duv).r, u_Amount, u_BorderWidth);
  vec4 c = 2.0 * v_col * u_TintColor * texture(u_MainTex, muv);
  o_col = vec4(c.rgb, clamp(m * c.a, 0.0, 1.0));
}`,
  },
  // Dissolve (VertexColor Major): the vertex alpha drives the dissolve, the tint only the final alpha
  dissolveVc: {
    tex: ['_MainTex', '_DissolveTex'],
    src: () => `${S(['_MainTex', '_DissolveTex'])}
${U4(['_MainTex_ST', '_DissolveTex_ST', '_TintColor'])}
${U1(['_BorderWidth'])}
void main() {
  float d = texture(u_DissolveTex, st(v_uv, u_DissolveTex_ST)).r;
  float m = clamp((d - (1.0 - v_col.a) + v_col.a * u_BorderWidth) / max(u_BorderWidth, 1e-4), 0.0, 1.0);
  vec4 t = texture(u_MainTex, st(v_uv, u_MainTex_ST));
  o_col = vec4(t.rgb * 2.0 * v_col.rgb, clamp(t.a * m * u_TintColor.a, 0.0, 1.0));
}`,
  },
  // Dissolve … Double: two dissolve textures, each with its amount and border
  dissolveDouble: {
    tex: ['_MainTex', '_DissolveTex_01', '_DissolveTex_02'],
    src: () => `${S(['_MainTex', '_DissolveTex_01', '_DissolveTex_02'])}
${U4(['_MainTex_ST', '_DissolveTex_01_ST', '_DissolveTex_02_ST', '_TintColor'])}
${U1(['_Amount_01', '_BorderWidth_01', '_Amount_02', '_BorderWidth_02'])}
void main() {
  float m1 = dissolveMask(texture(u_DissolveTex_01, st(v_uv, u_DissolveTex_01_ST)).r, u_Amount_01, u_BorderWidth_01);
  float m2 = dissolveMask(texture(u_DissolveTex_02, st(v_uv, u_DissolveTex_02_ST)).r, u_Amount_02, u_BorderWidth_02);
  vec4 c = 2.0 * v_col * u_TintColor * texture(u_MainTex, st(v_uv, u_MainTex_ST));
  o_col = vec4(c.rgb, clamp(m1 * m2 * c.a, 0.0, 1.0));
}`,
  },
  // Dissolve(CustomData): scrolled main / dissolve UVs, optional dissolve (_UseDissolveTex) by _DissolveIntensity;
  // the custom streams add UV offsets and the intensity / border
  dissolveCd: {
    tex: ['_MainTex', '_DissolveTex'],
    src: (d) => `${S(['_MainTex', '_DissolveTex'])}
${U4(['_MainTex_ST', '_DissolveTex_ST', '_MainColor'])}
${U1(['_MainUSpeed', '_MainVSpeed', '_DissolveUSpeed', '_DissolveVSpeed', '_MainTexChannel', '_DissolvTexChannel', '_Opacity', '_UseDissolveTex', '_DissolveIntensity', '_BorderWidth', '_PremultiplyAlpha'])}
void main() {
  vec2 muv = st(v_uv, u_MainTex_ST), duv = st(v_uv, u_DissolveTex_ST);
  float inten = u_DissolveIntensity, border = u_BorderWidth;
  ${d.cvs ? 'muv += v_t0; duv += v_t1.xy; inten += v_t1.z; border = clamp(border + v_t1.w, 0.0, 1.0);' : ''}
  muv += u_Time.y * vec2(u_MainUSpeed, u_MainVSpeed);
  duv += u_Time.y * vec2(u_DissolveUSpeed, u_DissolveVSpeed);
  vec4 t = chan4(texture(u_MainTex, muv), u_MainTexChannel);
  float dv = chan1(texture(u_DissolveTex, duv), u_DissolvTexChannel);
  float m = dissolveMask(dv, inten, border);
  float a = t.a * u_MainColor.a * v_col.a * 2.0 * u_Opacity;
  a = clamp(mix(a, m * a, u_UseDissolveTex), 0.0, 1.0);
  vec3 rgb = t.rgb * v_col.rgb * u_MainColor.rgb * 2.0;
  o_col = premul(rgb, a, u_PremultiplyAlpha);
}`,
  },
  // Disturb Origin: the main UV pushed by a distortion texture × (_IntensityU, _IntensityV)
  disturbOrigin: {
    tex: ['_MainTex', '_DisturTex'],
    src: (d) => `${S(['_MainTex', '_DisturTex'])}
${U4(['_MainTex_ST', '_DisturTex_ST', '_MainColor'])}
${U1(['_IntensityU', '_IntensityV'])}
void main() {
  float n = ${d.lite ? '0.0' : 'texture(u_DisturTex, st(v_uv, u_DisturTex_ST)).r'};
  vec2 uv = st(v_uv + n * vec2(u_IntensityU, u_IntensityV), u_MainTex_ST);
  vec4 c = texture(u_MainTex, uv) * u_MainColor * v_col * u_MainColor.a;
  o_col = c * 2.0;
}`,
  },
  // Disturb Anchor: distortion around an anchor (one or two textures, optional weight map and dissolve), UV tween
  disturbAnchor: {
    tex: ['_MainTex', '_DisturTex', '_DisturTex_02', '_WeightTex', '_DissolveTex'],
    src: (d) => `${S(['_MainTex', '_DisturTex', '_DisturTex_02', '_WeightTex', '_DissolveTex'])}
${U4(['_MainTex_ST', '_DisturTex_ST', '_DisturTex_02_ST', '_WeightTex_ST', '_DissolveTex_ST', '_MainColor', '_UVTween'])}
${U1(['_MainColorACtrl', '_IntensityU', '_IntensityV', '_AnchorU', '_AnchorV', '_ToggleUseDisturb2', '_IntensityU_02', '_IntensityV_02', '_AnchorU_02', '_AnchorV_02', '_ToggleUseDissolve', '_Amount', '_BorderWidth'])}
void main() {
  vec4 tw = fract(u_Time.y * u_UVTween);
  vec2 d1 = vec2(0.0), d2 = vec2(0.0);
  ${d.lite ? '' : `
  float n1 = texture(u_DisturTex, st(v_uv, u_DisturTex_ST) + tw.zw).r;
  d1 = vec2(n1) - vec2(u_AnchorU, u_AnchorV);
  if (u_ToggleUseDisturb2 > 0.5) d2 = vec2(texture(u_DisturTex_02, st(v_uv, u_DisturTex_02_ST)).r) - vec2(u_AnchorU_02, u_AnchorV_02);
  ${d.weight ? 'vec2 w = texture(u_WeightTex, st(v_uv, u_WeightTex_ST)).rg; d1 *= w; d2 *= w;' : ''}`}
  vec2 uv = v_uv + d1 * vec2(u_IntensityU, u_IntensityV) + d2 * vec2(u_IntensityU_02, u_IntensityV_02);
  vec4 c = texture(u_MainTex, st(uv, u_MainTex_ST) + tw.xy) * u_MainColor * v_col * 2.0;
  c.a *= 1.0 + u_MainColorACtrl * (u_MainColor.a - 1.0);
  c.rgb *= 1.0 + u_MainColorACtrl * (u_MainColor.a - 1.0);
  if (u_ToggleUseDissolve > 0.5) c.a = clamp(c.a * dissolveMask(texture(u_DissolveTex, st(uv, u_DissolveTex_ST)).r, u_Amount, u_BorderWidth), 0.0, 1.0);
  o_col = c;
}`,
  },
  // Disturb(CustomData): weight-masked distortion of the main UV (and optionally the dissolve UV), scrolled UVs,
  // optional UV rotations (FxUVRotation), dissolve, opacity
  disturbCd: {
    tex: ['_MainTex', '_DisturbTex', '_WeightTex', '_DissolveTex'],
    src: (d) => `${S(['_MainTex', '_DisturbTex', '_WeightTex', '_DissolveTex'])}
${U4(['_MainTex_ST', '_DissolveTex_ST', '_DisturbTex_ST', '_WeightTex_ST', '_MainColor', '_Rotation0', '_Rotation1', '_Rotation2', '_Rotation3'])}
${U1(['_HG_UV_ROTATION', '_MainUSpeed', '_MainVSpeed', '_DissolveUSpeed', '_DissolveVSpeed', '_DisturbUSpeed', '_DisturbVSpeed', '_MainTexChannel', '_DisturbTexChannel', '_DissolvTexChannel', '_Opacity', '_PremultiplyAlpha', '_DisturbInfluenceDissolveUV', '_Amount', '_BorderWidth', '_IntensityU', '_IntensityV', '_DisturbScale'])}
void main() {
  vec2 o0 = vec2(0.0), o1 = vec2(0.0), o3 = vec2(0.0); float addA = 0.0, addI = 0.0;
  ${d.cvs ? 'o0 = v_t0; o1 = v_t1.xy; addA = v_t1.z; addI = v_t1.w; o3 = v_t2.xy;' : ''}
  vec2 muv = uvRot(st(v_uv, u_MainTex_ST) + o0, u_Rotation0, u_HG_UV_ROTATION) + fract(u_Time.y * vec2(u_MainUSpeed, u_MainVSpeed));
  vec2 duv = uvRot(st(v_uv, u_DissolveTex_ST) + o1, u_Rotation1, u_HG_UV_ROTATION) + fract(u_Time.y * vec2(u_DissolveUSpeed, u_DissolveVSpeed));
  vec2 wuv = uvRot(st(v_uv, u_WeightTex_ST), u_Rotation2, u_HG_UV_ROTATION);
  vec2 tuv = uvRot(st(v_uv, u_DisturbTex_ST) + o3, u_Rotation3, u_HG_UV_ROTATION) + fract(u_Time.y * vec2(u_DisturbUSpeed, u_DisturbVSpeed));
  vec2 dist = vec2(0.0);
  ${d.lite ? '' : `vec2 w = texture(u_WeightTex, wuv).rg;
  dist = (vec2(addI) + vec2(u_IntensityU, u_IntensityV)) * chan1(texture(u_DisturbTex, tuv), u_DisturbTexChannel) * w;`}
  float sc = u_DisturbScale > 0.0 ? u_DisturbScale : 1.0;
  vec4 t = chan4(texture(u_MainTex, muv + dist * sc), u_MainTexChannel) * u_MainColor * v_col;
  float a = 2.0 * t.a * u_Opacity;
  float dv = chan1(texture(u_DissolveTex, duv + u_DisturbInfluenceDissolveUV * dist), u_DissolvTexChannel);
  a = clamp(dissolveMask(dv, u_Amount + addA, u_BorderWidth) * a, 0.0, 1.0);
  o_col = premul(t.rgb * 2.0, a, u_PremultiplyAlpha);
}`,
  },
  // Ram/Disturb(CustomData): Disturb(CustomData) with a ramp texture multiplied in
  // Ram/VertexDisturb(CustomData) (defs.vdist): the same fragment without channel selects and with the main UV pushed at
  // full strength, after a vertex stage that moves each vertex in object space by (_VertexDisturbTex.rgb − 0.5) ×
  // _VertexDisturbWeightTex.r × _VertexDisturbIntensity (the disturb texture scrolled by _VertexDisturbU/VSpeed ×
  // _Time.y, both read at LOD 0 with the vertex UV), plus normalize(normal) × (R − 0.5) × weight ×
  // _NormalDisturbIntensity when _NormalDisturb > 0
  ramDisturbCd: {
    tex: ['_MainTex', '_DisturbTex', '_RamTex', '_DissolveTex', '_VertexDisturbTex', '_VertexDisturbWeightTex'],
    vs: (d) => (!d.vdist ? null : {
      decl: `uniform sampler2D u_VertexDisturbTex;
uniform sampler2D u_VertexDisturbWeightTex;
uniform vec4 u_VertexDisturbTex_ST;
uniform vec4 u_VertexDisturbWeightTex_ST;
uniform vec4 u_VertexDisturbIntensity;
uniform float u_VertexDisturbUSpeed;
uniform float u_VertexDisturbVSpeed;
uniform float u_NormalDisturb;
uniform float u_NormalDisturbIntensity;
`,
      pre: `  vec3 vd = textureLod(u_VertexDisturbTex, uv0 * u_VertexDisturbTex_ST.xy + u_VertexDisturbTex_ST.zw + fract(vec2(u_VertexDisturbUSpeed, u_VertexDisturbVSpeed) * u_Time.y), 0.0).xyz - 0.5;
  float vw = textureLod(u_VertexDisturbWeightTex, uv0 * u_VertexDisturbWeightTex_ST.xy + u_VertexDisturbWeightTex_ST.zw, 0.0).r;
  vec3 voff = vd * vw * u_VertexDisturbIntensity.xyz;
  if (0.0 < u_NormalDisturb) voff += on * inversesqrt(dot(on, on)) * vd.x * vw * u_NormalDisturbIntensity;
  op.xyz += voff;`,
    }),
    src: (d) => `${S(['_MainTex', '_DisturbTex', '_RamTex', '_DissolveTex'])}
${U4(['_MainTex_ST', '_DissolveTex_ST', '_DisturbTex_ST', '_RamTex_ST', '_MainColor', '_Rotation0', '_Rotation1', '_Rotation2', '_Rotation3'])}
${U1(['_HG_UV_ROTATION', '_MainUSpeed', '_MainVSpeed', '_DissolveUSpeed', '_DissolveVSpeed', '_DisturbUSpeed', '_DisturbVSpeed', '_MainTexChannel', '_DisturbTexChannel', '_DissolvTexChannel', '_RamTexChannel', '_Opacity', '_PremultiplyAlpha', '_DisturbInfluenceDissolveUV', '_DisturbInfluenceMainUV', '_Amount', '_BorderWidth', '_IntensityU', '_IntensityV'])}
void main() {
  vec2 o0 = vec2(0.0), o1 = vec2(0.0), o3 = vec2(0.0); float addA = 0.0, addI = 0.0;
  ${d.cvs ? 'o0 = v_t0; o1 = v_t1.xy; addA = v_t1.z; addI = v_t1.w; o3 = v_t2.xy;' : ''}
  vec2 muv = uvRot(st(v_uv, u_MainTex_ST) + o0, u_Rotation0, u_HG_UV_ROTATION) + fract(u_Time.y * vec2(u_MainUSpeed, u_MainVSpeed));
  vec2 duv = uvRot(st(v_uv, u_DissolveTex_ST) + o1, u_Rotation1, u_HG_UV_ROTATION) + fract(u_Time.y * vec2(u_DissolveUSpeed, u_DissolveVSpeed));
  vec2 ruv = uvRot(st(v_uv, u_RamTex_ST), u_Rotation2, u_HG_UV_ROTATION);
  vec2 tuv = uvRot(st(v_uv, u_DisturbTex_ST) + o3, u_Rotation3, u_HG_UV_ROTATION) + fract(u_Time.y * vec2(u_DisturbUSpeed, u_DisturbVSpeed));
  vec4 ram = ${d.vdist ? 'texture(u_RamTex, ruv)' : 'chan4(texture(u_RamTex, ruv), u_RamTexChannel)'};
  vec4 dist = vec4(0.0);
  ${d.lite ? '' : `dist = (vec4(addI) + vec4(u_IntensityU, u_IntensityV, u_IntensityU, u_IntensityV)) * ${d.vdist ? 'texture(u_DisturbTex, tuv).r' : 'chan1(texture(u_DisturbTex, tuv), u_DisturbTexChannel)'};`}
  vec2 muv2 = muv + dist.xy${d.vdist ? '' : ' * u_DisturbInfluenceMainUV'};
  vec2 duv2 = duv + dist.zw * u_DisturbInfluenceDissolveUV;
  vec4 t = ${d.vdist ? 'texture(u_MainTex, muv2)' : 'chan4(texture(u_MainTex, muv2), u_MainTexChannel)'} * u_MainColor * v_col * ram;
  float a = 2.0 * t.a * u_Opacity;
  float dv = ${d.vdist ? 'texture(u_DissolveTex, duv2).r' : 'chan1(texture(u_DissolveTex, duv2), u_DissolvTexChannel)'};
  a = clamp(dissolveMask(dv, u_Amount + addA, u_BorderWidth) * a, 0.0, 1.0);
  o_col = premul(t.rgb * 2.0, a, u_PremultiplyAlpha);
}`,
  },
  // Ram Add / AlphaBlend: main texture × a ramp texture × 2 × colour
  ram: {
    tex: ['_MainTex', '_RamTex'],
    src: () => `${S(['_MainTex', '_RamTex'])}
${U4(['_MainTex_ST', '_RamTex_ST', '_TintColor'])}
void main() {
  vec4 c = texture(u_RamTex, st(v_uv, u_RamTex_ST)) * 2.0 * v_col * u_TintColor * texture(u_MainTex, st(v_uv, u_MainTex_ST));
  o_col = vec4(c.rgb, clamp(c.a, 0.0, 1.0));
}`,
  },
  // Mask (Add / AlphaBlend): main texture + 2 × an added texture masked by the mask's alpha × _AddFactor
  mask: {
    tex: ['_MainTex', '_MaskTex', '_AddTex'],
    src: () => `${S(['_MainTex', '_MaskTex', '_AddTex'])}
${U4(['_MainTex_ST', '_AddTex_ST', '_TintColor'])}
${U1(['_AddFactor'])}
void main() {
  vec2 muv = st(v_uv, u_MainTex_ST);
  vec4 add = texture(u_AddTex, st(v_uv, u_AddTex_ST)) * texture(u_MaskTex, muv).a * u_AddFactor;
  vec4 c = (add * 2.0 + texture(u_MainTex, muv)) * 2.0 * v_col * u_TintColor;
  o_col = vec4(c.rgb, clamp(c.a, 0.0, 1.0));
}`,
  },
  // Rim Texture (Add / AlphaBlend): a fresnel rim (1 − n·v)^_RimPower × tint × colour, × 2 × texture
  rimTex: {
    tex: ['_MainTex'],
    src: () => `${S(['_MainTex'])}
${U4(['_MainTex_ST', '_TintColor'])}
${U1(['_RimPower'])}
void main() {
  vec3 v = normalize(u_WorldSpaceCameraPos - v_wpos);
  float r = pow(max(1.0 - clamp(dot(v, normalize(v_nrm)), 0.0, 1.0), 1e-5), u_RimPower);
  vec4 c = vec4(r * u_TintColor.rgb * v_col.rgb, r * u_TintColor.a) * 2.0 * texture(u_MainTex, st(v_uv, u_MainTex_ST));
  o_col = vec4(c.rgb, clamp(c.a, 0.0, 1.0));
}`,
  },
  // Rim Tint (Add / AlphaBlend): the rim colour alone
  rimTint: {
    tex: [],
    src: () => `${U4(['_TintColor'])}
${U1(['_RimPower'])}
void main() {
  vec3 v = normalize(u_WorldSpaceCameraPos - v_wpos);
  float r = pow(max(1.0 - clamp(dot(v, normalize(v_nrm)), 0.0, 1.0), 1e-5), u_RimPower);
  o_col = vec4(r * u_TintColor.rgb * v_col.rgb, r * u_TintColor.a);
}`,
  },
  // Flipbook (Add / Blend): an in-shader sprite sheet (_Rows × _Columns at _Speed), adjacent frames blended
  flipbook: {
    tex: ['_MainTex'],
    src: () => `${S(['_MainTex'])}
${U4(['_TintColor'])}
${U1(['_Rows', '_Columns', '_Speed', '_AlphaIntensity'])}
void main() {
  float n = max(1.0, u_Rows * u_Columns), t = u_Time.y * u_Speed;
  float f = fract(t) * n, f0 = floor(f), f1 = mod(f0 + 1.0, n), k = fract(f);
  vec2 cell = vec2(1.0 / max(u_Rows, 1.0), 1.0 / max(u_Columns, 1.0));
  vec2 c0 = vec2(mod(f0, u_Rows), u_Columns - 1.0 - floor(f0 / u_Rows));
  vec2 c1 = vec2(mod(f1, u_Rows), u_Columns - 1.0 - floor(f1 / u_Rows));
  vec4 c = mix(texture(u_MainTex, (c0 + v_uv) * cell), texture(u_MainTex, (c1 + v_uv) * cell), k);
  c.a = clamp(c.a * u_AlphaIntensity, 0.0, 1.0);
  o_col = c * v_col * u_TintColor;
}`,
  },
  // Multiply: lerp(1, texture × colour, texture alpha × colour alpha) (blend DstColor Zero — gl.js maps it for the
  // transparent canvas: darkening by the luminance)
  // ---- the 动态立绘 scenes' L2D shaders the battle set does not use (spike/dyn-fx-20261116; formulas from the client's
  // D3D11 bytecode as decoded for the runtime developer, kept outside the repository) ----
  // Disturb2 (AlphaBlend / Add): the main UV pushed by two scrolled noise lookups of one texture (R, G) × Noise*Param.zw;
  // `_DisturbMode` Glow mixes _MainColor by R and _GlowColor by G instead (vertex colour unused)
  disturb2: {
    tex: ['_MainTex', '_DisturTex'],
    src: (d) => `${S(['_MainTex', '_DisturTex'])}
${U4(['_MainTex_ST', '_MainColor', '_GlowColor', '_Noise1Param', '_Noise2Param'])}
void main() {
  vec2 uvM = st(v_uv, u_MainTex_ST);
  vec2 n1uv = vec2(uvM.x * u_Noise1Param.x + fract(u_Noise1Param.y * u_Time.x), uvM.y * u_Noise1Param.x);
  vec2 n2uv = vec2(uvM.x * u_Noise2Param.x + fract(u_Noise2Param.y * u_Time.x), uvM.y * u_Noise2Param.x);
  float n1 = ${d.lite ? '0.0' : 'texture(u_DisturTex, n1uv).r'}, n2 = ${d.lite ? '0.0' : 'texture(u_DisturTex, n2uv).g'};
  vec4 m = texture(u_MainTex, uvM + 0.1 * (n1 * u_Noise1Param.zw + n2 * u_Noise2Param.zw));
  ${d.glow ? 'o_col = clamp(m.r * u_MainColor + m.g * u_GlowColor, 0.0, 1.0);'
    : d.add ? 'o_col = clamp(vec4(m.a * m.rgb * u_MainColor.rgb, m.a * u_MainColor.a * v_col.a), 0.0, 1.0);'
      : 'o_col = clamp(vec4(m.rgb * u_MainColor.rgb, m.a * u_MainColor.a * v_col.a), 0.0, 1.0);'}
}`,
  },
  // Dissolve AB / Add Double edge: Dissolve Double whose dissolve edge (width _Edgecolor.a) blends to _Edgecolor.rgb
  // by (1 − smoothstep)^_pow
  dissolveDoubleEdge: {
    tex: ['_MainTex', '_DissolveTex_01', '_DissolveTex_02'],
    src: (d) => `${S(['_MainTex', '_DissolveTex_01', '_DissolveTex_02'])}
${U4(['_MainTex_ST', '_DissolveTex_01_ST', '_DissolveTex_02_ST', '_TintColor', '_Edgecolor'])}
${U1(['_Amount_01', '_BorderWidth_01', '_Amount_02', '_BorderWidth_02', '_pow'])}
void main() {
  float k1 = dissolveMask(texture(u_DissolveTex_01, st(v_uv, u_DissolveTex_01_ST)).r, u_Amount_01, u_BorderWidth_01);
  float k2 = dissolveMask(texture(u_DissolveTex_02, st(v_uv, u_DissolveTex_02_ST)).r, u_Amount_02, u_BorderWidth_02);
  vec4 c = 2.0 * v_col * u_TintColor * texture(u_MainTex, st(v_uv, u_MainTex_ST));
  float kk = k1 * k2;
  ${d.add ? `float s = clamp(kk / max(u_Edgecolor.a, 1e-4), 0.0, 1.0);
  float e = pow(max(1.0 - s * s * (3.0 - 2.0 * s), 0.0), u_pow);`
    : `float s = clamp((kk + 0.001) / (u_Edgecolor.a + 0.001), 0.0, 1.0);
  float e = max(pow(max(1.0 - s * s * (3.0 - 2.0 * s), 0.0), u_pow), 0.001);`}
  o_col = vec4(mix(c.rgb, u_Edgecolor.rgb, e), clamp(kk * c.a * mix(1.0, u_Edgecolor.a, e), 0.0, 1.0));
}`,
  },
  // Mask/Erase: black by (1 − R) × _Strength — with its alpha factors (render/vfx/gl.js) it takes coverage away
  erase: {
    tex: ['_MainTex'],
    src: () => `${S(['_MainTex'])}
${U4(['_MainTex_ST'])}
${U1(['_Strength'])}
void main() {
  o_col = vec4(0.0, 0.0, 0.0, clamp((1.0 - texture(u_MainTex, st(v_uv, u_MainTex_ST)).r) * u_Strength, 0.0, 1.0));
}`,
  },
  // Disturb GrabPass / GrabPassOnce: the picture under it (render/vfx/gl.js copies the target into u_GrabTexture before
  // the draw, blend One Zero), read at the fragment's own screen position pushed by a scrolled noise (_Time.x) × the
  // direction mode × _Intensity × the vertex R, optionally masked (_MaskTex plain or polar, × _MaskIntensity). Modes:
  // 3 Directional_UV −_DisturbDirUV × 0.1; 4 Center_UV ±normalize(uv − _DisturbCenterUV) × 0.1; 1 Directional / 2 Center
  // (object space): the screen step from the vertex to the vertex moved by _DisturbDir, or one unit away from
  // _DisturbCenter + _ParticleSystemPositionWS. _CUSTOMDATA_ON: TEXCOORD1.xy noise offset, .zw intensity scale;
  // TEXCOORD2.xy mask offset (.x for the polar mask), .z mask intensity scale. _ShowMask / _ShowNoise draw the mask /
  // the noise instead. The client's grab texture runs top-down (D3D), so its V offsets point down the screen here.
  grab: {
    tex: ['_DisturTex', '_MaskTex', '_GrabTexture'],
    vs: () => ({
      decl: `uniform vec4 u_DisturbDir;
uniform vec4 u_DisturbCenter;
uniform vec4 u_ParticleSystemPositionWS;
uniform float u_DirMode;
out vec4 v_scr;
out vec4 v_scr2;
`,
      post: `  v_scr = gl_Position;
  vec4 q = op;
  if (u_DirMode == 1.0) q.xyz += u_DisturbDir.xyz;
  else if (u_DirMode == 2.0) { vec3 dd = op.xyz - (u_DisturbCenter.xyz + u_ParticleSystemPositionWS.xyz); q.xyz += dd * inversesqrt(dot(dd, dd)); }
  v_scr2 = u_vp * (o2w * q);`,
    }),
    fsIn: () => 'in vec4 v_scr;\nin vec4 v_scr2;\n',
    src: (d) => `${S(['_DisturTex', '_MaskTex', '_GrabTexture'])}
${U4(['_DisturTex_ST', '_MaskTex_ST', '_NoiseSpeed', '_MaskSpeed', '_DisturbDirUV', '_DisturbCenterUV'])}
${U1(['_Intensity', '_DirMode', '_Mask', '_MaskIntensity', '_PolarCoord', '_PolarRadius', '_DisturbInvert', '_ShowMask', '_ShowNoise'])}
void main() {
  vec2 nOff = vec2(0.0), iScale = vec2(1.0), mOff = vec2(0.0); float mI = 1.0;
  ${d.cvs ? 'nOff = v_t1.xy; iScale = v_t1.zw; mOff = v_t2.xy; mI = v_t2.z;' : ''}
  float r = 2.0 * length(v_uv - 0.5) * u_PolarRadius - u_MaskSpeed.x * u_Time.y;
  float m1 = texture(u_MaskTex, vec2(r) + u_MaskTex_ST.zw + mOff.x).r;
  float m2 = texture(u_MaskTex, v_uv * u_MaskTex_ST.xy - u_MaskSpeed.xy * u_Time.y + u_MaskTex_ST.zw + mOff).r;
  vec4 nz = texture(u_DisturTex, st(v_uv, u_DisturTex_ST) + fract(u_NoiseSpeed.xy * u_Time.x) + nOff);
  float mk = clamp(mI * u_MaskIntensity, 0.0, 1.0) * ((u_PolarCoord > 0.0 ? m1 : m2) - 1.0) + 1.0;
  float mask = u_Mask > 0.0 ? mk : 1.0;
  vec2 s0 = v_scr.xy / v_scr.w * 0.5 + 0.5;
  vec2 dir = vec2(1.0);
  if (u_DirMode == 1.0 || u_DirMode == 2.0) { vec2 s2 = v_scr2.xy / v_scr2.w * 0.5 + 0.5; dir = vec2(s2.x - s0.x, s0.y - s2.y); }
  else if (u_DirMode == 3.0) dir = -(u_DisturbDirUV.xy * 0.1);
  else if (u_DirMode == 4.0) { vec2 c = v_uv - u_DisturbCenterUV.xy; dir = (u_DisturbInvert * 2.0 - 1.0) * inversesqrt(dot(c, c)) * c * 0.1; }
  vec2 off = mask * nz.r * dir * u_Intensity * v_col.r * iScale;
  if (u_Mask > 0.0 && u_ShowMask > 0.0) { o_col = vec4(vec3(mk), 1.0); return; }
  if (u_ShowNoise > 0.0) { o_col = mask * nz; return; }
  o_col = texture(u_GrabTexture, s0 + vec2(off.x, -off.y));
}`,
  },
  // 3D/MatCapTransparent: the main texture × _Color blended to the matcap (sampled at the view-space normal's xy) by
  // smoothstep(_CtrlParams.x, .y) of the fresnel (1 − n·z)^_FresnelPow, then toward white by the highlight matcap's R
  // smoothstep(_CtrlParams.z, .w) × _HighLightStrength × the dissolve; the dissolve also cuts the alpha. The normal is
  // the object normal through the inverse transpose of ObjectToWorld and then the view (the object-space template)
  matcap: {
    tex: ['_MainTex', '_DissolveTex', '_MatCap', '_MatCapHighLight'],
    vs: () => ({}),
    src: () => `${S(['_MainTex', '_DissolveTex', '_MatCap', '_MatCapHighLight'])}
${U4(['_MainTex_ST', '_DissolveTex_ST', '_Color', '_CtrlParams'])}
${U1(['_Amount', '_BorderWidth', '_HighLightStrength', '_FresnelPow'])}
uniform mat4 u_V;
void main() {
  vec3 nv = mat3(u_V) * v_nrm;
  nv *= inversesqrt(dot(nv, nv));
  float fr = exp2(log2(1.0 - clamp(nv.z, 0.0, 1.0)) * u_FresnelPow);
  float s = clamp((fr - u_CtrlParams.x) * (1.0 / (u_CtrlParams.y - u_CtrlParams.x)), 0.0, 1.0);
  vec2 muv = nv.xy * 0.5 + 0.5;
  vec4 base = texture(u_MainTex, st(v_uv, u_MainTex_ST)) * u_Color;
  vec4 c = s * s * (3.0 - 2.0 * s) * (texture(u_MatCap, muv) - base) + base;
  float hs = clamp((1.0 / (u_CtrlParams.w - u_CtrlParams.z)) * (texture(u_MatCapHighLight, muv).r - u_CtrlParams.z), 0.0, 1.0);
  float k = dissolveMask(texture(u_DissolveTex, st(v_uv, u_DissolveTex_ST)).r, u_Amount, u_BorderWidth);
  float h = k * hs * hs * (3.0 - 2.0 * hs) * u_HighLightStrength;
  o_col = vec4(h * (1.0 - c.rgb) + c.rgb, k * (h * (1.0 - c.a) + c.a));
}`,
  },
  // Unlit-Outline, two passes on the same mesh. Pass 0 (Cull Back): 2 × texture × vertex colour × _TintColor, alpha ×
  // _Alpha. Pass 1, the shell (defs.shell, Cull Front): _Outline_Color.rgb with the vertex alpha × _Alpha, its vertices
  // pushed in clip space along the projected view-space normal (MatrixV × ObjectToWorld × normal, then the projection,
  // normalised over xyz) by _Outline_Width × 0.0003 (× w × saturate(1 / w); y × the target's aspect, _ScreenParams.x / .y),
  // and back in depth by _Outline_Depth_Offset × 0.0001 of the client's reversed-Z [INFERRED for GL: + twice that]
  outline: {
    tex: ['_MainTex'],
    vs: (d) => (!d.shell ? null : {
      decl: `uniform float u_Outline_Width;
uniform float u_Outline_Depth_Offset;
`,
      post: `  vec3 pn = mat3(u_P) * (mat3(u_V) * (mat3(o2w) * on));
  vec2 dn = pn.xy * inversesqrt(dot(pn, pn)) * gl_Position.w;
  float ow = clamp(1.0 / gl_Position.w, 0.0, 1.0) * u_Outline_Width;
  gl_Position.xy += vec2(ow * dn.x, ow * (u_Screen.x / u_Screen.y) * dn.y) * 0.0003;
  gl_Position.z += 2.0 * u_Outline_Depth_Offset * 0.0001;`,
    }),
    src: (d) => (d.shell ? `${U4(['_Outline_Color'])}
${U1(['_Alpha'])}
void main() { o_col = vec4(u_Outline_Color.rgb, v_col.a * u_Alpha); }`
      : `${S(['_MainTex'])}
${U4(['_MainTex_ST', '_TintColor'])}
${U1(['_Alpha'])}
void main() {
  vec4 t = texture(u_MainTex, st(v_uv, u_MainTex_ST));
  vec4 c = 2.0 * v_col * u_TintColor;
  o_col = vec4(t.rgb * c.rgb, clamp(t.a * c.a, 0.0, 1.0) * u_Alpha);
}`),
  },
  // 3D/Toon (Blend One Zero, ZWrite On, Cull Back): emission × _EmissionColor + _Ambient × texture × _Color + the
  // diffuse N·L × texture × _Color × light colour × _SunDir.w × _Diffuse + saturate(Blinn-Phong (N·H)^_Shininess ×
  // _SpecColor × light colour × _Specular) — H from the light and the direction to _WorldSpaceCameraPos; alpha texture
  // × _Color. Light (_SunMode keyword): Custom — _SunDir.xyz is a view-space direction (to world through the inverse
  // view) with _LightColor; Default — the scene's main light _WorldSpaceLightPos0 / _LightColor0 [ASSUMED: no light in
  // the 动态立绘 scene, so (0, 0, −1, 0) / black unless the material carries them]
  toon: {
    tex: ['_MainTex', '_EmissionMap'],
    vs: (d) => ({
      decl: `uniform vec4 u_SunDir;
uniform vec4 u_LightColor;
uniform vec4 u_WorldSpaceLightPos0;
uniform vec4 u_LightColor0;
out vec3 v_light;
out vec3 v_lcol;
`,
      post: d.sunCustom ? `  v_light = mat3(inverse(u_V)) * (u_SunDir.xyz * inversesqrt(dot(u_SunDir.xyz, u_SunDir.xyz)));
  v_lcol = u_LightColor.rgb;` : `  v_light = u_WorldSpaceLightPos0.xyz;
  v_lcol = u_LightColor0.rgb;`,
    }),
    fsIn: () => 'in vec3 v_light;\nin vec3 v_lcol;\n',
    src: () => `${S(['_MainTex', '_EmissionMap'])}
${U4(['_MainTex_ST', '_SunDir', '_Color', '_EmissionColor', '_SpecColor'])}
${U1(['_Ambient', '_Diffuse', '_Shininess', '_Specular'])}
void main() {
  vec3 n = v_nrm * inversesqrt(dot(v_nrm, v_nrm));
  vec3 l = v_light * inversesqrt(dot(v_light, v_light));
  vec3 e = v_wpos - u_WorldSpaceCameraPos;
  vec3 h = l - e * inversesqrt(dot(e, e));
  float sp = clamp(dot(h * inversesqrt(dot(h, h)), n), 0.0, 1.0);
  float df = clamp(dot(n, l), 0.0, 1.0);
  vec2 uv = st(v_uv, u_MainTex_ST);
  vec4 t = texture(u_MainTex, uv);
  vec3 c = df * t.rgb * u_Color.rgb * v_lcol * u_SunDir.w * u_Diffuse
    + clamp(exp2(log2(sp) * u_Shininess) * u_SpecColor.rgb * v_lcol * u_Specular, 0.0, 1.0);
  o_col = vec4(texture(u_EmissionMap, uv).rgb * u_EmissionColor.rgb + u_Ambient * t.rgb * u_Color.rgb + c, t.a * u_Color.a);
}`,
  },
  // RGBsplit (Torappu/Particles/RGBsplit): R, G and B read from the main texture at UVs pushed (clamped to 0–1) along
  // _OffsetR/G/B.xy × .z × 0.1 × a flicker — _SplitIntensity × pow(product of four sines of _Time.y × 15/16/19/27 ×
  // _SplitFrequency, _SplitRandom) + _SplitBase — optionally scaled by _MaskTex.r (read at the R offset); each channel ×
  // its own alpha × 2 × vertex colour × _TintColor; alpha from the three alphas weighted by _OffsetR/G/B.w.
  // _UseCustomData: TEXCOORD1.xyz scale the three offsets, .w _SplitBase, TEXCOORD2.x _SplitRandom (+1e-6)
  rgbsplit: {
    tex: ['_MainTex', '_MaskTex'],
    src: () => `${S(['_MainTex', '_MaskTex'])}
${U4(['_MainTex_ST', '_TintColor', '_OffsetR', '_OffsetG', '_OffsetB'])}
${U1(['_UseMask', '_SplitFrequency', '_SplitIntensity', '_SplitBase', '_SplitRandom', '_UseCustomData'])}
void main() {
  bool cd = 0.0 < u_UseCustomData;
  vec4 c1 = cd ? v_t1 : vec4(1.0);
  float t = u_Time.y, f = u_SplitFrequency;
  float k = (sin(t * 19.0 * f) * 0.5 + 1.0) * ((sin(t * 15.0 * f) + 1.0) * 0.5) * (sin(t * 16.0 * f) * 0.5 + 1.0);
  float e = log2((sin(t * 27.0 * f) * 0.5 + 1.0) * k) * (cd ? u_SplitRandom * v_t2.x + 1e-6 : u_SplitRandom);
  float amp = exp2(e) * u_SplitIntensity + (cd ? c1.w * u_SplitBase : u_SplitBase);
  vec2 uv = st(v_uv, u_MainTex_ST);
  vec2 oR = amp * (c1.x * u_OffsetR.z) * u_OffsetR.xy * 0.1;
  vec2 oG = amp * (c1.y * u_OffsetG.z) * u_OffsetG.xy * 0.1;
  vec2 oB = amp * (c1.z * u_OffsetB.z) * u_OffsetB.xy * 0.1;
  float mk = 0.0 < u_UseMask ? texture(u_MaskTex, clamp(oR + uv, 0.0, 1.0)).r : 1.0;
  vec4 sR = texture(u_MainTex, clamp(oR * mk + uv, 0.0, 1.0));
  vec4 sG = texture(u_MainTex, clamp(oG * mk + uv, 0.0, 1.0));
  vec4 sB = texture(u_MainTex, clamp(oB * mk + uv, 0.0, 1.0));
  vec4 c = v_col * u_TintColor;
  o_col = vec4(2.0 * c.r * sR.a * sR.r, 2.0 * c.g * sG.a * sG.g, 2.0 * c.b * sB.a * sB.b,
    clamp(2.0 * c.a * clamp(sB.a * u_OffsetB.w + sR.a * u_OffsetR.w + sG.a * u_OffsetG.w, 0.0, 1.0), 0.0, 1.0));
}`,
  },
  multiply: {
    tex: ['_MainTex'],
    src: () => `${S(['_MainTex'])}
${U4(['_MainTex_ST'])}
void main() {
  vec4 t = texture(u_MainTex, st(v_uv, u_MainTex_ST));
  vec4 cl = clamp(v_col, 0.0, 1.0);
  vec3 m = mix(vec3(1.0), t.rgb * cl.rgb, t.a * cl.a);
  o_col = vec4(m, 1.0 - dot(m, vec3(0.299, 0.587, 0.114)));
}`,
  },
};

/** The fragment shader of a family. */
export function fragmentSource(family, defs = {}) {
  const f = FAMILIES[family] || FAMILIES.basic;
  return `${HEAD}${VARY_IN}${f.fsIn ? f.fsIn(defs) : ''}${COMMON}${f.src(defs)}`;
}

/** A family's own vertex stage (see extVertexSource), or null for the plain geometry shaders. */
export function vertexExt(family, defs = {}) {
  const f = FAMILIES[family];
  return f && f.vs ? f.vs(defs) : null;
}
