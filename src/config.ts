import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

export const PROVIDERS = ["openrouter"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export type Config = {
  provider: ProviderName;
  model: string;
};

export const DEFAULTS: Config = {
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

function parseFlags(argv: string[]): Partial<Record<keyof Config, string>> {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        provider: { type: "string" },
        model: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    return dropUndefined(values);
  } catch (err) {
    throw new ConfigError(`${(err as Error).message}\nUsage: rocode [--provider <name>] [--model <id>]`);
  }
}

async function readConfigFile(path: string): Promise<Partial<Record<keyof Config, string>>> {
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

  const out: Partial<Record<keyof Config, string>> = {};
  for (const key of ["provider", "model"] as const) {
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

function dropUndefined<T extends Record<string, unknown>>(obj: T) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
