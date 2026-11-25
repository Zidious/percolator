export type Section = { title: string; body: string };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** An h2 at line start: `##`, then a space or tab and the title, or nothing. Indented, it is body text. */
const H2 = /^##(?:[ \t]+(.*))?$/;
/** A heading's optional closing `#` sequence (`## Title ##`), which is not part of its title. */
const CLOSING = /(^|\s)#+\s*$/;
/** An ordered-list marker (`1.` or `1)`, then a space, a tab or nothing), indented up to 3 spaces; group 1 is the indent. */
const MARKER = /^( {0,3})\d{1,9}[.)](?:[ \t]|$)/;

/**
 * The open fence after `line`, given the one open before it (undefined: outside a fenced block). `code` says whether
 * the line is part of a fenced block, its opening and closing lines included.
 */
function fenceAt(fence: string | undefined, line: string): { fence: string | undefined; code: boolean } {
  const f = FENCE.exec(line)?.[1];
  if (fence === undefined) return f === undefined ? { fence, code: false } : { fence: f, code: true };
  const closes = f !== undefined && f[0] === fence[0] && f.length >= fence.length && line.trim() === f;
  return { fence: closes ? undefined : fence, code: true };
}

/**
 * One item per `##` heading at line start; text before the first heading is ignored and bodies are trimmed.
 * A closing `#` sequence is dropped from the title; a bare heading gives an empty title (callers decide).
 * Lines inside fenced code blocks (``` or ~~~) are never headings.
 */
export function splitSections(md: string): Section[] {
  const out: { title: string; lines: string[] }[] = [];
  let fence: string | undefined;
  for (const line of md.split(/\r?\n/)) {
    const at = fenceAt(fence, line);
    fence = at.fence;
    if (!at.code) {
      const h = H2.exec(line);
      if (h) {
        out.push({ title: (h[1] ?? '').replace(CLOSING, '').trim(), lines: [] });
        continue;
      }
    }
    out.at(-1)?.lines.push(line);
  }
  return out.map((s) => ({ title: s.title, body: s.lines.join('\n').trim() }));
}

/**
 * One trimmed item per top-level ordered-list item (`1.` or `1)`, any number), with its continuation lines; the
 * non-blank text before the first marker is an item of its own. The first marker's indent is the top level, so a list
 * nested deeper stays in its item. Lines inside fenced code blocks are never markers. No marker: the whole text as
 * one item; blank: none. Lines are joined with `\n`.
 */
export function splitListItems(md: string): string[] {
  const items: string[][] = [[]];
  let top: string | undefined;
  let fence: string | undefined;
  for (const line of md.split(/\r?\n/)) {
    const at = fenceAt(fence, line);
    fence = at.fence;
    const indent = at.code ? undefined : MARKER.exec(line)?.[1];
    if (indent !== undefined && (top === undefined || indent === top)) {
      top = indent;
      items.push([]);
    }
    items.at(-1)!.push(line);
  }
  return items.map((lines) => lines.join('\n').trim()).filter((text) => text !== '');
}
