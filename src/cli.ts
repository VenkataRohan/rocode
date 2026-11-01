#!/usr/bin/env bun
import { ConfigError, loadConfig, type Config } from "./config.ts";
import type { Provider } from "./provider.ts";
import { createAgent } from "./agent.ts";
import { createOpenRouterProvider } from "./providers/openrouter.ts";
import { runRepl } from "./repl.ts";
import { readTool } from "./tools/read.ts";

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
  const agent = createAgent({
    provider,
    model: config.model,
    tools: [readTool],
    cwd: process.cwd(),
    maxSteps: config.maxSteps,
  });
  await runRepl({ agent, header: `${provider.name} · ${config.model}` });
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`rocode: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
