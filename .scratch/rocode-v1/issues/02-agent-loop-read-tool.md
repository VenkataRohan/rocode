# 02: Agent Loop with the `read` Tool

**What to build:** I ask "what's in package.json?" and the Model calls the `read` Tool, rocode runs it, feeds the Tool Result back, and the Model answers — the full Agent Loop. The REPL shows each Tool Call (name + key args) distinct from Model text, plus a short Tool Result preview. Introduces the Agent core (emitting Agent events, knowing nothing about the terminal), the Tool registry, the `FakeProvider` test harness, and Tool Call assembly in the OpenRouter Provider.

**Blocked by:** 01 (Streaming chat with OpenRouter)

**Status:** ready-for-agent

- [ ] Tool registry: each Tool has name, description, JSON-schema input, requires-Approval flag, and execute function (validated args, working directory, abort signal)
- [ ] OpenRouter Provider accumulates streamed Tool Call argument fragments and emits completed Tool Calls; covered by recorded SSE fixtures
- [ ] Agent core runs a Turn: Step after Step until the Model replies without Tool Calls
- [ ] Multiple Tool Calls in one Step execute sequentially in Model order
- [ ] Step limit per Turn (default 25, configurable); Turn ends with a step-limit reason and the REPL shows a notice
- [ ] Agent events emitted: text delta, Tool Call started, Tool Call finished (with preview), Step finished, Turn finished (with reason)
- [ ] `read` returns file contents with line numbers, supports offset and line limit
- [ ] Missing file, directory path, unknown Tool, and invalid arguments all produce error Tool Results (unknown Tool error lists available Tools); nothing throws out of the loop
- [ ] `FakeProvider` replays scripted Steps; Agent tests use a temp working directory and assert only on events, Messages, and files
- [ ] Manual smoke test with a free tool-capable Model
