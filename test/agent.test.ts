import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, type AgentEvent, type AgentOptions } from "../src/agent.ts";
import { readTool } from "../src/tools/read.ts";
import type { ToolCall } from "../src/messages.ts";
import type { Tool } from "../src/tools/tool.ts";
import { call, callTools, FakeProvider, reply, type ScriptedStep } from "./support/fake-provider.ts";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "rocode-agent-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function setup(steps: ScriptedStep[], options: Partial<AgentOptions> = {}) {
  const provider = new FakeProvider(steps);
  const agent = createAgent({ provider, model: "fake-model", cwd, tools: [readTool], ...options });
  return { agent, provider };
}

/** Appends its label to log.txt, optionally after a delay. Makes execution order observable on disk. */
const logTool: Tool<{ label: string; delayMs?: number }> = {
  name: "log",
  description: "Append a label to log.txt",
  inputSchema: {
    type: "object",
    properties: { label: { type: "string" }, delayMs: { type: "integer" } },
    required: ["label"],
  },
  requiresApproval: false,
  async execute({ label, delayMs = 0 }, { cwd }) {
    await Bun.sleep(delayMs);
    await appendFile(join(cwd, "log.txt"), `${label}\n`);
    return { content: `logged ${label}`, isError: false };
  },
};

/** Runs a one-Tool-Call Turn and returns that call's Tool Result Message. */
async function toolResultFor(toolCall: ToolCall, options: Partial<AgentOptions> = {}) {
  const { agent } = setup([callTools([toolCall]), reply("ok")], options);
  const events = await runTurn(agent, "go");
  expect(events.at(-1)).toEqual({ type: "turn_finished", reason: "completed" });
  const result = agent.messages.find((m) => m.role === "tool_result");
  if (!result) throw new Error("no Tool Result recorded");
  return result;
}

async function runTurn(agent: ReturnType<typeof createAgent>, text: string) {
  const events: AgentEvent[] = [];
  for await (const event of agent.runTurn(text, new AbortController().signal)) events.push(event);
  return events;
}

describe("Agent", () => {
  test("a reply without Tool Calls is a one-Step Turn", async () => {
    const { agent } = setup([reply("Hel", "lo!")]);

    const events = await runTurn(agent, "hi");

    expect(events).toEqual([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo!" },
      { type: "step_finished", step: 1 },
      { type: "turn_finished", reason: "completed" },
    ]);
    expect(agent.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello!", toolCalls: [] },
    ]);
  });

  test("the Model reads a file, gets the Tool Result back, and answers", async () => {
    await writeFile(join(cwd, "greeting.txt"), "hello\nworld\n");
    const readGreeting = call("call_1", "read", { path: "greeting.txt" });
    const { agent, provider } = setup([callTools([readGreeting]), reply("It says hello world.")]);

    const events = await runTurn(agent, "what's in greeting.txt?");

    const toolResult = {
      role: "tool_result",
      toolCallId: "call_1",
      toolName: "read",
      content: "1\thello\n2\tworld",
      isError: false,
    } as const;
    expect(events).toEqual([
      { type: "tool_call_started", toolCall: readGreeting },
      {
        type: "tool_call_finished",
        toolCall: readGreeting,
        isError: false,
        preview: "1\thello (+1 more line)",
      },
      { type: "step_finished", step: 1 },
      { type: "text_delta", text: "It says hello world." },
      { type: "step_finished", step: 2 },
      { type: "turn_finished", reason: "completed" },
    ]);
    expect(agent.messages).toEqual([
      { role: "user", content: "what's in greeting.txt?" },
      { role: "assistant", content: "", toolCalls: [readGreeting] },
      toolResult,
      { role: "assistant", content: "It says hello world.", toolCalls: [] },
    ]);
    expect(provider.requests.at(-1)!.at(-1)).toEqual(toolResult);
  });

  test("several Tool Calls in one Step run one at a time, in the Model's order", async () => {
    const slow = call("c1", "log", { label: "first", delayMs: 30 });
    const fast = call("c2", "log", { label: "second" });
    const { agent } = setup([callTools([slow, fast]), reply("done")], { tools: [logTool] });

    const events = await runTurn(agent, "log twice");

    expect(await readFile(join(cwd, "log.txt"), "utf8")).toBe("first\nsecond\n");
    expect(events.slice(0, 4).map((e) => [e.type, "toolCall" in e ? e.toolCall.id : null])).toEqual([
      ["tool_call_started", "c1"],
      ["tool_call_finished", "c1"],
      ["tool_call_started", "c2"],
      ["tool_call_finished", "c2"],
    ]);
    expect(agent.messages.filter((m) => m.role === "tool_result").map((m) => m.content)).toEqual([
      "logged first",
      "logged second",
    ]);
  });

  describe("Step limit", () => {
    /** A Model that never stops calling Tools. */
    const loopForever = (steps: number) =>
      Array.from({ length: steps }, (_, i) => callTools([call(`c${i + 1}`, "log", { label: `step ${i + 1}` })]));

    test("a Turn that reaches maxSteps ends with a step-limit reason", async () => {
      const { agent } = setup(loopForever(5), { tools: [logTool], maxSteps: 2 });

      const events = await runTurn(agent, "go");

      expect(events.slice(-2)).toEqual([
        { type: "step_finished", step: 2 },
        { type: "turn_finished", reason: "step_limit" },
      ]);
      expect(await readFile(join(cwd, "log.txt"), "utf8")).toBe("step 1\nstep 2\n");
      expect(agent.messages.map((m) => m.role)).toEqual([
        "user",
        "assistant",
        "tool_result",
        "assistant",
        "tool_result",
      ]);
    });

    test("defaults to 25 Steps", async () => {
      const { agent } = setup(loopForever(30), { tools: [logTool] });

      const events = await runTurn(agent, "go");

      expect(events.filter((e) => e.type === "step_finished")).toHaveLength(25);
      expect(events.at(-1)).toEqual({ type: "turn_finished", reason: "step_limit" });
    });
  });

  describe("Provider errors end the Turn without throwing", () => {
    const rateLimited = { kind: "rate_limit", message: "slow down" } as const;

    test("a failure in the first Step drops the user Message so a retry starts clean", async () => {
      const { agent } = setup([[{ type: "text_delta", text: "Par" }, { type: "error", error: rateLimited }]]);

      const events = await runTurn(agent, "hi");

      expect(events).toEqual([
        { type: "text_delta", text: "Par" },
        { type: "turn_finished", reason: "error", error: rateLimited },
      ]);
      expect(agent.messages).toEqual([]);
    });

    test("a failure in a later Step keeps the Steps that completed", async () => {
      const logOnce = call("c1", "log", { label: "once" });
      const { agent } = setup(
        [callTools([logOnce]), [{ type: "text_delta", text: "Par" }, { type: "error", error: rateLimited }]],
        { tools: [logTool] },
      );

      const events = await runTurn(agent, "log once");

      expect(events.at(-1)).toEqual({ type: "turn_finished", reason: "error", error: rateLimited });
      expect(agent.messages).toEqual([
        { role: "user", content: "log once" },
        { role: "assistant", content: "", toolCalls: [logOnce] },
        { role: "tool_result", toolCallId: "c1", toolName: "log", content: "logged once", isError: false },
      ]);
    });
  });

  describe("bad Tool Calls become error Tool Results the Model can recover from", () => {
    test("an unknown Tool lists the available Tools", async () => {
      const result = await toolResultFor(call("c1", "grep", { pattern: "x" }), { tools: [readTool, logTool] });

      expect(result.isError).toBe(true);
      expect(result.content).toBe('Unknown tool "grep". Available tools: read, log.');
    });

    test.each([
      ["a missing required argument", {}, 'Invalid arguments for tool "read": missing required property "path".'],
      ["a wrong type", { path: 42 }, 'Invalid arguments for tool "read": "path" must be a string, got number.'],
      [
        "a fractional integer",
        { path: "a.txt", offset: 1.5 },
        'Invalid arguments for tool "read": "offset" must be an integer, got 1.5.',
      ],
      ["a JSON string instead of an object", "a.txt", 'Invalid arguments for tool "read": expected a JSON object, got string.'],
      ["an array", ["a.txt"], 'Invalid arguments for tool "read": expected a JSON object, got array.'],
    ])("%s explains what to fix", async (_, args, message) => {
      const result = await toolResultFor(call("c1", "read", args));

      expect(result).toMatchObject({ isError: true, content: message });
    });

    test("arguments that weren't valid JSON are quoted back so the Model can fix them", async () => {
      const result = await toolResultFor({ id: "c1", name: "read", arguments: null, unparsedArguments: '{"path": "a.txt"' });

      expect(result).toMatchObject({
        isError: true,
        content: 'Invalid arguments for tool "read": not valid JSON: {"path": "a.txt"',
      });
    });

    test("a Tool that throws reports the failure instead of crashing the loop", async () => {
      const broken: Tool = {
        name: "broken",
        description: "Always fails",
        inputSchema: { type: "object", properties: {} },
        requiresApproval: false,
        async execute() {
          throw new Error("disk on fire");
        },
      };

      const result = await toolResultFor(call("c1", "broken", {}), { tools: [broken] });

      expect(result).toMatchObject({ isError: true, content: 'Tool "broken" failed: disk on fire' });
    });
  });

  describe("read", () => {
    beforeEach(async () => {
      await writeFile(join(cwd, "abc.txt"), "a\nb\nc\nd\ne\n");
    });

    test("offset and limit return a window of lines, with a hint for reading on", async () => {
      const result = await toolResultFor(call("c1", "read", { path: "abc.txt", offset: 2, limit: 2 }));

      expect(result).toMatchObject({
        isError: false,
        content: "2\tb\n3\tc\n\n(Showing lines 2-3 of 5. Use offset=4 to read more.)",
      });
    });

    test("a window reaching the end of the file needs no hint", async () => {
      const result = await toolResultFor(call("c1", "read", { path: "abc.txt", offset: 4, limit: 10 }));

      expect(result).toMatchObject({ isError: false, content: "4\td\n5\te" });
    });

    test("an offset past the end of the file is an error", async () => {
      const result = await toolResultFor(call("c1", "read", { path: "abc.txt", offset: 9 }));

      expect(result).toMatchObject({
        isError: true,
        content: "offset 9 is past the end of abc.txt, which has 5 lines.",
      });
    });

    test("paths resolve against the working directory, and absolute paths work too", async () => {
      await mkdir(join(cwd, "src"));
      await writeFile(join(cwd, "src", "x.ts"), "export {};\n");

      const relative = await toolResultFor(call("c1", "read", { path: "src/x.ts" }));
      const absolute = await toolResultFor(call("c1", "read", { path: join(cwd, "src", "x.ts") }));

      expect(relative.content).toBe("1\texport {};");
      expect(absolute.content).toBe("1\texport {};");
    });

    test("a missing file is an error", async () => {
      const result = await toolResultFor(call("c1", "read", { path: "nope.txt" }));

      expect(result).toMatchObject({ isError: true, content: "File not found: nope.txt" });
    });

    test("a directory is an error", async () => {
      await mkdir(join(cwd, "src"));

      const result = await toolResultFor(call("c1", "read", { path: "src" }));

      expect(result).toMatchObject({ isError: true, content: "src is a directory, not a file." });
    });

    test("an empty file says so", async () => {
      await writeFile(join(cwd, "empty.txt"), "");

      const result = await toolResultFor(call("c1", "read", { path: "empty.txt" }));

      expect(result).toMatchObject({ isError: false, content: "(empty.txt is empty)" });
    });
  });
});
