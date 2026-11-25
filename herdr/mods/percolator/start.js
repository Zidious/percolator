// The start picker: "+ New run" (any pipeline of a repo) and "▸ Run next…" (a finished run's ticket, the pipelines that
// take one). The repo comes first (the open spaces' repos, then earlier runs'), then the pipeline, then the fields it
// asks for and the exact `perc run` line; its preview (the pipeline spine over previewRun) sits below the picker, or to
// its right from 720px (previewSide).

import { div } from 'gpui-kit';
import { Input, h_flex, v_flex } from 'gpui-base';
import { commandLine, pipelineOption, previewRun, previewSide, runLabel, sameRepo, startFields } from './model.js';
import { pipeline } from './pipeline.js';
import { button, link, own } from './ui.js';

const label = (t, text, note) =>
  h_flex()
    .flex_none()
    .gap(6)
    .pt(6)
    .text_size(11)
    .text_color(t.muted)
    .child(div().flex_none().child(text))
    .when(Boolean(note), (el) => el.child(div().min_w(0).truncate().italic().child(note)));

const tag = (t, text) => div().flex_none().px(5).rounded(4).bg(t.raised).text_size(10).text_color(t.muted).child(text);

/** A radio-like row: a dot, a title line (truncating) and an optional line under it. */
function choice(t, id, on, title, under, onClick, { error = false, tags = [] } = {}) {
  const row = div()
    .id(id)
    .flex()
    .gap(8)
    .px(8)
    .py(4)
    .rounded(6)
    .border(1)
    .border_color(on ? t.accent : t.surface)
    .when(on, (el) => el.bg(t.background))
    .child(
      div()
        .flex_none()
        .mt(3)
        .size(10)
        .rounded(5)
        .border(2)
        .border_color(on ? t.accent : error ? t.border : t.dim)
        .when(on, (el) => el.bg(t.accent)),
    )
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .child(
          h_flex()
            .min_w(0)
            .gap(6)
            .items_center()
            .child(div().min_w(0).truncate().text_size(12).font_semibold().text_color(error ? t.dim : t.foreground).child(title))
            .children(tags.map((x) => tag(t, x))),
        )
        .when(Boolean(under), (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(error ? t.blocked : t.muted).child(under))),
    );
  if (error) return row.cursor_not_allowed();
  return own(row.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick));
}

/** A one-line text field over retained InputState (made when the pipelines arrive; never in render). */
const field = (t, state) =>
  state === null ? div() : own(
    div()
      .w_full()
      .px(8)
      .py(4)
      .rounded(6)
      .border(1)
      .border_color(t.border)
      .bg(t.surface)
      .text_size(12)
      .text_color(t.foreground)
      .child(Input.new(state).w_full()),
  );

function pipelinesPart(p, t, s, list) {
  const got = s.repo ? p.pipes[s.repo] : undefined;
  const why = !s.repo
    ? 'Choose a repo to list its pipelines'
    : got === undefined || got === 'loading'
      ? 'Loading pipelines…'
      : !got.ok
        ? got.error
        : list.length === 0
          ? 'No pipeline here takes a ticket'
          : null;
  const part = v_flex().flex_none().gap(2).child(label(t, 'Pipeline'));
  if (why) return part.child(div().text_size(11.5).text_color(got && got !== 'loading' && !got.ok ? t.blocked : t.muted).child(why));
  return part.children(
    list.map((pl) => {
      const o = pipelineOption(pl);
      return choice(t, `pipe-${o.name}`, o.name === s.pick, o.name, o.note, (_e, cx) => p.pickPipeline(o.name, cx), {
        error: o.error,
        tags: o.tags,
      });
    }),
  );
}

function fieldsPart(p, t, s, pl) {
  const f = startFields(pl);
  const hint = (text) => div().text_size(11).text_color(t.muted).child(text);
  let part = v_flex().flex_none().gap(2);
  if (f.ticket !== 'hidden') {
    part = part.child(label(t, 'Ticket', f.ticket === 'optional' ? 'optional' : ''));
    if (s.mode !== 'next') part = part.child(field(t, p.ticketInput)).child(hint('URL or owner/repo#n'));
    else if (s.tickets.length === 1) part = part.child(div().min_w(0).truncate().text_size(12).child(s.tickets[0])).child(hint('From this run'));
    else part = part.children(s.tickets.map((ref, i) => choice(t, `ticket-${i}`, ref === s.ticket, ref, '', (_e, cx) => p.pickTicket(ref, cx))));
  }
  for (const i of f.inputs) part = part.child(label(t, i.name, i.required ? '' : 'optional')).child(field(t, p.inputState(pl.name, i)));
  return part;
}

/** `repos`: startRepos's `{ repo, open }` items; the open spaces' repos carry an Open tag. */
function repoPart(p, t, s, repos) {
  const part = v_flex().flex_none().gap(2).child(label(t, 'Repo'));
  if (s.mode === 'next') return part.child(div().min_w(0).truncate().text_size(12).child(s.repo ?? ''));
  const all = s.repo && !repos.some((r) => sameRepo(r.repo, s.repo)) ? [{ repo: s.repo, open: false }, ...repos] : repos;
  return part
    .children(
      all.map((r, i) =>
        choice(t, `repo-${i}`, sameRepo(r.repo, s.repo), r.repo, '', (_e, cx) => p.pickRepo(r.repo, cx), { tags: r.open ? ['Open'] : [] }),
      ),
    )
    .child(h_flex().pt(2).child(link(t, 'repo-folder', 'Choose folder…', (_e, cx) => p.chooseFolder(cx))));
}

function foot(p, t, s, pl) {
  const choice = pl ? p.startChoice(pl) : null;
  const can = choice ? p.canStartNow(choice) : { ok: false, why: 'Pick a pipeline' };
  const line = choice && choice.repo ? commandLine(p.startArgvNow(choice)) : '';
  const busy = p.busy === 'start';
  const note = s.error ?? s.said ?? (can.ok ? 'Enter starts' : can.why);
  return v_flex()
    .flex_none()
    .gap(6)
    .pt(8)
    .when(Boolean(line), (el) => el.child(div().font_family('monospace').text_size(10.5).text_color(t.muted).child(line)))
    .child(
      h_flex()
        .flex_wrap()
        .gap(8)
        .items_center()
        .child(button(t, 'start-go', 'Start', 'ok', (_e, cx) => p.startRun(cx), { busy, disabled: !can.ok || Boolean(p.busy) }))
        .child(button(t, 'start-cancel', 'Cancel', '', (_e, cx) => p.closeStart(cx)))
        .child(div().min_w(0).text_size(11).text_color(s.error ? t.blocked : t.muted).child(note)),
    );
}

function preview(p, t, pl, fold, narrow) {
  const r = previewRun(pl);
  // the spine reads the view's stop and unfolded stages: the preview has neither
  const view = { stopSel: null, unfolded: [], activeSlot: null, openAgent() {}, pickStop() {} };
  return v_flex()
    .flex_none()
    .child(
      h_flex()
        .gap(8)
        .text_size(11)
        .text_color(t.muted)
        .child(div().min_w(0).truncate().child(`Pipeline: ${pl.name}`))
        .child(div().flex_1())
        .child(div().flex_none().child(`${pl.steps.length} steps`)),
    )
    .child(div().ml(-16).child(pipeline(view, t, r, fold, narrow, false)));
}

/** The picker, filling the area under the title bar while it is open (p.start). */
export function startDialog(p, t, { narrow, fold }, width, repos) {
  const s = p.start;
  const list = p.startList();
  const pl = p.startPipeline();
  const side = previewSide(width);
  const run = s.mode === 'next' ? p.runs.find((r) => r.id === s.run) : null;
  const title = run ? `Run next on ${runLabel(run)}` : 'Start a run';
  const form = v_flex()
    .flex_1()
    .min_w(0)
    .gap(2)
    .child(repoPart(p, t, s, repos))
    .child(pipelinesPart(p, t, s, list))
    .when(Boolean(pl), (el) => el.child(fieldsPart(p, t, s, pl)))
    .child(foot(p, t, s, pl));
  const body =
    side === 'right'
      ? h_flex()
          .items_start()
          .gap(16)
          .child(form)
          .when(Boolean(pl), (el) => el.child(v_flex().w(300).flex_none().pl(16).border_l(1).border_color(t.border).child(preview(p, t, pl, fold, narrow))))
      : v_flex()
          .gap(10)
          .child(form)
          .when(Boolean(pl), (el) => el.child(div().pt(10).border_t(1).border_color(t.border).child(preview(p, t, pl, fold, narrow))));
  return v_flex()
    .m(10)
    .p(12)
    .gap(4)
    .rounded(8)
    .bg(t.raised)
    .border(1)
    .border_color(t.border)
    .child(div().flex_none().text_size(13.5).font_semibold().child(title))
    .child(body);
}
