# 05: `write` and `edit` Tools

**What to build:** The Model can create files with `write` and make targeted changes with `edit` (exact, unique string replacement — see ADR 0002), each behind an Approval. When an edit can't be applied, the error tells the Model exactly how to fix its next attempt. Demo: the agent fixes a bug in a scratch repo end to end.

**Blocked by:** 04 (Approvals)

**Status:** done

- [x] `write` creates or overwrites a file, creating parent directories as needed
- [x] `edit` replaces exactly one occurrence of an old string with a new string
- [x] `edit` fails with a "not found — re-read the file" Tool Result when the old string is absent
- [x] `edit` fails with a "matched N times — add more surrounding context" Tool Result when not unique, and leaves the file untouched
- [x] Both Tools require Approval; the prompt shows the target path
- [x] Agent-seam tests assert on file contents in a temp directory, including a scripted not-found → re-read → successful edit self-correction sequence
- [ ] Manual smoke test: agent fixes a bug in a scratch repo
