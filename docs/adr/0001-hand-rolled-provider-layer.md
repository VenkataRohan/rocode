# Hand-rolled provider layer, no agent SDKs

The project exists primarily to learn how coding agents work, so we call Provider HTTP APIs directly with `fetch` and parse SSE streams ourselves instead of using the Vercel AI SDK, LangChain, or vendor SDKs. The agent owns its own Provider-independent Message and Tool Call types behind a `Provider` interface; OpenRouter (OpenAI Chat Completions format) is the first implementation, Ollama the second, with Anthropic and Gemini adapters later. Don't "fix" this by swapping in an SDK — the translation layer is the point.
