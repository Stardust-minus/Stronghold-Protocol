// public/js/ui/seatLive.js — the room seat card's 名片干员 picture and its framing. rel27 (the owner's decision of
// 2026-11-03): the look's 动态立绘, when it is a skin with one, plays live over the seat's static portrait
// (ui/dynamicIllustration.js cover mode, the shared renderer), framed as its player set it. rel30 (the owner, 2026-11-04:
// 「同盟房间名片只有动态立绘可以缩放移动，可以给静态的也加上吗」): every look can be framed — 精二, 精一 and a skin without a
// 动态立绘 frame their static portrait the same way.
// The framing is the player's own — room.card artX / artY / artZoom (ui/playerCard.js setCardArt, synced to the room,
// server/lobby.js setCard), the same for everyone in the room. Without one, everything is as before: the static picture
// `cover` at 50% 12% (css/screens/lobby.css .rseat__art img), the live one in the official portrait crop at that same
// position. With one (ui/dynamicFraming.js):
//   - a skin with a 动态立绘: the framing is in its skeleton bounds; the static portrait under it — the official crop's rect in
//     those bounds — is placed by the same transform (pictureBox), so a 动态立绘 still loading or failing shows exactly the
//     part of the picture the live one shows (around the crop, the box's background);
//   - any other look: the framing is in the static picture itself (pictureBounds, its natural size), the box always filled.
// HD (rel30, the owner's 「来点高清立绘」; ui/assetUrls.js portraitSourceOf, hd30's contract), the picture drawn over the
// 180×360 once it has loaded (the 180×360 until then, and alone if it fails — placed where the HD one goes, so a framing
// keeps its meaning):
//   - a look with its `illustration` and `portraitBox`: the whole 立绘, placed so that, with no framing, the portrait box
//     lands exactly where the 180×360 lands (cover at 50% 12%); its framing is in the 立绘 (the box as the default view;
//     pan across all of it, the box included where it runs past the 立绘's edge; zoom out to the 立绘's whole height, in to
//     ART_LIMITS). A scene look (`portraitScene*`) too, its scene drawn (rel31, the owner of 11-04: 「一直用整张原画」;
//     rel30 drew a scene look's cut-out in the 180×360's space, which could neither zoom out nor get sharper);
//   - a look with only `portraitHD`: the HD portrait in the 180×360's own space — the same framing values as without HD;
//   - a skin with a 动态立绘 keeps its skeleton framing; under the live one goes its 立绘 by the box ↔ official-crop match.
// A look without the HD fields frames as above (its 180×360 as the space).
// A frame saved before rel31 (ui/playerCard.js: no space mark) on a static scene look was in the cut-out's space; one's own
// seat drops it once (the default, sent to the room like 重置) instead of showing another part of the 立绘.
// On one's own seat (a 名片干员 picked) 「调整立绘」 opens the framer: drag to move, wheel / pinch / − + to zoom (shown
// relative to the default: 100 % = the default; the box always filled, so a look framed in its 180×360 cannot go below
// its default, one framed in its 立绘 can, down to the 立绘's whole height), 重置 back to the default, 完成 to close; a change
// is sent when a drag ends or a zoom settles (room.card is rate-limited), not on every move.
import { useRef, useState, useEffect } from '../../vendor/hooks.module.js';
import { html, Icon } from './components.js';
import { DynamicIllustration } from './dynamicIllustration.js';
import { lookDynamic, cropFraming, rectLayout, artOfRect, moveArt, seatRect, pictureBounds, pictureBox, ART_LIMITS, STATIC_ZOOM_MAX } from './dynamicFraming.js';
import { t } from '../../../shared/i18n.js';

const SETTLE_MS = 450;

/** The skeleton rect a layout shows in a bw × bh box (y-up). */
export function visibleRect(bw, bh, l) {
  return { x: -l.x / l.scale, y: (l.y - bh) / l.scale, width: bw / l.scale, height: bh / l.scale };
}

/** The rect of a portraitBox ([x, y, w, h] fractions from the top-left) inside y-up `bounds`. */
export function boxRect(bounds, box) {
  return { x: bounds.x + box[0] * bounds.width, y: bounds.y + bounds.height * (1 - box[1] - box[3]), width: box[2] * bounds.width, height: box[3] * bounds.height };
}

/** The whole illustration's rect in the space of `crop`, the rect its portraitBox `box` is (the inverse of boxRect). */
export function illustrationAround(crop, box) {
  const width = crop.width / box[2], height = crop.height / box[3];
  return { x: crop.x - box[0] * width, y: crop.y + crop.height + box[1] * height - height, width, height };
}

/** The smallest rect holding a and b. */
const union = (a, b) => { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }; };
/** The 180×360's own space (a static look without the 立绘, a scene look's cut-out). */
const PORTRAIT = pictureBounds(180, 360);

/**
 * What a seat's picture is framed in: `bounds` (the framing space), `pic` (the 180×360's rect in it, null = it keeps its
 * CSS cover), `hdSrc` / `hd` (the HD picture drawn over it and its rect, null = none), `crop` (the default view's rect,
 * `cover` at 50% 12%), `place` (the pictures are placed even with no framing), `zoomMax`; null while a plain 180×360's
 * size is unknown.
 * @param {any} dyn lookDynamic() @param {[number, number]|null} nat the 180×360's natural size
 * @param {{ src?: string|null, hd?: string|null, illustration?: string|null, box?: number[]|null, size?: number[]|null,
 *   scene?: boolean }|null} [pic] the look's portrait source (ui/assetUrls.js portraitSourceOf)
 * @param {[number, number]|null} [illNat] the 立绘's natural size once loaded
 */
export function seatSpace(dyn, nat, pic = null, illNat = null) {
  const whole = !!(pic?.illustration && pic.box);
  const cut = !whole && !!pic?.hd;
  if (dyn) {
    const crop = cropFraming(dyn, 'portrait', 50, 12)?.rect ?? null;
    if (!crop) return { bounds: dyn.bounds, pic: null, hdSrc: null, hd: null, crop: dyn.bounds, place: false, zoomMax: ART_LIMITS.zoomMax };
    const hd = whole ? illustrationAround(crop, pic.box) : cut ? crop : null;
    return { bounds: dyn.bounds, pic: crop, hdSrc: whole ? pic.illustration : cut ? pic.hd : null, hd, crop, place: !!hd, zoomMax: ART_LIMITS.zoomMax };
  }
  if (whole) {
    // [W, H]: the manifest's (illustrationSize), else its natural size once loaded, else the contract's shape (1:2 box)
    const size = pic.size || (illNat && illNat[0] > 0 && illNat[1] > 0 ? illNat : [1000 * pic.box[3] / (2 * pic.box[2]), 1000]);
    const ill = pictureBounds(size[0], size[1]), crop = boxRect(ill, pic.box);
    return { bounds: union(ill, crop), pic: crop, hdSrc: pic.illustration, hd: ill, crop, place: true, zoomMax: ART_LIMITS.zoomMax };
  }
  if (cut) return { bounds: PORTRAIT, pic: PORTRAIT, hdSrc: pic.hd, hd: PORTRAIT, crop: PORTRAIT, place: false, zoomMax: STATIC_ZOOM_MAX };
  if (!nat || !(nat[0] > 0) || !(nat[1] > 0)) return null;
  const b = pictureBounds(nat[0], nat[1]);
  return { bounds: b, pic: b, hdSrc: null, hd: null, crop: b, place: false, zoomMax: STATIC_ZOOM_MAX };
}

/**
 * Whether a look's framing space moved in rel31: a static scene look with its 立绘 (rel30 framed its cut-out / 180×360).
 * A frame saved before then means another region now. @param {any} dyn lookDynamic() @param {any} pic portraitSourceOf
 */
export function sceneSpaceMoved(dyn, pic) {
  return !dyn && !!pic?.scene && !!(pic.illustration && pic.box);
}

/** The default view (no framing) of a space as an art triple: its crop `cover` at 50% 12%. */
export function defaultArt(bw, bh, space) {
  return artOfRect(bw, bh, space.bounds, visibleRect(bw, bh, rectLayout(bw, bh, space.crop, 50, 12)));
}

/** The transform a box shows a space with: the framing, else (a placed space) its default view, else null (CSS). */
const seatLayout = (bw, bh, space, art) => (!space || !(bw > 0) || !(bh > 0) ? null
  : art ? rectLayout(bw, bh, seatRect(bw, bh, space.bounds, art)) : space.place ? rectLayout(bw, bh, space.crop, 50, 12) : null);

/** The 180×360's inline box under a framing (CSS px of a bw × bh box), or null (its CSS default). */
export function staticBox(bw, bh, space, art) {
  const l = space?.pic ? seatLayout(bw, bh, space, art) : null;
  return l ? pictureBox(l, space.pic) : null;
}

/** The HD picture's inline box (CSS px), or null (none, or its CSS default: a cut-out with no framing). */
export function illustrationBox(bw, bh, space, art) {
  const l = space?.hd ? seatLayout(bw, bh, space, art) : null;
  return l ? pictureBox(l, space.hd) : null;
}

const px = (v) => `${Math.round(v * 100) / 100}px`;
// max-width / max-height: none — the theme caps every <img> at its box (css/theme.css img { max-width: 100% }), which squashed a framed
// picture wider than the seat
const boxStyle = (b, hidden) => (b ? `left:${px(b.left)};top:${px(b.top)};width:${px(b.width)};height:${px(b.height)};right:auto;bottom:auto;max-width:none;max-height:none;object-fit:fill${hidden ? ';visibility:hidden' : ''}`
  : hidden ? 'visibility:hidden' : undefined);

/**
 * The seat card's picture: the static portrait, the live layer when the look has a 动态立绘, the framer on one's own seat.
 * Rendered inside `.rseat__art` (the <img> and the live layer stay its direct children: [data-dyn="live"] > img).
 * @param {{ m: any, src: string, source?: any, charId: string, look: string,
 *   art: { x: number, y: number, zoom: number }|null, legacyArt?: boolean, editable?: boolean,
 *   onCommit?: (art: { x: number, y: number, zoom: number }|null) => void, onError?: () => void }} props
 *   `legacyArt`: one's own frame was saved before rel31 (ui/playerCard.js artSpace).
 */
export function SeatArt({ m, src, source = null, charId, look, art: savedArt, legacyArt = false, editable = false, onCommit, onError }) {
  const dyn = lookDynamic(m, charId, look);
  // a pre-rel31 frame of a static scene look (sceneSpaceMoved): shown as the default, and on one's own seat dropped once
  const stale = legacyArt && !!savedArt && sceneSpaceMoved(dyn, source);
  const art = stale ? null : savedArt;
  useEffect(() => { if (stale && editable) onCommit?.(null); }, [stale, editable]);
  const [nat, setNat] = useState(null);
  const [hdNat, setHdNat] = useState(null), [hdReady, setHdReady] = useState(false), [hdFailed, setHdFailed] = useState(false);
  const [box, setBox] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const img = useRef(null), pad = useRef(null), drag = useRef(null), settle = useRef(null), pointers = useRef(new Map());
  useEffect(() => () => clearTimeout(settle.current), []);
  // the static picture's natural size (its own framing space), again for another picture
  useEffect(() => {
    const el = img.current;
    setNat(el?.complete && el.naturalWidth ? [el.naturalWidth, el.naturalHeight] : null);
  }, [src]);
  // the box the picture fills (its aspect sets what a framing shows)
  useEffect(() => {
    const el = img.current?.parentElement;
    if (!el) return undefined;
    const measure = () => setBox((b) => (b && b[0] === el.clientWidth && b[1] === el.clientHeight ? b : [el.clientWidth, el.clientHeight]));
    measure();
    const ro = globalThis.ResizeObserver ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  // the HD picture (rel30) sets the framing space whenever the manifest has it, drawn or not (a failed load keeps the
  // framing's meaning: the 180×360 goes where the HD one would)
  const space = seatSpace(dyn, nat, source, hdNat);
  const drawHd = !!space?.hdSrc && !hdFailed;
  const shown = draft || art;
  const sb = space && box ? staticBox(box[0], box[1], space, shown) : null;
  const ib = drawHd && space && box ? illustrationBox(box[0], box[1], space, shown) : null;
  const imgStyle = boxStyle(sb, drawHd && hdReady);
  // a cut-out with no framing keeps its CSS cover (the same as the 180×360's); a placed one waits for the box's size
  const hdStyle = boxStyle(ib, !hdReady || (!ib && space?.place));
  const framing = shown ? { art: shown } : dyn ? cropFraming(dyn, 'portrait', 50, 12) || { focusY: 12 } : null;
  const size = () => { const el = pad.current || img.current?.parentElement; return [Math.max(1, el?.clientWidth || 1), Math.max(1, el?.clientHeight || 1)]; };
  /** the framing the box shows now, as an art triple (the default's, the first time) */
  const current = () => {
    if (draft || art) return draft || art;
    const [bw, bh] = size();
    return defaultArt(bw, bh, space);
  };
  const commit = (next) => { clearTimeout(settle.current); settle.current = null; setDraft(null); onCommit?.(next); };
  const zoomBy = (factor) => {
    const [bw, bh] = size();
    const next = moveArt(bw, bh, space.bounds, current(), 0, 0, factor, space.zoomMax);
    setDraft(next);
    clearTimeout(settle.current); settle.current = setTimeout(() => commit(next), SETTLE_MS);
  };
  const stop = (e) => { e.stopPropagation(); };
  const down = (e) => {
    e.stopPropagation(); e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, [e.clientX, e.clientY]);
    const pts = [...pointers.current.values()];
    drag.current = { start: current(), x: e.clientX, y: e.clientY, dist: pts.length === 2 ? Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) : 0 };
  };
  const move = (e) => {
    if (!drag.current || !pointers.current.has(e.pointerId)) return;
    e.stopPropagation();
    pointers.current.set(e.pointerId, [e.clientX, e.clientY]);
    const [bw, bh] = size(), pts = [...pointers.current.values()], d = drag.current;
    if (pts.length === 2 && d.dist > 0) {
      setDraft(moveArt(bw, bh, space.bounds, d.start, 0, 0, Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) / d.dist, space.zoomMax));
    } else {
      setDraft(moveArt(bw, bh, space.bounds, d.start, e.clientX - d.x, e.clientY - d.y, 1, space.zoomMax));
    }
  };
  const up = (e) => {
    e.stopPropagation();
    pointers.current.delete(e.pointerId);
    if (pointers.current.size) { drag.current = { ...drag.current, start: draft || current(), dist: 0, x: e.clientX, y: e.clientY }; return; }
    if (drag.current && draft) commit(draft);
    drag.current = null;
  };
  const wheel = (e) => { e.preventDefault(); e.stopPropagation(); zoomBy(Math.exp(-e.deltaY * 0.0015)); };
  const canFrame = editable && !!space;
  // the zoom shown relative to the default's (100 % = the default framing); the limits are the stored ones
  const z = canFrame && editing ? Math.round(shown?.zoom ?? current().zoom) : 100;
  const base = canFrame && editing ? (() => { const [bw, bh] = size(); return defaultArt(bw, bh, space).zoom || 100; })() : 100;
  return html`
    <img src=${src} alt="" draggable=${false} loading="lazy" decoding="async" ref=${img} style=${imgStyle} data-framed=${shown && sb ? 'art' : undefined}
      onLoad=${(e) => { const el = e.currentTarget; if (el.naturalWidth) setNat([el.naturalWidth, el.naturalHeight]); }} onError=${onError} />
    ${drawHd ? html`<img class="rseat__hd" src=${space.hdSrc} alt="" draggable=${false} decoding="async" style=${hdStyle} data-testid="seat-hd"
      data-state=${hdReady ? 'ready' : 'loading'} data-framed=${shown && ib ? 'art' : undefined}
      onLoad=${(e) => { const el = e.currentTarget; if (el.naturalWidth) setHdNat([el.naturalWidth, el.naturalHeight]); setHdReady(true); }}
      onError=${() => { setHdFailed(true); setHdReady(false); }} />` : null}
    ${dyn ? html`<${DynamicIllustration} mode="cover" entry=${dyn} framing=${framing} />` : null}
    ${canFrame && !editing ? html`<button type="button" class="rseat__frame" data-testid="seat-frame" onClick=${(e) => { stop(e); setEditing(true); }}
        title=${t('拖动、缩放座位卡上的立绘')}><${Icon} name="expand" /><span>${t('调整立绘')}</span></button>` : null}
    ${canFrame && editing ? html`<div class="rseat__framer" ref=${pad} data-testid="seat-framer" onClick=${stop}
        onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up} onWheel=${wheel}>
      <div class="rseat__framer-bar" onPointerDown=${stop}>
        <button type="button" data-testid="seat-frame-out" onClick=${(e) => { stop(e); zoomBy(1 / 1.2); }} disabled=${z <= ART_LIMITS.zoomMin} aria-label=${t('缩小')}><${Icon} name="minus" /></button>
        <b class="num" data-testid="seat-frame-zoom">${Math.round(z / base * 100)}%</b>
        <button type="button" data-testid="seat-frame-in" onClick=${(e) => { stop(e); zoomBy(1.2); }} disabled=${z >= space.zoomMax} aria-label=${t('放大')}><${Icon} name="plus" /></button>
        <button type="button" data-testid="seat-frame-reset" onClick=${(e) => { stop(e); commit(null); }} title=${t('恢复默认取景')}><${Icon} name="refresh" /></button>
        <button type="button" data-testid="seat-frame-done" onClick=${(e) => { stop(e); if (settle.current && draft) commit(draft); setEditing(false); }}><${Icon} name="check" /><span>${t('完成')}</span></button>
      </div>
    </div>` : null}`;
}
