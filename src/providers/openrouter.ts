// OpenRouter Provider: OpenAI Chat Completions over SSE, hand-rolled (see ADR 0001).
// All wire-format JSON stays inside this module.

import type { Message } from "../messages.ts";
import type { HttpFn, Provider, ProviderError, ProviderEvent, StreamRequest } from "../provider.ts";
import { readSseData } from "./sse.ts";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export type OpenRouterOptions = {
  apiKey: string;
  http?: HttpFn;
};

// --- Wire shapes (OpenAI Chat Completions) ---

type WireMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type WireChunk = {
  choices?: { delta?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  /** OpenRouter reports failures after the 200 status as a chunk carrying `error`. */
  error?: { code?: string | number; message?: string };
};

export function createOpenRouterProvider(options: OpenRouterOptions): Provider {
  const http = options.http ?? fetch;

  return {
    name: "openrouter",
    async *stream(request: StreamRequest): AsyncGenerator<ProviderEvent> {
      let response: Response;
      try {
        response = await http(ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(toWireRequest(request)),
          signal: request.signal,
        });
      } catch (err) {
        yield { type: "error", error: transportError(err, request.signal) };
        return;
      }

      if (!response.ok) {
        yield { type: "error", error: await httpError(response, request.model) };
        return;
      }
      if (!response.body) {
        yield { type: "error", error: { kind: "server", message: "OpenRouter sent an empty response." } };
        return;
      }

      let sawDone = false;
      try {
        for await (const data of readSseData(response.body)) {
          if (data === "[DONE]") {
            sawDone = true;
            break;
          }

          let chunk: WireChunk;
          try {
            chunk = JSON.parse(data) as WireChunk;
          } catch {
            yield {
              type: "error",
              error: { kind: "server", message: `OpenRouter sent malformed stream data: ${data.slice(0, 200)}` },
            };
            return;
          }

          if (chunk.error) {
            yield {
              type: "error",
              error: { kind: "server", message: `OpenRouter stream failed: ${chunk.error.message ?? "unknown error"}` },
            };
            return;
          }

          const text = chunk.choices?.[0]?.delta?.content;
          if (text) yield { type: "text_delta", text };

          if (chunk.usage) {
            yield {
              type: "usage",
              usage: {
                inputTokens: chunk.usage.prompt_tokens ?? 0,
                outputTokens: chunk.usage.completion_tokens ?? 0,
              },
            };
          }
        }
      } catch (err) {
        yield { type: "error", error: transportError(err, request.signal) };
        return;
      }

      if (!sawDone) {
        // The connection closed cleanly but early: the reply is incomplete.
        yield {
          type: "error",
          error: { kind: "network", message: "OpenRouter closed the stream before the reply finished." },
        };
        return;
      }
      yield { type: "done" };
    },
  };
}

/** A failure to send the request or to keep reading its response. */
function transportError(err: unknown, signal: AbortSignal): ProviderError {
  if (signal.aborted) return { kind: "aborted", message: "Request cancelled." };
  const reason = err instanceof Error ? err.message : String(err);
  return { kind: "network", message: `Couldn't reach OpenRouter: ${reason}` };
}

async function httpError(response: Response, model: string): Promise<ProviderError> {
  const status = response.status;
  const detail = await errorDetail(response);

  if (status === 401) {
    return {
      kind: "auth",
      status,
      message: `OpenRouter rejected the API key (401: ${detail}). Check OPENROUTER_API_KEY.`,
    };
  }
  if (status === 429) {
    return {
      kind: "rate_limit",
      status,
      message: `OpenRouter rate limit hit (429: ${detail}). Free Models are capped per minute and per day; wait a bit or switch Models.`,
    };
  }
  // OpenRouter answers 400 "... is not a valid model ID" for unknown ids,
  // and 404 "No endpoints found for ..." for ids with no serving provider.
  if (status === 404 || (status === 400 && /not a valid model/i.test(detail))) {
    return {
      kind: "invalid_model",
      status,
      message: `Model "${model}" isn't available on OpenRouter (${status}: ${detail}). Pick another with --model.`,
    };
  }
  if (status >= 500) {
    return {
      kind: "server",
      status,
      message: `OpenRouter server error (${status}: ${detail}). Try again shortly.`,
    };
  }
  return { kind: "bad_request", status, message: `OpenRouter returned ${status}: ${detail}` };
}

/** The `error.message` from OpenRouter's JSON error body, or the raw text. */
async function errorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: { message?: string } };
    const message = body.error?.message?.trim();
    if (message) return message;
  } catch {
    // not JSON; fall through to raw text
  }
  return text.trim() || response.statusText || "no details";
}

function toWireRequest(request: StreamRequest) {
  return {
    model: request.model,
    messages: request.messages.map(toWireMessage),
    stream: true,
    stream_options: { include_usage: true },
    ...(request.tools.length > 0 && {
      tools: request.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      })),
    }),
  };
}

function toWireMessage(message: Message): WireMessage {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content };
    case "assistant":
      if (message.toolCalls.length === 0) return { role: "assistant", content: message.content };
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      };
    case "tool_result":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
}
