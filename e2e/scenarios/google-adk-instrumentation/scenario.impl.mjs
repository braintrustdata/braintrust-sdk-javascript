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
  const { LlmAgent, SequentialAgent, InMemoryRunner, FunctionTool } =
    decoratedADK;
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
    instruction: "Answer the user's question in one short sentence.",
    beforeAgentCallback: async () => {
      await getWeatherTool.runAsync({
        args: { location: "Paris, France" },
        toolContext: {
          functionCallId: "direct-weather-tool",
        },
      });
    },
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

  const greeter = new LlmAgent({
    name: "greeter",
    model: GOOGLE_MODEL,
    instruction: "Greet the user with a single short sentence.",
    beforeAgentCallback: () => ({
      role: "model",
      parts: [{ text: "Hello." }],
    }),
  });
  const farewell = new LlmAgent({
    name: "farewell",
    model: GOOGLE_MODEL,
    instruction: "Say a single short closing sentence.",
    beforeAgentCallback: () => ({
      role: "model",
      parts: [{ text: "Goodbye." }],
    }),
  });
  const workflow = new SequentialAgent({
    name: "sequential_workflow",
    subAgents: [greeter, farewell],
  });
  const workflowRunner = new InMemoryRunner({
    agent: workflow,
    appName: "e2e-test-sequential-app",
  });
  const workflowSessionId = "test-session-sequential";

  await workflowRunner.sessionService.createSession({
    appName: workflowRunner.appName,
    sessionId: workflowSessionId,
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

      await runOperation(
        "adk-sequential-run-operation",
        "sequential-run",
        async () => {
          const events = [];
          for await (const event of workflowRunner.runAsync({
            userId,
            sessionId: workflowSessionId,
            newMessage: {
              role: "user",
              parts: [{ text: "Hello." }],
            },
          })) {
            events.push(event);
          }
        },
      );
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
