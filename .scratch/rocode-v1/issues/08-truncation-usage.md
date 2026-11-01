# 08: Truncation and token usage

**What to build:** A noisy command or huge file can no longer blow the context window: every oversized Tool Result is truncated to a fixed budget with a note telling the Model what was dropped. After each Turn the REPL shows input/output token usage so I can see how full the context is getting.

**Blocked by:** 03 (`bash` Tool with timeout)

**Status:** ready-for-agent

- [ ] Truncation applied uniformly to every Tool Result (character and line budget, configurable defaults)
- [ ] Truncated results include a note stating how much was dropped (and, for `read`, how to page with offset/limit)
- [ ] Providers emit usage events; the Agent core reports usage per Turn
- [ ] REPL prints a usage line after each Turn
- [ ] Agent-seam tests: a `bash` command producing huge output yields a truncated Tool Result with the note; usage from `FakeProvider` surfaces in Turn events
