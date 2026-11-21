// The Percolator mark, theme-tinted: drops and cup in `base`, the live ring in `live` (pulsing when `pulse`).
// The cup carries a copy (Herdr refuses imports from another mod folder; tests/herdr/cup.test.ts keeps them equal).

import { div, svg } from 'gpui-kit';

const DIR = 'mods/percolator';

export function mark(size, base, live, pulse) {
  return div()
    .relative()
    .size(size)
    .flex_none()
    .child(svg(`${DIR}/glyph-base.svg`).absolute().top(0).left(0).size(size).text_color(base))
    .child(
      svg(`${DIR}/glyph-live.svg`)
        .absolute()
        .top(0)
        .left(0)
        .size(size)
        .text_color(live)
        .when(Boolean(pulse), (el) => el.loop('opacity', { from: 0.4, to: 1, period: 1200 })),
    );
}
