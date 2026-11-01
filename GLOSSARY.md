# rocode

A coding agent that runs in the terminal: it chats with a language model that can act on the user's machine through tools. Built mainly to learn how such agents work.

## Language

### Talking to models

**Provider**:
A backend that serves models through a specific wire format (e.g. OpenRouter, Ollama, Anthropic).
_Avoid_: Backend, vendor, API

**Model**:
A specific language model offered by a Provider, identified by the Provider's model id.
_Avoid_: LLM, engine

**Message**:
One entry in the conversation, in the agent's own Provider-independent shape; Providers translate to and from it.
_Avoid_: Chat item, prompt

### Acting

**Tool**:
A named capability the Model may invoke, described by a name, description, and input schema.
_Avoid_: Function, command, action

**Tool Call**:
A request from the Model to run a Tool with specific arguments.
_Avoid_: Function call, invocation

**Tool Result**:
The output (or error) of executing a Tool Call, sent back to the Model.
_Avoid_: Tool output, observation

### The loop

**Turn**:
Everything that happens in response to one user message: one or more Steps, ending when the Model replies without Tool Calls (or the Turn is interrupted or hits the Step limit).
_Avoid_: Exchange, round

**Step**:
A single request to the Model within a Turn, plus execution of any Tool Calls it returned.
_Avoid_: Iteration, hop

**Agent Loop**:
The process that drives a Turn: call the Model, run its Tool Calls, feed back Tool Results, repeat.
_Avoid_: Runner, executor

**Interrupted Turn**:
A Turn the user cancelled mid-flight; its partial content stays in the conversation, marked as interrupted.
_Avoid_: Aborted, killed

### Safety and context

**Approval**:
The user's consent for a Tool Call to run; either once, or for that Tool for the rest of the Session.
_Avoid_: Permission, confirmation

**Project Instructions**:
User-authored guidance for the agent loaded from `AGENTS.md` in the working directory.
_Avoid_: Memory, rules, CLAUDE.md

**Session**:
One conversation from launch to exit, persisted so it can be resumed later.
_Avoid_: Chat, thread, history

**Truncation**:
Cutting an oversized Tool Result down to a fixed budget, with a note telling the Model what was dropped.
_Avoid_: Trimming, clipping

**Compaction**:
Replacing older Messages in a Session with a Model-written summary to free context window space.
_Avoid_: Summarization, pruning
