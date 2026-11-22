// Manual smoke test against the REAL `gh`. Not part of `pnpm test`.
//   node tests/smoke/gh.smoke.ts --issue <owner/repo#n | issue URL>
//     READ-ONLY: calls only `issue()` (no comments, no PRs) and prints the parsed issue as JSON to verify the field shapes.
//   node tests/smoke/gh.smoke.ts --advisory <GHSA-xxxx-xxxx-xxxx> --repo <owner/repo>
//     WRITES: calls `advisoryFork()`, which asks GitHub to create the advisory's temporary private fork
//     (or returns the one it already has), and prints its full_name and clone_url. Needs admin or
//     security-manager rights on the repo and a draft advisory; the fork goes away with the advisory.
import { parseArgs } from 'node:util';
import { cliGh } from '../../src/tracker/gh.ts';
import { parseTicket } from '../../src/tracker/ticket.ts';

const { values } = parseArgs({ options: { issue: { type: 'string' }, advisory: { type: 'string' }, repo: { type: 'string' } } });
if (values.advisory !== undefined) {
  if (values.repo === undefined) {
    console.error('usage: node tests/smoke/gh.smoke.ts --advisory <GHSA-xxxx-xxxx-xxxx> --repo <owner/repo>');
    process.exit(2);
  }
  const fork = await cliGh().advisoryFork(values.repo, values.advisory);
  console.log(JSON.stringify({ repo: values.repo, advisory: values.advisory, fork }, null, 2));
  console.log('gh smoke ok');
  process.exit(0);
}
if (values.issue === undefined) {
  console.error('usage: node tests/smoke/gh.smoke.ts --issue <owner/repo#n> | --advisory <GHSA> --repo <owner/repo>');
  process.exit(2);
}
const ref = parseTicket(values.issue);
const issue = await cliGh().issue(ref.repo, ref.number);
console.log(JSON.stringify({ ref, issue }, null, 2));
console.log('gh smoke ok');
