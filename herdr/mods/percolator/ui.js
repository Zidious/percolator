// Small view pieces the panel's files share: theme colours for model tones, the spinner, links and buttons.

import { div } from 'gpui-kit';
import { Scrollbar } from 'gpui-base';
import { stepTone } from './model.js';

export const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** The theme colour for a step status (border for one that has not run). */
export const stepColor = (t, status) => t[stepTone(status)] ?? t.border;

/** Stops a press from reaching the window (a window overlay drags on presses its mod doesn't stop). */
export const own = (el) => el.on_mouse_down('left', (_e, cx) => cx.stop_propagation());

/** `el` as a vertical scroll area named `id`, as tall as its content until its parent runs out, with the theme's bar.
 *  Not overflow_y_scrollbar(): that wraps the element, so its flex sizing never reaches the layout. */
export const scrollY = (id, el) =>
  div()
    .relative()
    .flex()
    .flex_col()
    .min_h(0)
    .child(el.id(id).min_h(0).overflow_y_scroll())
    .child(Scrollbar.vertical(id).absolute().inset_0());

/** A small raised link-like control. */
export function link(t, id, label, onClick) {
  return own(
    div()
      .id(id)
      .flex_none()
      .px(7)
      .py(2)
      .rounded(4)
      .text_size(11)
      .text_color(t.muted)
      .bg(t.raised)
      .cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .on_click(onClick)
      .child(label),
  );
}

/** A button: kind "ok" (solid), "no" (blocked outline) or "" (plain); `busy` spins, `disabled` greys it out. */
export function button(t, id, label, kind, onClick, { busy = false, disabled = false } = {}) {
  const solid = kind === 'ok' && !disabled;
  const fg = disabled ? t.dim : solid ? t.solid_foreground : kind === 'no' ? t.blocked : t.foreground;
  return own(
    div()
      .id(id)
      .flex_none()
      .px(12)
      .py(5)
      .rounded(6)
      .text_size(12)
      .font_semibold()
      .bg(solid ? t.solid : t.raised)
      .text_color(fg)
      .border(1)
      .border_color(solid ? t.solid : kind === 'no' && !disabled ? t.blocked : t.border)
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click(onClick))
      .when(disabled, (el) => el.cursor_not_allowed())
      .child(
        busy
          ? div().flex().gap(6).child(div().frames(SPIN, 90).child(SPIN[0])).child(label)
          : label,
      ),
  );
}
