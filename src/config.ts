import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

export const PROVIDERS = ["openrouter"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export type Config = {
  provider: ProviderName;
  model: string;
};

const CONFIG_KEYS = ["provider", "model"] as const satisfies readonly (keyof Config)[];

/** Unvalidated string values from the config file or CLI flags. */
type RawConfig = Partial<Record<(typeof CONFIG_KEYS)[number], string>>;

const DEFAULTS: Config = {
  provider: "openrouter",
  model: "google/gemma-4-31b-it:free",
};

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
  return { provider: checkProvider(merged.provider), model: merged.model };
}

function parseFlags(argv: string[]): RawConfig {
  try {
    const { values } = parseArgs({
      args: argv,
      options: Object.fromEntries(CONFIG_KEYS.map((key) => [key, { type: "string" as const }])),
      strict: true,
      allowPositionals: false,
    });
    return Object.fromEntries(
      Object.entries(values).filter(([, v]) => typeof v === "string"),
    ) as RawConfig;
  } catch (err) {
    throw new ConfigError(`${(err as Error).message}\nUsage: rocode [--provider <name>] [--model <id>]`);
  }
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

  const out: RawConfig = {};
  for (const key of CONFIG_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value === "") {
      throw new ConfigError(`"${key}" in ${path} must be a non-empty string.`);
    }
    out[key] = value;
  }
  return out;
}

function checkProvider(name: string): ProviderName {
  if ((PROVIDERS as readonly string[]).includes(name)) return name as ProviderName;
  throw new ConfigError(`Unknown provider "${name}". Available: ${PROVIDERS.join(", ")}.`);
}
