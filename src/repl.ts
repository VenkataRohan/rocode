// Plain readline REPL: reads user messages, streams the Model's reply, prints errors.
// No Tools yet; the Agent core (issue 02) will take over the Turn logic from here.

import { createInterface } from "node:readline/promises";
import type { Message } from "./messages.ts";
import type { Provider } from "./provider.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const red = (s: string) => `\x1b[31m${s}\x1b[39m`;

export async function runRepl(options: { provider: Provider; model: string }) {
  const { provider, model } = options;
  const messages: Message[] = [];
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log(dim(`rocode · ${provider.name} · ${model}`));
  console.log(dim("Type a message. Ctrl+D to exit.\n"));

  // The async iterator buffers lines typed (or piped) while a reply is streaming,
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

    messages.push({ role: "user", content: text });
    const reply = await runTurn(provider, model, messages);
    if (reply) {
      messages.push(reply);
    } else {
      // The Turn failed: drop its user Message so the next attempt starts clean.
      messages.pop();
    }
    process.stdout.write("\n");
    prompt();
  }

  rl.close();
}

/** Streams one reply to stdout. Returns the assistant Message, or null if the Turn failed. */
async function runTurn(provider: Provider, model: string, messages: Message[]) {
  let content = "";
  const events = provider.stream({
    messages,
    tools: [],
    model,
    signal: new AbortController().signal,
  });

  for await (const event of events) {
    switch (event.type) {
      case "text_delta":
        content += event.text;
        process.stdout.write(event.text);
        break;
      case "usage":
        break; // shown once usage display lands (issue 08)
      case "error":
        if (content) process.stdout.write("\n");
        console.log(red(`✗ ${event.error.message}`));
        return null;
      case "done":
        process.stdout.write("\n");
        return { role: "assistant", content, toolCalls: [] } satisfies Message;
    }
  }
  return null;
}
