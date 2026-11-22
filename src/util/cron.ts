/**
 * Five-field cron (minute hour day-of-month month day-of-week) evaluated in an IANA time zone with
 * Intl only. `domAny`/`dowAny` record a field written as `*…`: when both day fields are restricted,
 * either may match (standard cron semantics).
 */
export type Cron = {
  minute: number[];
  hour: number[];
  dom: number[];
  month: number[];
  dow: number[];
  domAny: boolean;
  dowAny: boolean;
};

/** Wall-clock time in a zone; `key` is `YYYY-MM-DDTHH:MM` and identifies a firing. */
export type Wall = { y: number; mo: number; d: number; h: number; mi: number; dow: number; key: string };

const FIELDS = [
  { name: 'minute', lo: 0, hi: 59 },
  { name: 'hour', lo: 0, hi: 23 },
  { name: 'day-of-month', lo: 1, hi: 31 },
  { name: 'month', lo: 1, hi: 12 },
  { name: 'day-of-week', lo: 0, hi: 7 },
] as const;

const ITEM = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/;

function cronError(expr: string, reason: string): Error {
  return new Error(`cron "${expr}": ${reason}; use five fields: minute hour day-of-month month day-of-week`);
}

function parseField(expr: string, text: string, f: (typeof FIELDS)[number]): number[] {
  const out = new Set<number>();
  for (const token of text.split(',')) {
    const m = ITEM.exec(token);
    const step = m?.[3] === undefined ? 1 : Number(m[3]);
    // A step needs `*` or a range; a single value with a step, or a zero step, is unreadable.
    if (!m || step === 0 || (m[3] !== undefined && m[1] !== undefined && m[2] === undefined)) {
      throw cronError(expr, `cannot read "${token}" in ${f.name}`);
    }
    const a = m[1] === undefined ? f.lo : Number(m[1]);
    const b = m[1] === undefined ? f.hi : m[2] === undefined ? a : Number(m[2]);
    for (const v of [a, b]) {
      if (v < f.lo || v > f.hi) throw cronError(expr, `${f.name} value ${v} is out of range ${f.lo}-${f.hi}`);
    }
    if (a > b) throw cronError(expr, `cannot read "${token}" in ${f.name}`);
    for (let v = a; v <= b; v += step) out.add(f.name === 'day-of-week' && v === 7 ? 0 : v);
  }
  return [...out].sort((x, y) => x - y);
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/).filter((p) => p !== '');
  if (parts.length !== 5) throw cronError(expr, `needs 5 fields, got ${parts.length}`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(expr, p, FIELDS[i]));
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domAny: parts[2].startsWith('*'),
    dowAny: parts[4].startsWith('*'),
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const cacheKey = timeZone ?? '';
  let fmt = formatters.get(cacheKey);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    formatters.set(cacheKey, fmt);
  }
  return fmt;
}

/** The wall clock at `at` in `timeZone` (the system zone when omitted). */
export function wallClock(at: Date, timeZone?: string): Wall {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(at)) parts[p.type] = p.value;
  const y = Number(parts.year);
  const mo = Number(parts.month);
  const d = Number(parts.day);
  const h = Number(parts.hour);
  const mi = Number(parts.minute);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return {
    y,
    mo,
    d,
    h,
    mi,
    dow: WEEKDAYS.indexOf(parts.weekday),
    key: `${String(y).padStart(4, '0')}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}`,
  };
}

export function cronMatches(c: Cron, wall: Wall): boolean {
  if (!c.minute.includes(wall.mi) || !c.hour.includes(wall.h) || !c.month.includes(wall.mo)) return false;
  const domOk = c.dom.includes(wall.d);
  const dowOk = c.dow.includes(wall.dow);
  if (!c.domAny && !c.dowAny) return domOk || dowOk;
  return domOk && dowOk;
}

const MINUTE_MS = 60_000;
const MAX_LOOKBACK_MS = 7 * 24 * 60 * MINUTE_MS;

/**
 * The latest minute in (`after`, `upTo`] that matches `c` in `timeZone`, looking back at most 7
 * days from `upTo`.
 */
export function latestTick(
  c: Cron,
  after: Date,
  upTo: Date,
  timeZone?: string,
): { at: Date; key: string } | undefined {
  const floor = Math.max(after.getTime(), upTo.getTime() - MAX_LOOKBACK_MS);
  for (let t = Math.floor(upTo.getTime() / MINUTE_MS) * MINUTE_MS; t > floor; t -= MINUTE_MS) {
    const at = new Date(t);
    const wall = wallClock(at, timeZone);
    if (cronMatches(c, wall)) return { at, key: wall.key };
  }
  return undefined;
}

export function knownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
