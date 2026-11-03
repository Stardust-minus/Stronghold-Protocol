// public/js/ui/avatarLive.js — a player's avatar, live (rel27, the owner's decisions of 2026-11-03): over the static picture
// of an avatar slot (components.js AvatarFrame `live`, the 成就 plate, the 头像 picker, the match's PlayerAvatar).
//   - an operator avatar in a skin with a 动态立绘: that illustration in the skin's official avatar crop (LiveArt);
//   - an official dynamic avatar (display_meta_table, avatarType DYNAMIC: avatar_dyn_01…08, rel27 local-extract job
//     ui/avatar_dyn, data/local-assets.json group `ui/avatar_dyn/<id>`): its descriptor `avatar.json` (format
//     'avatar-dyn': a 180 × 180 box, rect clip, layers in draw order) —
//       spine     the skeleton (Spine 3.8 JSON, ui/dynamicStage.js acquireSpine) on the shared renderer, the whole box in
//                 the slot (the official static 150 × 150 picture is that box, so both frame alike);
//       sequence  a lossless animated WebP over the box (the browser plays it);
//       fx        UIParticle layers (彩纸 / 光点 / glass / shards) — TODO (next release, the owner's decision): not drawn;
//                 they need the battle fx runtime (render/vfx) in the avatar's UI space (NOTES-dyn.md has the plan);
//                 the avatar plays without them.
// Always animated (prefers-reduced-motion is not honoured, the owner's decision); any failure leaves the static picture.
// In the match screens too (ui/gameComponents.js PlayerAvatar).
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html } from './components.js';
import { localAsset, useData } from '../data.js';
import { LiveArt, CoverIllustration } from './dynamicIllustration.js';
import { isOfficialAvatar } from '../../../shared/protocol.js';

const descriptors = new Map();
/** The descriptor URL of an official dynamic avatar, or null. @param {string} id */
export function avatarDescriptorUrl(id) {
  return typeof id === 'string' && /^avatar_dyn_\d+$/.test(id) ? localAsset(`ui/avatar_dyn/${id}`, 'avatar.json') : null;
}
/** A descriptor as shipped, or null when it is not one (format 'avatar-dyn' v1, a box, layers). @param {any} d */
export function validDescriptor(d) {
  return d && d.format === 'avatar-dyn' && d.version === 1 && Array.isArray(d.box) && d.box.length === 2 && d.box.every((n) => n > 0)
    && Array.isArray(d.layers) ? d : null;
}
function loadDescriptor(url) {
  if (!descriptors.has(url)) {
    descriptors.set(url, fetch(url).then((r) => (r.ok ? r.json() : null)).then(validDescriptor).catch(() => null));
  }
  return descriptors.get(url);
}
/**
 * The entry and framing of a descriptor's spine layer for the shared renderer: the skeleton, the box (descriptor `box`,
 * UI px; the layer's `offset`: the skeleton origin from the box centre, y up; `unitPx` UI px per skeleton unit) as both
 * its bounds and its crop. @param {any} desc @param {any} layer
 */
export function spineLayerEntry(desc, layer) {
  const u = layer.unitPx > 0 ? layer.unitPx : 1;
  const [ox, oy] = Array.isArray(layer.offset) ? layer.offset : [0, 0];
  const w = desc.box[0] / u, h = desc.box[1] / u;
  const rect = { x: -ox / u - w / 2, y: -oy / u - h / 2, width: w, height: h };
  const clip = typeof layer.animation === 'string' ? layer.animation : 'loop';
  return {
    entry: { skel: layer.skeleton, atlas: layer.atlas, textures: layer.pages || [], pma: layer.pma === true, anims: { idle: clip },
      animations: { [clip]: layer.duration || 0 }, bounds: rect },
    framing: { rect, posX: 50, posY: 50 },
  };
}

/** One sequence layer: the animated WebP stretched over the box; the parent's static picture hides once it shows. */
function SequenceLayer({ src }) {
  const ref = useRef(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return undefined;
    if (shown) parent.dataset.dyn = 'live'; else delete parent.dataset.dyn;
    return () => { delete parent.dataset.dyn; };
  }, [shown]);
  return html`<img class="dyn-seq" ref=${ref} src=${src} alt="" draggable=${false} data-testid="dynamic-sequence"
    data-state=${shown ? 'ready' : 'loading'} onLoad=${() => setShown(true)} onError=${() => setShown(false)} />`;
}

/** An official dynamic avatar over its slot's static picture (nothing for any other id or while the data is missing). */
export function OfficialAvatarLive({ id }) {
  useData('local');
  const url = avatarDescriptorUrl(id);
  const [desc, setDesc] = useState(null);
  useEffect(() => {
    let live = true; setDesc(null);
    if (url) loadDescriptor(url).then((d) => { if (live) setDesc(d); });
    return () => { live = false; };
  }, [url]);
  const memo = useRef({ desc: null, spine: null });
  if (!desc) return null;
  const seq = desc.layers.find((l) => l?.kind === 'sequence' && typeof l.src === 'string');
  if (seq) return html`<${SequenceLayer} src=${seq.src} />`;
  const spine = desc.layers.find((l) => l?.kind === 'spine' && typeof l.skeleton === 'string' && typeof l.atlas === 'string');
  if (!spine) return null;
  if (memo.current.desc !== desc) memo.current = { desc, spine: spineLayerEntry(desc, spine) };
  const { entry, framing } = memo.current.spine;
  return html`<${CoverIllustration} entry=${entry} framing=${framing} />`;
}

/**
 * A card's avatar live (room.card avatar / avatarLook): an official dynamic avatar, or an operator avatar in a skin with
 * a 动态立绘 (its avatar crop); nothing otherwise.
 * @param {{ m: any, avatar: string, look?: string }} props
 */
export function CardAvatarLive({ m, avatar, look = '' }) {
  if (!avatar) return null;
  if (isOfficialAvatar(avatar)) return html`<${OfficialAvatarLive} id=${avatar} />`;
  return html`<${LiveArt} m=${m} charId=${avatar} look=${look || ''} kind="avatar" />`;
}
