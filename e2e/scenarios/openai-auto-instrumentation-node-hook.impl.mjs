import { initLogger } from "braintrust";

const OPENAI_MODEL = "gpt-4o-mini";

function getTestRunId() {
  return process.env.BRAINTRUST_E2E_RUN_ID;
}

function scopedName(base, testRunId = getTestRunId()) {
  const suffix = testRunId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `${base}-${suffix}`;
}

export async function runOpenAIAutoInstrumentationNodeHook(
  OpenAI,
  openaiSdkVersion,
) {
  const testRunId = getTestRunId();
  const logger = initLogger({
    projectName: scopedName("e2e-openai-auto-instrumentation-hook", testRunId),
  });
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
  });

  await logger.traced(
    async () => {
      await client.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
          {
            role: "user",
            content: "Auto-instrument this request.",
          },
        ],
        max_tokens: 8,
        temperature: 0,
      });
    },
    {
      name: "openai-auto-hook-root",
      event: {
        metadata: {
          scenario: "openai-auto-instrumentation-node-hook",
          openaiSdkVersion,
          testRunId,
        },
      },
    },
  );

  await logger.flush();
}

export function runOpenAIAutoInstrumentationNodeHookOrExit(
  OpenAI,
  openaiSdkVersion,
) {
  void runOpenAIAutoInstrumentationNodeHook(OpenAI, openaiSdkVersion).catch(
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
