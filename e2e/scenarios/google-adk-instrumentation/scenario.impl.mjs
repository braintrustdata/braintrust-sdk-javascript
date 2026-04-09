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

  // Create a simple tool
  const getWeatherTool = new FunctionTool({
    name: "get_weather",
    description: "Get the current weather in a given location",
    execute: ({ location }) => {
      return { temperature: 72, condition: "sunny", location };
    },
  });

  // Create a simple agent
  const agent = new LlmAgent({
    name: "weather_agent",
    model: GOOGLE_MODEL,
    instruction:
      "You are a helpful weather assistant. When asked about weather, use the get_weather tool. Be concise.",
    tools: [getWeatherTool],
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
          newMessage: {
            role: "user",
            parts: [{ text: "What is the weather in Paris?" }],
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
