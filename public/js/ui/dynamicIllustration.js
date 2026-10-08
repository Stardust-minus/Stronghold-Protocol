// Original layered Spine illustration, loaded only when explicitly opened. Not a looping video substitute.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button } from './components.js';
import { Img } from './gameComponents.js';
import { ensurePixi } from '../render/app/pixi.js';
import { assets } from '../assets.js';
import { t } from '../../../shared/i18n.js';
import { releaseGl } from '../render/app/host.js';

export function DynamicIllustration({ entry, staticSrc }) {
  const host = useRef(null), appRef = useRef(null);
  const reduced = !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [playing, setPlaying] = useState(!reduced);
  const playingRef = useRef(playing); playingRef.current = playing;
  const [state, setState] = useState('loading');
  const [clip, setClip] = useState(entry?.anims?.idle || 'Idle');
  const actorRef = useRef(null);
  const clips = Object.keys(entry?.animations || {});
  useEffect(() => {
    let disposed = false, acquired = false, app = null, actor = null, resize = null, watcher = null;
    const stop = () => { if (app) app.stop(); };
    const visibility = () => { if (globalThis.document?.hidden) stop(); else if (playingRef.current) app?.start(); };
    const initialise = async () => {
      try {
        if (!host.current || !entry) throw new Error('No dynamic artwork');
        const P = await ensurePixi();
        if (disposed) return;
        app = new P.Application({ width: 1, height: 1, backgroundAlpha: 0, antialias: true, autoStart: false, resolution: Math.min(globalThis.devicePixelRatio || 1, 1.5), autoDensity: true });
        appRef.current = app;
        host.current.appendChild(app.view);
        acquired = true;
        const data = await assets.spine.acquire(entry);
        if (disposed) return;
        actor = new P.spine.Spine(data); actor.autoUpdate = false; actorRef.current = actor;
        const b = entry.bounds;
        if (!b || !(b.width > 0 && b.height > 0)) throw new Error('Dynamic illustration bounds missing');
        const layer = async (url, foreground) => {
          if (!url) return;
          const image = await assets.image(url);
          if (disposed) return;
          if (!image) throw new Error('Dynamic illustration layer unavailable');
          const sprite = new P.Sprite(P.Texture.from(image));
          sprite.width = b.width; sprite.height = b.height; sprite.x = b.x; sprite.y = -b.y - b.height;
          if (foreground) container.addChild(sprite); else container.addChildAt(sprite, 0);
        };
        const container = new P.Container(); container.addChild(actor); app.stage.addChild(container);
        await layer(entry.background, false); await layer(entry.foreground, true);
        if (disposed) return;
        actor.state.setAnimation(0, entry.anims?.idle || clips[0], true);
        actor.update(0);
        resize = () => {
          if (disposed || !host.current) return;
          const width = Math.max(1, host.current.clientWidth), height = Math.max(1, host.current.clientHeight);
          app.renderer.resize(width, height);
          const scale = Math.min(width / b.width, height / b.height) * .94;
          container.scale.set(scale);
          container.position.set(width / 2 - (b.x + b.width / 2) * scale, height / 2 + (b.y + b.height / 2) * scale);
          app.render();
        };
        resize();
        watcher = new ResizeObserver(resize); watcher.observe(host.current);
        app.ticker.maxFPS = globalThis.matchMedia?.('(pointer: coarse)').matches ? 24 : 30;
        app.ticker.add(() => actor.update(Math.min(.05, app.ticker.deltaMS / 1000)));
        globalThis.document?.addEventListener('visibilitychange', visibility);
        if (playingRef.current && !globalThis.document?.hidden) app.start(); else app.render();
        setState('ready');
      } catch {
        stop();
        if (!disposed) setState('fallback');
      }
    };
    void initialise();
    return () => {
      disposed = true; watcher?.disconnect(); globalThis.document?.removeEventListener('visibilitychange', visibility);
      appRef.current = null; actorRef.current = null;
      try { if (app?.renderer) releaseGl(app.renderer); app?.destroy(true, { children: true, texture: false, baseTexture: false }); } catch { /* a lost context is already gone */ }
      if (acquired) assets.spine.release(entry);
    };
  }, [entry]);
  useEffect(() => {
    const app = appRef.current;
    if (!app) return;
    if (state === 'ready' && playing && !globalThis.document?.hidden) app.start(); else app.stop();
  }, [playing, state]);
  useEffect(() => {
    const actor = actorRef.current;
    if (!actor || !clips.includes(clip)) return;
    actor.state.setAnimation(0, clip, true); actor.update(0); appRef.current?.render();
  }, [clip, state]);
  return html`<div class="lo-dynamic" data-testid="dynamic-illustration" data-state=${state}>
    <div class="lo-dynamic__stage">
      ${state !== 'ready' ? html`<${Img} src=${staticSrc} class="lo-dynamic__fallback" />` : null}
      <div class="lo-dynamic__canvas" ref=${host} hidden=${state === 'fallback'}></div>
    </div>
    <div class="lo-dynamic__controls">
      <span role="status">${state === 'loading' ? t('正在载入动态立绘…') : state === 'fallback' ? t('动态立绘暂不可用，已显示静态立绘') : playing ? t('动态立绘播放中') : t('动态立绘已暂停')}</span>
      ${state === 'ready' ? html`<${Button} variant="secondary" size="sm" data-testid="dynamic-pause" onClick=${() => setPlaying(!playing)}>${playing ? t('暂停') : t('播放')}<//>` : null}
      ${state === 'ready' && clips.length > 1 ? html`<label>${t('动作')} <select id="operator-illustration-animation" value=${clip} onChange=${e => setClip(e.currentTarget.value)}>
        ${clips.map(name => html`<option key=${name} value=${name}>${name}</option>`)}
      </select></label>` : null}
    </div>
  </div>`;
}
