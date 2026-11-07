// Truncation: cuts an oversized Tool Result down to a fixed budget, keeping its start and end
// (where errors and exit codes usually are) and noting in the middle what was dropped.

export type TruncationBudget = {
  /** Most characters a Tool Result may keep. */
  maxChars: number;
  /** Most lines a Tool Result may keep. */
  maxLines: number;
};

export const DEFAULT_TRUNCATION: TruncationBudget = { maxChars: 50_000, maxLines: 2_000 };

/** The lines Truncation dropped (wholly or partly), counted from 0 in the Tool Result's content. */
export type Omission = {
  firstLine: number;
  lineCount: number;
};

/**
 * Returns `content` unchanged when it fits the budget. Otherwise keeps about half the budget from
 * each end, cut at line boundaries where possible, with a note between them. `hint`, if given,
 * adds a Tool-specific hint on recovering the dropped part.
 */
export function truncate(content: string, budget: TruncationBudget, hint?: (omission: Omission) => string): string {
  const lineCount = countNewlines(content, 0, content.length) + 1;
  if (content.length <= budget.maxChars && lineCount <= budget.maxLines) return content;

  const headChars = Math.floor(budget.maxChars / 2);
  const tailChars = Math.floor(budget.maxChars / 2);
  const headLines = Math.ceil(budget.maxLines / 2);
  const tailLines = Math.floor(budget.maxLines / 2);

  // The head ends after `headLines` lines or `headChars` characters, whichever comes first,
  // pulled back to the end of a whole line unless that would give up more than half of it
  // (one huge line, like minified code, is better shown in part than not at all).
  let headEnd = Math.min(headChars, afterLine(content, headLines));
  const lastNewline = headEnd > 0 ? content.lastIndexOf("\n", headEnd - 1) : -1;
  if (lastNewline >= 0 && lastNewline + 1 >= headEnd / 2) headEnd = lastNewline + 1;
  if (splitsPair(content, headEnd)) headEnd--;

  // The tail likewise starts at the start of a whole line, on the same terms.
  let tailStart = Math.max(content.length - tailChars, startOfLastLines(content, tailLines));
  const nextNewline = content.indexOf("\n", tailStart);
  const midLine = content[tailStart - 1] !== "\n";
  if (midLine && nextNewline >= 0 && nextNewline + 1 - tailStart <= (content.length - tailStart) / 2) {
    tailStart = nextNewline + 1;
  }
  if (splitsPair(content, tailStart)) tailStart++;

  const firstLine = countNewlines(content, 0, headEnd);
  const lastLine = countNewlines(content, 0, tailStart - 1);
  const omission: Omission = { firstLine, lineCount: lastLine - firstLine + 1 };
  const hintText = hint ? `. ${hint(omission)}` : "";
  const note =
    `[... ${omission.lineCount} line${omission.lineCount === 1 ? "" : "s"} (${tailStart - headEnd} characters) ` +
    `omitted: the Tool Result was too long${hintText} ...]`;

  const head = content.slice(0, headEnd);
  return `${head}${head.endsWith("\n") || head === "" ? "" : "\n"}\n${note}\n\n${content.slice(tailStart)}`;
}

/** The index just past the `n`th newline, or the content's length if it has fewer lines. */
function afterLine(content: string, n: number): number {
  let index = 0;
  for (let i = 0; i < n; i++) {
    const newline = content.indexOf("\n", index);
    if (newline < 0) return content.length;
    index = newline + 1;
  }
  return index;
}

/** The index where the last `n` lines start. */
function startOfLastLines(content: string, n: number): number {
  if (n === 0) return content.length;
  let index = content.length;
  for (let i = 0; i < n; i++) {
    const newline = content.lastIndexOf("\n", index - 1);
    if (newline < 0) return 0;
    index = newline;
  }
  return index + 1;
}

/** Whether cutting at `index` would split a surrogate pair (one character, such as an emoji, in two halves). */
function splitsPair(content: string, index: number): boolean {
  const before = content.charCodeAt(index - 1);
  const after = content.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function countNewlines(content: string, from: number, to: number): number {
  let count = 0;
  for (let i = content.indexOf("\n", from); i >= 0 && i < to; i = content.indexOf("\n", i + 1)) count++;
  return count;
}
