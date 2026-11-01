# 01: Streaming chat with OpenRouter

**What to build:** I launch rocode, type a message at a plain REPL prompt, and a free OpenRouter Model's reply streams in token by token. The conversation carries across Turns. This is the project scaffold (Bun + TypeScript), the Provider-independent Message types, the `Provider` interface, a hand-rolled OpenRouter Provider (OpenAI Chat Completions over SSE, no SDK — see ADR 0001), config loading, and the readline REPL. No Tools yet.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Bun + TypeScript project scaffolded with `bun test` working and a `rocode` entry point
- [ ] Provider-independent Message types (user, assistant, Tool Result shapes defined even if Tools aren't used yet)
- [ ] `Provider` interface: given Messages, Tool definitions, Model id, and abort signal, yields a stream of events (text delta, usage, done, error)
- [ ] OpenRouter Provider parses SSE by hand using an injected HTTP function; nothing outside it sees wire JSON
- [ ] API key read from `OPENROUTER_API_KEY`; clear startup error if missing
- [ ] Config merges defaults, `~/.config/rocode/config.json`, and `--provider` / `--model` flags (flags win)
- [ ] Readable errors for 401, 429 (rate limit), invalid Model id, 5xx, and network failure; the error ends the Turn but the REPL stays alive
- [ ] Multi-turn: earlier Messages are sent on each Turn
- [ ] Provider tests replay recorded SSE fixtures and assert on emitted events, typed errors, and the outgoing request body
- [ ] Manual smoke test: chat with a free OpenRouter Model
