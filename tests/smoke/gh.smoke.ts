// Manual, READ-ONLY smoke test against the REAL `gh`. Not part of `pnpm test`.
//   node tests/smoke/gh.smoke.ts --issue <owner/repo#n | issue URL>
// Calls only `issue()` (no comments, no PRs) and prints the parsed issue as JSON to verify the field shapes.
import { parseArgs } from 'node:util';
import { cliGh } from '../../src/tracker/gh.ts';
import { parseTicket } from '../../src/tracker/ticket.ts';

const { values } = parseArgs({ options: { issue: { type: 'string' } } });
if (values.issue === undefined) {
  console.error('usage: node tests/smoke/gh.smoke.ts --issue <owner/repo#n>');
  process.exit(2);
}
const ref = parseTicket(values.issue);
const issue = await cliGh().issue(ref.repo, ref.number);
console.log(JSON.stringify({ ref, issue }, null, 2));
console.log('gh smoke ok');
