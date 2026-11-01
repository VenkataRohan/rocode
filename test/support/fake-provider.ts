import type { Message, ToolCall } from "../../src/messages.ts";
import type { Provider, ProviderEvent, StreamRequest } from "../../src/provider.ts";

/** One scripted Model reply: the events a Provider would emit for a single Step. */
export type ScriptedStep = ProviderEvent[];

/**
 * A Provider that replays scripted Steps in order, one per `stream` call.
 * Running out of script is a test bug, reported as an error event.
 */
export class FakeProvider implements Provider {
  readonly name = "fake";
  /** Snapshots of the Messages each request carried, for asserting what the Model saw. */
  readonly requests: Message[][] = [];
  private steps: ScriptedStep[];

  constructor(steps: ScriptedStep[]) {
    this.steps = [...steps];
  }

  async *stream(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    this.requests.push(structuredClone(request.messages));
    const step = this.steps.shift();
    if (!step) {
      yield { type: "error", error: { kind: "server", message: "FakeProvider: no more scripted Steps" } };
      return;
    }
    yield* step;
  }
}

/** A Step where the Model replies with text only (streamed as the given deltas). */
export function reply(...deltas: string[]): ScriptedStep {
  return [...deltas.map((text) => ({ type: "text_delta", text }) as const), { type: "done" }];
}

/** A Step where the Model calls Tools, optionally after some text. */
export function callTools(calls: ToolCall[], text?: string): ScriptedStep {
  return [
    ...(text ? [{ type: "text_delta", text } as const] : []),
    ...calls.map((toolCall) => ({ type: "tool_call", toolCall }) as const),
    { type: "done" },
  ];
}

export function call(id: string, name: string, args: unknown): ToolCall {
  return { id, name, arguments: args };
}
