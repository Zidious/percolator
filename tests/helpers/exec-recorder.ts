import type { Exec, ExecResult } from '../../src/util/exec.ts';

/** Records every exec call and serves scripted results; unmatched calls succeed with `{}`. */
export class ExecRecorder {
  calls: { file: string; args: string[] }[] = [];
  private responses: { match: (args: string[]) => boolean; result: ExecResult }[] = [];

  respond(match: (args: string[]) => boolean, result: Partial<ExecResult>): void {
    this.responses.push({ match, result: { code: 0, stdout: '', stderr: '', ...result } });
  }

  exec: Exec = async (file, args) => {
    this.calls.push({ file, args });
    const hit = this.responses.find((r) => r.match(args));
    return hit ? hit.result : { code: 0, stdout: '{}', stderr: '' };
  };
}
