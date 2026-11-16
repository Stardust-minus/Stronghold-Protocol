// Order and rotations from the official statistics template.
export const TITLE_HEX_SECTORS = [
  ['comment_4', 180], ['comment_5', 240], ['comment_6', 300],
  ['comment_1', 0], ['comment_2', 60], ['comment_3', 120],
];

/** The awards at which the official statistics view fills a 评语's wedge and brightens its count. */
export const TITLE_FULL_COUNT = 20;

/** Clipped fill in each wedge's local coordinates; zero has no active area. */
export function titleSectorClip(count) {
  const scale = Math.min(1, Math.max(0, count) / TITLE_FULL_COUNT);
  if (!(scale > 0)) return null;
  const points = [
    [47, 0], [47 * (1 - scale), 93 * scale], [47 - 43 * scale, 100 * scale],
    [53 + 43 * scale, 100 * scale], [53 + 47 * scale, 93 * scale], [53, 0],
  ];
  return `polygon(${points.map(([x, y]) => `${x}% ${y}%`).join(',')})`;
}
