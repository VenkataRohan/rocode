import type { Message, ToolCall } from "../../src/messages.ts";
import type { Provider, ProviderEvent, StreamRequest } from "../../src/provider.ts";

/** Stands in for a stream that stalls until the request is aborted, then fails like a real Provider does. */
export const HANG = Symbol("hang");

/** One scripted Model reply: the events a Provider would emit for a single Step. */
export type ScriptedStep = (ProviderEvent | typeof HANG)[];

/**
 * A Provider that replays scripted Steps in order, one per `stream` call.
 * Running out of script is a test bug, reported as an error event.
 */
export class FakeProvider implements Provider {
  readonly name = "fake";
  /** Snapshots of the Messages each request carried, for asserting what the Model saw. */
  readonly requests: Message[][] = [];
  /** The system prompt each request carried. */
  readonly systemPrompts: (string | undefined)[] = [];
  /** Whether each request's abort signal had fired by the time its stream ended. */
  readonly aborted: boolean[] = [];
  private steps: ScriptedStep[];

  constructor(steps: ScriptedStep[]) {
    this.steps = [...steps];
  }

  async *stream(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    this.requests.push(structuredClone(request.messages));
    this.systemPrompts.push(request.system);
    const step = this.steps.shift();
    if (!step) {
      yield { type: "error", error: { kind: "server", message: "FakeProvider: no more scripted Steps" } };
      return;
    }
    const index = this.requests.length - 1;
    try {
      for (const event of step) {
        if (event !== HANG) {
          yield event;
          continue;
        }
        await waitForAbort(request.signal);
        yield { type: "error", error: { kind: "aborted", message: "Request cancelled." } };
        return;
      }
    } finally {
      this.aborted[index] = request.signal.aborted;
    }
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

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
