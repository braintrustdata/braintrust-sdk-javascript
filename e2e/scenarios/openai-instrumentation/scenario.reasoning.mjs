import { wrapOpenAI } from "braintrust";
import {
  getInstalledPackageVersion,
  runMain,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

const packageName = process.env.OPENAI_PACKAGE_NAME;
const { default: OpenAI } = await import(packageName);

runMain(async () => {
  const client = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: process.env.DEEPSEEK_BASE_URL,
    maxRetries: 0,
  });
  const instrumented =
    process.env.INSTRUMENTATION_MODE === "wrapped"
      ? wrapOpenAI(client)
      : client;

  await runTracedScenario({
    rootName: "openai-reasoning-root",
    projectNameBase: "tmp-luca-openai-reasoning",
    metadata: {
      scenario: "openai-instrumentation",
      openaiSdkVersion: await getInstalledPackageVersion(
        import.meta.url,
        packageName,
      ),
    },
    callback: async () => {
      // Genuine DeepSeek recordings from PR #2522 (commit 43100efd0f2ee4fffe44b4e9a711aa6f66c71b0f).
      // This is the plain OpenAI client with a custom baseURL reported in #2511.
      const stream = await instrumented.chat.completions.create({
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
      });
      const reasoning = [];
      const content = [];
      let usage;
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.reasoning_content) reasoning.push(delta.reasoning_content);
        if (delta?.content) content.push(delta.content);
        if (chunk.usage) usage = chunk.usage;
      }
      // Expectations come from what the application received, independently of tracing.
      console.log(JSON.stringify({ reasoning, content, usage }));
    },
  });
});
