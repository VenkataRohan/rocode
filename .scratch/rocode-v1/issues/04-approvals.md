# 04: Approvals

**What to build:** Before a mutating Tool runs, rocode shows me what will happen (the full command, or the path) and asks y / n / a. "y" allows once, "n" denies, "a" always allows that Tool for the rest of the Session. Denials are reported to the Model so it can adapt. `--yolo` skips all Approvals.

**Blocked by:** 03 (`bash` Tool with timeout)

**Status:** done

- [x] Agent core calls an injected async Approval handler (returns once / always / deny) for any Tool flagged as requiring Approval
- [x] Agent core tracks per-Session "always" grants per Tool; grants do not persist across launches
- [x] `read` never asks
- [x] Denied Tool Call yields a "user denied" Tool Result and the Turn continues
- [x] Agent events emitted for Approval requested / resolved
- [x] REPL renders the y/n/a prompt showing the command or path
- [x] `--yolo` supplies a handler that always approves
- [x] Agent-seam tests with a scripted Approval handler cover once, always, deny, and yolo
