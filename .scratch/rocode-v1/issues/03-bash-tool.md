# 03: `bash` Tool with timeout

**What to build:** I ask "list the files and show git status" and the Model runs shell commands via the `bash` Tool in my working directory, seeing combined output and exit code. No Approval prompt yet (that's 04).

**Blocked by:** 02 (Agent Loop with the `read` Tool)

**Status:** done

- [x] `bash` runs a command in the working directory and returns combined stdout/stderr plus exit code
- [x] Non-zero exit is a normal Tool Result, not an error that breaks the Turn
- [x] Commands time out (default 2 minutes, configurable) and the Tool Result says so; the process is killed
- [x] `bash` honours the abort signal by killing its process (used by 06)
- [x] `bash` is marked as requiring Approval in the registry (enforced in 04)
- [x] Agent-seam tests cover success, non-zero exit, and timeout using real processes in a temp directory
