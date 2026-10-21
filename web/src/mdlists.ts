import { marked } from 'marked';

// Markdown only lets a numbered list that starts at 1 follow a line of text directly. Claude often writes
// "**Part 2**" and then "5. ..." on the next line: that showed as one run-on paragraph (2026-10-21). Inside a
// paragraph only, a line starting with a number becomes the start of a list.
// The first numbered line only: the lines after it then join the same list (a blank line between items
// would space them out as a loose list).
const NUMBERED = /\n( {0,3}\d{1,3}[.)] )/;

export function fixLists(text: string): string {
  const src = text.replace(/\r\n?/g, '\n'); // the lexer does this too: its pieces match this
  if (!NUMBERED.test(src)) return text;
  const tokens = marked.lexer(src);
  let changed = false;
  const parts = tokens.map((t) => {
    if (t.type !== 'paragraph' || !NUMBERED.test(t.raw)) return t.raw;
    changed = true;
    return t.raw.replace(NUMBERED, '\n\n$1');
  });
  if (!changed) return text;
  // The pieces must add up to the original text; if the lexer dropped anything, leave the text alone.
  const original = tokens.map((t) => t.raw).join('');
  return original === src ? parts.join('') : text;
}
