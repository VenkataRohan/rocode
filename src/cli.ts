#!/usr/bin/env bun
import { ConfigError, loadConfig, type Config } from "./config.ts";
import type { Provider } from "./provider.ts";
import { approveAll, createAgent } from "./agent.ts";
import { createOpenRouterProvider } from "./providers/openrouter.ts";
import { runRepl } from "./repl.ts";
import { createBashTool } from "./tools/bash.ts";
import { editTool } from "./tools/edit.ts";
import { readTool } from "./tools/read.ts";
import { writeTool } from "./tools/write.ts";

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
  const tools = [readTool, writeTool, editTool, createBashTool({ timeoutMs: config.bashTimeoutSeconds * 1000 })];
  await runRepl({
    createAgent: (askUser) =>
      createAgent({
        provider,
        model: config.model,
        tools,
        cwd: process.cwd(),
        approve: config.yolo ? approveAll : askUser,
        maxSteps: config.maxSteps,
        truncation: { maxChars: config.toolResultMaxChars, maxLines: config.toolResultMaxLines },
      }),
    header: `${provider.name} · ${config.model}${config.yolo ? " · yolo: Approvals off" : ""}`,
  });
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`rocode: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
