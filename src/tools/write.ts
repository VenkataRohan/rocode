import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { countLines, plural, statOrNull } from "./files.ts";
import { errorResult as error, okResult as ok, type Tool } from "./tool.ts";

type WriteArgs = { path: string; content: string };

export const writeTool: Tool<WriteArgs> = {
  name: "write",
  description:
    "Create a file, or overwrite an existing one, with the given content. Missing parent directories are created. " +
    "To change part of an existing file, prefer edit.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the working directory or absolute." },
      content: { type: "string", description: "The full content of the file." },
    },
    required: ["path", "content"],
  },
  requiresApproval: true,
  approvalSubject: ({ path }) => path,

  async execute({ path, content }, { cwd }) {
    const fullPath = resolve(cwd, path);
    const existing = await statOrNull(fullPath);
    if (existing?.isDirectory()) return error(`${path} is a directory, not a file.`);

    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
    return ok(`${existing ? "Overwrote" : "Created"} ${path} (${plural(countLines(content), "line")}).`);
  },
};
