import { stat } from "node:fs/promises";
import type { Stats } from "node:fs";

/** Like `stat`, but a missing path is null rather than an error. */
export function statOrNull(path: string): Promise<Stats | null> {
  return stat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
}

/** How many lines the text has, as an editor would count them (a final newline doesn't start a new one). */
export function countLines(text: string): number {
  if (text === "") return 0;
  return text.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

/** A count with its noun, e.g. "1 line", "3 lines". */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
