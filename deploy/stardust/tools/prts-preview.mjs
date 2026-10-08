// Read-only, LAN-only animation demo. No production gate, credentials, game backend, or WebSocket.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const auth = join(root, 'deploy/stardust/auth/public');
const previewScript = `(() => {
  if (document.body.dataset.preview !== 'animation-only') return;
  const url = new URL(location.href);
  if (url.searchParams.has('intro')) {
    try { localStorage.setItem('ark.prts.intro', url.searchParams.get('intro') === '1' ? '1' : '0'); } catch {}
  }
  try { if (!localStorage.getItem('ark.callsign')) localStorage.setItem('ark.callsign', 'Doctor'); } catch {}
  const input = document.getElementById('password');
  if (input) { input.value = 'DEMO'; input.readOnly = true; input.autocomplete = 'off'; }
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, options = {}) => {
    const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
    if (path !== '/_gate/login') return originalFetch(input, options);
    // This response is generated in this browser. Form contents NEVER travel to the server.
    const name = new URLSearchParams(options.body).get('callsign') || 'Doctor';
    return new Promise(resolve => setTimeout(() => resolve(new Response(JSON.stringify({ ok: true, next: '/', callsign: name }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    })), 260));
  };
})();`;
const previewCSS = `.preview-bar{position:fixed;z-index:30;top:0;left:0;right:0;min-height:30px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:6px 16px;background:#10151e;color:#dce5fb;font:11px system-ui,sans-serif}.preview-bar a{color:inherit;text-decoration:underline;text-underline-offset:3px;padding:4px 6px}.preview-bar nav{display:flex;gap:8px}.preview-done{min-height:100dvh;display:grid;place-content:center;gap:18px;padding:24px;font:16px/1.7 system-ui,sans-serif;background:#dce5fb;color:#10151e}.preview-done h1{font:700 58px Georgia,serif;margin:0}.preview-done p{max-width:40em;margin:0}.preview-done a{color:inherit}.preview-done small{color:#4a5160}.preview-bar~.bar-top{padding-top:24px}.preview-bar~.bar-top>span{visibility:hidden}@media(max-width:600px){.preview-bar{font-size:10px;padding:5px 12px;gap:2px}.preview-bar nav{gap:4px}.preview-done h1{font-size:40px}}`;
const bar = '<aside class="preview-bar"><span>本地动画预览 · 不连接正式服</span><nav><a href="/login?intro=0">重播组装</a><a href="/login?intro=1">播放片头</a></nav></aside>';
const done = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PRTS 本地动画预览</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/preview.css"><main class="preview-done"><small>本地动画预览 / TRANSITION COMPLETE</small><h1>进入动画完成</h1><p>这里仅演示终端组装、认证成功与进入转场，没有进行实际认证，也没有连接游戏服务。</p><p><a href="/login?intro=0">重新查看组装与登录动画</a>　<a href="/login?intro=1">连同片头重播</a></p><small>可在登录页直接点“连接终端”。演示口令已填好，无需输入真实口令。</small></main></html>`;
const types = { css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', woff2: 'font/woff2', webp: 'image/webp', json: 'application/json; charset=utf-8' };

export function createPreviewServer({ host = '192.168.10.101', port = 8788 } = {}) {
  if (!['192.168.10.101', '127.0.0.1'].includes(host)) throw new Error('Preview supports only the explicit LAN address or loopback');
  const routes = new Map();
  function add(path, file) {
    routes.set(path, { type: types[file.split('.').at(-1)], data: readFileSync(file) });
  }
  for (const name of ['gate.css', 'gate.js', 'warmup.js', 'scene.js', 'terminal-motion.js', 'entry-nav.js',
    'three.module.js', 'three.core.js', 'css3d.js', 'bender-regular.woff2', 'doctor.webp', 'rhodes.webp', 'ae-sphere.json']) add('/_gate/assets/' + name, join(auth, name));
  for (const name of ['fonts.css', 'bender-regular.woff2', 'bender-light.woff2', 'novecento-wide-normal.woff2']) add('/fonts/' + name, join(root, 'public/fonts', name));
  for (const name of ['preact.module.js', 'hooks.module.js', 'htm.module.js']) add('/vendor/' + name, join(root, 'public/vendor', name));
  routes.set('/preview.js', { type: types.js, data: Buffer.from(previewScript) });
  routes.set('/preview.css', { type: types.css, data: Buffer.from(previewCSS) });
  const template = readFileSync(join(auth, 'login.html'), 'utf8');
  const values = { AUTHENTICATED: 'false', LOGIN_HIDDEN: '', STATUS_HIDDEN: 'hidden', CSRF: 'LOCAL-DEMO-NOT-A-CREDENTIAL', NEXT: '/', MESSAGE: '' };
  const page = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => values[key] || '')
    .replace('<body ', '<body data-preview="animation-only" ')
    .replace('</head>', '<link rel="stylesheet" href="/preview.css"><script src="/preview.js" defer></script></head>')
    // Demo setup must execute before the real gate controller; the controller itself is unchanged.
    .replace(/(<script src="\/_gate\/assets\/gate\.js[^>]+><\/script>)/, '')
    .replace('<script src="/preview.js" defer></script>', '<script src="/preview.js" defer></script>' + template.match(/<script src="\/_gate\/assets\/gate\.js[^>]+><\/script>/)[0])
    .replace('<div id="ambient-field"', bar + '<div id="ambient-field"')
    .replace('PASSWORD <span>访问口令</span>', 'DEMO <span>演示占位 · 无需输入</span>')
    .replace('最多 12 字 · 同步为游戏昵称', '最多 12 字 · 仅用于本地凭证动画')
    .replace('非官方同人站点 · 仅验证共享访问口令，不收集游戏账号密码', '本地动画演示 · 无实际认证 · 不要填写真实口令');
  routes.set('/login', { type: 'text/html; charset=utf-8', data: Buffer.from(page) });
  let requests = 0, blocked = 0;
  const server = http.createServer((req, res) => {
    requests++;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
    const remote = req.socket.remoteAddress;
    const local = remote === '127.0.0.1' || /^192\.168\.10\.\d{1,3}$/.test(remote || '');
    if (!local || req.headers.host !== `${host}:${server.address().port}`) { blocked++; res.writeHead(403); res.end(); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { req.resume(); blocked++; res.writeHead(405); res.end('Read-only animation demo'); return; }
    let url;
    try { url = new URL(req.url, `http://${req.headers.host}`); } catch { res.writeHead(400); res.end(); return; }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (url.searchParams.get('_prts') !== '1') { res.writeHead(302, { Location: '/login' }); res.end(); return; }
      const data = Buffer.from(done); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': data.length }); res.end(req.method === 'HEAD' ? undefined : data); return;
    }
    const resource = routes.get(url.pathname);
    if (!resource) { blocked++; res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': resource.type, 'Content-Length': resource.data.length });
    res.end(req.method === 'HEAD' ? undefined : resource.data);
  });
  server.on('upgrade', (_, socket) => { blocked++; socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  return { server, listen: () => new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(port, host, resolveReady); }),
    stats: () => ({ requests, blocked, demoOnly: true, productionConnected: false }) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createPreviewServer(); await app.listen();
  console.log('PRTS animation preview ready at http://192.168.10.101:8788/login (LAN only; no authentication/game service)');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { app.server.closeAllConnections(); app.server.close(() => process.exit(0)); });
}
