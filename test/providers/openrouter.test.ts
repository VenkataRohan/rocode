import { describe, expect, test } from "bun:test";
import { createOpenRouterProvider } from "../../src/providers/openrouter.ts";
import type { HttpFn, ProviderEvent, StreamRequest } from "../../src/provider.ts";

const fixture = (name: string) =>
  Bun.file(new URL(`../fixtures/openrouter/${name}`, import.meta.url)).text();

/** An HTTP function that replays a canned response and records what was sent. */
function replay(body: string | ReadableStream<Uint8Array>, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const http: HttpFn = async (url, init) => {
    calls.push({ url, init });
    return new Response(body, {
      status,
      headers: { "content-type": status === 200 ? "text/event-stream" : "application/json" },
    });
  };
  return { http, calls };
}

async function collect(events: AsyncIterable<ProviderEvent>) {
  const out: ProviderEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const request = (overrides: Partial<StreamRequest> = {}): StreamRequest => ({
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  model: "google/gemma-4-31b-it:free",
  signal: new AbortController().signal,
  ...overrides,
});

describe("OpenRouter Provider", () => {
  test("streams text deltas, then usage, then done", async () => {
    const { http } = replay(await fixture("text-stream.sse"));
    const provider = createOpenRouterProvider({ apiKey: "sk-test", http });

    const events = await collect(provider.stream(request()));

    expect(events).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " there" },
      { type: "text_delta", text: "!" },
      { type: "usage", usage: { inputTokens: 12, outputTokens: 3 } },
      { type: "done" },
    ]);
  });

  test("sends the whole conversation, Tool definitions, and the API key", async () => {
    const { http, calls } = replay(await fixture("text-stream.sse"));
    const provider = createOpenRouterProvider({ apiKey: "sk-test", http });

    await collect(
      provider.stream(
        request({
          model: "some/model:free",
          messages: [
            { role: "user", content: "what's in a.txt?" },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "call_1", name: "read", arguments: { path: "a.txt" } }],
            },
            {
              role: "tool_result",
              toolCallId: "call_1",
              toolName: "read",
              content: "1\thello",
              isError: false,
            },
            { role: "assistant", content: "It says hello.", toolCalls: [] },
            { role: "user", content: "thanks" },
          ],
          tools: [
            {
              name: "read",
              description: "Read a file",
              inputSchema: { type: "object", properties: { path: { type: "string" } } },
            },
          ],
        }),
      ),
    );

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(call!.init.method).toBe("POST");
    expect(new Headers(call!.init.headers).get("authorization")).toBe("Bearer sk-test");
    expect(JSON.parse(call!.init.body as string)).toEqual({
      model: "some/model:free",
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "user", content: "what's in a.txt?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read", arguments: '{"path":"a.txt"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "1\thello" },
        { role: "assistant", content: "It says hello." },
        { role: "user", content: "thanks" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
    });
  });

  test("omits the tools field when there are no Tools", async () => {
    const { http, calls } = replay(await fixture("text-stream.sse"));
    const provider = createOpenRouterProvider({ apiKey: "sk-test", http });

    await collect(provider.stream(request()));

    expect(JSON.parse(calls[0]!.init.body as string)).not.toHaveProperty("tools");
  });

  describe("errors end the stream with a typed error event", () => {
    test("401 becomes an auth error pointing at OPENROUTER_API_KEY", async () => {
      const { http } = replay(await fixture("error-401.json"), 401);
      const provider = createOpenRouterProvider({ apiKey: "sk-bad", http });

      const events = await collect(provider.stream(request()));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "error", error: { kind: "auth", status: 401 } });
      expect(errorMessage(events[0])).toContain("OPENROUTER_API_KEY");
    });

    test.each([
      ["error-429.json", 429, "rate_limit", "rate limit"],
      ["error-400-invalid-model.json", 400, "invalid_model", "not-a/real-model"],
      ["error-404-no-endpoints.json", 404, "invalid_model", "not-a/real-model"],
      ["error-502.json", 502, "server", "502"],
    ] as const)("%s becomes a %p %s error", async (file, status, kind, mentions) => {
      const { http } = replay(await fixture(file), status);
      const provider = createOpenRouterProvider({ apiKey: "sk-test", http });

      const events = await collect(provider.stream(request({ model: "not-a/real-model" })));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "error", error: { kind, status } });
      expect(errorMessage(events[0]).toLowerCase()).toContain(mentions);
    });

    test("a request that never gets a response becomes a network error", async () => {
      const http: HttpFn = async () => {
        throw new TypeError("Unable to connect. Is the computer able to access the url?");
      };
      const provider = createOpenRouterProvider({ apiKey: "sk-test", http });

      const events = await collect(provider.stream(request()));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "error", error: { kind: "network" } });
      expect(errorMessage(events[0])).toContain("Unable to connect");
    });

    test("an abort before the response becomes an aborted error", async () => {
      const controller = new AbortController();
      const http: HttpFn = async (_url, init) => {
        controller.abort();
        init.signal?.throwIfAborted();
        throw new Error("unreachable");
      };
      const provider = createOpenRouterProvider({ apiKey: "sk-test", http });

      const events = await collect(provider.stream(request({ signal: controller.signal })));

      expect(events).toEqual([{ type: "error", error: expect.objectContaining({ kind: "aborted" }) }]);
    });

    test("an error reported mid-stream keeps earlier text and ends with a server error", async () => {
      const { http } = replay(await fixture("midstream-error.sse"));
      const provider = createOpenRouterProvider({ apiKey: "sk-test", http });

      const events = await collect(provider.stream(request()));

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: "text_delta", text: "Partial" });
      expect(events[1]).toMatchObject({ type: "error", error: { kind: "server" } });
      expect(errorMessage(events[1])).toContain("Provider disconnected unexpectedly");
    });

    test("a connection that drops mid-stream becomes a network error", async () => {
      const encoder = new TextEncoder();
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls++ === 0) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n'),
            );
          } else {
            controller.error(new Error("socket hang up"));
          }
        },
      });
      const { http } = replay(body);
      const provider = createOpenRouterProvider({ apiKey: "sk-test", http });

      const events = await collect(provider.stream(request()));

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: "text_delta", text: "Hel" });
      expect(events[1]).toMatchObject({ type: "error", error: { kind: "network" } });
    });
  });

  test("events split across network chunks are reassembled", async () => {
    const text = await fixture("text-stream.sse");
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Deliver 7 bytes at a time so lines and JSON are cut mid-way.
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    });
    const { http } = replay(body);
    const provider = createOpenRouterProvider({ apiKey: "sk-test", http });

    const events = await collect(provider.stream(request()));

    expect(events.filter((e) => e.type === "text_delta")).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: " there" },
      { type: "text_delta", text: "!" },
    ]);
    expect(events.at(-1)).toEqual({ type: "done" });
  });
});

function errorMessage(event: ProviderEvent | undefined): string {
  if (event?.type !== "error") throw new Error(`expected an error event, got ${JSON.stringify(event)}`);
  return event.error.message;
}
