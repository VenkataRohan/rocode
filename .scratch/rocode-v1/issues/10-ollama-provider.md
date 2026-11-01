# 10: Ollama Provider

**What to build:** I can run rocode against a local Ollama Model with `--provider ollama` — no API key, no rate limits. A Session started on OpenRouter can be resumed on Ollama, proving the Provider boundary is real.

**Blocked by:** 02 (Agent Loop with the `read` Tool), 09 (Sessions and `--continue`)

**Status:** ready-for-agent

- [ ] Ollama Provider implements the same `Provider` interface using an injected HTTP function
- [ ] Selected via `--provider ollama` or config; no API key required
- [ ] The Provider contract test suite (recorded fixtures) runs against both OpenRouter and Ollama
- [ ] Readable error when Ollama isn't running or the Model isn't pulled
- [ ] Resuming an OpenRouter Session with `--provider ollama` works, including prior Tool Calls and Tool Results
- [ ] Manual smoke test with a local tool-capable Model
