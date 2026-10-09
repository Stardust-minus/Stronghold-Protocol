// Compact multiplayer roster: fit every seat into the available HUD height, without a scroll container.
export function teamPanelLayout(count, height, rootSize = 40) {
  const seats = Math.max(1, Math.trunc(Number(count) || 1));
  const gap = 2;
  const preferred = Math.max(24, rootSize * 0.28);
  const available = Math.max(1, Number(height) || seats * (preferred + gap));
  const columns = Math.min(3, Math.max(1, Math.ceil(seats / Math.max(1, Math.floor((available + gap) / (20 + gap))))));
  const rows = Math.ceil(seats / columns);
  const rowHeight = Math.min(preferred, Math.max(1, (available - gap * (rows - 1)) / rows));
  return { columns, rows, rowHeight, avatar: Math.max(1, Math.min(26, rowHeight - 2)), gap };
}
