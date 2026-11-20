import { execFile } from 'node:child_process';

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (file: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => Promise<ExecResult>;

/** Run `file` with an argv array (never a shell). A non-zero exit resolves with its code. */
export const nodeExec: Exec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        ...(opts?.cwd === undefined ? {} : { cwd: opts.cwd }),
        ...(opts?.env === undefined ? {} : { env: { ...process.env, ...opts.env } }),
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') return reject(new Error(`${file} not found on PATH`));
        if (typeof e.code === 'number') return resolve({ code: e.code, stdout, stderr });
        reject(err);
      },
    );
  });
