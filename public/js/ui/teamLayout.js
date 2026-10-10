// Keep readable rows; a short/narrow roster scrolls rather than shrinking its final seats.
export function teamPanelLayout(count, height, rootSize = 40, width = 240, coarse = false) {
  const seats = Math.max(1, Math.trunc(Number(count) || 1));
  const gap = 4;
  const rowHeight = Math.max(48, Math.min(64, rootSize * .48));
  const available = Math.max(1, Number(height) || seats * (rowHeight + gap));
  const maxColumns = coarse ? 1 : Math.min(2, Math.max(1, Math.floor((Math.max(1, width) + gap) / (204 + gap))));
  const columns = seats * (rowHeight + gap) - gap > available ? maxColumns : 1;
  const rows = Math.ceil(seats / columns);
  return { columns, rows, rowHeight, avatar: Math.min(40, rowHeight - 12), gap };
}
