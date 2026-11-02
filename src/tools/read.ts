import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { statOrNull } from "./files.ts";
import { errorResult as error, okResult as ok, type Tool } from "./tool.ts";

type ReadArgs = { path: string; offset?: number; limit?: number };

export const readTool: Tool<ReadArgs> = {
  name: "read",
  description:
    "Read a text file. Returns its contents with 1-based line numbers. " +
    "Use offset and limit to page through large files.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the working directory or absolute." },
      offset: { type: "integer", minimum: 1, description: "Line number to start reading from (1-based). Default 1." },
      limit: { type: "integer", minimum: 1, description: "Maximum number of lines to return." },
    },
    required: ["path"],
  },
  requiresApproval: false,

  async execute({ path, offset = 1, limit }, { cwd }) {
    const fullPath = resolve(cwd, path);

    const info = await statOrNull(fullPath);
    if (!info) return error(`File not found: ${path}`);
    if (info.isDirectory()) return error(`${path} is a directory, not a file.`);

    const text = await readFile(fullPath, "utf8");
    if (text === "") return ok(`(${path} is empty)`);

    const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
    if (offset > lines.length) {
      return error(`offset ${offset} is past the end of ${path}, which has ${lines.length} lines.`);
    }

    const end = Math.min(lines.length, limit === undefined ? lines.length : offset - 1 + limit);
    const numbered = lines
      .slice(offset - 1, end)
      .map((line, i) => `${offset + i}\t${line}`)
      .join("\n");
    if (end === lines.length) return ok(numbered);
    return ok(`${numbered}\n\n(Showing lines ${offset}-${end} of ${lines.length}. Use offset=${end + 1} to read more.)`);
  },
};
