import { tool } from "@openrouter/agent";
import { wrapOpenRouterAgent } from "braintrust";
import { z } from "zod";
import {
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";
import { CHAT_MODEL, ROOT_NAME, SCENARIO_NAME } from "./constants.mjs";

function createWeatherTool(toolFactory) {
  return toolFactory({
    name: "lookup_weather",
    description: "Look up the weather forecast for a city.",
    inputSchema: z.object({
      city: z.string(),
    }),
    outputSchema: z.object({
      forecast: z.string(),
    }),
    execute: async ({ city }) => ({
      forecast: `Sunny in ${city}`,
    }),
  });
}

async function runOpenRouterAgentInstrumentationScenario(
  OpenRouter,
  { decorateClient } = {},
) {
  const baseClient = new OpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
  });
  const client = decorateClient ? decorateClient(baseClient) : baseClient;
  const weatherTool = createWeatherTool(tool);

  await runTracedScenario({
    callback: async () => {
      await runOperation(
        "openrouter-agent-call-model-operation",
        "call-model",
        async () => {
          const result = client.callModel({
            input:
              "Use the lookup_weather tool for Vienna exactly once, then answer with only the forecast.",
            maxOutputTokens: 16,
            maxToolCalls: 1,
            model: CHAT_MODEL,
            temperature: 0,
            toolChoice: "required",
            tools: [weatherTool],
          });

          await result.getText();
        },
      );
    },
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-openrouter-agent-instrumentation",
    rootName: ROOT_NAME,
  });
}

export async function runWrappedOpenRouterAgentInstrumentation(OpenRouter) {
  await runOpenRouterAgentInstrumentationScenario(OpenRouter, {
    decorateClient: wrapOpenRouterAgent,
  });
}

export async function runAutoOpenRouterAgentInstrumentation(OpenRouter) {
  await runOpenRouterAgentInstrumentationScenario(OpenRouter);
}
