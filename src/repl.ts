// Plain readline REPL: reads user messages and renders the Agent's events.
// No agent logic lives here; the Agent core runs the Turn.

import { createInterface, type Interface } from "node:readline";
import type { Agent, AgentEvent, ApprovalDecision, ApprovalHandler, ApprovalRequest } from "./agent.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const red = (s: string) => `\x1b[31m${s}\x1b[39m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;

export async function runRepl(options: {
  /** Builds the Agent, given a handler that asks the user for Approval at this REPL. */
  createAgent: (askUser: ApprovalHandler) => Agent;
  header: string;
}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines = new LineQueue(rl);
  const renderer = new EventRenderer();
  const agent = options.createAgent((request) => askForApproval(request, rl, lines, renderer));

  console.log(dim(`rocode · ${options.header}`));
  console.log(dim("Type a message. Ctrl+D to exit.\n"));

  rl.setPrompt(MESSAGE_PROMPT);
  while (true) {
    if (!lines.closed) rl.prompt();
    const line = await lines.next();
    if (line === null) break;
    const text = line.trim();
    if (!text) continue;

    for await (const event of agent.runTurn(text, new AbortController().signal)) renderer.render(event);
    renderer.write("\n");
  }

  rl.close();
}

const MESSAGE_PROMPT = "> ";

const ANSWERS: Record<string, ApprovalDecision> = { y: "once", yes: "once", n: "deny", no: "deny", a: "always", always: "always" };

/** Shows what a Tool Call will do and asks y / n / a until it gets a valid answer. Ctrl+D (end of input) denies. */
async function askForApproval(
  { toolCall, subject }: ApprovalRequest,
  rl: Interface,
  lines: LineQueue,
  renderer: EventRenderer,
): Promise<ApprovalDecision> {
  // At a terminal, lines typed while the Model was working weren't meant as answers to a
  // prompt that didn't exist yet. Drop them, so a stray "y" can't approve unseen. Piped input is
  // deliberately scripted, so it keeps feeding answers.
  if (process.stdin.isTTY) {
    const dropped = lines.discardBuffered();
    if (dropped > 0) renderer.line(dim(`(ignored ${dropped} line${dropped === 1 ? "" : "s"} typed ahead)`));
  }

  renderer.line(yellow(`? Allow ${toolCall.name}?`));
  renderer.line(subject.replace(/^/gm, "    "));
  // Through readline, so redraws (backspace, wrapping) keep this prompt rather than "> ".
  rl.setPrompt(yellow(`  [y] yes  [n] no  [a] always allow ${toolCall.name} this Session › `));
  try {
    while (true) {
      if (!lines.closed) rl.prompt();
      const answer = await lines.next();
      if (answer === null) {
        renderer.line(dim("(end of input: denied)"));
        return "deny";
      }
      // A terminal echoes the answer and the Enter; piped input doesn't, so echo it ourselves.
      if (!process.stdin.isTTY) renderer.write(`${answer}\n`);
      const decision = ANSWERS[answer.trim().toLowerCase()];
      if (decision) return decision;
    }
  } finally {
    rl.setPrompt(MESSAGE_PROMPT);
  }
}

/**
 * Every line the user types, in order, whoever asks for it next: the main prompt or an Approval.
 * Lines typed (or piped) ahead of time wait here instead of being lost.
 */
class LineQueue {
  private buffered: string[] = [];
  private waiting: ((line: string | null) => void) | undefined;
  private ended = false;

  constructor(rl: Interface) {
    rl.on("line", (line) => {
      if (this.waiting) this.take()(line);
      else this.buffered.push(line);
    });
    rl.on("close", () => {
      this.ended = true;
      this.waiting && this.take()(null);
    });
  }

  /** Throws away lines typed ahead that nobody asked for yet; returns how many. */
  discardBuffered(): number {
    const count = this.buffered.length;
    this.buffered = [];
    return count;
  }

  /** Whether input has ended (Ctrl+D or end of a pipe). Buffered lines may remain. */
  get closed() {
    return this.ended;
  }

  /** The next line, or null once input has ended and every line was taken. */
  next(): Promise<string | null> {
    const line = this.buffered.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => (this.waiting = resolve));
  }

  private take() {
    const waiting = this.waiting!;
    this.waiting = undefined;
    return waiting;
  }
}

/** Writes Agent events to stdout, keeping Model text, Tool activity and prompts visually apart. */
class EventRenderer {
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
      case "approval_requested":
        break; // the Approval prompt shows the request
      case "approval_resolved":
        if (event.decision === "always") this.line(dim(`  ${event.toolCall.name} is allowed for the rest of this Session.`));
        break;
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

  write(text: string) {
    if (!text) return;
    process.stdout.write(text);
    this.atLineStart = text.endsWith("\n");
  }

  private endLine() {
    if (!this.atLineStart) this.write("\n");
  }

  line(text: string) {
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
