(() => {
  'use strict';
  // Only public, stable boot dependencies before authorization; never import the game here.
  const files = [
    '/fonts/fonts.css', '/fonts/bender-regular.woff2', '/fonts/bender-light.woff2',
    '/fonts/novecento-wide-normal.woff2', '/vendor/preact.module.js',
    '/vendor/hooks.module.js', '/vendor/htm.module.js',
  ];
  const controllers = new Set();
  let idle = 0, timer = 0, stopped = false, started = false;
  const economical = () => navigator.connection?.saveData || ['slow-2g', '2g'].includes(navigator.connection?.effectiveType);

  async function warmFile(path) {
    const controller = new AbortController();
    controllers.add(controller);
    const deadline = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(path, { credentials: 'omit', mode: 'cors', cache: 'default', priority: 'low', signal: controller.signal });
      if (!response.ok) { await response.body?.cancel(); return; }
      // Consume the body for the HTTP cache, without keeping it in storage or executing vendor code.
      await response.arrayBuffer();
    } catch { /* optional warmup must not delay or reject authorization */ }
    finally { clearTimeout(deadline); controllers.delete(controller); }
  }
  function startPublic() {
    if (started || stopped || document.hidden || economical() || !window.fetch || !window.AbortController) return;
    started = true;
    let index = 0;
    const run = async () => {
      while (!stopped && !document.hidden && !economical() && index < files.length) await warmFile(files[index++]);
    };
    void run(); void run(); // At most two low-priority requests, seven small files, no retries.
  }
  function cancelPublic() {
    stopped = true;
    clearTimeout(timer);
    if (idle) window.cancelIdleCallback?.(idle);
    for (const controller of controllers) controller.abort();
  }
  window.addEventListener('pagehide', cancelPublic);
  if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(startPublic, { timeout: 2000 });
  else timer = setTimeout(startPublic, 1200);
})();
