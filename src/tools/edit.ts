import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { statOrNull } from "./files.ts";
import { errorResult as error, okResult as ok, type Tool } from "./tool.ts";

type EditArgs = { path: string; old_string: string; new_string: string };

export const editTool: Tool<EditArgs> = {
  name: "edit",
  description:
    "Replace one exact occurrence of old_string with new_string in a file. " +
    "old_string must match the file exactly, including whitespace and indentation, and must occur exactly once: " +
    "include enough surrounding lines to make it unique. Read the file first.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the working directory or absolute." },
      old_string: { type: "string", description: "The exact text to replace. Must occur exactly once in the file." },
      new_string: { type: "string", description: "The text to put in its place." },
    },
    required: ["path", "old_string", "new_string"],
  },
  requiresApproval: true,
  approvalSubject: ({ path }) => path,

  async execute({ path, old_string, new_string }, { cwd }) {
    if (old_string === "") {
      return error("old_string must not be empty. To create a file or replace all of its content, use write.");
    }

    const fullPath = resolve(cwd, path);
    const info = await statOrNull(fullPath);
    if (!info) return error(`File not found: ${path}. To create a file, use write.`);
    if (info.isDirectory()) return error(`${path} is a directory, not a file.`);

    // read shows lines without their "\r", so match against LF text and restore CRLF on write.
    const raw = await readFile(fullPath, "utf8");
    const crlf = raw.includes("\r\n");
    const text = crlf ? toLf(raw) : raw;
    const search = crlf ? toLf(old_string) : old_string;
    const matches = findAll(text, search);
    if (matches.length === 0) {
      return error(
        `old_string was not found in ${path}. It must match the file exactly, including whitespace and indentation. ` +
          "Re-read the file with read, then retry with the exact text.",
      );
    }
    if (matches.length > 1) {
      const lines = matches.map((index) => lineNumberAt(text, index)).join(", ");
      return error(
        `old_string matched ${matches.length} times in ${path} (lines ${lines}) — ` +
          "add more surrounding context so it matches exactly once.",
      );
    }
    const [at] = matches as [number];
    const edited = text.slice(0, at) + (crlf ? toLf(new_string) : new_string) + text.slice(at + search.length);
    await writeFile(fullPath, crlf ? edited.replaceAll("\n", "\r\n") : edited);
    return ok(`Edited ${path}.`);
  },
};

const toLf = (text: string) => text.replaceAll("\r\n", "\n");

/** Start index of every occurrence of `search` in `text`, overlapping ones included. */
function findAll(text: string, search: string): number[] {
  const indexes: number[] = [];
  for (let at = text.indexOf(search); at !== -1; at = text.indexOf(search, at + 1)) indexes.push(at);
  return indexes;
}

/** The 1-based line number of the character at `index`. */
function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) line++;
  return line;
}
