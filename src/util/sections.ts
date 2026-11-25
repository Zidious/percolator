export type Section = { title: string; body: string };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** An h2 at line start: `##`, then a space or tab and the title, or nothing. Indented, it is body text. */
const H2 = /^##(?:[ \t]+(.*))?$/;
/** A heading's optional closing `#` sequence (`## Title ##`), which is not part of its title. */
const CLOSING = /(^|\s)#+\s*$/;
/** An ordered-list marker (`1.` or `1)`, then a space, a tab or nothing), indented up to 3 spaces; group 1 is the indent. */
const MARKER = /^( {0,3})\d{1,9}[.)](?:[ \t]|$)/;
/** An unordered-list marker (`-`, `*` or `+`, then a space, a tab or nothing); group 1 is the indent. */
const BULLET = /^(\s*)[-*+](?:[ \t]|$)/;
/** An ATX heading line (`#` to `######`, then a space, a tab or nothing), indented up to 3 spaces. */
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
/** A thematic break (`* * *`, `- - -`, `___`): three or more of one mark, spaces or tabs between; never a bullet. */
const BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
/** The column a bullet's content starts at (after the mark and its space), or undefined when the line is no bullet. */
const bulletContent = (line: string): number | undefined => {
  const b = BREAK.test(line) ? undefined : BULLET.exec(line);
  return b ? b[1]!.length + 2 : undefined;
};
const indentOf = (line: string): number => /^\s*/.exec(line)![0].length;

/**
 * Whether a first ordered marker at `indent` is the top level, given the non-code lines before it: not when it sits
 * inside an earlier bullet's content (the list is nested in that bullet), nor when the line right before it is text
 * left of it (the list is indented under that text).
 */
function isTopLevel(before: string[], indent: number): boolean {
  if (before.some((l) => (bulletContent(l) ?? Infinity) <= indent)) return false;
  const prev = before.at(-1);
  return prev === undefined || prev.trim() === '' || indentOf(prev) >= indent;
}

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
 * nested deeper stays in its item. A first marker nested in a bullet or indented under the text right before it is
 * not a top level: the whole text is one item. A heading line ends the item before it unless it is indented past the
 * top-level marker (then it is the item's content); an item of headings only is dropped. Lines inside fenced code blocks are never markers or headings. No marker: the whole text as one item;
 * blank: none. Lines are joined with `\n`.
 */
export function splitListItems(md: string): string[] {
  const lines = md.split(/\r?\n/);
  const whole = lines.join('\n').trim();
  const items: string[][] = [[]];
  const before: string[] = [];
  let top: string | undefined;
  let fence: string | undefined;
  for (const line of lines) {
    const at = fenceAt(fence, line);
    fence = at.fence;
    const indent = at.code ? undefined : MARKER.exec(line)?.[1];
    if (top === undefined && indent !== undefined && !isTopLevel(before, indent.length)) return whole === '' ? [] : [whole];
    if (top === undefined && !at.code) before.push(line);
    const heading = !at.code && HEADING.test(line) && (top === undefined || indentOf(line) <= top.length);
    if (heading || (indent !== undefined && (top === undefined || indent === top))) items.push([]);
    if (indent !== undefined && top === undefined) top = indent;
    items.at(-1)!.push(line);
  }
  if (top === undefined) return whole === '' ? [] : [whole];
  const onlyHeadings = (item: string[]) => item.every((l) => l.trim() === '' || HEADING.test(l));
  return items.filter((item) => !onlyHeadings(item)).map((item) => item.join('\n').trim());
}
