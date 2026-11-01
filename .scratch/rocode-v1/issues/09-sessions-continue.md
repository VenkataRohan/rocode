# 09: Sessions and `--continue`

**What to build:** Every Session is saved automatically as I go, one human-readable line per Message, so a crash loses almost nothing and I can open the file to see exactly what happened. `rocode --continue` resumes my most recent Session with full context.

**Blocked by:** 02 (Agent Loop with the `read` Tool)

**Status:** ready-for-agent

- [ ] Session store appends a header line (Provider, Model, working directory, start time) then one JSON line per Message, as Messages happen
- [ ] Session files live in a timestamped file under the rocode config directory's sessions folder
- [ ] `--continue` loads the most recent Session and continues the conversation
- [ ] A Session file with a truncated final line (simulated crash) still loads, dropping the partial line
- [ ] Interrupted flags and Tool Results round-trip through save/load
- [ ] Agent-seam tests use a temp config directory: run Turns, construct a new Agent from the saved Session, and assert the next request includes prior Messages
