import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { createMockModel } from "@mastra/core/test-utils/llm-mock";
import { createTool } from "@mastra/core/tools";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import {
  runMain,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

export const ROOT_NAME = "mastra-instrumentation-root";
export const SCENARIO_NAME = "mastra-instrumentation";

const weatherTool = createTool({
  id: "lookup_weather",
  description: "Look up a deterministic weather forecast.",
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

const weatherAgent = new Agent({
  id: "weather-agent",
  name: "Weather Agent",
  instructions: "Answer weather questions with the provided mock forecast.",
  model: createMockModel({
    mockText: "The forecast is sunny.",
  }),
});

const lookupStep = createStep({
  id: "lookup-step",
  inputSchema: z.object({
    city: z.string(),
  }),
  outputSchema: z.object({
    forecast: z.string(),
  }),
  execute: async ({ inputData }) => weatherTool.execute(inputData),
});

const travelWorkflow = createWorkflow({
  id: "travel-flow",
  inputSchema: z.object({
    city: z.string(),
  }),
  outputSchema: z.object({
    forecast: z.string(),
  }),
})
  .then(lookupStep)
  .commit();

// The scenario constructs `new Mastra({})` with no observability config.
// Under `node --import braintrust/hook.mjs`, the loader patches:
//   - `@mastra/core` Mastra constructor → injects a default Observability when
//     `observability` is missing
//   - `@mastra/observability` Observability constructor → injects
//     BraintrustObservabilityExporter when not already present
// So this snippet exercises the truly zero-line integration path.
const mastra = new Mastra({
  agents: { "weather-agent": weatherAgent },
  workflows: { "travel-flow": travelWorkflow },
});

const registeredAgent = mastra.getAgent("weather-agent");
const registeredWorkflow = mastra.getWorkflow("travel-flow");

async function runMastraInstrumentationScenario() {
  await runTracedScenario({
    callback: async () => {
      await runOperation("mastra-agent-generate-operation", "generate", () =>
        registeredAgent.generate("What is the weather in Paris?", {
          runId: "agent-generate-run",
          resourceId: "weather-user",
        }),
      );

      await runOperation(
        "mastra-agent-stream-operation",
        "stream",
        async () => {
          const result = await registeredAgent.stream(
            "Stream the Paris forecast.",
            {
              runId: "agent-stream-run",
              resourceId: "weather-user",
            },
          );
          for await (const _chunk of result.textStream) {
          }
        },
      );

      await runOperation("mastra-tool-operation", "tool", () =>
        weatherTool.execute({ city: "Paris" }),
      );

      await runOperation("mastra-workflow-operation", "workflow", async () => {
        const run = await registeredWorkflow.createRun({
          runId: "workflow-run",
        });
        await run.start({
          inputData: {
            city: "Berlin",
          },
        });
      });

      // Flush so the mock server sees every span before the subprocess exits.
      await mastra.observability.shutdown();
    },
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-mastra-instrumentation",
    rootName: ROOT_NAME,
  });
}

runMain(runMastraInstrumentationScenario);
