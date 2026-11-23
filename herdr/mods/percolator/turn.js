// What sits under the selected run's active stop (the agent card, or the box saying what the run needs from you) and
// the lower half under the pipeline: how a finished run ended, and the history fold.

import { div } from 'gpui-kit';
import { v_flex, h_flex, Textarea } from 'gpui-base';
import { agents, terminals } from 'herdr';
import {
  activeBox,
  agentAddress,
  agentCard,
  agentNote,
  agentTone,
  ago,
  attentionTag,
  boxActions,
  boxAsks,
  boxDriver,
  historyLabel,
  outcomeOf,
  programInitial,
  textTone,
  timelineRows,
} from './model.js';
import { stopStrip } from './pipeline.js';
import { button, inlineReader, own, scrollY } from './ui.js';

const LABELS = {
  approve: ['Approve', 'ok'],
  reject: ['Reject…', 'no'],
  grant: ['Grant a round & resume', 'ok'],
  resume: ['Resume', 'ok'],
  clean: ['Clean up', ''],
};

const tag = (label, c) =>
  div().flex_none().px(6).py(1).rounded(4).text_size(10).font_semibold().border(1).border_color(c).text_color(c).child(label);


/** The run history's rows, newest first. */
function historyList(t, r) {
  const rows = timelineRows(r, Date.now());
  return v_flex()
    .py(4)
    .children(
      rows.length === 0
        ? [div().px(12).py(3).text_size(11.5).text_color(t.muted).child('Nothing has run yet.')]
        : rows.map((x) =>
            h_flex()
              .px(12)
              .py(3)
              .gap(10)
              .text_size(11.5)
              .child(div().w(10).flex_none().text_color(t[textTone(x.tone)]).child(x.mark))
              .child(div().w(130).flex_none().truncate().text_color(t.foreground).child(x.step))
              .child(div().w(60).flex_none().text_color(t.muted).child(x.round))
              .child(div().w(90).flex_none().text_color(t[textTone(x.tone)]).child(x.status))
              .child(div().w(50).flex_none().text_color(t.muted).child(x.started))
              .child(div().w(50).flex_none().text_color(t.muted).child(x.took))
              .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(x.note)),
          ),
    );
}

/** "History ▸ N attempts" under the pipeline, closed by default; open, the run history in a box that scrolls past 200px. */
export function historyFold(p, t, r) {
  const open = p.historyOpen;
  return v_flex()
    .flex_none()
    .gap(6)
    .pt(8)
    .border_t(1)
    .border_color(t.border)
    .child(
      own(
        h_flex()
          .id('history-toggle')
          .gap(6)
          .items_center()
          .cursor_pointer()
          .text_size(11.5)
          .text_color(t.muted)
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => {
            p.historyOpen = !p.historyOpen;
            cx.notify();
          })
          .child(historyLabel(r, open)),
      ),
    )
    .when(open, (el) =>
      el.child(
        own(
          v_flex()
            .id('history-frame')
            .flex_none()
            .max_h(200)
            .rounded(6)
            .bg(t.background)
            .border(1)
            .border_color(t.border)
            .child(scrollY('history', historyList(t, r))),
        ),
      ),
    );
}

function rejectBox(p, t) {
  return v_flex()
    .flex_none()
    .gap(6)
    .child(
      own(
        div()
          .w_full()
          .h(76)
          .px(10)
          .py(6)
          .rounded(6)
          .border(1)
          .border_color(t.blocked)
          .bg(t.surface)
          .text_size(12)
          .text_color(t.foreground)
          .child(Textarea.new(p.feedback).w_full().h_full()),
      ),
    )
    .child(
      h_flex()
        .flex_wrap()
        .gap(8)
        .items_center()
        .child(button(t, 'reject-send', 'Send', 'no', (_e, cx) => p.sendReject(cx), { busy: p.busy === 'reject', disabled: Boolean(p.busy) }))
        .child(button(t, 'reject-cancel', 'Cancel', '', (_e, cx) => p.cancelReject(cx), { disabled: Boolean(p.busy) }))
        .child(div().text_size(11).text_color(p.rejectError ? t.blocked : t.muted).child(p.rejectError ?? 'Ctrl+Enter sends · Esc cancels')),
    );
}

/** `el` with the error of the last action, or what fixtures mode would have done. */
function said(p, t, el) {
  return el
    .when(Boolean(p.actError), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(p.actError)))
    .when(Boolean(p.said), (el) => el.child(div().text_size(11).text_color(t.accent).child(p.said)));
}

/** The agent working the active stop: its program, Herdr's status for it, its terminal; a click opens the terminal.
 *  Dim and inert while the terminal is not live. Under the stop (`narrow`) the link says just Open ↗. */
function agentBox(p, t, card, narrow) {
  const on = Boolean(card.address);
  return own(
    h_flex()
      .id('agent-card')
      .mt(2)
      .mb(8)
      .px(9)
      .py(6)
      .gap(8)
      .items_center()
      .rounded(7)
      .bg(t.background)
      .border(1)
      .border_color(on ? t.working : t.border)
      .text_size(11.5)
      .text_color(on ? t.foreground : t.dim)
      .when(on, (el) =>
        el
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            p.openAgent();
            cx.notify();
          }),
      )
      .child(
        div()
          .flex_none()
          .size(18)
          .rounded(4)
          .bg(t.raised)
          .flex()
          .items_center()
          .justify_center()
          .text_size(10)
          .font_semibold()
          .child(programInitial(card.program)),
      )
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .child(
            h_flex()
              .min_w(0)
              .gap(4)
              .child(div().flex_none().child(`${card.program} ·`))
              .child(div().min_w(0).truncate().text_color(t[agentTone(card.status)]).child(card.status)),
          )
          .child(div().min_w(0).truncate().text_size(10.5).text_color(t.muted).child(card.since ? `${card.name} · ${card.since}` : card.name)),
      )
      .child(div().flex_none().font_semibold().text_color(on ? t.working : t.dim).child(narrow ? 'Open ↗' : 'Open terminal ↗')),
  );
}

/** The box of a run that needs you: the tag, the message and its age, the detail, the file to review, the buttons.
 *  With `fill` (the right column of two) its reader takes the height left. */
function attentionBox(p, t, r, kind, narrow, fill) {
  const a = r.attention;
  const acts = boxActions(r);
  const card = agentCard(r, terminals(), agents(), Date.now());
  const live = Boolean(agentAddress(r, terminals()));
  const drv = boxDriver(r);
  const buttons = h_flex()
    .flex_none()
    .flex_wrap()
    .gap(8)
    .items_center()
    .children(
      // pick is one button per pipeline the gate may pick
      acts.flatMap((x) =>
        x === 'pick'
          ? (a.choices ?? []).map((name) =>
              button(t, `pick-${name}`, `Run ${name}`, 'ok', (_e, cx) => p.act('pick', cx, name), {
                busy: p.busy === 'pick',
                disabled: Boolean(p.busy),
              }),
            )
          : [
              button(t, `act-${x}`, LABELS[x]?.[0] ?? x, LABELS[x]?.[1] ?? '', (_e, cx) => p.act(x, cx), {
                busy: p.busy === x,
                disabled: Boolean(p.busy) && p.busy !== x,
              }),
            ],
      ),
    )
    .when(Boolean(a.commentUrl), (el) => el.child(button(t, 'github', 'GitHub ↗', '', (_e, cx) => cx.open_url(a.commentUrl))))
    .when(live, (el) => el.child(button(t, 'open-terminal', 'Open terminal ↗', '', () => p.openAgent())))
    .when(Boolean(drv), (el) => el.child(button(t, 'box-driver', drv.label, '', () => p.peekDriver())));
  const grow = fill && Boolean(p.boxFile);
  const box = v_flex()
    .when(grow, (el) => el.flex_1().min_h(0))
    .when(!grow, (el) => el.flex_none())
    .mt(2)
    .mb(8)
    .px(9)
    .py(8)
    .gap(8)
    .rounded(7)
    .bg(t.background)
    .border(1)
    .border_color(t.blocked)
    .child(
      // narrow: the tag and the age on a line of their own, so the message wraps at its words, not inside them
      h_flex()
        .flex_none()
        .gap(8)
        .items_center()
        .child(tag(attentionTag(kind), t.blocked))
        .when(!narrow, (el) => el.child(div().flex_1().min_w(0).text_size(12.5).font_semibold().child(a.message)))
        .when(narrow, (el) => el.child(div().flex_1()))
        .child(div().flex_none().text_size(11).text_color(t.muted).child(`${ago(a.since, Date.now())} ago`)),
    )
    .when(narrow, (el) => el.child(div().text_size(12.5).font_semibold().child(a.message)))
    .when(Boolean(a.detail), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(a.detail)))
    .when(Boolean(card), (el) =>
      el.child(
        h_flex()
          .gap(4)
          .text_size(11)
          .text_color(t.muted)
          .child(div().flex_none().child(`${card.program} ·`))
          .child(div().flex_none().text_color(t[agentTone(card.status)]).child(card.status))
          .child(div().min_w(0).truncate().child(`· ${card.name}`)),
      ),
    )
    .when(Boolean(p.boxFile), (el) => el.child(inlineReader(p, t, p.boxFile, 'box-reader', grow)))
    .when(acts.length > 0 || Boolean(a.commentUrl) || live || Boolean(drv), (el) => el.child(buttons))
    .when(p.rejecting, (el) => el.child(rejectBox(p, t)));
  return said(p, t, box);
}

/** What shows under the active stop (main.js hands it to the pipeline as `p.activeSlot`), or at the top of the right
 *  column of two (`fill`: its reader takes the height left). */
export function activeSlot(p, t, r, narrow, fill = false) {
  const kind = activeBox(r);
  if (kind === null) return div();
  if (kind === 'agent') {
    const card = agentCard(r, terminals(), agents(), Date.now());
    if (!card) return div().mt(2).mb(8).text_size(11).text_color(t.muted).child(agentNote(card));
    return agentBox(p, t, card, narrow);
  }
  return attentionBox(p, t, r, kind, narrow, fill);
}

/** How a run with nothing under its active stop stands: delivered, routed, done, unreadable, or its status. */
function outcome(t, r) {
  if (r.status === 'completed') {
    const o = outcomeOf(r);
    return h_flex()
      .gap(8)
      .items_center()
      .child(tag(o.tag, t.done))
      .when(o.text !== '', (el) => el.child(div().min_w(0).truncate().text_size(12.5).child(o.text)));
  }
  if (r.status === 'unreadable') {
    return h_flex().gap(8).items_center().child(tag('UNREADABLE', t.muted)).child(div().min_w(0).text_size(12.5).truncate().child(r.error));
  }
  return h_flex().gap(8).items_center().child(tag(r.status.toUpperCase(), t.muted));
}

/** The lower half (one column) or the right column's body (two, `fill`): the parts detailParts puts there (the active
 *  box, how a finished run ended, the picked stop's strip), then the history fold. */
export function turn(p, t, r, narrow, side, fill = false) {
  const part = (x) => (x === 'box' ? activeSlot(p, t, r, narrow, fill) : x === 'outcome' ? outcome(t, r) : stopStrip(p, t, r, fill));
  const body = v_flex()
    .when(fill, (el) => el.flex_1().min_h(0))
    .when(!fill, (el) => el.flex_none())
    .px(16)
    .pt(8)
    .pb(12)
    .gap(10)
    .children(side.map(part));
  return (boxAsks(r) ? body : said(p, t, body)).child(historyFold(p, t, r));
}
