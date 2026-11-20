import type { Exec, ExecResult } from '../../src/util/exec.ts';

/** Records every exec call and serves scripted results; unmatched calls succeed with `{}`. */
export class ExecRecorder {
  calls: { file: string; args: string[]; opts?: Parameters<Exec>[2] }[] = [];
  private responses: { match: (args: string[]) => boolean; result: ExecResult }[] = [];

  respond(match: (args: string[]) => boolean, result: Partial<ExecResult>): void {
    this.responses.push({ match, result: { code: 0, stdout: '', stderr: '', ...result } });
  }

  exec: Exec = async (file, args, opts) => {
    this.calls.push({ file, args, ...(opts === undefined ? {} : { opts }) });
    const hit = this.responses.find((r) => r.match(args));
    return hit ? hit.result : { code: 0, stdout: '{}', stderr: '' };
  };
}
