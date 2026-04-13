import { wrapGoogleADK } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

const GOOGLE_MODEL = "gemini-2.5-flash-lite";
const ROOT_NAME = "google-adk-instrumentation-root";
const SCENARIO_NAME = "google-adk-instrumentation";

async function runGoogleADKInstrumentationScenario(adk, options = {}) {
  const decoratedADK = options.decorateSDK ? options.decorateSDK(adk) : adk;
  const { LlmAgent, InMemoryRunner, FunctionTool } = decoratedADK;
  process.env.GOOGLE_GENAI_API_KEY ??=
    process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;

  // Create a simple tool
  const getWeatherTool = new FunctionTool({
    name: "get_weather",
    description: "Get the current weather in a given location",
    parameters: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "The city and country to look up",
        },
      },
      required: ["location"],
    },
    execute: ({ location }) => {
      return { temperature: 72, condition: "sunny", location };
    },
  });

  // Create a simple agent
  const agent = new LlmAgent({
    name: "weather_agent",
    model: GOOGLE_MODEL,
    instruction:
      "For weather questions, first call the get_weather tool exactly once, then answer with the tool result in one short sentence. Do not answer from memory and do not call any tool after you have a tool result.",
    tools: [getWeatherTool],
    generateContentConfig: {
      temperature: 0,
    },
  });

  // Create a runner
  const runner = new InMemoryRunner({ agent, appName: "e2e-test-app" });
  const userId = "test-user";
  const sessionId = "test-session-1";

  await runner.sessionService.createSession({
    appName: runner.appName,
    sessionId,
    userId,
  });

  await runTracedScenario({
    callback: async () => {
      // Test 1: Simple agent run (should produce runner + agent + LLM + tool spans)
      await runOperation("adk-simple-run-operation", "simple-run", async () => {
        const events = [];
        for await (const event of runner.runAsync({
          userId,
          sessionId,
          runConfig: {
            maxLlmCalls: 4,
          },
          newMessage: {
            role: "user",
            parts: [{ text: "What is the weather in Paris, France?" }],
          },
        })) {
          events.push(event);
        }
      });
    },
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-google-adk-instrumentation",
    rootName: ROOT_NAME,
  });
}

export async function runWrappedGoogleADKInstrumentation(adk) {
  await runGoogleADKInstrumentationScenario(adk, {
    decorateSDK: wrapGoogleADK,
  });
}

export async function runAutoGoogleADKInstrumentation(adk) {
  await runGoogleADKInstrumentationScenario(adk);
}

export { GOOGLE_MODEL, ROOT_NAME, SCENARIO_NAME };
