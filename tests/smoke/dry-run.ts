// Manual dry run of the whole stack (perc, the real hc, Herdr and its panel) with a scripted agent instead of a model:
// no tokens spent, deterministic outcomes. Not part of `pnpm test`.
//   node tests/smoke/dry-run.ts [--out <dir>] [--ticket <n>]
// Writes <dir>/config.yaml (default: a fresh temp dir) whose pipelines bind every agent to tests/smoke/fake-agent.ts,
// then prints the commands that start each scenario from this checkout. Each pipeline brings a run to one state the
// panel draws, or exercises one config option. Ticket scenarios (--ticket, default 1) comment on that issue; nothing
// opens a PR, an issue or a release.
//
//   dry-feature   groom asks two questions → approve-plan gate (ticketless; reject at approve-plan → back to groom with the feedback) → review fails every round → FINDINGS at cap 2
//   dry-loop      a test script fails every round → on_fail back to implement → PAUSED at its cap 2 (Grant a round)
//   dry-once      review fails in round 1 only → completes (exit none)
//   dry-list      review writes its findings as a numbered list (as real reviews do) → FINDINGS at once (cap 1)
//   dry-slots     two review slots both fail → FINDINGS listing both steps' findings (cap 1)
//   dry-nofind    review fails without findings → FINDINGS with nothing to tick
//   dry-escalate  implement escalates with a reason → PAUSED
//   dry-timeout   implement hangs, timeout_s 10 → PAUSED (timed out)
//   dry-contract  implement passes without summary.md → contract error
//   dry-crash     implement exits 3 without done.json → PAUSED (agent exited)
//   dry-fail      a script hook with no on_fail fails → FAILED (lint failed (exit code 1)); also before: all and after hooks
//   dry-slow      implement takes FAKE_AGENT_SLOW_S (90) → the running agent card; kill its driver → STALLED
//   dry-inputs    ticket: optional, a required and an optional input, rendered into the prompt
//   dry-issue     exit issue behind an approve-issue gate with when_output: no drafts → gate passes, nothing opened
//   dry-fanout    plan writes two slices → fan-out of implement, one slice at a time, each slice its own run
//   dry-cron      a schedule trigger every minute: perc watch --config … starts it
//   dry-ticket    on a ticket: a gate (posts its comment on the issue) → review fails once → exit comment
//   dry-triage    router on a ticket: no label rule matches → choose agent unsure → pick-pipeline gate → child run
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { out: { type: 'string' }, ticket: { type: 'string' } } });
const out = values.out !== undefined ? path.resolve(values.out) : await fs.mkdtemp(path.join(os.tmpdir(), 'perc-dry-'));
const ticket = values.ticket ?? '1';
await fs.mkdir(out, { recursive: true });
const fake = fileURLToPath(new URL('./fake-agent.ts', import.meta.url));
const argv = (behaviour: string) => `[${JSON.stringify(process.execPath)}, ${JSON.stringify(fake)}, ${JSON.stringify(behaviour)}]`;
const agent = (behaviour: string, extra = '') => `{ agent: command, command: ${argv(behaviour)}${extra === '' ? '' : `, ${extra}`} }`;
const script = (code: string) => `[${JSON.stringify(process.execPath)}, -e, ${JSON.stringify(code)}]`;
const ticketless = (description: string, stages: string, exit = 'none') =>
  `description: ${JSON.stringify(description)}\n        ticket: none\n        stages: [${stages}]\n        exit: ${exit}`;

const config = `# Dry-run config written by tests/smoke/dry-run.ts: every agent is tests/smoke/fake-agent.ts.
version: 1
profiles:
  dry:
    match: { remote: "github.com/*/*" }
    bindings:
      intake: { builtin: github.intake }
      groom: ${agent('ask')}
      plan: ${agent('pass')}
      implement: ${agent('pass')}
      review: ${agent('findings')}
      deliver: { builtin: github.open_pr }
    pipelines:
      dry-feature:
        default: true
        ${ticketless('questions, a gate, findings at the cap', 'intake, groom, plan, implement, review, deliver')}
        bindings:
          groom: ${agent('ask')}
          plan: ${agent('pass')}
          implement: ${agent('pass')}
          review: ${agent('findings', 'max_rounds: 2')}
        nodes:
          approve-plan: { kind: gate, after: groom }
      dry-loop:
        ${ticketless('a failing test node at its back-edge cap', 'intake, implement, deliver')}
        bindings:
          implement: ${agent('pass')}
        nodes:
          test:
            command: ${script('process.exit(1)')}
            after: implement
            on_fail: { back_to: implement, max_rounds: 2 }
      dry-once:
        ${ticketless('review fails once, then passes', 'intake, implement, review, deliver')}
        bindings:
          implement: ${agent('pass')}
          review: ${agent('findings-once')}
      dry-list:
        ${ticketless('review writes its findings as a numbered list', 'intake, implement, review, deliver')}
        bindings:
          implement: ${agent('pass')}
          review: ${agent('findings-list', 'max_rounds: 1')}
      dry-slots:
        ${ticketless('two review slots, both failing', 'intake, implement, review, deliver')}
        bindings:
          implement: ${agent('pass')}
          review:
            - ${agent('findings', 'max_rounds: 1')}
            - ${agent('findings-list', 'max_rounds: 1')}
      dry-nofind:
        ${ticketless('review fails without findings', 'intake, implement, review, deliver')}
        bindings:
          implement: ${agent('pass')}
          review: ${agent('findings-none', 'max_rounds: 1')}
      dry-escalate:
        ${ticketless('implement escalates with a reason', 'intake, implement, deliver')}
        bindings:
          implement: ${agent('escalate')}
      dry-timeout:
        ${ticketless('implement hangs past its timeout', 'intake, implement, deliver')}
        bindings:
          implement: ${agent('hang', 'timeout_s: 10')}
      dry-contract:
        ${ticketless('implement leaves out its required output', 'intake, implement, deliver')}
        bindings:
          implement: ${agent('missing')}
      dry-crash:
        ${ticketless('implement exits without done.json', 'intake, implement, deliver')}
        bindings:
          implement: ${agent('crash')}
      dry-fail:
        ${ticketless('a hook fails with no loop; before: all and after hooks', 'intake, implement, deliver')}
        bindings:
          implement: ${agent('pass')}
        nodes:
          announce: { command: ${script("console.log('before every stage')")}, before: all }
          lint: { command: ${script('process.exit(1)')}, after: implement }
      dry-slow:
        ${ticketless('a long-running agent (kill its driver to stall it)', 'intake, implement, deliver')}
        bindings:
          implement: ${agent('slow')}
      dry-inputs:
        description: ticket optional, inputs into the prompt
        ticket: optional
        stages: [intake, implement, deliver]
        exit: none
        inputs:
          area: { required: true, description: the area to work on }
          note: { description: an optional note }
        bindings:
          implement: ${agent('pass', 'prompt: "Work on {{input_area}}. Note: {{input_note}}."')}
      dry-issue:
        ${ticketless('exit issue behind a when_output gate, with no drafts', 'intake, diagnose, open', 'issue')}
        bindings:
          diagnose: ${agent('pass')}
        nodes:
          approve-issue:
            kind: gate
            before: open
            when_output: issues
            on_fail: { back_to: diagnose, max_rounds: 3 }
      dry-fanout:
        ${ticketless('plan splits into two slices, built one at a time', 'intake, plan, implement, review, deliver')}
        fan_out:
          stage: implement
          slices: { from: plan, output: slices }
          max_parallel: 1
        bindings:
          plan: ${agent('slices')}
          implement: ${agent('pass')}
          review: ${agent('findings-once')}
      dry-cron:
        ${ticketless('started by perc watch every minute', 'intake, implement, deliver')}
        bindings:
          implement: ${agent('pass')}
        triggers:
          - { schedule: "* * * * *" }
      dry-ticket:
        description: a ticket run with a gate that comments on the issue
        ticket: required
        stages: [intake, implement, review, deliver]
        exit: comment
        outputs: { implement: [summary, comment] }
        bindings:
          implement: ${agent('comment')}
          review: ${agent('findings-once')}
        nodes:
          approve-change: { kind: gate, after: implement, on_fail: { back_to: implement, max_rounds: 2 } }
      dry-triage:
        description: a router whose agent is unsure
        router: true
        ticket: required
        stages: [intake, route]
        routes:
          - { label: never-on-this-issue, to: dry-ticket }
        choose:
          agent: command
          command: ${argv('pick:dry-ticket')}
          from: [dry-ticket, feature]
          confirm: always
        fallback: dry-ticket
`;
const file = path.join(out, 'config.yaml');
await fs.writeFile(file, config);
const perc = `node ${fileURLToPath(new URL('../../src/cli.ts', import.meta.url))}`;
console.log(`wrote ${file}\n`);
console.log(`${perc} validate --config ${file}`);
for (const p of ['dry-feature', 'dry-loop', 'dry-once', 'dry-list', 'dry-slots', 'dry-nofind', 'dry-escalate', 'dry-timeout', 'dry-contract', 'dry-crash', 'dry-fail', 'dry-slow', 'dry-issue', 'dry-fanout']) {
  console.log(`${perc} run --pipeline ${p} --config ${file}`);
}
console.log(`${perc} run --pipeline dry-inputs --input area=parser --input "note=keep it small" --config ${file}`);
console.log(`${perc} run ${ticket} --pipeline dry-ticket --config ${file}`);
console.log(`${perc} run ${ticket} --pipeline dry-triage --config ${file}`);
console.log(`${perc} watch --config ${file} --interval 15     # starts dry-cron each minute; perc watch stop`);
