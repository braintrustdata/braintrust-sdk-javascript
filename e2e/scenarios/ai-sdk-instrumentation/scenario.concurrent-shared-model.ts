import { wrapAISDK } from "braintrust";
import * as ai from "ai-sdk-v6-latest";
import { MockLanguageModelV3 } from "ai-sdk-v6-latest/test";
import { runMain, runTracedScenario } from "../../helpers/provider-runtime.mjs";

const ROOT_NAME = "ai-sdk-concurrent-shared-model-root";
const SCENARIO_NAME = "ai-sdk-concurrent-shared-model";
const MARKERS = ["MARKER_A", "MARKER_B"] as const;

function markerFrom(value: unknown): string {
  const text = JSON.stringify(value);
  return MARKERS.find((marker) => text.includes(marker)) ?? "MARKER_UNKNOWN";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { generateText } = wrapAISDK(ai);
  const sharedModel = new MockLanguageModelV3({
    provider: "mock-provider",
    modelId: "mock-concurrent-model",
    doGenerate: async (options) => {
      const marker = markerFrom(options);
      await sleep(marker === "MARKER_A" ? 75 : 25);

      return {
        content: [{ type: "text", text: `response for ${marker}` }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: {
          inputTokens: {
            cacheRead: undefined,
            cacheWrite: undefined,
            noCache: 5,
            total: 5,
          },
          outputTokens: {
            reasoning: undefined,
            text: 3,
            total: 3,
          },
        },
      };
    },
  });

  await runTracedScenario({
    callback: async () => {
      await Promise.all(
        MARKERS.map((marker) =>
          generateText({
            model: sharedModel,
            messages: [
              {
                role: "user",
                content: `${marker}: write one short sentence about cats.`,
              },
            ],
            temperature: 0,
            maxOutputTokens: 16,
          }),
        ),
      );
    },
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-ai-sdk-concurrent-shared-model",
    rootName: ROOT_NAME,
  });
}

runMain(main);
