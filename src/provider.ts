import type { Message, Usage } from "./messages.ts";

/** How a Tool is described to the Model. */
export type ToolDefinition = {
  name: string;
  description: string;
  /** JSON Schema for the Tool's input. */
  inputSchema: Record<string, unknown>;
};

export type ProviderErrorKind =
  | "auth" // 401: missing or bad API key
  | "rate_limit" // 429
  | "invalid_model" // unknown Model id
  | "server" // 5xx, or an error reported mid-stream
  | "network" // the request never got a response
  | "aborted" // the caller's abort signal fired
  | "bad_request"; // any other non-2xx response

export type ProviderError = {
  kind: ProviderErrorKind;
  /** Human-readable, safe to print as-is. */
  message: string;
  status?: number;
};

export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "done" }
  | { type: "error"; error: ProviderError };

export type StreamRequest = {
  messages: Message[];
  tools: ToolDefinition[];
  model: string;
  signal: AbortSignal;
};

/**
 * A Provider serves Models through a specific wire format.
 * `stream` never throws: failures arrive as a final `error` event,
 * success ends with a `done` event.
 */
export interface Provider {
  readonly name: string;
  stream(request: StreamRequest): AsyncIterable<ProviderEvent>;
}

/** The subset of `fetch` a Provider needs; injected so tests can replay fixtures. */
export type HttpFn = (url: string, init: RequestInit) => Promise<Response>;
