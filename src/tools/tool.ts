import type { ToolCall } from "../messages.ts";
import type { ToolDefinition } from "../provider.ts";
import { validateArguments } from "./validate.ts";

/** What a Tool gets besides its arguments. */
export type ToolContext = {
  /** Working directory; relative paths resolve against it. */
  cwd: string;
  signal: AbortSignal;
};

/** What executing a Tool Call produced: the content and error flag of its Tool Result. */
export type ToolResult = {
  content: string;
  isError: boolean;
};

export const okResult = (content: string): ToolResult => ({ content, isError: false });
export const errorResult = (content: string): ToolResult => ({ content, isError: true });

/** A named capability the Model may invoke. */
export type Tool<Args = any> = ToolDefinition & {
  /** Whether the user must give Approval before each run (enforced from issue 04). */
  requiresApproval: boolean;
  /** Receives arguments already validated against `inputSchema`. May throw; the registry turns that into an error Tool Result. */
  execute(args: Args, context: ToolContext): Promise<ToolResult>;
};

/** The Tools available to the Model, and the one place Tool Calls are dispatched. */
export type ToolRegistry = {
  /** How the Tools are described to the Model. */
  readonly definitions: ToolDefinition[];
  /** Runs a Tool Call. Never throws: every failure becomes an error Tool Result. */
  run(call: ToolCall, context: ToolContext): Promise<ToolResult>;
};

export function createToolRegistry(tools: Tool[]): ToolRegistry {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    definitions: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    async run(call, context) {
      const tool = byName.get(call.name);
      if (!tool) {
        const available = tools.map((t) => t.name).join(", ") || "none";
        return errorResult(`Unknown tool "${call.name}". Available tools: ${available}.`);
      }

      const problem =
        call.unparsedArguments !== undefined
          ? `not valid JSON: ${call.unparsedArguments}`
          : validateArguments(tool.inputSchema, call.arguments);
      if (problem) return errorResult(`Invalid arguments for tool "${tool.name}": ${problem}`);

      try {
        return await tool.execute(call.arguments, context);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return errorResult(`Tool "${tool.name}" failed: ${reason}`);
      }
    },
  };
}
