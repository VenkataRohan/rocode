// The Agent core: owns the conversation and runs the Agent Loop.
// It emits Agent events and knows nothing about the terminal, so any UI can render them.

import type { AssistantMessage, Message, SystemMessage, ToolCall } from "./messages.ts";
import type { Provider, ProviderError } from "./provider.ts";
import { buildSystemPrompt, currentOs, loadProjectInstructions } from "./system-prompt.ts";
import { createToolRegistry, errorResult, type Tool, type ToolResult } from "./tools/tool.ts";

export type TurnFinishReason =
  | "completed" // the Model replied without Tool Calls
  | "step_limit" // maxSteps Steps ran and the Model still wanted Tools
  | "interrupted" // the user interrupted the Turn (Ctrl+C)
  | "error"; // the Provider failed

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_started"; toolCall: ToolCall }
  | { type: "approval_requested"; toolCall: ToolCall; subject: string }
  | { type: "approval_resolved"; toolCall: ToolCall; decision: ApprovalDecision }
  | { type: "tool_call_finished"; toolCall: ToolCall; isError: boolean; preview: string }
  | { type: "step_finished"; step: number }
  | { type: "turn_finished"; reason: TurnFinishReason; error?: ProviderError };

/** How the user answered an Approval: allow this Tool Call, allow the Tool for the rest of the Session, or refuse. */
export type ApprovalDecision = "once" | "always" | "deny";

export type ApprovalRequest = {
  toolCall: ToolCall;
  /** What will happen, e.g. the full command or the path. */
  subject: string;
};

/** Asks the user whether a Tool Call may run. */
export type ApprovalHandler = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>;

/** Allows everything without asking (`--yolo`). */
export const approveAll: ApprovalHandler = async () => "once";

export type AgentOptions = {
  provider: Provider;
  model: string;
  tools: Tool[];
  /** Working directory Tools act in. */
  cwd: string;
  /** Asked before each run of a Tool that requires Approval, unless the user already allowed that Tool always. */
  approve: ApprovalHandler;
  /** Most Steps one Turn may take before it is stopped. */
  maxSteps?: number;
  /** The clock, for today's date in the system prompt. */
  now?: () => Date;
};

export const DEFAULT_MAX_STEPS = 25;

export type Agent = {
  /** The conversation so far, oldest first. The system prompt isn't part of it. */
  readonly messages: readonly Message[];
  /** Runs one Turn for a user message, streaming Agent events until it ends. Never throws. */
  runTurn(text: string, signal: AbortSignal): AsyncGenerator<AgentEvent>;
};

export function createAgent(options: AgentOptions): Agent {
  const { provider, model, cwd, approve, maxSteps = DEFAULT_MAX_STEPS, now = () => new Date() } = options;
  const registry = createToolRegistry(options.tools);
  const messages: Message[] = [];
  /** Tools the user allowed "always". Lives only as long as this Agent, so grants never outlast the Session. */
  const alwaysAllowed = new Set<string>();
  /** Built on the first Turn and kept for the Session, so the Model's instructions don't shift mid-conversation. */
  let cachedSystemMessage: SystemMessage | undefined;

  async function systemMessage(): Promise<SystemMessage> {
    cachedSystemMessage ??= {
      role: "system",
      content: buildSystemPrompt(
        { cwd, os: currentOs(), date: now(), tools: registry.definitions },
        await loadProjectInstructions(cwd),
      ),
    };
    return cachedSystemMessage;
  }

  /** Asks for Approval if needed, then runs the Tool Call. Yields Approval events; returns the Tool Result. */
  async function* approveAndRun(toolCall: ToolCall, signal: AbortSignal): AsyncGenerator<AgentEvent, ToolResult> {
    const prepared = registry.prepare(toolCall);
    if ("error" in prepared) return prepared.error;

    const { tool } = prepared;
    if (tool.requiresApproval && !alwaysAllowed.has(tool.name)) {
      const { subject } = prepared;
      yield { type: "approval_requested", toolCall, subject };
      const decision = await approve({ toolCall, subject }, signal);
      yield { type: "approval_resolved", toolCall, decision };
      if (signal.aborted) return errorResult(CANCELLED);
      if (decision === "deny") return errorResult(denied(tool.name));
      if (decision === "always") alwaysAllowed.add(tool.name);
    }
    return prepared.run({ cwd, signal });
  }

  /**
   * Marks the Turn's last reply (already recorded) as interrupted, and gives each of its Tool Calls
   * that has no Tool Result yet a cancelled one, so every call is answered as every Provider requires.
   */
  function finishInterrupted(reply: AssistantMessage): AgentEvent {
    reply.interrupted = true;
    const answered = new Set(
      messages.slice(messages.indexOf(reply)).flatMap((m) => (m.role === "tool_result" ? [m.toolCallId] : [])),
    );
    for (const toolCall of reply.toolCalls) {
      if (answered.has(toolCall.id)) continue;
      messages.push({ role: "tool_result", toolCallId: toolCall.id, toolName: toolCall.name, content: CANCELLED, isError: true });
    }
    return { type: "turn_finished", reason: "interrupted" };
  }

  async function* runTurn(text: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const system = await systemMessage();
    messages.push({ role: "user", content: text });

    for (let step = 1; ; step++) {
      const reply: AssistantMessage = { role: "assistant", content: "", toolCalls: [] };
      for await (const event of provider.stream({ messages: [system, ...messages], tools: registry.definitions, model, signal })) {
        switch (event.type) {
          case "text_delta":
            reply.content += event.text;
            yield event;
            break;
          case "tool_call":
            reply.toolCalls.push(event.toolCall);
            break;
          case "error":
            if (signal.aborted) {
              messages.push(reply);
              yield finishInterrupted(reply);
              return;
            }
            // Discard the failed Step's partial reply. If no Step completed, drop the
            // user Message too, so retrying doesn't send it twice.
            if (step === 1) messages.pop();
            yield { type: "turn_finished", reason: "error", error: event.error };
            return;
        }
      }
      messages.push(reply);

      for (const toolCall of reply.toolCalls) {
        if (signal.aborted) break;
        yield { type: "tool_call_started", toolCall };
        const result = yield* approveAndRun(toolCall, signal);
        messages.push({
          role: "tool_result",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: result.content,
          isError: result.isError,
        });
        yield { type: "tool_call_finished", toolCall, isError: result.isError, preview: preview(result.content) };
      }

      if (signal.aborted) {
        yield finishInterrupted(reply);
        return;
      }

      yield { type: "step_finished", step };
      if (reply.toolCalls.length === 0) {
        yield { type: "turn_finished", reason: "completed" };
        return;
      }
      if (step >= maxSteps) {
        yield { type: "turn_finished", reason: "step_limit" };
        return;
      }
    }
  }

  return { messages, runTurn };
}

const CANCELLED = "Cancelled by the user: the Turn was interrupted before this tool call ran.";

function denied(toolName: string): string {
  return `The user denied this ${toolName} call, so it did not run. Try a different approach, or ask the user how to proceed.`;
}

/** The first line of a Tool Result, plus how many lines were left out. */
function preview(content: string): string {
  const [first = "", ...rest] = content.split("\n");
  if (rest.length === 0) return first;
  return `${first} (+${rest.length} more line${rest.length === 1 ? "" : "s"})`;
}
