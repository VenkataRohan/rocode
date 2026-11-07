// The system prompt builder: a fixed template filled with the environment the Model works in,
// plus Project Instructions from `AGENTS.md` when the working directory has one.

import { readFile } from "node:fs/promises";
import { release, type } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "./provider.ts";

type Environment = {
  cwd: string;
  /** e.g. "darwin (Darwin 25.6.0)". */
  os: string;
  date: Date;
  tools: ToolDefinition[];
};

const PROJECT_INSTRUCTIONS_FILE = "AGENTS.md";

/** The machine rocode runs on, for the system prompt. */
export function currentOs(): string {
  return `${process.platform} (${type()} ${release()})`;
}

/** The contents of `AGENTS.md` in `cwd`, or undefined when it's missing, unreadable, or blank. */
export async function loadProjectInstructions(cwd: string): Promise<string | undefined> {
  try {
    const text = (await readFile(join(cwd, PROJECT_INSTRUCTIONS_FILE), "utf8")).trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

export function buildSystemPrompt(env: Environment, projectInstructions?: string): string {
  const tools = env.tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n") || "(none)";
  const prompt = `You are rocode, a coding agent running in the user's terminal. You help with software engineering tasks by reading and changing files and running commands in the working directory.

# Environment
- Working directory: ${env.cwd}
- OS: ${env.os}
- Today's date: ${formatDate(env.date)}

# Tools
${tools}

# How to work
- Use Tools to look before you act: read files before editing them, and check your changes when you can.
- Relative paths resolve against the working directory.
- Some Tool Calls need the user's Approval. If one is denied, try a different approach or ask the user.
- Keep replies short and to the point. When you're done, say what you changed.`;

  if (!projectInstructions) return prompt;
  return `${prompt}

# Project Instructions
The user wrote these for this project in ${PROJECT_INSTRUCTIONS_FILE}. Follow them.

${projectInstructions}`;
}

/** YYYY-MM-DD in local time. */
function formatDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
