// The selected run's header, its train (six zones of stops, one marker, loop arcs) and the stop strip.

import { div, svg } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { STAGES, ago, driverToggle, loopAtCap, loopLabel, shownLoops, ticketTitle, took, trainLayout, xOf } from './model.js';
import { stepColor, link, own } from './ui.js';

const TOP = 40; // room above the rail for loop arcs
const RAIL = 14; // the rail's y inside a stop row
const MARK = 28; // the train marker
const short = (id) => id.split('-').pop();

export function header(p, t, r, narrow) {
  if (r.status === 'unreadable') {
    return v_flex()
      .px(16)
      .pt(14)
      .gap(5)
      .child(div().text_size(15).font_semibold().child(r.id))
      .child(div().text_size(11).text_color(t.dim).child('This run could not be read.'));
  }
  const drv = driverToggle(r);
  const now = Date.now();
  return v_flex()
    .px(16)
    .pt(14)
    .gap(5)
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .child(div().flex_none().text_size(15).font_semibold().child(`#${r.ticket.number}`))
        .child(div().min_w(0).text_size(15).truncate().child(ticketTitle(r))),
    )
    .child(
      h_flex()
        .gap(6)
        .items_center()
        .when(Boolean(r.ticket.url), (el) => el.child(link(t, 'issue', 'issue ↗', (_e, cx) => cx.open_url(r.ticket.url))))
        .when(Boolean(r.pr?.url), (el) => el.child(link(t, 'pr', 'PR ↗', (_e, cx) => cx.open_url(r.pr.url))))
        .when(Boolean(drv), (el) => el.child(link(t, 'driver', drv.label, (_e, cx) => p.toggleDriver(cx))))
        .child(
          div()
            .min_w(0)
            .truncate()
            .text_size(11)
            .text_color(t.dim)
            .child(
              narrow
                ? `started ${ago(r.createdAt, now)} ago · ${short(r.id)}`
                : `${r.branch ?? ''} · started ${ago(r.createdAt, now)} ago · ${short(r.id)}`,
            ),
        ),
    );
}

function stop(p, t, r, st, left, right, folded) {
  const core = st.role === 'core';
  const picked = st.id === p.stopSel;
  const here = st.id === r.currentStep || folded.some((f) => f.id === r.currentStep);
  const size = core ? 18 : 10;
  const ran = st.status !== 'pending';
  const c = stepColor(t, st.status);
  const gate = st.kind === 'gate';
  const rail = (side, on) =>
    div()
      .absolute()
      .top(RAIL - 1)
      .h(3)
      .w('50%')
      .when(side === 'l', (el) => el.left(0))
      .when(side === 'r', (el) => el.right(0))
      .bg(on ? t.done : t.border);
  const dot = div()
    .size(size)
    .rounded(gate ? 2 : size / 2)
    .border(core ? 3 : 2)
    .border_color(here ? t.surface : ran ? c : t.input)
    .bg(here ? t.surface : ran ? c : t.surface);
  const label = core ? (folded.length ? `+${folded.length}` : took(st, Date.now())) : st.id;
  const tip = folded.length
    ? `${st.id} · ${st.kind} · ${st.status} · also ${folded.map((f) => f.id).join(', ')}`
    : `${st.id} · ${st.kind} · ${st.status}`;
  return own(
    v_flex()
      .id(`stop-${st.id}`)
      .flex_1()
      .min_w(0)
      .items_center()
      .cursor_pointer()
      .relative()
      .when(left !== null, (el) => el.child(rail('l', left)))
      .when(right !== null, (el) => el.child(rail('r', right)))
      .tooltip(tip)
      .on_click((_e, cx) => {
        p.pickStop(picked ? null : st.id, cx);
        cx.notify();
      })
      .child(
        div()
          .h(RAIL * 2)
          .flex()
          .items_center()
          .child(
            div()
              .p(2)
              .rounded(gate ? 4 : 16)
              .border(1)
              .border_color(picked ? t.accent : t.surface)
              .child(dot),
          ),
      )
      .child(
        div()
          .h(14)
          .max_w_full()
          .truncate()
          .text_size(10)
          .text_color(picked ? t.accent : core ? t.dim : t.muted)
          .child(label || ' '),
      ),
  );
}

export function train(p, t, r, narrow) {
  if (r.status === 'unreadable') return div();
  const zones = trainLayout(r, narrow);
  const flat = zones.flatMap((z) => z.shown);
  if (flat.length === 0) return div();
  const reached = (s) => Boolean(s) && s.status !== 'pending';
  const tone = r.attention ? t.blocked : r.status === 'completed' ? t.done : t.working;
  const zoneEls = zones.map((z, i) => {
    const all = [...z.shown, ...z.hidden];
    const cur = all.some((st) => st.id === r.currentStep);
    const name = narrow ? STAGES[i].slice(0, 4).toUpperCase() : STAGES[i].toUpperCase();
    return v_flex()
      .flex_1()
      .min_w(0)
      .child(
        h_flex().children(
          z.shown.map((st) => {
            const k = flat.indexOf(st);
            const left = k === 0 ? null : reached(st);
            const right = k === flat.length - 1 ? null : reached(flat[k + 1]);
            return stop(p, t, r, st, left, right, z.hidden);
          }),
        ),
      )
      .child(
        div()
          .pt(2)
          .text_center()
          .truncate()
          .text_size(10)
          .font_semibold()
          .text_color(cur ? tone : all.some(reached) ? t.muted : t.dim)
          .child(name),
      );
  });

  const over = [];
  for (const l of shownLoops(r)) {
    const a = xOf(zones, l.to);
    const b = xOf(zones, l.from);
    if (a === null || b === null || b <= a) continue;
    const c = loopAtCap(l) ? t.blocked : t.working;
    over.push(
      div()
        .absolute()
        .top(20)
        .left(`${a}%`)
        .w(`${b - a}%`)
        .h(TOP - 20 + 2)
        .border_t(2)
        .border_l(2)
        .border_r(2)
        .rounded_t(12)
        .border_color(c),
      // the label sits above the arc, centred on it, and may be wider than it
      h_flex()
        .absolute()
        .top(2)
        .left(`${a}%`)
        .w(`${b - a}%`)
        .h(14)
        .justify_center()
        .child(div().flex_none().whitespace_nowrap().text_size(10).text_color(c).child(loopLabel(l, narrow))),
    );
  }

  const at = r.currentStep ?? flat[flat.length - 1].id;
  const x = xOf(zones, at);
  const st = (r.steps ?? []).find((s) => s.id === at);
  const gate = st?.kind === 'gate';
  const moving = (r.status === 'running' || r.status === 'waiting') && r.driver?.alive === true;
  if (x !== null) {
    over.push(
      div()
        .id(`train-${r.id}`)
        .absolute()
        .top(TOP + RAIL - MARK / 2)
        .left(`${x}%`)
        .w(0)
        .h(MARK)
        .transition('left', { duration: 700, easing: 'ease-in-out' })
        .child(
          div()
            .absolute()
            .top(0)
            .left(-MARK / 2)
            .size(MARK)
            .rounded(gate ? 7 : MARK / 2)
            .border(2)
            .border_color(tone)
            .bg(t.surface)
            .flex()
            .items_center()
            .justify_center()
            .child(svg('mods/percolator/train.svg').size(15).text_color(tone))
            .when(moving, (el) => el.loop('opacity', { from: 0.6, to: 1, period: 1300 })),
        ),
    );
  }
  return div().relative().mx(16).mt(6).pt(TOP).child(h_flex().children(zoneEls)).children(over);
}

/** The strip under the train for a clicked stop: what it is and its outputs (they open in the reader). */
export function stopStrip(p, t, r) {
  const st = (r.steps ?? []).find((s) => s.id === p.stopSel);
  if (!st) return div();
  const kv = (k, v) => h_flex().gap(4).child(div().text_color(t.dim).child(k)).child(div().text_color(t.foreground).child(v));
  const spent = took(st, Date.now());
  return h_flex()
    .flex_wrap()
    .mx(16)
    .mt(8)
    .px(10)
    .py(6)
    .gap(10)
    .items_center()
    .rounded(6)
    .bg(t.raised)
    .text_size(11.5)
    .child(div().font_semibold().child(st.id))
    .child(kv('kind', st.kind))
    .child(kv('stage', st.stage))
    .child(kv('status', st.status))
    .child(kv('attempts', String(st.attempts ?? 0)))
    .when(Boolean(spent), (el) => el.child(kv('took', spent)))
    .child(div().flex_1())
    .children(
      Object.entries(st.outputs ?? {}).map(([k, path]) =>
        link(t, `out-${k}`, `${k}.md`, (_e, cx) => {
          p.pickOutput(path, cx);
          cx.notify();
        }).when(p.file === p.resolve(path), (el) => el.text_color(t.accent)),
      ),
    );
}
