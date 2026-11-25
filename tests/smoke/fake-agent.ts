// A scripted stand-in for a coding agent, for dry runs through the real perc + hc + Herdr (tests/smoke/dry-run.ts).
// Bound as `agent: command` with `command: [node, <this file>, <behaviour>]`; perc appends its message
// ("Your task is in <task.md>. …"), and this reads the task like an agent would: its round, outputs dir and done file.
//
// Behaviours (round = the task's "round r/max"):
//   pass            write each required output, status pass
//   ask             no answers input yet: escalate with two questions; with answers: pass
//   findings        status fail with three "## " findings every round (a review that never passes)
//   findings-list   like findings, written as a numbered list (as real reviews often are), not ## sections
//   findings-once   fail with findings in round 1, pass after
//   findings-none   status fail without writing findings
//   fail            status fail with no findings file (a test node's back-edge)
//   comment         write comment.md (for exit: comment), status pass
//   escalate        status escalate with a reason (no questions)
//   missing         status pass without the required outputs (a contract error)
//   crash           exit 3 without a done.json
//   hang            never finish (pair with timeout_s)
//   slow            sleep FAKE_AGENT_SLOW_S (default 90) first, then pass: the panel's running agent card
//   slices          write slices.md with two "## " slices (fan_out.slices.from), then pass
//   pick:<name>     write pick.md picking pipeline <name>, unsure (a router's choose agent: the pick-pipeline gate)
// Each sleeps FAKE_AGENT_DELAY_S (default 3) first so the panel shows the step running.
import fs from 'node:fs';
import path from 'node:path';

const [behaviour = 'pass', message = ''] = process.argv.slice(2);
const taskFile = /Your task is in (.+?)\. Read it/.exec(message)?.[1];
if (taskFile === undefined) {
  console.error(`fake-agent: no task file in the message: ${message}`);
  process.exit(2);
}
const task = fs.readFileSync(taskFile, 'utf8');
const pick = (re: RegExp, what: string): RegExpExecArray => {
  const m = re.exec(task);
  if (!m) {
    console.error(`fake-agent: no ${what} in ${taskFile}`);
    process.exit(2);
  }
  return m;
};
const [header, step, stage, round] = pick(/^# Percolator task: (\S+) \((\S+), round (\d+)\/(\d+)\)/m, 'header');
const outputsDir = pick(/Write each output as a Markdown file in (.+), named <key>\.md\./, 'outputs dir')[1]!;
const doneFile = pick(/Write (.+?) last, as one JSON object/, 'done file')[1]!;
const required = (/^Required: (.+)$/m.exec(task)?.[1] ?? '').split(', ').filter(Boolean).map((f) => f.replace(/\.md$/, ''));
const hasAnswers = /^- answers \(from /m.test(task);
const r = Number(round);
const sleep = (s: number) => new Promise((res) => setTimeout(res, s * 1000));

await sleep(Number(process.env['FAKE_AGENT_DELAY_S'] ?? 3));
console.log(`fake-agent ${behaviour}: ${header} answers=${hasAnswers}`);

fs.mkdirSync(outputsDir, { recursive: true });
const write = (key: string, text: string) => fs.writeFileSync(path.join(outputsDir, `${key}.md`), text);
const writeRequired = () => {
  for (const k of required) if (k !== 'findings') write(k, `# ${k}\n\nWritten by fake-agent for ${step} (${stage}), round ${r}.\n`);
};
const done = (o: object) => fs.writeFileSync(doneFile, JSON.stringify(o));
const sections = () =>
  write(
    'findings',
    `# Review findings, round ${r}\n\n` +
      `## Missing test for the empty input\n\nsrc/thing.ts: \`parse('')\` throws; add a test and return [] instead.\n\n` +
      `## Unclear name \`doIt\`\n\nsrc/thing.ts:12: rename \`doIt\` to \`parseTickets\`, which says what it does.\n\n` +
      `## Scope creep in README\n\nREADME.md: the new "Roadmap" section is unrelated to this ticket; drop it.\n`,
  );
const list = () =>
  write(
    'findings',
    '1. **Answers lost on a contract error** (`src/engine/engine.ts:75`).\n   The re-run no longer lists answers.\n   Change: keep them until the step passes.\n\n' +
      '2. **Enter in an answer field starts a run** (`herdr/mods/percolator/main.js:445`).\n   Change: give answer fields their own submit.\n\n' +
      '3. **The summary says "answered 1 questions"**.\n   Change: use the singular.\n',
  );

switch (behaviour) {
  case 'pass':
    writeRequired();
    done({ status: 'pass' });
    break;
  case 'ask':
    if (!hasAnswers) {
      done({ status: 'escalate', questions: ['Should empty tickets be skipped or rejected?', 'Which branch should the PR target?\n\nmain is protected; release/* is not.'] });
    } else {
      writeRequired();
      done({ status: 'pass' });
    }
    break;
  case 'findings':
    writeRequired();
    sections();
    done({ status: 'fail' });
    break;
  case 'findings-list':
    writeRequired();
    list();
    done({ status: 'fail' });
    break;
  case 'findings-once':
    writeRequired();
    if (r === 1) {
      sections();
      done({ status: 'fail' });
    } else {
      write('findings', 'No findings.\n');
      done({ status: 'pass' });
    }
    break;
  case 'findings-none':
    writeRequired();
    done({ status: 'fail' });
    break;
  case 'fail':
    writeRequired();
    done({ status: 'fail', reason: `tests failed in round ${r}` });
    break;
  case 'comment':
    writeRequired();
    write('comment', `Dry run of Percolator: ${step} wrote this comment (round ${r}).\n`);
    done({ status: 'pass' });
    break;
  case 'escalate':
    writeRequired();
    done({ status: 'escalate', reason: 'the staging database is down; restart it, then resume' });
    break;
  case 'missing':
    done({ status: 'pass' });
    break;
  case 'crash':
    console.error('fake-agent: crashing on purpose');
    process.exit(3);
  case 'hang':
    for (;;) await sleep(60);
  case 'slow':
    await sleep(Number(process.env['FAKE_AGENT_SLOW_S'] ?? 90));
    writeRequired();
    done({ status: 'pass' });
    break;
  case 'slices':
    writeRequired();
    write('slices', '# Slices\n\n## Parser\n\nParse tickets.\n\n## Renderer\n\nRender them.\n');
    done({ status: 'pass' });
    break;
  case behaviour.startsWith('pick:') ? behaviour : '': {
    const from = behaviour.slice('pick:'.length);
    writeRequired();
    write('pick', `pipeline: ${from}\nunsure: true\n\nThe ticket says little; ${from} looks closest, but check.\n`);
    done({ status: 'pass' });
    break;
  }
  default:
    console.error(`fake-agent: unknown behaviour "${behaviour}"`);
    process.exit(2);
}
