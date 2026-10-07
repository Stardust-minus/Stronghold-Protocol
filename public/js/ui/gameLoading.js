import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, MicroLabel, Spinner, useTicker } from './components.js';
import { GAME_FILES } from './gameComponents.js';
import { data, DATA_FILES } from '../data.js';
import { t } from '../../../shared/i18n.js';

const optional = new Set(['assets', 'local']);
export const missingCoreData = (source = data) => GAME_FILES.some((name) => !optional.has(name) && source.status(name) === 'missing');
export const pendingGameFiles = (source = data) => GAME_FILES.map((name) => ({ name, status: source.status(name) }))
  .filter(({ name, status }) => status !== 'ready' && !(optional.has(name) && status === 'missing'));

/** Server terminal state must remain escapable even when core files are unavailable. */
export function gameScreenStage({ hasResult, ended, mode, hasPublic, ready, missing }) {
  if (hasResult || mode === 'result') return 'result';
  if (ended) return 'ended';
  return !hasPublic || !ready || missing ? 'loading' : 'game';
}

export function GameLoadingView({ hasPublic, slow, files, retrying = false, onRetry, onReload }) {
  const failed = files.some((file) => file.status === 'missing');
  return html`<div class="screen gload">
    <${Spinner} size="lg" label=${failed ? 'DATA UNAVAILABLE' : hasPublic ? 'LOADING DATA' : 'ENTERING SIMULATION'} />
    <p class="t-lo" role="status">${failed ? t('部分模拟数据未能载入') : hasPublic ? t('正在载入模拟数据…') : t('正在进入模拟…')}</p>
    ${slow || failed ? html`<section class="gload__recovery" aria-label=${t('载入恢复')}>
      <${MicroLabel}>CONNECTION RECOVERY<//>
      <p>${files.length ? t('以下文件仍未就绪，可以重试或刷新页面。') : t('正在等待服务器同步对局，可以刷新页面重新连接。')}</p>
      ${files.length ? html`<ul>${files.map(({ name, status }) => html`<li key=${name}>
        <span>${DATA_FILES[name] || `${name}.json`}</span><span>${status === 'missing' ? t('载入失败') : t('等待载入')}</span>
      </li>`)}</ul>` : null}
      <div class="gload__actions">
        ${files.length ? html`<${Button} variant="primary" disabled=${retrying} loading=${retrying} onClick=${onRetry}>${t('重试未完成项')}<//>` : null}
        <${Button} variant="secondary" onClick=${onReload}>${t('刷新页面')}<//>
      </div>
      <small>${t('重试只重新下载未就绪的数据，不会退出房间。')}</small>
    </section>` : null}
  </div>`;
}

export function GameLoading({ hasPublic }) {
  useTicker(1000);
  const [since] = useState(() => Date.now());
  const [retrying, setRetrying] = useState(false);
  const busy = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const retry = async () => {
    if (busy.current) return;
    busy.current = true;
    setRetrying(true);
    try {
      await Promise.all(pendingGameFiles().map(({ name, status }) => status === 'idle' ? data.load(name) : data.invalidate(name)));
    } finally { busy.current = false; if (mounted.current) setRetrying(false); }
  };
  return html`<${GameLoadingView} hasPublic=${hasPublic} slow=${Date.now() - since >= 8000}
    files=${pendingGameFiles()} retrying=${retrying} onRetry=${retry} onReload=${() => location.reload()} />`;
}
