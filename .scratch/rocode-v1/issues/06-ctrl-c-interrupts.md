# 06: Ctrl+C interrupts

**What to build:** When a Turn runs away, I press Ctrl+C and it stops immediately — the stream is cancelled and any running `bash` command is killed. What the Model said so far stays in the conversation, marked as an Interrupted Turn, so my follow-up has context. Ctrl+C at an idle prompt exits.

**Blocked by:** 03 (`bash` Tool with timeout)

**Status:** done

- [x] Running a Turn takes an abort signal; aborting cancels the in-flight Provider stream
- [x] Aborting kills a running `bash` process
- [x] Partial assistant Message is recorded with the interrupted flag
- [x] Any Tool Calls in that Message that never ran receive a "cancelled by user" Tool Result, so the conversation stays valid for every Provider
- [x] Turn finishes with reason "interrupted"
- [x] Ctrl+C during an Approval prompt denies and interrupts the Turn (once 04 exists)
- [x] Ctrl+C at an idle prompt exits rocode
- [x] Agent-seam tests abort mid-stream and mid-`bash` (long sleep) and assert on Messages and that the process is gone
