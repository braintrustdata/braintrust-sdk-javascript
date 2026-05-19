import { wrapCopilotClient } from "braintrust";
import {
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";
import {
  CHAT_MODEL,
  GITHUB_COPILOT_SCENARIO_TIMEOUT_MS,
  ROOT_NAME,
  SCENARIO_NAME,
} from "./constants.mjs";

export { GITHUB_COPILOT_SCENARIO_TIMEOUT_MS };

function getOpenAIBaseUrl() {
  return (
    process.env.BRAINTRUST_E2E_MODEL_BASE_URL ??
    process.env.OPENAI_BASE_URL ??
    "https://api.openai.com/v1"
  );
}

function buildProvider() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY must be set for the GitHub Copilot SDK e2e test",
    );
  }

  return {
    type: "openai",
    baseUrl: getOpenAIBaseUrl(),
    apiKey,
  };
}

async function runCopilotSession(options, decorateClient) {
  const { CopilotClient, approveAll, defineTool } = options;

  const baseClient = new CopilotClient();
  const client = decorateClient ? decorateClient(baseClient) : baseClient;

  const provider = buildProvider();

  const getWeather = defineTool("get_weather", {
    description: "Get current weather for a city",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name" },
      },
      required: ["city"],
    },
    handler: async ({ city }) => {
      return `The weather in ${city} is 72°F and sunny.`;
    },
    skipPermission: true,
  });

  await runTracedScenario({
    callback: async () => {
      // Basic turn operation
      await runOperation(
        "github-copilot-basic-operation",
        "basic",
        async () => {
          const session = await client.createSession({
            model: CHAT_MODEL,
            onPermissionRequest: approveAll,
            ...(provider ? { provider } : {}),
          });

          await session.sendAndWait({
            prompt: "Reply with exactly: OK",
          });

          await session.disconnect();
        },
      );

      // Tool-using operation
      await runOperation("github-copilot-tool-operation", "tool", async () => {
        const session = await client.createSession({
          model: CHAT_MODEL,
          onPermissionRequest: approveAll,
          tools: [getWeather],
          ...(provider ? { provider } : {}),
        });

        await session.sendAndWait({
          prompt:
            "What is the weather in Tokyo? Use the get_weather tool and report the result.",
        });

        await session.disconnect();
      });
    },
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-github-copilot-instrumentation",
    rootName: ROOT_NAME,
  });

  await client.stop();
}

export async function runCopilotWrappedInstrumentation(options) {
  await runCopilotSession(options, wrapCopilotClient);
}

export async function runCopilotAutoInstrumentation(options) {
  await runCopilotSession(options, null);
}
