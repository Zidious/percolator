export type Section = { title: string; body: string };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const H2 = /^## (.*)$/;
/** A heading's optional closing `#` sequence (`## Title ##`), which is not part of its title. */
const CLOSING = /(^|\s)#+\s*$/;

/**
 * One item per `## ` heading at line start; text before the first heading is ignored and bodies are trimmed.
 * A closing `#` sequence is dropped from the title; a bare heading gives an empty title (callers decide).
 * Lines inside fenced code blocks (``` or ~~~) are never headings.
 */
export function splitSections(md: string): Section[] {
  const out: { title: string; lines: string[] }[] = [];
  let fence: string | undefined;
  for (const line of md.split(/\r?\n/)) {
    const f = FENCE.exec(line)?.[1];
    if (fence === undefined) {
      if (f !== undefined) fence = f;
      else {
        const h = H2.exec(line);
        if (h) {
          out.push({ title: h[1]!.replace(CLOSING, '').trim(), lines: [] });
          continue;
        }
      }
    } else if (f !== undefined && f[0] === fence[0] && f.length >= fence.length && line.trim() === f) {
      fence = undefined;
    }
    out.at(-1)?.lines.push(line);
  }
  return out.map((s) => ({ title: s.title, body: s.lines.join('\n').trim() }));
}
