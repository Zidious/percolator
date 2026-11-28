import type { RunState } from '../engine/state.ts';
import { readWaiting } from '../tracker/gate-store.ts';
import type { RunMeta } from './meta.ts';
import { failedText } from './next-steps.ts';
import { prUrl } from './outputs.ts';
import type { DriverDeps } from './prepare.ts';
import { driverLiveness, readAttention } from './status.ts';

/** The first non-empty line of an asked item, without a leading heading or list marker, `**`, `__` or backticks. */
export const itemLine = (text: string): string =>
  (text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '')
    .replace(/^\s*#+\s*/, '')
    .replace(/^ {0,3}\d{1,9}[.)](?:[ \t]+|$)/, '')
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1')
    .replace(/(^|[\s(])__(?=\S)(.+?)(?<=\S)__(?=$|[\s,;:!?)]|\.(?:$|\s))/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .trim();

/** A question in full: its first line numbered, the rest indented under it (blank lines kept blank). */
export const questionLines = (n: number, text: string): string[] => {
  const prefix = `  ${n}. `;
  const [first = '', ...rest] = text.trim().split(/\r?\n/);
  return [`${prefix}${first}`, ...rest.map((l) => (l.trim() === '' ? '' : `${' '.repeat(prefix.length)}${l}`))];
};

/** What a run is doing or waiting for, in one line; an hc failure is reported, never thrown. */
export async function runDetail(dir: string, meta: RunMeta, state: RunState, deps: DriverDeps): Promise<string> {
  const waiting = await readWaiting(dir).catch(() => undefined);
  // a gate on a ticketless run posts nothing: it is answered only from here
  const answer = waiting?.commentUrl ?? `perc approve ${meta.runId} | perc reject ${meta.runId} <feedback>`;
  const waitingText = waiting && `waiting for approval: ${answer}`;
  if (state.status === 'running') {
    // a killed driver leaves waiting.json and attention.json behind, so liveness is always reported
    const a = await readAttention(dir);
    const what = waitingText ?? (a !== undefined && a.stepId === state.currentStep ? `${a.kind}: attend terminal ${a.terminal}` : undefined);
    // the same judgement as the JSON's driver.alive: true live, false stopped, null unknown
    const d = await driverLiveness(dir, meta, deps);
    // a foreground drive has no driver terminal; its driver.json says it is alive
    const live = d.lock === undefined ? `driver ${meta.driver}` : `driver pid ${d.lock.pid}`;
    const driver =
      d.alive === true
        ? undefined
        : d.alive === false
          ? `driver not running; perc resume ${meta.runId}`
          : d.lock !== undefined
            ? `driver unknown (pid ${d.lock.pid} on ${d.lock.host})`
            : `driver unknown (hc: ${d.hcError})`;
    if (what === undefined) return driver ?? live;
    return driver === undefined ? what : `${what}; ${driver}`;
  }
  if (waitingText) return waitingText;
  if (state.status === 'paused') return state.pausedReason ?? '';
  if (state.status === 'completed') return (await prUrl(dir, state)) ?? '';
  if (state.status === 'failed') return failedText(state.currentStep ?? '-', state.failedReason);
  return '';
}
