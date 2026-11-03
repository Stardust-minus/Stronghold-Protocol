// public/js/ui/seatLive.js — the room seat card's 动态立绘 (rel27, the owner's decision of 2026-11-03): the 名片干员's look,
// when it is a skin with a dynamic illustration, plays live over the seat's static portrait (ui/dynamicIllustration.js
// cover mode, the shared renderer). Its framing is the player's own — room.card artX / artY / artZoom (ui/playerCard.js
// setCardArt, synced to the room, server/lobby.js setCard), the same for everyone in the room — else the portrait crop at
// the static picture's object-position (50% 12%). On one's own seat 「调整立绘」 opens the framer: drag to move, wheel / pinch
// / − + to zoom (shown relative to the crop: 100 % = the default; the box always filled), 重置 back to the crop, 完成 to close; a change is sent when a drag ends
// or a zoom settles (room.card is rate-limited), not on every move.
import { useRef, useState, useEffect } from '../../vendor/hooks.module.js';
import { html, Icon } from './components.js';
import { DynamicIllustration } from './dynamicIllustration.js';
import { lookDynamic, cropFraming, rectLayout, artOfRect, moveArt, ART_LIMITS } from './dynamicFraming.js';
import { t } from '../../../shared/i18n.js';

const SETTLE_MS = 450;

/** The skeleton rect a layout shows in a bw × bh box (y-up). */
export function visibleRect(bw, bh, l) {
  return { x: -l.x / l.scale, y: (l.y - bh) / l.scale, width: bw / l.scale, height: bh / l.scale };
}

/**
 * @param {{ m: any, charId: string, look: string, art: { x: number, y: number, zoom: number }|null, editable?: boolean,
 *   onCommit?: (art: { x: number, y: number, zoom: number }|null) => void }} props
 */
export function SeatLive({ m, charId, look, art, editable = false, onCommit }) {
  const dyn = lookDynamic(m, charId, look);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const pad = useRef(null), drag = useRef(null), settle = useRef(null), pointers = useRef(new Map());
  useEffect(() => () => clearTimeout(settle.current), []);
  if (!dyn) return null;
  const crop = cropFraming(dyn, 'portrait', 50, 12);
  const shown = draft || art;
  const framing = shown ? { art: shown } : crop || { focusY: 12 };
  const size = () => { const el = pad.current; return [Math.max(1, el?.clientWidth || 1), Math.max(1, el?.clientHeight || 1)]; };
  /** the framing the box shows now, as an art triple (the crop's, the first time) */
  const current = () => {
    if (draft || art) return draft || art;
    const [bw, bh] = size();
    const l = crop ? rectLayout(bw, bh, crop.rect, 50, 12) : rectLayout(bw, bh, dyn.bounds, 50, 12);
    return artOfRect(bw, bh, dyn.bounds, visibleRect(bw, bh, l));
  };
  const commit = (next) => { clearTimeout(settle.current); settle.current = null; setDraft(null); onCommit?.(next); };
  const zoomBy = (factor) => {
    const [bw, bh] = size();
    const next = moveArt(bw, bh, dyn.bounds, current(), 0, 0, factor);
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
      setDraft(moveArt(bw, bh, dyn.bounds, d.start, 0, 0, Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) / d.dist));
    } else {
      setDraft(moveArt(bw, bh, dyn.bounds, d.start, e.clientX - d.x, e.clientY - d.y, 1));
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
  // the zoom shown relative to the official crop's (100 % = the default framing); the limits are the stored ones
  const z = Math.round(shown?.zoom ?? current().zoom);
  const base = (() => { if (!crop) return 100; const [bw, bh] = size(); const l = rectLayout(bw, bh, crop.rect, 50, 12);
    return artOfRect(bw, bh, dyn.bounds, visibleRect(bw, bh, l)).zoom || 100; })();
  return html`
    <${DynamicIllustration} mode="cover" entry=${dyn} framing=${framing} />
    ${editable && !editing ? html`<button type="button" class="rseat__frame" data-testid="seat-frame" onClick=${(e) => { stop(e); setEditing(true); }}
        title=${t('拖动、缩放座位卡上的动态立绘')}><${Icon} name="expand" /><span>${t('调整立绘')}</span></button>` : null}
    ${editing ? html`<div class="rseat__framer" ref=${pad} data-testid="seat-framer" onClick=${stop}
        onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up} onWheel=${wheel}>
      <div class="rseat__framer-bar" onPointerDown=${stop}>
        <button type="button" data-testid="seat-frame-out" onClick=${(e) => { stop(e); zoomBy(1 / 1.2); }} disabled=${z <= ART_LIMITS.zoomMin} aria-label=${t('缩小')}><${Icon} name="minus" /></button>
        <b class="num" data-testid="seat-frame-zoom">${Math.round(z / base * 100)}%</b>
        <button type="button" data-testid="seat-frame-in" onClick=${(e) => { stop(e); zoomBy(1.2); }} disabled=${z >= ART_LIMITS.zoomMax} aria-label=${t('放大')}><${Icon} name="plus" /></button>
        <button type="button" data-testid="seat-frame-reset" onClick=${(e) => { stop(e); commit(null); }} title=${t('恢复默认取景')}><${Icon} name="refresh" /></button>
        <button type="button" data-testid="seat-frame-done" onClick=${(e) => { stop(e); if (settle.current && draft) commit(draft); setEditing(false); }}><${Icon} name="check" /><span>${t('完成')}</span></button>
      </div>
    </div>` : null}`;
}
