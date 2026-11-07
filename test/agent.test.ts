import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveAll,
  createAgent,
  type AgentEvent,
  type AgentOptions,
  type ApprovalDecision,
  type ApprovalHandler,
  type ApprovalRequest,
} from "../src/agent.ts";
import { readTool } from "../src/tools/read.ts";
import { createBashTool } from "../src/tools/bash.ts";
import { writeTool } from "../src/tools/write.ts";
import { editTool } from "../src/tools/edit.ts";
import type { ToolCall } from "../src/messages.ts";
import type { Tool } from "../src/tools/tool.ts";
import { call, callTools, FakeProvider, HANG, reply, type ScriptedStep } from "./support/fake-provider.ts";

const CANCELLED = "Cancelled by the user: the Turn was interrupted before this tool call ran.";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "rocode-agent-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/** Starts a long-lived background process and records its pid, to check later that it was killed. */
const BACKGROUND_SLEEP = "sleep 30 & echo $! > bg.pid";
async function backgroundProcessAlive() {
  const pid = Number(await readFile(join(cwd, "bg.pid"), "utf8"));
  await Bun.sleep(50); // let the kernel reap it
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function setup(steps: ScriptedStep[], options: Partial<AgentOptions> = {}) {
  const provider = new FakeProvider(steps);
  const agent = createAgent({ provider, model: "fake-model", cwd, tools: [readTool], approve: approveAll, ...options });
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

/** Like logTool, but each run needs the user's Approval. */
const guardedLogTool: Tool<{ label: string }> = { ...logTool, name: "guarded_log", requiresApproval: true };

/** An Approval handler that answers with scripted decisions, in order, and records what it was asked. */
function scriptedApprovals(...decisions: ApprovalDecision[]) {
  const requests: ApprovalRequest[] = [];
  const approve: ApprovalHandler = async (request) => {
    requests.push(request);
    const decision = decisions.shift();
    if (!decision) throw new Error(`unexpected Approval request for ${request.toolCall.name}`);
    return decision;
  };
  return { approve, requests };
}

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

  describe("bash", () => {
    const bash = (command: string, options: { timeoutMs?: number } = {}) =>
      toolResultFor(call("c1", "bash", { command }), { tools: [createBashTool(options)] });

    test("runs in the working directory and returns combined output with the exit code", async () => {
      await writeFile(join(cwd, "hello.txt"), "hi\n");

      const result = await bash("ls; echo oops >&2; echo done");

      expect(result).toMatchObject({ isError: false, content: "hello.txt\noops\ndone\n\n(exit code 0)" });
    });

    test("a non-zero exit is reported to the Model and the Turn carries on", async () => {
      const result = await bash("echo failing tests; exit 3");

      expect(result).toMatchObject({ isError: false, content: "failing tests\n\n(exit code 3)" });
    });

    test("a command with no output says so", async () => {
      const result = await bash("true");

      expect(result).toMatchObject({ isError: false, content: "(no output)\n(exit code 0)" });
    });

    test("multi-byte characters survive large output", async () => {
      const result = await bash("for i in $(seq 50000); do printf 'é'; done");

      expect(result.content).toBe(`${"é".repeat(50000)}\n\n(exit code 0)`);
    });

    test("finishes when the command does, killing processes it left in the background", async () => {
      const started = Date.now();

      const result = await bash(`echo hi; ${BACKGROUND_SLEEP}`, { timeoutMs: 5000 });

      expect(Date.now() - started).toBeLessThan(2000);
      expect(result).toMatchObject({ isError: false, content: "hi\n\n(exit code 0)" });
      expect(await backgroundProcessAlive()).toBe(false);
    });

    test("a command that runs too long is killed, with its partial output and a timeout note", async () => {
      const started = Date.now();

      const result = await bash(`echo started; ${BACKGROUND_SLEEP}; wait`, { timeoutMs: 100 });

      expect(Date.now() - started).toBeLessThan(2000);
      expect(result).toMatchObject({
        isError: true,
        content: "started\n\n(Command timed out after 0.1s and was killed.)",
      });
      expect(await backgroundProcessAlive()).toBe(false);
    });

    test("a process that escapes the process group can't stretch the timeout", async () => {
      const started = Date.now();

      const result = await bash("perl -e 'setpgrp(0, 0); sleep 3' & wait", { timeoutMs: 100 });

      expect(Date.now() - started).toBeLessThan(2000);
      expect(result.isError).toBe(true);
    });
  });

  describe("write", () => {
    const write = (args: unknown) => toolResultFor(call("c1", "write", args), { tools: [writeTool] });

    test("creates a file, and any missing parent directories", async () => {
      const result = await write({ path: "src/deep/new.ts", content: "export const x = 1;\n" });

      expect(result).toMatchObject({ isError: false, content: "Created src/deep/new.ts (1 line)." });
      expect(await readFile(join(cwd, "src/deep/new.ts"), "utf8")).toBe("export const x = 1;\n");
    });

    test("overwrites an existing file", async () => {
      await writeFile(join(cwd, "a.txt"), "old\nold\nold\n");

      const result = await write({ path: "a.txt", content: "new\nnew\n" });

      expect(result).toMatchObject({ isError: false, content: "Overwrote a.txt (2 lines)." });
      expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("new\nnew\n");
    });

    test("a path that is a directory is an error", async () => {
      await mkdir(join(cwd, "src"));

      const result = await write({ path: "src", content: "x" });

      expect(result).toMatchObject({ isError: true, content: "src is a directory, not a file." });
    });
  });

  describe("edit", () => {
    const edit = (args: unknown) => toolResultFor(call("c1", "edit", args), { tools: [editTool] });
    const source = "function add(a, b) {\n  return a - b;\n}\n";

    beforeEach(async () => {
      await writeFile(join(cwd, "math.js"), source);
    });

    test("replaces the one occurrence of the old string with the new string", async () => {
      const result = await edit({ path: "math.js", old_string: "return a - b;", new_string: "return a + b;" });

      expect(result).toMatchObject({ isError: false, content: "Edited math.js." });
      expect(await readFile(join(cwd, "math.js"), "utf8")).toBe("function add(a, b) {\n  return a + b;\n}\n");
    });

    test("an old string that isn't in the file tells the Model to re-read it, and changes nothing", async () => {
      const result = await edit({ path: "math.js", old_string: "return a-b;", new_string: "return a + b;" });

      expect(result).toMatchObject({
        isError: true,
        content:
          "old_string was not found in math.js. It must match the file exactly, including whitespace and indentation. " +
          "Re-read the file with read, then retry with the exact text.",
      });
      expect(await readFile(join(cwd, "math.js"), "utf8")).toBe(source);
    });

    test("an old string that occurs more than once asks for more context, and changes nothing", async () => {
      const twice = "let a = 0;\nlet b = 0;\nlet c = 1;\nlet d = 0;\n";
      await writeFile(join(cwd, "vars.js"), twice);

      const result = await edit({ path: "vars.js", old_string: " = 0;", new_string: " = 2;" });

      expect(result).toMatchObject({
        isError: true,
        content:
          "old_string matched 3 times in vars.js (lines 1, 2, 4) — add more surrounding context so it matches exactly once.",
      });
      expect(await readFile(join(cwd, "vars.js"), "utf8")).toBe(twice);
    });

    test("the Model recovers from a not-found edit by re-reading the file and retrying", async () => {
      const guess = call("c1", "edit", { path: "math.js", old_string: "return a-b;", new_string: "return a + b;" });
      const reread = call("c2", "read", { path: "math.js" });
      const retry = call("c3", "edit", { path: "math.js", old_string: "  return a - b;", new_string: "  return a + b;" });
      const { agent, provider } = setup(
        [callTools([guess]), callTools([reread]), callTools([retry]), reply("Fixed the subtraction.")],
        { tools: [readTool, editTool] },
      );

      const events = await runTurn(agent, "add() subtracts; fix it");

      expect(events.at(-1)).toEqual({ type: "turn_finished", reason: "completed" });
      const results = agent.messages.filter((m) => m.role === "tool_result");
      expect(results.map((r) => [r.toolCallId, r.isError])).toEqual([
        ["c1", true],
        ["c2", false],
        ["c3", false],
      ]);
      // The Model saw the not-found hint before it chose to re-read.
      expect(provider.requests[1]!.at(-1)).toMatchObject({ toolCallId: "c1", content: expect.stringContaining("Re-read") });
      expect(await readFile(join(cwd, "math.js"), "utf8")).toBe("function add(a, b) {\n  return a + b;\n}\n");
    });

    test("overlapping occurrences count as more than one match", async () => {
      await writeFile(join(cwd, "a.txt"), "aaa");

      const result = await edit({ path: "a.txt", old_string: "aa", new_string: "b" });

      expect(result.content).toStartWith("old_string matched 2 times in a.txt (lines 1, 1)");
      expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("aaa");
    });

    test("a CRLF file matches multi-line text as read shows it, and keeps its CRLF line endings", async () => {
      await writeFile(join(cwd, "win.js"), "function add(a, b) {\r\n  return a - b;\r\n}\r\n");

      const result = await edit({
        path: "win.js",
        old_string: "function add(a, b) {\n  return a - b;",
        new_string: "function add(a, b) {\n  // fixed\n  return a + b;",
      });

      expect(result).toMatchObject({ isError: false });
      expect(await readFile(join(cwd, "win.js"), "utf8")).toBe(
        "function add(a, b) {\r\n  // fixed\r\n  return a + b;\r\n}\r\n",
      );
    });

    test("an empty old string is rejected, pointing at write", async () => {
      const result = await edit({ path: "math.js", old_string: "", new_string: "x" });

      expect(result).toMatchObject({
        isError: true,
        content: "old_string must not be empty. To create a file or replace all of its content, use write.",
      });
      expect(await readFile(join(cwd, "math.js"), "utf8")).toBe(source);
    });

    test("a missing file is an error that suggests write", async () => {
      const result = await edit({ path: "nope.js", old_string: "a", new_string: "b" });

      expect(result).toMatchObject({ isError: true, content: "File not found: nope.js. To create a file, use write." });
    });
  });

  describe("Approvals", () => {
    const logged = () => readFile(join(cwd, "log.txt"), "utf8").catch(() => "");

    test("a Tool that requires Approval asks first, and runs once when allowed once", async () => {
      const logA = call("c1", "guarded_log", { label: "a" });
      const { approve, requests } = scriptedApprovals("once");
      const { agent } = setup([callTools([logA]), reply("done")], { tools: [guardedLogTool], approve });

      const events = await runTurn(agent, "log a");

      expect(events.slice(0, 4)).toEqual([
        { type: "tool_call_started", toolCall: logA },
        { type: "approval_requested", toolCall: logA, subject: 'label: "a"' },
        { type: "approval_resolved", toolCall: logA, decision: "once" },
        { type: "tool_call_finished", toolCall: logA, isError: false, preview: "logged a" },
      ]);
      expect(requests).toEqual([{ toolCall: logA, subject: 'label: "a"' }]);
      expect(await logged()).toBe("a\n");
    });

    test("a denied Tool Call doesn't run; the Model is told the user denied it and the Turn continues", async () => {
      const logA = call("c1", "guarded_log", { label: "a" });
      const { approve } = scriptedApprovals("deny");
      const { agent, provider } = setup([callTools([logA]), reply("Okay, I won't.")], { tools: [guardedLogTool], approve });

      const events = await runTurn(agent, "log a");

      expect(events).toContainEqual({ type: "approval_resolved", toolCall: logA, decision: "deny" });
      expect(events.at(-1)).toEqual({ type: "turn_finished", reason: "completed" });
      expect(await logged()).toBe("");
      const denial = {
        role: "tool_result",
        toolCallId: "c1",
        toolName: "guarded_log",
        content: "The user denied this guarded_log call, so it did not run. Try a different approach, or ask the user how to proceed.",
        isError: true,
      } as const;
      expect(provider.requests.at(-1)!.at(-1)).toEqual(denial);
    });

    test('"always" stops asking for that Tool for the rest of the Session, but not for other Tools', async () => {
      const otherTool: Tool<{ label: string }> = { ...guardedLogTool, name: "other_log" };
      const { approve, requests } = scriptedApprovals("always", "once");
      const { agent } = setup(
        [
          callTools([call("c1", "guarded_log", { label: "a" }), call("c2", "guarded_log", { label: "b" })]),
          reply("done"),
          callTools([call("c3", "guarded_log", { label: "c" }), call("c4", "other_log", { label: "d" })]),
          reply("done"),
        ],
        { tools: [guardedLogTool, otherTool], approve },
      );

      await runTurn(agent, "log a and b");
      const secondTurn = await runTurn(agent, "log c and d");

      expect(requests.map((r) => r.toolCall.id)).toEqual(["c1", "c4"]);
      expect(secondTurn.filter((e) => e.type === "approval_requested").map((e) => "toolCall" in e && e.toolCall.id)).toEqual(["c4"]);
      expect(await logged()).toBe("a\nb\nc\nd\n");
    });

    test('"always" grants belong to one Session: a new Agent asks again', async () => {
      const first = scriptedApprovals("always");
      await toolResultFor(call("c1", "guarded_log", { label: "a" }), { tools: [guardedLogTool], approve: first.approve });
      const second = scriptedApprovals("once");
      await toolResultFor(call("c1", "guarded_log", { label: "b" }), { tools: [guardedLogTool], approve: second.approve });

      expect(second.requests).toHaveLength(1);
    });

    test("read never asks", async () => {
      await writeFile(join(cwd, "a.txt"), "hi\n");
      const { approve, requests } = scriptedApprovals();

      const result = await toolResultFor(call("c1", "read", { path: "a.txt" }), { approve });

      expect(result).toMatchObject({ isError: false, content: "1\thi" });
      expect(requests).toEqual([]);
    });

    test("an invalid Tool Call is rejected without asking", async () => {
      const { approve, requests } = scriptedApprovals();

      const result = await toolResultFor(call("c1", "guarded_log", {}), { tools: [guardedLogTool], approve });

      expect(result.isError).toBe(true);
      expect(requests).toEqual([]);
    });

    test("bash asks with the full command", async () => {
      const command = `echo ${"x".repeat(200)} && echo done`;
      const { approve, requests } = scriptedApprovals("once");

      await toolResultFor(call("c1", "bash", { command }), { tools: [createBashTool()], approve });

      expect(requests.map((r) => r.subject)).toEqual([command]);
    });

    test.each([
      ["write", writeTool, { path: "src/a.ts", content: "b\n".repeat(500) }],
      ["edit", editTool, { path: "src/a.ts", old_string: "a", new_string: "b" }],
    ])("%s asks with the target path, and a denial leaves the file alone", async (name, tool, args) => {
      await mkdir(join(cwd, "src"));
      await writeFile(join(cwd, "src/a.ts"), "a\n");
      const { approve, requests } = scriptedApprovals("deny");

      await toolResultFor(call("c1", name, args), { tools: [tool], approve });

      expect(requests.map((r) => r.subject)).toEqual(["src/a.ts"]);
      expect(await readFile(join(cwd, "src/a.ts"), "utf8")).toBe("a\n");
    });

    test("yolo approves every Tool Call without asking the user", async () => {
      const result = await toolResultFor(call("c1", "bash", { command: "echo hi > out.txt" }), {
        tools: [createBashTool()],
        approve: approveAll,
      });

      expect(result).toMatchObject({ isError: false });
      expect(await readFile(join(cwd, "out.txt"), "utf8")).toBe("hi\n");
    });
  });

  describe("Interrupts", () => {
    /** Runs a Turn, letting `onEvent` decide when to interrupt it (like the user pressing Ctrl+C). */
    async function interruptedTurn(
      agent: ReturnType<typeof createAgent>,
      onEvent: (event: AgentEvent, abort: () => void) => void,
    ) {
      const controller = new AbortController();
      const events: AgentEvent[] = [];
      for await (const event of agent.runTurn("go", controller.signal)) {
        events.push(event);
        onEvent(event, () => controller.abort());
      }
      return events;
    }

    test("interrupting mid-stream cancels the stream and keeps the partial reply, marked interrupted", async () => {
      const { agent, provider } = setup([[{ type: "text_delta", text: "Let me" }, HANG]]);

      const events = await interruptedTurn(agent, (e, abort) => e.type === "text_delta" && abort());

      expect(events).toEqual([
        { type: "text_delta", text: "Let me" },
        { type: "turn_finished", reason: "interrupted" },
      ]);
      expect(provider.aborted).toEqual([true]);
      expect(agent.messages).toEqual([
        { role: "user", content: "go" },
        { role: "assistant", content: "Let me", toolCalls: [], interrupted: true },
      ]);
    });

    test("Tool Calls in a reply cut off mid-stream never run, and get a cancelled Tool Result", async () => {
      const logA = call("c1", "log", { label: "a" });
      const { agent, provider } = setup([[{ type: "tool_call", toolCall: logA }, { type: "text_delta", text: "and" }, HANG]], {
        tools: [logTool],
      });

      const events = await interruptedTurn(agent, (e, abort) => e.type === "text_delta" && abort());

      expect(events.at(-1)).toEqual({ type: "turn_finished", reason: "interrupted" });
      expect(agent.messages).toEqual([
        { role: "user", content: "go" },
        { role: "assistant", content: "and", toolCalls: [logA], interrupted: true },
        { role: "tool_result", toolCallId: "c1", toolName: "log", content: CANCELLED, isError: true },
      ]);
      expect(await Bun.file(join(cwd, "log.txt")).exists()).toBe(false);
      expect(provider.requests).toHaveLength(1);
    });

    test("interrupting mid-bash kills the command, cancels the Tool Calls after it, and ends the Turn", async () => {
      const bash = call("c1", "bash", { command: `echo started; ${BACKGROUND_SLEEP}; wait` });
      const logA = call("c2", "log", { label: "a" });
      const { agent, provider } = setup([callTools([bash, logA]), reply("never sent")], {
        tools: [createBashTool(), logTool],
      });
      const started = Date.now();

      const events = await interruptedTurn(agent, (e, abort) => {
        if (e.type === "tool_call_started" && e.toolCall.id === "c1") setTimeout(abort, 100);
      });

      expect(Date.now() - started).toBeLessThan(2000);
      expect(events.at(-1)).toEqual({ type: "turn_finished", reason: "interrupted" });
      expect(agent.messages.slice(1)).toEqual([
        { role: "assistant", content: "", toolCalls: [bash, logA], interrupted: true },
        {
          role: "tool_result",
          toolCallId: "c1",
          toolName: "bash",
          content: "started\n\n(Command was interrupted and killed.)",
          isError: true,
        },
        { role: "tool_result", toolCallId: "c2", toolName: "log", content: CANCELLED, isError: true },
      ]);
      expect(await backgroundProcessAlive()).toBe(false);
      expect(await Bun.file(join(cwd, "log.txt")).exists()).toBe(false);
      expect(provider.requests).toHaveLength(1);
    });

    test("interrupting during an Approval prompt denies the call and interrupts the Turn", async () => {
      const guarded = call("c1", "guarded_log", { label: "a" });
      /** Like the REPL: waits for an answer that never comes, and denies once the Turn is interrupted. */
      const waitForCtrlC: ApprovalHandler = (_, signal) =>
        new Promise((resolve) => {
          if (signal.aborted) resolve("deny");
          signal.addEventListener("abort", () => resolve("deny"), { once: true });
        });
      const { agent, provider } = setup([callTools([guarded]), reply("never sent")], {
        tools: [guardedLogTool],
        approve: waitForCtrlC,
      });

      const events = await interruptedTurn(agent, (e, abort) => {
        if (e.type === "approval_requested") setTimeout(abort, 10);
      });

      expect(events.slice(-3)).toEqual([
        { type: "approval_resolved", toolCall: guarded, decision: "deny" },
        { type: "tool_call_finished", toolCall: guarded, isError: true, preview: CANCELLED },
        { type: "turn_finished", reason: "interrupted" },
      ]);
      expect(agent.messages.at(-1)).toEqual({
        role: "tool_result",
        toolCallId: "c1",
        toolName: "guarded_log",
        content: CANCELLED,
        isError: true,
      });
      expect(await Bun.file(join(cwd, "log.txt")).exists()).toBe(false);
      expect(provider.requests).toHaveLength(1);
    });
  });

  describe("System prompt", () => {
    /** The system prompt the Model saw with a request. */
    function systemPrompt(provider: FakeProvider, request = 0): string {
      const prompt = provider.systemPrompts[request];
      if (prompt === undefined) throw new Error(`request ${request} had no system prompt`);
      return prompt;
    }

    test("tells the Model its working directory, OS, today's date, and available Tools", async () => {
      const { agent, provider } = setup([reply("hi")], {
        tools: [readTool, logTool],
        now: () => new Date(2026, 10, 7, 15, 30),
      });
      await runTurn(agent, "hello");

      const prompt = systemPrompt(provider);
      expect(prompt).toContain(cwd);
      expect(prompt).toContain(process.platform);
      expect(prompt).toContain("2026-11-07");
      expect(prompt).toContain(`read: ${readTool.description}`);
      expect(prompt).toContain("log: Append a label to log.txt");
      expect(prompt).not.toContain("Project Instructions");
      expect(provider.requests[0]).toEqual([{ role: "user", content: "hello" }]);
    });

    test("includes AGENTS.md from the working directory as Project Instructions", async () => {
      await writeFile(join(cwd, "AGENTS.md"), "Always run `bun test` before finishing.\n");
      const { agent, provider } = setup([reply("ok")]);
      await runTurn(agent, "hello");

      const prompt = systemPrompt(provider);
      expect(prompt).toContain("# Project Instructions");
      expect(prompt).toContain("Always run `bun test` before finishing.");
      expect(prompt).toContain(cwd);
    });

    test("is sent unchanged with every request, across Steps and Turns", async () => {
      await writeFile(join(cwd, "notes.txt"), "x\n");
      const { agent, provider } = setup([callTools([call("c1", "read", { path: "notes.txt" })]), reply("done"), reply("again")]);
      await runTurn(agent, "first");
      await runTurn(agent, "second");

      expect(provider.requests).toHaveLength(3);
      const first = systemPrompt(provider, 0);
      expect(systemPrompt(provider, 1)).toBe(first);
      expect(systemPrompt(provider, 2)).toBe(first);
    });
  });
});
