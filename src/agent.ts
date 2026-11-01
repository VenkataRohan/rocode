// The Agent core: owns the conversation and runs the Agent Loop.
// It emits Agent events and knows nothing about the terminal, so any UI can render them.

import type { AssistantMessage, Message, ToolCall } from "./messages.ts";
import type { Provider, ProviderError } from "./provider.ts";
import { createToolRegistry, type Tool } from "./tools/tool.ts";

export type TurnFinishReason =
  | "completed" // the Model replied without Tool Calls
  | "step_limit" // maxSteps Steps ran and the Model still wanted Tools
  | "error"; // the Provider failed

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_started"; toolCall: ToolCall }
  | { type: "tool_call_finished"; toolCall: ToolCall; isError: boolean; preview: string }
  | { type: "step_finished"; step: number }
  | { type: "turn_finished"; reason: TurnFinishReason; error?: ProviderError };

export type AgentOptions = {
  provider: Provider;
  model: string;
  tools: Tool[];
  /** Working directory Tools act in. */
  cwd: string;
  /** Most Steps one Turn may take before it is stopped. */
  maxSteps?: number;
};

export const DEFAULT_MAX_STEPS = 25;

export type Agent = {
  /** The conversation so far, oldest first. */
  readonly messages: readonly Message[];
  /** Runs one Turn for a user message, streaming Agent events until it ends. Never throws. */
  runTurn(text: string, signal: AbortSignal): AsyncGenerator<AgentEvent>;
};

export function createAgent(options: AgentOptions): Agent {
  const { provider, model, cwd, maxSteps = DEFAULT_MAX_STEPS } = options;
  const registry = createToolRegistry(options.tools);
  const messages: Message[] = [];

  async function* runTurn(text: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    messages.push({ role: "user", content: text });

    for (let step = 1; ; step++) {
      const reply: AssistantMessage = { role: "assistant", content: "", toolCalls: [] };
      for await (const event of provider.stream({ messages, tools: registry.definitions, model, signal })) {
        switch (event.type) {
          case "text_delta":
            reply.content += event.text;
            yield event;
            break;
          case "tool_call":
            reply.toolCalls.push(event.toolCall);
            break;
          case "error":
            // Discard the failed Step's partial reply. If no Step completed, drop the
            // user Message too, so retrying doesn't send it twice.
            if (step === 1) messages.pop();
            yield { type: "turn_finished", reason: "error", error: event.error };
            return;
        }
      }
      messages.push(reply);

      for (const toolCall of reply.toolCalls) {
        yield { type: "tool_call_started", toolCall };
        const result = await registry.run(toolCall, { cwd, signal });
        messages.push({
          role: "tool_result",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: result.content,
          isError: result.isError,
        });
        yield { type: "tool_call_finished", toolCall, isError: result.isError, preview: preview(result.content) };
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

/** The first line of a Tool Result, plus how many lines were left out. */
function preview(content: string): string {
  const [first = "", ...rest] = content.split("\n");
  if (rest.length === 0) return first;
  return `${first} (+${rest.length} more line${rest.length === 1 ? "" : "s"})`;
}
