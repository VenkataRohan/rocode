#!/usr/bin/env bun
import { ConfigError, loadConfig, type Config } from "./config.ts";
import type { Provider } from "./provider.ts";
import { createOpenRouterProvider } from "./providers/openrouter.ts";
import { runRepl } from "./repl.ts";

function createProvider(config: Config, env: NodeJS.ProcessEnv): Provider {
  switch (config.provider) {
    case "openrouter": {
      const apiKey = env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new ConfigError(
          "OPENROUTER_API_KEY is not set.\n" +
            "Create a key at https://openrouter.ai/keys, then: export OPENROUTER_API_KEY=sk-or-...",
        );
      }
      return createOpenRouterProvider({ apiKey });
    }
  }
}

try {
  const config = await loadConfig(process.argv.slice(2));
  const provider = createProvider(config, process.env);
  await runRepl({ provider, model: config.model });
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`rocode: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
