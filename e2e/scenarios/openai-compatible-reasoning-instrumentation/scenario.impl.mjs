import { runTracedScenario } from "../../helpers/provider-runtime.mjs";

export const SCENARIO_NAME = "openai-compatible-reasoning-instrumentation";
export const ROOT_NAME = "openai-compatible-reasoning-root";
export const REQUEST = {
  model: "deepseek-flash",
  messages: [
    {
      role: "user",
      content:
        "Which is greater, 9.11 or 9.8? Answer with the greater number only.",
    },
  ],
  thinking: { type: "enabled" },
  reasoning_effort: "low",
  max_tokens: 2048,
  stream: true,
  stream_options: { include_usage: true },
};

export async function runReasoningScenario({
  OpenAI,
  decorateClient = (client) => client,
  openaiSdkVersion,
}) {
  // Require cassette routing even during recording. Never default to live APIs.
  const baseURL = new URL(process.env.DEEPSEEK_BASE_URL ?? "");
  if (
    baseURL.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(baseURL.hostname) ||
    baseURL.pathname !== "/deepseek/v1" ||
    baseURL.search ||
    baseURL.username ||
    baseURL.password
  ) {
    throw new Error("Expected the harness's loopback DeepSeek base URL");
  }
  const client = decorateClient(
    new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: baseURL.href,
      maxRetries: 0,
      timeout: 45_000,
    }),
  );

  await runTracedScenario({
    rootName: ROOT_NAME,
    projectNameBase: SCENARIO_NAME,
    metadata: { scenario: SCENARIO_NAME, openaiSdkVersion },
    callback: async () => {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 45_000);
      try {
        const stream = await client.chat.completions.create(REQUEST, {
          signal: controller.signal,
        });
        for await (const _chunk of stream) {
          // Consume the real SDK stream to completion; assertions use raw cassettes.
        }
      } finally {
        clearTimeout(deadline);
      }
    },
  });
}
