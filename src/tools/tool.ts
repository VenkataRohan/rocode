import type { ToolCall } from "../messages.ts";
import type { ToolDefinition } from "../provider.ts";
import type { Omission } from "../truncation.ts";
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
  /** Whether the user must give Approval before each run. */
  requiresApproval: boolean;
  /** What the user is shown when asked for Approval, e.g. the full command. Defaults to the arguments as `key: value` pairs. */
  approvalSubject?(args: Args): string;
  /** A hint, added to the Truncation note, on how the Model can get at the part of the Tool Result that was dropped. */
  truncationHint?(args: Args, omission: Omission): string;
  /** Receives arguments already validated against `inputSchema`. May throw; the registry turns that into an error Tool Result. */
  execute(args: Args, context: ToolContext): Promise<ToolResult>;
};

/** A Tool Call that passed lookup and validation, ready to run. */
export type PreparedCall = {
  tool: Tool;
  /** What the user is shown when asked for Approval. */
  subject: string;
  /** The Tool's Truncation hint for this call, if it has one. */
  truncationHint?(omission: Omission): string;
  /** Executes the Tool. Never throws: a failure becomes an error Tool Result. */
  run(context: ToolContext): Promise<ToolResult>;
};

/** The Tools available to the Model, and the one place Tool Calls are dispatched. */
export type ToolRegistry = {
  /** How the Tools are described to the Model. */
  readonly definitions: ToolDefinition[];
  /** Looks up and validates a Tool Call: a call ready to run, or the error Tool Result explaining what's wrong. */
  prepare(call: ToolCall): PreparedCall | { error: ToolResult };
};

export function createToolRegistry(tools: Tool[]): ToolRegistry {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    definitions: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    prepare(call) {
      const tool = byName.get(call.name);
      if (!tool) {
        const available = tools.map((t) => t.name).join(", ") || "none";
        return { error: errorResult(`Unknown tool "${call.name}". Available tools: ${available}.`) };
      }

      const problem =
        call.unparsedArguments !== undefined
          ? `not valid JSON: ${call.unparsedArguments}`
          : validateArguments(tool.inputSchema, call.arguments);
      if (problem) return { error: errorResult(`Invalid arguments for tool "${tool.name}": ${problem}`) };

      return {
        tool,
        subject: tool.approvalSubject?.(call.arguments) ?? formatArguments(call.arguments as Record<string, unknown>),
        truncationHint: tool.truncationHint && ((omission) => tool.truncationHint!(call.arguments, omission)),
        async run(context) {
          try {
            return await tool.execute(call.arguments, context);
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return errorResult(`Tool "${tool.name}" failed: ${reason}`);
          }
        },
      };
    },
  };
}

/** Validated arguments (always a JSON object) as `key: value` pairs. */
function formatArguments(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(", ");
}
