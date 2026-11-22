// Small view pieces the panel's files share: terminal addresses, the spinner, links, buttons and the inline reader.

import { div } from 'gpui-kit';
import { Scrollbar, TextView, h_flex, v_flex } from 'gpui-base';
import { terminals } from 'herdr';
import { readFullShown, terminalAddress } from './model.js';

/** The Herdr address of a live terminal perc names (or addresses), else null: pane.focus takes addresses. */
export const addressOf = (term) => terminalAddress(terminals(), term);

export const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

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

/** The markdown file at `path` (resolved; its text in `p.files`), with its name and Read full ↗ (the pop-out window).
 *  It scrolls on its own past half the panel. */
export function inlineReader(p, t, path, id) {
  const md = p.files[path];
  return v_flex()
    .flex_none()
    .gap(4)
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(path.split(/[\\/]/).pop()))
        .child(div().flex_1())
        .when(readFullShown(p.inWindow()), (el) => el.child(link(t, `${id}-full`, 'Read full ↗', () => p.popOut()))),
    )
    .child(
      own(
        v_flex()
          .id(`${id}-frame`)
          .flex_none()
          .max_h(p.readerMaxH())
          .rounded(6)
          .bg(t.surface)
          .border(1)
          .border_color(t.border)
          .child(scrollY(id, v_flex().px(12).py(8).text_size(12).child(TextView.markdown(`md-${path}`, md ?? 'loading…')))),
      ),
    );
}
