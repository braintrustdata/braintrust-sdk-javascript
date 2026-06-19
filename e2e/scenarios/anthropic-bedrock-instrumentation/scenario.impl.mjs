import { wrapAnthropic } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

export const ROOT_NAME = "anthropic-bedrock-instrumentation-root";
export const SCENARIO_NAME = "anthropic-bedrock-instrumentation";
export const ANTHROPIC_BEDROCK_SCENARIO_TIMEOUT_MS = 180_000;

const DEFAULT_MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const DEFAULT_REGION = "us-east-1";

function getAwsRegion() {
  return (
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || DEFAULT_REGION
  );
}

function getModel() {
  const cassetteMode = process.env.BRAINTRUST_E2E_CASSETTE_MODE;
  if (
    (cassetteMode === "record" ||
      cassetteMode === "record-missing" ||
      cassetteMode === "passthrough") &&
    process.env.BRAINTRUST_ANTHROPIC_BEDROCK_MODEL
  ) {
    return process.env.BRAINTRUST_ANTHROPIC_BEDROCK_MODEL;
  }

  return DEFAULT_MODEL;
}

async function runAnthropicBedrockInstrumentationScenario(options) {
  const baseClient = new options.AnthropicBedrock({
    apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK,
    awsRegion: getAwsRegion(),
    baseURL: process.env.ANTHROPIC_BEDROCK_BASE_URL,
  });
  const client = options.decorateClient
    ? options.decorateClient(baseClient)
    : baseClient;
  const model = getModel();

  await runTracedScenario({
    callback: async () => {
      await runOperation(
        "anthropic-bedrock-create-operation",
        "create",
        async () => {
          await client.messages.create({
            max_tokens: 24,
            messages: [{ role: "user", content: "Reply with exactly OK." }],
            model,
            temperature: 0,
          });
        },
      );

      await runOperation(
        "anthropic-bedrock-stream-operation",
        "stream",
        async () => {
          const stream = await client.messages.create({
            max_tokens: 32,
            messages: [
              {
                role: "user",
                content:
                  "Count from 1 to 3 and include the words one two three.",
              },
            ],
            model,
            stream: true,
            temperature: 0,
          });
          await collectAsync(stream);
        },
      );
    },
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-anthropic-bedrock-instrumentation",
    rootName: ROOT_NAME,
  });
}

export async function runWrappedAnthropicBedrockInstrumentation(options) {
  await runAnthropicBedrockInstrumentationScenario({
    decorateClient: wrapAnthropic,
    ...options,
  });
}

export async function runAutoAnthropicBedrockInstrumentation(options) {
  await runAnthropicBedrockInstrumentationScenario(options);
}
