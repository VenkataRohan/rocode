# Four tools: read, write, edit, bash

Following pi.dev, rocode ships only `read`, `write`, `edit` (unique exact-string replace), and `bash`; `bash` covers listing, searching, and git. Dedicated `grep`/`ls` tools are added only if observed free models struggle with bash. `edit` uses exact-string replacement rather than diffs because small models produce invalid diffs and waste tokens on full-file rewrites; failed matches return actionable errors so the Model can self-correct.
