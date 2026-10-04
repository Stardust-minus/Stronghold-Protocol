// Narrow lifecycle adapter. Sessions, admission and game state remain owned by net.js/lobby.js.
import { RollingError, releaseId, startControl } from './control.js';

export function backendRollingOptions(opts, env = process.env) {
  const id = opts.releaseId ?? env.SP_RELEASE_ID;
  const socketPath = opts.controlSocket ?? env.SP_ROLLING_CONTROL_SOCKET;
  if (id == null && socketPath == null) return null;
  if (!id || !socketPath) throw new RollingError('RELEASE_AND_CONTROL_SOCKET_REQUIRED', 400);
  releaseId(id);
  const raw = opts.draining ?? env.SP_ROLLING_DRAINING ?? false;
  if (![true, false, '0', '1'].includes(raw)) throw new RollingError('INVALID_DRAIN_CONFIGURATION', 400);
  return { releaseId: id, socketPath, draining: raw === true || raw === '1' };
}

export async function startBackendControl(config, { lobby, health }) {
  if (!config) return null;
  lobby.setDraining(config.draining, config.releaseId);
  const status = () => ({ ...health(), ...lobby.getRollingStatus(), releaseId: config.releaseId });
  const control = await startControl(config.socketPath, (input) => {
    if (input.op === 'status') return status();
    if (input.op === 'drain') {
      if (typeof input.draining !== 'boolean') throw new RollingError('INVALID_DRAIN', 400);
      const current = releaseId(input.currentReleaseId);
      lobby.setDraining(input.draining, current);
      return status();
    }
    throw new RollingError('UNKNOWN_COMMAND', 400);
  });
  return { ...control, status };
}
