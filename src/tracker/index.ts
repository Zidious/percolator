/** Names of the builtin nodes Percolator handles itself; the single source for validation and drive. */
export const BUILTIN_NAMES = [
  'github.intake',
  'github.open_pr',
  'github.comment',
  'github.open_issues',
  'percolator.report',
  'github.release',
  'github.pr_review',
  'github.private_fork_pr',
  'percolator.route_rules',
  'percolator.route',
  'percolator.fan_out',
  'percolator.seed',
] as const;
export type BuiltinName = (typeof BUILTIN_NAMES)[number];

/** How a pipeline ends: each exit kind is run by one builtin on the pipeline's last stage. */
export const EXIT_KINDS = ['pr', 'comment', 'issue', 'none', 'release', 'pr_review', 'private_fork_pr'] as const;
export type ExitKind = (typeof EXIT_KINDS)[number];

export type Exit = {
  /** the builtin that runs the exit stage */
  builtin: BuiltinName;
  /** what Percolator does there, for errors: "Percolator <verb> itself" */
  verb: string;
  /** the output key the exit writes, part of the exit stage's contract (none: it may write nothing) */
  output?: string;
  /** what the pipeline must declare for this exit; checked at validate */
  needs?: { ticket?: true; input?: string };
};

export const EXITS: Readonly<Record<ExitKind, Exit>> = Object.freeze({
  pr: { builtin: 'github.open_pr', verb: 'opens the PR', output: 'pr_url' },
  comment: { builtin: 'github.comment', verb: 'posts the comment', output: 'comment_url', needs: { ticket: true } },
  issue: { builtin: 'github.open_issues', verb: 'opens the issues' },
  none: { builtin: 'percolator.report', verb: 'ends the run' },
  release: { builtin: 'github.release', verb: 'tags the release', output: 'release_url' },
  pr_review: { builtin: 'github.pr_review', verb: 'posts the review', output: 'review_url', needs: { input: 'pr' } },
  private_fork_pr: { builtin: 'github.private_fork_pr', verb: 'opens the PR', output: 'pr_url', needs: { input: 'advisory' } },
});
