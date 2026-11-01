# 07: System prompt and AGENTS.md

**What to build:** The Model knows where it is and how to behave: a built-in system prompt tells it the working directory, OS, today's date, and available Tools. If the working directory has an `AGENTS.md`, its contents are included as Project Instructions.

**Blocked by:** 02 (Agent Loop with the `read` Tool)

**Status:** ready-for-agent

- [ ] System prompt built from a fixed template filled with working directory, OS, date, and Tool list
- [ ] `AGENTS.md` in the working directory is appended as Project Instructions when present
- [ ] rocode works normally when no `AGENTS.md` exists
- [ ] Agent-seam tests assert (via the Messages the `FakeProvider` receives) that the system prompt contains the environment details and, when present, the Project Instructions
