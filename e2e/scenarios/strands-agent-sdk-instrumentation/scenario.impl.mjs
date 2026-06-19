import { wrapStrandsAgentSDK } from "braintrust";
import {
  collectAsync,
  runOperation,
  runTracedScenario,
} from "../../helpers/provider-runtime.mjs";

const MODEL_NAME = "gpt-4o-mini-2024-07-18";
const ROOT_NAME = "strands-agent-sdk-instrumentation-root";
const SCENARIO_NAME = "strands-agent-sdk-instrumentation";

function createOpenAIModel(OpenAIModel) {
  return new OpenAIModel({
    api: "chat",
    modelId: MODEL_NAME,
    temperature: 0,
    maxTokens: 160,
    ...(process.env.OPENAI_BASE_URL
      ? { clientConfig: { baseURL: process.env.OPENAI_BASE_URL } }
      : {}),
  });
}

function resultText(result) {
  return typeof result?.toString === "function" &&
    result.toString !== Object.prototype.toString
    ? result.toString()
    : JSON.stringify(result);
}

function expectContains(value, marker, label) {
  const text = resultText(value);
  if (!text.includes(marker)) {
    throw new Error(`${label} did not include ${marker}: ${text}`);
  }
}

async function runStrandsAgentSDKInstrumentationScenario(
  sdk,
  OpenAIModel,
  options = {},
) {
  const strands = options.decorateSDK ? options.decorateSDK(sdk) : sdk;
  const { Agent, Graph, Swarm, tool } = strands;
  const lookupWeather = tool({
    name: "lookup_weather",
    description: "Return a deterministic weather report for one city.",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string" },
      },
      required: ["city"],
    },
    callback: ({ city }) => ({
      city,
      forecast: "sunny",
      marker: "STRANDS_TOOL_OK",
    }),
  });

  await runTracedScenario({
    callback: async () => {
      await runOperation(
        "strands-agent-invoke-operation",
        "agent-invoke",
        async () => {
          const agent = new Agent({
            id: "weather-agent",
            name: "weather-agent",
            model: createOpenAIModel(OpenAIModel),
            printer: false,
            systemPrompt:
              "You are a deterministic test agent. Always call lookup_weather exactly once for Vienna, then answer exactly STRANDS_AGENT_TOOL_OK.",
            tools: [lookupWeather],
          });
          const result = await agent.invoke(
            "Use lookup_weather for Vienna, then answer exactly STRANDS_AGENT_TOOL_OK.",
          );

          expectContains(result, "STRANDS_AGENT_TOOL_OK", "agent invoke");
        },
      );

      await runOperation(
        "strands-agent-stream-operation",
        "agent-stream",
        async () => {
          const agent = new Agent({
            id: "stream-agent",
            name: "stream-agent",
            model: createOpenAIModel(OpenAIModel),
            printer: false,
            systemPrompt: "Reply exactly STRANDS_AGENT_STREAM_OK.",
          });
          const events = await collectAsync(
            agent.stream("Reply exactly STRANDS_AGENT_STREAM_OK."),
          );

          if (!JSON.stringify(events).includes("STRANDS_AGENT_STREAM_OK")) {
            throw new Error(
              "agent stream did not include STRANDS_AGENT_STREAM_OK",
            );
          }
        },
      );

      await runOperation(
        "strands-graph-invoke-operation",
        "graph-invoke",
        async () => {
          const researcher = new Agent({
            id: "graph-researcher",
            name: "graph-researcher",
            model: createOpenAIModel(OpenAIModel),
            printer: false,
            systemPrompt: "Reply exactly GRAPH_RESEARCH_DONE.",
          });
          const writer = new Agent({
            id: "graph-writer",
            name: "graph-writer",
            model: createOpenAIModel(OpenAIModel),
            printer: false,
            systemPrompt: "Reply exactly STRANDS_GRAPH_OK.",
          });
          const graph = new Graph({
            id: "weather-graph",
            maxSteps: 3,
            nodes: [researcher, writer],
            edges: [["graph-researcher", "graph-writer"]],
          });
          const result = await graph.invoke(
            "Have the first node finish, then have the writer answer exactly STRANDS_GRAPH_OK.",
          );

          expectContains(result, "STRANDS_GRAPH_OK", "graph invoke");
        },
      );

      await runOperation(
        "strands-swarm-invoke-operation",
        "swarm-invoke",
        async () => {
          const router = new Agent({
            id: "swarm-router",
            name: "swarm-router",
            description: "Routes work to the finisher agent.",
            model: createOpenAIModel(OpenAIModel),
            printer: false,
            systemPrompt:
              "Use the structured output schema. Hand off to swarm-finisher with message finish with STRANDS_SWARM_OK.",
          });
          const finisher = new Agent({
            id: "swarm-finisher",
            name: "swarm-finisher",
            description: "Finishes the test response.",
            model: createOpenAIModel(OpenAIModel),
            printer: false,
            systemPrompt:
              "Use the structured output schema. Do not hand off. Set the final message to exactly STRANDS_SWARM_OK.",
          });
          const swarm = new Swarm({
            id: "weather-swarm",
            maxSteps: 2,
            nodes: [router, finisher],
            start: "swarm-router",
          });
          const result = await swarm.invoke(
            "Route to the finisher, then finish exactly STRANDS_SWARM_OK.",
          );

          expectContains(result, "STRANDS_SWARM_OK", "swarm invoke");
        },
      );
    },
    flushCount: 2,
    flushDelayMs: 250,
    metadata: {
      scenario: SCENARIO_NAME,
    },
    projectNameBase: "e2e-strands-agent-sdk-instrumentation",
    rootName: ROOT_NAME,
  });
}

export async function runWrappedStrandsAgentSDKInstrumentation(
  sdk,
  OpenAIModel,
) {
  await runStrandsAgentSDKInstrumentationScenario(sdk, OpenAIModel, {
    decorateSDK: wrapStrandsAgentSDK,
  });
}

export async function runAutoStrandsAgentSDKInstrumentation(sdk, OpenAIModel) {
  await runStrandsAgentSDKInstrumentationScenario(sdk, OpenAIModel);
}

export { MODEL_NAME, ROOT_NAME, SCENARIO_NAME };
