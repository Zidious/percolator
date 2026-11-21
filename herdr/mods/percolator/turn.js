// The lower half: what the selected run needs from you (or what it is doing), the reader, history and the actions.

import { div } from 'gpui-kit';
import { v_flex, h_flex, TextView, Textarea } from 'gpui-base';
import { terminals } from 'herdr';
import { ago, attentionTag, terminalCommands, took } from './model.js';
import { stepColor, link, button, own, scrollY } from './ui.js';

const LABELS = {
  approve: ['Approve', 'ok'],
  reject: ['Reject…', 'no'],
  grant: ['Grant a round & resume', 'ok'],
  resume: ['Resume', 'ok'],
  clean: ['Clean up', ''],
  'open-pane': ['Go to agent pane', ''],
};
const MARKS = { running: '●', pass: '✓', waiting: '■', pending: '·' };
const live = (term) => Boolean(term) && terminals().some((x) => x.address === term);

const tag = (label, c) =>
  div().flex_none().px(6).py(1).rounded(4).text_size(10).font_semibold().border(1).border_color(c).text_color(c).child(label);

// The reader, history and the agent tail fill what the detail has left over (p.boxH, at least a few lines; below that
// the detail scrolls), and scroll on their own past that.
const frame = (p, t, id) =>
  v_flex().id(id).flex_none().h(p.boxH).rounded(6).bg(t.background).border(1).border_color(t.border);
const box = (p, t, id, inner) => frame(p, t, `${id}-frame`).child(scrollY(id, inner));

function reader(p, t) {
  const md = p.files[p.file];
  return v_flex()
    .flex_none()
    .gap(4)
    .child(div().text_size(11).text_color(t.muted).child(p.file.split(/[\\/]/).pop()))
    .child(
      own(
        frame(p, t, 'reader')
          .overflow_y_scrollbar()
          .px(14)
          .py(10)
          .text_size(12)
          .child(TextView.markdown(`md-${p.file}`, md ?? 'loading…')),
      ),
    );
}

/** Steps that ran, newest first. */
function history(p, t, r) {
  const ran = (r.steps ?? []).filter((s) => s.status !== 'pending').reverse();
  const now = Date.now();
  const list = v_flex()
    .py(4)
    .children(
      ran.length === 0
        ? [div().px(12).py(3).text_size(11.5).text_color(t.dim).child('Nothing has run yet.')]
        : ran.map((s) =>
            h_flex()
              .px(12)
              .py(3)
              .gap(10)
              .text_size(11.5)
              .child(div().w(10).flex_none().text_color(stepColor(t, s.status)).child(MARKS[s.status] ?? '✕'))
              .child(div().w(130).flex_none().truncate().text_color(t.foreground).child(s.id))
              .child(div().w(70).flex_none().text_color(t.dim).child(s.kind))
              .child(div().w(90).flex_none().text_color(stepColor(t, s.status)).child(s.status))
              .child(div().w(80).flex_none().text_color(t.dim).child(s.attempts > 1 ? `${s.attempts} attempts` : ''))
              .child(div().flex_1().text_color(t.dim).child(took(s, now))),
          ),
    );
  return v_flex()
    .flex_none()
    .gap(4)
    .child(div().text_size(11).text_color(t.muted).child('History'))
    .child(own(box(p, t, 'history', list)));
}

function tail(p, t, r, text) {
  return v_flex()
    .flex_none()
    .gap(4)
    .child(div().text_size(11).text_color(t.muted).child(`${r.currentStep} agent · last lines`))
    .child(
      own(
        box(
          p,
          t,
          'tail',
          v_flex()
            .p(10)
            .text_size(11)
            .font_family('monospace')
            .text_color(t.muted)
            .children(text.split('\n').map((line) => div().whitespace_nowrap().child(line || ' '))),
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
          .bg(t.background)
          .text_size(12)
          .text_color(t.foreground)
          .child(Textarea.new(p.feedback).w_full().h_full()),
      ),
    )
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .child(button(t, 'reject-send', 'Send', 'no', (_e, cx) => p.sendReject(cx), { busy: p.busy === 'reject', disabled: Boolean(p.busy) }))
        .child(button(t, 'reject-cancel', 'Cancel', '', (_e, cx) => p.cancelReject(cx), { disabled: Boolean(p.busy) }))
        .child(div().text_size(11).text_color(p.rejectError ? t.blocked : t.dim).child(p.rejectError ?? 'Ctrl+Enter sends · Esc cancels')),
    );
}

/** "Terminal commands": a disclosure row; open, one copyable command per line. The choice lives on the panel. */
function commandsSection(p, t, cmds, narrow) {
  const open = p.cmdsOpen;
  return v_flex()
    .flex_none()
    .gap(6)
    .child(
      own(
        h_flex()
          .id('cmds-toggle')
          .gap(6)
          .items_center()
          .cursor_pointer()
          .text_size(11)
          .text_color(t.muted)
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => {
            p.cmdsOpen = !p.cmdsOpen;
            cx.notify();
          })
          .child(div().w(12).flex_none().text_size(12).child(open ? '▾' : '▸'))
          .child('Terminal commands'),
      ),
    )
    .when(open, (el) =>
      el.children(
        cmds.map((c, i) =>
          h_flex()
            .gap(8)
            .items_center()
            .child(
              div()
                .flex_1()
                .min_w(0)
                .px(8)
                .py(4)
                .rounded(4)
                .bg(t.raised)
                .text_size(11)
                .font_family('monospace')
                .text_color(t.foreground)
                .when(!narrow, (el) => el.truncate())
                .child(c),
            )
            .child(
              link(t, `copy-${i}`, p.copied === c ? 'Copied' : 'Copy', (_e, cx) => {
                cx.write_to_clipboard(c);
                p.copied = c;
                cx.notify();
              }),
            ),
        ),
      ),
    );
}

function banner(p, t, r, narrow) {
  const a = r.attention;
  const now = Date.now();
  if (a) {
    return h_flex()
      .gap(8)
      .items_center()
      .child(tag(attentionTag(a.kind), t.blocked))
      .child(div().min_w(0).text_size(13).font_semibold().when(!narrow, (el) => el.truncate()).child(a.message))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(`${ago(a.since, now)} ago`));
  }
  if (r.status === 'running') {
    const st = (r.steps ?? []).find((s) => s.id === r.currentStep);
    const term = r.terminals?.[r.currentStep];
    const spent = st ? took(st, now) : '';
    return h_flex()
      .flex_wrap()
      .gap(8)
      .items_center()
      .child(tag('RUNNING', t.working))
      .child(div().text_size(13).child(`${r.currentStep} is running${spent ? ` for ${spent}` : ''}. Nothing for you yet.`))
      .when(live(term), (el) => el.child(link(t, 'watch', 'watch agent ↗', () => p.focusTerminal(term))));
  }
  if (r.status === 'completed') {
    const pr = r.pr?.url;
    return h_flex()
      .gap(8)
      .items_center()
      .child(tag('DELIVERED', t.done))
      .child(div().text_size(13).child(pr ? `Opened ${pr.replace(/^https:\/\/github\.com\//, '')}` : 'Done.'));
  }
  if (r.status === 'unreadable') {
    return h_flex().gap(8).items_center().child(tag('UNREADABLE', t.muted)).child(div().min_w(0).text_size(13).truncate().child(r.error));
  }
  return h_flex().gap(8).items_center().child(tag(r.status.toUpperCase(), t.muted));
}

export function turn(p, t, r, narrow) {
  const a = r.attention;
  const acts = a?.actions ?? [];
  const term = r.status === 'running' ? r.terminals?.[r.currentStep] : null;
  const tailText = live(term) ? p.tail[term] : null;
  const body = p.file
    ? reader(p, t)
    : a
      ? history(p, t, r)
      : tailText
        ? tail(p, t, r, tailText)
        : history(p, t, r);
  const cmds = terminalCommands(r);
  const say = p.said ? div().text_size(11).text_color(t.accent).child(p.said) : null;
  const buttons = h_flex()
    .flex_wrap()
    .gap(8)
    .items_center()
    .children(
      acts.map((x) =>
        button(t, `act-${x}`, LABELS[x]?.[0] ?? x, LABELS[x]?.[1] ?? '', (_e, cx) => p.act(x, cx), {
          busy: p.busy === x,
          disabled: Boolean(p.busy) && p.busy !== x,
        }),
      ),
    )
    .when(Boolean(a?.commentUrl), (el) => el.child(button(t, 'github', 'GitHub ↗', '', (_e, cx) => cx.open_url(a.commentUrl))));
  return v_flex()
    .flex_none()
    .px(16)
    .pt(12)
    .pb(12)
    .gap(10)
    .child(banner(p, t, r, narrow))
    .when(Boolean(a?.detail), (el) => el.child(div().text_size(12).text_color(t.muted).child(a.detail)))
    .child(body)
    .when(p.rejecting, (el) => el.child(rejectBox(p, t)))
    .when(acts.length > 0, (el) => el.child(buttons))
    .when(Boolean(p.actError), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(p.actError)))
    .when(Boolean(say), (el) => el.child(say))
    .when(cmds.length > 0, (el) => el.child(commandsSection(p, t, cmds, narrow)));
}
