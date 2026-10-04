// Explicit local operator actions; no timers, remote shell, deployment, or backend stop command.
import { controlRequest, releaseId } from './control.js';

const [socketPath, op, id, flag] = process.argv.slice(2);
try {
  if (!socketPath?.startsWith('/') || !['status', 'reload', 'activate', 'rollback', 'retire', 'drain'].includes(op)) {
    throw new Error('Usage: node server/rolling/cli.js /private/control.sock status|reload|activate|rollback|retire|drain [release-id] [on|off]');
  }
  const input = { op };
  if (!['status', 'reload'].includes(op)) input.releaseId = releaseId(id);
  if (op === 'drain') {
    if (!['on', 'off'].includes(flag)) throw new Error('drain requires on|off');
    input.draining = flag === 'on';
  }
  // Status is aggregate-only; the CLI never prints tokens or serializes sessions.
  console.log(JSON.stringify(await controlRequest(socketPath, input, 10000), null, 2));
} catch (e) { console.error(e.message); process.exitCode = 1; }
