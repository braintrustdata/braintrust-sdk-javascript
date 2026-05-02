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

function getGitHubToken() {
  return process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
}

function getMockBaseUrl() {
  return process.env.BRAINTRUST_E2E_MODEL_BASE_URL;
}

function buildProvider() {
  const mockBaseUrl = getMockBaseUrl();
  if (mockBaseUrl) {
    // BYOK mode: point the Copilot CLI at a mock/local OpenAI-compatible server
    return {
      type: "openai",
      baseUrl: mockBaseUrl,
      apiKey: "test-key",
    };
  }

  // No provider override — use default GitHub Copilot auth
  return undefined;
}

async function runCopilotSession(options, decorateClient) {
  const { CopilotClient, approveAll, defineTool } = options;

  const githubToken = getGitHubToken();
  if (!githubToken && !getMockBaseUrl()) {
    throw new Error(
      "Either GITHUB_TOKEN or BRAINTRUST_E2E_MODEL_BASE_URL must be set for the GitHub Copilot SDK e2e test",
    );
  }

  const baseClient = new CopilotClient(
    githubToken ? { gitHubToken: githubToken } : {},
  );
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
