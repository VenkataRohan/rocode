// Plain readline REPL: reads user messages and renders the Agent's events.
// No agent logic lives here; the Agent core runs the Turn.

import { createInterface } from "node:readline/promises";
import type { Agent, AgentEvent } from "./agent.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const red = (s: string) => `\x1b[31m${s}\x1b[39m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;

export async function runRepl(options: { agent: Agent; header: string }) {
  const { agent } = options;
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(dim(`rocode · ${options.header}`));
  console.log(dim("Type a message. Ctrl+D to exit.\n"));

  // The async iterator buffers lines typed (or piped) while a Turn is running,
  // and ends cleanly on EOF (Ctrl+D).
  let closed = false;
  rl.once("close", () => (closed = true));
  const prompt = () => {
    if (!closed) rl.prompt();
  };

  rl.setPrompt("> ");
  prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (!text) {
      prompt();
      continue;
    }

    const renderer = new TurnRenderer();
    for await (const event of agent.runTurn(text, new AbortController().signal)) renderer.render(event);
    process.stdout.write("\n");
    prompt();
  }

  rl.close();
}

/** Writes one Turn's events to stdout, keeping Model text and Tool activity visually apart. */
class TurnRenderer {
  /** Whether the cursor is at the start of a line. */
  private atLineStart = true;

  render(event: AgentEvent) {
    switch (event.type) {
      case "text_delta":
        this.write(event.text);
        break;
      case "tool_call_started":
        this.line(cyan(`● ${event.toolCall.name}(${formatArguments(event.toolCall.arguments)})`));
        break;
      case "tool_call_finished": {
        const preview = `  ⎿ ${truncate(event.preview.replaceAll("\t", " "), 100)}`;
        this.line(event.isError ? red(preview) : dim(preview));
        break;
      }
      case "step_finished":
        break;
      case "turn_finished":
        if (event.reason === "step_limit") {
          this.line(yellow("⚠ Stopped: this Turn hit the Step limit. The task may be incomplete; say \"continue\" to keep going."));
        } else if (event.reason === "error") {
          this.line(red(`✗ ${event.error?.message ?? "The Turn failed."}`));
        } else {
          this.endLine();
        }
        break;
    }
  }

  private write(text: string) {
    if (!text) return;
    process.stdout.write(text);
    this.atLineStart = text.endsWith("\n");
  }

  private endLine() {
    if (!this.atLineStart) this.write("\n");
  }

  private line(text: string) {
    this.endLine();
    this.write(`${text}\n`);
  }
}

/** Tool Call arguments as `key: value` pairs, each value shortened. */
function formatArguments(args: unknown): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return truncate(typeof args === "string" ? args : JSON.stringify(args), 80);
  }
  return Object.entries(args)
    .map(([key, value]) => `${key}: ${truncate(JSON.stringify(value), 60)}`)
    .join(", ");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
