// The board: one row per run (needing you first, then running, then newest), with a mini train and a state line.

import { div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { STAGES, ago, rowState, ticketTitle } from './model.js';
import { mark } from './mark.js';
import { SPIN, stepColor, own, scrollY } from './ui.js';

const title = (r) => (r.status === 'unreadable' ? r.id : ticketTitle(r));
const number = (r) => (r.status === 'unreadable' ? '?' : `#${r.ticket.number}`);
const age = (r, now) => (r.status === 'unreadable' ? '' : ago(r.attention?.since ?? r.createdAt, now));

// the state text truncates alone; the round (when there is one) is a separate child, so it is never cut
function stateCell(s, width, size, t) {
  return h_flex()
    .w(width)
    .flex_none()
    .gap(4)
    .text_size(size)
    .text_color(t[s.tone])
    .child(div().min_w(0).truncate().child(s.text))
    .when(s.round, (el) => el.child(div().flex_none().child(`· ${s.round}`)));
}

function icon(t, r) {
  const box = div().w(14).flex_none().flex().items_center().justify_center().text_size(12);
  if (r.attention?.kind === 'failed') return box.text_color(t.blocked).child('✕');
  if (r.attention) {
    return box.child(div().size(8).rounded(4).bg(t.blocked).loop('opacity', { from: 0.35, to: 1, period: 1200 }));
  }
  if (r.status === 'running') return box.text_color(t.working).frames(SPIN, 90).child(SPIN[0]);
  if (r.status === 'completed') return box.text_color(t.done).child('✓');
  if (r.status === 'failed') return box.text_color(t.blocked).child('✕');
  if (r.status === 'unreadable') return box.text_color(t.muted).child('!');
  return box.text_color(t.dim).child('·');
}

/** Six equal columns, one segment per step in each stage, coloured by status. */
function mini(t, r) {
  const steps = r.steps ?? [];
  const stageOf = (s) => (s.stage === 'before-all' ? 'intake' : s.stage === 'after-all' ? 'deliver' : s.stage);
  return h_flex()
    .flex_1()
    .min_w(0)
    .gap(5)
    .children(
      STAGES.map((stage) =>
        h_flex()
          .flex_1()
          .h(6)
          .gap(1)
          .children(
            steps
              .filter((st) => stageOf(st) === stage)
              .map((st) => div().flex_1().h_full().rounded(2).bg(stepColor(t, st.status))),
          ),
      ),
    );
}

function empty(t, filter) {
  return v_flex()
    .flex_none()
    .py(28)
    .items_center()
    .gap(6)
    .border_b(1)
    .border_color(t.border)
    .child(mark(32, t.dim, t.dim, false))
    .child(
      div()
        .text_size(13)
        .text_color(t.muted)
        .child(filter === 'all' ? 'No runs yet' : 'Nothing running, nothing waiting on you'),
    )
    .child(div().text_size(11.5).text_color(t.dim).child('perc run <owner/repo#issue>'));
}

/** The run list; its frame in main.js takes the divider's height; it scrolls, and ↑/↓ bring the selected row into view. */
export function board(p, t, narrow, rows) {
  if (rows.length === 0) return empty(t, p.filter);
  const now = Date.now();
  const pick = (r) => (_e, cx) => {
    p.select(r.id, cx);
    cx.notify();
  };
  const frame = (r) => {
    const on = r.id === p.sel;
    return own(
      div()
        .id(`row-${r.id}`)
        .cursor_pointer()
        .border_l(2)
        .border_color(on ? t.accent : t.surface)
        .when(on, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click(pick(r)),
    );
  };
  if (narrow) {
    const list = v_flex()
      .track_scroll(p.boardScroll)
      .py(4)
      .children(
        rows.map((r) => {
          const s = rowState(r);
          return frame(r)
            .flex()
            .flex_col()
            .px(12)
            .py(6)
            .gap(4)
            .child(
              h_flex()
                .gap(6)
                .items_center()
                .text_size(12)
                .child(icon(t, r))
                .child(div().flex_none().font_semibold().child(number(r)))
                .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(title(r)))
                .child(div().flex_none().text_size(10.5).text_color(t.dim).child(age(r, now))),
            )
            .child(
              h_flex()
                .pl(20)
                .gap(8)
                .items_center()
                .child(mini(t, r))
                .child(stateCell(s, 130, 10.5, t)),
            );
        }),
      );
    return v_flex().min_h(0).child(scrollY('board', list));
  }
  const head = h_flex()
    .px(14)
    .pb(3)
    .gap(12)
    .text_size(9)
    .text_color(t.dim)
    .child(div().w(14).flex_none())
    .child(div().w(220).flex_none())
    .child(
      h_flex()
        .flex_1()
        .gap(5)
        .children(STAGES.map((s) => div().flex_1().min_w(0).text_center().truncate().child(s.toUpperCase()))),
    )
    .child(div().w(200).flex_none())
    .child(div().w(34).flex_none());
  return v_flex()
    .min_h(0)
    .pt(8)
    .pb(4)
    .child(head.flex_none())
    .child(
      scrollY(
        'board',
        v_flex()
          .track_scroll(p.boardScroll)
          .children(
            rows.map((r) => {
              const s = rowState(r);
              return frame(r)
                .flex()
                .items_center()
                .px(14)
                .py(6)
                .gap(12)
                .child(icon(t, r))
                .child(
                  h_flex()
                    .w(220)
                    .flex_none()
                    .gap(6)
                    .text_size(12)
                    .child(div().flex_none().font_semibold().text_color(t.foreground).child(number(r)))
                    .child(div().min_w(0).truncate().text_color(t.muted).child(title(r))),
                )
                .child(mini(t, r))
                .child(stateCell(s, 200, 11.5, t))
                .child(div().w(34).flex_none().text_size(11).text_color(t.dim).child(age(r, now)));
            }),
          ),
      ),
    );
}
