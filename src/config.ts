import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_MAX_STEPS } from "./agent.ts";
import { DEFAULT_BASH_TIMEOUT_MS } from "./tools/bash.ts";
import { DEFAULT_TRUNCATION } from "./truncation.ts";

export const PROVIDERS = ["openrouter"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export type Config = {
  provider: ProviderName;
  model: string;
  /** Most Steps one Turn may take. */
  maxSteps: number;
  /** How long a `bash` command may run before it is killed. */
  bashTimeoutSeconds: number;
  /** Most characters of a Tool Result the Model sees; the rest is truncated. Config file only. */
  toolResultMaxChars: number;
  /** Most lines of a Tool Result the Model sees; the rest is truncated. Config file only. */
  toolResultMaxLines: number;
  /** Skip all Approvals. CLI flag only, so a config file can't silently turn off safety. */
  yolo: boolean;
};

/** Unvalidated values from the config file or CLI flags. */
type RawConfig = Partial<{
  provider: string;
  model: string;
  maxSteps: number;
  bashTimeoutSeconds: number;
  toolResultMaxChars: number;
  toolResultMaxLines: number;
}>;

const DEFAULTS: Omit<Config, "yolo"> = {
  provider: "openrouter",
  model: "google/gemma-4-31b-it:free",
  maxSteps: DEFAULT_MAX_STEPS,
  bashTimeoutSeconds: DEFAULT_BASH_TIMEOUT_MS / 1000,
  toolResultMaxChars: DEFAULT_TRUNCATION.maxChars,
  toolResultMaxLines: DEFAULT_TRUNCATION.maxLines,
};

const USAGE = "Usage: rocode [--provider <name>] [--model <id>] [--max-steps <n>] [--bash-timeout <seconds>] [--yolo]";

/** Thrown for anything the user must fix before rocode can start. */
export class ConfigError extends Error {}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "rocode");
}

/** Merge defaults < config file < CLI flags. */
export async function loadConfig(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Config> {
  const flags = parseFlags(argv);
  const file = await readConfigFile(join(configDir(env), "config.json"));
  const merged = { ...DEFAULTS, ...file, ...flags };
  return {
    provider: checkProvider(merged.provider),
    model: merged.model,
    maxSteps: merged.maxSteps,
    bashTimeoutSeconds: merged.bashTimeoutSeconds,
    toolResultMaxChars: merged.toolResultMaxChars,
    toolResultMaxLines: merged.toolResultMaxLines,
    yolo: flags.yolo ?? false,
  };
}

function parseFlags(argv: string[]): RawConfig & { yolo?: true } {
  let values: { provider?: string; model?: string; "max-steps"?: string; "bash-timeout"?: string; yolo?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        provider: { type: "string" },
        model: { type: "string" },
        "max-steps": { type: "string" },
        "bash-timeout": { type: "string" },
        yolo: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new ConfigError(`${(err as Error).message}\n${USAGE}`);
  }

  const out: RawConfig & { yolo?: true } = {};
  if (values.provider !== undefined) out.provider = values.provider;
  if (values.model !== undefined) out.model = values.model;
  if (values.yolo) out.yolo = true;
  if (values["max-steps"] !== undefined) {
    const n = Number(values["max-steps"]);
    if (!isPositiveInteger(n)) throw new ConfigError(`--max-steps must be a positive integer.\n${USAGE}`);
    out.maxSteps = n;
  }
  if (values["bash-timeout"] !== undefined) {
    const n = Number(values["bash-timeout"]);
    if (!isTimeoutSeconds(n)) throw new ConfigError(`--bash-timeout ${TIMEOUT_RULE}\n${USAGE}`);
    out.bashTimeoutSeconds = n;
  }
  return out;
}

async function readConfigFile(path: string): Promise<RawConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};

  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch (err) {
    throw new ConfigError(`Couldn't parse ${path}: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${path} must contain a JSON object.`);
  }
  const values = raw as Record<string, unknown>;

  const out: RawConfig = {};
  for (const key of ["provider", "model"] as const) {
    const value = values[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value === "") {
      throw new ConfigError(`"${key}" in ${path} must be a non-empty string.`);
    }
    out[key] = value;
  }
  for (const key of ["maxSteps", "toolResultMaxChars", "toolResultMaxLines"] as const) {
    const value = values[key];
    if (value === undefined) continue;
    if (!isPositiveInteger(value)) throw new ConfigError(`"${key}" in ${path} must be a positive integer.`);
    out[key] = value;
  }
  if (values.bashTimeoutSeconds !== undefined) {
    if (!isTimeoutSeconds(values.bashTimeoutSeconds)) {
      throw new ConfigError(`"bashTimeoutSeconds" in ${path} ${TIMEOUT_RULE}`);
    }
    out.bashTimeoutSeconds = values.bashTimeoutSeconds;
  }
  return out;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
const TIMEOUT_RULE = `must be a number of seconds greater than 0 and at most ${MAX_TIMEOUT_SECONDS}.`;

function isTimeoutSeconds(value: unknown): value is number {
  return typeof value === "number" && value > 0 && value <= MAX_TIMEOUT_SECONDS;
}

function checkProvider(name: string): ProviderName {
  if ((PROVIDERS as readonly string[]).includes(name)) return name as ProviderName;
  throw new ConfigError(`Unknown provider "${name}". Available: ${PROVIDERS.join(", ")}.`);
}
