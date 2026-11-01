---
status: ready-for-agent
---

# rocode v1: a hand-built terminal coding agent

## Problem Statement

I want to understand how terminal coding agents like Claude Code and pi.dev actually work — the Agent Loop, tool calling, streaming, Approvals, context limits, Session persistence — not just use them. Frameworks and SDKs hide exactly the parts I want to learn. I also don't have paid API keys yet, so whatever I build has to work with free OpenRouter Models (and ideally local Models), while leaving room to plug in OpenAI, Gemini, and Claude later and possibly ship the tool for real dev work.

## Solution

rocode is a terminal coding agent built from first principles in TypeScript on Bun. I type a request in a plain REPL; a free Model on OpenRouter streams its reply and can use four Tools — `read`, `write`, `edit`, `bash` — to inspect and change files in my working directory. Mutating Tools ask for my Approval. I can interrupt a runaway Turn with Ctrl+C, resume yesterday's Session with `--continue`, and switch to a local Ollama Model when I hit free-tier rate limits. Every core mechanism (stream parsing, the Agent Loop, Tool dispatch, Provider translation) is hand-written so I understand it, and the agent core is decoupled from the UI so a richer TUI can replace the REPL later.

## User Stories

### Talking to a Model

1. As a developer, I want to type a message at a prompt and see the Model's reply stream in token by token, so that I get immediate feedback instead of waiting for the full response.
2. As a developer, I want rocode to read my OpenRouter key from `OPENROUTER_API_KEY`, so that I don't have to paste secrets into config files.
3. As a developer, I want a clear error at startup if no API key is set for the selected Provider, so that I know exactly what to fix.
4. As a developer, I want to choose the Model via a `--model` flag, so that I can try different free Models quickly.
5. As a developer, I want to set a default Provider and Model in `~/.config/rocode/config.json`, so that I don't repeat flags every launch.
6. As a developer, I want flags to override config file values, so that one-off experiments don't require editing config.
7. As a developer, I want a readable error when the Provider returns a rate-limit (429) response, so that I understand I've hit the free-tier cap rather than a bug.
8. As a developer, I want readable errors for network failures and invalid model ids, so that a failed request doesn't crash the REPL.
9. As a developer, I want a failed request to end the Turn but keep the Session alive, so that I can retry or switch Models without losing context.
10. As a developer, I want to see token usage (input and output) after each Turn, so that I can see how close I am to the Model's context window.
11. As a developer, I want multi-turn conversations where the Model remembers earlier Messages in the Session, so that I can refine requests iteratively.

### The Agent Loop

12. As a developer, I want the Model to be able to call Tools and have rocode run them and feed the Tool Results back automatically, so that the Model can complete multi-step tasks on its own.
13. As a developer, I want the Agent Loop to keep taking Steps until the Model replies without Tool Calls, so that a Turn ends naturally when the work is done.
14. As a developer, I want a cap on Steps per Turn (default 25, configurable), so that a confused free Model can't loop forever and burn my rate limit.
15. As a developer, I want a clear notice when a Turn ends because it hit the Step limit, so that I know the task may be incomplete.
16. As a developer, I want multiple Tool Calls in one Step to run sequentially in the order the Model gave them, so that edits never race each other.
17. As a developer, I want to see each Tool Call as it happens (Tool name and key arguments) visually distinct from Model text, so that I can follow what the agent is doing.
18. As a developer, I want to see a short preview of each Tool Result, so that I know whether a Tool succeeded without being flooded with output.
19. As a developer, I want a Tool Call with malformed or invalid arguments to produce an error Tool Result rather than crash, so that the Model can correct itself.
20. As a developer, I want a Tool Call naming an unknown Tool to produce an error Tool Result listing the available Tools, so that the Model can recover.

### Tools

21. As a developer, I want a `read` Tool that returns a file's contents with line numbers, so that the Model can reference exact locations.
22. As a developer, I want `read` to accept an offset and line limit, so that the Model can page through large files without flooding context.
23. As a developer, I want `read` on a missing file or directory to return a clear error Tool Result, so that the Model can adjust.
24. As a developer, I want a `write` Tool that creates or overwrites a file (creating parent directories as needed), so that the Model can create new files.
25. As a developer, I want an `edit` Tool that replaces one exact, unique occurrence of a string with another, so that the Model can make targeted changes cheaply.
26. As a developer, I want `edit` to fail with "not found" when the old string doesn't exist, so that the Model knows to re-read the file.
27. As a developer, I want `edit` to fail with "matched N times — add more surrounding context" when the old string isn't unique, so that the Model can disambiguate.
28. As a developer, I want a `bash` Tool that runs a shell command in the working directory and returns combined stdout/stderr and exit code, so that the Model can list, search, build, test, and use git.
29. As a developer, I want `bash` commands to time out (default 2 minutes) and report the timeout, so that a hung command doesn't freeze the agent.
30. As a developer, I want a non-zero exit code to be reported in the Tool Result rather than treated as a crash, so that the Model can react to failing tests or commands.

### Truncation and context

31. As a developer, I want any oversized Tool Result truncated to a fixed budget with a note saying how much was dropped, so that one noisy command can't blow the context window.
32. As a developer, I want the system prompt to tell the Model its working directory, OS, today's date, and available Tools, so that it acts correctly in my environment.
33. As a developer, I want rocode to load `AGENTS.md` from the working directory as Project Instructions when it exists, so that I can give per-project guidance using the cross-tool standard.
34. As a developer, I want rocode to work normally when no `AGENTS.md` exists, so that it's usable in any directory.

### Approvals and safety

35. As a developer, I want `read` to run without asking, so that exploration is fast.
36. As a developer, I want `write`, `edit`, and `bash` to ask for Approval showing what will happen (path, or full command), so that nothing changes my machine without my consent.
37. As a developer, I want to answer an Approval with y (once), n (deny), or a (always allow this Tool for the rest of the Session), so that I can balance safety and speed.
38. As a developer, I want a denied Tool Call to send a "user denied" Tool Result to the Model, so that it can choose a different approach or ask me.
39. As a developer, I want a `--yolo` flag that skips all Approvals, so that I can run unattended in throwaway directories.
40. As a developer, I want "always allow" choices to not persist across Sessions, so that a new launch starts safe.

### Interrupting

41. As a developer, I want Ctrl+C during a Turn to cancel it immediately — stopping the stream and killing any running `bash` process — so that I can stop a runaway agent.
42. As a developer, I want an Interrupted Turn's partial content kept in the conversation and marked as interrupted, so that the Model knows what happened when I follow up.
43. As a developer, I want Ctrl+C at an idle prompt to exit rocode, so that quitting is familiar.
44. As a developer, I want Ctrl+C during an Approval prompt to deny and interrupt the Turn, so that there's always a fast escape.

### Sessions

45. As a developer, I want every Session saved automatically to an append-only JSONL file as Messages happen, so that a crash loses almost nothing.
46. As a developer, I want `--continue` to resume my most recent Session with its full conversation, so that I can pick up where I left off.
47. As a developer, I want Session files to be human-readable, so that I can open them to debug exactly what was sent to and received from the Model.
48. As a developer, I want a Session file that ends mid-Turn (e.g. after a crash) to still load, so that resuming is robust.

### Providers

49. As a developer, I want an Ollama Provider, so that I can use local Models with no rate limits and no API key.
50. As a developer, I want to select the Provider via `--provider` or config, so that switching between OpenRouter and Ollama is trivial.
51. As a developer, I want the agent's Messages to be Provider-independent, so that adding Anthropic or Gemini later means writing one adapter, not rewriting the Agent Loop.
52. As a learner, I want a resumed Session to work even if I switch Provider, so that the Provider boundary is proven real.

### Learning and maintainability

53. As a learner, I want each milestone to be independently usable, so that I understand each concept before stacking the next.
54. As a learner, I want the Agent core to know nothing about the terminal, so that I can later replace the REPL with a rich TUI without touching the loop.
55. As a learner, I want the Agent Loop testable without network access, so that I can iterate fast despite free-tier rate limits.

## Implementation Decisions

- **Runtime and language:** TypeScript on Bun. No agent SDKs or LLM frameworks (see ADR 0001); small non-agent libraries (colors, arg parsing) are fine.
- **Modules:**
  - **Messages/types** — the Provider-independent conversation model: user, assistant, and Tool Result Messages; assistant Messages carry text plus zero or more Tool Calls (id, Tool name, parsed arguments); an interrupted flag on assistant Messages; usage data.
  - **Provider interface** — a single streaming operation: given Messages, Tool definitions, a Model id, and an abort signal, yield a stream of events (text delta, Tool Call completed, usage, done, error). Providers own all wire-format translation and SSE parsing; nothing outside a Provider sees raw HTTP or wire JSON. Providers accept an injected HTTP function.
  - **OpenRouter Provider** — OpenAI Chat Completions format over SSE; accumulates streamed Tool Call argument fragments by index until complete; maps HTTP errors (401, 429, 404/invalid model, 5xx) to typed errors.
  - **Ollama Provider** — second implementation behind the same interface (milestone 6).
  - **Tool registry and Tools** — each Tool has a name, description, JSON-schema input, a flag for whether it requires Approval, and an execute function receiving validated arguments, the working directory, and an abort signal. Tools: `read`, `write`, `edit`, `bash` (see ADR 0002). Tool failures return error Tool Results; they never throw out of the loop.
  - **Truncation** — applied uniformly to every Tool Result (character and line budget) with an explanatory note.
  - **Agent core** — owns the Agent Loop. Constructed with a Provider, Model id, Tool set, working directory, Approval handler, Session store, and limits (max Steps). Exposes "run a Turn for this user message with this abort signal" and emits a stream of Agent events: text delta, Tool Call started, Approval requested/resolved, Tool Call finished (with result preview), Step finished, usage, Turn finished (with reason: completed, step-limit, interrupted, error).
  - **Approval** — the Agent core calls an injected async handler returning once / always / deny; the core tracks per-Session "always" grants per Tool. `--yolo` supplies a handler that always approves.
  - **System prompt builder** — fixed template filled with working directory, OS, date, and Tool list, plus Project Instructions from `AGENTS.md` if present.
  - **Session store** — appends one JSON line per Message (and a header line with Session metadata: Provider, Model, working directory, start time) to a timestamped file under the rocode config directory; can load the most recent Session; tolerates a truncated final line.
  - **Config** — merges defaults, config file, and CLI flags (flags win). Keys: provider, model, max Steps, bash timeout. API keys come only from environment variables.
  - **REPL** — readline-based; renders Agent events (colored Tool Calls, previews, usage line), prompts for Approvals, maps Ctrl+C to the Turn's abort signal or exit when idle. Contains no agent logic.
- **Interruption semantics:** aborting the signal cancels the in-flight HTTP stream and kills any running bash process; the partial assistant Message is recorded with the interrupted flag; any Tool Calls in that Message that never ran get a "cancelled by user" Tool Result so the conversation stays valid for every Provider.
- **Denied Approval** produces a Tool Result stating the user denied it; the Agent Loop continues the Turn.
- **Free-model constraint:** recommended defaults are free OpenRouter Models that advertise tool support; no XML/text-protocol fallback in v1.
- **Milestone order:** (1) streaming chat via OpenRouter, (2) Agent Loop + `read` + `bash`, (3) `write`/`edit` + Approvals + interrupts, (4) system prompt + `AGENTS.md` + Truncation + usage display, (5) Session persistence + `--continue`, (6) Ollama Provider.

## Testing Decisions

- **Good tests exercise external behavior only:** feed inputs through a public interface and assert on emitted events, resulting Messages, and real files/processes — never on internal helpers, call counts, or private state. Refactors of the loop internals should not break tests.
- **Seam 1 — Agent core (primary):** tests construct the Agent with a `FakeProvider` that replays scripted Steps (text deltas, Tool Calls, usage, errors), a scripted Approval handler, a temporary working directory, and a temporary Session directory. Assertions cover: event sequence, final Messages, files on disk, `bash` side effects, Session JSONL contents. This seam covers the Agent Loop, Step limit, sequential Tool Calls, Tool errors and self-correction paths (`edit` not-found / not-unique), Approvals (once/always/deny/yolo), interrupts via abort signal (including killing a long `bash`), Truncation, system prompt/Project Instructions inclusion, and Session save/resume.
- **Seam 2 — Provider adapters:** each Provider is tested with an injected HTTP function replaying recorded SSE fixtures captured from real responses, asserting on the emitted Provider events (text, fully assembled Tool Calls, usage, typed errors) and on the outgoing request body shape. The same contract suite runs against every Provider.
- **Not automated:** the REPL, which stays a thin renderer over Agent events. Each milestone ends with a manual smoke test against a real free Model.
- **Tooling:** `bun test`. No prior art exists — this is a greenfield repo; these tests become the prior art.

## Out of Scope

- Compaction (Model-written summaries of older Messages).
- Rich TUI (Ink, custom renderer, diff views, spinners beyond basics).
- Anthropic, OpenAI-direct, and Gemini Providers.
- Parallel Tool Calls.
- Additional Tools (`grep`, `ls`, `glob`, web fetch) unless free Models demonstrably struggle with `bash`.
- Sandboxing, command allowlists/denylists, persisted Approval rules.
- Subagents, MCP, slash commands, hooks, plugins.
- Session picker UI (only `--continue` for the most recent).
- Text-protocol (XML) Tool Call fallback for Models without native tool support.
- Packaging/distribution (npm publish, single binary).

## Further Notes

- Primary goal is learning; when a library would save time on a core agent concept, prefer writing it by hand (ADR 0001).
- Free OpenRouter tiers are rate-limited (roughly 20 requests/minute plus a daily cap) and tool-calling quality varies widely; expect to try several Models. Ollama is the escape hatch.
- Vocabulary follows `GLOSSARY.md`: Provider, Model, Message, Tool, Tool Call, Tool Result, Turn, Step, Agent Loop, Interrupted Turn, Approval, Project Instructions, Session, Truncation, Compaction.
