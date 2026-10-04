// One immutable full dataset and one normalization cache per thread, shared by all phase engines.
import { deepFreeze, getData } from '../../data.js';
import { DataSource } from '../../sim/simdata.js';
import { initializeGameData } from '../../sim/content/support/index.js';

let installed = null;
let source = null;
export function combatData(data = installed ?? getData()) {
  if (!data || typeof data !== 'object' || data instanceof DataSource || typeof data.getChess === 'function') {
    throw new TypeError('combat data must be the full raw dataset, not a DataSource');
  }
  if (installed && data !== installed) throw new Error('combat data cannot change within a thread');
  if (!installed) {
    initializeGameData(deepFreeze(data));
    installed = data;
    // No fallback to a second dataset: content and sim must resolve the same records.
    source = new DataSource(data);
  }
  return source;
}
