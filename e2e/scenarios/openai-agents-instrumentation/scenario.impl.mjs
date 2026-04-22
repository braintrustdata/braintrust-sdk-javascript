import { Agent, run, tool } from "@openai/agents";
import {
  runMain,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";
import {
  AGENT_NAME,
  FINAL_OUTPUT,
  MODEL_NAME,
  OPERATION_NAME,
  ROOT_NAME,
  SCENARIO_NAME,
  TOOL_NAME,
} from "./constants.mjs";

const lookupWeather = tool({
  name: TOOL_NAME,
  description: "Look up the weather forecast for a city.",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string" },
    },
    required: ["city"],
    additionalProperties: false,
  },
  strict: false,
  execute: async ({ city }) => `Sunny in ${city}`,
});

export async function runOpenAIAgentsAutoInstrumentationScenario() {
  await runTracedScenario({
    callback: async () => {
      await runOperation(OPERATION_NAME, "openai-agents-run", async () => {
        const agent = new Agent({
          name: AGENT_NAME,
          instructions:
            "Use the lookup_weather tool exactly once, then answer only with the forecast.",
          model: MODEL_NAME,
          modelSettings: {
            temperature: 0,
            toolChoice: "required",
          },
          tools: [lookupWeather],
        });

        const result = await run(
          agent,
          "What is the weather in Vienna? Answer only with the forecast.",
        );

        if (!String(result.finalOutput).includes(FINAL_OUTPUT)) {
          throw new Error(
            `Unexpected OpenAI Agents final output: ${result.finalOutput}`,
          );
        }
      });
    },
    flushCount: 2,
    flushDelayMs: 10,
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-openai-agents-instrumentation",
    rootName: ROOT_NAME,
  });
}

export { runMain };
