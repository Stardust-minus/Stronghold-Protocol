(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const body = document.body;
  if (body.dataset.build !== 'spatial-06') { location.reload(); return; }
  const form = $('login-form'), logout = $('logout-form'), input = $('password');
  const callsign = $('callsign'), credentialName = $('credential-name');
  const message = $('login-message'), statusMessage = $('status-message');
  const toggle = $('password-toggle'), returnLink = $('return-link');
  const intro = $('intro-scene'), introSkip = $('intro-skip');
  const face = $('login-scene'), success = $('success-scene'), bridge = $('entry-bridge');
  const entrySkip = $('entry-skip'), announcer = $('entry-message');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const authed = body.dataset.authenticated === 'true';
  let phase = 'idle', phaseTime = performance.now(), scene = null;
  let introTimer = 0, handoffTimer = 0, assembleTimer = 0, pending = false, committed = false, navigation = false;
  let destination = '/', entryTimers = [], retryAt = 0;
  let autoAllowed = authed && location.pathname === '/entry', autoStarted = false;
  const animationToggle = $('intro-enabled');
  let animations = false, sceneLoading = false;
  try { animations = localStorage.getItem('ark.prts.animations') === '1'; } catch {}
  body.dataset.animations = animations ? 'on' : 'off';
  if (animationToggle) animationToggle.checked = animations;

  function gameLink(value) {
    const url = new URL(entryPath(value) || '/', location.origin);
    url.searchParams.set('_prts', '1');
    return url.pathname + url.search;
  }
  function maybeAutoEnter() {
    if (!autoAllowed || autoStarted || pending || committed || phase !== 'idle' || !window.fetch || !cleanCallsign(callsign.value)) return;
    autoStarted = true;
    void continueSession(true);
  }

  function entryPath(value) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f]/.test(value)) return null;
    try {
      const url = new URL(value, location.origin);
      const page = ['/', '/index.html'].includes(url.pathname);
      return url.origin === location.origin && page ? url.pathname + url.search : null;
    } catch { return null; }
  }
  function cleanCallsign(raw) {
    let name = String(raw || '');
    try { name = name.normalize('NFC'); } catch {}
    name = Array.from(name.replace(/\s+/g, ' ')).filter(character => {
      const code = character.codePointAt(0);
      return !(code < 32 || (code >= 0x7f && code <= 0x9f) || code === 0xad
        || (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e)
        || (code >= 0x2060 && code <= 0x206f) || code === 0xfeff
        || (code >= 0xd800 && code <= 0xdfff));
    }).join('').trim().slice(0, 12);
    const last = name.charCodeAt(name.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) name = name.slice(0, -1);
    return name.trim();
  }
  function readCallsign() {
    const name = cleanCallsign(callsign.value);
    callsign.setCustomValidity(name ? '' : '请输入博士代号，最多 12 字。');
    if (!name) { callsign.reportValidity(); callsign.focus(); tell(authed ? statusMessage : message, '请先填写博士代号。'); return null; }
    callsign.value = name;
    return name;
  }
  function applyIdentity(name) {
    if (credentialName) {
      credentialName.textContent = name;
      const units = Array.from(name).reduce((sum, c) => sum + (/^[\x20-\x7e]$/.test(c) ? .62 : 1), 0);
      credentialName.style.setProperty('--callsign-size', Math.max(16, Math.min(32, 196 / Math.max(1, units))) + 'px');
    }
    try { localStorage.setItem('ark.callsign', name); } catch {}
    let stored = false;
    try { localStorage.setItem('sp.name', name); stored = true; } catch {}
    try { if (stored) sessionStorage.setItem('sp.entered', '1'); else sessionStorage.removeItem('sp.entered'); } catch {}
  }
  try { callsign.value = cleanCallsign(localStorage.getItem('ark.callsign')); } catch {}
  callsign.addEventListener('input', () => { callsign.setCustomValidity(''); callsign.removeAttribute('aria-invalid'); });
  callsign.addEventListener('invalid', () => { finishIntro(true); callsign.setAttribute('aria-invalid', 'true'); tell(authed ? statusMessage : message, '请填写博士代号，最多 12 字。'); });

  function setPhase(value) {
    phase = value; phaseTime = performance.now(); body.dataset.phase = value;
    if (value === 'idle') queueMicrotask(maybeAutoEnter);
    try { scene?.setPhase(value); } catch { try { scene?.dispose(); } catch {} scene = null; }
  }
  function tell(node, text, type = 'error') { if (node) { node.textContent = text; node.dataset.status = type; } }
  function finishIntro(instant = true) {
    clearTimeout(introTimer); clearTimeout(handoffTimer); clearTimeout(assembleTimer);
    if (!['intro', 'handoff', 'assembling'].includes(phase)) {
      if (intro) intro.hidden = true;
      if (introSkip) introSkip.hidden = true;
      return;
    }
    if (instant || motion.matches) {
      body.dataset.introSkipped = 'true';
      if (intro) intro.hidden = true;
      if (introSkip) introSkip.hidden = true;
      setPhase('idle');
    } else {
      setPhase('handoff');
      handoffTimer = setTimeout(() => {
        if (phase !== 'handoff') return;
        if (intro) intro.hidden = true;
        if (introSkip) introSkip.hidden = true;
        setPhase('assembling');
        assembleTimer = setTimeout(() => { if (phase === 'assembling') setPhase('idle'); }, 1240);
      }, 700);
    }
  }
  function clearEntry() { entryTimers.forEach(clearTimeout); entryTimers = []; }
  function navigate() {
    if (navigation) return;
    navigation = true; clearEntry();
    try {
      const target = gameLink(destination);
      if (location.pathname === '/entry') location.replace(target);
      else location.assign(target);
    }
    catch { navigation = false; tell(announcer, '访问已获授权，请点击立即进入。', 'success'); }
  }
  function enter(next, name) {
    const safe = entryPath(next);
    if (!safe || committed) return;
    committed = true; destination = safe;
    applyIdentity(name);
    if (!animations || motion.matches) { finishIntro(true); navigate(); return; }
    // The hard deadline exists before any optional visual operation can throw.
    entryTimers.push(setTimeout(navigate, 4100));
    try {
      finishIntro(true);
      entrySkip.href = gameLink(safe); entrySkip.hidden = false;
      tell(announcer, '访问权限已确认。正在进入终端，可立即进入以跳过动画。', 'success');
      if (motion.matches || !face || !success || !bridge) { navigate(); return; }
      face.inert = true; face.setAttribute('aria-hidden', 'true');
      success.hidden = false;
      form?.removeAttribute('aria-busy');
      setPhase('auth-morph');
      entrySkip.focus({ preventScroll: true });
      entryTimers.push(setTimeout(() => { if (!navigation) setPhase('success'); }, 720));
      entryTimers.push(setTimeout(() => {
        if (navigation) return;
        try { bridge.hidden = false; setPhase('entering'); } catch { navigate(); }
      }, 2050));
      entryTimers.push(setTimeout(navigate, 3550));
    } catch { navigate(); }
  }
  function busy(target, active) {
    target.setAttribute('aria-busy', String(active));
    for (const control of target.querySelectorAll('input,button')) control.disabled = active;
    if (target === form) callsign.disabled = active;
    const label = target.querySelector('.action-label');
    if (label) label.textContent = target === form ? (active ? '正在验证' : '连接终端') : (active ? '正在退出' : '退出访问授权');
  }
  function onMotionChange() {
    try { scene?.setReduced(motion.matches); } catch { try { scene?.dispose(); } catch {} scene = null; }
    if (motion.matches) { finishIntro(true); if (committed) navigate(); }
  }
  motion.addEventListener?.('change', onMotionChange);
  introSkip?.addEventListener('click', () => finishIntro(true));
  entrySkip?.addEventListener('click', event => { event.preventDefault(); if (committed) navigate(); });
  for (const field of [callsign, input]) {
    field.addEventListener('focus', () => { autoAllowed = false; finishIntro(true); });
    field.addEventListener('pointerdown', () => { autoAllowed = false; finishIntro(true); });
    field.closest('.physical-frame').addEventListener('pointerdown', event => {
      if (event.target !== field && !event.target.closest('button') && !field.disabled) { event.preventDefault(); field.focus(); }
    });
  }
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
  input.addEventListener('invalid', () => { finishIntro(true); setPhase('error'); tell(message, '请输入站点访问口令。'); });
  toggle.hidden = false;
  toggle.addEventListener('click', () => {
    const start = input.selectionStart, end = input.selectionEnd;
    const show = input.type === 'password'; input.type = show ? 'text' : 'password';
    input.focus();
    if (start !== null && end !== null) input.setSelectionRange(start, end);
    toggle.textContent = show ? '隐藏' : '显示'; toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', show ? '隐藏访问口令' : '显示访问口令');
  });

  function startIntro() {
    if (!animations || motion.matches || !intro || !introSkip || pending || committed || phase === 'error') return;
    intro.hidden = false; introSkip.hidden = false; setPhase('intro');
    introTimer = setTimeout(() => finishIntro(false), 1880);
  }
  animationToggle?.addEventListener('change', () => {
    if (pending || committed) { animationToggle.checked = animations; return; }
    autoAllowed = false;
    animations = animationToggle.checked;
    body.dataset.animations = animations ? 'on' : 'off';
    try { localStorage.setItem('ark.prts.animations', animations ? '1' : '0'); } catch {}
    if (animations) { loadScene(); startIntro(); }
    else {
      finishIntro(true);
      try { scene?.dispose(); } catch {}
      scene = null;
      restorePlane();
    }
  });
  const initialError = !authed && message.textContent.trim();
  if (initialError) setPhase('error');
  else startIntro();

  function rejectCallsign(result, node) {
    if (result?.code !== 'NAME_REJECTED') return false;
    autoAllowed = false;
    callsign.disabled = false;
    callsign.setAttribute('aria-invalid', 'true');
    callsign.focus();
    setPhase('error');
    tell(node, typeof result.message === 'string' ? result.message : '博士代号包含不合适的内容，请换一个。');
    return true;
  }

  async function continueSession(automatic = false) {
    if (pending || committed || (automatic && !autoAllowed)) return;
    const next = entryPath(returnLink.getAttribute('href')) || '/';
    const name = readCallsign();
    if (!name) return;
    pending = true; callsign.disabled = true; returnLink.setAttribute('aria-disabled', 'true');
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const payload = new URLSearchParams({ csrf: form.elements.csrf.value, next, callsign: name });
      const response = await fetch('/_gate/profile', { method: 'POST', headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', body: payload, signal: controller.signal });
      const result = await response.json().catch(() => null);
      if (rejectCallsign(result, statusMessage)) return;
      if (response.ok && result?.ok === true && typeof result.callsign === 'string' && (!automatic || autoAllowed)) enter(result.next, result.callsign);
      else if (response.status === 401 || response.status === 303) location.replace('/login?next=' + encodeURIComponent(next));
      else tell(statusMessage, typeof result?.message === 'string' ? result.message : '暂时无法进入终端，请稍后重试。');
    } catch { tell(statusMessage, '连接失败，请检查网络后重试。'); }
    finally { clearTimeout(timeout); pending = false; if (!committed) { callsign.disabled = false; returnLink.removeAttribute('aria-disabled'); } }
  }

  // Authentication is attached before the optional graphics engine is downloaded.
  if (window.fetch && window.FormData && window.URLSearchParams) {
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (pending || committed) return;
      finishIntro(true);
      if (retryAt > Date.now()) { setPhase('error'); tell(message, `请等待 ${Math.ceil((retryAt - Date.now()) / 1000)} 秒后再试。`); return; }
      if (!input.value) { input.focus(); input.setAttribute('aria-invalid', 'true'); tell(message, '请输入站点访问口令。'); return; }
      const name = readCallsign();
      if (!name) return;
      const requestBody = new URLSearchParams(new FormData(form));
      pending = true; busy(form, true); setPhase('checking'); tell(message, '正在确认访问权限……', 'pending');
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(form.action, { method: 'POST', headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', body: requestBody, signal: controller.signal });
        const result = await response.json().catch(() => null);
        clearTimeout(deadline);
        if (response.status === 429) {
          const wait = Math.max(1, Number(result?.retryAfter || response.headers.get('Retry-After')) || 30);
          retryAt = Date.now() + Math.min(wait, 86400) * 1000;
          setPhase('error'); tell(message, `验证请求过于频繁，请 ${Math.ceil(wait)} 秒后重试。`); return;
        }
        if (rejectCallsign(result, message)) return;
        if (!response.ok || result?.ok !== true) {
          setPhase('error');
          tell(message, typeof result?.message === 'string' ? result.message : '验证服务暂时不可用，请稍后再试。');
          if (response.status === 401) input.setAttribute('aria-invalid', 'true');
          return;
        }
        const next = entryPath(result.next);
        input.value = ''; input.type = 'password'; toggle.textContent = '显示'; toggle.setAttribute('aria-pressed', 'false');
        if (!next) { setPhase('error'); tell(message, '访问已获授权，请刷新此页后继续。'); return; }
        tell(message, '访问权限已确认。', 'success');
        if (typeof result.callsign !== 'string' || !result.callsign) { setPhase('error'); tell(message, '代号校验未完成，请刷新后重试。'); return; }
        enter(next, result.callsign);
      } catch (error) {
        if (!committed) { setPhase('error'); tell(message, error.name === 'AbortError' ? '验证请求超时，请重试。' : '无法连接认证服务，请检查网络。'); }
        else navigate();
      } finally {
        clearTimeout(deadline); pending = false;
        if (!committed) busy(form, false);
      }
    });

    logout.addEventListener('submit', async event => {
      event.preventDefault(); autoAllowed = false; if (pending || committed) return;
      const payload = new URLSearchParams(new FormData(logout)); pending = true; busy(logout, true);
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(logout.action, { method: 'POST', headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', body: payload, signal: controller.signal });
        const result = await response.json().catch(() => null);
        if (!response.ok || result?.ok !== true) { tell(statusMessage, result?.message || '退出未完成，请刷新后重试。'); return; }
        location.assign('/login');
      } catch { tell(statusMessage, '无法连接认证服务，请稍后重试。'); }
      finally { clearTimeout(timeout); pending = false; busy(logout, false); }
    });

    // Manual status-page entry and automatic remembered entry use the same fresh authorization check.
    returnLink.addEventListener('click', event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); autoAllowed = false; void continueSession(false);
    });
  }

  function restorePlane() {
    const plane = $('terminal-plane');
    if (plane.parentNode !== $('plane-home')) $('plane-home').appendChild(plane);
    for (const key of ['position', 'transform', 'pointerEvents', 'userSelect', 'display', 'margin']) plane.style[key] = '';
    $('spatial-dom').hidden = true; body.dataset.renderer = 'fallback'; body.dataset.spatial = 'false';
  }
  function loadScene() {
    if (!animations || motion.matches || scene || sceneLoading || navigation) return;
    sceneLoading = true;
    import('/_gate/assets/scene.js').then(module => {
      if (!animations || navigation) return;
      $('spatial-dom').hidden = false;
      scene = module.createTerminalScene({ canvas: $('world'), plane: $('terminal-plane'), home: $('plane-home'), dom: $('spatial-dom'), reduced: motion.matches });
      scene.setPhase(phase, performance.now() - phaseTime);
    }).catch(() => {
      restorePlane();
      if (!committed && phase === 'intro') finishIntro(false);
    }).finally(() => { sceneLoading = false; });
  }
  queueMicrotask(maybeAutoEnter);
  loadScene();
  window.addEventListener('pagehide', () => { clearTimeout(introTimer); clearTimeout(handoffTimer); clearTimeout(assembleTimer); clearEntry(); scene?.dispose(); });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
})();
