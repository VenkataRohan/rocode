import { spawn } from "node:child_process";
import { errorResult as error, okResult as ok, type Tool, type ToolResult } from "./tool.ts";

type BashArgs = { command: string };

export const DEFAULT_BASH_TIMEOUT_MS = 2 * 60 * 1000;

/** How long to wait for output after bash exits, in case a leftover process still holds the pipe. */
const DRAIN_MS = 100;

const INTERRUPTED = "(Command was interrupted and killed.)";
const NOT_RUN = "(Command was not run: the Turn was interrupted.)";

type StopReason = "timeout" | "abort";

export function createBashTool({ timeoutMs = DEFAULT_BASH_TIMEOUT_MS } = {}): Tool<BashArgs> {
  const seconds = timeoutMs / 1000;

  return {
    name: "bash",
    description:
      "Run a shell command with bash in the working directory. Returns combined stdout/stderr and the exit code. " +
      `Commands are killed after ${seconds}s, and background processes are killed when the command finishes. ` +
      "stdin is not available, so avoid interactive commands.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", description: "The bash command to run." } },
      required: ["command"],
    },
    requiresApproval: true,

    execute({ command }, { cwd, signal }) {
      if (signal.aborted) return Promise.resolve(error(NOT_RUN));

      return new Promise((resolve, reject) => {
        // One pipe for both streams keeps their interleaving. Its own process group,
        // so killing the group also kills anything the command started.
        const child = spawn("bash", ["-c", `exec 2>&1\n${command}`], {
          cwd,
          stdio: ["ignore", "pipe", "ignore"],
          detached: true,
        });
        const stdout = child.stdout.setEncoding("utf8");
        let output = "";
        stdout.on("data", (chunk: string) => (output += chunk));

        let stopped: StopReason | undefined;
        const stop = (reason: StopReason) => {
          stopped ??= reason;
          killGroup(child.pid);
        };
        const onAbort = () => stop("abort");
        const timer = setTimeout(() => stop("timeout"), timeoutMs);
        signal.addEventListener("abort", onAbort, { once: true });
        const cleanUp = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
        };

        child.on("error", (err) => {
          cleanUp();
          reject(err);
        });
        // Finish when bash itself exits, not when the pipe closes: a process the command
        // left behind (or one that escaped the group) could hold the pipe open forever.
        child.on("exit", (code, killedBy) => {
          cleanUp();
          const finish = () => {
            clearTimeout(drainTimer);
            killGroup(child.pid);
            stdout.destroy();
            resolve(toResult(output, stopped, code, killedBy, seconds));
          };
          const drainTimer = setTimeout(finish, DRAIN_MS);
          if (stdout.closed) finish();
          else stdout.once("close", finish);
        });
      });
    },
  };
}

function toResult(
  output: string,
  stopped: StopReason | undefined,
  code: number | null,
  killedBy: NodeJS.Signals | null,
  seconds: number,
): ToolResult {
  const shown = output === "" ? "(no output)" : output.endsWith("\n") ? output : `${output}\n`;
  if (stopped === "abort") return error(`${shown}\n${INTERRUPTED}`);
  if (stopped === "timeout") return error(`${shown}\n(Command timed out after ${seconds}s and was killed.)`);
  return ok(`${shown}\n(${code === null ? `killed by ${killedBy}` : `exit code ${code}`})`);
}

function killGroup(pid: number | undefined) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group already exited.
  }
}
