// The selected run's header and its vertical pipeline: core stages on the spine, hooks on a branch to its right, loop
// spans in the gutter on its left, the stop strip under a picked row and the active slot under the active row.

import { div, svg } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { terminals } from 'herdr';
import { ago, canPick, deleteView, driverPeek, fanOutRow, hookNote, nowTone, parentLink, pipelineChip, pipelineMarks, pipelineRows, pipelineSpans, roundNote, roundView, runNextChoices, sliceRows, slotOpensAgent, stageName, textTone, ticketTitle, took, triggerLine } from './model.js';
import { chip, inlineReader, link, own } from './ui.js';

const GUTTER = 26; // loop spans
const SPINE = 24;
const LANE = 6; // between the lines of two loop spans in the gutter
const RADIUS = 8; // a loop span's corners
const ARROW = 6; // the arrowhead's width, at the gutter's right edge
const DIR = 'mods/percolator';
const short = (id) => id.split('-').pop();

export function header(p, t, r, narrow) {
  if (r.status === 'unreadable') {
    return v_flex()
      .px(16)
      .pt(14)
      .gap(5)
      .child(div().text_size(15).font_semibold().child(r.id))
      .child(div().text_size(11).text_color(t.muted).child('This run could not be read.'))
      .child(h_flex().gap(6).items_center().child(link(t, 'delete', 'Delete ↗', (_e, cx) => p.act('delete', cx), { disabled: Boolean(p.busy) })))
      .when(deleteView(r.id, p) !== null, (el) => el.child(deleteState(p, t, r)));
  }
  const drv = driverPeek(r);
  const up = parentLink(r, p.runs);
  const started = triggerLine(r);
  const now = Date.now();
  return v_flex()
    .px(16)
    .pt(14)
    .gap(5)
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .child(div().flex_none().text_size(15).font_semibold().child(r.ticket ? `#${r.ticket.number}` : ''))
        .child(div().min_w(0).text_size(15).truncate().child(ticketTitle(r)))
        .when(Boolean(pipelineChip(r)), (el) => el.child(chip(t, pipelineChip(r)))),
    )
    .when(Boolean(up), (el) =>
      el.child(
        h_flex().child(
          link(t, 'parent', up.text, (_e, cx) => p.toParent(cx)),
        ),
      ),
    )
    .when(started !== null, (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(started)))
    .child(
      h_flex()
        .gap(6)
        .items_center()
        .when(Boolean(r.ticket?.url), (el) => el.child(link(t, 'issue', 'Issue ↗', (_e, cx) => cx.open_url(r.ticket.url))))
        .when(Boolean(r.pr?.url), (el) => el.child(link(t, 'pr', 'PR ↗', (_e, cx) => cx.open_url(r.pr.url))))
        .when(Boolean(drv), (el) => el.child(link(t, 'driver', drv.label, () => p.peekDriver())))
        // which pipelines it offers is asked of the repo when it opens: here only whether it can be offered at all
        .when(runNextChoices(r, [], p.runs) !== null, (el) => el.child(link(t, 'run-next', '▸ Run next…', (_e, cx) => p.openRunNext(cx), { disabled: Boolean(p.busy) })))
        .child(link(t, 'delete', 'Delete ↗', (_e, cx) => p.act('delete', cx), { disabled: Boolean(p.busy) }))
        .child(
          div()
            .min_w(0)
            .truncate()
            .text_size(11)
            .text_color(t.muted)
            .child(
              narrow
                ? `Started ${ago(r.createdAt, now)} ago · ${short(r.id)}`
                : `${r.branch ?? ''} · started ${ago(r.createdAt, now)} ago · ${short(r.id)}`,
            ),
        ),
    )
    .when(deleteView(r.id, p) !== null, (el) => el.child(deleteState(p, t, r)));
}

/** Under the header's links: Deleting… while perc deletes the run, or why the delete failed and Try again ↗. */
function deleteState(p, t, r) {
  const v = deleteView(r.id, p);
  if (v.kind === 'deleting') return div().text_size(11).text_color(t.muted).child('Deleting…');
  return h_flex()
    .gap(8)
    .items_center()
    .child(div().min_w(0).truncate().text_size(11).text_color(t.blocked).child(`Delete failed: ${v.error}`))
    // the owner confirmed this delete already; only this run, so a failed Delete Finished Runs doesn't retry the deleted ones
    .child(link(t, 'delete-retry', 'Try again ↗', (_e, cx) => p.deleteRuns([r.id], cx), { disabled: Boolean(p.busy) }));
}

/** A loop span's line colour (dim before its loop is taken); its round pill's text reads the same tone via textTone. */
const toneColor = (t, tone) => (tone === 'working' ? t.working : tone === 'blocked' ? t.blocked : t.dim);

/** A piece of a vertical line, absolutely placed in its column: the top half, the bottom half or the whole height. */
const vline = (part, x, c) =>
  div()
    .absolute()
    .left(x)
    .w(2)
    .bg(c)
    .when(part === 'top', (el) => el.top_0().h('50%'))
    .when(part === 'bottom', (el) => el.top('50%').bottom_0())
    .when(part === 'full', (el) => el.top_0().bottom_0());

/**
 * The gutter of row `i` (`between`: the space under it, where a strip or the active slot sits): each loop span is a
 * bracket, a 2px line down the gutter with rounded corners turning toward the spine at its `to` and `from` rows'
 * centres, and an arrowhead into the `to` row.
 */
function gutter(t, spans, i, between) {
  const parts = spans.flatMap((s, k) => {
    const lo = Math.min(s.from, s.to);
    const hi = Math.max(s.from, s.to);
    if (lo === hi || i < lo || i > hi) return [];
    const c = toneColor(t, s.tone);
    const x = 4 + k * LANE;
    if (between) return i < hi ? [vline('full', x, c)] : [];
    if (i > lo && i < hi) return [vline('full', x, c)];
    const top = i === lo;
    const corner = div()
      .absolute()
      .left(x)
      .right(ARROW)
      .border_l(2)
      .border_color(c)
      .when(top, (el) => el.top('50%').mt(-1).bottom_0().border_t(2).rounded_tl(RADIUS))
      .when(!top, (el) => el.top_0().bottom('50%').mb(-1).border_b(2).rounded_bl(RADIUS));
    if (i !== s.to) return [corner];
    const arrow = svg(`${DIR}/loop-arrow.svg`).absolute().right(0).top('50%').mt(-4).w(ARROW).h(8).text_color(c);
    return [corner, arrow];
  });
  return div().flex_none().w(GUTTER).relative().children(parts);
}

/** The spine of row `i`: accent up to and including the reached row `last`, border after it. */
function spine(t, i, n, last, between, stop) {
  const c = (on) => (on ? t.accent : t.border);
  const x = SPINE / 2 - 1;
  return h_flex()
    .flex_none()
    .w(SPINE)
    .relative()
    .items_center()
    .justify_center()
    .when(between, (el) => el.when(i < n - 1, (el) => el.child(vline('full', x, c(i < last)))))
    .when(!between && i > 0, (el) => el.child(vline('top', x, c(i <= last))))
    .when(!between && i < n - 1, (el) => el.child(vline('bottom', x, c(i < last))))
    .when(Boolean(stop), (el) => el.child(stop));
}

/** The active stop `el` (stage stop or hook node), clickable to open the agent when one works there (slotOpensAgent);
 *  the click stops there, so the row is not picked too. */
function opensAgent(p, r, el, id) {
  if (!slotOpensAgent(r, terminals())) return el;
  return own(
    el
      .id(id)
      .cursor_pointer()
      .tooltip('Open terminal')
      .on_click((_e, cx) => {
        p.openAgent();
        cx.stop_propagation();
        cx.notify();
      }),
  );
}

/** The colour the active stop rings in (nowTone). */
const nowColor = (t, r) => t[nowTone(r)];

function stageStop(p, t, r, row, picked) {
  const gate = row.gate;
  if (row.state === 'active') {
    const c = nowColor(t, r);
    const stop = div()
      .size(24)
      .rounded(gate ? 4 : 12)
      .border(2)
      .border_color(c)
      .bg(t.surface)
      .flex()
      .items_center()
      .justify_center()
      .child(div().size(9).rounded(gate ? 2 : 5).bg(c));
    return opensAgent(p, r, stop, 'now-stop');
  }
  const fill = row.state === 'past' ? t.accent : row.state === 'failed' ? t.blocked : null;
  const dot = div()
    .size(16)
    .rounded(gate ? 4 : 8)
    .border(2)
    .border_color(fill ?? t.border)
    .bg(fill ?? t.surface);
  // the ring around a picked stop; always there, so picking does not move the row
  return div()
    .p(2)
    .rounded(gate ? 6 : 12)
    .border(1)
    .border_color(picked ? t.foreground : t.surface)
    .child(dot);
}

function stageLabel(t, r, row) {
  const st = row.step;
  const c =
    row.state === 'active' ? nowColor(t, r) : row.state === 'failed' ? t.blocked : row.state === 'past' ? t.foreground : t.muted;
  const now = Date.now();
  // a loop's target past round 1 says its round and its latest attempt's time
  const spent = roundNote(r, st.id, now) || (row.state === 'past' ? took(st, now) : '');
  const label = stageName(st);
  return h_flex()
    .flex_1()
    .min_w(0)
    .pl(8)
    .py(6)
    .gap(8)
    .items_center()
    .child(
      div()
        .flex_none()
        .text_size(11.5)
        .font_semibold()
        .text_color(c)
        // the stage name; the step id on hover tells rows of one stage apart
        .when(label !== st.id, (el) => el.tooltip(st.id))
        .child(label.toUpperCase()),
    )
    .when(Boolean(spent), (el) => el.child(div().flex_none().text_size(11).text_color(t.muted).child(spent)))
    .when(row.folded.length > 0, (el) =>
      el.child(
        div()
          .flex_none()
          .text_size(11)
          .text_color(t.muted)
          .tooltip(`Also ${row.folded.map((f) => f.id).join(', ')}`)
          .child(`+${row.folded.length}`),
      ),
    )
    .child(div().flex_1())
    .when(Boolean(row.round), (el) => {
      const rc = toneColor(t, row.round.tone);
      return el.child(
        div().flex_none().px(7).py(1).rounded(9).border(1).border_color(rc).text_size(10).text_color(t[textTone(row.round.tone)]).child(row.round.text),
      );
    });
}

function hookNode(p, t, r, row) {
  const c = row.state === 'active' ? nowColor(t, r) : row.state === 'failed' ? t.blocked : row.state === 'past' ? t.accent : t.border;
  const filled = row.state === 'past' || row.state === 'failed';
  const node = div()
    .flex_none()
    .size(10)
    .rounded(row.gate ? 2 : 5)
    .border(2)
    .border_color(c)
    .bg(filled ? c : t.surface);
  return row.state === 'active' ? opensAgent(p, r, node, 'now-node') : node;
}

function hookLabel(p, t, r, row) {
  const branch = row.state === 'future' ? t.border : row.state === 'active' ? nowColor(t, r) : t.accent;
  const name = row.state === 'active' ? nowColor(t, r) : row.state === 'failed' ? t.blocked : t.muted;
  return h_flex()
    .flex_1()
    .min_w(0)
    .py(2)
    .items_center()
    .child(div().flex_none().ml(-SPINE / 2).w(20).h(2).bg(branch))
    .child(hookNode(p, t, r, row))
    .child(div().flex_none().ml(7).font_family('monospace').text_size(11).text_color(name).child(row.step.id))
    .child(div().min_w(0).ml(6).truncate().text_size(10).text_color(t.muted).child(hookNote(r, row, Date.now())));
}

/** The vertical pipeline of a readable run, folding every passed hook when `fold` (under 320px); while `under` (one
 *  column), the strip opens under the picked row and `p.activeSlot` (drawn `narrow`) under the active one; in two
 *  columns they show in the right column. */
export function pipeline(p, t, r, fold, narrow, under = true) {
  if (r.status === 'unreadable') return div();
  const rows = pipelineRows(r, { narrow: fold, unfolded: p.unfolded });
  if (rows.length === 0) return div();
  const spans = pipelineSpans(rows, r);
  const n = rows.length;
  const { active, reached: last, stripAt } = pipelineMarks(rows, p.stopSel);
  const slices = sliceRows(r, p.runs ?? []);
  const fanAt = slices.length > 0 ? fanOutRow(rows) : -1;

  const below = (i, el) =>
    h_flex()
      .items_stretch()
      .child(gutter(t, spans, i, true))
      .child(spine(t, i, n, last, true, null))
      .child(div().flex_1().min_w(0).pl(8).child(el));

  return v_flex()
    .mx(16)
    .mt(10)
    .children(
      rows.flatMap((row, i) => {
        const st = row.step;
        const picked = st.id === p.stopSel;
        const stage = row.type === 'stage';
        const line = own(
          h_flex()
            .id(`stop-${st.id}`)
            .items_stretch()
            .min_h(stage ? 34 : 24)
            .tooltip(`${st.id} · ${st.kind} · ${st.status}`)
            .when(canPick(st), (el) =>
              el.cursor_pointer().on_click((_e, cx) => {
                p.pickStop(picked ? null : st.id, cx);
                cx.notify();
              }),
            )
            .child(gutter(t, spans, i, false))
            // the ring marks the row holding the picked stop: its own, or the stage row a picked hook folds into
            .child(spine(t, i, n, last, false, stage ? stageStop(p, t, r, row, i === stripAt) : null))
            .child(stage ? stageLabel(t, r, row) : hookLabel(p, t, r, row)),
        );
        const out = [line];
        // a fan-out parent's slices, one sub-row each, under its fan-out step in either layout
        if (i === fanAt) out.push(below(i, sliceList(p, t, slices)));
        if (!under) return out;
        if (i === active) out.push(below(i, p.activeSlot ? p.activeSlot(t, r, narrow) : div()));
        if (i === stripAt) out.push(below(i, stopStrip(p, t, r)));
        return out;
      }),
    );
}

/** A slice's colour: its dot's (dim before it runs), or with `text` its step label's (muted, so it stays readable). */
const sliceColor = (t, status, text = false) =>
  status === 'completed' ? t.accent : status === 'failed' ? t.blocked : status === 'running' || status === 'waiting' ? t.working : text ? t.muted : t.dim;

/** One sub-row per slice: its number and title, the step its run is at and its PR; clicking a started slice selects
 *  its run (on All when the Active tab hides it). A slice not started yet is not clickable. */
function sliceList(p, t, slices) {
  return v_flex()
    .flex_none()
    .mb(6)
    .gap(1)
    .children(
      slices.map((s) => {
        const listed = (p.runs ?? []).some((x) => x.id === s.id);
        const row = h_flex()
          .id(`slice-${s.index}`)
          .min_w(0)
          .py(2)
          .gap(6)
          .items_center()
          .text_size(11)
          .child(div().flex_none().size(8).rounded(4).bg(sliceColor(t, s.status)))
          .child(div().flex_none().text_color(t.muted).child(`${s.index}.`))
          .child(div().min_w(0).truncate().text_color(t.foreground).child(s.title))
          .child(div().flex_none().text_color(sliceColor(t, s.status, true)).child(s.stepLabel))
          .child(div().flex_1())
          .when(Boolean(s.prUrl), (el) => el.child(link(t, `slice-pr-${s.index}`, 'PR ↗', (_e, cx) => cx.open_url(s.prUrl))));
        if (!listed) return row;
        return own(
          row
            .cursor_pointer()
            .tooltip(s.id)
            .hover((st) => st.bg(t.raised))
            .on_click((_e, cx) => {
              if (!p.rows().some((x) => x.id === s.id)) p.filter = 'all';
              p.select(s.id, cx);
              cx.notify();
            }),
        );
      }),
    );
}

/** The strip under a picked stop: what it is and its outputs, the picked one (else the first) read under them; with
 *  `fill` (the right column of two) the reader takes the height left. */
export function stopStrip(p, t, r, fill = false) {
  const st = (r.steps ?? []).find((s) => s.id === p.stopSel);
  if (!st) return div();
  const kv = (k, v) => h_flex().gap(4).child(div().text_color(t.muted).child(k)).child(div().text_color(t.foreground).child(v));
  const rv = roundView(r, st.id, p.roundSel); // null for a step that has not run: its own values show
  const shown = rv?.attempt ?? st;
  const spent = took(shown, Date.now());
  const step = (glyph, to, id) =>
    to === null
      ? div().flex_none().px(4).text_color(t.dim).child(glyph)
      : link(t, id, glyph, (_e, cx) => {
          p.pickRound(to, cx);
          cx.notify();
        });
  const outputs = Object.entries(shown.outputs ?? {});
  const grow = fill && Boolean(p.file);
  return v_flex()
    .when(grow, (el) => el.flex_1().min_h(0))
    .when(!grow, (el) => el.flex_none())
    .mt(2)
    .mb(8)
    .px(9)
    .py(7)
    .gap(5)
    .rounded(7)
    .bg(t.background)
    .border(1)
    .border_color(t.border)
    .text_size(11)
    .child(
      h_flex()
        .flex_none()
        .gap(8)
        .items_center()
        .child(div().min_w(0).truncate().font_semibold().child(st.id))
        .child(div().flex_1())
        .when(rv !== null && rv.of > 1, (el) =>
          el
            .child(step('‹', rv.prev, 'round-prev'))
            .child(div().flex_none().text_color(t.muted).child(`Round ${rv.n} of ${rv.of}${rv.mark ? ` · ${rv.mark}` : ''}`))
            .child(step('›', rv.next, 'round-next')),
        ),
    )
    .child(
      h_flex()
        .flex_none()
        .flex_wrap()
        .gap_x(10)
        .gap_y(2)
        .child(kv('Kind', st.kind))
        .child(kv('Stage', st.stage))
        .child(kv('Status', shown.status))
        .child(kv('Attempts', String(st.attempts ?? 0)))
        .when(Boolean(spent), (el) => el.child(kv('Took', spent))),
    )
    .when(outputs.length > 0, (el) =>
      el.child(
        h_flex()
          .flex_none()
          .flex_wrap()
          .gap(6)
          .children(
            outputs.map(([k, path]) =>
              link(t, `out-${k}`, `${k}.md`, (_e, cx) => {
                p.pickOutput(path, cx);
                cx.notify();
              }).when(p.file === p.resolve(path), (el) => el.text_color(t.accent)),
            ),
          ),
      ),
    )
    .when(Boolean(p.file), (el) => el.child(inlineReader(p, t, p.file, 'strip-reader', grow)));
}
